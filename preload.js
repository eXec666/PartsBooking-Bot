// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  // Database initialization & management
  initDb:           () => ipcRenderer.invoke('init-db'),
  resetDatabase:           () => ipcRenderer.invoke('wipe-db'),
  refreshDatabase:  () => ipcRenderer.invoke('refresh-database'),

  // Excel file import & scraping
  selectExcelFile:       () => ipcRenderer.invoke('select-excel-file'),
  scrapePrices:        (filePath) => ipcRenderer.invoke('scrape-prices', filePath),
  
  // Database viewer (legacy call—now routed into same window)
  openDbViewer:   () => ipcRenderer.send('open-db-viewer'),
  getTableData:   (table) => ipcRenderer.invoke('get-table-data', table),
  
  downloadCsv: () => ipcRenderer.invoke('download-csv'),

  openImages: async () => {
    const dir = await ipcRenderer.invoke('get-images-dir');
    return ipcRenderer.invoke('open-folder', dir);
  },

  // File system helpers
  openFolder: (dirPath) => ipcRenderer.invoke('open-folder', dirPath),

  // Progress
  onProgress:     (callback) => {
    ipcRenderer.on('progress-update', (event, percent, message) => {
      callback(percent, message);
    });
  },

  onScrapeState: (callback) => {
    ipcRenderer.on('scrape-state', (_e, active) => callback(!!active));
  },

  onForceRefresh: (callback) => {
    ipcRenderer.on('force-refresh', callback);
  },
    
  onDbDumpProgress: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on('ui:db-dump-progress', listener);
        // return unsubscribe so you can clean up if needed
        return () => ipcRenderer.removeListener('ui:db-dump-progress', listener);
  },
});




// === Logging bridge ===
contextBridge.exposeInMainWorld('logs', {
  // Subscribe to snapshot + live appends
  subscribe: (handler) => {
    ipcRenderer.send('log:subscribe');
    const onSnap = (_e, buf) => handler({ type: 'snapshot', data: buf });
    const onAppend = (_e, entry) => handler({ type: 'append', data: entry });
    ipcRenderer.on('log:snapshot', onSnap);
    ipcRenderer.on('log:append', onAppend);
    // return unsubscribe
    return () => {
      ipcRenderer.removeListener('log:snapshot', onSnap);
      ipcRenderer.removeListener('log:append', onAppend);
    };
  },
  // Emit one entry upstream
  emit: (entry) => ipcRenderer.send('log:emit', entry),
  open: () => ipcRenderer.invoke('log:open-file')
});

// Wrap page console in this renderer to forward logs to main.
// Kept minimal and safe; does not alter Node/Electron internals.
window.addEventListener('DOMContentLoaded', () => {
  try {
    const orig = { log: console.log, warn: console.warn, error: console.error };
    ['log', 'warn', 'error'].forEach(level => {
      console[level] = (...args) => {
        try { orig[level](...args); } catch {}
        try {
          window.logs?.emit({ ts: Date.now(), level, args, source: 'renderer' });
        } catch {}
      };
    });
  } catch {}
});
