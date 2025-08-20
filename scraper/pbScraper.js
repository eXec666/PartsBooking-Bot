// scraper/pbScraper.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer-core');
const ExcelJS = require('exceljs');
const { app } = require('electron');
const SUPPORTED_BRANDS = new Set(['JOHN DEERE', 'CLAAS', 'MANITOU']);
const initDb = require('../db/init_db');
const dbManager = require('../db/db_Manager');
const { rankPrice } = dbManager;
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const proxyAgent = new HttpsProxyAgent('http://wlmdopbt-rotate:7rtmo8tgu1t2@p.webshare.io:80');

// Verbosity control for noisy per-part logs
const VERBOSE_LOGS = process.env.VERBOSE === '1';
const LOG_EVERY = 10; // show 1 of every 10 captures in UI unless VERBOSE=1
let __captureCounter = 0;

//puppeteer.use(StealthPlugin());

const CONFIG = {
  inputFile: null,                      // resolved at runtime to app.getPath('userData')
  ourSiteCode: 1269,
  maxPartsToProcess: 0,                 // 0 = no cap
  maxConcurrentInstances: Math.max(1, Math.floor(os.cpus().length * 0.25)),
  requestThrottleMs: { min: 1500, max: 3000 },
  navigation: {
    timeout: 60000,
    waitUntil: 'domcontentloaded'
  },
  apiWaitMs: 60000,
  imagesDir: null,                      // resolved at runtime to app.getPath('userData')/images
  imageDownloadTimeoutMs: 10000
};

const sleep = ms => new Promise(res => setTimeout(res, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleepRandom = ({ min, max }) => sleep(randInt(min, max));


function resolveSystemChrome() {
  // Highest priority: explicit env overrides
  const envPaths = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH
  ].filter(Boolean);

  for (const p of envPaths) {
    if (fs.existsSync(p)) return p;
  }

  // Default Windows locations
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ];

  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }

  throw new Error([
    'System Chrome not found.',
    'Install Google Chrome or set CHROME_PATH to its chrome.exe.',
    'Tried:',
    ...candidates
  ].join(' '));
}




let sharedTaskQueue = [];
let retryQueue = [];
let deadLetter = [];
const MAX_ATTEMPTS = 5;

// --- Central aggregator for results from all workers ---

// Incoming queue of { slag, partNumber, brandName }
const resultQueue = [];
let aggregatorRunning = false;
let aggregatorStop = false;

// Tunables for pooled DB writes
const BATCH_SIZE = 100;
const IDLE_FLUSH_MS = 1000;

function enqueueSlag(item) {
  // item: { slag, partNumber, brandName }
  if (!item || !Array.isArray(item.slag)) return;
  resultQueue.push(item);
}

function rankPriceAsync(slag, ourCode, partNumber, brandName) {
  // Make it async to decouple from worker loop microtasks
  return Promise.resolve().then(() => rankPrice(slag, ourCode, partNumber, brandName));
}

/**
 * Start central aggregator; returns a promise that resolves on graceful stop.
 */
function startAggregator() {
  if (aggregatorRunning) return Promise.resolve();
  aggregatorRunning = true;

  return new Promise((resolve) => {
    let batch = [];
    let idleTimer = null;

    const flush = () => {
      if (!batch.length) return;
      try {
        dbManager.dumpToDb('prices', batch);
      } catch (e) {
        console.warn('[aggregator] dumpToDb failed:', e && e.message);
      } finally {
        batch = [];
      }
    };

    const scheduleIdleFlush = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        flush();
        if (aggregatorStop && resultQueue.length === 0) {
          clearTimeout(idleTimer);
          aggregatorRunning = false;
          resolve();
        } else {
          scheduleIdleFlush();
        }
      }, IDLE_FLUSH_MS);
    };

    scheduleIdleFlush();

    (async function pump() {
      while (!aggregatorStop || resultQueue.length > 0) {
        const next = resultQueue.shift();
        if (!next) {
          // brief rest (cooperative) if no work
          await sleep(25);
          continue;
        }

        try {
          const ranked = await rankPriceAsync(next.slag, CONFIG.ourSiteCode, next.partNumber, next.brandName);
          batch.push(ranked);
          if (batch.length >= BATCH_SIZE) {
            flush();
          }
        } catch (e) {
          console.warn('[aggregator] rankPriceAsync failed:', e && e.message);
        }
      }

      // Final flush on exit
      flush();
      clearTimeout(idleTimer);
      aggregatorRunning = false;
      resolve();
    })();
  });
}


