// Budget allocator — reuses the exact same evaluateMaster() scoring used by the scanner,
// so recommendations are always consistent with what's shown elsewhere in the app.
// In the browser, evaluateMaster is already a global from agents.js in the same bundle.
// In Node (tests), require it explicitly since there's no shared global script scope.
if (typeof module !== 'undefined' && typeof evaluateMaster === 'undefined') {
  var { evaluateMaster } = require('./agents.js');
}

// symbolBarsMap: { symbol: { assetClass, bars, horizon } } — pre-fetched + indicator-computed
// bars for each candidate symbol, with an optional per-symbol horizon (defaults to
// 'short_term'). Per-symbol horizon is what makes "Auto" mode possible: the caller can
// pre-select whichever horizon scored strongest for each symbol before calling this.
function recommendAllocation(budget, symbolBarsMap, opts = {}) {
  const maxPositions = opts.maxPositions ?? 3;
  const minConfidence = opts.minConfidence ?? 60;
  const maxRiskPerTradePct = opts.maxRiskPerTradePct ?? 1.0;

  if (budget <= 0) return { budget, recommendations: [], unallocated: budget, message: 'Budget must be greater than $0.' };

  const candidates = [];
  for (const [symbol, entry] of Object.entries(symbolBarsMap)) {
    const { assetClass, bars, horizon } = entry;
    if (!bars || bars.length < 10) continue;
    const signal = evaluateMaster(bars, symbol, assetClass, { maxRiskPerTradePct, horizon });
    const qualifies = (signal.direction === 'long' && signal.masterConfidence >= minConfidence)
      || (signal.direction === 'short' && signal.masterConfidence <= (100 - minConfidence));
    if (qualifies) candidates.push(signal);
  }

  if (!candidates.length) {
    return {
      budget, recommendations: [], unallocated: budget,
      message: `No symbols currently meet the ${minConfidence} confidence threshold. Nothing is worth forcing a trade into right now — that's a valid outcome, not a system failure. Try again later or lower the confidence threshold.`,
    };
  }

  candidates.sort((a, b) => Math.abs(b.masterConfidence - 50) - Math.abs(a.masterConfidence - 50));
  const top = candidates.slice(0, maxPositions);
  const strengths = top.map(c => Math.abs(c.masterConfidence - 50));
  const totalStrength = strengths.reduce((a, b) => a + b, 0) || 1;
  const maxSinglePositionPct = Math.max(maxRiskPerTradePct * 5, 15.0);

  const recommendations = [];
  let allocatedTotal = 0;
  for (let i = 0; i < top.length; i++) {
    const candidate = top[i];
    const rawPct = (strengths[i] / totalStrength) * 100;
    const cappedPct = Math.min(rawPct, maxSinglePositionPct);
    const amount = budget * (cappedPct / 100);
    const quantity = candidate.entryPrice > 0 ? amount / candidate.entryPrice : 0;
    const reasoning = (candidate.direction === 'long' ? candidate.bullishFactors : candidate.bearishFactors).slice(0, 5);

    recommendations.push({
      symbol: candidate.symbol, assetClass: candidate.assetClass, direction: candidate.direction,
      horizon: candidate.horizon,
      confidence: Math.round(candidate.masterConfidence * 10) / 10, riskScore: Math.round(candidate.riskScore * 10) / 10,
      allocatedAmount: Math.round(amount * 100) / 100, allocatedPct: Math.round(cappedPct * 100) / 100,
      quantity: Math.round(quantity * 1e6) / 1e6, entryPrice: Math.round(candidate.entryPrice * 1e6) / 1e6,
      stopLoss: Math.round(candidate.suggestedStopLoss * 1e6) / 1e6, takeProfit: Math.round(candidate.suggestedTakeProfit * 1e6) / 1e6,
      expectedReturnPct: Math.round(candidate.expectedReturnPct * 100) / 100,
      expectedDrawdownPct: Math.round(candidate.expectedDrawdownPct * 100) / 100,
      reasoning: reasoning.length ? reasoning : ['Neutral technical/trend confluence'],
    });
    allocatedTotal += amount;
  }

  return {
    budget, recommendations, allocatedTotal: Math.round(allocatedTotal * 100) / 100,
    unallocated: Math.round((budget - allocatedTotal) * 100) / 100,
    message: `${recommendations.length} opportunit${recommendations.length === 1 ? 'y' : 'ies'} found meeting your criteria.`,
  };
}

if (typeof module !== 'undefined') module.exports = { recommendAllocation };
