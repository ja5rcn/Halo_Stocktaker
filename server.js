const express = require('express');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const StocktakeManager = require('./lib/stocktake-manager');
const StocktakeCreator = require('./stocktake-creator');
const HaloAPI = require('./lib/halo-api');
const { generateLabelsPDF } = require('./lib/label-generator');
const { generateReportPDF } = require('./lib/report-generator');

const halo = new HaloAPI();

const app = express();
const stocktakeManager = new StocktakeManager();
const stocktakeCreator = new StocktakeCreator();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// IP Allowlist - uses X-Forwarded-For when source is trusted HAProxy
const dns = require('dns');
let PROXY_IP = process.env.PROXY_IP || '127.0.0.1';
let ALLOWLIST_HOST = process.env.ALLOWLIST_HOST || '';
const ALLOWLIST_TTL_MS = 5 * 60 * 1000;
let allowlistCache = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
let allowlistFetchedAt = 0;

async function refreshAllowlist() {
  if (!ALLOWLIST_HOST) return;
  try {
    const ips = await dns.promises.resolve4(ALLOWLIST_HOST);
    const fresh = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
    for (const ip of ips) fresh.add(ip);
    allowlistCache = fresh;
    allowlistFetchedAt = Date.now();
    console.log(`[allowlist] Refreshed: ${ips.length} IPs from ${ALLOWLIST_HOST}`);
  } catch (err) {
    console.error(`[allowlist] DNS lookup failed, retaining cache:`, err.message);
  }
}

refreshAllowlist();
setInterval(refreshAllowlist, ALLOWLIST_TTL_MS);

app.use((req, res, next) => {
  if (!ALLOWLIST_HOST) return next();
  if (Date.now() - allowlistFetchedAt > ALLOWLIST_TTL_MS * 2) refreshAllowlist();
  const tcpIp = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  let clientIp = tcpIp;
  if (tcpIp === PROXY_IP) {
    const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) clientIp = xff;
  }
  if (allowlistCache.has(clientIp)) return next();
  console.warn(`[allowlist] DENY ${req.method} ${req.url} tcp=${tcpIp} client=${clientIp}`);
  res.status(403).type('text').send('Forbidden: IP not allowlisted');
});

app.use(express.static('public'));

// Initialize data directory
stocktakeManager.initialize();

// API Routes

// Get all stocktakes
app.get('/api/stocktakes', async (req, res) => {
  try {
    const stocktakes = await stocktakeManager.listStocktakes();
    res.json(stocktakes);
  } catch (error) {
    console.error('Error getting stocktakes:', error);
    res.status(500).json({ error: 'Failed to get stocktakes' });
  }
});

// Get specific stocktake
app.get('/api/stocktake/:id', async (req, res) => {
  try {
    const stocktake = await stocktakeManager.loadStocktake(req.params.id);
    // Lazy upgrade: backfill new report fields (countedItems + value totals) on
    // reports generated before the enrichment was added.
    if (stocktake.report && !stocktake.report.countedItems) {
      stocktake.report = stocktakeManager.generateDifferentialReport(stocktake);
      await stocktakeManager.saveStocktake(stocktake);
    }
    res.json(stocktake);
  } catch (error) {
    console.error('Error getting stocktake:', error);
    res.status(500).json({ error: 'Failed to get stocktake' });
  }
});

