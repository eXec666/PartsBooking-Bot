const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const Database = require('better-sqlite3');
const { DB_PATH } = require('./db_config.js');
const initDb = require('./init_db');

function nowIso() { return new Date().toISOString(); }

// single shared connection
let db = null;
const bus = new EventEmitter();

function connect() {
  if (!db) {
    initDb();
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  return db;
}

function disconnect() {
  if (db) {
    try { db.close(); } catch (_) {}
    db = null;
  }
}

function query(sql, params = []) {
  console.log(`[${nowIso()}] [ENTRY] query: sql=${typeof sql === 'string' ? sql.slice(0, 200) : '<non-string>'}, paramsLength=${Array.isArray(params) ? params.length : 0}`);
  const db = connect();
  const stmt = db.prepare(sql);
  const res = Array.isArray(params) && params.length ? stmt.all(params) : stmt.all();
  console.log(`[${nowIso()}] [ENTRY] query: rows=${Array.isArray(res) ? res.length : 0}`);
  return res;
}

function checkpoint(truncate = true) {
  try {
    const mode = truncate ? 'TRUNCATE' : 'PASSIVE';
    const res = connect().pragma(`wal_checkpoint(${mode})`);
    console.log('[db_Manager] wal_checkpoint(%s) =>', mode, res);
  } catch (e) {
    console.warn('[db_Manager] wal_checkpoint failed:', e.message);
  }
}


function wipeDatabase({ mode = 'delete', vacuum = true } = {}) {
  console.log(`[db_Manager] wipeDatabase: initiated with mode=${mode}, vacuum=${vacuum}`);
  console.log(`[db_Manager] wipeDatabase: connecting to database at ${DB_PATH}`);

  const dbc = connect();
  const startTs = new Date().toISOString();
  console.log(`[db_Manager] wipeDatabase: start @ ${startTs}`);

  try {
    const count = dbc.prepare(`SELECT COUNT(*) AS c FROM prices`).get().c;
    console.log(`[db_Manager] wipeDatabase: current rows in prices=${count}`);

    if (mode === 'drop-recreate') {
      console.log('[db_Manager] wipeDatabase: dropping table prices...');
      dbc.exec('BEGIN');
      try {
        dbc.exec('DROP TABLE IF EXISTS prices;');
        dbc.exec('COMMIT');
        console.log('[db_Manager] wipeDatabase: drop committed. Recreating schema via initDb()...');
      } catch (e) {
        dbc.exec('ROLLBACK');
        console.error('[db_Manager] wipeDatabase: drop failed, rolled back.', e);
        throw e;
      }
      initDb();
      const exists = dbc.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='prices'").get();
      console.log(`[db_Manager] wipeDatabase: schema recreated. prices table exists=${!!exists}`);
      try {
        const res = dbc.pragma("wal_checkpoint(TRUNCATE)");
        console.log('[db_Manager] wipeDatabase: wal_checkpoint(TRUNCATE) =>', res);
      } catch (e) {
        console.warn('[db_Manager] wipeDatabase: wal_checkpoint failed:', e.message);
      }
      if (vacuum) {
        console.log('[db_Manager] wipeDatabase: running VACUUM...');
        dbc.exec('VACUUM');
        console.log('[db_Manager] wipeDatabase: VACUUM complete.');
      }
      const endTs = new Date().toISOString();
      console.log(`[db_Manager] wipeDatabase: finished @ ${endTs}`);
      return { success: true, mode, dropped: true, recreated: true, deletedRows: count };
    }

    console.log('[db_Manager] wipeDatabase: deleting all rows from prices...');
    const tx = dbc.transaction(() => {
      dbc.prepare('DELETE FROM prices').run();
    });
    tx();

    const after = dbc.prepare(`SELECT COUNT(*) AS c FROM prices`).get().c;
    console.log(`[db_Manager] wipeDatabase: delete complete. rows after=${after}`);

    try {
      const res = dbc.pragma("wal_checkpoint(TRUNCATE)");
      console.log('[db_Manager] wipeDatabase: wal_checkpoint(TRUNCATE) =>', res);
    } catch (e) {
      console.warn('[db_Manager] wipeDatabase: wal_checkpoint failed:', e.message);
    }

    if (vacuum) {
      console.log('[db_Manager] wipeDatabase: running VACUUM...');
      dbc.exec('VACUUM');
      console.log('[db_Manager] wipeDatabase: VACUUM complete.');
    }

    const endTs = new Date().toISOString();
    console.log(`[db_Manager] wipeDatabase: finished @ ${endTs}`);
    console.log('[db_Manager] wipeDatabase: operation complete, verify with viewer after reconnecting to DB.');
    return { success: true, mode, deletedRows: count, rowsAfter: after };
  } catch (error) {
    console.error('[db_Manager] wipeDatabase failed:', error);
    return { success: false, error: error.message };
  }
}




/**
 * Rank a list of [siteCode, price] pairs and produce a summary row.
 * @param {Array<[number|string, number|string]>} slag
 * @param {number|string} ourCode
 * @param {string} partNumber
 * @param {string} brandName
 */
function rankPrice(slag, ourCode, partNumber, brandName) {
  const out = {
    part_number: partNumber ?? null,
    brand_name: brandName ?? null,
    rank_pos: null,
    our_price: null,
    leader_code: null,
    leader_price: null,
    over_code: null,
    over_price: null,
    under_code: null,
    under_price: null
  };

  if (!Array.isArray(slag) || slag.length === 0) return out;

  const normalized = slag
    .map(p => [p?.[0], p?.[1]])
    .filter(p => p[0] != null && p[1] != null)
    .map(p => [String(p[0]), typeof p[1] === 'string'
      ? Number(p[1].toString().replace(/\s/g, ''))
      : Number(p[1])])
    .filter(p => Number.isFinite(p[1]));

  if (normalized.length === 0) return out;

  normalized.sort((a, b) => a[1] - b[1]);

  // annotate with rank
  normalized.forEach((item, i) => {
    const pos = i + 1;
    item.push(pos); // [code, price, pos]
    if (item[0] === String(ourCode)) {
      out.rank_pos = pos;
      out.our_price = item[1];
    }
  });

  const leader = normalized.find(x => x[2] === 1);
  const over   = normalized.find(x => x[2] === (out.rank_pos ?? 0) - 1);
  const under  = normalized.find(x => x[2] === (out.rank_pos ?? 0) + 1);
  const last = normalized.find(x => x[2] === normalized.length && normalized.length != 1);
  

  const weAreLeader = leader && leader[0] === String(ourCode);
  const weAreLast = last && last[0] === String(ourCode);

  if (weAreLeader) {
    out.leader_code  = 'G&G Лидер';
    out.leader_price = out.our_price;
    out.over_code    = 'G&G Лидер';
    out.over_price   = 'G&G Лидер';
  } else if (leader) {
    out.leader_code  = leader[0];
    out.leader_price = leader[1];
  }



  if (weAreLast) {
    out.under_code = "G&G Последний";
    out.under_price = "G&G Последний";
  }

  if (over) {
    out.over_code  = over[0];
    out.over_price = over[1];
  }
  if (under) {
    out.under_code  = under[0];
    out.under_price = under[1];
  }

  if (out.rank_pos == null) {
    out.rank_pos = "Нет листинга";
    out.our_price = "Нет листинга";
    out.over_code = "Нет листинга";
    out.over_price = "Нет листинга";
    out.under_code = "Нет листинга";
    out.under_price = "Нет листинга";
  }

  return out;
}

/**
 * Dump an array of ranked price objects into the prices table.
 * Accepts objects with keys that match init_db schema.
 * Emits 'dump-progress' events with counts.
 * @param {'prices'} tableName
 * @param {Array<object>} rows
 */
function dumpToDb(tableName, rows) {
  if (tableName !== 'prices') {
    throw new Error(`Unsupported table: ${tableName}`);
  }
  if (!Array.isArray(rows) || rows.length === 0) return { inserted: 0 };

  const dbc = connect();

  const insert = dbc.prepare(`
    INSERT OR IGNORE INTO prices
      (part_number, brand_name, rank_pos, our_price,
       leader_code, leader_price, over_code, over_price, under_code, under_price)
    VALUES (@part_number, @brand_name, @rank_pos, @our_price,
            @leader_code, @leader_price, @over_code, @over_price, @under_code, @under_price)
  `);

  const tx = dbc.transaction((batch) => {
    for (const r of batch) insert.run(r);
  });

  tx(rows);
  checkpoint(false);
  bus.emit('dump-progress', { table: 'prices', count: rows.length });

  return { inserted: rows.length };
}

function onDumpProgress(handler) {
  bus.on('dump-progress', handler);
}

// fast existence check on PRIMARY KEY(part_number, brand_name)
let __existsStmt = null;
/**
 * Return true if a (part_number, brand_name) row already exists.
 * @param {string} partNumber
 * @param {string} brandName
 */
function existsPart(partNumber, brandName) {
  const dbc = connect();
  if (!__existsStmt) {
    __existsStmt = dbc.prepare(
      'SELECT 1 FROM prices WHERE part_number = ? AND brand_name = ? LIMIT 1'
    );
  }
  return !!__existsStmt.get(partNumber, brandName);
}

// --- CSV EXPORT ---
const { app } = (() => { try { return require('electron'); } catch { return {}; } })();
const DEFAULT_CHUNK = 10000;

function escapeCsvValue(val) {
  if (val == null) return '';
  const s = String(val);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * Export the current prices table to CSV files in chunks.
 * Files are written to the user's Downloads folder (Electron) or ./exports (Node).
 * @param {{chunkSize?: number}} opts
 */
function generateCsvFiles({ chunkSize = DEFAULT_CHUNK } = {}) {
  const ro = new Database(DB_PATH, { readonly: true });
  try {
    const total = ro.prepare(`SELECT COUNT(*) AS total FROM prices`).get().total;
    if (!total) {
      return {
        success: true,
        message: 'No data to export (prices table is empty).',
        directory: null,
        files: [],
        fileCount: 0,
        totalRows: 0
      };
    }

    const downloadsPath = (app && app.getPath) ? app.getPath('downloads') : path.join(process.cwd(), 'exports');
    const baseDir = path.join(downloadsPath, 'price_reports');
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

    const fileCount = Math.ceil(total / chunkSize);
    const files = [];
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    const stmt = ro.prepare(`
      SELECT 
        part_number AS 'Артикул',
        brand_name  AS 'Брэнд',
        rank_pos    AS 'Позиция в Прайс-листе',
        our_price   AS 'Цена G&G',
        leader_code AS 'Код Лидера',
        leader_price AS 'Цена Лидера',
        over_code   AS 'Код Опережающего Конкурента',
        over_price  AS 'Цена Опережающего Конкурента',
        under_code  AS 'Код Отстающего Конкурента',
        under_price AS 'Цена Отстающего Конкурента'
      FROM prices
      ORDER BY part_number, brand_name
      LIMIT ? OFFSET ?
    `);

    for (let i = 0; i < fileCount; i++) {
      const offset = i * chunkSize;
      const rows = stmt.all(chunkSize, offset);
      if (!rows.length) continue;

      const fileName = `prices_${timestamp}_part${i + 1}_of${fileCount}.csv`;
      const filePath = path.join(baseDir, fileName);

      const headerKeys = Object.keys(rows[0]);
      const header = headerKeys.join(',');
      const csv = [header];
      for (const r of rows) {
        csv.push(headerKeys.map(k => escapeCsvValue(r[k])).join(','));
      }

      fs.writeFileSync(filePath, csv.join('\n'), 'utf8');
      files.push(filePath);
    }

    return {
      success: true,
      message: `Exported ${total} price rows to ${fileCount} file(s).`,
      directory: baseDir,
      fileCount,
      totalRows: total,
      files,
      mode: 'prices'
    };
  } catch (error) {
    console.error('[db_Manager] CSV export failed:', error);
    return { success: false, error: error.message };
  } finally {
    try { ro.close(); } catch {}
  }
}

module.exports = {
  connect,
  disconnect,
  dumpToDb,
  rankPrice,
  onDumpProgress,
  generateCsvFiles,
  wipeDatabase,
  existsPart,
  query
};
