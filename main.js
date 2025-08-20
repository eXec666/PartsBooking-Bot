debugger;
const {app, BrowserWindow, ipcMain, dialog, shell} = require('electron');
// Auto-dismiss Electron error dialogs; log instead.
(() => {
  const _showErrorBox   = dialog.showErrorBox.bind(dialog);
  const _showMessageBox = dialog.showMessageBox.bind(dialog);

  dialog.showErrorBox = (title, content) => {
    // Mark in logs; no modal UI.
    console.error(`[dialog suppressed] ${title}: ${content}`);
  };

  dialog.showMessageBox = async (browserWindowOrOpts, maybeOpts) => {
    // Normalize args: showMessageBox(win, opts) OR showMessageBox(opts)
    const opts = maybeOpts ? maybeOpts : browserWindowOrOpts;
    const isErrorish =
      opts && (opts.type === 'error' || /enoent/i.test(opts.message || ''));

    if (isErrorish) {
      console.error(`[dialog suppressed] ${opts.title || 'Error'}: ${opts.message || ''}`);
      // Immediately resolve with default/first button so callers continue.
      return { response: opts.defaultId ?? 0, checkboxChecked: false };
    }
    // Non-error dialogs behave normally.
    return _showMessageBox(browserWindowOrOpts, maybeOpts);
  };
})();
const originalLog = console.log;
const originalErr = console.error;
const path = require('path');
const fs = require('fs');
const dbManager = require('./db/db_Manager');
const {wipeDatabase} = dbManager
const {query} = dbManager
const {pbScraper} = require('./scraper/pbScraper');
//const {data} = require('node-persist');

// main.js — Logging module (add near top-level, after requires)

// === Logging: bounded UI tail + NDJSON file persistence with rotation ===
const os = require('os');
// ---- LOG PATH RESOLUTION ----
let LOG_FILE = null;                 // resolved after app is ready
const preReadyBuffer = [];           // buffer writes that occur before ready

// Centralized write that tolerates early calls
function ensureLogWrite(payload, cb) {
  if (!LOG_FILE) {
    preReadyBuffer.push(payload);    // queue until app.whenReady() resolves path
    if (typeof cb === 'function') cb(); // avoid blocking callers
    return;
  }
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  } catch {}
  appendFile(LOG_FILE, payload, cb);
}

const { mkdirSync, existsSync, appendFile, statSync, renameSync, readFileSync, readdirSync, unlinkSync } = require('fs');
const { join } = require('path');
const LOG_UI_CAP = 1000;                      // renderer shows at most this many
const ROTATE_MAX_BYTES = 20 * 1024 * 1024;    // 20 MB
const ROTATE_KEEP = 10;                       // keep last N rotated files

// in-memory tail for fast snapshot of current run
let uiTail = [];
const subscribers = new Set();

// write queue to reduce fs churn
let writeQueue = [];
let writeTimer = null;

function initLogFilePath() {
  const userDir = app.getPath('userData');        // e.g. C:\Users\<you>\AppData\Roaming\PartsBooking
  // Ensure the directory exists (userData itself exists, but mkdirSync is harmless if it already does)
  fs.mkdirSync(userDir, { recursive: true });
  LOG_FILE = path.join(userDir, 'logs.txt');
}

function enqueueWrite(entry) {
  try {
    writeQueue.push(JSON.stringify(entry) + os.EOL);
    if (!writeTimer) writeTimer = setTimeout(flushWriteQueue, 75);
  } catch {}
}

function initDatabaseAfterReady() {
  const initDb = require(path.join(__dirname, 'db', 'init_db'));
  initDb();
}


function initDatabaseAfterReady() {
  const initDb = require(path.join(__dirname, 'db', 'init_db'));
  initDb();
}


function flushWriteQueue() {
  const payload = writeQueue.join('');
  writeQueue = [];
  writeTimer = null;

  ensureLogWrite(payload, (err) => {
    if (err) {
      // Surface a synthetic error into the stream (not to disk to avoid loops)
      broadcastAppend({ ts: Date.now(), level: 'error', msg: `Log write failed: ${err.message}`, source: 'main' });
      return;
    }
    // rotate if needed
    try {
      const { size } = statSync(LOG_FILE);
      if (size >= ROTATE_MAX_BYTES) rotateLogs();
    } catch {}
  });
}

function rotateLogs() {
  const dir = path.dirname(LOG_FILE);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rotated = join(dir, `log-${stamp}.txt`);
  try { renameSync(LOG_FILE, rotated); } catch {}
  try {
    const files = readdirSync(dir)
      .filter(f => /^log-\d{4}-\d{2}-\d{2}T/.test(f))
      .sort()
      .reverse();
    files.slice(ROTATE_KEEP).forEach(f => { try { unlinkSync(join(dir, f)); } catch {} });
  } catch {}
}

