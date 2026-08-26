"use strict";
const { computeAllIndicators } = require("../lib/indicators.js");
const { evaluateMaster } = require("../lib/agents.js");

// Alpaca's normalized bar shape (open/high/low/close/volume/timestamp) is already what
// computeAllIndicators expects (it just needs open/high/low/close/volume present as
// numbers) - no transformation needed, just a rename of 'timestamp' isn't even required
// since computeAllIndicators doesn't read a 'time' field itself, only the OHLCV values.

const TIMEFRAME_MAP = {
  short_term: { alpaca: "1Hour", limit: 300 },
  long_term: { alpaca: "1Day", limit: 300 },
};

async function getIndexedBars(restClient, symbol, assetType, horizon, feed) {
  const cfg = TIMEFRAME_MAP[horizon] || TIMEFRAME_MAP.short_term;
  const bars = await restClient.getHistoricalBars({
    symbol, assetType, timeframe: cfg.alpaca, limit: cfg.limit, feed,
  });
  if (bars.length < 15) {
    throw new Error(`Not enough historical data for ${symbol} (got ${bars.length} bars) - the symbol may be invalid, newly listed, or your Alpaca subscription may not cover this feed.`);
  }
  return computeAllIndicators(bars);
}

async function analyzeSymbol(restClient, symbol, assetType, horizon, opts = {}) {
  const indexed = await getIndexedBars(restClient, symbol, assetType, horizon, opts.feed);
  return evaluateMaster(indexed, symbol, assetType, {
    maxRiskPerTradePct: opts.maxRiskPerTradePct ?? 1.0,
    horizon,
  });
}

module.exports = { getIndexedBars, analyzeSymbol, TIMEFRAME_MAP };
