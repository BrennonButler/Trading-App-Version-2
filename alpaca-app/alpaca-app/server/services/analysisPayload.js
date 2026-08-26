"use strict";
const { computeAllIndicators } = require("../lib/indicators.js");
const { getMarketStatus } = require("./marketHours.js");
const { buildScorecard } = require("./scorecard.js");

const INDEX_PROXIES = {
  NASDAQ: { proxySymbol: "QQQ", assetType: "stock", note: "QQQ (Nasdaq-100 tracking ETF) used as a proxy - Alpaca does not provide the raw Nasdaq Composite index level." },
  "NASDAQ COMPOSITE": { proxySymbol: "QQQ", assetType: "stock", note: "QQQ (Nasdaq-100 tracking ETF) used as a proxy - Alpaca does not provide the raw Nasdaq Composite index level." },
  SPX: { proxySymbol: "SPY", assetType: "stock", note: "SPY (S&P 500 tracking ETF) used as a proxy - Alpaca does not provide the raw S&P 500 index level." },
  "S&P 500": { proxySymbol: "SPY", assetType: "stock", note: "SPY (S&P 500 tracking ETF) used as a proxy - Alpaca does not provide the raw S&P 500 index level." },
  DOW: { proxySymbol: "DIA", assetType: "stock", note: "DIA (Dow Jones tracking ETF) used as a proxy - Alpaca does not provide the raw Dow Jones index level." },
};

const CRYPTO_PATTERN = /\b([A-Za-z]{2,10}\/[A-Za-z]{2,10})\b/;
const CAPS_TOKEN_PATTERN = /\b[A-Z]{1,5}\b/g;
const STOCK_STOPWORDS = new Set([
  "A", "I", "IS", "IT", "OR", "TO", "ON", "IN", "OF", "AT", "BE", "DO", "GO", "NO", "SO", "UP",
  "AI", "US", "UK", "EU", "ETF", "USD", "NOW", "WHY", "HOW", "WHAT", "THE", "AND", "FOR", "ARE",
  "WAS", "CAN", "NOT", "BUY", "SELL", "WAIT", "VS", "VERSUS", "DOWN", "ABOUT", "TODAY", "THIS",
  "THAT", "WILL", "WITH", "FROM", "SHOW", "TELL",
]);
const KNOWN_CRYPTO_BASES = new Set(["BTC", "ETH", "SOL", "DOGE", "XRP", "ADA", "AVAX", "LINK", "DOT", "LTC", "BCH", "MATIC"]);

function aliasMatches(upperMessage, alias) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(upperMessage);
}

function extractSymbol(message, conversationContext = {}) {
  const cryptoMatch = message.match(CRYPTO_PATTERN);
  if (cryptoMatch) return { symbol: cryptoMatch[1].toUpperCase(), assetType: "crypto", source: "explicit" };

  const upper = message.toUpperCase();
  for (const [alias, proxy] of Object.entries(INDEX_PROXIES)) {
    if (aliasMatches(upper, alias)) return { symbol: proxy.proxySymbol, assetType: proxy.assetType, source: "index_proxy", indexNote: proxy.note };
  }

  const candidates = [...message.matchAll(CAPS_TOKEN_PATTERN)].map((m) => m[0]).filter((s) => !STOCK_STOPWORDS.has(s));
  const uniqueCandidates = [...new Set(candidates)];
  const looksLikeComparison = /\b(compare|vs\.?|versus)\b/i.test(message);

  const bareCrypto = uniqueCandidates.find((c) => KNOWN_CRYPTO_BASES.has(c));
  if (bareCrypto && uniqueCandidates.length === 1) return { symbol: `${bareCrypto}/USD`, assetType: "crypto", source: "explicit" };

  if (uniqueCandidates.length === 1) return { symbol: uniqueCandidates[0], assetType: "stock", source: "explicit" };
  if (looksLikeComparison && uniqueCandidates.length === 2) {
    return { symbol: uniqueCandidates[0], assetType: "stock", source: "explicit" };
  }

  if (conversationContext.lastSymbol) {
    return { symbol: conversationContext.lastSymbol, assetType: conversationContext.lastAssetType, source: "chat_memory" };
  }
  return null;
}

function extractComparisonSymbol(message, firstSymbol) {
  const cryptoMatches = [...message.matchAll(new RegExp(CRYPTO_PATTERN, "gi"))].map((m) => m[1].toUpperCase());
  const capsMatches = [...message.matchAll(CAPS_TOKEN_PATTERN)].map((m) => m[0]).filter((s) => !STOCK_STOPWORDS.has(s));
  const all = [...cryptoMatches, ...capsMatches].filter((s) => s !== firstSymbol);
  return all.length ? all[0] : null;
}

