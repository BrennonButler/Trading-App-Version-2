// Backtesting engine — walk-forward simulation, indicators computed once (causal, safe).
if (typeof module !== 'undefined') {
  var { computeAllIndicators } = require('./indicators.js');
  var { evaluateMaster, suggestStopAndTarget } = require('./agents.js');
}

function runBacktest(rawBars, symbol, assetClass, opts = {}) {
  const startingEquity = opts.startingEquity ?? 10000;
  const positionSizePct = opts.positionSizePct ?? 10;
  const confidenceThresholdLong = opts.confidenceThresholdLong ?? 55;
  const confidenceThresholdShort = opts.confidenceThresholdShort ?? 45;
  const maxOpenPositions = opts.maxOpenPositions ?? 1;
  const minHistoryBars = opts.minHistoryBars ?? 60;
  const horizon = opts.horizon === 'long_term' ? 'long_term' : 'short_term';

  if (rawBars.length <= minHistoryBars) throw new Error(`Not enough data: need > ${minHistoryBars} bars, got ${rawBars.length}`);

  const fullIndexed = computeAllIndicators(rawBars);

  let cash = startingEquity;
  let openTrades = [];
  const closedTrades = [];
  const equityCurve = [];

  for (let i = minHistoryBars; i < rawBars.length; i++) {
    const currentBar = rawBars[i];
    const currentPrice = currentBar.close;
    const indexed = fullIndexed.slice(0, i + 1);

    const stillOpen = [];
    for (const t of openTrades) {
      let hitStop = false, hitTarget = false;
      if (t.direction === 'long') { hitStop = currentPrice <= t._stop; hitTarget = currentPrice >= t._target; }
      else { hitStop = currentPrice >= t._stop; hitTarget = currentPrice <= t._target; }

      if (hitStop || hitTarget) {
        t.exitTime = currentBar.time; t.exitPrice = currentPrice;
        t.closeReason = hitStop ? 'stop_loss' : 'take_profit';
        t.pnl = t.direction === 'long' ? (t.exitPrice - t.entryPrice) * t.quantity : (t.entryPrice - t.exitPrice) * t.quantity;
        t.pnlPct = t.pnl / (t.entryPrice * t.quantity) * 100;
        cash += t.entryPrice * t.quantity + t.pnl;
        closedTrades.push(t);
      } else stillOpen.push(t);
    }
    openTrades = stillOpen;

    if (openTrades.length < maxOpenPositions) {
      const signal = evaluateMaster(indexed, symbol, assetClass, { maxRiskPerTradePct: 100, horizon });
      let direction = null;
      if (signal.masterConfidence >= confidenceThresholdLong) direction = 'long';
      else if (signal.masterConfidence <= confidenceThresholdShort) direction = 'short';

      if (direction) {
        const notional = cash * (positionSizePct / 100);
        if (notional > 0 && currentPrice > 0) {
          const quantity = notional / currentPrice;
          // Use the master signal's own stop/target (already horizon-aware) rather than a
          // separate call, so the backtest never silently diverges from what the live
          // scanner/dashboard would have shown for the same signal.
          openTrades.push({
            entryTime: currentBar.time, exitTime: null, direction, entryPrice: currentPrice,
            exitPrice: null, quantity, pnl: null, pnlPct: null, closeReason: null,
            _stop: signal.suggestedStopLoss, _target: signal.suggestedTakeProfit,
          });
          cash -= notional;
        }
      }
    }

    const positionsValue = openTrades.reduce((sum, t) => sum + currentPrice * t.quantity, 0);
    equityCurve.push({ time: currentBar.time, equity: cash + positionsValue });
  }

  const finalPrice = rawBars[rawBars.length - 1].close;
  const finalTime = rawBars[rawBars.length - 1].time;
  for (const t of openTrades) {
    t.exitTime = finalTime; t.exitPrice = finalPrice; t.closeReason = 'end_of_backtest';
    t.pnl = t.direction === 'long' ? (t.exitPrice - t.entryPrice) * t.quantity : (t.entryPrice - t.exitPrice) * t.quantity;
    t.pnlPct = t.pnl / (t.entryPrice * t.quantity) * 100;
    closedTrades.push(t);
  }

  const endingEquity = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : startingEquity;
  return computeMetrics({ symbol, startTime: rawBars[minHistoryBars].time, endTime: rawBars[rawBars.length - 1].time, startingEquity, endingEquity, trades: closedTrades, equityCurve });
}

function computeMetrics(result) {
  if (!result.equityCurve.length) return { ...result, cagrPct: 0, sharpeRatio: 0, sortinoRatio: 0, maxDrawdownPct: 0, winRatePct: 0, profitFactor: 0, totalReturnPct: 0 };

  const equityValues = result.equityCurve.map(p => p.equity);
  const totalReturn = (result.endingEquity / result.startingEquity) - 1;

  const startMs = new Date(result.startTime).getTime();
  const endMs = new Date(result.endTime).getTime();
  const days = Math.max((endMs - startMs) / (1000 * 60 * 60 * 24), 1);
  const years = days / 365.25;
  const cagr = (years > 0 && result.endingEquity > 0) ? Math.pow(result.endingEquity / result.startingEquity, 1 / years) - 1 : 0;

  const returns = [];
  for (let i = 1; i < equityValues.length; i++) {
    if (equityValues[i - 1] !== 0) returns.push((equityValues[i] - equityValues[i - 1]) / equityValues[i - 1]);
  }
  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 1 ? returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1) : 0;
  const std = Math.sqrt(variance);

  let sharpe = 0, sortino = 0;
  if (returns.length > 1 && std > 0) {
    const avgBarHours = ((endMs - startMs) / 3600000) / Math.max(equityValues.length - 1, 1);
    const barsPerYear = avgBarHours > 0 ? (365.25 * 24) / avgBarHours : 252;
    sharpe = (mean / std) * Math.sqrt(barsPerYear);
    const downside = returns.filter(r => r < 0);
    if (downside.length > 0) {
      const downsideStd = Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length);
      if (downsideStd > 0) sortino = (mean / downsideStd) * Math.sqrt(barsPerYear);
    }
  }

  let runningMax = -Infinity, maxDrawdown = 0;
  for (const eq of equityValues) { runningMax = Math.max(runningMax, eq); maxDrawdown = Math.min(maxDrawdown, (eq - runningMax) / runningMax); }

  const wins = result.trades.filter(t => t.pnl > 0);
  const losses = result.trades.filter(t => t.pnl < 0);
  const winRate = result.trades.length ? (wins.length / result.trades.length) * 100 : 0;
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);

  return {
    symbol: result.symbol, startTime: result.startTime, endTime: result.endTime,
    startingEquity: result.startingEquity, endingEquity: result.endingEquity, totalTrades: result.trades.length,
    cagrPct: cagr * 100, sharpeRatio: sharpe, sortinoRatio: sortino, maxDrawdownPct: Math.abs(maxDrawdown) * 100,
    winRatePct: winRate, profitFactor: profitFactor === Infinity ? null : profitFactor, totalReturnPct: totalReturn * 100,
    equityCurve: result.equityCurve, trades: result.trades,
  };
}

if (typeof module !== 'undefined') module.exports = { runBacktest, computeMetrics };
