const axios = require('axios');
require('dotenv').config();

class HaloAPI {
  constructor() {
    this.baseURL = process.env.HALO_BASE_URL;
    this.tokenURL = process.env.HALO_TOKEN_URL;
    this.clientId = process.env.HALO_CLIENT_ID;
    this.clientSecret = process.env.HALO_CLIENT_SECRET;
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  /**
   * Apply new connection settings (e.g. from the Settings UI) without a process
   * restart. Forces re-authentication on the next API call.
   */
  configure({ baseURL, tokenURL, clientId, clientSecret } = {}) {
    if (baseURL !== undefined) this.baseURL = baseURL;
    if (tokenURL !== undefined) this.tokenURL = tokenURL;
    if (clientId !== undefined) this.clientId = clientId;
    if (clientSecret !== undefined) this.clientSecret = clientSecret;
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  /**
   * Authenticate with Halo API and get access token
   */
  async authenticate() {
    try {
      const response = await axios.post(this.tokenURL,
        new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret,
          scope: 'all'
        }),
        {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      this.accessToken = response.data.access_token;
      // Set expiry to 1 minute before actual expiry for safety
      this.tokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;

      console.log('✅ Authenticated with Halo API');
      return this.accessToken;
    } catch (error) {
      console.error('❌ Authentication failed:', error.message);
      throw new Error(`Halo API authentication failed: ${error.message}`);
    }
  }

  /**
   * Ensure we have a valid token
   */
  async ensureAuthenticated() {
    if (!this.accessToken || !this.tokenExpiry || Date.now() >= this.tokenExpiry) {
      await this.authenticate();
    }
    return this.accessToken;
  }

  /**
   * Make authenticated API call
   */
  async apiCall(method, endpoint, params = {}) {
    await this.ensureAuthenticated();

    try {
      const response = await axios({
        method,
        url: `${this.baseURL}${endpoint}`,
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Accept': 'application/json'
        },
        params
      });

      return response.data;
    } catch (error) {
      if (error.response?.status === 401) {
        // Token might be expired, try re-authenticating
        await this.authenticate();
        return this.apiCall(method, endpoint, params);
      }
      throw error;
    }
  }

  /**
   * Get all items with stock (including serialised items with 0 quantity)
   */
  async getItemsWithStock() {
    const allItems = [];
    let pageNo = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await this.apiCall('GET', '/api/Item', {
        show_not_in_stock: false,
        pageinate: true,
        page_no: pageNo,
        page_size: 100
      });

      if (response.items && response.items.length > 0) {
        // Include items that have stock OR serialised assets
        const itemsWithStockOrSerials = response.items.filter(item => {
          const hasStock = item.stocklocations && Array.isArray(item.stocklocations) &&
            item.stocklocations.some(loc => loc.item_quantity_in_stock > 0);
          const hasSerialisedAssets = item.stocklocations && Array.isArray(item.stocklocations) &&
            item.stocklocations.some(loc => loc.item_serialised_assets_in_stock > 0);
          return hasStock || hasSerialisedAssets;
        });

        allItems.push(...itemsWithStockOrSerials);

        // Check if there are more pages
        if (response.items.length < 100) {
          hasMore = false;
        } else {
          pageNo++;
        }
      } else {
        hasMore = false;
      }
    }

    return allItems;
  }

  /**
   * Get all items with UPC codes (including zero stock items)
   */
  async getAllItemsWithUPC() {
    const allItems = [];
    let pageNo = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await this.apiCall('GET', '/api/Item', {
        show_not_in_stock: true, // Include items not in stock
        pageinate: true,
        page_no: pageNo,
        page_size: 100
      });

      if (response.items && response.items.length > 0) {
        // Filter to only include items with UPC codes
        const itemsWithUPC = response.items.filter(item => item.supplier_part_code && item.supplier_part_code.trim() !== '');
        allItems.push(...itemsWithUPC);

        // Check if there are more pages
        if (response.items.length < 100) {
          hasMore = false;
        } else {
          pageNo++;
        }
      } else {
        hasMore = false;
      }
    }

