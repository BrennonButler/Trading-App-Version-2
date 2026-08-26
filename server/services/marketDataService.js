"use strict";
const EventEmitter = require("events");
const { AlpacaFeedClient } = require("./alpacaFeedClient.js");

const STOCK_WS_URLS = {
  iex: "wss://stream.data.alpaca.markets/v2/iex",
  sip: "wss://stream.data.alpaca.markets/v2/sip",
  delayed_sip: "wss://stream.data.alpaca.markets/v2/delayed_sip",
};
const CRYPTO_WS_URL = "wss://stream.data.alpaca.markets/v1beta3/crypto/us";

// Freshness thresholds per message type, matching the spec's requirement that these be
// configurable and appropriate to the message type (a trade going stale after 5s makes
// sense; a bar is naturally "older" the moment it closes, so bars get more slack).
const FRESHNESS_THRESHOLDS_MS = {
  trade: { live: 5000, recent: 30000 },
  quote: { live: 5000, recent: 30000 },
  bar: { live: 90000, recent: 300000 },
};

function classifyFreshness(type, ageMs) {
  const t = FRESHNESS_THRESHOLDS_MS[type] || FRESHNESS_THRESHOLDS_MS.trade;
  if (ageMs < t.live) return "live";
  if (ageMs < t.recent) return "recent";
  return "stale";
}

/**
 * Validates a stock symbol: letters + optional ".X" suffix (e.g. AAPL, BRK.B), 1-6 chars.
 * Validates a crypto symbol: BASE/QUOTE format. Intentionally conservative - reject first;
 * the real Alpaca call is the actual source of truth for whether a symbol truly exists.
 */
function isValidSymbol(symbol, assetType) {
  if (typeof symbol !== "string" || symbol.length === 0 || symbol.length > 20) return false;
  if (assetType === "crypto") return /^[A-Z0-9]{2,10}\/[A-Z0-9]{2,10}$/.test(symbol);
  return /^[A-Z]{1,6}(\.[A-Z])?$/.test(symbol);
}

class MarketDataService extends EventEmitter {
  constructor({ keyId, secretKey, stockFeed = "iex", maxSubscriptionsPerClient = 30, stockWsUrls = STOCK_WS_URLS, cryptoWsUrl = CRYPTO_WS_URL }) {
    super();
    this.keyId = keyId;
    this.secretKey = secretKey;
    this.stockFeed = stockFeed;
    this.maxSubscriptionsPerClient = maxSubscriptionsPerClient;
    this.stockWsUrls = stockWsUrls;
    this.cryptoWsUrl = cryptoWsUrl;

    this.snapshots = new Map(); // "stock:AAPL" -> { latestTrade, latestQuote, latestBar, ... }
    this.clientSubscriptions = new Map(); // clientId -> Set of "assetType:symbol"
    this.symbolRefCounts = new Map(); // "assetType:symbol" -> number of clients subscribed

    this.stockClient = null;
    this.cryptoClient = null;
    this.configErrors = [];
  }

  start() {
    if (!this.keyId || !this.secretKey) {
      const msg = "Alpaca credentials missing (APCA_API_KEY_ID / APCA_API_SECRET_KEY). Market data will not connect until these are set.";
      this.configErrors.push(msg);
      this.emit("status", msg);
      return;
    }
    const stockUrl = this.stockWsUrls[this.stockFeed];
    if (!stockUrl) {
      const msg = `Invalid ALPACA_STOCK_FEED "${this.stockFeed}" - must be one of: ${Object.keys(this.stockWsUrls).join(", ")}`;
      this.configErrors.push(msg);
      this.emit("status", msg);
      return;
    }

    this.stockClient = new AlpacaFeedClient({ url: stockUrl, keyId: this.keyId, secretKey: this.secretKey, assetType: "stock", feed: this.stockFeed });
    this.cryptoClient = new AlpacaFeedClient({ url: this.cryptoWsUrl, keyId: this.keyId, secretKey: this.secretKey, assetType: "crypto", feed: "us" });

    for (const client of [this.stockClient, this.cryptoClient]) {
      client.on("data", (msg) => this._handleData(msg));
      client.on("error", (err) => {
        this.emit("dataError", { assetType: client.assetType, ...err });
        if (err.fatal) this.configErrors.push(`${client.assetType} feed: ${err.message}`);
      });
      client.on("status", (s) => this.emit("status", `[${client.assetType}] ${s}`));
      client.start();
    }
  }

  stop() {
    if (this.stockClient) this.stockClient.stop();
    if (this.cryptoClient) this.cryptoClient.stop();
  }

