// scrapers/prices_scraper.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { v4: uuidv4 } = require('uuid');
const ExcelJS = require('exceljs');
const { app } = require('electron');

const initDb = require('../db/init_db');

puppeteer.use(StealthPlugin());

// --- Configuration ---
const CONFIG = {
  inputFile: path.join(process.resourcesPath || __dirname, 'prices_input.xlsx'),
  siteBase: 'https://partsbooking.ru',
  baseUrl: 'https://partsbooking.ru/products',
  apiBase: 'https://partsbooking.ru/backend/v3/www/3.0.1/price_search/search',
  regionId: 28,
  maxPartsToProcess: 0, // 0 = all
  maxConcurrentInstances: Math.max(1, Math.floor(os.cpus().length * 0.75)),
  requestThrottle: 1200,
  navigation: {
    timeout: 45000,
    waitUntil: 'networkidle2'
  },
  browser: {
    headless: true,
    executablePath: null,
    userDataDir: path.join(app ? app.getPath('userData') : os.tmpdir(), 'puppeteer_prices'),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote'
    ],
    instances: Array.from(
      { length: Math.max(1, Math.floor(os.cpus().length * 0.75)) },
      (_, i) => ({
        x: (i % 2) * 1280,
        y: Math.floor(i / 2) * 800,
        width: 1280,
        height: 800
      })
    )
  },
  debug: {
    saveScreenshots: false,
    screenshotPath: path.join(os.homedir(), 'prices-scraper-debug')
  }
};

const sleep = ms => new Promise(res => setTimeout(res, ms));
let sharedTaskQueue = [];
function getNextTask() { return sharedTaskQueue.shift() || null; }

// --- Parallel Scraper ---
class ParallelScraper {
  constructor(config, instanceId) {
    this.config = config;
    this.instanceId = instanceId;
    this.results = [];
  }

  async initialize() {
    if (!CONFIG.browser.executablePath) {
      const chromeLauncher = await import('chrome-launcher');
      CONFIG.browser.executablePath = chromeLauncher.Launcher.getInstallations()[0];
    }

    this.browser = await puppeteer.launch({
      executablePath: CONFIG.browser.executablePath,
      headless: CONFIG.browser.headless,
      args: CONFIG.browser.args,
      ignoreHTTPSErrors: true,
      userDataDir: CONFIG.browser.userDataDir
    });

    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1280, height: 800 });
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36'
    );
    await this.page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8' });

    // Preload the site once to establish cookies/session.
    await this.page.goto(CONFIG.baseUrl, {
      waitUntil: CONFIG.navigation.waitUntil,
      timeout: CONFIG.navigation.timeout
    }).catch(() => {});
  }

  // Encode space as + for make_name
  encodeForQuery(v) { return encodeURIComponent(v).replace(/%20/g, '+'); }

  buildSearchUrl(brandName, partNumber) {
    const make_name = this.encodeForQuery(String(brandName).trim());
    const oem = encodeURIComponent(String(partNumber).trim());
    // Optional query members left empty intentionally to mirror found request
    const q = [
      `make_name=${make_name}`,
      `oem=${oem}`,
      // detail_name optional; omit to avoid over-encoding issues
      'customer_id',
      'app_token',
      `region_id=${CONFIG.regionId}`,
      `customer_guid=${uuidv4()}`,
      `_=${Date.now()}`
    ].join('&');
    return `${CONFIG.apiBase}?${q}`;
  }

  async fetchPriceItems(brandName, partNumber) {
    const url = this.buildSearchUrl(brandName, partNumber);
    // Use page context fetch to bypass CORS and share cookies.
    return await this.page.evaluate(async (requestUrl) => {
      const res = await fetch(requestUrl, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': 'application/json, text/plain, */*',
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }, url);
  }

  async processTask(task) {
    const { brandName, partNumber } = task;
    try {
      const json = await this.fetchPriceItems(brandName, partNumber);

      const items = Array.isArray(json?.price_items) ? json.price_items : [];
      const compact = items.map(x => ({
        price_id: x?.price_id ?? null,
        cost: x?.cost ?? null
      }));

      this.results.push(...compact);
      return { ok: true, count: compact.length, partNumber };
    } catch (err) {
      return { ok: false, error: err.message, partNumber };
    }
  }

  async workerLoop(progressCallback) {
    while (true) {
      const task = getNextTask();
      if (!task) break;

      await this.processTask(task);
      progressCallback();

      await sleep(CONFIG.requestThrottle + Math.random() * 400);
    }
  }

  async close() {
    if (this.browser) await this.browser.close().catch(() => {});
  }
}

// Global scrape lock
let isScraping = false;

module.exports = {
  runWithProgress: async function (
    progressCallback = () => {},
    onForceRefresh = () => {},
    inputFilePath = null
  ) {
    if (isScraping) return { message: 'Scraping is already in progress.' };
    isScraping = true;

    let tickCount = 0;
    const tick = () => progressCallback(null, `Processed ${++tickCount}`);

    try {
      await initDb(); // keep boot flow consistent

      const inputFile = inputFilePath || CONFIG.inputFile;
      if (!fs.existsSync(inputFile)) throw new Error(`Input file not found: ${inputFile}`);

      // Load Excel
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(inputFile);
      const ws = workbook.getWorksheet(1);
      if (!ws) throw new Error('Worksheet 1 is missing');

      // Resolve headers; defaults: col 1 = Артикул, col 2 = Брэнд
      let colPart = 1;
      let colBrand = 2;
      const headerRow = ws.getRow(1);
      if (headerRow) {
        headerRow.eachCell((cell, colNumber) => {
          const v = (cell && cell.value ? String(cell.value) : '').trim();
          if (v === 'Артикул') colPart = colNumber;
          if (v === 'Брэнд') colBrand = colNumber;
        });
      }

      // Build JOHN DEERE tasks
      const tasks = [];
      ws.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const partCell = row.getCell(colPart).value;
        const brandCell = row.getCell(colBrand).value;
        if (partCell == null || brandCell == null) return;

        const partNumber = String(partCell).trim();
        const brandName = String(brandCell).trim();
        if (!partNumber) return;
        if (brandName.toUpperCase() !== 'JOHN DEERE') return;

        tasks.push({ brandName: 'JOHN DEERE', partNumber });
      });

      const finalTasks =
        CONFIG.maxPartsToProcess > 0 ? tasks.slice(0, CONFIG.maxPartsToProcess) : tasks;

      sharedTaskQueue = [...finalTasks];
      const total = finalTasks.length;
      if (total === 0) return [];

      // Init workers
      const workerInitPromises = CONFIG.browser.instances.map(async (conf, idx) => {
        try {
          const w = new ParallelScraper(conf, idx + 1);
          await w.initialize();
          return w;
        } catch (e) {
          return null;
        }
      });

      const workers = (await Promise.all(workerInitPromises)).filter(Boolean);
      if (workers.length === 0) throw new Error('No scraper workers could be initialized.');

      await Promise.all(workers.map(w => w.workerLoop(tick)));

      // Aggregate results across workers into a flat array of { price_id, cost }
      const aggregated = workers.flatMap(w => w.results);

      await Promise.all(workers.map(w => w.close()));
      onForceRefresh();

      return aggregated;
    } catch (err) {
      return { error: err.message };
    } finally {
      isScraping = false;
    }
  }
};
