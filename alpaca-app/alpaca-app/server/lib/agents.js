// Multi-agent scoring — direct port of the Python agents, same logic and weights.
if (typeof require !== 'undefined' && typeof findSupportResistance === 'undefined') {
  var { findSupportResistance } = require('./indicators.js');
}

function last(bars) { return bars[bars.length - 1]; }
function prevOf(bars) { return bars.length > 1 ? bars[bars.length - 2] : bars[bars.length - 1]; }

function technicalAgent(bars) {
  const l = last(bars), p = prevOf(bars);
  let score = 50;
  const bullish = [], bearish = [];

  if (l.rsi14 != null) {
    if (l.rsi14 < 30) { score += 12; bullish.push(`RSI at ${l.rsi14.toFixed(1)} is oversold, favoring a bounce`); }
    else if (l.rsi14 > 70) { score -= 12; bearish.push(`RSI at ${l.rsi14.toFixed(1)} is overbought, favoring a pullback`); }
    else if (l.rsi14 > 50) { score += 4; bullish.push(`RSI at ${l.rsi14.toFixed(1)} shows bullish momentum`); }
    else { score -= 4; bearish.push(`RSI at ${l.rsi14.toFixed(1)} shows bearish momentum`); }
  }

  if (l.macd != null && l.macdSignal != null && p.macd != null && p.macdSignal != null) {
    const crossedUp = p.macd <= p.macdSignal && l.macd > l.macdSignal;
    const crossedDown = p.macd >= p.macdSignal && l.macd < l.macdSignal;
    if (crossedUp) { score += 15; bullish.push('MACD just crossed above its signal line (bullish crossover)'); }
    else if (crossedDown) { score -= 15; bearish.push('MACD just crossed below its signal line (bearish crossover)'); }
    else if (l.macd > l.macdSignal) { score += 5; bullish.push('MACD remains above its signal line'); }
    else { score -= 5; bearish.push('MACD remains below its signal line'); }
  }

  if (l.stochRsiK != null) {
    if (l.stochRsiK < 20) { score += 8; bullish.push(`Stochastic RSI at ${l.stochRsiK.toFixed(1)} is in oversold territory`); }
    else if (l.stochRsiK > 80) { score -= 8; bearish.push(`Stochastic RSI at ${l.stochRsiK.toFixed(1)} is in overbought territory`); }
  }

  if (l.bbUpper != null && l.bbLower != null && l.bbUpper > l.bbLower) {
    const pctB = (l.close - l.bbLower) / (l.bbUpper - l.bbLower);
    if (pctB < 0.1) { score += 8; bullish.push('Price is near the lower Bollinger Band (potential support)'); }
    else if (pctB > 0.9) { score -= 8; bearish.push('Price is near the upper Bollinger Band (potential resistance)'); }
  }

  if (bars.length >= 10) {
    const recent = bars.slice(-10);
    const obvSlope = recent[recent.length - 1].obv - recent[0].obv;
    const priceSlope = recent[recent.length - 1].close - recent[0].close;
    if (obvSlope > 0 && priceSlope > 0) { score += 5; bullish.push('On-Balance Volume confirms the recent price rise'); }
    else if (obvSlope < 0 && priceSlope < 0) { score -= 5; bearish.push('On-Balance Volume confirms the recent price decline'); }
    else if (obvSlope < 0 && priceSlope > 0) { score -= 6; bearish.push('Volume is diverging from price (weak rally, possible reversal)'); }
    else if (obvSlope > 0 && priceSlope < 0) { score += 6; bullish.push('Volume is diverging from the price decline (possible bottoming)'); }
  }

  score = Math.max(0, Math.min(100, score));
  return { agentName: 'technical', score, rationale: `Technical composite: ${Math.round(score)}/100`, bullish, bearish };
}

function detectTrend(bars) {
  const l = last(bars);
  if (l.ema9 == null || l.ema21 == null || l.ema50 == null) return 'sideways';
  const adxVal = l.adx || 0;
  const bullStack = l.ema9 > l.ema21 && l.ema21 > l.ema50;
  const bearStack = l.ema9 < l.ema21 && l.ema21 < l.ema50;
  if (bullStack && adxVal > 25) return 'strong_uptrend';
  if (bullStack) return 'uptrend';
  if (bearStack && adxVal > 25) return 'strong_downtrend';
  if (bearStack) return 'downtrend';
  return 'sideways';
}

