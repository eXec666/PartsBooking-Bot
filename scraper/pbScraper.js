// scraper/pbScraper.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');
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
  inputFile: path.join(process.resourcesPath || __dirname, 'prices_input.xlsx'),
  ourSiteCode: 1269,
  maxPartsToProcess: 0,                 // 0 = no cap
  maxConcurrentInstances: 1,            // Math.max(1, Math.floor(os.cpus().length * 0.25)),
  requestThrottleMs: { min: 1500, max: 3000 },
  navigation: {
    timeout: 60000,
    waitUntil: 'domcontentloaded'
  },
  apiWaitMs: 60000,
  imagesDir: path.resolve(process.resourcesPath || __dirname, 'images'),
  imageDownloadTimeoutMs: 10000
};

const sleep = ms => new Promise(res => setTimeout(res, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleepRandom = ({ min, max }) => sleep(randInt(min, max));

let sharedTaskQueue = [];
function getNextTask() { return sharedTaskQueue.shift() || null; }

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
  constructor(instanceId) {
    this.instanceId = instanceId;
    this.results = [];
    this.buffer = [];
    this.browser = null;
    this.page = null;
  }

  async initialize() {
    try {
      let execPath = puppeteer.executablePath?.();
      if (execPath && execPath.includes('app.asar')) {
        execPath = execPath.replace('app.asar', 'app.asar.unpacked');
      }
      if (!execPath || !fs.existsSync(execPath)) {
        throw new Error(`Chromium not found at "${execPath}". Install puppeteer and unpack .local-chromium.`);
      }

      console.log(`[pbScraper][worker ${this.instanceId}] Using Chromium at: ${execPath}`);

      const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--disable-extensions',
        '--proxy-server=http://p.webshare.io:80'
      ];

      const workerDataDir = path.join(app.getPath('userData'), `puppeteer_worker_${this.instanceId}`);

      if (!Array.isArray(launchArgs) || launchArgs.some(a => typeof a !== 'string')) {
        throw new Error('launchArgs must be strings only: ' + JSON.stringify(launchArgs.map(a => typeof a)));
      }
      if (typeof workerDataDir !== 'string' || workerDataDir.length === 0) {
        throw new Error('Invalid userDataDir computed from app.getPath("userData")');
      }

      this.browser = await puppeteer.launch({
        headless: false,
        executablePath: execPath,
        args: launchArgs,
        ignoreHTTPSErrors: true,
        userDataDir: workerDataDir
      });

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

      // task-scoped listeners — define once per task
      const onReq = (r) => {
        const u = r.url();
        if (isPriceSearch(u)) {
          sawPriceRequest = true;
          console.log(`[worker ${this.instanceId}] price_search request: ${r.method()} ${u}`);
        }
      };

      const onReqFinished = (r) => {
        const u = r.url();
        if (isPriceSearch(u)) {
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
        .waitForResponse(r => r.url().includes('/price_search/search'), { timeout: CONFIG.apiWaitMs })
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
          .waitForResponse(r => r.url().includes('/price_search/search'), { timeout: Math.floor(CONFIG.apiWaitMs / 2) })
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

      const ranked = rankPrice(slag, CONFIG.ourSiteCode, partNumber, brandName);

      this.results.push(ranked);
      this.buffer.push(ranked);

      if (this.buffer.length >= 10) {
        try {
          dbManager.dumpToDb('prices', this.buffer);
        } finally {
          this.buffer = [];
        }
      }
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
      await this.processTask(task);
      progressCallback();
      await sleepRandom(CONFIG.requestThrottleMs);
    }
  }

  async close() {
    try { if (this.page && !this.page.isClosed()) await this.page.close(); } catch {}
    try { if (this.browser) await this.browser.close(); } catch {}
  }
}

let isScraping = false;
const api = {
  runWithProgress: async function (progressCallback = () => {}, onForceRefresh = () => {}, inputFilePath = null) {
    if (isScraping) return { message: 'Scraping is already in progress.' };
    isScraping = true;

    let tickCount = 0;
    const tick = () => progressCallback(null, `Processed ${++tickCount}`);

    try {
      if (!app.isReady()) await app.whenReady();
      const ok = await initDb();
      if (!ok) throw new Error('DB init failed');

      const inputFile = inputFilePath || CONFIG.inputFile;
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
      sharedTaskQueue = [...finalTasks];
      if (finalTasks.length === 0) return [];

      const workerCount = CONFIG.maxConcurrentInstances;
      const workers = [];
      for (let i = 0; i < workerCount; i++) {
        const w = new ParallelScraper(i + 1);
        await w.initialize();
        workers.push(w);
      }

      await Promise.all(workers.map(w => w.workerLoop(tick)));

      for (const w of workers) {
        if (w.buffer && w.buffer.length) {
          dbManager.dumpToDb('prices', w.buffer);
          w.buffer = [];
        }
      }

      const aggregated = workers.flatMap(w => w.results);

      await Promise.all(workers.map(w => w.close()));
      onForceRefresh();

      if (aggregated.length) dbManager.dumpToDb('prices', aggregated);

      return aggregated;
    } catch (err) {
      console.error('FATAL in runWithProgress:', err.message);
      return { error: err.message };
    } finally {
      isScraping = false;
    }
  },
  imagesDir: CONFIG.imagesDir
};

api.pbScraper = api;
module.exports = api;
