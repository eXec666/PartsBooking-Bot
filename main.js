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

//log forwarding
function broadcastLog(level, ...args) {
  originalLog.apply(console, args);
  const msg = args.map(a => String(a)).join(' ');
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) win.webContents.send('log-message', { level, msg, ts: new Date().toISOString() });
  });
}
console.log = (...args) => broadcastLog('log', ...args);
console.error = (...args) => broadcastLog('error', ...args);

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



