// Exit signal checker — this is what answers "when should I pull out?" for an open
// position, distinct from the hard stop-loss/take-profit price levels. It re-runs the
// exact same evaluateMaster() scoring on fresh data and compares it to the position's
// entry thesis: if the signal has weakened or reversed, it says so with a plain-English
// reason, even though price hasn't hit the stop or target yet.

// trade: { direction, entryConfidence, horizon, symbol } — entryConfidence should be
// stored on the trade at open time (the masterConfidence from the signal that opened it).
// currentSignal: fresh evaluateMaster() output for the same symbol/horizon right now.
function checkExitSignal(trade, currentSignal) {
  const entryDirection = trade.direction;
  const entryConfidence = trade.entryConfidence ?? 50;
  const nowDirection = currentSignal.direction;
  const nowConfidence = currentSignal.masterConfidence;

  const reversed = (entryDirection === 'long' && nowDirection === 'short')
    || (entryDirection === 'short' && nowDirection === 'long');

  if (reversed) {
    return {
      urgency: 'exit',
      headline: `Signal has reversed to ${nowDirection.toUpperCase()}`,
      reason: `You entered ${entryDirection.toUpperCase()} at ${entryConfidence.toFixed(0)} confidence. ` +
        `The current read is now ${nowDirection.toUpperCase()} at ${nowConfidence.toFixed(0)} confidence — the original thesis has flipped.`,
      currentConfidence: nowConfidence, entryConfidence,
      supportingFactors: entryDirection === 'long' ? currentSignal.bearishFactors.slice(0, 3) : currentSignal.bullishFactors.slice(0, 3),
    };
  }

  // Weakening: confidence has dropped meaningfully toward neutral (50) since entry,
  // even though direction hasn't fully flipped yet.
  const confidenceDrop = entryDirection === 'long'
    ? entryConfidence - nowConfidence
    : nowConfidence - entryConfidence;

  if (confidenceDrop >= 15) {
    return {
      urgency: 'watch',
      headline: 'Conviction has weakened since you entered',
      reason: `Confidence has moved from ${entryConfidence.toFixed(0)} to ${nowConfidence.toFixed(0)} in the direction away from your position. ` +
        `Not a reversal yet, but worth watching closely — consider tightening your stop.`,
      currentConfidence: nowConfidence, entryConfidence,
      supportingFactors: entryDirection === 'long' ? currentSignal.bearishFactors.slice(0, 3) : currentSignal.bullishFactors.slice(0, 3),
    };
  }

  return {
    urgency: 'hold',
    headline: 'Thesis still intact',
    reason: `Confidence is at ${nowConfidence.toFixed(0)} (entered at ${entryConfidence.toFixed(0)}) and direction hasn't reversed. No action needed beyond your existing stop-loss/take-profit.`,
    currentConfidence: nowConfidence, entryConfidence,
    supportingFactors: [],
  };
}

if (typeof module !== 'undefined') module.exports = { checkExitSignal };
