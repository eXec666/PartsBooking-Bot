// db/init_db.js
const Database = require('better-sqlite3');
const { DB_PATH } = require('./db_config');

module.exports = function initDb() {
  const db = new Database(DB_PATH);

  // Create table without site_code column
  db.prepare(`CREATE TABLE IF NOT EXISTS prices (
    part_number TEXT,
    brand_name TEXT,
    rank_pos TEXT,
    our_price TEXT,
    leader_code TEXT,
    leader_price TEXT,
    over_code TEXT,
    over_price TEXT,
    under_code TEXT,
    under_price TEXT,
    PRIMARY KEY(part_number, brand_name)
  )`).run();

  db.close(); // important: don’t leak a second writer connection
  return true;
};
