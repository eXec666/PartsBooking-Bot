// dbViewerRenderer.js — adapted for all-text DB fields
// Assumptions remain as in the previous version. Key change: all backend fields are strings.
// We defensively coerce text to numbers/strings before filtering, sorting, and math.

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
const debounce = (fn, ms = 300) => { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; };

const toText = (v) => (v == null ? '' : String(v).trim());
const hasDigit = (s) => /\d/.test(s || '');
const hasAlpha = (s) => /[A-Za-z]/.test(s || '');

// Robust numeric parser from arbitrary text ("€ 1 234,56", "1,234.56", "(123)")
function parseNumberLike(v) {
  const s0 = toText(v);
  if (!hasDigit(s0)) return null;
  // remove spaces, keep digits, dots, commas, minus, parentheses
  let s = s0.replace(/\s+/g, '');
  const negByParens = /^\(.*\)$/.test(s);
  if (negByParens) s = s.slice(1, -1);
  s = s.replace(/[^0-9.,\-]/g, '');
  // If both comma and dot present -> assume comma is thousands, dot is decimal
  if (s.includes('.') && s.includes(',')) s = s.replace(/,/g, '');
  // If only comma present -> treat comma as decimal
  else if (s.includes(',') && !s.includes('.')) s = s.replace(/,/g, '.');
  // If multiple dots remain, keep last as decimal, remove the rest (thousands)
  if ((s.match(/\./g) || []).length > 1) {
    const last = s.lastIndexOf('.');
    s = s.slice(0, last).replace(/\./g, '') + s.slice(last);
  }
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return negByParens ? -n : n;
}