const HORIZON_CONFIG = {
  short_term: { dailyBarsForContext: 60, hourlyBarLookbackHours: 48, primaryTimeframeLabel: "intraday/short-term (hourly bars, last 48 hours)" },
  long_term: { dailyBarsForContext: 260, hourlyBarLookbackHours: 48, primaryTimeframeLabel: "daily/structural (up to 260 trading days)" },
};

async function buildAnalysisPayload({ symbol, assetType, restClient, newsClient, feed, indexNote, horizon = "short_term" }) {
  const horizonCfg = HORIZON_CONFIG[horizon] || HORIZON_CONFIG.short_term;
  const payload = {
    asset: symbol, assetType, horizon, timestamps: {}, sources: [], warnings: [],
    currentPrice: null, priceChange: null, volume: null, indicators: null,
    historicalDataAvailable: { daily: false, hourly: false },
    news: [], fundamentals: null, indexNote: indexNote || null, scorecard: null,
    marketStatus: getMarketStatus(assetType),
    dataType: "historical", // upgraded to "live" below if a fresh snapshot is available
  };

  // Try the actual latest snapshot first (a real trade/quote, not just the last completed
  // bar) - if it's genuinely recent, the current price is labeled LIVE rather than
  // HISTORICAL. This is real data either way; the label just reflects which kind it is.
  try {
    const snapshot = await restClient.getLatestSnapshot({ symbol, assetType, feed });
    const snapTimestamp = snapshot.latestTrade ? snapshot.latestTrade.timestamp : (snapshot.latestQuote ? snapshot.latestQuote.timestamp : null);
    if (snapTimestamp) {
      const ageMs = Date.now() - new Date(snapTimestamp).getTime();
      if (ageMs < 5 * 60 * 1000) { // fresh within the last 5 minutes -> genuinely LIVE
        payload.dataType = "live";
        if (snapshot.latestTrade) payload.currentPrice = snapshot.latestTrade.price;
        payload.timestamps.marketData = snapTimestamp;
      }
    }
  } catch (e) {
    // Non-fatal - historical bars below are the fallback source of truth either way.
  }

  let dailyBars = [];
  try {
    dailyBars = await restClient.getHistoricalBars({ symbol, assetType, timeframe: "1Day", limit: horizonCfg.dailyBarsForContext, feed });
    payload.historicalDataAvailable.daily = dailyBars.length >= 2;
  } catch (e) {
    payload.warnings.push(`Daily market data unavailable: ${e.message}`);
  }

  if (dailyBars.length >= 2) {
    const last = dailyBars[dailyBars.length - 1];
    const priorClose = dailyBars[dailyBars.length - 2].close;
    const referencePrice = payload.dataType === "live" ? payload.currentPrice : last.close;
    if (payload.dataType !== "live") { payload.currentPrice = last.close; payload.timestamps.marketData = last.timestamp; }
    payload.priceChange = { absolute: round(referencePrice - priorClose, 6), percent: round(((referencePrice - priorClose) / priorClose) * 100, 4) };
    payload.volume = last.volume; // daily volume always comes from the bar - a single trade isn't the day's total volume
    payload.sources.push({ label: "Price, change, volume", provider: "Alpaca Market Data API", timestamp: payload.timestamps.marketData });
  } else {
    payload.warnings.push("Not enough daily bars returned to compute price/change/volume.");
  }

  if (dailyBars.length >= 15) {
    const indexed = computeAllIndicators(dailyBars);
    const last = indexed[indexed.length - 1];
    payload.indicators = {
      rsi14: hasEnoughBars(dailyBars, 15) ? round(last.rsi14, 2) : null,
      macd: hasEnoughBars(dailyBars, 35) ? { macd: round(last.macd, 4), signal: round(last.macdSignal, 4), histogram: round(last.macdHist, 4) } : null,
      sma20: hasEnoughBars(dailyBars, 20) ? round(last.sma20, 4) : null,
      sma200: hasEnoughBars(dailyBars, 200) ? round(last.sma200, 4) : null,
      ema9: hasEnoughBars(dailyBars, 9) ? round(last.ema9, 4) : null,
      ema21: hasEnoughBars(dailyBars, 21) ? round(last.ema21, 4) : null,
      ema50: hasEnoughBars(dailyBars, 50) ? round(last.ema50, 4) : null,
      atr14: hasEnoughBars(dailyBars, 15) ? round(last.atr14, 4) : null,
      bollinger: hasEnoughBars(dailyBars, 20) ? { upper: round(last.bbUpper, 4), lower: round(last.bbLower, 4), middle: round(last.bbMiddle, 4) } : null,
      adx14: hasEnoughBars(dailyBars, 28) ? round(last.adx, 2) : null,
      obv: last.obv != null ? round(last.obv, 0) : null,
      goldenCrossStructure: hasEnoughBars(dailyBars, 200) ? (last.ema50 > last.sma200 ? "50-period average above 200-day average (bullish structure)" : "50-period average below 200-day average (bearish structure)") : null,
      period: "14-day/20-day/etc as applicable, calculated from daily bars",
      barsUsed: dailyBars.length,
    };
    payload.sources.push({ label: "Technical indicators", provider: `Calculated from ${dailyBars.length} daily bars (Alpaca Market Data API)`, timestamp: payload.timestamps.marketData });
    const missing = Object.entries({ sma200: 200, macd: 35, adx14: 28 }).filter(([k, need]) => dailyBars.length < need).map(([k]) => k);
    if (missing.length) payload.warnings.push(`Not enough history for: ${missing.join(", ")} (need more daily bars than the ${dailyBars.length} available).`);
    payload.scorecard = buildScorecard(indexed, symbol);
  } else {
    payload.warnings.push(`Only ${dailyBars.length} daily bars available - too few to calculate reliable indicators (need at least 15).`);
  }

  try {
    const hourlyBars = await restClient.getHistoricalBars({ symbol, assetType, timeframe: "1Hour", limit: horizonCfg.hourlyBarLookbackHours, feed });
    payload.historicalDataAvailable.hourly = hourlyBars.length >= 2;
    if (hourlyBars.length >= 2) {
      const firstH = hourlyBars[0].close, lastH = hourlyBars[hourlyBars.length - 1].close;
      payload.shortTermTrend = { changePercent: round(((lastH - firstH) / firstH) * 100, 4), barsUsed: hourlyBars.length, timeframe: `1-hour bars, last ${horizonCfg.hourlyBarLookbackHours} hours` };
      payload.sources.push({ label: "Short-term (hourly) trend", provider: "Alpaca Market Data API", timestamp: hourlyBars[hourlyBars.length - 1].timestamp });
    }
  } catch (e) {
    payload.warnings.push(`Hourly market data unavailable: ${e.message}`);
  }

  if (assetType === "stock" && newsClient) {
    try {
      const articles = await newsClient.getNews({ symbols: [symbol], limit: 5 });
      payload.news = articles;
      articles.forEach((a) => payload.sources.push({ label: `News: "${a.headline}"`, provider: a.publisher, timestamp: a.publishedAt, url: a.url }));
    } catch (e) {
      payload.warnings.push(`News unavailable: ${e.message}`);
    }
  } else if (assetType === "crypto") {
    payload.warnings.push("News is not available for crypto symbols through the current data source.");
  }

  payload.fundamentals = null;
  payload.warnings.push("Fundamental data (P/E, earnings, revenue, analyst estimates) is not available - no fundamentals data source is currently connected.");

  return payload;
}

