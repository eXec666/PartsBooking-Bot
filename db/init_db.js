// db/init_db.js
const Database = require('better-sqlite3');
const { DB_PATH } = require('./db_config');

module.exports = function initDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Create table without site_code column
  db.prepare(`CREATE TABLE IF NOT EXISTS prices (
    part_number TEXT,
    brand_name TEXT,
    rank_pos INTEGER,
    our_price REAL,
    leader_code TEXT,
    leader_price REAL,
    over_code TEXT,
    over_price REAL,
    under_code TEXT,
    under_price REAL,
    PRIMARY KEY(part_number, brand_name)
  )`).run();

  return true;
};
