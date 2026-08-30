"use strict";
const { rateLimitedFetch } = require("./rateLimiter.js");

/**
 * Alpaca REST market-data client (historical bars). Auth via headers, never query params,
 * so credentials never end up in logs/URLs. Base: https://data.alpaca.markets
 */
class AlpacaRestClient {
  constructor({ keyId, secretKey, baseUrl = "https://data.alpaca.markets" }) {
    this.keyId = keyId;
    this.secretKey = secretKey;
    this.baseUrl = baseUrl;
  }

  _headers() {
    return {
      "APCA-API-KEY-ID": this.keyId,
      "APCA-API-SECRET-KEY": this.secretKey,
    };
  }

  async _get(path, params) {
    if (!this.keyId || !this.secretKey) {
      throw new Error("Alpaca API credentials are not configured (APCA_API_KEY_ID / APCA_API_SECRET_KEY).");
    }
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
    let res;
    try {
      res = await rateLimitedFetch(url.toString(), { headers: this._headers() });
    } catch (e) {
      throw new Error(`Could not reach Alpaca (network error): ${e.message}`);
    }
    if (!res.ok) {
      let detail = "";
      try { detail = JSON.stringify(await res.json()); } catch (e) { /* ignore */ }
      throw new Error(`Alpaca REST error (${res.status}): ${detail || res.statusText}`);
    }
    return res.json();
  }

  /**
   * getHistoricalBars({symbol, assetType, timeframe, start, end, limit})
   * timeframe: Alpaca format, e.g. '1Min', '5Min', '15Min', '1Hour', '1Day'
   * Returns normalized bars: [{ type:'bar', symbol, assetType, open, high, low, close,
   *   volume, timestamp, timeframe, source:'alpaca', feed }]
   */
  async getHistoricalBars({ symbol, assetType, timeframe = "1Day", start, end, limit = 300, feed = "iex" }) {
    // Alpaca's bars endpoint can return an empty result when no start is given and "now"
    // falls on a non-trading window (e.g. a weekend, or after-hours before any bar has
    // formed) - it does not automatically walk backward to find the most recent real
    // trading data. Always supply an explicit, generous start so real bars are found
    // regardless of what day/time it currently is. This does not risk returning MORE
    // than asked for - Alpaca still respects `limit` as a hard cap.
    const effectiveStart = start || this._computeDefaultStart(timeframe, limit, assetType);
    if (assetType === "crypto") {
      const data = await this._get("/v1beta3/crypto/us/bars", { symbols: symbol, timeframe, start: effectiveStart, end, limit });
      const raw = (data.bars && data.bars[symbol]) || [];
      return raw.map((b) => this._normalizeBar(b, symbol, assetType, timeframe, "us"));
    }
    const data = await this._get(`/v2/stocks/${encodeURIComponent(symbol)}/bars`, { timeframe, start: effectiveStart, end, limit, feed, adjustment: "raw" });
    const raw = data.bars || [];
    return raw.map((b) => this._normalizeBar(b, symbol, assetType, timeframe, feed));
  }

  /**
   * Generous, deliberately-padded lookback window so `limit` real bars are always
   * findable even across weekends/holidays. Crypto trades 24/7 so needs no weekend
   * padding; stocks get roughly 40% extra calendar days plus a flat 10-day margin for
   * holidays and thin trading days.
   */
  _computeDefaultStart(timeframe, limit, assetType) {
    const barsPerTradingDay = { "1Min": 390, "5Min": 78, "15Min": 26, "1Hour": 7, "1Day": 1 };
    const perDay = barsPerTradingDay[timeframe] || 1;
    const tradingPeriodsNeeded = Math.ceil(limit / perDay);
    const calendarDaysBack = assetType === "crypto"
      ? tradingPeriodsNeeded + 2
      : Math.ceil(tradingPeriodsNeeded * 1.4) + 10;
    return new Date(Date.now() - calendarDaysBack * 24 * 60 * 60 * 1000).toISOString();
  }

  async getLatestSnapshot({ symbol, assetType, feed = "iex" }) {
    if (assetType === "crypto") {
      const [tradeData, quoteData] = await Promise.all([
        this._get("/v1beta3/crypto/us/latest/trades", { symbols: symbol }),
        this._get("/v1beta3/crypto/us/latest/quotes", { symbols: symbol }),
      ]);
      const trade = tradeData.trades && tradeData.trades[symbol];
      const quote = quoteData.quotes && quoteData.quotes[symbol];
      return {
        symbol, assetType,
        latestTrade: trade ? { price: trade.p, size: trade.s, timestamp: trade.t } : null,
        latestQuote: quote ? { bidPrice: quote.bp, bidSize: quote.bs, askPrice: quote.ap, askSize: quote.as, timestamp: quote.t } : null,
        source: "alpaca", feed: "us",
      };
    }
    const [tradeData, quoteData] = await Promise.all([
      this._get(`/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`, { feed }),
      this._get(`/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`, { feed }),
    ]);
    const trade = tradeData.trade;
    const quote = quoteData.quote;
    return {
      symbol, assetType,
      latestTrade: trade ? { price: trade.p, size: trade.s, timestamp: trade.t } : null,
      latestQuote: quote ? { bidPrice: quote.bp, bidSize: quote.bs, askPrice: quote.ap, askSize: quote.as, timestamp: quote.t } : null,
      source: "alpaca", feed,
    };
  }

  _normalizeBar(b, symbol, assetType, timeframe, feed) {
    return {
      type: "bar", symbol, assetType,
      open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
      timestamp: b.t, timeframe, source: "alpaca", feed,
    };
  }
}

module.exports = { AlpacaRestClient };
