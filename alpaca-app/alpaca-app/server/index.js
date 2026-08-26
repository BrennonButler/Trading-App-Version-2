"use strict";
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const path = require("path");

const config = require("./config.js");
const { initDb } = require("./services/db.js");
const { MarketDataService } = require("./services/marketDataService.js");
const { AlpacaRestClient } = require("./services/alpacaRestClient.js");
const { AlpacaAssetsClient } = require("./services/alpacaAssetsClient.js");
const { AlpacaScreenerClient } = require("./services/alpacaScreenerClient.js");
const { analyzeSymbol } = require("./services/analyst.js");
const { extractSymbol, extractComparisonSymbol, buildAnalysisPayload, isMarketOverviewRequest, buildMarketOverviewPayload } = require("./services/analysisPayload.js");
const { runAnalysis } = require("./services/aiReasoningEngine.js");
const { AlpacaNewsClient } = require("./services/alpacaNewsClient.js");
const {
  createInitialState, getOpenPositions, getPortfolioValue, openPosition, closePosition, checkStopsAndTargets, RiskLimitExceeded,
} = require("./lib/paper_trading_engine.js");
const { runBacktest } = require("./lib/backtest.js");
const { recommendAllocation } = require("./lib/allocator.js");
const { checkExitSignal } = require("./lib/exit_signal.js");
const { computeAllIndicators } = require("./lib/indicators.js");