    return allItems;
  }

  /**
   * Get detailed item information including stock locations
   */
  async getItemDetails(itemId) {
    return await this.apiCall('GET', `/api/Item/${itemId}`, {
      includedetails: true
    });
  }

  /**
   * Get assets for a specific item (serialised items)
   */
  async getAssetsForItem(itemId, siteId = null) {
    const params = {
      item_id: itemId,
      client_id: 12 // Elliotts Tech - internal stock
    };

    // Don't filter by status_id to get all assets (both in stock and deployed)
    if (siteId) {
      params.site_id = siteId;
    }

    console.log(`Fetching assets for item ${itemId}${siteId ? ` at site ${siteId}` : ''}`);
    const response = await this.apiCall('GET', '/api/Asset', params);
    console.log(`Found ${response.assets?.length || 0} assets for item ${itemId}`);
    return response;
  }

  /**
   * Get assets by item and location
   */
  async getAssetsByLocation(itemId, locationId) {
    return await this.getAssetsForItem(itemId, locationId);
  }

  /**
   * Get individual asset details (includes stockdetails.cost)
   */
  async getAssetDetails(assetId) {
    return await this.apiCall('GET', `/api/Asset/${assetId}`);
  }

  /**
   * Get a single Purchase Order with line items + received assets.
   * Returns mapped shape (see mapPurchaseOrder).
   */
  async getPurchaseOrder(poId) {
    const raw = await this.apiCall('GET', `/api/PurchaseOrder/${poId}`, {
      includedetails: true
    });

    const itemIds = [...new Set(
      (raw.lines || [])
        .map(l => l.item_id)
        .filter(id => id && id > 0)
    )];
    const itemLookup = {};
    for (const id of itemIds) {
      try {
        const r = await this.getItemDetails(id);
        const item = r.item || r;
        itemLookup[id] = {
          description: item.description || '',
          sellPrice: item.baseprice,
          upc: item.supplier_part_code || '',
          sku: item.qbosku || item.item_code || ''
        };
      } catch (err) {
        console.warn(`Failed to look up item ${id}: ${err.message}`);
        itemLookup[id] = { description: '', sellPrice: null, upc: '' };
      }
    }

    return this.mapPurchaseOrder(raw, itemLookup);
  }

  /**
   * Search Purchase Orders by ref (e.g. "P50128-1") or supplier name.
   */
  async searchPurchaseOrders(term) {
    const raw = await this.apiCall('GET', '/api/PurchaseOrder', {
      search: term,
      pageinate: false
    });
    const list = raw.purchaseorders || raw.items || [];
    return list.map(po => ({
      id: po.id,
      po_ref: po.po_ref,
      title: po.title,
      status: po.status,
      supplier_name: po.supplier_name,
      date: po.date
    }));
  }

  /**
   * List all products for the typeahead picker.
   * Returns [{id, name, stock, serialised}].
   */
  async listProducts() {
    const out = [];
    let pageNo = 1;
    while (true) {
      const r = await this.apiCall('GET', '/api/Item', {
        show_not_in_stock: true,
        pageinate: true,
        page_no: pageNo,
        page_size: 100,
        includedetails: true
      });
      const items = r.items || [];
      for (const it of items) {
        out.push({
          id: it.id,
          name: it.name,
          stock: Number(it.quantity_in_stock) || 0,
          serialised: !!(it.assettype_id && it.assettype_id > 0),
          sku: it.qbosku || ''
        });
      }
      if (items.length < 100) break;
      pageNo++;
    }
    return out;
  }

  /**
   * Get in-stock instances of an item for label generation.
   * Serialised items: one entry per in-stock asset (by inventory_number).
   * Non-serialised items: one entry representing current stock quantity.
   * Returns mapped shape with pre-expanded labels[], matching mapPurchaseOrder lines.
   */
  async getItemInstances(itemId) {
    const itemDetails = await this.getItemDetails(itemId);
    const item = itemDetails.item || itemDetails;
    const name = item.name || '';
    const description = item.description || '';
    const sellPrice = item.baseprice;
    const sku = item.qbosku || item.item_code || '';
    const upc = this.pickUPC(sku, item.supplier_part_code);

    const stocklocations = item.stocklocations || [];

    let assetsResp;
    try {
      assetsResp = await this.apiCall('GET', '/api/Asset', {
        item_id: itemId
      });
    } catch (e) { assetsResp = { assets: [] }; }
    const allAssets = (assetsResp.assets || assetsResp.items || [])
      .filter(a => a && a.id);
    const serialised = allAssets.length > 0;

    let labels = [];
    let instanceRows = [];

    if (serialised) {
      const inStock = allAssets.filter(a =>
        a.status_id === 0 && (!a.username) && (a.site_name || '').toLowerCase().includes('stock')
      );
      const ctx = { sku, supplierPartCode: item.supplier_part_code };
      const perAsset = inStock.map(a => this.pickAssetBarcode(a, ctx));
      instanceRows = perAsset.map(bc => ({
        inventory_number: bc.barcode_value,
        label: 'Asset ' + bc.barcode_value
      }));
      labels = perAsset.map(bc => ({ barcode_type: bc.barcode_type, barcode_value: bc.barcode_value }));
    } else {
      const qty = stocklocations.reduce(
        (sum, l) => sum + (Number(l.item_quantity_in_stock) || 0), 0
      );
      const qtyN = Math.floor(qty);
      const bc = this.pickNonSerialBarcode(itemId, sku, item.supplier_part_code);
      for (let i = 0; i < qtyN; i++) {
        labels.push({ ...bc });
      }
      instanceRows = qtyN > 0
        ? [{ inventory_number: bc.barcode_value, label: `${qtyN} in stock` }]
        : [];
    }

    return {
      item_id: itemId,
      name,
      description,
      sell_price: sellPrice,
      sku,
      upc,
      serialised,
      instances: instanceRows,
      labels
    };
  }

  /**
   * Find assets by inventory_number or serial fragment.
   * Only returns assets with an inventory_number AND linked item_id — Halo's
   * loose search often matches unrelated junk (PO lines, assets with no tag).
   */
  async findAsset(term) {
    const t = String(term || '').trim();
    if (!t) return [];
    const r = await this.apiCall('GET', '/api/Asset', {
      search: t,
      pageinate: false
    });
    const list = r.assets || r.items || [];
    const out = [];
    for (const a of list) {
      if (!a || !a.item_id) continue;
      const ident = (a.inventory_number || a.key_field || '').toString().trim();
      if (!ident) continue;
      out.push({
        asset_id: a.id,
        inventory_number: ident,
        item_id: a.item_id,
        item_name: a.item_name
      });
    }
    return out;
  }

  /**
   * Resolve a single asset to a label-ready item.
   */
  async assetToLabel(term) {
    const matches = await this.findAsset(term);
    if (matches.length === 0) return null;
    const a = matches[0];
    let name = a.item_name || '';
    let description = '';
    let sellPrice = null;
    let sku = '';
    let supplierPartCode = '';
    if (a.item_id) {
      try {
        const r = await this.getItemDetails(a.item_id);
        const item = r.item || r;
        name = item.name || name;
        description = item.description || '';
        sellPrice = item.baseprice;
        sku = item.qbosku || item.item_code || '';
        supplierPartCode = item.supplier_part_code || '';
      } catch (e) { /* ignore */ }
    }
    const bc = this.pickAssetBarcode(
      { id: a.asset_id, inventory_number: a.inventory_number },
      { sku, supplierPartCode }
    );
    return {
      item_id: a.item_id,
      asset_id: a.asset_id,
      name,
      description,
      sell_price: sellPrice,
      sku,
      instances: [{ inventory_number: bc.barcode_value, label: 'Asset ' + bc.barcode_value }],
      labels: [{ barcode_type: bc.barcode_type, barcode_value: bc.barcode_value }]
    };
  }

  /**
   * Pick the best UPC-like barcode source from item fields.
   * qbosku is the actual UPC/EAN in this Halo instance; supplier_part_code holds garbage.
   * Returns null if no valid 11-13 digit code.
   */
  pickUPC(...candidates) {
    for (const c of candidates) {
      const v = (c || '').toString().trim();
      if (v && /^\d{11,13}$/.test(v)) return v;
    }
    return null;
  }

  /**
   * Choose a barcode for a non-serialised item.
   * Priority: valid UPC/EAN (UPC-A symbology), then SKU (Code128), then item_id (Code128).
   */
  pickNonSerialBarcode(itemId, sku, supplierPartCode) {
    const upc = this.pickUPC(sku, supplierPartCode);
    if (upc) return { barcode_type: 'upca', barcode_value: upc };
    const skuStr = (sku || '').toString().trim();
    if (skuStr) return { barcode_type: 'code128', barcode_value: skuStr };
    return { barcode_type: 'code128', barcode_value: String(itemId) };
  }

  /**
   * Choose a barcode for a single asset instance.
   * Priority: inventory_number (Code128), then UPC/EAN (UPC-A), then 'A'+asset_id (Code128).
   * Handles Halo assets that exist but have no inventory_number assigned.
   */
  pickAssetBarcode(asset, ctx = {}) {
    const inv = (asset && (asset.inventory_number || asset.key_field) || '').toString().trim();
    if (inv) return { barcode_type: 'code128', barcode_value: inv };
    const upc = this.pickUPC(ctx.sku, ctx.supplierPartCode);
    if (upc) return { barcode_type: 'upca', barcode_value: upc };
    return { barcode_type: 'code128', barcode_value: 'A' + (asset && asset.id || 0) };
  }

  /**
   * Map raw PO JSON into label-friendly shape.
   * Lines carry pre-expanded `labels[]` so the frontend just sums lengths.
   */
  mapPurchaseOrder(raw, itemLookup) {
    const assetsByItem = {};
    for (const asset of (raw.so_assets || [])) {
      if (!asset || !asset.inventory_number) continue;
      if (!assetsByItem[asset.item_id]) assetsByItem[asset.item_id] = [];
      assetsByItem[asset.item_id].push(asset);
    }

    const lines = (raw.lines || [])
      .filter(l => !l.item_dont_receive_on_po)
      .map(l => {
        const item = itemLookup[l.item_id] || { description: '', sellPrice: null, upc: '', sku: '' };
        const upc = this.pickUPC(item.sku, item.upc, l.item_default_supplier_part_code);
        const assets = assetsByItem[l.item_id] || [];
        const qtyReceived = Math.floor(Number(l.quantity_received) || 0);

        let labels = [];
        if (assets.length > 0) {
          labels = assets.map(a => ({
            barcode_type: 'code128',
            barcode_value: a.inventory_number
          }));
        } else {
          const bc = this.pickNonSerialBarcode(l.item_id, item.sku, l.item_default_supplier_part_code);
          for (let i = 0; i < qtyReceived; i++) {
            labels.push({ ...bc });
          }
        }

        return {
          line_id: l.id,
          item_id: l.item_id,
          name: l.name,
          description: item.description,
          sell_price: item.sellPrice,
          sku: item.sku,
          qty_received: qtyReceived,
          qty_ordered: Math.floor(Number(l.quantity) || 0),
          upc,
          assets: assets.map(a => ({ id: a.id, inventory_number: a.inventory_number })),
          labels
        };
      });

    return {
      id: raw.id,
      po_ref: raw.po_ref,
      title: raw.title,
      status: raw.status,
      supplier_name: raw.supplier_name,
      date: raw.date,
      lines
    };
  }

  /**
   * Extract complete stocktake data
   */
  async extractStocktakeData() {
    console.log('📊 Extracting stocktake data from Halo...');

    // Get all items with stock
    const items = await this.getItemsWithStock();
    console.log(`Found ${items.length} items with stock`);

    // Get all items with UPC codes (including zero stock items)
    const itemsWithUPC = await this.getAllItemsWithUPC();
    console.log(`Found ${itemsWithUPC.length} items with UPC codes (including zero stock)`);

    // Create a set of item IDs that we already have from stock items
    const stockItemIds = new Set(items.map(item => item.id));

    // Add items with UPC but no stock
    const zeroStockItems = itemsWithUPC.filter(item => !stockItemIds.has(item.id));
    console.log(`Adding ${zeroStockItems.length} items with UPC but zero expected quantity`);

    const stocktakeData = {
      extractedAt: new Date().toISOString(),
      items: []
    };

    // Process items with stock
    for (const item of items) {
      console.log(`Processing item: ${item.name}`);

      // Get detailed information
      const itemDetails = await this.getItemDetails(item.id);

      // Check if any location has serialised assets
      const hasSerialisedAssets = itemDetails.stocklocations &&
        itemDetails.stocklocations.some(loc => loc.item_serialised_assets_in_stock > 0);

      const itemData = {
        id: item.id,
        name: item.name,
        description: item.description || '',
        assetGroupName: item.assetgroup_name || 'Unknown',
        isSerialised: hasSerialisedAssets,
        supplierPartCode: item.supplier_part_code || '',
        cost: item.costprice || 0,
        price: item.baseprice || 0,
        stockLocations: []
      };

      // Process each stock location
      if (itemDetails.stocklocations && itemDetails.stocklocations.length > 0) {
        for (const location of itemDetails.stocklocations) {
          // Include location if it has stock quantity OR serialised assets
          const hasStock = location.item_quantity_in_stock > 0;
          const hasSerialisedAssets = location.item_serialised_assets_in_stock > 0;

          if (hasStock || hasSerialisedAssets) {
            const locationData = {
              id: location.id,
              name: location.name,
              stockBinName: location.stockbin_name || location.name,
              expectedQuantity: location.item_quantity_in_stock,
              reservedQuantity: location.item_quantity_reserved,
              availableQuantity: location.item_quantity_available,
              serialisedAssets: location.item_serialised_assets_in_stock,
              serialNumbers: []
            };

            // Get serial numbers if this is a serialised item with serialised assets
            if (itemData.isSerialised && hasSerialisedAssets) {
              try {
                const assets = await this.getAssetsByLocation(item.id, location.id);

                if (assets.assets && assets.assets.length > 0) {
                  // Fetch per-asset cost from individual asset details (stockdetails.cost)
                  const serials = [];
                  for (const asset of assets.assets) {
                    let assetCost = 0;
                    try {
                      const detail = await this.getAssetDetails(asset.id);
                      assetCost = detail.stockdetails?.cost || 0;
                    } catch (e) {
                      // Cost unavailable, default to 0
                    }
                    serials.push({
                      id: asset.id,
                      serialNumber: asset.key_field || asset.inventory_number || `Unknown-${asset.id}`,
                      assetTag: asset.inventory_number || '',
                      status: asset.status_id === 0 ? 'in_stock' : 'deployed',
                      userName: asset.username || 'Unassigned',
                      cost: assetCost
                    });
                  }
                  locationData.serialNumbers = serials;
                }
              } catch (error) {
                console.warn(`Could not fetch assets for item ${item.id} at location ${location.id}:`, error.message);
              }
            }

            itemData.stockLocations.push(locationData);
          }
        }
      }

      this._stripJunkSerials(itemData);
      stocktakeData.items.push(itemData);
    }

    // Process items with UPC but zero stock
    for (const item of zeroStockItems) {
      console.log(`Adding zero-stock item with UPC: ${item.name} (${item.supplier_part_code})`);

      const itemData = {
        id: item.id,
        name: item.name,
        description: item.description || '',
        assetGroupName: item.assetgroup_name || 'Unknown',
        isSerialised: false,
        supplierPartCode: item.supplier_part_code || '',
        stockLocations: [
          {
            id: 'zero-stock',
            name: 'General Stock',
            stockBinName: 'General',
            expectedQuantity: 0,
            reservedQuantity: 0,
            availableQuantity: 0,
            serialisedAssets: 0,
            serialNumbers: []
          }
        ]
      };

      stocktakeData.items.push(itemData);
    }

    console.log(`✅ Extracted data for ${stocktakeData.items.length} items (including ${zeroStockItems.length} zero-stock UPC items)`);
    return stocktakeData;
  }

  /**
   * Extract a single item's current data (for refresh-from-Halo).
   * Returns the same item shape as extractStocktakeData, or null if the item
   * no longer exists in Halo.
   */
  async extractItemData(itemId) {
    const itemDetails = await this.getItemDetails(itemId);
    if (!itemDetails || !itemDetails.id) return null;

    const hasSerialisedAssets = itemDetails.stocklocations &&
      itemDetails.stocklocations.some(loc => loc.item_serialised_assets_in_stock > 0);

    const itemData = {
      id: itemDetails.id,
      name: itemDetails.name,
      description: itemDetails.description || '',
      assetGroupName: itemDetails.assetgroup_name || 'Unknown',
      isSerialised: hasSerialisedAssets,
      supplierPartCode: itemDetails.supplier_part_code || '',
      cost: itemDetails.costprice || 0,
      price: itemDetails.baseprice || 0,
      stockLocations: []
    };

    if (itemDetails.stocklocations && itemDetails.stocklocations.length > 0) {
      for (const location of itemDetails.stocklocations) {
        const hasStock = location.item_quantity_in_stock > 0;
        const hasSerialisedAssets = location.item_serialised_assets_in_stock > 0;
        if (!hasStock && !hasSerialisedAssets) continue;

        const locationData = {
          id: location.id,
          name: location.name,
          stockBinName: location.stockbin_name || location.name,
          expectedQuantity: location.item_quantity_in_stock,
          reservedQuantity: location.item_quantity_reserved,
          availableQuantity: location.item_quantity_available,
          serialisedAssets: location.item_serialised_assets_in_stock,
          serialNumbers: []
        };

        if (itemData.isSerialised && hasSerialisedAssets) {
          try {
            const assets = await this.getAssetsByLocation(itemData.id, location.id);
            if (assets.assets && assets.assets.length > 0) {
              const serials = [];
              for (const asset of assets.assets) {
                let assetCost = 0;
                try {
                  const detail = await this.getAssetDetails(asset.id);
                  assetCost = detail.stockdetails?.cost || 0;
                } catch (e) { /* noop */ }
                serials.push({
                  id: asset.id,
                  serialNumber: asset.key_field || asset.inventory_number || `Unknown-${asset.id}`,
                  assetTag: asset.inventory_number || '',
                  status: asset.status_id === 0 ? 'in_stock' : 'deployed',
                  userName: asset.username || 'Unassigned',
                  cost: assetCost
                });
              }
              locationData.serialNumbers = serials;
            }
          } catch (error) {
            console.warn(`Could not fetch assets for item ${itemData.id} at location ${location.id}:`, error.message);
          }
        }

        itemData.stockLocations.push(locationData);
      }
    }

    this._stripJunkSerials(itemData);
    return itemData;
  }

  /**
   * If every serial on every location is a placeholder (Unknown-XXX, the
   * fallback we synthesise when assets have no key_field/inventory_number),
   * treat the item as non-serialised. Agreed during stocktake-import design:
   * "Unknown-only" means Halo is using assets purely as quantity tracking.
   */
  _stripJunkSerials(itemData) {
    if (!itemData || !Array.isArray(itemData.stockLocations)) return;
    const junkRe = /^Unknown/i;
    let totalReal = 0;
    for (const loc of itemData.stockLocations) {
      if (!Array.isArray(loc.serialNumbers) || loc.serialNumbers.length === 0) continue;
      const real = loc.serialNumbers.filter(s => s.serialNumber && !junkRe.test(String(s.serialNumber)));
      if (real.length === 0) {
        loc.serialNumbers = [];
        loc.serialisedAssets = 0;
      } else {
        totalReal += real.length;
        loc.serialNumbers = real;
      }
    }
    if (totalReal === 0) itemData.isSerialised = false;
  }
}

module.exports = HaloAPI;