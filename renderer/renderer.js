// renderer.js
document.addEventListener('DOMContentLoaded', () => {

  // --- Tabs & panels ---
  const topTabs = document.querySelectorAll('#topTabs button');
  const panels = {
    main: document.getElementById('main'),
    db:   document.getElementById('db'),
    logs: document.getElementById('logs'),
  };

  topTabs.forEach(btn => {
    btn.addEventListener('click', () => {
      // Activate tab button
      topTabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // Show corresponding panel
      Object.values(panels).forEach(p => p.classList.remove('active'));
      const tab = btn.dataset.tab;
      panels[tab].classList.add('active');
      // If opening DB tab, init its renderer
      if (tab === 'db') window.dbViewerRenderer.init();
    });
  });

  // --- DOM Elements ---
  // Main
  const partInput         = document.getElementById('partNumberInput');
  const queryPartBtn      = document.getElementById('queryPartBtn');
  const selectFileBtn     = document.getElementById('selectFileBtn');
  const startPricesBtn = document.getElementById('startPricesBtn');
  const filePathDisplay   = document.getElementById('filePathDisplay');
  const progressBar       = document.querySelector('#progressBar > div');

  // DB
  const wipeDbBtn     = document.getElementById('wipeDbBtn');
  const openDbBtn     = document.getElementById('openDbBtn');
  const downloadCsvBtn = document.getElementById('downloadCsvBtn');
  const openImagesBtn = document.getElementById('openImagesBtn')

  // Logs
  const logsWindow   = document.getElementById('logsWindow');
  const scrollDownBtn = document.getElementById('scrollDownBtn');

  // DB progress elements
  

  // State variables
  let debounceTimer;
  let selectedFilePath = null;
  let autoScroll       = true;

  // --- Logging (bounded + batched DOM writes) ---
const MAX_LOG_LINES = 1000;
let pendingLogNodes = [];
let logsFlushScheduled = false;

function scheduleLogsFlush() {
  if (logsFlushScheduled) return;
  logsFlushScheduled = true;
  requestAnimationFrame(() => {
    const frag = document.createDocumentFragment();
    for (const n of pendingLogNodes) frag.appendChild(n);
    pendingLogNodes = [];
    logsWindow.appendChild(frag);

    // Enforce cap
    while (logsWindow.children.length > MAX_LOG_LINES) {
      logsWindow.removeChild(logsWindow.firstChild);
    }
    if (autoScroll) logsWindow.scrollTop = logsWindow.scrollHeight;
    logsFlushScheduled = false;
  });
}

function appendLog({ level, msg, ts }) {
  const line = document.createElement('div');
  line.textContent = `[${ts}] ${msg}`;
  line.style.color = level === 'error' ? 'red' : '#888';
  pendingLogNodes.push(line);
  scheduleLogsFlush();
}

// Single-message listener (existing channel)
window.electronAPI.onLog(appendLog);

// Optional batched listener if you later add it in preload
if (window.electronAPI.onLogBatch) {
  window.electronAPI.onLogBatch((batch) => {
    for (const item of batch) appendLog(item);
  });
}


  logsWindow.addEventListener('scroll', () => {
    const atBottom = logsWindow.scrollTop + logsWindow.clientHeight 
                   >= logsWindow.scrollHeight - 5;
    autoScroll = atBottom;
    scrollDownBtn.style.display = atBottom ? 'none' : 'block';
  });
  scrollDownBtn.addEventListener('click', () => {
    logsWindow.scrollTop = logsWindow.scrollHeight;
    autoScroll = true;
    scrollDownBtn.style.display = 'none';
  });


  // --- Helpers ---
  function showNotification(message, isError = false) {
    const note = document.createElement('div');
    note.className = `notification ${isError ? 'error' : ''}`;
    note.textContent = message;
    document.body.appendChild(note);
    setTimeout(() => note.remove(), 3000);
  }

  function createModal(title, contentHTML, closeCallback = null) {
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    const content = document.createElement('div');
    content.className = 'modal-content';
    content.innerHTML = `
      <h2>${title}</h2>
      ${contentHTML}
      <button class="modal-close-btn">Close</button>
    `;
    modal.appendChild(content);
    document.body.appendChild(modal);

    // Close button handler
    content.querySelector('.modal-close-btn').addEventListener('click', () => {
      document.body.removeChild(modal);
      if (closeCallback) closeCallback();
    });

    return modal;
  }


  // --- File / Scrape Buttons (Главное меню) ---
  selectFileBtn.addEventListener('click', async () => {
    try {
      const fp = await window.electronAPI.selectExcelFile();
      if (fp) {
        selectedFilePath = fp;
        filePathDisplay.textContent = `Selected: ${fp.split('\\').pop()}`;
        startPricesBtn.disabled = false;
      } else {
        showNotification('No file selected');
      }
    } catch (err) {
      showNotification(`Error: ${err.message}`, true);
    }
  });

  startPricesBtn.addEventListener('click', async () => {
    if (!selectedFilePath) {
      showNotification('Please select an Excel file first', true);
      return;
    }
    startPricesBtn.disabled = true;
    startPricesBtn.textContent = 'Запуск Цен...';
    try {
      const res = await window.electronAPI.scrapePrices(selectedFilePath);
      if (res.error) throw new Error(res.error);
      showNotification(res.message || 'Completed!');
    } catch (err) {
      showNotification(`Error: ${err.message}`, true);
    } finally {
      startPricesBtn.disabled = false;
      startPricesBtn.textContent = 'Запустить Цены';
    }
  });
  
   if (queryPartBtn) {
    queryPartBtn.addEventListener('click', performSearch);
  }

    // Listen for DB dump progress and update the second bar
  

  // --- DB Tab Buttons ---
  function displayTableData(data) {
    createModal(
      'Database Table Data',
      `
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Part Number</th>
                <th>Equipment Ref ID</th>
                <th>Node Path</th>
              </tr>
            </thead>
            <tbody>
              ${data.map(row => `
                <tr>
                  <td>${row.partNumber || 'N/A'}</td>
                  <td>${row.equipmentRefId || 'N/A'}</td>
                  <td>${row.nodePath || 'N/A'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <p class="table-meta">Showing ${data.length} records</p>
      `
    );
  }
  
  wipeDbBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to wipe the database?')) {
      try {
        await window.electronAPI.resetDatabase();
        showNotification('Database wiped');

        // Refresh DB tab only if the DB tab is active and dbViewerRenderer is available
        if (typeof window.dbViewerRenderer?.init === 'function') {
          window.dbViewerRenderer.init();
        }
      } catch (err) {
        showNotification(`Error: ${err.message}`, true);
      }
    }
  });
  
  if (openDbBtn) {
    openDbBtn.addEventListener('click', () => {
      window.electronAPI.openDbViewer();
    });
  }

  if (downloadCsvBtn) {
    downloadCsvBtn.addEventListener('click', async () => {
      downloadCsvBtn.disabled = true;
      downloadCsvBtn.textContent = 'Generating CSV...';

      try {
        const result = await window.electronAPI.downloadCsv();
        if (result.error) throw new Error(result.error);

        showNotification(result.message || `CSV files saved to: ${result.directory}`);
        window.electronAPI.openFolder(result.directory);
      } catch (error) {
        showNotification(`Error: ${error.message}`, true);
      } finally {
        downloadCsvBtn.disabled = false;
        downloadCsvBtn.textContent = 'Download CSV';
      }
    });
  }

  if (openImagesBtn) {
    openImagesBtn.addEventListener('click', async () => {
      openImagesBtn.disabled = true;
      openImagesBtn.textContent = 'Открываем папку с фото';

      try {
        const result = await window.electronAPI.openImages();
        if (result.error) throw new Error(result.error);

        showNotification(result.message || `Photos saved to: ${result.directory}`);
        window.electronAPI.openFolder(result.directory);
      } catch (error) {
        showNotification(`Error: ${error.message}`, true);
      } finally {
        openImagesBtn.disabled = false;
        openImagesBtn.textContent = 'Открыть фото';
      }
    });
  }

  // --- Progress Updates ---
 window.electronAPI.onProgress(( percent, message ) => {
   // prices_scraper may send null/undefined percent; guard the UI
    if (typeof percent === 'number' && isFinite(percent)) {
     const p = Math.max(0, Math.min(100, Math.round(percent)));
      progressBar.style.width = `${p}%`;
      progressBar.textContent = `${p}%`;
    } else {
      // keep bar as-is; expose textual pulse via content if needed
      progressBar.textContent = message || '';
    }
  });
});
