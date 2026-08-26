"use strict";
const WebSocket = require("ws");
const EventEmitter = require("events");

/**
 * Low-level client for ONE Alpaca market-data WebSocket feed (stocks OR crypto).
 * Handles: connect, auth, subscribe/unsubscribe, reconnect with bounded exponential
 * backoff + jitter, and normalizes raw Alpaca messages into our provider-independent
 * data model. Emits events; never talks to the frontend directly (that's marketDataService).
 *
 * Emits:
 *   'authenticated'                - after successful auth
 *   'data', normalizedMessage      - one normalized trade/quote/bar
 *   'error', { fatal, message }    - fatal=true means "stop retrying, config problem"
 *   'status', string                - connection lifecycle string, for logging/UI
 */
class AlpacaFeedClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.url - WebSocket URL for this feed
   * @param {string} opts.keyId
   * @param {string} opts.secretKey
   * @param {string} opts.assetType - 'stock' | 'crypto'
   * @param {string} opts.feed - label for the normalized output, e.g. 'iex', 'sip', 'us'
   */
  constructor(opts) {
    super();
    this.url = opts.url;
    this.keyId = opts.keyId;
    this.secretKey = opts.secretKey;
    this.assetType = opts.assetType;
    this.feed = opts.feed;

    this.ws = null;
    this.authenticated = false;
    this.subscriptions = { trades: new Set(), quotes: new Set(), bars: new Set() };
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 12;
    this.stopped = false;
    this.fatalErrorSeen = false;
    this._reconnectTimer = null;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this.ws) {
      try { this.ws.close(); } catch (e) { /* ignore */ }
    }
  }

  _connect() {
    if (this.stopped || this.fatalErrorSeen) return;
    this.emit("status", `connecting to ${this.url}`);

    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this._scheduleReconnect(`failed to open socket: ${e.message}`);
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.emit("status", "socket open, waiting for connect ack");
    });

    ws.on("message", (raw) => this._handleRawMessage(raw));

    ws.on("close", (code, reason) => {
      this.authenticated = false;
      this.emit("status", `closed (${code}) ${reason || ""}`);
      if (!this.stopped && !this.fatalErrorSeen) this._scheduleReconnect(`socket closed (${code})`);
    });

    ws.on("error", (err) => {
      // 'error' is often followed by 'close'; let close() drive reconnect to avoid double-scheduling.
      this.emit("status", `socket error: ${err.message}`);
    });
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  _authenticate() {
    if (!this.keyId || !this.secretKey) {
      this.fatalErrorSeen = true;
      this.emit("error", { fatal: true, message: "Missing APCA_API_KEY_ID or APCA_API_SECRET_KEY - cannot authenticate." });
      this.stop();
      return;
    }
    this._send({ action: "auth", key: this.keyId, secret: this.secretKey });
  }

  _handleRawMessage(raw) {
    let messages;
    try {
      messages = JSON.parse(raw.toString());
    } catch (e) {
      this.emit("status", `received unparseable message, ignoring: ${e.message}`);
      return;
    }
    // Alpaca always sends an array of message objects, even for a single event.
    if (!Array.isArray(messages)) messages = [messages];

    for (const msg of messages) {
      this._handleOneMessage(msg);
    }
  }

  _handleOneMessage(msg) {
    if (!msg || typeof msg !== "object" || !msg.T) return;

    switch (msg.T) {
      case "success":
        if (msg.msg === "connected") {
          this.emit("status", "connected, authenticating");
          this._authenticate();
        } else if (msg.msg === "authenticated") {
          this.authenticated = true;
          this.reconnectAttempts = 0;
          this.emit("status", "authenticated");
          this.emit("authenticated");
          this._resubscribeAll();
        }
        return;

      case "error":
        this._handleErrorMessage(msg);
        return;

      case "subscription":
        this.emit("status", `subscription confirmed: ${JSON.stringify(msg)}`);
        return;

      case "t": // trade
        this.emit("data", this._normalizeTrade(msg));
        return;
      case "q": // quote
        this.emit("data", this._normalizeQuote(msg));
        return;
      case "b": // minute bar
      case "d": // daily bar
        this.emit("data", this._normalizeBar(msg, msg.T === "d" ? "1Day" : "1Min"));
        return;

      default:
        // Unknown/irrelevant message type (e.g. 'c' correction, 'x' cancel/luld) - ignore rather
        // than crash, per "handle malformed provider message" requirement.
        return;
    }
  }

  _handleErrorMessage(msg) {
    const code = msg.code;
    const text = msg.msg || "unknown error";
    // Alpaca documented codes: 401/402 auth issues, 403 forbidden feed, 409 already
    // authenticated / connection limit exceeded, 405 invalid message format.
    const fatalCodes = new Set([401, 402, 403, 405]);
    if (fatalCodes.has(code)) {
      this.fatalErrorSeen = true;
      this.emit("error", { fatal: true, message: `Alpaca rejected the connection (code ${code}): ${text}. Check APCA_API_KEY_ID/APCA_API_SECRET_KEY and that your account has access to this feed.` });
      this.stop();
      return;
    }
    if (code === 409) {
      // Connection limit exceeded: another connection to this feed is already open for this
      // key. This should not normally happen since we hold exactly one connection per feed,
      // but if it does, back off harder rather than hammering the limit.
      this.emit("error", { fatal: false, message: `Alpaca reports another connection is already open for this feed (code 409): ${text}` });
      this._scheduleReconnect("connection limit exceeded", /*forceLongDelay*/ true);
      return;
    }
    this.emit("error", { fatal: false, message: `Alpaca error (code ${code}): ${text}` });
  }

  _scheduleReconnect(reason, forceLongDelay) {
    if (this.stopped || this.fatalErrorSeen) return;
    this.reconnectAttempts++;
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      this.fatalErrorSeen = true;
      this.emit("error", {
        fatal: true,
        message: `Gave up reconnecting to ${this.assetType} feed after ${this.maxReconnectAttempts} attempts (${reason}). Not retrying further - check network/config and restart the service.`,
      });
      return;
    }
    const base = forceLongDelay ? 30000 : 1000;
    const capped = Math.min(base * 2 ** (this.reconnectAttempts - 1), 60000);
    const jitter = capped * (0.5 + Math.random() * 0.5); // 50%-100% of capped delay
    this.emit("status", `reconnecting in ${Math.round(jitter)}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}, reason: ${reason})`);
    this._reconnectTimer = setTimeout(() => this._connect(), jitter);
  }

  // ---------- Subscription management ----------

  subscribe({ trades = [], quotes = [], bars = [] }) {
    const newTrades = trades.filter((s) => !this.subscriptions.trades.has(s));
    const newQuotes = quotes.filter((s) => !this.subscriptions.quotes.has(s));
    const newBars = bars.filter((s) => !this.subscriptions.bars.has(s));
    trades.forEach((s) => this.subscriptions.trades.add(s));
    quotes.forEach((s) => this.subscriptions.quotes.add(s));
    bars.forEach((s) => this.subscriptions.bars.add(s));

    if (this.authenticated && (newTrades.length || newQuotes.length || newBars.length)) {
      const payload = { action: "subscribe" };
      if (newTrades.length) payload.trades = newTrades;
      if (newQuotes.length) payload.quotes = newQuotes;
      if (newBars.length) payload.bars = newBars;
      this._send(payload);
    }
  }

  unsubscribe({ trades = [], quotes = [], bars = [] }) {
    trades.forEach((s) => this.subscriptions.trades.delete(s));
    quotes.forEach((s) => this.subscriptions.quotes.delete(s));
    bars.forEach((s) => this.subscriptions.bars.delete(s));
    if (this.authenticated && (trades.length || quotes.length || bars.length)) {
      const payload = { action: "unsubscribe" };
      if (trades.length) payload.trades = trades;
      if (quotes.length) payload.quotes = quotes;
      if (bars.length) payload.bars = bars;
      this._send(payload);
    }
  }

  _resubscribeAll() {
    // After a reconnect, Alpaca doesn't remember prior subscriptions - resend them all.
    const trades = [...this.subscriptions.trades];
    const quotes = [...this.subscriptions.quotes];
    const bars = [...this.subscriptions.bars];
    if (trades.length || quotes.length || bars.length) {
      const payload = { action: "subscribe" };
      if (trades.length) payload.trades = trades;
      if (quotes.length) payload.quotes = quotes;
      if (bars.length) payload.bars = bars;
      this._send(payload);
    }
  }

  // ---------- Normalization (matches the documented data model exactly) ----------

  _normalizeTrade(msg) {
    return {
      type: "trade",
      symbol: msg.S,
      assetType: this.assetType,
      price: msg.p,
      size: msg.s,
      timestamp: msg.t,
      source: "alpaca",
      feed: this.feed,
    };
  }

  _normalizeQuote(msg) {
    return {
      type: "quote",
      symbol: msg.S,
      assetType: this.assetType,
      bidPrice: msg.bp,
      bidSize: msg.bs,
      askPrice: msg.ap,
      askSize: msg.as,
      timestamp: msg.t,
      source: "alpaca",
      feed: this.feed,
    };
  }

  _normalizeBar(msg, timeframe) {
    return {
      type: "bar",
      symbol: msg.S,
      assetType: this.assetType,
      open: msg.o,
      high: msg.h,
      low: msg.l,
      close: msg.c,
      volume: msg.v,
      timestamp: msg.t,
      timeframe,
      source: "alpaca",
      feed: this.feed,
    };
  }
}

module.exports = { AlpacaFeedClient };
