"use strict";
const { technicalAgent, trendAgent } = require("../lib/agents.js");

/**
 * Real, explainable Volume score - relative volume (today vs. recent average) plus OBV
 * trend confirmation, the same signals technicalAgent already uses internally, surfaced
 * here as its own dedicated category since the scorecard spec calls for Volume separately
 * from Momentum. Never an arbitrary number - every point is traceable to the calculation.
 */
function volumeScore(bars) {
  if (bars.length < 10) {
    return { score: null, label: "Insufficient Data", why: `Only ${bars.length} bars available - need at least 10 to assess volume trends.` };
  }
  const recent = bars.slice(-10);
  const volumes = recent.map((b) => b.volume);
  const avgVolume = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
  const lastVolume = volumes[volumes.length - 1];
  const relativeVolume = avgVolume > 0 ? lastVolume / avgVolume : 1;

  const obvSlope = recent[recent.length - 1].obv - recent[0].obv;
  const priceSlope = recent[recent.length - 1].close - recent[0].close;
  const obvConfirms = (obvSlope > 0 && priceSlope > 0) || (obvSlope < 0 && priceSlope < 0);

  let score = 50;
  const reasons = [];
  if (relativeVolume > 1.5) { score += 20; reasons.push(`Volume is ${relativeVolume.toFixed(1)}x the recent average - unusually high activity.`); }
  else if (relativeVolume < 0.5) { score -= 15; reasons.push(`Volume is only ${relativeVolume.toFixed(1)}x the recent average - unusually thin.`); }
  else { reasons.push(`Volume is ${relativeVolume.toFixed(1)}x the recent average - roughly normal.`); }

  if (obvConfirms) { score += 15; reasons.push("On-Balance Volume confirms the recent price direction."); }
  else { score -= 10; reasons.push("On-Balance Volume is diverging from the recent price direction - weaker confirmation."); }

  score = Math.max(0, Math.min(100, score));
  return { score: Math.round(score), label: scoreLabel(score), why: reasons.join(" ") };
}

function scoreLabel(score) {
  if (score >= 70) return "Strong";
  if (score >= 55) return "Favorable";
  if (score >= 45) return "Neutral";
  if (score >= 30) return "Weak";
  return "Very Weak";
}

/**
 * Builds the Trend/Momentum/Volume scorecard from real indexed bars (already computed
 * via computeAllIndicators). Returns null category entries (not fabricated scores) when
 * there genuinely isn't enough data - matches the spec's "do not make arbitrary scores"
 * requirement exactly.
 */
function buildScorecard(indexedBars, symbol) {
  if (indexedBars.length < 15) {
    return {
      trend: { score: null, label: "Insufficient Data", why: "Not enough historical bars." },
      momentum: { score: null, label: "Insufficient Data", why: "Not enough historical bars." },
      volume: { score: null, label: "Insufficient Data", why: "Not enough historical bars." },
    };
  }
  const trend = trendAgent(indexedBars);
  const momentum = technicalAgent(indexedBars);
  const volume = volumeScore(indexedBars);

  return {
    trend: { score: Math.round(trend.score), label: scoreLabel(trend.score), why: trend.rationale },
    momentum: { score: Math.round(momentum.score), label: scoreLabel(momentum.score), why: momentum.rationale },
    volume,
  };
}

module.exports = { buildScorecard, volumeScore, scoreLabel };
