debugger;
const {app, BrowserWindow, ipcMain, dialog, shell} = require('electron');
const originalLog = console.log;
const originalErr = console.error;
const path = require('path');
const fs = require('fs');
const dbManager = require('./db/db_Manager');
const {wipeDatabase} = dbManager
const {pbScraper, imagesDir} = require('./scraper/pbScraper');
//const {data} = require('node-persist');

// ---- safe, bounded log forwarding (main process) ----
const origLog   = console.log.bind(console);
const origWarn  = console.warn.bind(console);
const origError = console.error.bind(console);

// Bounded, batched queue to protect the renderer
const LOG_QUEUE_MAX   = 2000;   // keep last 2k messages for replay
const LOG_BATCH_SIZE  = 100;    // send at most 100 queued logs per flush
let   logQueue        = [];
let   flushingLogs    = false;
let   broadcasting    = false;  // prevents recursion

// Persistent file logging
let __logFilePath = null;
function getLogFilePath() {
  if (__logFilePath) return __logFilePath;
  try {
    const dir = app.getPath('userData');
    __logFilePath = path.join(dir, 'logs.txt');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  } catch {
    // Fallback to app folder if userData not available yet
    __logFilePath = path.join(__dirname, 'logs.txt');
  }
  return __logFilePath;
}

function appendToLogFile(payload) {
  const line = `[${payload.ts}] [${payload.level.toUpperCase()}] ${payload.msg}\n`;
  try { fs.appendFile(getLogFilePath(), line, () => {}); }
  catch (e) { origWarn('file log append failed:', e && e.message ? e.message : e); }
}

function safeSerialize(args) {
  const seen = new WeakSet();
  return args.map((a) => {
    if (a instanceof Error) {
      return { name: a.name, message: a.message, stack: a.stack };
    }
    if (typeof a === 'string') return a;
    try {
      return JSON.parse(JSON.stringify(a, (k, v) => {
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[Circular]';
          seen.add(v);
        }
        return v;
      }));
    } catch {
      return String(a);
    }
  });
}

function enqueueLog(payload) {
  logQueue.push(payload);
  if (logQueue.length > LOG_QUEUE_MAX) {
    logQueue.splice(0, logQueue.length - LOG_QUEUE_MAX);
  }
}

function canSendTo(wc) {
  try {
    return wc
      && !wc.isDestroyed()
      && !wc.isLoadingMainFrame()
      && wc.mainFrame
      && !wc.mainFrame.isDestroyed();
  } catch { return false; }
}

function flushLogsTo(win) {
  if (flushingLogs) return;
  const wc = win && win.webContents;
  if (!canSendTo(wc) || logQueue.length === 0) return;

  flushingLogs = true;
  try {
    const count = Math.min(LOG_BATCH_SIZE, logQueue.length);
    const batch = logQueue.splice(0, count);
    for (let i = 0; i < batch.length; i++) {
      wc.send('log-message', batch[i]); // keep compatibility with existing preload
    }
  } catch (e) {
    // If sending fails, we can’t know how many were delivered; safest is to put batch back at front
    // Note: order preserved by unshifting reversed
    for (let i = batch.length - 1; i >= 0; i--) logQueue.unshift(batch[i]);
    origWarn('flushLogsTo failed:', e && e.message ? e.message : e);
  } finally {
    flushingLogs = false;
  }
}

function broadcastLog(level, ...args) {
  // prevent recursion if our own logging throws
  if (broadcasting) {
    if (level === 'error') return origError(...args);
    if (level === 'warn')  return origWarn(...args);
    return origLog(...args);
  }

  broadcasting = true;
  try {
    // 1) Write to original console
    if (level === 'error') origError(...args);
    else if (level === 'warn') origWarn(...args);
    else origLog(...args);

    // 2) Normalize payload
    const parts = safeSerialize(args).map(v =>
      typeof v === 'string' ? v : JSON.stringify(v)
    );
    const payload = {
      level,
      ts: new Date().toISOString(),
      msg: parts.join(' ')
    };

    // 3) Always append to logs.txt
    appendToLogFile(payload);

    // 4) Try to deliver live to open windows
    const wins = BrowserWindow.getAllWindows();
    if (wins.length === 0) {
      enqueueLog(payload);
    } else {
      let sent = false;
      for (const win of wins) {
        const wc = win.webContents;
        if (!canSendTo(wc)) continue;
        try {
          wc.send('log-message', payload);
          sent = true;
        } catch (e) {
          enqueueLog(payload);
          origWarn('log-message send failed:', e && e.message ? e.message : e);
        }
      }
      if (!sent) enqueueLog(payload);
      // Opportunistic flush of any backlog
      for (const win of wins) flushLogsTo(win);
    }
  } finally {
    broadcasting = false;
  }
}

// Hook global consoles
console.log  = (...args) => broadcastLog('log',   ...args);
console.warn = (...args) => broadcastLog('warn',  ...args);
console.error= (...args) => broadcastLog('error', ...args);


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
  // Flush any queued logs after renderer finishes loading
  win.webContents.on('did-finish-load', () => flushLogsTo(win));

  // If the renderer crashes/exits, just queue logs and avoid sending
  win.webContents.on('render-process-gone', (_e, details) => {
    console.warn('Renderer gone:', details && details.reason ? details.reason : 'unknown');
  });

}

app.whenReady().then(createWindow);

ipcMain.handle('scrape-prices', async (event, inputFilePath) => {
  console.log('⚡️ scrape-prices IPC called');
  try {
    let win = BrowserWindow.getFocusedWindow();
    if (!win) {
      const windows = BrowserWindow.getAllWindows();
      win = windows.find(w => w.isVisible()) || windows[0];
    }

    console.log('🔌 Starting scraping...');
    const result = await pbScraper.runWithProgress(
      (percent, message) => {
        console.log(`📦 Progress: ${percent}% - ${message}`);
        if (win && !win.isDestroyed()) {
          win.webContents.send('progress-update', percent, message);
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
  const result = await dbManager.wipeDatabase();
  return result;
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

ipcMain.handle('get-images-dir', async () => imagesDir);


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

  win.loadFile(path.join(__dirname, 'db', 'dbViewer.html'));
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



