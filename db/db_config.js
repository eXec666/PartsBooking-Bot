// db/db_config.js
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function resolveDbPath() {
  const isDev = !app.isPackaged;
  // Allow override for testing
  const override = process.env.PARTSBOOKING_DB_PATH;
  if (override) {
    ensureDir(path.dirname(override));
    return override;
  }

  if (isDev) {
    const devDir = path.join(process.cwd(), 'dev-data'); // writable in dev repo
    ensureDir(devDir);
    return path.join(devDir, 'partsbooking.sqlite');
  }

  const dataDir = path.join(app.getPath('userData'), 'data'); // writable in production
  ensureDir(dataDir);
  return path.join(dataDir, 'partsbooking.sqlite');
}

module.exports = {
  get DB_PATH() {
    return resolveDbPath(); // compute at call time
  },
};