const parseDateLike = (v) => {
  const s = toText(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const textOrEmpty = (v) => {
  const s = toText(v);
  return (hasAlpha(s) || hasDigit(s)) ? s : '';
};

const parseNum = (v) => { if (v === '' || v == null) return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; };

const fmtNum = (v, dp = 2) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(dp));

const fmtDate = (iso) => { if (!iso) return '—'; const d = new Date(iso); if (Number.isNaN(d.getTime())) return '—'; return d.toLocaleString(); };

const computeDelta = (ourPrice, leaderPrice) => {
  const a = Number(ourPrice);
  const b = Number(leaderPrice);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { abs: null, pct: null, sign: 'neu' };
  const abs = a - b; // positive => more expensive than leader
  const pct = b === 0 ? null : abs / b;
  const sign = abs < 0 ? 'pos' : abs > 0 ? 'neg' : 'neu'; // pos => cheaper than leader
  return { abs, pct, sign };
};

const arrowFor = (by) => state.sort.by === by ? (state.sort.dir === 'asc' ? '▲' : '▼') : '▲';

const saveUiState = () => { try { localStorage.setItem('dbv.ui', JSON.stringify({ filters: state.filters, sort: state.sort, page: state.page })); } catch {} };
const restoreUiState = () => { try { const raw = localStorage.getItem('dbv.ui'); if (!raw) return; const s = JSON.parse(raw); Object.assign(state.filters, s.filters || {}); Object.assign(state.sort, s.sort || {}); Object.assign(state.page, s.page || {}); } catch {} };

// ---------- Row normalization (all sources) ----------
function normalizeRow(r) {
  // Accept both old canonical keys and raw backend keys, all text-typed
  const part = textOrEmpty(r.part ?? r.part_number ?? r.Part ?? r.PART);
  const brand = textOrEmpty(r.brand ?? r.brand_name ?? r.Brand ?? r.BRAND);
  const rank = parseNumberLike(r.rank ?? r.rank_pos ?? r.Rank ?? r.RANK);
  const ourPrice = parseNumberLike(r.ourPrice ?? r.our_price ?? r.Our ?? r.OUR);
  const leaderPrice = parseNumberLike(r.leaderPrice ?? r.leader_price ?? r.Leader ?? r.LEADER);
  const leaderName = textOrEmpty(r.leaderName ?? r.leader_code ?? r.LeaderName);
  const overPrice = parseNumberLike(r.overPrice ?? r.over_price);
  const overCode = textOrEmpty(r.overCode ?? r.over_code);
  const underPrice = parseNumberLike(r.underPrice ?? r.under_price);
  const underCode = textOrEmpty(r.underCode ?? r.under_code);
  const updatedAt = parseDateLike(r.updatedAt ?? r.updated_at ?? r.last_update);

  return {
    id: toText(r.id ?? `${brand || ''}:${part || ''}`) || cryptoRandomId(),
    part,
    brand,
    rank: Number.isFinite(rank) ? rank : null,
    ourPrice: Number.isFinite(ourPrice) ? ourPrice : null,
    leaderPrice: Number.isFinite(leaderPrice) ? leaderPrice : null,
    leaderName: leaderName || null,
    overCode: overCode || null,
    overPrice: Number.isFinite(overPrice) ? overPrice : null,
    underCode: underCode || null,
    underPrice: Number.isFinite(underPrice) ? underPrice : null,
    updatedAt: updatedAt,
  };
}

function cryptoRandomId() {
  try {
    const a = new Uint32Array(4);
    crypto.getRandomValues(a);
    return Array.from(a, x => x.toString(16).padStart(8, '0')).join('');
  } catch { // Fallback
    return 'id_' + Math.random().toString(36).slice(2);
  }
}

// ---------- Backend adapter ----------
async function queryBackend(payload) {
  // Prefer Electron exposed API that returns the whole table; transform locally
  if (window.electronAPI?.getTableData) {
    try {
      const raw = await window.electronAPI.getTableData();
      const rowsSource = Array.isArray(raw?.data?.prices)
        ? raw.data.prices
        : (Array.isArray(raw?.prices) ? raw.prices : (Array.isArray(raw) ? raw : []));

      const data = rowsSource.map(normalizeRow);
      return filterSortPaginate(data, payload);
    } catch (e) {
      console.warn('electronAPI.getTableData failed, will try IPC/HTTP fallbacks', e);
    }
  }

  // IPC adapters (server-side filtering unknown; normalize defensively)
  try {
    if (window.db?.queryPrices) {
      const res = await window.db.queryPrices(payload);
      return postNormalize(res, payload);
    }
    if (window.api?.queryPrices) {
      const res = await window.api.queryPrices(payload);
      return postNormalize(res, payload);
    }
    if (window.electronAPI?.queryPrices) {
      const res = await window.electronAPI.queryPrices(payload);
      return postNormalize(res, payload);
    }
  } catch (e) {
    console.warn('IPC queryPrices failed, will try HTTP fallback', e);
  }

  // HTTP fallback (server expected to filter/sort/paginate); still normalize in case server returns text
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
  const json = await res.json();
  return postNormalize(json, payload);
}

function postNormalize(res, payload) {
  const rows = Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : [];
  const data = rows.map(normalizeRow);
  // If server already paginated, keep its total if finite; else compute locally
  const total = Number.isFinite(res?.total) ? res.total : data.length;
  if (Array.isArray(res?.items)) return { items: data, total };
  // If not paginated, filter/sort/paginate locally
  return filterSortPaginate(data, payload);
}

function filterSortPaginate(data, payload) {
  const { filters, sort, page } = payload;

  const match = (r) => {
    const part = toText(r.part).toLowerCase();
    const brand = toText(r.brand).toLowerCase();
    const our = Number(r.ourPrice);
    const leader = Number(r.leaderPrice);
    if (filters.part && !part.includes(toText(filters.part).toLowerCase())) return false;
    if (filters.brand && !brand.includes(toText(filters.brand).toLowerCase())) return false;
    if (filters.rankMin != null && !(Number.isFinite(r.rank) && r.rank >= filters.rankMin)) return false;
    if (filters.rankMax != null && !(Number.isFinite(r.rank) && r.rank <= filters.rankMax)) return false;
    if (filters.ourMin != null && !(Number.isFinite(our) && our >= filters.ourMin)) return false;
    if (filters.ourMax != null && !(Number.isFinite(our) && our <= filters.ourMax)) return false;
    if (filters.cheaper && !(Number.isFinite(our) && Number.isFinite(leader) && our < leader)) return false;
    if (filters.missing && Number.isFinite(leader)) return false;
    return true;
  };

  const getSortVal = (r, by) => {
    switch (by) {
      case 'delta': {
        const d = computeDelta(r.ourPrice, r.leaderPrice);
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
    if (typeof va === 'string' || typeof vb === 'string')
      return sort.dir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    return sort.dir === 'asc' ? (va - vb) : (vb - va);
  });

  const total = filtered.length;
  const start = page.index * page.size;
  const items = filtered.slice(start, start + page.size);
  return { items, total };
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
        <td><code>${toText(r.part)}</code></td>
        <td>${toText(r.brand)}</td>
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
  if (state.lastError) { el.error.textContent = state.lastError; el.error.style.display = ''; }
  else { el.error.style.display = 'none'; }
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  saveUiState();
  setError(null);
  el.viewer.innerHTML = '<div class="empty">Loading…</div>';

  try {
    const payload = { filters: { ...state.filters }, sort: { ...state.sort }, page: { ...state.page } };
    const res = await queryBackend(payload);
    const items = Array.isArray(res?.items) ? res.items.map(normalizeRow) : [];
    state.total = Number.isFinite(res?.total) ? res.total : items.length;
    state.data = items;

    el.viewer.innerHTML = renderTable(items);

    qsa('th.sortable', el.viewer).forEach(th => {
      th.addEventListener('click', () => {
        const key = th.getAttribute('data-key');
        if (!key) return;
        if (state.sort.by === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
        else { state.sort.by = key; state.sort.dir = key === 'part' || key === 'brand' ? 'asc' : 'desc'; }
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
  const onChange = debounce(() => { applyFiltersFromUI(); state.page.index = 0; refresh(); }, 300);

  [el.fPart, el.fBrand, el.fRankMin, el.fRankMax, el.fOurMin, el.fOurMax].forEach(input => {
    input.addEventListener('input', onChange);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') onChange(); });
  });

  [el.tCheaper, el.tMissing].forEach(cb => cb.addEventListener('change', onChange));

  el.pageSize.addEventListener('change', () => { const v = parseInt(el.pageSize.value, 10); state.page.size = Number.isFinite(v) ? v : state.page.size; state.page.index = 0; refresh(); });

  el.prevPage.addEventListener('click', () => { if (state.page.index > 0) { state.page.index -= 1; refresh(); } });
  el.nextPage.addEventListener('click', () => { const totalPages = Math.max(1, Math.ceil(state.total / state.page.size)); if (state.page.index + 1 < totalPages) { state.page.index += 1; refresh(); } });
}

function ensureScaffold() {
  let scaffoldCreated = false;
  if (!el.error) { const banner = document.createElement('div'); banner.id = 'errorBanner'; banner.style.display = 'none'; banner.className = 'error-banner'; document.body.prepend(banner); el.error = banner; scaffoldCreated = true; }
  if (!el.viewer) { const container = document.createElement('div'); container.id = 'dbViewer'; document.body.appendChild(container); el.viewer = container; scaffoldCreated = true; }
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
  if (scaffoldCreated) console.info('[dbv] Scaffold auto-built because expected elements were missing.');
}

function boot() { ensureScaffold(); restoreUiState(); setUIFromState(); initEvents(); refresh(); }

window.addEventListener('DOMContentLoaded', boot);