// Synchronous drain for emergency/quit paths.
function drainLogsSync() {
  try {
    if (!LOG_FILE) return;
    if (writeQueue && writeQueue.length) {
      const payload = writeQueue.join('');
      writeQueue.length = 0;
      fs.appendFileSync(LOG_FILE, payload);
    }
  } catch {}
}

function normalizeEntry(raw) {
  // Accept either {ts, level, msg, source} or console args
  const level = raw?.level || 'log';
  const source = raw?.source || 'renderer';
  const ts = raw?.ts || Date.now();
  let msg = raw?.msg;
  if (msg == null && Array.isArray(raw?.args)) {
    msg = raw.args.map(a => safeToString(a)).join(' ');
  }
  if (msg == null) msg = safeToString(raw);
  return { ts, level, msg, source, pid: raw?.pid || process.pid };
}

function safeToString(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function pushUiTail(entry) {
  uiTail.push(entry);
  if (uiTail.length > LOG_UI_CAP) uiTail.shift();
}

function broadcastAppend(entry) {
  for (const wc of subscribers) {
    if (!wc.isDestroyed()) wc.send('log:append', entry);
  }
}

function ingest(entryLike) {
  const entry = normalizeEntry(entryLike);
  pushUiTail(entry);
  enqueueWrite(entry);
  broadcastAppend(entry);
}

function tailFileForSnapshot(max = LOG_UI_CAP) {
  // Simple, robust: read last ~5MB, split lines, take last N
  try {
    const BUF = 5 * 1024 * 1024;
    const stats = statSync(LOG_FILE);
    const start = Math.max(0, stats.size - BUF);
    const fd = readFileSync(LOG_FILE, { encoding: 'utf8', start }); // Node supports start offset in readFileSync via options in recent versions
    const lines = fd.trim().split(/\r?\n/);
    const parsed = [];
    for (let i = Math.max(0, lines.length - max); i < lines.length; i++) {
      try { parsed.push(JSON.parse(lines[i])); } catch {}
    }
    return parsed.slice(-max);
  } catch {
    return [];
  }
}

// IPC: renderers subscribe and emit
ipcMain.on('log:subscribe', (event) => {
  const wc = event.sender;
  subscribers.add(wc);
  wc.once('destroyed', () => subscribers.delete(wc));

  // snapshot: prefer in-memory tail; if empty (fresh boot before any logs), try file
  const snapshot = uiTail.length ? uiTail.slice(-LOG_UI_CAP) : tailFileForSnapshot(LOG_UI_CAP);
  wc.send('log:snapshot', snapshot);
});

ipcMain.on('log:emit', (_e, entry) => ingest(entry));

// Wrap main-process console to also feed ingest
(() => {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  ['log', 'warn', 'error'].forEach(level => {
    console[level] = (...args) => {
      try { orig[level].apply(console, args); } catch {}
      ingest({ ts: Date.now(), level, args, source: 'main', pid: process.pid });
    };
  });
})();

// Global error sinks — keep process alive and mark the event.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack || reason);
});
process.on('warning', (w) => {
  console.warn('[process warning]', w && w.stack || w);
});
app.on('gpu-process-crashed', (_e, killed) => {
  console.error(`[gpu-process-crashed] killed=${killed}`);
});

// Open logs.txt with the OS default app; fall back to revealing in folder on failure
ipcMain.handle('log:open-file', async () => {
  try {
    const result = await shell.openPath(LOG_FILE); // empty string = success
    if (result) {
      shell.showItemInFolder(LOG_FILE);
      return { ok: false, error: result };
    }
    return { ok: true };
  } catch (e) {
    try { shell.showItemInFolder(LOG_FILE); } catch {}
    return { ok: false, error: e.message };
  }
});


// === /Logging module ===



