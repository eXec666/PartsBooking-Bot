// db/init_db.js
const Database = require('better-sqlite3');
const { DB_PATH } = require('../db/db_config');

const schema = `
CREATE TABLE IF NOT EXISTS prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  part_number TEXT,
  brand_name  TEXT,
  rank_pos    INTEGER,
  our_price   NUMERIC,
  site_code   TEXT,
  leader_code TEXT,
  leader_price NUMERIC,
  over_code   TEXT,
  over_price  NUMERIC,
  under_code  TEXT,
  under_price NUMERIC,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(part_number, site_code)
);

CREATE INDEX IF NOT EXISTS idx_prices_part ON prices(part_number);
CREATE INDEX IF NOT EXISTS idx_prices_site ON prices(site_code);
`;

function initDb() {
  let db;
  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    return true;
  } catch (err) {
    console.error('Database initialization failed:', err);
    try {
      if (db) db.close();
      require('fs').unlinkSync(DB_PATH);
      return initDb();
    } catch (recoveryErr) {
      console.error('Database recovery failed:', recoveryErr);
      return false;
    }
  } finally {
    if (db) db.close();
  }
}

if (require.main === module) initDb();
module.exports = initDb;