function getNextTask() { return sharedTaskQueue.shift() || retryQueue.shift() || null; }

const STATE_FILE = () => path.join(app.getPath('userData'), 'scraper-state.json');

function persistState() {
  try {
    fs.writeFileSync(
      STATE_FILE(),
      JSON.stringify({ queue: sharedTaskQueue, retry: retryQueue, dead: deadLetter }),
      'utf8'
    );
  } catch {}
}

function loadStateIfAny() {
  try {
    const p = STATE_FILE();
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      sharedTaskQueue = Array.isArray(j.queue) ? j.queue : [];
      retryQueue      = Array.isArray(j.retry) ? j.retry : [];
      deadLetter      = Array.isArray(j.dead)  ? j.dead  : [];
    }
  } catch {}
}


function resolveBrandCode(raw) {
  const b = String(raw || '').trim().toUpperCase();
  if (!b) return null;
  if (b.includes('JOHN') && b.includes('DEERE')) return 'JOHN%20DEERE'; // explicit for safety
  if (b === 'CLAAS') return 'CLAAS';
  if (b === 'MANITOU') return 'MANITOU';
  return null; // not supported
}

const isType1 = (x) => {
  const v = x?.art_type_id;
  if (v == null) return false;
  const n = typeof v === 'string' ? Number(v.trim()) : Number(v);
  return n === 1;
};

const allowBySearchComment = (x) => {
  const s = x?.sys_info?.search_comment;
  if (s == null) return true;                 // missing comment ⇒ allow
  return !String(s).toLowerCase().includes('альметьевск');
};

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function isRetryable(errLike) {
  const s = String(errLike && errLike.message || errLike || '').toLowerCase();
  return (
    /net::err_(aborted|connection|internet|network|timed_out)/.test(s) ||
    /(econnreset|etimedout|enotfound|eai_again|socket hang up)/.test(s) ||
    /no price_items/.test(s) || /no[-\s]?response/.test(s) ||
    /bad nav status/.test(s) || /5\d\d/.test(s) || /429/.test(s)
  );
}

function downloadImage(imageUrl, filePath, referer) {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(filePath));
    const file = fs.createWriteStream(filePath);
    let settled = false;
    let received = 0;

    const cleanup = (err) => {
      if (settled) return;
      settled = true;
      try { file.close(() => {}); } catch {}
      if (err) {
        fs.unlink(filePath, () => {});
        reject(err);
      } else {
        resolve({ filePath, bytes: received });
      }
    };

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      cleanup(new Error(`Image download timeout after ${CONFIG.imageDownloadTimeoutMs}ms`));
    }, CONFIG.imageDownloadTimeoutMs);

    const doGet = (urlToGet) => {
      const req = https.get(urlToGet, {
        agent: proxyAgent,
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer': referer || 'https://partsbooking.ru/',
          'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        },
      }, (res) => {
        // handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, urlToGet).href;
          res.resume();
          return doGet(nextUrl);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return cleanup(new Error(`HTTP ${res.statusCode} for ${urlToGet}`));
        }

        res.on('data', (chunk) => { received += chunk.length; });
        res.on('error', (err) => cleanup(err));
        res.pipe(file);
        file.on('finish', () => {
          clearTimeout(timer);
          cleanup(null);
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error('request timeout'));
      });
      req.setTimeout(CONFIG.imageDownloadTimeoutMs);

      req.on('error', (err) => {
        clearTimeout(timer);
        cleanup(err);
      });
    };

    doGet(imageUrl);
  });
}