function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      devTools: true,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Listen for dump progress from the unified DB entry point
  dbManager.onDumpProgress((payload) => {
    console.log('[MAIN] forwarding ui:db-dump-progress', payload);
    if (win && !win.isDestroyed()) {
      win.webContents.send('ui:db-dump-progress', payload);
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // win.webContents.openDevTools();

  // If// If the renderer goes away, mark it and try a soft recovery.
  win.webContents.on('render-process-gone', (_e, details) => {
    const reason   = (details && details.reason) || 'unknown';
    const exitCode = details && details.exitCode;
    console.error(`[renderer gone] reason=${reason} exitCode=${exitCode}`);

    // Flush any buffered logs synchronously (helper added below).
    try { if (typeof drainLogsSync === 'function') drainLogsSync(); } catch {}

    // Attempt a soft reload on crash/oom/killed; otherwise leave it.
    if (/crashed|oom|killed/i.test(reason)) {
      setTimeout(() => {
        if (!win.isDestroyed()) {
          try { win.reload(); } catch {}
        }
      }, 1000);
    }
  });
}

// Capture common webContents failures globally (no UI).
app.on('web-contents-created', (_e, wc) => {
  wc.on('preload-error', (_ev, preloadPath, error) => {
    console.error(`[preload-error] ${preloadPath}: ${error && error.message}`);
  });
  wc.on('did-fail-load', (_ev, code, description, url, isMainFrame) => {
    console.error(`[did-fail-load] code=${code} desc=${description} url=${url} main=${isMainFrame}`);
  });
  wc.on('unresponsive', () => { console.warn('[webContents] unresponsive'); });
  wc.on('crashed',      () => { console.error('[webContents] crashed'); });
});

app.on('before-quit', () => { try { drainLogsSync(); } catch {} });
app.on('will-quit',   () => { try { drainLogsSync(); } catch {} });

app.whenReady().then(() => {
  initLogFilePath();   
    if (preReadyBuffer.length) {
    try { appendFile(LOG_FILE, preReadyBuffer.join(''), () => {}); } catch {}
    preReadyBuffer.length = 0;
  }                          // <-- set LOG_FILE before any file writes
  try {
    // If you initialize the DB here, do it after logs path is ready
    const initDb = require(path.join(__dirname, 'db', 'init_db'));
    initDb();
  } catch (e) {
    // Use console.* here; file logger may not be ready if something else fails
    console.error('[MAIN] DB init failed:', e);
  }
  createWindow();
});


ipcMain.handle('scrape-prices', async (event, inputFilePath) => {
  console.log('⚡️ scrape-prices IPC called');
  try {
    let win = BrowserWindow.getFocusedWindow();
    if (!win) {
      const windows = BrowserWindow.getAllWindows();
      win = windows.find(w => w.isVisible()) || windows[0];
    }

    console.log('🔌 Starting scraping...');
    const result = await pbScraper.runWithProgress((percent, message) => {
          try {
            console.log(`Progress: ${percent}% - ${message}`);
            if (win && !win.isDestroyed()) {
              win.webContents.send('progress-update', percent, message);
            }
          } catch (progressErr) {
            console.error('Progress callback failed:', progressErr);
          }
        },
        () => {
          if (win && !win.isDestroyed()) {
            win.webContents.send('force-refresh');
          }
        },
        inputFilePath
    );

    console.log('Price scrape completed:', result);
    if (win && !win.isDestroyed()) {
      win.webContents.send('scrape-complete', result);
    }
    return result;
  } catch (err) {
    console.error('Scrape failed:', err);
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send('scrape-error', {
        error: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
      });
    }
    return { error: err.message };
  }
});

//HANDLERS
ipcMain.handle('get-table-data', async () => {
  try {
    const tables = dbManager.query(`SELECT name FROM sqlite_master WHERE type='table'`);
    const data = {};
    for (const t of tables) {
      data[t.name] = dbManager.query(`SELECT * FROM ${t.name}`);
    }
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
});


ipcMain.handle('wipe-db', async () => {
  try {
    if (pbScraper.isActive && pbScraper.isActive()) {
      return { success: false, error: 'Scraper is active; stop the run before wiping the database.' };
    }
    return await dbManager.wipeDatabase();
  } catch (e) {
    return { success: false, error: e.message };
  }
});


ipcMain.handle('query-part', async (event, partNumber) => {
  try {
    const result = await dbManager.queryVehiclesForPart(partNumber);
    return result;
  } catch (err) {
    return { error: err.message };
  }
});


ipcMain.handle('select-excel-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Excel Files', extensions: ['xlsx', 'xls'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (canceled || !filePaths?.length) return null;
  return filePaths[0];  // absolute path
});


ipcMain.handle('download-csv', async () => {
  const result = await dbManager.generateCsvFiles();
  return result; 
});

ipcMain.handle('get-images-dir', async () => pbScraper.imagesDir());



ipcMain.handle('open-folder', async (_evt, folderPath) => {
  if (!folderPath) return { success: false, error: 'No folder path provided' };
  const outcome = await shell.openPath(folderPath);
  // openPath returns '' on success, or an error string on failure
  if (outcome) return { success: false, error: outcome };
  return { success: true };
});

// Open DB Viewer window handler
ipcMain.on('open-db-viewer', () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'dbViewer.html'));
});

app.on('window-all-closed', () => {
  try {
    dbManager.disconnect(); // unified DB close
  } catch (e) {
    console.warn('DB disconnect warning:', e?.message || e);
  }
  if (process.platform !== 'darwin') app.quit();
});

process.on('SIGTERM', () => {
  try { dbManager.disconnect(); } catch {}
  app.quit();
});



