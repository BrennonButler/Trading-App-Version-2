// Paper trading engine — operates on a plain, serializable state object so it can be
// persisted via window.storage and unit-tested without any browser APIs.

function createInitialState(startingBalance = 10000, riskLimits = {}) {
  return {
    startingBalance,
    trades: [],
    nextTradeId: 1,
    riskLimits: {
      maxRiskPerTradePct: riskLimits.maxRiskPerTradePct ?? 1.0,
      maxDailyLossPct: riskLimits.maxDailyLossPct ?? 3.0,
      maxPortfolioExposurePct: riskLimits.maxPortfolioExposurePct ?? 50.0,
      maxOpenPositions: riskLimits.maxOpenPositions ?? 5,
    },
  };
}

class RiskLimitExceeded extends Error {}

function getOpenPositions(state) { return state.trades.filter(t => t.status === 'open'); }
function getRealizedPnl(state) { return state.trades.filter(t => t.status !== 'open').reduce((sum, t) => sum + (t.pnl || 0), 0); }

function getCashBalance(state) {
  const realized = getRealizedPnl(state);
  const deployed = getOpenPositions(state).reduce((sum, t) => sum + t.entryPrice * t.quantity, 0);
  return state.startingBalance + realized - deployed;
}

function getPortfolioValue(state, priceFn) {
  const cash = getCashBalance(state);
  const openPositions = getOpenPositions(state);
  let positionsValue = 0;
  for (const pos of openPositions) {
    let price;
    try { price = priceFn(pos.symbol, pos.assetClass); } catch (e) { price = pos.entryPrice; }
    positionsValue += price * pos.quantity;
  }
  return { cashBalance: cash, positionsValue, totalEquity: cash + positionsValue, openPositionsCount: openPositions.length };
}

function checkRiskLimits(state, notionalValue, priceFn) {
  const portfolio = getPortfolioValue(state, priceFn);
  const openPositions = getOpenPositions(state);
  const limits = state.riskLimits;

  if (openPositions.length >= limits.maxOpenPositions) throw new RiskLimitExceeded(`Max open positions (${limits.maxOpenPositions}) reached`);

  const exposurePct = portfolio.totalEquity > 0 ? (portfolio.positionsValue + notionalValue) / portfolio.totalEquity * 100 : 100;
  if (exposurePct > limits.maxPortfolioExposurePct) {
    throw new RiskLimitExceeded(`Trade would bring portfolio exposure to ${exposurePct.toFixed(1)}%, exceeding the ${limits.maxPortfolioExposurePct}% limit`);
  }

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todaysLoss = state.trades
    .filter(t => t.status !== 'open' && t.closedAt && new Date(t.closedAt) >= todayStart && t.pnl < 0)
    .reduce((sum, t) => sum + t.pnl, 0);
  const dailyLossPct = Math.abs(todaysLoss) / state.startingBalance * 100;
  if (dailyLossPct >= limits.maxDailyLossPct) {
    throw new RiskLimitExceeded(`Daily loss limit reached (${dailyLossPct.toFixed(1)}% >= ${limits.maxDailyLossPct}%). No new trades until tomorrow.`);
  }
}

function openPosition(state, { symbol, assetClass, direction, positionSizePct, absoluteAmount, stopLoss, takeProfit, signalId, horizon, entryConfidence }, priceFn) {
  const entryPrice = priceFn(symbol, assetClass);
  const portfolio = getPortfolioValue(state, priceFn);
  // absoluteAmount (exact dollar amount, e.g. from the budget allocator) takes priority
  // over positionSizePct (percent of current portfolio equity, e.g. from the scanner) -
  // these are deliberately different sizing modes for different callers.
  let notionalValue = absoluteAmount != null ? absoluteAmount : portfolio.totalEquity * (positionSizePct / 100);
  if (notionalValue > portfolio.cashBalance) notionalValue = portfolio.cashBalance;

  checkRiskLimits(state, notionalValue, priceFn);
  if (notionalValue <= 0 || entryPrice <= 0) throw new RiskLimitExceeded('Insufficient cash balance or invalid price to open a position');

  const quantity = notionalValue / entryPrice;
  const trade = {
    id: state.nextTradeId++, symbol, assetClass, direction, entryPrice, quantity,
    stopLoss: stopLoss ?? null, takeProfit: takeProfit ?? null,
    horizon: horizon === 'long_term' ? 'long_term' : 'short_term',
    entryConfidence: entryConfidence ?? null,
    openedAt: new Date().toISOString(), closedAt: null,
    status: 'open', pnl: null, pnlPct: null, closeReason: null, signalId: signalId ?? null, exitPrice: null,
  };
  state.trades.push(trade);
  return trade;
}

function closePosition(state, tradeId, reason, priceFn) {
  const trade = state.trades.find(t => t.id === tradeId && t.status === 'open');
  if (!trade) throw new Error(`No open trade found with id ${tradeId}`);

  const exitPrice = priceFn(trade.symbol, trade.assetClass);
  trade.exitPrice = exitPrice;
  trade.closedAt = new Date().toISOString();
  trade.pnl = trade.direction === 'long' ? (exitPrice - trade.entryPrice) * trade.quantity : (trade.entryPrice - exitPrice) * trade.quantity;
  trade.pnlPct = (trade.pnl / (trade.entryPrice * trade.quantity)) * 100;
  trade.status = reason === 'manual' ? 'closed' : reason;
  trade.closeReason = reason;
  return trade;
}

function checkStopsAndTargets(state, priceFn) {
  const closed = [];
  for (const trade of getOpenPositions(state)) {
    let currentPrice;
    try { currentPrice = priceFn(trade.symbol, trade.assetClass); } catch (e) { continue; }

    let hitStop = false, hitTarget = false;
    if (trade.direction === 'long') {
      hitStop = trade.stopLoss != null && currentPrice <= trade.stopLoss;
      hitTarget = trade.takeProfit != null && currentPrice >= trade.takeProfit;
    } else {
      hitStop = trade.stopLoss != null && currentPrice >= trade.stopLoss;
      hitTarget = trade.takeProfit != null && currentPrice <= trade.takeProfit;
    }

    if (hitStop) closed.push(closePosition(state, trade.id, 'stopped_out', priceFn));
    else if (hitTarget) closed.push(closePosition(state, trade.id, 'target_hit', priceFn));
  }
  return closed;
}

if (typeof module !== 'undefined') {
  module.exports = { createInitialState, RiskLimitExceeded, getOpenPositions, getCashBalance, getPortfolioValue, openPosition, closePosition, checkStopsAndTargets };
}
