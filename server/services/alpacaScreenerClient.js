"use strict";
const { rateLimitedFetch } = require("./rateLimiter.js");

/**
 * Alpaca Screener API - real, live "most active" and "top movers" data, computed by
 * Alpaca itself from real trading activity. Same data.alpaca.markets base and auth as
 * the other market-data clients.
 *
 * Honest note: Alpaca's docs confirm the top-level response shape (gainers/losers/
 * market_type for movers; a ranked list for most-actives) and confirm `symbol` as the
 * ticker field (consistent with every other Alpaca endpoint already verified in this
 * app), but the exact field name for volume/change wasn't visible in the fetched docs
 * page. Normalization below checks multiple plausible field names defensively rather
 * than assume one - if Alpaca's real field name differs from all of these, that one
 * derived field will just be null rather than the whole feature breaking.
 */
class AlpacaScreenerClient {
  constructor({ keyId, secretKey, baseUrl = "https://data.alpaca.markets" }) {
    this.keyId = keyId;
    this.secretKey = secretKey;
    this.baseUrl = baseUrl;
  }

  _headers() {
    return { "APCA-API-KEY-ID": this.keyId, "APCA-API-SECRET-KEY": this.secretKey };
  }

  async _get(path, params) {
    if (!this.keyId || !this.secretKey) {
      throw new Error("Alpaca API credentials are not configured (APCA_API_KEY_ID / APCA_API_SECRET_KEY).");
    }
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    let res;
    try {
      res = await rateLimitedFetch(url.toString(), { headers: this._headers() });
    } catch (e) {
      throw new Error(`Could not reach Alpaca screener API (network error): ${e.message}`);
    }
    if (!res.ok) {
      let detail = "";
      try { detail = JSON.stringify(await res.json()); } catch (e) { /* ignore */ }
      throw new Error(`Alpaca screener API error (${res.status}): ${detail || res.statusText}`);
    }
    return res.json();
  }

  _pickField(obj, candidates) {
    for (const key of candidates) if (obj[key] !== undefined) return obj[key];
    return null;
  }

  /** Top N most actively-traded stocks right now (by real volume, computed by Alpaca). */
  async getMostActive(top = 30) {
    const data = await this._get("/v1beta1/screener/stocks/most-actives", { by: "volume", top });
    const list = data.most_actives || data.mostActives || data.most_actives_list || [];
    return list.map((item) => ({
      symbol: item.symbol,
      volume: this._pickField(item, ["volume", "trade_count", "volume_total"]),
    })).filter((s) => s.symbol);
  }

  /** Top gainers for stocks (real, from Alpaca's screener - not derived by scanning ourselves). */
  async getTopGainers(top = 20) {
    const data = await this._get("/v1beta1/screener/stocks/movers", { top });
    const gainers = data.gainers || [];
    return gainers.map((item) => ({
      symbol: item.symbol,
      percentChange: this._pickField(item, ["percent_change", "percentChange", "change_percent"]),
    })).filter((s) => s.symbol);
  }
}

module.exports = { AlpacaScreenerClient };