// Download stocktake report as A4 PDF (always regenerates, overwrites cache)
app.get('/api/stocktake/:id/report-pdf', async (req, res) => {
  try {
    const stocktake = await stocktakeManager.loadStocktake(req.params.id);
    if (!stocktake.report || !stocktake.report.countedItems) {
      stocktake.report = stocktakeManager.generateDifferentialReport(stocktake);
      await stocktakeManager.saveStocktake(stocktake);
    }

    const reportsDir = path.join(__dirname, 'data', 'reports');
    await fs.promises.mkdir(reportsDir, { recursive: true });
    const safeName = (stocktake.name || 'stocktake').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const cacheKey = `${req.params.id}_${stocktake.report.generatedAt.replace(/[^0-9TZ.-]/g, '')}_${safeName}.pdf`;
    const cachePath = path.join(reportsDir, cacheKey);

    const pdf = await generateReportPDF(stocktake);
    await fs.promises.writeFile(cachePath, pdf);
    console.log(`📄 Generated + cached report PDF: ${cachePath}`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="stocktake-${safeName}.pdf"`);
    res.send(pdf);
  } catch (error) {
    console.error('Error generating report PDF:', error);
    res.status(500).json({ error: 'Failed to generate PDF: ' + error.message });
  }
});

// List cached report PDFs
app.get('/api/reports', async (req, res) => {
  try {
    const reportsDir = path.join(__dirname, 'data', 'reports');
    let files = [];
    try {
      files = await fs.promises.readdir(reportsDir);
    } catch (e) { /* dir doesn't exist yet */ }
    const out = [];
    for (const f of files) {
      if (!f.endsWith('.pdf')) continue;
      const stat = await fs.promises.stat(path.join(reportsDir, f));
      // Parse cache key: <stocktakeId>_<generatedAt>_<safeName>.pdf
      const m = f.match(/^([^_]+)_(.+)_([^_]+)\.pdf$/);
      out.push({
        filename: f,
        size: stat.size,
        createdAt: stat.mtimeMs,
        stocktakeId: m ? m[1] : null,
        generatedAt: m ? m[2] : null,
        stocktakeName: m ? m[3].replace(/-/g, ' ') : f.replace(/\.pdf$/, '')
      });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    res.json({ reports: out });
  } catch (error) {
    console.error('Error listing reports:', error);
    res.status(500).json({ error: 'Failed to list reports: ' + error.message });
  }
});

// Serve a cached report PDF
app.get('/api/reports/:filename', async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    if (!/^[\w.\-]+\.pdf$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const filePath = path.join(__dirname, 'data', 'reports', filename);
    try {
      await fs.promises.access(filePath);
    } catch {
      return res.status(404).json({ error: 'Report not found' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    console.error('Error serving report:', error);
    res.status(500).json({ error: 'Failed to serve report: ' + error.message });
  }
});

// Delete a cached report PDF
app.delete('/api/reports/:filename', async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    if (!/^[\w.\-]+\.pdf$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const filePath = path.join(__dirname, 'data', 'reports', filename);
    await fs.promises.unlink(filePath);
    console.log(`🗑️ Deleted cached report: ${filename}`);
    res.json({ success: true });
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'Report not found' });
    console.error('Error deleting report:', error);
    res.status(500).json({ error: 'Failed to delete report: ' + error.message });
  }
});

// Start stocktake creation with progress tracking
app.post('/api/start-stocktake-creation', async (req, res) => {
  try {
    const { name, notes } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Stocktake name is required' });
    }

    console.log(`Starting stocktake creation: ${name}`);

    const result = await stocktakeCreator.startCreation(name, {
      notes: notes || ''
    });

    res.json(result);
  } catch (error) {
    console.error('Error starting stocktake creation:', error);
    res.status(500).json({ error: 'Failed to start creation: ' + error.message });
  }
});

// Get stocktake creation progress
app.get('/api/stocktake-progress/:creationId', async (req, res) => {
  try {
    const progress = await stocktakeCreator.getProgress(req.params.creationId);
    if (!progress) {
      return res.status(404).json({ error: 'Progress not found' });
    }
    res.json(progress);
  } catch (error) {
    console.error('Error getting progress:', error);
    res.status(500).json({ error: 'Failed to get progress' });
  }
});

// Create new stocktake (original method)
app.post('/api/create-stocktake', async (req, res) => {
  try {
    const { name, notes } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Stocktake name is required' });
    }

    console.log(`Creating stocktake: ${name}`);

    const stocktake = await stocktakeManager.createStocktake(name, {
      notes: notes || ''
    });

    res.json(stocktake);
  } catch (error) {
    console.error('Error creating stocktake:', error);
    res.status(500).json({ error: 'Failed to create stocktake: ' + error.message });
  }
});

// Update counted quantity
app.post('/api/update-quantity', async (req, res) => {
  try {
    const { stocktakeId, itemId, locationId, countedQuantity } = req.body;

    const ok = await stocktakeManager.updateCountedQuantity(stocktakeId, itemId, locationId, countedQuantity);
    if (!ok) return res.status(404).json({ error: 'Item or location not found in stocktake' });
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating quantity:', error);
    res.status(500).json({ error: 'Failed to update quantity' });
  }
});

// Update serial number status
app.post('/api/update-serial', async (req, res) => {
  try {
    const { stocktakeId, itemId, locationId, serialId, found } = req.body;

    await stocktakeManager.updateSerialNumber(stocktakeId, itemId, locationId, serialId, found);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating serial:', error);
    res.status(500).json({ error: 'Failed to update serial status' });
  }
});

// Add additional serial number
app.post('/api/add-serial', async (req, res) => {
  try {
    const { stocktakeId, itemId, locationId, serialNumber } = req.body;

    await stocktakeManager.addAdditionalSerial(stocktakeId, itemId, locationId, serialNumber);
    res.json({ success: true });
  } catch (error) {
    console.error('Error adding serial:', error);
    res.status(500).json({ error: 'Failed to add serial number' });
  }
});

// Save variance reason (review step)
app.post('/api/update-variance-reason', async (req, res) => {
  try {
    const { stocktakeId, itemId, locationId, reason } = req.body;

    await stocktakeManager.setVarianceReason(stocktakeId, itemId, locationId, reason);
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving variance reason:', error);
    res.status(500).json({ error: 'Failed to save variance reason' });
  }
});

// Reopen a completed stocktake
app.post('/api/reopen-stocktake', async (req, res) => {
  try {
    const { stocktakeId } = req.body;
    const stocktake = await stocktakeManager.reopenStocktake(stocktakeId);
    res.json(stocktake);
  } catch (error) {
    console.error('Error reopening stocktake:', error);
    res.status(500).json({ error: 'Failed to reopen stocktake: ' + error.message });
  }
});

// Add a single item to a stocktake (re-extracts from Halo)
app.post('/api/stocktake/:id/add-item', async (req, res) => {
  try {
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    const result = await stocktakeManager.addItemToStocktake(req.params.id, itemId);
    res.json(result);
  } catch (error) {
    console.error('Error adding item:', error);
    res.status(500).json({ error: 'Failed to add item: ' + error.message });
  }
});

// Remove an item from a stocktake
app.post('/api/stocktake/:id/remove-item', async (req, res) => {
  try {
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    const result = await stocktakeManager.removeItemFromStocktake(req.params.id, itemId);
    res.json(result);
  } catch (error) {
    console.error('Error removing item:', error);
    res.status(500).json({ error: 'Failed to remove item: ' + error.message });
  }
});

// Refresh selected items' expected data from Halo (preserves countedData)
app.post('/api/refresh-halo', async (req, res) => {
  try {
    const { stocktakeId, itemIds } = req.body;
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({ error: 'itemIds array is required' });
    }
    const result = await stocktakeManager.refreshItemsFromHalo(stocktakeId, itemIds);
    res.json(result);
  } catch (error) {
    console.error('Error refreshing from Halo:', error);
    res.status(500).json({ error: 'Failed to refresh from Halo: ' + error.message });
  }
});

// Complete stocktake
app.post('/api/complete-stocktake', async (req, res) => {
  try {
    const { stocktakeId } = req.body;

    const stocktake = await stocktakeManager.completeStocktake(stocktakeId);
    res.json(stocktake);
  } catch (error) {
    console.error('Error completing stocktake:', error);
    res.status(500).json({ error: 'Failed to complete stocktake: ' + error.message });
  }
});

// Delete stocktake
app.delete('/api/stocktake/:id', async (req, res) => {
  try {
    await stocktakeManager.deleteStocktake(req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting stocktake:', error);
    res.status(500).json({ error: 'Failed to delete stocktake: ' + error.message });
  }
});

// Search Purchase Orders by ref or supplier
app.get('/api/po/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q query param required' });
    const results = await halo.searchPurchaseOrders(q);
    res.json({ results });
  } catch (error) {
    console.error('Error searching POs:', error);
    res.status(500).json({ error: 'Failed to search POs: ' + error.message });
  }
});

// Get a Purchase Order with line items + pre-expanded labels
app.get('/api/po/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid PO id' });
    const po = await halo.getPurchaseOrder(id);
    res.json(po);
  } catch (error) {
    console.error('Error getting PO:', error);
    const status = error.response?.status || 500;
    res.status(status).json({ error: 'Failed to get PO: ' + error.message });
  }
});

// List all products for the typeahead picker
app.get('/api/products', async (req, res) => {
  try {
    const products = await halo.listProducts();
    res.json({ products });
  } catch (error) {
    console.error('Error listing products:', error);
    res.status(500).json({ error: 'Failed to list products: ' + error.message });
  }
});

// Get in-stock instances of a product for label generation
app.get('/api/products/:id/instances', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid product id' });
    const data = await halo.getItemInstances(id);
    res.json(data);
  } catch (error) {
    console.error('Error getting product instances:', error);
    const status = error.response?.status || 500;
    res.status(status).json({ error: 'Failed to get product instances: ' + error.message });
  }
});

// Lookup asset by inventory_number / serial fragment
app.get('/api/asset-lookup', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q query param required' });
    const data = await halo.assetToLabel(q);
    if (!data) return res.status(404).json({ error: 'No asset matches ' + q });
    res.json(data);
  } catch (error) {
    console.error('Error looking up asset:', error);
    res.status(500).json({ error: 'Failed to look up asset: ' + error.message });
  }
});

// Generate labels PDF
app.post('/api/labels/generate', async (req, res) => {
  try {
    const labels = Array.isArray(req.body) ? req.body : req.body.labels;
    if (!Array.isArray(labels) || labels.length === 0) {
      return res.status(400).json({ error: 'labels array required' });
    }
    const pdf = await generateLabelsPDF(labels);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="labels.pdf"');
    res.send(pdf);
  } catch (error) {
    console.error('Error generating labels:', error);
    res.status(500).json({ error: 'Failed to generate labels: ' + error.message });
  }
});

// Stock Valuation Report — RCN/HQ (or whichever sites are flagged as stock
// locations in Halo) physical stock + consigned stock on open Sales Orders.
const VALUATION_CONFIG_PATH = path.join(__dirname, 'data', 'valuation-config.json');

function readValuationConfig() {
  try {
    return JSON.parse(fs.readFileSync(VALUATION_CONFIG_PATH, 'utf8'));
  } catch {
    return { stockSiteIds: [] };
  }
}

function writeValuationConfig(config) {
  fs.mkdirSync(path.dirname(VALUATION_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(VALUATION_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function valuationRowsToCsv(rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['itemId', 'itemName', 'quantity', 'unitCost', 'value', 'sourceType', 'source'];
  const lines = [header.join(',')];
  for (const r of rows) lines.push(header.map(h => esc(r[h])).join(','));
  return lines.join('\n');
}

// List Halo sites flagged as stock locations, plus the currently saved selection
app.get('/api/valuation/sites', async (req, res) => {
  try {
    const sites = await halo.listStockSites();
    const config = readValuationConfig();
    res.json({ sites, selectedSiteIds: config.stockSiteIds || [] });
  } catch (error) {
    console.error('Error listing stock sites:', error);
    res.status(500).json({ error: 'Failed to list stock sites: ' + error.message });
  }
});

// Save which stock-location sites feed the valuation report
app.post('/api/valuation/sites', (req, res) => {
  try {
    const { stockSiteIds } = req.body;
    if (!Array.isArray(stockSiteIds)) {
      return res.status(400).json({ error: 'stockSiteIds array required' });
    }
    writeValuationConfig({ stockSiteIds: stockSiteIds.map(Number).filter(Number.isFinite) });
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving stock sites:', error);
    res.status(500).json({ error: 'Failed to save stock sites: ' + error.message });
  }
});

// Run the valuation report live against Halo
app.get('/api/valuation/report', async (req, res) => {
  try {
    const config = readValuationConfig();
    if (!config.stockSiteIds || config.stockSiteIds.length === 0) {
      return res.status(400).json({ error: 'No stock sites selected — pick at least one in Settings' });
    }
    const report = await halo.getStockValuationReport(config.stockSiteIds);
    res.json(report);
  } catch (error) {
    console.error('Error generating valuation report:', error);
    res.status(500).json({ error: 'Failed to generate valuation report: ' + error.message });
  }
});

// Same report as a CSV download
app.get('/api/valuation/report.csv', async (req, res) => {
  try {
    const config = readValuationConfig();
    if (!config.stockSiteIds || config.stockSiteIds.length === 0) {
      return res.status(400).json({ error: 'No stock sites selected — pick at least one in Settings' });
    }
    const report = await halo.getStockValuationReport(config.stockSiteIds);
    const csv = valuationRowsToCsv(report.rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="stock-valuation-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Error exporting valuation report:', error);
    res.status(500).json({ error: 'Failed to export valuation report: ' + error.message });
  }
});

// Valuation report history — saved snapshots the report can be re-downloaded
// from later. Archive/delete are both soft states (recoverable), matching the
// active/archived/deleted pattern used for customers elsewhere in this org's tools.
const VALUATION_HISTORY_DIR = path.join(__dirname, 'data', 'valuation-history');
const VALUATION_HISTORY_INDEX = path.join(VALUATION_HISTORY_DIR, 'index.json');
const VALUATION_HISTORY_STATUSES = ['active', 'archived', 'deleted'];

// IDs are always generateHistoryId() output (timestamp+random base36). Reject
// anything else before it reaches a file path — same class of bug as the
// stocktake-id path traversal fixed earlier.
function assertValidHistoryId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9]+$/i.test(id)) {
    throw new Error('Invalid history id');
  }
}

function generateHistoryId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function readValuationHistoryIndex() {
  try {
    return JSON.parse(fs.readFileSync(VALUATION_HISTORY_INDEX, 'utf8'));
  } catch {
    return [];
  }
}

function writeValuationHistoryIndex(index) {
  fs.mkdirSync(VALUATION_HISTORY_DIR, { recursive: true });
  fs.writeFileSync(VALUATION_HISTORY_INDEX, JSON.stringify(index, null, 2));
}

// Save the last-run report as a permanent, downloadable snapshot
app.post('/api/valuation/history', (req, res) => {
  try {
    const { rows, totals, generatedAt } = req.body || {};
    if (!Array.isArray(rows) || !totals) {
      return res.status(400).json({ error: 'rows and totals required' });
    }
    const id = generateHistoryId();
    const savedAt = new Date().toISOString();
    const entry = { id, generatedAt: generatedAt || savedAt, savedAt, status: 'active', totals, rows };

    fs.mkdirSync(VALUATION_HISTORY_DIR, { recursive: true });
    fs.writeFileSync(path.join(VALUATION_HISTORY_DIR, `${id}.json`), JSON.stringify(entry, null, 2));

    const index = readValuationHistoryIndex();
    index.push({ id, generatedAt: entry.generatedAt, savedAt, status: 'active', totals });
    writeValuationHistoryIndex(index);

    res.json({ success: true, id });
  } catch (error) {
    console.error('Error saving valuation history:', error);
    res.status(500).json({ error: 'Failed to save history: ' + error.message });
  }
});

// List saved report snapshots (summary only — no row data)
app.get('/api/valuation/history', (req, res) => {
  try {
    const index = readValuationHistoryIndex();
    index.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
    res.json({ history: index });
  } catch (error) {
    console.error('Error listing valuation history:', error);
    res.status(500).json({ error: 'Failed to list history: ' + error.message });
  }
});

// Download a saved snapshot as CSV
app.get('/api/valuation/history/:id/csv', (req, res) => {
  try {
    assertValidHistoryId(req.params.id);
    const filePath = path.join(VALUATION_HISTORY_DIR, `${req.params.id}.json`);
    const entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const csv = valuationRowsToCsv(entry.rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="stock-valuation-${entry.savedAt.slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'Snapshot not found' });
    console.error('Error downloading valuation history:', error);
    res.status(500).json({ error: 'Failed to download snapshot: ' + error.message });
  }
});

// Change a snapshot's status — active / archived / deleted, all reversible
app.post('/api/valuation/history/:id/status', (req, res) => {
  try {
    assertValidHistoryId(req.params.id);
    const { status } = req.body || {};
    if (!VALUATION_HISTORY_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALUATION_HISTORY_STATUSES.join(', ')}` });
    }

    const index = readValuationHistoryIndex();
    const entry = index.find(e => e.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Snapshot not found' });
    entry.status = status;
    writeValuationHistoryIndex(index);

    const filePath = path.join(VALUATION_HISTORY_DIR, `${req.params.id}.json`);
    try {
      const full = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      full.status = status;
      fs.writeFileSync(filePath, JSON.stringify(full, null, 2));
    } catch { /* index is the source of truth for listing either way */ }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating valuation history status:', error);
    res.status(500).json({ error: 'Failed to update status: ' + error.message });
  }
});