function createApp({ dbPath, stockWsUrls, cryptoWsUrl } = {}) {
  const app = express();
  app.use(express.json());

  const db = initDb(dbPath || config.dbPath);
  const restClient = new AlpacaRestClient({ keyId: config.alpaca.keyId, secretKey: config.alpaca.secretKey });
  const assetsClient = new AlpacaAssetsClient({ keyId: config.alpaca.keyId, secretKey: config.alpaca.secretKey });
  const screenerClient = new AlpacaScreenerClient({ keyId: config.alpaca.keyId, secretKey: config.alpaca.secretKey });
  const newsClient = new AlpacaNewsClient({ keyId: config.alpaca.keyId, secretKey: config.alpaca.secretKey });
  // Per-session chat memory: sessionId -> { lastSymbol, lastAssetType, history: [] }
  const chatSessions = new Map();
  const marketData = new MarketDataService({
    keyId: config.alpaca.keyId, secretKey: config.alpaca.secretKey,
    stockFeed: config.alpaca.stockFeed, maxSubscriptionsPerClient: config.maxSubscriptionsPerClient,
    ...(stockWsUrls ? { stockWsUrls } : {}), ...(cryptoWsUrl ? { cryptoWsUrl } : {}),
  });

  // ---------- Paper trading state (in-memory mirror, backed by SQLite) ----------
  const paperState = createInitialState(
    db.getSetting("startingPaperBalance", config.startingPaperBalance),
    db.getSetting("riskLimits", config.defaultRiskLimits)
  );
  // Rehydrate open trades from the DB on startup so a server restart doesn't lose positions.
  for (const row of db.getOpenTrades()) {
    paperState.trades.push({
      id: row.id, symbol: row.symbol, assetClass: row.asset_type, direction: row.direction,
      entryPrice: row.entry_price, quantity: row.quantity, stopLoss: row.stop_loss, takeProfit: row.take_profit,
      horizon: row.horizon, entryConfidence: row.entry_confidence,
      openedAt: row.opened_at, closedAt: null, status: "open", pnl: null, pnlPct: null, closeReason: null, exitPrice: null,
    });
    paperState.nextTradeId = Math.max(paperState.nextTradeId, row.id + 1);
  }

  function priceFnFor(snapshotOrPrice) {
    return () => snapshotOrPrice;
  }

  async function getCurrentPrice(symbol, assetType) {
    // Prefer live streamed data if we have it and it's fresh; otherwise fetch fresh via REST.
    const snap = marketData.getMarketSnapshot(symbol, assetType);
    if (snap.freshness === "live" && snap.latestTrade) return snap.latestTrade.price;
    if (snap.latestQuote) return (snap.latestQuote.bidPrice + snap.latestQuote.askPrice) / 2;
    const fresh = await restClient.getLatestSnapshot({ symbol, assetType, feed: config.alpaca.stockFeed });
    if (fresh.latestTrade) return fresh.latestTrade.price;
    if (fresh.latestQuote) return (fresh.latestQuote.bidPrice + fresh.latestQuote.askPrice) / 2;
    throw new Error(`No current price available for ${symbol}`);
  }

  // ============================================================
  // Market data routes
  // ============================================================
  app.get("/api/status", (req, res) => {
    res.json({
      alpacaConfigured: Boolean(config.alpaca.keyId && config.alpaca.secretKey),
      stockFeed: config.alpaca.stockFeed,
      connection: marketData.getConnectionStatus(),
    });
  });

  app.get("/api/snapshot/:assetType/:symbol", (req, res) => {
    const { assetType, symbol } = req.params;
    res.json(marketData.getMarketSnapshot(decodeURIComponent(symbol), assetType));
  });

  app.get("/api/historical/:assetType/:symbol", async (req, res) => {
    const { assetType, symbol } = req.params;
    const { timeframe = "1Day", limit = 300, start, end } = req.query;
    try {
      const bars = await restClient.getHistoricalBars({
        symbol: decodeURIComponent(symbol), assetType, timeframe, limit: parseInt(limit, 10), start, end, feed: config.alpaca.stockFeed,
      });
      res.json({ symbol, assetType, bars });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Symbol autocomplete/search - backed by Alpaca's real, full list of tradable US stocks
  // (thousands, not a hardcoded subset), so typing any real ticker or company name gets
  // live feedback rather than only working for a small pre-set watchlist.
  app.get("/api/symbols/search", async (req, res) => {
    const q = (req.query.q || "").trim();
    if (!q) return res.json({ results: [] });
    try {
      const results = await assetsClient.search(q, parseInt(req.query.limit || "8", 10));
      res.json({ results });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Real, live "what's actually being traded right now" from Alpaca's own screener - not
  // derived by us scanning the whole market. This is the fast, no-manual-effort default:
  // a small, real pool the existing signal engine can then evaluate in well under a minute.
  app.get("/api/symbols/trending", async (req, res) => {
    try {
      const [actives, gainers] = await Promise.all([
        screenerClient.getMostActive(30).catch((e) => { console.warn("most-actives failed:", e.message); return []; }),
        screenerClient.getTopGainers(20).catch((e) => { console.warn("top gainers failed:", e.message); return []; }),
      ]);
      const seen = new Set();
      const symbols = [];
      for (const a of [...actives, ...gainers]) {
        if (!seen.has(a.symbol)) { seen.add(a.symbol); symbols.push(a.symbol); }
      }
      if (!symbols.length) return res.status(502).json({ error: "Could not reach Alpaca's screener - both most-actives and movers requests failed." });
      res.json({ count: symbols.length, symbols });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Real, verifiable exchange listings from Alpaca's own asset data - not a fabricated or
  // stale "S&P 500 list" from somewhere else. exchanges=NYSE,NASDAQ (comma-separated) or
  // omit for everything Alpaca lists as tradable (includes OTC/smaller venues).
  app.get("/api/symbols/universe", async (req, res) => {
    try {
      const all = await assetsClient.getAllAssets();
      const exchangeFilter = (req.query.exchanges || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
      const filtered = exchangeFilter.length ? all.filter((a) => exchangeFilter.includes((a.exchange || "").toUpperCase())) : all;
      res.json({ count: filtered.length, symbols: filtered.map((a) => a.symbol) });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // ============================================================
  // AI Trade Analyst chat route
  // ============================================================
  app.post("/api/analyst/chat", async (req, res) => {
    const { message, sessionId = "default", horizon = "short_term" } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required" });
    }

    let session = chatSessions.get(sessionId);
    if (!session) { session = { lastSymbol: null, lastAssetType: null, history: [] }; chatSessions.set(sessionId, session); }

    const primary = extractSymbol(message, { lastSymbol: session.lastSymbol, lastAssetType: session.lastAssetType });

    if (!primary) {
      if (isMarketOverviewRequest(message)) {
        try {
          const payload = await buildMarketOverviewPayload({ restClient, newsClient, feed: config.alpaca.stockFeed, horizon });
          const { reply } = await runAnalysis({
            payload, userQuestion: message, conversationHistory: session.history, horizon,
            apiKey: config.anthropic.apiKey, model: config.anthropic.model,
          });
          session.history.push({ role: "user", content: message }, { role: "assistant", content: reply });
          if (session.history.length > 20) session.history = session.history.slice(-20);
          return res.json({ reply, symbol: null, payload, isMarketOverview: true });
        } catch (e) {
          db.log("ERROR", "analyst", `Market overview failed: ${e.message}`);
          return res.status(502).json({ error: e.message });
        }
      }
      return res.json({
        reply: "I don't have a symbol to analyze yet - tell me a stock ticker, ETF, or crypto pair (e.g. \"Analyze NVDA\" or \"Is BTC/USD bullish?\"), or ask about the market overall.",
        symbol: null, payload: null,
      });
    }

    const isComparison = /\b(compare|vs\.?|versus)\b/i.test(message);
    const secondSymbol = isComparison ? extractComparisonSymbol(message, primary.symbol) : null;

    try {
      const payloadOpts = { restClient, newsClient, feed: config.alpaca.stockFeed, horizon };
      const primaryPayload = await buildAnalysisPayload({ symbol: primary.symbol, assetType: primary.assetType, indexNote: primary.indexNote, ...payloadOpts });

      let payload = primaryPayload;
      if (secondSymbol) {
        // Comparison mode: build both payloads, hand the model both, let it reason about
        // which currently has stronger evidence rather than us picking programmatically.
        const secondAssetType = secondSymbol.includes("/") ? "crypto" : "stock";
        const secondPayload = await buildAnalysisPayload({ symbol: secondSymbol, assetType: secondAssetType, ...payloadOpts });
        payload = { comparison: true, assetA: primaryPayload, assetB: secondPayload };
      }

      const { reply } = await runAnalysis({
        payload, userQuestion: message, conversationHistory: session.history, horizon,
        apiKey: config.anthropic.apiKey, model: config.anthropic.model,
      });

      session.lastSymbol = primary.symbol;
      session.lastAssetType = primary.assetType;
      session.history.push({ role: "user", content: message }, { role: "assistant", content: reply });
      if (session.history.length > 20) session.history = session.history.slice(-20); // bounded memory

      db.log("INFO", "analyst", `Chat analysis for ${primary.symbol} (${horizon})`);
      res.json({ reply, symbol: primary.symbol, assetType: primary.assetType, horizon, payload, symbolSource: primary.source });
    } catch (e) {
      db.log("ERROR", "analyst", `Chat analysis failed: ${e.message}`);
      res.status(502).json({ error: e.message });
    }
  });

  // ============================================================
  // AI analyst routes
  // ============================================================
  app.post("/api/scan", async (req, res) => {
    const { symbols, horizon = "short_term" } = req.body || {};
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return res.status(400).json({ error: "symbols must be a non-empty array of {symbol, assetType}" });
    }
    const results = [];
    for (const { symbol, assetType } of symbols) {
      try {
        const signal = await analyzeSymbol(restClient, symbol, assetType, horizon, {
          maxRiskPerTradePct: db.getSetting("riskLimits", config.defaultRiskLimits).maxRiskPerTradePct,
          feed: config.alpaca.stockFeed,
        });
        results.push({ signal, error: null });
      } catch (e) {
        results.push({ signal: null, symbol, assetType, error: e.message });
      }
    }
    res.json({ results });
  });

  app.post("/api/allocate", async (req, res) => {
    const { budget, symbols, maxPositions = 3, minConfidence = 60, horizon = "auto" } = req.body || {};
    if (!(budget > 0)) return res.status(400).json({ error: "budget must be > 0" });
    if (!Array.isArray(symbols) || symbols.length === 0) return res.status(400).json({ error: "symbols required" });

    const symbolBarsMap = {};
    for (const { symbol, assetType } of symbols) {
      try {
        if (horizon === "auto") {
          const [shortBars, longBars] = await Promise.allSettled([
            restClient.getHistoricalBars({ symbol, assetType, timeframe: "1Hour", limit: 300, feed: config.alpaca.stockFeed }),
            restClient.getHistoricalBars({ symbol, assetType, timeframe: "1Day", limit: 300, feed: config.alpaca.stockFeed }),
          ]);
          const candidates = [];
          if (shortBars.status === "fulfilled" && shortBars.value.length >= 15) {
            candidates.push({ bars: computeAllIndicators(shortBars.value), horizon: "short_term" });
          }
          if (longBars.status === "fulfilled" && longBars.value.length >= 15) {
            candidates.push({ bars: computeAllIndicators(longBars.value), horizon: "long_term" });
          }
          if (!candidates.length) continue;
          // Pick whichever horizon scores stronger for this symbol (same "Auto" idea as before)
          const { evaluateMaster } = require("./lib/agents.js");
          let best = null, bestStrength = -1;
          for (const c of candidates) {
            const sig = evaluateMaster(c.bars, symbol, assetType, { maxRiskPerTradePct: 1.0, horizon: c.horizon });
            const strength = Math.abs(sig.masterConfidence - 50);
            if (strength > bestStrength) { bestStrength = strength; best = c; }
          }
          symbolBarsMap[symbol] = { assetClass: assetType, assetType, bars: best.bars, horizon: best.horizon };
        } else {
          const timeframe = horizon === "long_term" ? "1Day" : "1Hour";
          const bars = await restClient.getHistoricalBars({ symbol, assetType, timeframe, limit: 300, feed: config.alpaca.stockFeed });
          if (bars.length < 15) continue;
          symbolBarsMap[symbol] = { assetClass: assetType, assetType, bars: computeAllIndicators(bars), horizon };
        }
      } catch (e) {
        // Skip symbols that fail to fetch - matches existing behavior of degrading gracefully
      }
    }

    const result = recommendAllocation(budget, symbolBarsMap, {
      maxPositions, minConfidence, maxRiskPerTradePct: db.getSetting("riskLimits", config.defaultRiskLimits).maxRiskPerTradePct,
    });
    res.json(result);
  });

  app.post("/api/backtest", async (req, res) => {
    const { symbol, assetType, horizon = "short_term", startingEquity = 10000, positionSizePct = 10, lookback = 300 } = req.body || {};
    if (!symbol || !assetType) return res.status(400).json({ error: "symbol and assetType required" });
    try {
      const timeframe = horizon === "long_term" ? "1Day" : "1Hour";
      const minHistoryBars = horizon === "long_term" ? 200 : 60;
      const bars = await restClient.getHistoricalBars({
        symbol, assetType, timeframe, limit: Math.max(lookback, minHistoryBars + 20), feed: config.alpaca.stockFeed,
      });
      const result = runBacktest(bars, symbol, assetType, { startingEquity, positionSizePct, horizon, minHistoryBars });
      res.json(result);
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // ============================================================
  // Paper trading routes
  // ============================================================
  app.get("/api/portfolio", async (req, res) => {
    const open = getOpenPositions(paperState);
    const prices = {};
    await Promise.all(open.map(async (p) => {
      try { prices[p.symbol] = await getCurrentPrice(p.symbol, p.assetClass); }
      catch (e) { prices[p.symbol] = p.entryPrice; }
    }));
    res.json(getPortfolioValue(paperState, (symbol) => prices[symbol]));
  });

  app.get("/api/positions", (req, res) => res.json(getOpenPositions(paperState)));

  app.post("/api/positions", async (req, res) => {
    const { symbol, assetType, direction, positionSizePct, absoluteAmount, stopLoss, takeProfit, horizon, entryConfidence } = req.body || {};
    try {
      const price = await getCurrentPrice(symbol, assetType);
      const trade = openPosition(paperState, {
        symbol, assetClass: assetType, direction, positionSizePct, absoluteAmount, stopLoss, takeProfit, horizon, entryConfidence,
      }, priceFnFor(price));
      db.insertTrade({
        symbol, assetType, direction, horizon: trade.horizon, entryPrice: trade.entryPrice, quantity: trade.quantity,
        stopLoss: trade.stopLoss, takeProfit: trade.takeProfit, entryConfidence: trade.entryConfidence, openedAt: trade.openedAt,
      });
      // Reconcile the DB-assigned id with the in-memory trade (DB is the source of truth for ids)
      const dbRow = db.raw.prepare("SELECT id FROM trades WHERE symbol = ? ORDER BY id DESC LIMIT 1").get(symbol);
      trade.id = dbRow.id;
      db.log("INFO", "trade", `Opened ${direction} ${symbol} qty=${trade.quantity} @ ${price}`);
      res.json(trade);
    } catch (e) {
      const status = e instanceof RiskLimitExceeded ? 400 : 502;
      res.status(status).json({ error: e.message });
    }
  });

  app.post("/api/positions/:id/close", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const trade = paperState.trades.find((t) => t.id === id);
    if (!trade) return res.status(404).json({ error: "Trade not found" });
    try {
      const price = await getCurrentPrice(trade.symbol, trade.assetClass);
      const closed = closePosition(paperState, id, req.body?.reason || "manual", priceFnFor(price));
      db.closeTrade(id, {
        exitPrice: closed.exitPrice, pnl: closed.pnl, pnlPct: closed.pnlPct,
        status: closed.status, closeReason: closed.closeReason, closedAt: closed.closedAt,
      });
      db.log("INFO", "trade", `Closed ${trade.symbol}: pnl=${closed.pnl}`);
      res.json(closed);
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get("/api/trades", (req, res) => res.json(db.getAllTrades(parseInt(req.query.limit || "200", 10))));
  app.get("/api/logs", (req, res) => res.json(db.getLogs(parseInt(req.query.limit || "200", 10))));

  // Live exit-check for an open position: re-evaluates the current signal and compares
  // to the entry thesis, same "when should I pull out" logic as before.
  app.get("/api/positions/:id/exit-check", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const trade = paperState.trades.find((t) => t.id === id);
    if (!trade) return res.status(404).json({ error: "Trade not found" });
    try {
      const freshSignal = await analyzeSymbol(restClient, trade.symbol, trade.assetClass, trade.horizon, { feed: config.alpaca.stockFeed });
      res.json(checkExitSignal(trade, freshSignal));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // ============================================================
  // Settings routes
  // ============================================================
  app.get("/api/settings", (req, res) => {
    res.json({
      cryptoSymbols: db.getSetting("cryptoSymbols", []),
      stockSymbols: db.getSetting("stockSymbols", []),
      riskLimits: db.getSetting("riskLimits", config.defaultRiskLimits),
      alertConfidenceThreshold: db.getSetting("alertConfidenceThreshold", 65),
    });
  });

  app.post("/api/settings", (req, res) => {
    const { cryptoSymbols, stockSymbols, riskLimits, alertConfidenceThreshold } = req.body || {};
    if (cryptoSymbols) db.setSetting("cryptoSymbols", cryptoSymbols);
    if (stockSymbols) db.setSetting("stockSymbols", stockSymbols);
    if (riskLimits) { db.setSetting("riskLimits", riskLimits); Object.assign(paperState.riskLimits, riskLimits); }
    if (alertConfidenceThreshold) db.setSetting("alertConfidenceThreshold", alertConfidenceThreshold);
    res.json({ ok: true });
  });

  // ============================================================
  // Static frontend
  // ============================================================
  app.use(express.static(path.join(__dirname, "../public")));

  return { app, db, marketData, restClient, paperState };
}

function createServer(opts) {
  const { app, db, marketData, paperState } = createApp(opts);
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    const clientId = crypto.randomUUID();

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (msg.type === "subscribe") {
        const result = marketData.subscribeClient(clientId, msg.symbol, msg.assetType);
        if (!result.ok) {
          ws.send(JSON.stringify({ type: "error", symbol: msg.symbol, error: result.error }));
        } else {
          ws.send(JSON.stringify({ type: "snapshot", ...marketData.getMarketSnapshot(msg.symbol, msg.assetType) }));
        }
      } else if (msg.type === "unsubscribe") {
        marketData.unsubscribeClient(clientId, msg.symbol, msg.assetType);
      }
    });

    ws.on("close", () => marketData.disconnectClient(clientId));

    const onData = (data) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
    };
    marketData.on("data", onData);
    ws.on("close", () => marketData.off("data", onData));
  });

  marketData.on("status", (s) => console.log(`[market-data] ${s}`));
  marketData.on("dataError", (e) => console.error(`[market-data] ${e.assetType} error:`, e.message));

  // Periodic stop-loss/take-profit check for open paper positions (every 30s)
  setInterval(async () => {
    const open = getOpenPositions(paperState);
    if (!open.length) return;
    const prices = {};
    for (const p of open) {
      try {
        const snap = marketData.getMarketSnapshot(p.symbol, p.assetClass);
        if (snap.latestTrade) prices[p.symbol] = snap.latestTrade.price;
      } catch (e) { /* skip */ }
    }
    checkStopsAndTargets(paperState, (symbol) => {
      if (prices[symbol] == null) throw new Error("no price");
      return prices[symbol];
    });
  }, 30000);

  return { server, marketData, db };
}

module.exports = { createApp, createServer };

if (require.main === module) {
  const { server, marketData } = createServer();
  marketData.start();
  server.listen(config.port, () => {
    console.log(`Server listening on port ${config.port}`);
    console.log(`Alpaca configured: ${Boolean(config.alpaca.keyId && config.alpaca.secretKey)}, feed: ${config.alpaca.stockFeed}`);
  });
}
