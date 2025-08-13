document.addEventListener('DOMContentLoaded', async () => {
  const tabs = document.querySelectorAll('.tab');
  const searchInput = document.getElementById('searchInput');
  const refreshButton = document.getElementById('refreshButton');
  let currentTable = 'parts';
  let tableData = {};

  // Tab switching functionality
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Remove active class from all tabs
      tabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      
      // Set active tab and content
      tab.classList.add('active');
      currentTable = tab.dataset.tab;
      document.getElementById(`${currentTable}-content`).classList.add('active');
      
      // Load or filter data
      if (tableData[currentTable]) {
        filterTable(currentTable);
      } else {
        loadTableData(currentTable);
      }
    });
  });

  // Search functionality
  searchInput.addEventListener('input', () => {
    filterTable(currentTable);
  });

  // Refresh button functionality
  refreshButton.addEventListener('click', () => {
    loadTableData(currentTable, true);
  });

  /**
   * Loads table data from the database
   * @param {string} tableName - Name of the table to load
   * @param {boolean} force - Whether to force reload from database
   */
  async function loadTableData(tableName, force = false) {
    const tableBody = document.querySelector(`#${tableName}-table tbody`);
    tableBody.innerHTML = '<tr><td colspan="100%" class="loading-message">Loading data...</td></tr>';

    try {
      if (force || !tableData[tableName]) {
        const response = await window.electronAPI.getTableData();
        
        if (!response || !response.success) {
          throw new Error(response?.error || 'Failed to load table data');
        }

        // Map UI table names to database table names
        const tableMapping = {
          'parts': 'parts',
          'vehicles': 'vehicles',
          'compatibility': 'compatibility',
          'nodes': 'nodes'
        };

        const dbTableName = tableMapping[tableName];
        if (!response.data || !response.data[dbTableName]) {
          throw new Error(`Table ${dbTableName} not found in database`);
        }

        // Ensure we have an array
        tableData[tableName] = Array.isArray(response.data[dbTableName]) 
          ? response.data[dbTableName] 
          : Object.values(response.data[dbTableName]);
      }

      filterTable(tableName);
    } catch (error) {
      console.error(`Error loading ${tableName}:`, error);
      tableBody.innerHTML = `<tr><td colspan="100%" class="error-message">Error: ${error.message}</td></tr>`;
    }
  }

  /**
   * Filters and displays table data based on search input
   * @param {string} tableName - Name of the table to filter
   */
  function filterTable(tableName) {
    const tableBody = document.querySelector(`#${tableName}-table tbody`);
    
    // Validate data
    if (!tableData[tableName] || !Array.isArray(tableData[tableName])) {
      tableBody.innerHTML = '<tr><td colspan="100%" class="loading-message">No data available</td></tr>';
      return;
    }

    const searchTerm = searchInput.value.toLowerCase();
    const filteredData = tableData[tableName].filter(row => {
      if (!row) return false;
      return Object.values(row).some(val => 
        String(val || '').toLowerCase().includes(searchTerm)
      );
    });

    // Clear previous results
    tableBody.innerHTML = '';
    
    // Handle empty results
    if (filteredData.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="100%" class="loading-message">No matching records found</td></tr>';
      return;
    }

    // Render table rows based on table type
    filteredData.forEach(row => {
      const tr = document.createElement('tr');
      
      switch(tableName) {
        case 'parts':
          tr.innerHTML = `
            <td>${row.part_id || ''}</td>
            <td>${row.part_number || ''}</td>
          `;
          break;
          
        case 'vehicles':
          tr.innerHTML = `
            <td>${row.vehicle_id || ''}</td>
            <td>${row.vehicle_name || ''}</td>
            <td>${row.equipment_ref_id || ''}</td>
          `;
          break;
          
        case 'compatibility':
          tr.innerHTML = `
            <td>${row.vehicle_id || ''}</td>
            <td>${row.part_id || ''}</td>
          `;
          break;
          
        case 'nodes':
          tr.innerHTML = `
            <td>${row.node_id || ''}</td>
            <td>${row.node_desc || ''}</td>
          `;
          break;
          
        default:
          // Fallback for unknown tables
          Object.values(row).forEach(value => {
            const td = document.createElement('td');
            td.textContent = value !== null ? value : 'NULL';
            tr.appendChild(td);
          });
      }
      
      tableBody.appendChild(tr);
    });
  }

  // Force refresh event listener
  window.addEventListener('force-refresh', () => {
    const activeTab = document.querySelector('.tab.active');
    if (activeTab) {
      const tableName = activeTab.dataset.tab;
      loadTableData(tableName, true);
    }
  });

  // Initial load
  loadTableData('parts');
});