function trendAgent(bars, opts = {}) {
  const horizon = opts.horizon || 'short_term';
  const l = last(bars);
  const bullish = [], bearish = [];
  const trendLabel = detectTrend(bars);
  const trendScores = { strong_uptrend: 90, uptrend: 70, sideways: 50, downtrend: 30, strong_downtrend: 10 };
  let score = trendScores[trendLabel];

  if (l.ema9 != null && l.ema21 != null && l.ema50 != null) {
    if (l.ema9 > l.ema21 && l.ema21 > l.ema50) bullish.push('EMA stack is bullish (9 > 21 > 50)');
    else if (l.ema9 < l.ema21 && l.ema21 < l.ema50) bearish.push('EMA stack is bearish (9 < 21 < 50)');
    else bullish.push('EMAs are mixed/converging, suggesting a potential trend change');
  }

  if (l.adx != null) {
    if (l.adx > 25) (score >= 50 ? bullish : bearish).push(`ADX at ${l.adx.toFixed(1)} confirms a strong trend`);
    else { bearish.push(`ADX at ${l.adx.toFixed(1)} indicates a weak/choppy trend (low conviction)`); score = 50 + (score - 50) * 0.5; }
  }

  if (l.ichimokuA != null && l.ichimokuB != null) {
    const cloudTop = Math.max(l.ichimokuA, l.ichimokuB);
    const cloudBottom = Math.min(l.ichimokuA, l.ichimokuB);
    if (l.close > cloudTop) { score += 5; bullish.push('Price is above the Ichimoku Cloud (bullish structure)'); }
    else if (l.close < cloudBottom) { score -= 5; bearish.push('Price is below the Ichimoku Cloud (bearish structure)'); }
    else { bearish.push('Price is inside the Ichimoku Cloud (no clear trend structure)'); }
  }

  // Long-term horizon: weight the 50/200 relationship (golden cross / death cross) heavily.
  // This is the classic long-horizon trend signal and matters far more for a multi-month
  // hold than the short EMA9/21 noise that dominates day-trading decisions.
  if (horizon === 'long_term' && l.ema50 != null && l.ema200 != null) {
    if (l.ema50 > l.ema200) { score += 15; bullish.push('Golden cross structure: 50-period average is above the 200-period average (long-term uptrend)'); }
    else { score -= 15; bearish.push('Death cross structure: 50-period average is below the 200-period average (long-term downtrend)'); }
  }

  score = Math.max(0, Math.min(100, score));
  return { agentName: 'trend', score, rationale: `Trend classified as '${trendLabel}': ${Math.round(score)}/100`, bullish, bearish };
}

function detectVolatilityRegime(bars) {
  const atrVals = bars.map(b => b.atr14).filter(v => v != null);
  if (!atrVals.length) return 'normal';
  const recent = atrVals.slice(-50);
  const current = recent[recent.length - 1];
  const percentile = recent.filter(v => v < current).length / recent.length;
  if (percentile > 0.8) return 'high';
  if (percentile < 0.2) return 'low';
  return 'normal';
}

function findSR(bars) {
  const highs = bars.map(b => b.high), lows = bars.map(b => b.low);
  return findSupportResistance(highs, lows, 100, 3);
}

function riskAgent(bars) {
  const l = last(bars);
  let riskScore = 50;
  const bullish = [], bearish = [];

  const volRegime = detectVolatilityRegime(bars);
  if (volRegime === 'high') { riskScore += 20; bearish.push('Volatility (ATR) is in the top 20% of its recent range — wider swings likely'); }
  else if (volRegime === 'low') { riskScore -= 15; bullish.push('Volatility (ATR) is unusually low — tighter, more predictable ranges'); }

  if (l.atr14 != null && l.close > 0) {
    const atrPct = (l.atr14 / l.close) * 100;
    if (atrPct > 5) { riskScore += 15; bearish.push(`ATR is ${atrPct.toFixed(1)}% of price — a large range relative to price`); }
    else if (atrPct < 1) { riskScore -= 5; bullish.push(`ATR is only ${atrPct.toFixed(1)}% of price — a tight, lower-risk range`); }
  }

  const sr = findSR(bars);
  const support = sr.support.filter(s => s <= l.close);
  if (support.length) {
    const nearest = Math.max(...support);
    const distPct = (l.close - nearest) / l.close * 100;
    if (distPct < 1.5) { riskScore -= 8; bullish.push(`Price is close to support at ${nearest.toFixed(2)} (${distPct.toFixed(1)}% away)`); }
  }
  const resistance = sr.resistance.filter(r => r >= l.close);
  if (resistance.length) {
    const nearest = Math.min(...resistance);
    const distPct = (nearest - l.close) / l.close * 100;
    if (distPct < 1.5) { riskScore += 8; bearish.push(`Price is close to resistance at ${nearest.toFixed(2)} (${distPct.toFixed(1)}% away)`); }
  }

  riskScore = Math.max(0, Math.min(100, riskScore));
  return { agentName: 'risk', score: riskScore, rationale: `Risk regime '${volRegime}': ${Math.round(riskScore)}/100 (higher = riskier)`, bullish, bearish };
}

function sentimentAgent(bars, apiKey) {
  if (!apiKey) {
    return { agentName: 'sentiment', score: 50, rationale: 'No news/sentiment provider is configured, so this agent is neutral (50) and excluded from the master score.', bullish: [], bearish: [] };
  }
  return { agentName: 'sentiment', score: 50, rationale: 'News provider configured but not yet implemented.', bullish: [], bearish: [] };
}