function hasEnoughBars(bars, needed) { return bars.length >= needed; }
function round(n, digits) { return n == null || isNaN(n) ? null : Math.round(n * 10 ** digits) / 10 ** digits; }

const MARKET_OVERVIEW_PATTERN = /\b(market overview|happening in the market|how('s| is) the market|market doing|state of the market)\b/i;
// Broad market snapshot: major index proxies + the two largest cryptos. Same real-data
// approach as everything else here - no synthetic "market mood" number, just genuine
// price/change for each of these pulled the same way a single-asset analysis would be.
const MARKET_OVERVIEW_SYMBOLS = [
  { symbol: "QQQ", assetType: "stock", label: "Nasdaq-100" },
  { symbol: "SPY", assetType: "stock", label: "S&P 500" },
  { symbol: "DIA", assetType: "stock", label: "Dow Jones" },
  { symbol: "BTC/USD", assetType: "crypto", label: "Bitcoin" },
  { symbol: "ETH/USD", assetType: "crypto", label: "Ethereum" },
];

function isMarketOverviewRequest(message) {
  return MARKET_OVERVIEW_PATTERN.test(message);
}

async function buildMarketOverviewPayload({ restClient, newsClient, feed, horizon }) {
  const assets = [];
  const errors = [];
  for (const { symbol, assetType, label } of MARKET_OVERVIEW_SYMBOLS) {
    try {
      const payload = await buildAnalysisPayload({ symbol, assetType, restClient, newsClient, feed, horizon });
      assets.push({ label, ...payload });
    } catch (e) {
      errors.push(`${label}: ${e.message}`);
    }
  }
  return { marketOverview: true, assets, errors, timestamp: new Date().toISOString() };
}

module.exports = { extractSymbol, extractComparisonSymbol, buildAnalysisPayload, INDEX_PROXIES, HORIZON_CONFIG, isMarketOverviewRequest, buildMarketOverviewPayload };
