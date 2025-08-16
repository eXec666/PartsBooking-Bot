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
      //if (tab === 'db') window.dbViewerRenderer.init();
    });
  });

  // --- DOM Elements ---
  // Main
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

  //Progress updates:
  const progressStats = document.getElementById('progressStats');
  const statProcessed = document.getElementById('statProcessed');
  const statElapsed   = document.getElementById('statElapsed');
  const statEta       = document.getElementById('statEta');


  // renderer.js — helper to parse and display the 3-line progress message
  function updateProgressStats(message) {
    if (!progressStats || !message) return;
    // Expect lines like:
    // "Processed 123 / 999"
    // "Elapsed 00:01:23"
    // "ETA 00:04:56"
    const lines = String(message).split('\n').map(s => s.trim()).filter(Boolean);

    const processed = lines.find(l => /^Processed/i.test(l)) || '';
    const elapsed   = lines.find(l => /^Elapsed/i.test(l))   || '';
    const eta       = lines.find(l => /^ETA/i.test(l))       || '';

    if (statProcessed) statProcessed.textContent = processed || 'Обработано —';
    if (statElapsed)   statElapsed.textContent   = elapsed   || 'Время работы —';
    if (statEta)       statEta.textContent       = eta       || 'ETA —';
  }



  // renderer.js — wire up existing "Открыть логи" button (expects #openLogsBtn in HTML)

  (function setupOpenLogsButton() {
    const btn = document.getElementById('openLogsBtn');
    const logsWindow = document.getElementById('logsWindow');
    if (!btn || !window.logs) return;

    // Avoid duplicate handlers
    if (btn.__openLogsWired) return;
    btn.__openLogsWired = true;

    btn.addEventListener('click', async () => {
      try {
        const res = await window.logs.open();
        if (res && res.ok === false && logsWindow) {
          const line = document.createElement('div');
          line.textContent = `[${new Date().toLocaleTimeString()}] ERROR (renderer) Не удалось открыть logs.txt: ${res.error}`;
          logsWindow.appendChild(line);
          logsWindow.scrollTop = logsWindow.scrollHeight;
        }
      } catch (e) {
        if (logsWindow) {
          const line = document.createElement('div');
          line.textContent = `[${new Date().toLocaleTimeString()}] ERROR (renderer) Не удалось открыть logs.txt: ${e.message}`;
          logsWindow.appendChild(line);
          logsWindow.scrollTop = logsWindow.scrollHeight;
        }
      }
    });
  })();



  /* === Logs UI (bounded FIFO, realtime) === */
  (function setupLogsUI() {
    const logsWindow = document.getElementById('logsWindow');
    if (!logsWindow || !window.logs) return;

    const UI_CAP = 1000;
    const state = [];     // last N entries for rendering
    let autoScroll = true;

    // Preserve existing "down" button behavior: we only read its presence and attach no conflicting handlers.
    const scrollDownBtn = document.getElementById('scrollDownBtn');

    // Auto-scroll detection: if user scrolls up, pause auto-scroll; if near bottom, resume.
    logsWindow.addEventListener('scroll', () => {
      const nearBottom = (logsWindow.scrollTop + logsWindow.clientHeight) >= (logsWindow.scrollHeight - 4);
      autoScroll = nearBottom;
    }, { passive: true });

    function format(entry) {
      const dt = new Date(entry.ts || Date.now());
      const ts = isNaN(dt.getTime()) ? '' : dt.toLocaleTimeString();
      const lvl = (entry.level || 'log').toUpperCase();
      const src = entry.source || 'renderer';
      const msg = entry.msg != null ? String(entry.msg) :
        (Array.isArray(entry.args) ? entry.args.map(a => {
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch { return String(a); }
        }).join(' ') : '');
      return `[${ts}] ${lvl} (${src}) ${msg}`;
    }

    function renderSnapshot(list) {
      state.length = 0;
      logsWindow.textContent = ''; // flush DOM
      const frag = document.createDocumentFragment();
      const start = Math.max(0, list.length - UI_CAP);
      for (let i = start; i < list.length; i++) {
        const line = document.createElement('div');
        line.textContent = format(list[i]);
        frag.appendChild(line);
        state.push(list[i]);
      }
      logsWindow.appendChild(frag);
      if (autoScroll) logsWindow.scrollTop = logsWindow.scrollHeight;
    }

    function renderAppend(entry) {
      state.push(entry);
      if (state.length > UI_CAP) {
        state.shift();
        // remove one DOM node from the head if present
        if (logsWindow.firstChild) logsWindow.removeChild(logsWindow.firstChild);
      }
      const line = document.createElement('div');
      line.textContent = format(entry);
      logsWindow.appendChild(line);
      if (autoScroll) logsWindow.scrollTop = logsWindow.scrollHeight;
    }

    // Subscribe to stream
    try {
      window.logs.subscribe((evt) => {
        if (evt.type === 'snapshot') renderSnapshot(evt.data || []);
        else if (evt.type === 'append') renderAppend(evt.data);
      });
    } catch (e) {
      // Fallback: show one error and continue
      const err = document.createElement('div');
      err.textContent = `[${new Date().toLocaleTimeString()}] ERROR (renderer) Log subscribe failed: ${e.message}`;
      logsWindow.appendChild(err);
    }

    // Optional: if a "down" button exists, keep it working without altering its handler.
    if (scrollDownBtn && !scrollDownBtn.__wiredForLogs) {
      scrollDownBtn.addEventListener('click', () => {
        logsWindow.scrollTop = logsWindow.scrollHeight;
        autoScroll = true;
      }, { passive: true });
      scrollDownBtn.__wiredForLogs = true;
    }
  })();
  /* === /Logs UI === */

  

  // State variables
  let debounceTimer;
  let selectedFilePath = null;
  let autoScroll       = true;

  // --- Logging (bounded + batched DOM writes) ---
  

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
    // renderer.js — clear stats when a new run starts (inside startPricesBtn click handler, before calling scrape)
    if (progressStats) {
      if (statProcessed) statProcessed.textContent = 'Processed —';
      if (statElapsed)   statElapsed.textContent   = 'Elapsed —';
      if (statEta)       statEta.textContent       = 'ETA —';
    }

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
  if (window.electronAPI?.onProgress) window.electronAPI.onProgress((percent, message) => {
    if (typeof percent === 'number' && isFinite(percent)) {
      const p = Math.max(0, Math.min(100, Math.round(percent)));
      progressBar.style.width = `${p}%`;
      progressBar.textContent = `${p}%`;
    } else {
      progressBar.textContent = message || '';
    }
    updateProgressStats(message);
  });
});