// Settings — view/edit .env-backed configuration from the web UI
const ENV_PATH = path.join(__dirname, '.env');

// key -> { secret } — only these keys can be read or written via the API
const SETTINGS_FIELDS = {
  HALO_CLIENT_ID: { secret: true },
  HALO_CLIENT_SECRET: { secret: true },
  HALO_BASE_URL: { secret: false },
  HALO_TOKEN_URL: { secret: false },
  PORT: { secret: false },
  ALLOWLIST_HOST: { secret: false },
  PROXY_IP: { secret: false }
};

function readEnvFile() {
  try {
    return dotenv.parse(fs.readFileSync(ENV_PATH));
  } catch {
    return {};
  }
}

function writeEnvFile(vars) {
  const lines = [
    '# Halo API Configuration',
    `HALO_CLIENT_ID=${vars.HALO_CLIENT_ID || ''}`,
    `HALO_CLIENT_SECRET=${vars.HALO_CLIENT_SECRET || ''}`,
    `HALO_BASE_URL=${vars.HALO_BASE_URL || ''}`,
    `HALO_TOKEN_URL=${vars.HALO_TOKEN_URL || ''}`,
    '',
    '# Server Configuration',
    `PORT=${vars.PORT || ''}`,
    '',
    '# IP Allowlist',
    `ALLOWLIST_HOST=${vars.ALLOWLIST_HOST || ''}`,
    `PROXY_IP=${vars.PROXY_IP || ''}`,
    ''
  ];
  fs.writeFileSync(ENV_PATH, lines.join('\n'), { mode: 0o600 });
}