  _handleData(msg) {
    const key = `${msg.assetType}:${msg.symbol}`;
    const existing = this.snapshots.get(key) || { symbol: msg.symbol, assetType: msg.assetType };
    if (msg.type === "trade") existing.latestTrade = msg;
    else if (msg.type === "quote") existing.latestQuote = msg;
    else if (msg.type === "bar") existing.latestBar = msg;
    existing.source = msg.source;
    existing.feed = msg.feed;
    existing.lastUpdated = Date.now();
    this.snapshots.set(key, existing);
    this.emit("data", msg); // for fan-out to subscribed browser clients
  }

  // ---------- Subscription management (one shared connection, many clients) ----------

  subscribeClient(clientId, symbol, assetType) {
    if (!isValidSymbol(symbol, assetType)) {
      return { ok: false, error: `"${symbol}" doesn't look like a valid ${assetType} symbol.` };
    }
    let clientSet = this.clientSubscriptions.get(clientId);
    if (!clientSet) { clientSet = new Set(); this.clientSubscriptions.set(clientId, clientSet); }
    const key = `${assetType}:${symbol}`;
    if (clientSet.size >= this.maxSubscriptionsPerClient && !clientSet.has(key)) {
      return { ok: false, error: `Max ${this.maxSubscriptionsPerClient} symbols per session reached.` };
    }

    const alreadySubscribedByThisClient = clientSet.has(key);
    clientSet.add(key);

    const prevCount = this.symbolRefCounts.get(key) || 0;
    if (!alreadySubscribedByThisClient) this.symbolRefCounts.set(key, prevCount + 1);

    // Only actually subscribe to Alpaca if this is the FIRST client wanting this symbol -
    // this is the "one connection, fan-out to many clients" requirement in practice.
    if (prevCount === 0 && !alreadySubscribedByThisClient) {
      const client = assetType === "crypto" ? this.cryptoClient : this.stockClient;
      if (client) client.subscribe({ trades: [symbol], quotes: [symbol], bars: [symbol] });
    }
    return { ok: true };
  }

  unsubscribeClient(clientId, symbol, assetType) {
    const key = `${assetType}:${symbol}`;
    const clientSet = this.clientSubscriptions.get(clientId);
    if (!clientSet || !clientSet.has(key)) return;
    clientSet.delete(key);

    const count = (this.symbolRefCounts.get(key) || 1) - 1;
    if (count <= 0) {
      this.symbolRefCounts.delete(key);
      const client = assetType === "crypto" ? this.cryptoClient : this.stockClient;
      if (client) client.unsubscribe({ trades: [symbol], quotes: [symbol], bars: [symbol] });
    } else {
      this.symbolRefCounts.set(key, count);
    }
  }

  disconnectClient(clientId) {
    const clientSet = this.clientSubscriptions.get(clientId);
    if (!clientSet) return;
    for (const key of [...clientSet]) {
      const slashIdx = key.indexOf(":");
      const assetType = key.slice(0, slashIdx);
      const symbol = key.slice(slashIdx + 1);
      this.unsubscribeClient(clientId, symbol, assetType);
    }
    this.clientSubscriptions.delete(clientId);
  }

  // ---------- Snapshot / freshness ----------

  getMarketSnapshot(symbol, assetType) {
    const key = `${assetType}:${symbol}`;
    const snap = this.snapshots.get(key);
    if (!snap) {
      return { symbol, assetType, latestTrade: null, latestQuote: null, latestBar: null, freshness: "disconnected", timestamp: null };
    }
    const ageMs = Date.now() - snap.lastUpdated;
    const msgType = snap.latestTrade ? "trade" : snap.latestQuote ? "quote" : "bar";
    return {
      symbol, assetType,
      latestTrade: snap.latestTrade || null,
      latestQuote: snap.latestQuote || null,
      latestBar: snap.latestBar || null,
      source: snap.source, feed: snap.feed,
      timestamp: new Date(snap.lastUpdated).toISOString(),
      freshness: classifyFreshness(msgType, ageMs),
    };
  }

  getConnectionStatus() {
    return {
      stock: this.stockClient ? { authenticated: this.stockClient.authenticated, feed: this.stockFeed } : null,
      crypto: this.cryptoClient ? { authenticated: this.cryptoClient.authenticated, feed: "us" } : null,
      configErrors: this.configErrors,
    };
  }
}

module.exports = { MarketDataService, isValidSymbol, classifyFreshness, STOCK_WS_URLS, CRYPTO_WS_URL };