async function navigateWithRetries(page, url, navOpts, attempts = 3) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const resp = await page.goto(url, { ...navOpts });
      const status = resp ? resp.status() : 0;
      // Retry on 429 or 5xx, or when no response object is returned
      if (!resp || status === 429 || status >= 500) {
        throw new Error(`Bad nav status: ${status || 'no-response'}`);
      }
      const final = new URL(page.url());
      const expected = new URL(url);
      if (final.origin !== expected.origin) {
        throw new Error(`unexpected cross-origin redirect: ${final.href}`);
      }
      return resp;
    } catch (e) {
      lastErr = e;
      const backoff = randInt(800 * i, 1200 * i); // jittered backoff
      console.warn(`[nav] attempt ${i} failed: ${e.message}. Backoff ${backoff}ms`);
      await sleep(backoff);
      // light fingerprint shuffle per attempt
      try {
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8' });
      } catch {}
    }
  }
  throw lastErr || new Error('navigateWithRetries failed');
}

class ParallelScraper {
  constructor(instanceId,browser) {
    this.instanceId = instanceId;
    this.results = [];
    this.buffer = [];
    this.browser = browser;
    this.page = null;
  }

  async initialize() {
    try {
      if (!this.browser) {
        throw new Error('Shared browser not available in ParallelScraper.initialize()');
      }

      this.page = await this.browser.newPage();


      await this.page.authenticate({
        username: 'wlmdopbt-rotate',
        password: '7rtmo8tgu1t2'
      });
      await this.page.setCacheEnabled(false);
      await this.page.evaluateOnNewDocument(() => {
        try {
          if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister())).catch(()=>{});
          }
          if (typeof caches !== 'undefined' && caches.keys) {
            caches.keys().then(keys => keys.forEach(k => caches.delete(k))).catch(()=>{});
          }
        } catch {}
      });

      await this.page.setViewport({ width: 1280, height: 800 });
      const realUA = await this.browser.userAgent();
      await this.page.setUserAgent(realUA);

      await this.page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8' });

      // global request interceptor (kept for the lifetime of the page)
      this._intercept = (req) => {
        const type = req.resourceType();
        const url = req.url();

        if (type === 'stylesheet') {
          return req.respond({ status: 200, contentType: 'text/css', body: '/* stripped */' });
        }
        if (type === 'font' || type === 'image' || type === 'media') return req.abort();
        if (type === 'script' && /analytics|gtag|google-analytics|yandex|metrika|hotjar|tracker/i.test(url)) return req.abort();

        return req.continue();
      };

      await this.page.setRequestInterception(true);
      this.page.on('request', this._intercept);

    } catch (e) {
      console.error(`[worker ${this.instanceId}] puppeteer launch failed: ${e.message}`);
      console.error(e && e.stack);
      throw e;
    }
  }

  buildProductUrl(brandName, partNumber) {
    const brandCode = resolveBrandCode(brandName);
    if (!brandCode) return null; // caller will handle skipping
    const part = encodeURIComponent(String(partNumber).trim());
    return `https://partsbooking.ru/products/${brandCode}/${part}.html`;
  }

  async processTask(task) {
    const { brandName, partNumber } = task;
    try {
      const brandCode = resolveBrandCode(brandName);
      if (!brandCode) {
        console.warn(`[worker ${this.instanceId}] Skipping unsupported brand "${brandName}" for part ${partNumber}`);
        return { ok: false, error: 'Unsupported brand', partNumber, brandName };
      }

      // Skip if this (part_number, brand_name) already exists in DB
      try {
        if (dbManager.existsPart(partNumber, brandName)) {
          console.log(`[worker ${this.instanceId}] SKIP existing ${brandName} ${partNumber}`);
          return { ok: true, skipped: true, partNumber, brandName };
        }
      } catch (e) {
        console.warn(`[worker ${this.instanceId}] existsPart check failed: ${e.message}`);
      }

      const productUrl = this.buildProductUrl(brandName, partNumber);
      console.log(`[worker ${this.instanceId}] Navigating to: ${productUrl}`);

      let priceItems = null;
      let bytesIn = 0;

          let sawPriceRequest = false;
    let priceReqFailures = [];
    const isPriceSearch = (u) => u.includes('/price_search/');

    // only-once gating
    let loggedPriceSearchStart = false;
    let loggedPriceSearchFinish = false;
    let firstPriceSearchUrl = null;

    // task-scoped listeners — define once per task
    const onReq = (r) => {
      const u = r.url();
      const method = (typeof r.method === 'function') ? r.method() : '';
      if (isPriceSearch(u) && method !== 'OPTIONS' && !loggedPriceSearchStart) {
        sawPriceRequest = true;
        loggedPriceSearchStart = true;
        firstPriceSearchUrl = u;
        console.log(`[worker ${this.instanceId}] price_search request: ${method} ${u}`);
      }
    };

    const onReqFinished = (r) => {
      const u = r.url();
      const method = (typeof r.method === 'function') ? r.method() : '';
      if (isPriceSearch(u) && method !== 'OPTIONS'
          && !loggedPriceSearchFinish
          && (!firstPriceSearchUrl || u === firstPriceSearchUrl)) {
        loggedPriceSearchFinish = true;
        console.log(`[worker ${this.instanceId}] price_search finished: ${r.resourceType()} ${u}`);
      }
    };

    const onReqFailed = (r) => {
      const u = r.url();
      if (isPriceSearch(u)) {
        const failure = r.failure() ? r.failure().errorText : null;
        priceReqFailures.push(failure || 'unknown');
        console.warn(`[worker ${this.instanceId}] price_search failed: ${failure} ${u}`);
      }
    };


      const onResp = async (response) => {
        const url = response.url();
        if (!url.includes('/price_search/search')) return;

        // identify preflights / non-JSON / non-2xx
        let method = '';
        try {
          const req = typeof response.request === 'function' ? response.request() : null;
          method = req && typeof req.method === 'function' ? req.method() : '';
        } catch {}

        let status = 0;
        try { status = typeof response.status === 'function' ? response.status() : 0; } catch {}

        let headers = {};
        try { headers = typeof response.headers === 'function' ? response.headers() : {}; } catch {}

        const ct = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();

        if (method === 'OPTIONS' || status < 200 || status >= 300 || !ct.includes('application/json')) {
          // ignore preflights, errors, and non-JSON bodies
          return;
        }

        // count incoming bytes when Content-Length is present
        try {
          const len = parseInt(headers['content-length'] || headers['Content-Length'] || '0', 10);
          if (!Number.isNaN(len) && len > 0) bytesIn += len;
        } catch {}

        try {
          const json = await response.json();
          if (json && json.price_items) {
            priceItems = json.price_items;
            // backfill size if no Content-Length
            try {
              if (!(headers['content-length'] || headers['Content-Length'])) {
                const approx = Buffer.byteLength(JSON.stringify(json), 'utf8');
                if (approx > 0) bytesIn += approx;
              }
            } catch {}
            __captureCounter++;
            if (VERBOSE_LOGS || (__captureCounter % LOG_EVERY === 0)) {
              console.log(`[worker ${this.instanceId}] Captured ${priceItems.length} price items for ${partNumber}`);
            }
          }
        } catch (err) {
          // downgrade noise from “no body” cases
          console.warn(`[worker ${this.instanceId}] Skipped non-body /price_search response: ${err.message}`);
        }
      };

      if (this.page) {
        this.page.on('request', onReq);
        this.page.on('requestfinished', onReqFinished);
        this.page.on('requestfailed', onReqFailed);
        this.page.on('response', onResp);
      }

      await navigateWithRetries(this.page, productUrl, CONFIG.navigation, 3);
      const apiResp = await this.page
      .waitForResponse(r => {
        try {
          if (!r.url().includes('/price_search/search')) return false;
          const req = typeof r.request === 'function' ? r.request() : null;
          const method = req && typeof req.method === 'function' ? req.method() : '';
          if (method === 'OPTIONS') return false;
          const status = typeof r.status === 'function' ? r.status() : 0;
          if (status < 200 || status >= 300) return false;
          const h = typeof r.headers === 'function' ? r.headers() : {};
          const ct = String(h['content-type'] || h['Content-Type'] || '').toLowerCase();
          return ct.includes('application/json');
        } catch { return false; }
      }, { timeout: CONFIG.apiWaitMs })
      .catch(() => null);
      // safety: if the response listener hasn’t set priceItems yet, parse here too
      if (apiResp && !priceItems) {
        try {
          const json = await apiResp.json();
          if (json && json.price_items) priceItems = json.price_items;
        } catch {}
      }

      if (!priceItems) {
        console.warn(
          `[worker ${this.instanceId}] No price_items found for ${partNumber} after initial wait of ${CONFIG.apiWaitMs}ms. Retrying...`
        );

        // brief pause before retry
        await sleep(randInt(400, 900));

        const apiResp2 = await this.page
        .waitForResponse(r => {
          try {
            if (!r.url().includes('/price_search/search')) return false;
            const req = typeof r.request === 'function' ? r.request() : null;
            const method = req && typeof req.method === 'function' ? req.method() : '';
            if (method === 'OPTIONS') return false;
            const status = typeof r.status === 'function' ? r.status() : 0;
            if (status < 200 || status >= 300) return false;
            const h = typeof r.headers === 'function' ? r.headers() : {};
            const ct = String(h['content-type'] || h['Content-Type'] || '').toLowerCase();
            return ct.includes('application/json');
          } catch { return false; }
        }, { timeout: Math.floor(CONFIG.apiWaitMs / 2) })
        .catch(() => null);


        if (apiResp2 && !priceItems) {
          try {
            const j = await apiResp2.json();
            if (j && j.price_items) {
              priceItems = j.price_items;
              console.log(
                `[worker ${this.instanceId}] Captured ${priceItems.length} price items for ${partNumber} on second attempt`
              );
            }
          } catch {
            // ignore JSON parse errors
          }
        }

        // still nothing after retry
        if (!priceItems) {
          console.warn(
            `[worker ${this.instanceId}] No price_items found for ${partNumber} after total wait of ${CONFIG.apiWaitMs + Math.floor(CONFIG.apiWaitMs / 2)}ms`
          );
          console.log(
            `[worker ${this.instanceId}] [${partNumber}] total bandwidth used: ${bytesIn} bytes`
          );
          return { ok: false, error: 'No price_items', partNumber };
        }
      }

      const imgRel = (priceItems || []).find(x => x?.sys_info?.goods_img_url)?.sys_info?.goods_img_url;
      if (imgRel) {
        try {
          const imgUrl = new URL(imgRel, 'https://partsbooking.ru').href;
          const brandSafe = String(brandName || '').trim().replace(/[^\w\-]+/g, '_');
          const partSafe = String(partNumber || '').trim().replace(/[^\w\-]+/g, '_');
          const ext = path.extname(imgUrl) || '.jpg';
          const outDir = path.join(CONFIG.imagesDir, brandSafe);
          const outFile = path.join(outDir, `${partSafe}${ext}`);
          await downloadImage(imgUrl, outFile, productUrl);
          console.log(`[worker ${this.instanceId}] Image saved: ${outFile}`);
        } catch (e) {
          console.warn(`[worker ${this.instanceId}] Image download failed for ${partNumber}: ${e.message}`);
        }
      } else {
        console.log(`[worker ${this.instanceId}] No image URL for ${partNumber}`);
      }


      const logPriceArray = [];
      const slag = priceItems
        .filter(isType1)
        .filter(allowBySearchComment)
        .map(x => {
          const pid = x?.price_id ?? x?.id ?? null;
          const c = x?.cost ?? x?.price ?? null;
          if (pid != null && c != null) {
            logPriceArray.push(`price_id = ${pid}, cost = ${c}`);
          }
          return [pid, c];
        })
        .filter(p => p[0] != null && p[1] != null);

      console.log(`[worker ${this.instanceId}] Total picked for ${partNumber}: ${slag.length}`);
      var i = null;
      for(i = 0; i < logPriceArray.length; i++)  {
        console.log(`${i}: ${logPriceArray[i]}`)
      }
     enqueueSlag({ slag, partNumber, brandName });

      console.log(`[worker ${this.instanceId}] [${partNumber}] total bandwidth used: ${bytesIn} bytes`);
      return { ok: true, count: slag.length, partNumber };

    } catch (err) {
      console.error(`[worker ${this.instanceId}] task ${partNumber} failed: ${err.message}`);
      return { ok: false, error: err.message, partNumber };
    } finally {
      try { this.page.off('request', onReq); } catch {}
      try { this.page.off('requestfinished', onReqFinished); } catch {}
      try { this.page.off('requestfailed', onReqFailed); } catch {}
      try { this.page.off('response', onResp); } catch {}
    }
  }

  async workerLoop(progressCallback) {
  while (true) {
    const task = getNextTask();
    if (!task) break;

    const res = await this.processTask(task);

    if (!res || res.ok !== true) {
      const attempts = (task.attempts || 0) + 1;
      const retryable = isRetryable(res && res.error);
      if (retryable && attempts < MAX_ATTEMPTS) {
        retryQueue.push({ ...task, attempts });
      } else {
        deadLetter.push({ ...(task || {}), error: (res && res.error) || 'unknown' });
      }
    }

    persistState();
    progressCallback();
    await sleepRandom(CONFIG.requestThrottleMs);
  }
}


  async close() {
    try { if (this.page && !this.page.isClosed()) await this.page.close(); } catch {}
    
  }
}