function suggestStopAndTarget(bars, direction, atrMultStop = 1.5, atrMultTarget = 3.0) {
  const l = last(bars);
  const close = l.close;
  let atrVal = l.atr14 || 0;
  if (!atrVal) atrVal = close * 0.02;

  let stopLoss, takeProfit;
  if (direction === 'long') { stopLoss = close - atrVal * atrMultStop; takeProfit = close + atrVal * atrMultTarget; }
  else { stopLoss = close + atrVal * atrMultStop; takeProfit = close - atrVal * atrMultTarget; }

  const riskPerUnit = Math.abs(close - stopLoss);
  const rewardPerUnit = Math.abs(takeProfit - close);

  return { entryPrice: close, stopLoss, takeProfit, riskPerUnit, rewardPerUnit, rewardRiskRatio: riskPerUnit > 0 ? rewardPerUnit / riskPerUnit : null };
}

const BASE_WEIGHTS = { technical: 0.55, trend: 0.45, sentiment: 0.20 };

// Short-term (day trading): momentum/oscillators matter more, stops/targets are tight
// (sized off short-term ATR volatility). Long-term (position trading): trend structure
// and the golden-cross/death-cross relationship matter more, stops/targets are wide
// enough to ride out normal multi-week noise without getting shaken out early.
const HORIZON_CONFIG = {
  short_term: { atrMultStop: 1.5, atrMultTarget: 3.0, weights: { technical: 0.60, trend: 0.40, sentiment: 0.20 } },
  long_term: { atrMultStop: 3.0, atrMultTarget: 8.0, weights: { technical: 0.35, trend: 0.65, sentiment: 0.20 } },
};

function evaluateMaster(bars, symbol, assetClass, opts = {}) {
  const maxRiskPerTradePct = opts.maxRiskPerTradePct ?? 1.0;
  const sentimentApiKey = opts.sentimentApiKey || null;
  const horizon = opts.horizon === 'long_term' ? 'long_term' : 'short_term';
  const horizonConfig = HORIZON_CONFIG[horizon];

  const techResult = technicalAgent(bars);
  const trendResult = trendAgent(bars, { horizon });
  const riskResult = riskAgent(bars);
  const sentimentResult = sentimentAgent(bars, sentimentApiKey);

  const directional = { technical: techResult, trend: trendResult, sentiment: sentimentResult };
  const activeWeights = {};
  for (const [name, result] of Object.entries(directional)) {
    if (name === 'sentiment' && result.rationale.includes('No news/sentiment provider')) continue;
    activeWeights[name] = horizonConfig.weights[name];
  }
  const totalWeight = Object.values(activeWeights).reduce((a, b) => a + b, 0) || 1;
  let masterConfidence = 0;
  for (const [name, weight] of Object.entries(activeWeights)) masterConfidence += directional[name].score * weight;
  masterConfidence /= totalWeight;

  const direction = masterConfidence >= 55 ? 'long' : (masterConfidence <= 45 ? 'short' : 'flat');
  const riskScore = riskResult.score;

  const stopTarget = suggestStopAndTarget(
    bars, direction !== 'flat' ? direction : 'long', horizonConfig.atrMultStop, horizonConfig.atrMultTarget
  );
  const rrRatio = stopTarget.rewardRiskRatio || 1.0;
  const rewardScore = Math.max(0, Math.min(100, rrRatio * 30));

  const entryPrice = stopTarget.entryPrice;
  const expectedReturnPct = (stopTarget.rewardPerUnit / entryPrice) * 100;
  const expectedDrawdownPct = (stopTarget.riskPerUnit / entryPrice) * 100;

  const confidenceFactor = Math.max(0, (masterConfidence - 50) / 50);
  const riskDampener = Math.max(0.2, 1 - riskScore / 100);
  const positionSizePct = Math.min(maxRiskPerTradePct * confidenceFactor * riskDampener, maxRiskPerTradePct);

  const allResults = [techResult, trendResult, riskResult, sentimentResult];
  const bullishFactors = allResults.flatMap(r => r.bullish);
  const bearishFactors = allResults.flatMap(r => r.bearish);

  return {
    symbol, assetClass, direction, horizon, masterConfidence, riskScore, rewardScore,
    entryPrice, suggestedStopLoss: stopTarget.stopLoss, suggestedTakeProfit: stopTarget.takeProfit,
    suggestedPositionSizePct: Math.round(positionSizePct * 1000) / 1000,
    expectedReturnPct, expectedDrawdownPct, agentResults: allResults, bullishFactors, bearishFactors,
  };
}

if (typeof module !== 'undefined') {
  module.exports = { technicalAgent, trendAgent, riskAgent, sentimentAgent, detectTrend, detectVolatilityRegime, suggestStopAndTarget, evaluateMaster, findSR };
}
