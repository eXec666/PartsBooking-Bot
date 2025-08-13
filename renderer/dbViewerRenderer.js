// dbViewerRenderer.js — rewritten to fit the new dbViewer.html
// Assumptions & wiring notes:
// - The HTML provides inputs with ids: fPart, fBrand, fRankMin, fRankMax, fOurMin, fOurMax,
//   toggles tCheaper, tMissing, pager controls pageSize, prevPage, nextPage, pageInfo,
//   and containers errorBanner, dbViewer. (Matches dbViewer.html)
// - Data backend: this module tries several adapters in this order:
//     1) window.db.queryPrices(payload)
//     2) window.api.queryPrices(payload)
//     3) window.electronAPI.queryPrices(payload)
//     4) HTTP GET to '/api/prices'
//   Implement ONE of these on your side; payload shape documented below.
// - Expected backend response: { items: PriceRow[], total: number }
//   where PriceRow has at least: { id, part, brand, rank, ourPrice, leaderPrice, leaderName?, updatedAt? }
//   Any extra fields are ignored. Missing leaderPrice is treated as "Missing competitor price".
// - Sorting fields used from UI: 'rank' | 'part' | 'brand' | 'ourPrice' | 'leaderPrice' | 'delta' | 'updatedAt'
//
// Author: Tabs (2025)

/* eslint-disable no-console */

const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  filters: {
    part: '',
    brand: '',
    rankMin: undefined,
    rankMax: undefined,
    ourMin: undefined,
    ourMax: undefined,
    cheaper: false,
    missing: false,
  },
  sort: { by: 'rank', dir: 'asc' },
  page: { index: 0, size: 100 },
  data: [],
  total: 0,
  loading: false,
  lastError: null,
};

const el = {
  root: document.body,
  error: qs('#errorBanner'),
  viewer: qs('#dbViewer'),
  fPart: qs('#fPart'),
  fBrand: qs('#fBrand'),
  fRankMin: qs('#fRankMin'),
  fRankMax: qs('#fRankMax'),
  fOurMin: qs('#fOurMin'),
  fOurMax: qs('#fOurMax'),
  tCheaper: qs('#tCheaper'),
  tMissing: qs('#tMissing'),
  pageSize: qs('#pageSize'),
  prevPage: qs('#prevPage'),
  nextPage: qs('#nextPage'),
  pageInfo: qs('#pageInfo'),
};

// ---------- Utilities ----------
const debounce = (fn, ms = 300) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

const parseNum = (v) => {
  if (v === '' || v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const fmtNum = (v, dp = 2) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(dp));

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
};

const computeDelta = (ourPrice, leaderPrice) => {
  if (ourPrice == null || leaderPrice == null || !Number.isFinite(ourPrice) || !Number.isFinite(leaderPrice))
    return { abs: null, pct: null, sign: 'neu' };
  const abs = ourPrice - leaderPrice; // positive => more expensive than leader
  const pct = leaderPrice === 0 ? null : abs / leaderPrice;
  const sign = abs < 0 ? 'pos' : abs > 0 ? 'neg' : 'neu'; // pos => cheaper than leader
  return { abs, pct, sign };
};

const arrowFor = (by) => state.sort.by === by ? (state.sort.dir === 'asc' ? '▲' : '▼') : '▲';

const saveUiState = () => {
  try { localStorage.setItem('dbv.ui', JSON.stringify({
    filters: state.filters,
    sort: state.sort,
    page: state.page,
  })); } catch {}
};

const restoreUiState = () => {
  try {
    const raw = localStorage.getItem('dbv.ui');
    if (!raw) return;
    const s = JSON.parse(raw);
    Object.assign(state.filters, s.filters || {});
    Object.assign(state.sort, s.sort || {});
    Object.assign(state.page, s.page || {});
  } catch {}
};

