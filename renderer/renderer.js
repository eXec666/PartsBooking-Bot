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
  const startTechniqueBtn = document.getElementById('startTechniqueBtn'); //rename to startVehicleBtn
  const startNodesBtn     = document.getElementById('startNodesBtn');
  const filePathDisplay   = document.getElementById('filePathDisplay');
  const progressBar       = document.querySelector('#progressBar > div');

  // DB
  const wipeDbBtn     = document.getElementById('wipeDbBtn');
  const openDbBtn     = document.getElementById('openDbBtn');
  const downloadCsvBtn = document.getElementById('downloadCsvBtn');

  // Logs
  const logsWindow   = document.getElementById('logsWindow');
  const scrollDownBtn = document.getElementById('scrollDownBtn');

  // DB progress elements
  const dbSection = document.getElementById('db-dump-section');
  const dbBar = document.getElementById('db-progress-bar');
  const dbLabel = document.getElementById('db-progress-label');
  const dbMeta = document.getElementById('db-progress-meta');

  // State variables
  let debounceTimer;
  let selectedFilePath = null;
  let autoScroll       = true;

  // --- Logging ---
  function appendLog({ level, msg, ts }) {
    const line = document.createElement('div');
    line.textContent = `[${ts}] ${msg}`;
    line.style.color = level === 'error' ? 'red' : '#888';
    logsWindow.appendChild(line);
    if (autoScroll) logsWindow.scrollTop = logsWindow.scrollHeight;
  }
  window.electronAPI.onLog(appendLog);

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

  // ======================
  // Search Functionality
  // ======================
  if (partInput) {
    partInput.addEventListener('focus', function () {
      this.select();
      if (searchResults) searchResults.style.display = 'none';
    });

    partInput.addEventListener('input', function (e) {
      clearTimeout(debounceTimer);
      const query = e.target.value.trim();

      if (!searchResults) return;

      if (query.length < 3) {
        searchResults.style.display = 'none';
        return;
      }

      debounceTimer = setTimeout(async () => {
        try {
          const result = await window.electronAPI.queryPartSuggestions(query);
          displayResults(result.suggestions);
        } catch (error) {
          console.error('Search error:', error);
          searchResults.style.display = 'none';
        }
      }, 300);
    });

    partInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        if (searchResults) searchResults.style.display = 'none';
        performSearch();
      }
    });
  }

  function displayResults(suggestions) {
    if (!searchResults) return;
    searchResults.innerHTML = '';
    if (suggestions.length > 0) {
      suggestions.forEach(suggestion => {
        const div = document.createElement('div');
        div.className = 'search-item';
        div.textContent = suggestion;
        div.addEventListener('click', () => {
          partInput.value = suggestion;
          searchResults.style.display = 'none';
          performSearch();
        });
        searchResults.appendChild(div);
      });
      searchResults.style.display = 'block';
    } else {
      searchResults.style.display = 'none';
    }
  }

  async function performSearch() {
    const partNumber = partInput.value.trim();
    if (!partNumber) return;

    try {
      const result = await window.electronAPI.queryPart(partNumber);
      if (result.error) throw new Error(result.error);

      showResultsModal(partNumber, result);
    } catch (error) {
      console.error('Search failed:', error);
      showNotification(`Error: ${error.message}`, true);
    }
  }

  function showResultsModal(partNumber, result) {
    createModal(
      `Compatibility Results for ${partNumber}`,
      `
        <p>Found ${result.totalUnique} compatible vehicles:</p>
        <ul class="vehicle-list">
          ${result.rows.map(r => `
            <li class="vehicle-item" data-vehicle-id="${r.vehicle_id}"
                data-part-number="${partNumber}">
              ${r.vehicle_name} (${r.cnt} matches)
            </li>
          `).join('')}
        </ul>
      `,
      () => partInput.focus()
    );
    // Add click handlers for vehicle items
    document.querySelectorAll('.vehicle-item').forEach(item => {
      item.addEventListener('click', e => {
        showNodeDetails(
          e.currentTarget.dataset.partNumber,
          e.currentTarget.dataset.vehicleId
        );
      });
    });
  }

  async function showNodeDetails(partNumber, vehicleId) {
    const loadingModal = createModal(
      'Loading Node Details',
      '<div class="loader"></div>'
    );

    try {
      const result = await window.electronAPI.getNodeDetails(partNumber, vehicleId);
      document.body.removeChild(loadingModal);

      if (result.error) throw new Error(result.error);
        createModal(
        'Node Details',
        `
          <p><strong>Part:</strong> ${partNumber}</p>
          <p><strong>Vehicle:</strong> ${result.vehicleName}</p>
          <div class="node-list">
            ${result.nodes.length > 0
              ? result.nodes.map(node => `<div class="node-item">${node}</div>`).join('')
              : '<p>No nodes found</p>'}
          </div>
        `
      );
    } catch (err) {
      document.body.removeChild(loading);
      console.error(err);
      showNotification(`Error: ${err.message}`, true);
    }
  }

  // --- File / Scrape Buttons (Главное меню) ---
  selectFileBtn.addEventListener('click', async () => {
    try {
      const fp = await window.electronAPI.selectExcelFile();
      if (fp) {
        selectedFilePath = fp;
        filePathDisplay.textContent = `Selected: ${fp.split('\\').pop()}`;
        startTechniqueBtn.disabled = false;
      } else {
        showNotification('No file selected');
      }
    } catch (err) {
      showNotification(`Error: ${err.message}`, true);
    }
  });

  startTechniqueBtn.addEventListener('click', async () => {
    if (!selectedFilePath) {
      showNotification('Please select an Excel file first', true);
      return;
    }
    startTechniqueBtn.disabled = true;
    startTechniqueBtn.textContent = 'Запуск Цен...';
    try {
      const res = await window.electronAPI.scrapeVehicles(selectedFilePath);
      if (res.error) throw new Error(res.error);
      showNotification(res.message || 'Completed!');
    } catch (err) {
      showNotification(`Error: ${err.message}`, true);
    } finally {
      startTechniqueBtn.disabled = false;
      startTechniqueBtn.textContent = 'Запустить Цены';
    }
  });
  
   if (queryPartBtn) {
    queryPartBtn.addEventListener('click', performSearch);
  }

  startNodesBtn.addEventListener('click', async () => {
    startNodesBtn.disabled = true;
    startNodesBtn.textContent = 'Запуск узлов...';
    try {
      const res = await window.electronAPI.scrapeNodes();
      if (res.error) throw new Error(res.error);
      showNotification(res.message || 'Completed!');
    } catch (err) {
      showNotification(`Error: ${err.message}`, true);
    } finally {
      startNodesBtn.disabled = false;
      startNodesBtn.textContent = 'Запустить узлы';
    }
  });
  
    // Listen for DB dump progress and update the second bar
  if (window.electronAPI?.onDbDumpProgress && dbSection && dbBar && dbLabel && dbMeta) {
    const unsubscribeDb = window.electronAPI.onDbDumpProgress(({ table, done, total, percent }) => {
      if (dbSection.style.display === 'none') dbSection.style.display = 'block';
      const p = Math.max(0, Math.min(100, Number(percent) || 0));
      dbBar.style.width = `${p}%`;
      dbLabel.textContent = `${p}%`;
      dbMeta.textContent = `${done} / ${total} rows • ${table}`;
    });
    window.addEventListener('beforeunload', () => unsubscribeDb && unsubscribeDb());
  }

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
