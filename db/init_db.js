// db/init_db.js
const Database = require('better-sqlite3');
const { DB_PATH } = require('../db/db_config');

const schema = `
CREATE TABLE IF NOT EXISTS prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  part_number TEXT NOT NULL,
  brand_name TEXT NOT NULL,
  our_price INTEGER NOT NULL,
  site_code INTEGER NOT NULL,
  under_price INTEGER NOT NULL,
  over_price INTEGER NOT NULL,
  rankPos INTEGER NOT NULL,
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

    const tableCheck = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='prices'`)
      .get();

    if (!tableCheck) {
      console.log('Creating database schema...');
      db.exec(schema);

      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all();
      console.log('Created tables:', tables.map(t => t.name));
    } else {
      console.log('Database already initialized');
    }

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

if (require.main === module) {
  initDb();
}

module.exports = initDb;