// ---------- Backend adapter ----------
async function queryBackend(payload) {
  // Prefer Electron exposed API that returns the whole table; transform locally
  if (window.electronAPI?.getTableData) {
    try {
      const raw = await window.electronAPI.getTableData();
      // Expected shape now: { success: true, data: { prices: [...] } }
      const rowsSource = Array.isArray(raw?.data?.prices)
        ? raw.data.prices
        : (Array.isArray(raw?.prices) ? raw.prices : (Array.isArray(raw) ? raw : []));

      const norm = (r) => {
        const rank = r.rank_pos;
        const our = r.our_price;
        const leader = r.leader_price;
        const over = r.over_price;
        const under = r.under_price;
        return {
          // canonical fields used by the table
          id: r.id ?? `${r.brand_name || ''}:${r.part_number || ''}`,
          part: r.part_number ?? '',
          brand: r.brand_name ?? '',
          rank: Number.isFinite(Number(rank)) ? Number(rank) : null,
          ourPrice: Number.isFinite(Number(our)) ? Number(our) : null,
          leaderPrice: Number.isFinite(Number(leader)) ? Number(leader) : null,
          // keep extra hints if we want to show tooltips later
          leaderName: r.leader_code ?? null,
          overCode: r.over_code ?? null,
          overPrice: Number.isFinite(Number(over)) ? Number(over) : null,
          underCode: r.under_code ?? null,
          underPrice: Number.isFinite(Number(under)) ? Number(under) : null,
          updatedAt: null,
        };
      };

      const data = rowsSource.map(norm);
      const { filters, sort, page } = payload;

      const match = (r) => {
        const part = String(r.part || '').toLowerCase();
        const brand = String(r.brand || '').toLowerCase();
        const our = Number(r.ourPrice);
        const leader = Number(r.leaderPrice);
        if (filters.part && !part.includes(String(filters.part).toLowerCase())) return false;
        if (filters.brand && !brand.includes(String(filters.brand).toLowerCase())) return false;
        if (filters.rankMin != null && Number(r.rank) < filters.rankMin) return false;
        if (filters.rankMax != null && Number(r.rank) > filters.rankMax) return false;
        if (filters.ourMin != null && (!Number.isFinite(our) || our < filters.ourMin)) return false;
        if (filters.ourMax != null && (!Number.isFinite(our) || our > filters.ourMax)) return false;
        if (filters.cheaper && !(Number.isFinite(our) && Number.isFinite(leader) && our < leader)) return false;
        if (filters.missing && Number.isFinite(leader)) return false;
        return true;
      };

      const getSortVal = (r, by) => {
        switch (by) {
          case 'delta': {
            const d = computeDelta(Number(r.ourPrice), Number(r.leaderPrice));
            return d.abs == null ? Number.POSITIVE_INFINITY : d.abs;
          }
          case 'updatedAt':
            return r.updatedAt ? new Date(r.updatedAt).getTime() : 0;
          case 'ourPrice':
            return Number(r.ourPrice);
          case 'leaderPrice':
            return Number(r.leaderPrice);
          default:
            return r[by];
        }
      };

      let filtered = data.filter(match);
      filtered.sort((a, b) => {
        const va = getSortVal(a, sort.by);
        const vb = getSortVal(b, sort.by);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        if (typeof va === 'string' || typeof vb === 'string') {
          return sort.dir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
        }
        return sort.dir === 'asc' ? (va - vb) : (vb - va);
      });

      const total = filtered.length;
      const start = page.index * page.size;
      const items = filtered.slice(start, start + page.size);
      return { items, total };
    } catch (e) {
      console.warn('electronAPI.getTableData failed, will try IPC/HTTP fallbacks', e);
    }
  }

  // IPC adapters (if available) — expects server-side filtering
  try {
    if (window.db?.queryPrices) return await window.db.queryPrices(payload);
    if (window.api?.queryPrices) return await window.api.queryPrices(payload);
    if (window.electronAPI?.queryPrices) return await window.electronAPI.queryPrices(payload);
  } catch (e) {
    console.warn('IPC queryPrices failed, will try HTTP fallback', e);
  }

  // HTTP fallback (server expected to filter/sort/paginate)
  const params = new URLSearchParams();
  const { filters, sort, page } = payload;
  if (filters.part) params.set('part', filters.part);
  if (filters.brand) params.set('brand', filters.brand);
  if (filters.rankMin != null) params.set('rankMin', String(filters.rankMin));
  if (filters.rankMax != null) params.set('rankMax', String(filters.rankMax));
  if (filters.ourMin != null) params.set('ourMin', String(filters.ourMin));
  if (filters.ourMax != null) params.set('ourMax', String(filters.ourMax));
  if (filters.cheaper) params.set('cheaper', '1');
  if (filters.missing) params.set('missing', '1');
  if (sort?.by) params.set('sortBy', sort.by);
  if (sort?.dir) params.set('sortDir', sort.dir);
  params.set('page', String(page.index));
  params.set('pageSize', String(page.size));

  const res = await fetch(`/api/prices?${params.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// ---------- Rendering ----------
function renderTable(items) {
  if (!items?.length) return `<div class="empty">No rows match your filters.</div>`;

  const th = (key, label) => `<th class="sortable" data-key="${key}" aria-sort="${state.sort.by === key ? state.sort.dir : 'none'}">${label}<span class="arrow">${arrowFor(key)}</span></th>`;

  const head = `
    <thead>
      <tr>
        ${th('rank','Rank')}
        ${th('part','Part #')}
        ${th('brand','Brand')}
        ${th('ourPrice','Our price')}
        ${th('leaderPrice','Leader')}
        ${th('delta','Δ vs leader')}
        ${th('updatedAt','Updated')}
      </tr>
    </thead>`;

  const rows = items.map(r => {
    const { abs, pct, sign } = computeDelta(r.ourPrice, r.leaderPrice);
    const deltaHtml = (abs == null && pct == null)
      ? '<span class="delta neu">—</span>'
      : `<span class="delta ${sign}">${abs == null ? '' : (abs > 0 ? '+' : '') + fmtNum(abs)}${pct == null ? '' : ` (${(pct*100).toFixed(1)}%)`}</span>`;

    return `
      <tr>
        <td>${r.rank ?? '—'}</td>
        <td><code>${r.part ?? ''}</code></td>
        <td>${r.brand ?? ''}</td>
        <td>${fmtNum(r.ourPrice)}</td>
        <td>${r.leaderPrice == null ? '—' : fmtNum(r.leaderPrice)}</td>
        <td>${deltaHtml}</td>
        <td>${fmtDate(r.updatedAt)}</td>
      </tr>`;
  }).join('');

  return `<table class="table">${head}<tbody>${rows}</tbody></table>`;
}

function updatePageInfo() {
  const totalPages = Math.max(1, Math.ceil(state.total / state.page.size));
  const current = Math.min(totalPages, state.page.index + 1);
  el.pageInfo.textContent = `Page ${current} / ${totalPages} · ${state.total.toLocaleString()} rows`;
  el.prevPage.disabled = current <= 1;
  el.nextPage.disabled = current >= totalPages;
}

function setError(message) {
  state.lastError = message || null;
  if (state.lastError) {
    el.error.textContent = state.lastError;
    el.error.style.display = '';
  } else {
    el.error.style.display = 'none';
  }
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  saveUiState();
  setError(null);
  el.viewer.innerHTML = '<div class="empty">Loading…</div>';

  try {
    const payload = {
      filters: { ...state.filters },
      sort: { ...state.sort },
      page: { ...state.page },
    };

    const res = await queryBackend(payload);
    // Defensive parsing
    const items = Array.isArray(res?.items) ? res.items : [];
    state.total = Number.isFinite(res?.total) ? res.total : items.length;
    state.data = items;

    el.viewer.innerHTML = renderTable(items);

    // Bind header sort handlers after render
    qsa('th.sortable', el.viewer).forEach(th => {
      th.addEventListener('click', () => {
        const key = th.getAttribute('data-key');
        if (!key) return;
        if (state.sort.by === key) {
          state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sort.by = key;
          state.sort.dir = key === 'part' || key === 'brand' ? 'asc' : 'desc';
        }
        state.page.index = 0;
        refresh();
      });
    });
  } catch (e) {
    console.error(e);
    setError(`Failed to load data: ${e.message || e}`);
    el.viewer.innerHTML = '<div class="empty">Could not load data.</div>';
    state.data = [];
    state.total = 0;
  } finally {
    updatePageInfo();
    state.loading = false;
  }
}

// ---------- Event wiring ----------
function applyFiltersFromUI() {
  state.filters.part = el.fPart.value.trim();
  state.filters.brand = el.fBrand.value.trim();
  state.filters.rankMin = parseNum(el.fRankMin.value);
  state.filters.rankMax = parseNum(el.fRankMax.value);
  state.filters.ourMin = parseNum(el.fOurMin.value);
  state.filters.ourMax = parseNum(el.fOurMax.value);
  state.filters.cheaper = !!el.tCheaper.checked;
  state.filters.missing = !!el.tMissing.checked;
}

function setUIFromState() {
  el.fPart.value = state.filters.part ?? '';
  el.fBrand.value = state.filters.brand ?? '';
  el.fRankMin.value = state.filters.rankMin ?? '';
  el.fRankMax.value = state.filters.rankMax ?? '';
  el.fOurMin.value = state.filters.ourMin ?? '';
  el.fOurMax.value = state.filters.ourMax ?? '';
  el.tCheaper.checked = !!state.filters.cheaper;
  el.tMissing.checked = !!state.filters.missing;
  el.pageSize.value = String(state.page.size);
}

function initEvents() {
  const onChange = debounce(() => {
    applyFiltersFromUI();
    state.page.index = 0; // reset to first page on filter change
    refresh();
  }, 300);

  [el.fPart, el.fBrand, el.fRankMin, el.fRankMax, el.fOurMin, el.fOurMax]
    .forEach(input => {
      input.addEventListener('input', onChange);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') onChange(); });
    });

  [el.tCheaper, el.tMissing].forEach(cb => cb.addEventListener('change', onChange));

  el.pageSize.addEventListener('change', () => {
    const v = parseInt(el.pageSize.value, 10);
    state.page.size = Number.isFinite(v) ? v : state.page.size;
    state.page.index = 0;
    refresh();
  });

  el.prevPage.addEventListener('click', () => {
    if (state.page.index > 0) {
      state.page.index -= 1;
      refresh();
    }
  });
  el.nextPage.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(state.total / state.page.size));
    if (state.page.index + 1 < totalPages) {
      state.page.index += 1;
      refresh();
    }
  });
}

function ensureScaffold() {
  // If the new HTML doesn't include the toolbar/containers, create them dynamically
  let scaffoldCreated = false;
  if (!el.error) {
    const banner = document.createElement('div');
    banner.id = 'errorBanner';
    banner.style.display = 'none';
    banner.className = 'error-banner';
    document.body.prepend(banner);
    el.error = banner;
    scaffoldCreated = true;
  }
  if (!el.viewer) {
    const container = document.createElement('div');
    container.id = 'dbViewer';
    document.body.appendChild(container);
    el.viewer = container;
    scaffoldCreated = true;
  }
  if (!el.fPart) {
    const wrapper = document.createElement('div');
    wrapper.className = 'db-toolbar';
    wrapper.innerHTML = `
      <div class="field"><label for="fPart">Part #</label><input id="fPart" type="text" placeholder="e.g. 6PK1820" /></div>
      <div class="field"><label for="fBrand">Brand</label><input id="fBrand" type="text" placeholder="e.g. Gates" /></div>
      <div class="field"><label for="fRankMin">Rank ≥</label><input id="fRankMin" type="number" min="0" step="1" /></div>
      <div class="field"><label for="fRankMax">Rank ≤</label><input id="fRankMax" type="number" min="0" step="1" /></div>
      <div class="field"><label for="fOurMin">Our ≥</label><input id="fOurMin" type="number" min="0" step="0.01" /></div>
      <div class="field"><label for="fOurMax">Our ≤</label><input id="fOurMax" type="number" min="0" step="0.01" /></div>
      <div class="toggles">
        <label><input id="tCheaper" type="checkbox"/> Cheaper than leader</label>
        <label><input id="tMissing" type="checkbox"/> Missing competitor</label>
      </div>
      <div class="field">
        <label for="pageSize">Page size</label>
        <select id="pageSize">
          <option value="50">50</option>
          <option value="100" selected>100</option>
          <option value="200">200</option>
          <option value="500">500</option>
        </select>
      </div>
      <div class="pager">
        <button id="prevPage" type="button">◀</button>
        <span id="pageInfo"></span>
        <button id="nextPage" type="button">▶</button>
      </div>`;
    (el.viewer?.parentNode || document.body).insertBefore(wrapper, el.viewer || null);
    // Rebind element refs
    el.fPart = qs('#fPart');
    el.fBrand = qs('#fBrand');
    el.fRankMin = qs('#fRankMin');
    el.fRankMax = qs('#fRankMax');
    el.fOurMin = qs('#fOurMin');
    el.fOurMax = qs('#fOurMax');
    el.tCheaper = qs('#tCheaper');
    el.tMissing = qs('#tMissing');
    el.pageSize = qs('#pageSize');
    el.prevPage = qs('#prevPage');
    el.nextPage = qs('#nextPage');
    el.pageInfo = qs('#pageInfo');
    scaffoldCreated = true;
  }
  if (scaffoldCreated) {
    console.info('[dbv] Scaffold auto-built because expected elements were missing.');
  }
}

function boot() {
  ensureScaffold();
  restoreUiState();
  setUIFromState();
  initEvents();
  refresh();
}

// Start!
window.addEventListener('DOMContentLoaded', boot);
