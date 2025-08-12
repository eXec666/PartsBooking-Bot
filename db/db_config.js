// db/db_config.js
const path = require('path');
let app;

try {
  // Only require electron if available
  app = require('electron').app;
} catch (_) {}

const isDev = process.env.NODE_ENV !== 'production';

const DB_PATH = isDev
  ? path.resolve(__dirname, '../prices.db') // project root folder in dev
  : path.join(app ? app.getPath('userData') : __dirname, 'prices.db');

// Log for visibility
console.log(`[DB] Using database at: ${DB_PATH}`);

module.exports = {
  DB_PATH
};
