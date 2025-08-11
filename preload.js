// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  // Database initialization & management
  initDb:           () => ipcRenderer.invoke('init-db'),
  resetDatabase:           () => ipcRenderer.invoke('wipe-db'),
  refreshDatabase:  () => ipcRenderer.invoke('refresh-database'),

  // Excel file import & scraping
  selectExcelFile:       () => ipcRenderer.invoke('select-excel-file'),
  scrapeVehicles:        (filePath) => ipcRenderer.invoke('scrape-vehicles', filePath),
  scrapeNodes:           () => ipcRenderer.invoke('scrape-nodes'),

  // Part lookups & suggestions
  queryPart:             (partNumber) => ipcRenderer.invoke('query-part', partNumber),
  queryPartSuggestions:  (query)       => ipcRenderer.invoke('query-part-suggestions', query),

  // Node details
  getNodeDetails:        (partNumber, vehicleId) => 
                          ipcRenderer.invoke('get-node-details', partNumber, vehicleId),

  // Database viewer (legacy call—now routed into same window)
  openDbViewer:   () => ipcRenderer.send('open-db-viewer'),
  getTableData:   (table) => ipcRenderer.invoke('get-table-data', table),
  downloadCsv: () => ipcRenderer.invoke('download-csv'),


  // File system helpers
  openFolder: (dirPath) => ipcRenderer.invoke('open-folder', dirPath),

  // Progress & logs
  onProgress:     (callback) => {
    ipcRenderer.on('progress-update', (event, percent, message) => {
      callback(percent, message);
    });
  },
  onLog:          (callback) => {
    ipcRenderer.on('log-message', (event, payload) => {
      callback(payload);
    });
  },
  
  onForceRefresh: (callback) => {
    ipcRenderer.on('force-refresh', callback);
  },
    
  onDbDumpProgress: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on('ui:db-dump-progress', listener);
        // return unsubscribe so you can clean up if needed
        return () => ipcRenderer.removeListener('ui:db-dump-progress', listener);
  }
});