let isScraping = false;
const api = {
  runWithProgress: async function (progressCallback = () => {}, onForceRefresh = () => {}, inputFilePath = null) {
    if (isScraping) return { message: 'Scraping is already in progress.' };
    isScraping = true;

    try {
      if (!app.isReady()) await app.whenReady();
      const dir = path.join(app.getPath('userData'), 'images');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      CONFIG.imagesDir = dir;

      const ok = await initDb();
      if (!ok) throw new Error('DB init failed');

      if (ok) {console.log(ok.path, "DB Path")}

      // Writable defaults under userData
      CONFIG.imagesDir = path.join(app.getPath('userData'), 'images');
      CONFIG.inputFile = inputFilePath
        ? inputFilePath
        : path.join(app.getPath('userData'), 'prices_input.xlsx');
      ensureDir(CONFIG.imagesDir);

      // Resume state if present
      loadStateIfAny();

      const inputFile = CONFIG.inputFile;
      if (!fs.existsSync(inputFile)) throw new Error(`Input file not found: ${inputFile}`);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(inputFile);
      const ws = workbook.getWorksheet(1);
      if (!ws) throw new Error('Worksheet 1 is missing');

      // --- Robust header/column detection and task build ---
      function cellText(v) {
        if (v == null) return '';
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (v && typeof v === 'object') {
          if (Array.isArray(v.richText)) return v.richText.map(rt => rt.text || '').join('');
          if (v.text) return String(v.text);
          if (v.hyperlink && v.text) return String(v.text);
          if (v.result != null) return cellText(v.result);
          if (v.sharedFormula && v.result != null) return cellText(v.result);
        }
        return String(v);
      }
      function norm(s) { return String(s || '').trim().toLowerCase(); }

      const PART_HEADERS = new Set(['артикул', 'арт', 'part', 'part number', 'номер детали', 'код товара', 'pn', 'sku', 'код']);
      const BRAND_HEADERS = new Set(['бренд', 'брэнд', 'brand', 'марка', 'производитель', 'oem']);

      let headerRowIdx = 1;
      let colPart = 1;
      let colBrand = 2;

      const scanRows = Math.min(10, ws.rowCount || 10);
      outer:
      for (let r = 1; r <= scanRows; r++) {
        const row = ws.getRow(r);
        let p = 0, b = 0;
        for (let c = 1; c <= row.cellCount; c++) {
          const val = norm(cellText(row.getCell(c).value));
          if (!val) continue;
          if (PART_HEADERS.has(val)) { colPart = c; p = c; }
          if (BRAND_HEADERS.has(val)) { colBrand = c; b = c; }
        }
        if (p && b) { headerRowIdx = r; break outer; }
      }
      console.log(`[pbScraper] Header row=${headerRowIdx} colPart=${colPart} colBrand=${colBrand}`);

      const tasks = [];
      ws.eachRow((row, rowNumber) => {
        if (rowNumber <= headerRowIdx) return;
        const partCell = cellText(row.getCell(colPart).value);
        const brandCell = cellText(row.getCell(colBrand).value);
        const partNumber = String(partCell).trim();
        const brandName = String(brandCell).trim();
        if (!partNumber || !brandName) return;
        tasks.push({ brandName, partNumber });
      });
      console.log(`[pbScraper] Parsed tasks: ${tasks.length}`);

      // Prefilter by DB existence, then optionally cap. 0 = no cap.
      let skippedExisting = 0;
      let filtered = tasks;
      try {
        filtered = tasks.filter(t => {
          const exists = dbManager.existsPart(t.partNumber, t.brandName);
          if (exists) skippedExisting++;
          return !exists;
        });
      } catch (e) {
        console.warn(`[pbScraper] existsPart prefilter disabled: ${e.message}`);
        filtered = tasks; // fail-open
      }

      const finalTasks =
        (CONFIG.maxPartsToProcess && CONFIG.maxPartsToProcess > 0)
          ? filtered.slice(0, CONFIG.maxPartsToProcess)
          : filtered;

      console.log(`[pbScraper] Existing rows skipped: ${skippedExisting} / ${tasks.length}`);
      sharedTaskQueue = sharedTaskQueue.length
  ? [...sharedTaskQueue, ...retryQueue.splice(0), ...finalTasks]
  : [...finalTasks];
persistState();

if (finalTasks.length === 0 && sharedTaskQueue.length === 0) return [];
      // Start central aggregator (pooled writer)
      // One shared Chrome instance
      const execPath = resolveSystemChrome();
      console.log('[scraper] Using system Chrome:', execPath);

      const sharedUserDataDir = path.join(app.getPath('userData'), 'puppeteer_shared');
      const browser = await puppeteer.launch({
        executablePath: execPath,
        headless: false,
        userDataDir: sharedUserDataDir,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-zygote',
          '--disable-extensions',
          '--proxy-server=http://p.webshare.io:80'
        ],
        ignoreHTTPSErrors: true
      });

      aggregatorStop = false;
      const aggregatorPromise = startAggregator()
      browser.on('disconnected', () => {
        console.warn(`[shared-browser] disconnected; subsequent runs will resume from state file if any`);
      });

      const workerCount = CONFIG.maxConcurrentInstances;
      const workers = [];
      for (let i = 0; i < workerCount; i++) {
        const w = new ParallelScraper(i + 1, browser);
        await w.initialize(browser); // opens a new Page (tab)
        workers.push(w);
      }

      
      // Guard: nothing to do
      const totalCount = finalTasks.length;
      if (totalCount === 0) {
        progressCallback(100, 'No tasks to process | Elapsed 00:00:00 | ETA 00:00:00');
        return [];
      }

      let processed = 0;
      const startTime = Date.now();

      const formatHMS = (ms) => {
        const t = Math.max(0, Math.floor(ms / 1000));
        const h = Math.floor(t / 3600);
        const m = Math.floor((t % 3600) / 60);
        const s = t % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      };

      const tick = () => {
        processed += 1;
        const elapsed = Date.now() - startTime;
        const percent = Math.round((processed / totalCount) * 100);
        const remaining = Math.max(0, totalCount - processed);
        const etaMs = processed ? Math.round((elapsed / processed) * remaining) : 0;
        progressCallback( percent,
          `Processed ${processed} / ${totalCount}
          Elapsed ${formatHMS(elapsed)}
          ETA ${processed ? formatHMS(etaMs) : 'unknown'}`
        );
      };

      await Promise.all(workers.map(w => w.workerLoop(tick)));

       const totalElapsed = Date.now() - startTime;
      progressCallback(100, 
        `Processed ${processed} / ${totalCount} 
        Elapsed ${formatHMS(totalElapsed)}
        ETA 00:00:00`);

      // Stop aggregator and wait for the final drain
      aggregatorStop = true;
      await aggregatorPromise;

      // Close pages (tabs) then the shared browser
      await Promise.all(workers.map(w => w.close()));
      try { await browser.close(); } catch {}

      onForceRefresh();

      // Return combined results (already written via aggregator)
      const aggregated = workers.flatMap(w => w.results);
      return aggregated;

      // Aggregator wrote everything; no need to return rows
      return { message: 'Scrape complete (pooled DB writes).' };

    } catch (err) {
      console.error('FATAL in runWithProgress:', err.message);
      return { error: err.message };
    } finally {
      isScraping = false;
    }
  },
  imagesDir() {
    try {
      if (!CONFIG.imagesDir) {
        const dir = path.join(app.getPath('userData'), 'images');
        ensureDir(dir);
        CONFIG.imagesDir = dir;
      }
      return CONFIG.imagesDir;
    } catch {
      return null;
    }
  },
  isActive: () => !!isScraping

};

api.pbScraper = api;
module.exports = api;
