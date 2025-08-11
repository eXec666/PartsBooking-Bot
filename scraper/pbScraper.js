// scraper/pbScraper.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const ExcelJS = require('exceljs');
const { app } = require('electron');
const initDb = require('../db/init_db');
const dbManager = require('../db/db_Manager');
const { rankPrice } = dbManager;

puppeteer.use(StealthPlugin());

const CONFIG = {
  inputFile: path.join(process.resourcesPath || __dirname, 'prices_input.xlsx'),
  ourSiteCode: 1269,
  maxPartsToProcess: 0,
  maxConcurrentInstances: Math.max(1, Math.min(2, os.cpus().length)),
  requestThrottle: 1200,
  navigation: { timeout: 45000, waitUntil: 'networkidle2' }
};

const sleep = ms => new Promise(res => setTimeout(res, ms));

let sharedTaskQueue = [];
function getNextTask() { return sharedTaskQueue.shift() || null; }

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
        '--single-process',
        '--disable-extensions'
      ];

      const workerDataDir = path.join(app.getPath('userData'), `puppeteer_worker_${this.instanceId}`);

      this.browser = await puppeteer.launch({
        headless: true,
        executablePath: execPath,
        args: launchArgs,
        ignoreHTTPSErrors: true,
        userDataDir: workerDataDir
      });

      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: 1280, height: 800 });
      await this.page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36'
      );
      await this.page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8' });

    } catch (e) {
      console.error(`[worker ${this.instanceId}] puppeteer launch failed: ${e.message}`);
      throw e;
    }
  }

  buildProductUrl(brandName, partNumber) {
    const brand = encodeURIComponent(String(brandName).trim());
    const part = encodeURIComponent(String(partNumber).trim());
    return `https://partsbooking.ru/products/${brand}/${part}.html`;
  }

  async processTask(task) {
    const { brandName, partNumber } = task;
    try {
      const productUrl = this.buildProductUrl(brandName, partNumber);
      console.log(`[worker ${this.instanceId}] Navigating to: ${productUrl}`);

      await this.page.goto(productUrl, CONFIG.navigation);

      // TODO: Replace this placeholder with your page scraping logic
      // For now we'll just grab all script JSON and parse price_items if available
      const data = await this.page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script')).map(s => s.textContent);
        return scripts.join('\n');
      });

      // You'd parse `data` here to extract site_code and price info
      // The following is placeholder logic:
      const priceItems = []; // parse from `data` when you implement
      const slag = priceItems
        .map(x => [x?.price_id ?? x?.site_code ?? null, x?.cost ?? x?.price ?? null])
        .filter(p => p[0] != null && p[1] != null);

      const ranked = rankPrice(slag, CONFIG.ourSiteCode, partNumber, brandName);

      this.results.push(ranked);
      this.buffer.push(ranked);

      if (this.buffer.length >= 100) {
        try {
          dbManager.dumpToDb('prices', this.buffer);
        } finally {
          this.buffer = [];
        }
      }

      return { ok: true, count: slag.length, partNumber };
    } catch (err) {
      console.error(`[worker ${this.instanceId}] task ${partNumber} failed: ${err.message}`);
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
    try { if (this.page && !this.page.isClosed()) await this.page.close(); } catch {}
    try { if (this.browser) await this.browser.close(); } catch {}
  }
}

let isScraping = false;

module.exports = {
  runWithProgress: async function (progressCallback = () => {}, onForceRefresh = () => {}, inputFilePath = null) {
    if (isScraping) return { message: 'Scraping is already in progress.' };
    isScraping = true;

    let tickCount = 0;
    const tick = () => progressCallback(null, `Processed ${++tickCount}`);

    try {
      const ok = await initDb();
      if (!ok) throw new Error('DB init failed');

      const inputFile = inputFilePath || CONFIG.inputFile;
      if (!fs.existsSync(inputFile)) throw new Error(`Input file not found: ${inputFile}`);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(inputFile);
      const ws = workbook.getWorksheet(1);
      if (!ws) throw new Error('Worksheet 1 is missing');

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

      const tasks = [];
      ws.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const partCell = row.getCell(colPart).value;
        const brandCell = row.getCell(colBrand).value;
        if (partCell == null || brandCell == null) return;
        const partNumber = String(partCell).trim();
        const brandName = String(brandCell).trim();
        if (!partNumber) return;
        tasks.push({ brandName, partNumber });
      });

      const finalTasks = CONFIG.maxPartsToProcess > 0 ? tasks.slice(0, CONFIG.maxPartsToProcess) : tasks;
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
  }
};