// Get current settings — secret fields are masked (never returned in full)
app.get('/api/settings', (req, res) => {
  const current = { ...readEnvFile(), ...process.env };
  const out = {};
  for (const [key, meta] of Object.entries(SETTINGS_FIELDS)) {
    const value = current[key] || '';
    if (meta.secret) {
      out[key] = { set: !!value, masked: value ? `••••${value.slice(-4)}` : '' };
    } else {
      out[key] = { value };
    }
  }
  res.json(out);
});

// Update settings — writes .env, updates process.env, and hot-reloads the
// live Halo API clients. PORT/allowlist DNS host changes need a restart or
// take effect on the next allowlist refresh respectively.
app.post('/api/settings', (req, res) => {
  try {
    const body = req.body || {};
    const current = { ...readEnvFile(), ...process.env };
    const updated = { ...current };

    for (const key of Object.keys(SETTINGS_FIELDS)) {
      if (!(key in body)) continue;
      const value = String(body[key] ?? '').trim();
      // Blank secret fields mean "leave unchanged" — the UI never shows the
      // real value, so an empty submit isn't an intentional clear.
      if (SETTINGS_FIELDS[key].secret && !value) continue;
      updated[key] = value;
    }

    if (updated.PORT && !/^\d+$/.test(updated.PORT)) {
      return res.status(400).json({ error: 'PORT must be a number' });
    }

    writeEnvFile(updated);
    for (const key of Object.keys(SETTINGS_FIELDS)) {
      process.env[key] = updated[key] || '';
    }

    halo.configure({
      baseURL: updated.HALO_BASE_URL,
      tokenURL: updated.HALO_TOKEN_URL,
      clientId: updated.HALO_CLIENT_ID,
      clientSecret: updated.HALO_CLIENT_SECRET
    });
    stocktakeManager.haloAPI.configure({
      baseURL: updated.HALO_BASE_URL,
      tokenURL: updated.HALO_TOKEN_URL,
      clientId: updated.HALO_CLIENT_ID,
      clientSecret: updated.HALO_CLIENT_SECRET
    });

    const portChanged = String(current.PORT || PORT) !== String(updated.PORT || PORT);
    if (updated.ALLOWLIST_HOST !== ALLOWLIST_HOST || updated.PROXY_IP !== PROXY_IP) {
      ALLOWLIST_HOST = updated.ALLOWLIST_HOST || '';
      PROXY_IP = updated.PROXY_IP || '127.0.0.1';
      refreshAllowlist();
    }

    res.json({ success: true, restartRequired: portChanged });
  } catch (error) {
    console.error('Error saving settings:', error);
    res.status(500).json({ error: 'Failed to save settings: ' + error.message });
  }
});

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Halo Stocktake System running on http://localhost:${PORT}`);
  console.log(`📁 Data directory: ${path.join(__dirname, 'data')}`);
  console.log(`🔧 Ready to create and manage stocktakes!`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});

module.exports = app;