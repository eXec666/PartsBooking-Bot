const {EventEmitter} = require('events');
const Database = require('better-sqlite3');
const path = require('path');
const {DB_PATH} = require('./db_config');
const initDb = require('./init_db');
const fs = require('fs');
const {app} = require('electron');


let activeWriters = 0;
let writeGateOpen = true;
let isWiping = false;

let dbInstance = null;
const bus = new EventEmitter();

//new helper functions
function nowIso() {return new Date().toISOString();}
function sleep(ms) {return new Promise(r => setTimeout(r,ms));}

async function waitForIdle(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (activeWriters > 0 && Date.now() < deadline) {
        await sleep(50);
    }
    return activeWriters === 0;
}

const MAX_ROWS_PER_FILE = 5000;

async function retryDelete(filePath, tries = 15, delayMs = 200) {
   const fs = require('fs');
   for (let i = 0; i < tries; i++) {
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return true;
    } catch (err) {
        if ((err.code === 'EBUSY' || err.code === 'EPERM') && i < tries - 1) {
            await sleep(delayMs);
            continue;
        }
        if (err.code === 'ENOENT') return true;
        throw err;
    }
   }
   return false; 
}

// db functions

function connect() {
    if (dbInstance && dbInstance.open) {
        return dbInstance;
    }
    dbInstance = new Database(DB_PATH);
    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('foreign_keys = ON');
    return dbInstance;
}

function disconnect() {
    if (dbInstance && dbInstance.open) {
        dbInstance.close();
        dbInstance = null;
    }
}

function query(sql, params = []) {
  const db = connect();
  const stmt = db.prepare(sql);
  return Array.isArray(params) && params.length ? stmt.all(params) : stmt.all();
}



async function wipeDatabase() {
  if (isWiping) return { success: false, error: 'Wipe already in progress.' };
  isWiping = true;
  console.log(`[${nowIso()}] [ENTRY] Wiping database...`);

  try {
    // 1) Close the gate so no new writers can start
    writeGateOpen = false;

    // 2) Wait for in-flight writers to finish (up to 8s)
    const wentIdle = await waitForIdle(8000);
    if (!wentIdle) {
      console.warn(`[${nowIso()}] [ENTRY] Wipe proceeding after idle timeout; force-closing DB handle.`);
    }

    // 3) Checkpoint WAL and close the singleton handle, if open
    try {
      if (!dbInstance || !dbInstance.open) {
        // open a temp handle just to checkpoint if needed
        dbInstance = new Database(DB_PATH);
      }
      // Move WAL contents into main DB and truncate WAL
      dbInstance.pragma('wal_checkpoint(TRUNCATE)');
    } catch (e) {
      console.log(`[${nowIso()}] [ENTRY] wal_checkpoint note: ${e.message}`);
    } finally {
      if (dbInstance && dbInstance.open) {
        try { dbInstance.close(); } catch (_) {}
      }
      dbInstance = null;
    }

    // 4) Delete DB + sidecar files with retry (Windows EBUSY/EPERM safe)
    const wal = `${DB_PATH}-wal`;
    const shm = `${DB_PATH}-shm`;

    const okMain = await retryDelete(DB_PATH);
    const okWal  = await retryDelete(wal);
    const okShm  = await retryDelete(shm);

    if (!okMain) {
      throw new Error(`Could not delete DB file after retries: ${DB_PATH}`);
    }

    // 5) Reinitialize schema
    await initDb();
    console.log(`[${nowIso()}] [ENTRY] Database wiped and reinitialized.`);

    return { success: true, message: 'Database wiped and reinitialized' };
  } catch (err) {
    console.error(`[${nowIso()}] [ENTRY] wipeDatabase failed:`, err);
    return { success: false, error: err.message };
  } finally {
    // 6) Reopen the gate for future writes
    writeGateOpen = true;
    isWiping = false;
  }
}

function getPartIdByNumber(partNumber) {
    const db = connect();
    const row = db.prepare('SELECT part_id FROM parts WHERE part_number = ?').get(partNumber);
    return row ? row.part_id : null;
}

function dumpToDb(tableName, data) {
  if (!data || data.length === 0) return { message: 'No data to dump.' };
  if (!writeGateOpen) {
    console.warn(`[${nowIso()}] [ENTRY] dumpToDb blocked: wipe in progress (table=${tableName})`);
    return { success: false, error: 'DB is being wiped. Try again shortly.' };
  }

  const db = connect();
  activeWriters++; // track an in-flight writer

  let insertStmt;
  switch (tableName) {
    case 'vehicles':
      insertStmt = db.prepare('INSERT OR IGNORE INTO vehicles (vehicle_id, vehicle_name, equipment_ref_id) VALUES (?, ?, ?)');
      break;
    case 'parts':
      insertStmt = db.prepare('INSERT OR IGNORE INTO parts (part_id, part_number) VALUES (?, ?)');
      break;
    case 'compatibility':
      insertStmt = db.prepare('INSERT OR IGNORE INTO compatibility (part_id, vehicle_id) VALUES (?, ?)');
      break;
    case 'nodes':
      insertStmt = db.prepare('INSERT OR IGNORE INTO nodes (node_id, node_desc) VALUES (?, ?)');
      break;
    case 'part_vehicle_nodes':
      insertStmt = db.prepare('INSERT OR IGNORE INTO part_vehicle_nodes (part_id, vehicle_id, node_id) VALUES (?, ?, ?)');
      break;
    default:
      activeWriters = Math.max(0, activeWriters - 1);
      throw new Error(`Unsupported table: ${tableName}`);
  }

  const total = data.length;
  let done = 0;

  const tx = db.transaction((rows) => {
    for (const row of rows) {
      try {
        insertStmt.run(Object.values(row));
        done++;
        const percent = Math.round((done / total) * 100);
        const payload = { table: tableName, done, total, percent };
        bus.emit('dump-progress', payload);
        console.log('[DB] dump-progress', payload);
      } catch (err) {
        console.error(`Error inserting into ${tableName}:`, err.message);
      }
    }
  });

  try {
    tx(data);
    return { success: true, inserted: done, total };
  } catch (err) {
    console.error(`Dump to ${tableName} failed:`, err.message);
    return { error: err.message };
  } finally {
    activeWriters = Math.max(0, activeWriters - 1); // writer finished
  }
}

function onDumpProgress(handler) {
    bus.on('dump-progress', handler);
}

module.exports = {
    connect,
    disconnect,
    dumpToDb,
    query,
    wipeDatabase,
    onDumpProgress,
    getPartIdByNumber
}