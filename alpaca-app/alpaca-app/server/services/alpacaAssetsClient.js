"use strict";
const { rateLimitedFetch } = require("./rateLimiter.js");

/**
 * Alpaca Assets API client - the full list of tradable US assets (thousands of stocks/ETFs),
 * used to power real autocomplete/validation instead of guessing from a hardcoded subset.
 *
 * IMPORTANT: this lives on Alpaca's TRADING API (api.alpaca.markets), NOT the Market Data
 * API (data.alpaca.markets) that alpacaRestClient/alpacaFeedClient/alpacaNewsClient use -
 * same credentials, different base URL. This is reference data (what's listed/tradable),
 * not live pricing, which is why it's a separate client rather than bolted onto those.
 */
class AlpacaAssetsClient {
  constructor({ keyId, secretKey, baseUrl = "https://api.alpaca.markets" }) {
    this.keyId = keyId;
    this.secretKey = secretKey;
    this.baseUrl = baseUrl;
    this._cache = null; // { assets: [...], fetchedAt: timestamp }
    this._cacheTtlMs = 60 * 60 * 1000; // asset listings change rarely - re-fetch at most hourly
  }

  _headers() {
    return { "APCA-API-KEY-ID": this.keyId, "APCA-API-SECRET-KEY": this.secretKey };
  }

  /** Fetches (and caches) the full list of active, tradable US equities/ETFs. */
  async getAllAssets({ forceRefresh = false } = {}) {
    if (!this.keyId || !this.secretKey) {
      throw new Error("Alpaca API credentials are not configured (APCA_API_KEY_ID / APCA_API_SECRET_KEY).");
    }
    const isFresh = this._cache && (Date.now() - this._cache.fetchedAt) < this._cacheTtlMs;
    if (isFresh && !forceRefresh) return this._cache.assets;

    const url = new URL(`${this.baseUrl}/v2/assets`);
    url.searchParams.set("status", "active");
    url.searchParams.set("asset_class", "us_equity");

    let res;
    try {
      res = await rateLimitedFetch(url.toString(), { headers: this._headers() });
    } catch (e) {
      throw new Error(`Could not reach Alpaca assets API (network error): ${e.message}`);
    }
    if (!res.ok) {
      let detail = "";
      try { detail = JSON.stringify(await res.json()); } catch (e) { /* ignore */ }
      throw new Error(`Alpaca assets API error (${res.status}): ${detail || res.statusText}`);
    }
    const raw = await res.json();
    const assets = raw
      .filter((a) => a.tradable)
      .map((a) => ({ symbol: a.symbol, name: a.name, exchange: a.exchange, assetType: "stock" }));

    this._cache = { assets, fetchedAt: Date.now() };
    return assets;
  }

  /**
   * Case-insensitive search, ranked: exact symbol match first, then symbol-prefix matches,
   * then name-substring matches. Typing the exact ticker "AA" should surface Alcoa first,
   * not just whichever AA-prefixed company happened to come first in Alpaca's raw list.
   */
  async search(query, limit = 8) {
    if (!query || query.length < 1) return [];
    const assets = await this.getAllAssets();
    const q = query.toUpperCase();

    const exact = assets.filter((a) => a.symbol === q);
    const prefix = assets.filter((a) => a.symbol !== q && a.symbol.startsWith(q));
    const nameMatch = assets.filter((a) => !a.symbol.startsWith(q) && a.name.toUpperCase().includes(q));

    return [...exact, ...prefix, ...nameMatch].slice(0, limit);
  }
}

module.exports = { AlpacaAssetsClient };
