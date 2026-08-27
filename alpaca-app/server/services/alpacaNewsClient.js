"use strict";
const { rateLimitedFetch } = require("./rateLimiter.js");

/**
 * Alpaca News API client. Reuses the same APCA_API_KEY_ID/APCA_API_SECRET_KEY already
 * used for market data - Alpaca's news endpoint lives under the same data API and the
 * same auth headers, so this needs no new credentials or environment variables.
 * Docs: GET https://data.alpaca.markets/v1beta1/news
 */
class AlpacaNewsClient {
  constructor({ keyId, secretKey, baseUrl = "https://data.alpaca.markets" }) {
    this.keyId = keyId;
    this.secretKey = secretKey;
    this.baseUrl = baseUrl;
  }

  _headers() {
    return { "APCA-API-KEY-ID": this.keyId, "APCA-API-SECRET-KEY": this.secretKey };
  }

  /**
   * getNews({symbols, limit}) - symbols: array of stock tickers (Alpaca's news endpoint
   * covers equities; it does not carry crypto-specific news). Returns normalized articles:
   * [{ headline, publisher, publishedAt, url, summary, relatedSymbols }]
   * Never fabricates an article - if the request fails or returns nothing, callers get an
   * empty array or a thrown error, never placeholder content.
   */
  async getNews({ symbols = [], limit = 10 } = {}) {
    if (!this.keyId || !this.secretKey) {
      throw new Error("Alpaca API credentials are not configured (APCA_API_KEY_ID / APCA_API_SECRET_KEY).");
    }
    const url = new URL(`${this.baseUrl}/v1beta1/news`);
    if (symbols.length) url.searchParams.set("symbols", symbols.join(","));
    url.searchParams.set("limit", String(Math.min(limit, 50)));
    url.searchParams.set("sort", "desc");

    let res;
    try {
      res = await rateLimitedFetch(url.toString(), { headers: this._headers() });
    } catch (e) {
      throw new Error(`Could not reach Alpaca news (network error): ${e.message}`);
    }
    if (!res.ok) {
      let detail = "";
      try { detail = JSON.stringify(await res.json()); } catch (e) { /* ignore */ }
      throw new Error(`Alpaca news API error (${res.status}): ${detail || res.statusText}`);
    }
    const data = await res.json();
    const rawArticles = data.news || [];
    return rawArticles.map((a) => this._normalize(a));
  }

  _normalize(a) {
    return {
      headline: a.headline,
      publisher: a.source,
      publishedAt: a.created_at,
      url: a.url,
      summary: a.summary || null,
      relatedSymbols: a.symbols || [],
    };
  }
}

module.exports = { AlpacaNewsClient };
