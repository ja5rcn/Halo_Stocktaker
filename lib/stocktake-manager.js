const fs = require('fs').promises;
const path = require('path');
const HaloAPI = require('./halo-api');

class StocktakeManager {
  constructor() {
    this.haloAPI = new HaloAPI();
    this.dataDir = path.join(__dirname, '..', 'data');
    this._writeQueues = new Map();
  }

  /**
   * IDs are always generateId() output (timestamp+random base36). Reject anything
   * else before it reaches a file path — blocks path traversal via crafted ids.
   */
  _assertValidId(id) {
    if (typeof id !== 'string' || !/^[a-z0-9]+$/i.test(id)) {
      throw new Error('Invalid stocktake id');
    }
  }

  /**
   * Serialize async work per stocktake id — prevents load/modify/save races
   * between concurrent requests (e.g. update-quantity vs refresh-halo).
   */
  async withStocktakeLock(id, fn) {
    if (!this._writeQueues.has(id)) {
      this._writeQueues.set(id, Promise.resolve());
    }
    const prev = this._writeQueues.get(id);
    let release;
    const next = new Promise(r => { release = r; });
    this._writeQueues.set(id, prev.then(() => next));
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Create new stocktake session
   */
  async createStocktake(name, options = {}) {
    console.log(`Creating stocktake: ${name}`);

    // Extract current data from Halo
    const haloData = await this.haloAPI.extractStocktakeData();

    // Create stocktake session
    const stocktake = {
      id: this.generateId(),
      name: name,
      createdAt: new Date().toISOString(),
      status: 'in_progress', // in_progress, completed, cancelled
      options: {
        includeZeroStock: options.includeZeroStock || false,
        selectedLocations: options.selectedLocations || [],
        selectedCategories: options.selectedCategories || []
      },
      haloData: haloData,
      countedData: this.initializeCountedData(haloData),
      summary: this.generateSummary(haloData)
    };

    // Save to file
    await this.saveStocktake(stocktake);

    console.log(`✅ Stocktake created: ${stocktake.id}`);
    return stocktake;
  }

  /**
   * Initialize counted data structure
   */
  initializeCountedData(haloData) {
    const countedData = {
      items: [],
      completedAt: null,
      completedBy: null
    };

    for (const item of haloData.items) {
      const countedItem = {
        id: item.id,
        name: item.name,
        cost: item.cost || 0,
        price: item.price || 0,
        stockLocations: []
      };

      for (const location of item.stockLocations) {
        const countedLocation = {
          id: location.id,
          name: location.name,
          expectedQuantity: location.expectedQuantity,
          countedQuantity: null, // To be filled during stocktake
          serialNumbers: location.serialNumbers.map(serial => ({
            id: serial.id,
            serialNumber: serial.serialNumber,
            cost: serial.cost || 0,
            expected: true,
            found: false, // To be checked during stocktake
            notes: ''
          })),
          additionalSerials: [], // Serials found but not expected
          notes: ''
        };

        countedItem.stockLocations.push(countedLocation);
      }

      countedData.items.push(countedItem);
    }

    return countedData;
  }

  /**
   * Generate summary of stocktake
   */
  generateSummary(haloData) {
    let totalItems = 0;
    let totalSerialised = 0;
    let totalNonSerialised = 0;
    let totalLocations = 0;

    const locationCounts = new Map();
    const categoryCounts = new Map();

    for (const item of haloData.items) {
      totalItems++;

      if (item.isSerialised) {
        totalSerialised++;
      } else {
        totalNonSerialised++;
      }

      // Safety check for stockLocations
      if (item.stockLocations && Array.isArray(item.stockLocations)) {
        for (const location of item.stockLocations) {
          totalLocations++;

          const locName = location.stockBinName || location.name;
          locationCounts.set(locName, (locationCounts.get(locName) || 0) + 1);

          const catName = item.assetGroupName || 'Unknown';
          categoryCounts.set(catName, (categoryCounts.get(catName) || 0) + 1);
        }
      }
    }

    return {
      totalItems,
      totalSerialised,
      totalNonSerialised,
      totalLocations,
      locations: Object.fromEntries(locationCounts),
      categories: Object.fromEntries(categoryCounts)
    };
  }

  /**
   * Save stocktake to file
   */
  async saveStocktake(stocktake) {
    this._assertValidId(stocktake.id);
    const filename = `stocktake-${stocktake.id}.json`;
    const filepath = path.join(this.dataDir, filename);

    await fs.writeFile(filepath, JSON.stringify(stocktake, null, 2));

    // Also update the index
    await this.updateIndex(stocktake);

    return filepath;
  }

  /**
   * Update stocktake index
   */
  async updateIndex(stocktake) {
    const indexPath = path.join(this.dataDir, 'index.json');

    let index = [];
    try {
      const data = await fs.readFile(indexPath, 'utf8');
      index = JSON.parse(data);
    } catch (error) {
      // Index doesn't exist yet, create new one
    }

    // Update or add entry
    const existingIndex = index.findIndex(s => s.id === stocktake.id);
    const entry = {
      id: stocktake.id,
      name: stocktake.name,
      createdAt: stocktake.createdAt,
      status: stocktake.status,
      summary: stocktake.summary
    };

    if (existingIndex >= 0) {
      index[existingIndex] = entry;
    } else {
      index.push(entry);
    }

    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
  }

  /**
   * Load stocktake by ID
   */
  async loadStocktake(id) {
    this._assertValidId(id);
    const filename = `stocktake-${id}.json`;
    const filepath = path.join(this.dataDir, filename);

    const data = await fs.readFile(filepath, 'utf8');
    return JSON.parse(data);
  }

  /**
   * Update index file
   */
  async updateIndexFile(index) {
    const indexPath = path.join(this.dataDir, 'index.json');
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
  }

  /**
   * List all stocktakes
   */
  async listStocktakes() {
    const indexPath = path.join(this.dataDir, 'index.json');

    try {
      const data = await fs.readFile(indexPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      return [];
    }
  }

  /**
   * Update counted quantity for non-serialised item
   */
  async updateCountedQuantity(stocktakeId, itemId, locationId, countedQuantity) {
    return this.withStocktakeLock(stocktakeId, async () => {
      const stocktake = await this.loadStocktake(stocktakeId);

      const item = stocktake.countedData.items.find(i => String(i.id) === String(itemId));
      if (item) {
        const location = item.stockLocations.find(l => String(l.id) === String(locationId));
        if (location) {
          location.countedQuantity = parseInt(countedQuantity);
          location.lastCountedAt = new Date().toISOString();
          await this.saveStocktake(stocktake);
          return true;
        }
      }

      return false;
    });
  }

  /**
   * Update serial number verification
   */
  async updateSerialNumber(stocktakeId, itemId, locationId, serialId, found) {
    return this.withStocktakeLock(stocktakeId, async () => {
      const stocktake = await this.loadStocktake(stocktakeId);

      const item = stocktake.countedData.items.find(i => String(i.id) === String(itemId));
      if (item) {
        const location = item.stockLocations.find(l => String(l.id) === String(locationId));
        if (location) {
          const serial = location.serialNumbers.find(s => String(s.id) === String(serialId));
          if (serial) {
            serial.found = found;
            if (found) {
              location.lastCountedAt = new Date().toISOString();
            }
            await this.saveStocktake(stocktake);
            return true;
          }
        }
      }

      return false;
    });
  }

  /**
   * Add additional serial number found during stocktake
   */
  async addAdditionalSerial(stocktakeId, itemId, locationId, serialNumber) {
    return this.withStocktakeLock(stocktakeId, async () => {
      const stocktake = await this.loadStocktake(stocktakeId);

      const item = stocktake.countedData.items.find(i => String(i.id) === String(itemId));
      if (item) {
        const location = item.stockLocations.find(l => String(l.id) === String(locationId));
        if (location) {
          location.additionalSerials.push({
            id: this.generateId(),
            serialNumber: serialNumber,
            notes: ''
          });
          location.lastCountedAt = new Date().toISOString();
          await this.saveStocktake(stocktake);
          return true;
        }
      }

      return false;
    });
  }

  /**
   * Save user-supplied reason for an item+location variance (review step)
   */
  async setVarianceReason(stocktakeId, itemId, locationId, reason) {
    return this.withStocktakeLock(stocktakeId, async () => {
      const stocktake = await this.loadStocktake(stocktakeId);

      const item = stocktake.countedData.items.find(i => String(i.id) === String(itemId));
      if (!item) return false;

      const location = item.stockLocations.find(l => String(l.id) === String(locationId));
      if (!location) return false;

      location.varianceReason = (reason || '').slice(0, 1000);
      await this.saveStocktake(stocktake);
      return true;
    });
  }

  /**
   * Add an item from Halo to an existing stocktake. Idempotent — no-op if
   * already present. Re-extracts via haloAPI.extractItemData and initialises
   * the matching countedData entry.
   */
  async addItemToStocktake(stocktakeId, itemId) {
    return this.withStocktakeLock(stocktakeId, async () => {
      const stocktake = await this.loadStocktake(stocktakeId);
      const id = Number(itemId);
      if (!id) throw new Error('Invalid itemId');

      const existsHalo = stocktake.haloData.items.some(i => i.id === id);
      const existsCounted = stocktake.countedData.items.some(i => i.id === id);
      if (existsHalo && existsCounted) {
        return { stocktake, added: false, reason: 'already present' };
      }

      await this.haloAPI.authenticate();
      const freshItem = await this.haloAPI.extractItemData(id);
      if (!freshItem) throw new Error('Item not found in Halo');

      if (!existsHalo) stocktake.haloData.items.push(freshItem);
      if (!existsCounted) {
        const init = this.initializeCountedData({ items: [freshItem] });
        stocktake.countedData.items.push(init.items[0]);
      }

      stocktake.haloData.extractedAt = new Date().toISOString();
      stocktake.summary = this.generateSummary(stocktake.haloData);
      await this.saveStocktake(stocktake);
      console.log(`➕ Added item ${id} to stocktake ${stocktakeId}`);
      return { stocktake, added: true };
    });
  }

  /**
   * Remove an item from a stocktake (both haloData and countedData).
   * Returns false if the item was not present.
   */
  async removeItemFromStocktake(stocktakeId, itemId) {
    return this.withStocktakeLock(stocktakeId, async () => {
      const stocktake = await this.loadStocktake(stocktakeId);
      const id = Number(itemId);
      if (!id) throw new Error('Invalid itemId');

      const beforeHalo = stocktake.haloData.items.length;
      const beforeCounted = stocktake.countedData.items.length;
      stocktake.haloData.items = stocktake.haloData.items.filter(i => i.id !== id);
      stocktake.countedData.items = stocktake.countedData.items.filter(i => i.id !== id);
      const removed = (stocktake.haloData.items.length !== beforeHalo)
        || (stocktake.countedData.items.length !== beforeCounted);

      if (removed) {
        stocktake.summary = this.generateSummary(stocktake.haloData);
        await this.saveStocktake(stocktake);
        console.log(`➖ Removed item ${id} from stocktake ${stocktakeId}`);
      }
      return { stocktake, removed };
    });
  }

  /**
   * Reopen a completed stocktake — return to in_progress for further review/scanning
   */
  async reopenStocktake(stocktakeId) {
    return this.withStocktakeLock(stocktakeId, async () => {
      const stocktake = await this.loadStocktake(stocktakeId);

      stocktake.status = 'in_progress';
      stocktake.countedData.completedAt = null;
      stocktake.countedData.completedBy = null;
      stocktake.reopenedAt = new Date().toISOString();

      await this.saveStocktake(stocktake);
      console.log(`↩️ Stocktake reopened: ${stocktakeId}`);
      return stocktake;
    });
  }

  /**
   * Refresh selected items' haloData in place — re-pull current quantities/serials
   * for just those items. countedData is preserved untouched. Items no longer in
   * Halo are marked consumed (expected=0) but retained so counted activity still
   * surfaces as a variance.
   */
  async refreshItemsFromHalo(stocktakeId, itemIds) {
    return this.withStocktakeLock(stocktakeId, async () => {
      const stocktake = await this.loadStocktake(stocktakeId);
      await this.haloAPI.authenticate();

    const updated = [];
    const consumed = [];
    for (const itemId of itemIds) {
      let freshItem = null;
      try {
        freshItem = await this.haloAPI.extractItemData(itemId);
      } catch (e) {
        console.warn(`refresh: item ${itemId} fetch failed: ${e.message}`);
      }

      const idx = stocktake.haloData.items.findIndex(i => i.id === itemId);
      if (freshItem) {
        if (idx >= 0) {
          const oldItem = stocktake.haloData.items[idx];
          this._reconcileCountedForItem(oldItem, freshItem, stocktake.countedData);
          stocktake.haloData.items[idx] = freshItem;
        } else {
          stocktake.haloData.items.push(freshItem);
        }
        updated.push(itemId);
      } else {
        // Item gone from Halo — zero out expected so counted activity shows as variance
        if (idx >= 0) {
          const existing = stocktake.haloData.items[idx];
          existing._consumed = true;
          existing.stockLocations = (existing.stockLocations || []).map(l => ({
            ...l,
            expectedQuantity: 0,
            reservedQuantity: 0,
            availableQuantity: 0,
            serialisedAssets: 0,
            serialNumbers: []
          }));
        }
        consumed.push(itemId);
      }
    }

      stocktake.haloData.extractedAt = new Date().toISOString();
      stocktake.lastRefreshedAt = stocktake.haloData.extractedAt;
      stocktake.summary = this.generateSummary(stocktake.haloData);

      await this.saveStocktake(stocktake);
      console.log(`🔄 Refreshed ${updated.length} item(s) from Halo (${consumed.length} consumed/removed): ${stocktakeId}`);
      return { stocktake, updated, consumed };
    });
  }

  /**
   * Reconcile countedData when an item's haloData changes shape (e.g. flips
   * non-serialised -> serialised). Preserves prior counted effort:
   *   - old non-serial with countedQuantity N + new serial expected K serials:
   *     mark min(N, K) of the new serials as found.
   *   - old serial with found serials: keep matches by asset id (no-op here;
   *     countedData entries already key by id and survive haloData replacement).
   *   - old serial with countedQuantity fallback: covered by the non-serial branch.
   */
  _reconcileCountedForItem(oldItem, newItem, countedData) {
    const cItem = countedData.items.find(i => i.id === newItem.id);
    if (!cItem) return;

    // Sync stockLocations: add new ones that appeared in Halo (e.g. stock moved to
    // a new location since last extraction). Without this, the scanned-items table
    // would reference a location that countedData has no row for and updates 404.
    if (Array.isArray(newItem.stockLocations)) {
      const existing = new Set((cItem.stockLocations || []).map(l => l.id));
      for (const newLoc of newItem.stockLocations) {
        if (!existing.has(newLoc.id)) {
          cItem.stockLocations = cItem.stockLocations || [];
          cItem.stockLocations.push({
            id: newLoc.id,
            name: newLoc.name,
            expectedQuantity: newLoc.expectedQuantity,
            countedQuantity: null,
            serialNumbers: (newLoc.serialNumbers || []).map(serial => ({
              id: serial.id,
              serialNumber: serial.serialNumber,
              cost: serial.cost || 0,
              expected: true,
              found: false,
              notes: ''
            })),
            additionalSerials: [],
            notes: ''
          });
        }
      }
    }

    for (const cLoc of (cItem.stockLocations || [])) {
      const newLoc = (newItem.stockLocations || []).find(l => l.id === cLoc.id);
      if (!newLoc) continue;

      // Prune expected serials no longer present in fresh Halo data.
      // User-added additionalSerials are preserved.
      if (newItem.isSerialised && Array.isArray(newLoc.serialNumbers) && Array.isArray(cLoc.serialNumbers)) {
        const newIds = new Set(newLoc.serialNumbers.map(s => s.id));
        cLoc.serialNumbers = cLoc.serialNumbers.filter(s =>
          !s.expected || newIds.has(s.id)
        );

        // Add expected serials that appeared in Halo since the last extraction,
        // so they show up as "not found" rows instead of a silent count mismatch.
        const existingIds = new Set(cLoc.serialNumbers.map(s => s.id));
        for (const s of newLoc.serialNumbers) {
          if (!existingIds.has(s.id)) {
            cLoc.serialNumbers.push({
              id: s.id,
              serialNumber: s.serialNumber,
              cost: s.cost || 0,
              expected: true,
              found: false,
              notes: 'auto-added by refresh'
            });
          }
        }
      }

      const wasNonSerialCounted = (oldItem && !oldItem.isSerialised)
        && cLoc.countedQuantity !== null && cLoc.countedQuantity !== undefined
        && cLoc.countedQuantity > 0;
      const nowSerial = newItem.isSerialised && (newLoc.serialNumbers || []).length > 0;

      if (wasNonSerialCounted && nowSerial) {
        const foundCount = Math.min(cLoc.countedQuantity, newLoc.serialNumbers.length);
        if (!cLoc.serialNumbers || cLoc.serialNumbers.length === 0) {
          cLoc.serialNumbers = newLoc.serialNumbers.slice(0, foundCount).map(s => ({
            id: s.id,
            serialNumber: s.serialNumber,
            cost: s.cost || 0,
            expected: true,
            found: true,
            notes: 'auto-reconciled from prior quantity count'
          }));
        }
      }
    }
  }

  /**
   * Complete stocktake and generate report
   */
  async completeStocktake(stocktakeId, completedBy = 'System') {
    return this.withStocktakeLock(stocktakeId, async () => {
      const stocktake = await this.loadStocktake(stocktakeId);

      stocktake.status = 'completed';
      stocktake.countedData.completedAt = new Date().toISOString();
      stocktake.countedData.completedBy = completedBy;
      stocktake.report = this.generateDifferentialReport(stocktake);

      await this.saveStocktake(stocktake);

      console.log(`✅ Stocktake completed: ${stocktakeId}`);
      return stocktake;
    });
  }

  /**
   * Delete stocktake
   */
  async deleteStocktake(stocktakeId) {
    this._assertValidId(stocktakeId);
    try {
      // Remove from index
      const index = await this.listStocktakes();
      const updatedIndex = index.filter(s => s.id !== stocktakeId);
      await this.updateIndexFile(updatedIndex);

      // Try to delete individual stocktake file if it exists
      const filePath = path.join(this.dataDir, `stocktake-${stocktakeId}.json`);
      try {
        await fs.unlink(filePath);
      } catch (fileError) {
        // File doesn't exist, which is fine - just continue with index deletion
        console.log(`Individual file for ${stocktakeId} doesn't exist, removing from index only`);
      }

      console.log(`🗑️ Stocktake deleted: ${stocktakeId}`);
      return true;
    } catch (error) {
      console.error(`❌ Failed to delete stocktake ${stocktakeId}:`, error.message);
      throw error;
    }
  }

  /**
   * Generate differential report
   */
  generateDifferentialReport(stocktake) {
    const report = {
      generatedAt: new Date().toISOString(),
      summary: {
        totalItemsChecked: 0,
        itemsWithVariance: 0,
        totalVariance: 0,
        serialisedVariance: 0,
        nonSerialisedVariance: 0,
        unexpectedItems: 0,
        totalCostImpact: 0,
        totalCountedValue: 0,
        totalExpectedValue: 0,
        totalVarianceValue: 0
      },
      countedItems: [],
      variances: [],
      missingSerials: [],
      unexpectedSerials: [],
      unexpectedItems: [], // Items scanned but not expected (0 expected quantity)
      locationSummaries: []
    };

    const locationVarianceMap = new Map();

    // Compare counted vs expected
    for (const countedItem of stocktake.countedData.items) {
      const haloItem = stocktake.haloData.items.find(i => i.id === countedItem.id);

      if (haloItem) {
        for (const countedLocation of countedItem.stockLocations) {
          const haloLocation = haloItem.stockLocations.find(l => l.id === countedLocation.id);

          // Handle items that were counted but have no corresponding expected data (scanned unexpected items)
          if (!haloLocation && (countedLocation.countedQuantity > 0 || countedLocation.serialNumbers?.some(s => s.found))) {
            report.summary.unexpectedItems++;
            report.summary.itemsWithVariance++;

            const counted = countedLocation.countedQuantity || 0;
            const foundSerials = countedLocation.serialNumbers?.filter(s => s.found).length || 0;

            report.unexpectedItems.push({
              itemName: haloItem.name,
              upc: haloItem.supplierPartCode || 'N/A',
              locationName: countedLocation.name,
              countedQuantity: counted,
              foundSerials: foundSerials,
              itemType: haloItem.isSerialised ? 'serialised' : 'non_serialised'
            });

            // Add to variance summary
            const variance = haloItem.isSerialised ? foundSerials : counted;
            report.summary.totalVariance += variance;

            if (haloItem.isSerialised) {
              report.summary.serialisedVariance += Math.abs(variance);
            } else {
              report.summary.nonSerialisedVariance += Math.abs(variance);
            }

            continue;
          }

          if (haloLocation) {
            report.summary.totalItemsChecked++;

            // Initialize location summary
            if (!locationVarianceMap.has(countedLocation.name)) {
              locationVarianceMap.set(countedLocation.name, {
                locationName: countedLocation.name,
                itemVariance: 0,
                missingSerials: 0,
                unexpectedSerials: 0
              });
            }

            const locationSummary = locationVarianceMap.get(countedLocation.name);

            if (haloItem.isSerialised) {
              // Handle serialised items
              const expectedSerials = haloLocation.serialNumbers.length;
              const foundSerials = countedLocation.serialNumbers.filter(s => s.found).length;
              const variance = foundSerials - expectedSerials;

              // Calculate financial impact using per-serial costs
              const missingCost = countedLocation.serialNumbers
                .filter(s => !s.found)
                .reduce((sum, s) => sum + (s.cost || haloItem.cost || 0), 0);

              const foundCost = countedLocation.serialNumbers
                .filter(s => s.found)
                .reduce((sum, s) => sum + (s.cost || haloItem.cost || 0), 0);
              const expectedCost = haloLocation.serialNumbers
                .reduce((sum, s) => sum + (s.cost || haloItem.cost || 0), 0);

              report.countedItems.push({
                itemType: 'serialised',
                itemId: haloItem.id,
                itemName: haloItem.name,
                sku: haloItem.supplierPartCode || '',
                locationName: countedLocation.name,
                cost: haloItem.cost || 0,
                price: haloItem.price || 0,
                expected: expectedSerials,
                counted: foundSerials,
                variance,
                valueCounted: foundCost,
                valueExpected: expectedCost,
                valueVariance: foundCost - expectedCost,
                reason: countedLocation.varianceReason || ''
              });
              report.summary.totalCountedValue += foundCost;
              report.summary.totalExpectedValue += expectedCost;
              report.summary.totalVarianceValue += (foundCost - expectedCost);

              if (variance !== 0) {
                report.summary.serialisedVariance += Math.abs(variance);
                report.summary.itemsWithVariance++;

                report.variances.push({
                  itemType: 'serialised',
                  itemName: haloItem.name,
                  itemId: haloItem.id,
                  locationId: countedLocation.id,
                  locationName: countedLocation.name,
                  expected: expectedSerials,
                  found: foundSerials,
                  variance: variance,
                  costImpact: missingCost,
                  reason: countedLocation.varianceReason || ''
                });

                locationSummary.itemVariance += Math.abs(variance);
              }

              // Track missing serials
              const missingSerials = countedLocation.serialNumbers.filter(s => !s.found);
              if (missingSerials.length > 0) {
                report.missingSerials.push({
                  itemName: haloItem.name,
                  locationName: countedLocation.name,
                  serialNumbers: missingSerials.map(s => s.serialNumber)
                });

                locationSummary.missingSerials += missingSerials.length;
              }

              // Track unexpected serials
              if (countedLocation.additionalSerials.length > 0) {
                report.unexpectedSerials.push({
                  itemName: haloItem.name,
                  locationName: countedLocation.name,
                  serialNumbers: countedLocation.additionalSerials.map(s => s.serialNumber)
                });

                locationSummary.unexpectedSerials += countedLocation.additionalSerials.length;
              }

              // Use variance from serialised calculation
              report.summary.totalVariance += Math.abs(variance);

            } else {
              // Handle non-serialised items
              const expected = haloLocation.expectedQuantity;
              const counted = countedLocation.countedQuantity || 0;
              const variance = counted - expected;
              const unitCost = haloItem.cost || 0;
              const unitPrice = haloItem.price || 0;

              report.countedItems.push({
                itemType: 'non_serialised',
                itemId: haloItem.id,
                itemName: haloItem.name,
                sku: haloItem.supplierPartCode || '',
                locationName: countedLocation.name,
                cost: unitCost,
                price: unitPrice,
                expected,
                counted,
                variance,
                valueCounted: counted * unitCost,
                valueExpected: expected * unitCost,
                valueVariance: (counted - expected) * unitCost,
                reason: countedLocation.varianceReason || ''
              });
              report.summary.totalCountedValue += counted * unitCost;
              report.summary.totalExpectedValue += expected * unitCost;
              report.summary.totalVarianceValue += (counted - expected) * unitCost;

              if (variance !== 0) {
                const costImpact = Math.abs(variance) * (haloItem.cost || 0);
                report.summary.nonSerialisedVariance += Math.abs(variance);
                report.summary.itemsWithVariance++;

                report.variances.push({
                  itemType: 'non_serialised',
                  itemName: haloItem.name,
                  itemId: haloItem.id,
                  locationId: countedLocation.id,
                  locationName: countedLocation.name,
                  expected: expected,
                  counted: counted,
                  variance: variance,
                  costImpact: costImpact,
                  reason: countedLocation.varianceReason || ''
                });

                locationSummary.itemVariance += Math.abs(variance);
              }

              // Use variance from non-serialised calculation
              report.summary.totalVariance += Math.abs(variance);
            }
          }
        }
      }
    }

    // Calculate total financial impact
    report.summary.totalCostImpact = report.variances.reduce((sum, v) => sum + (v.costImpact || 0), 0);

    // Convert location map to array
    report.locationSummaries = Array.from(locationVarianceMap.values());

    return report;
  }

  /**
   * Generate unique ID
   */
  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  /**
   * Initialize data directory
   */
  async initialize() {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      console.log('✅ Data directory initialized');
    } catch (error) {
      console.error('❌ Failed to initialize data directory:', error.message);
      throw error;
    }
  }
}

module.exports = StocktakeManager;