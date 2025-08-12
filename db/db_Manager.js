// db/db_Manager.js
const { EventEmitter } = require('events');
const Database = require('better-sqlite3');
const { DB_PATH } = require('./db_config.js');
const initDb = require('./init_db');

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

  const weAreLeader = leader && leader[0] === String(ourCode);

  if (weAreLeader) {
    out.leader_code  = 'G&G Leader';
    out.leader_price = out.our_price;
    out.over_code    = 'G&G Leader';
    out.over_price   = null;
  } else if (leader) {
    out.leader_code  = leader[0];
    out.leader_price = leader[1];
  }

  if (over) {
    out.over_code  = over[0];
    out.over_price = over[1];
  }
  if (under) {
    out.under_code  = under[0];
    out.under_price = under[1];
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
    INSERT OR REPLACE INTO prices
      (part_number, brand_name, rank_pos, our_price,
       leader_code, leader_price, over_code, over_price, under_code, under_price)
    VALUES (@part_number, @brand_name, @rank_pos, @our_price,
            @leader_code, @leader_price, @over_code, @over_price, @under_code, @under_price)
  `);

  const tx = dbc.transaction((batch) => {
    for (const r of batch) insert.run(r);
  });

  tx(rows);
  bus.emit('dump-progress', { table: 'prices', count: rows.length });

  return { inserted: rows.length };
}

function onDumpProgress(handler) {
  bus.on('dump-progress', handler);
}

module.exports = {
  connect,
  disconnect,
  dumpToDb,
  rankPrice,
  onDumpProgress
};
