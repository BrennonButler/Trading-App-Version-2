// Technical indicators — pure functions over arrays. Every formula here was verified
// bar-by-bar against the Python `ta` library's actual output (not just the textbook
// formula) since several indicators have non-obvious seeding/smoothing conventions that
// differ from the "standard" formula in subtle but numerically significant ways.

// Matches pandas' `series.ewm(alpha=..., min_periods=minPeriods, adjust=False).mean()`
// exactly: recursion starts from the first non-null value, output is masked null until
// `minPeriods` valid observations have accumulated.
function ewmAdjustFalse(values, alpha, minPeriods) {
  const out = new Array(values.length).fill(null);
  let prev = null;
  let validCount = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) continue;
    prev = (prev === null) ? values[i] : (values[i] * alpha + prev * (1 - alpha));
    validCount++;
    if (validCount >= minPeriods) out[i] = prev;
  }
  return out;
}

function ema(values, period) {
  // ta library: series.ewm(span=period, min_periods=period, adjust=False).mean()
  return ewmAdjustFalse(values, 2 / (period + 1), period);
}

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function rsi(closes, period = 14) {
  // ta library's RSIIndicator: Wilder's smoothing via ewm(alpha=1/period, adjust=False)
  // on separate up/down move series. Crucially, pandas' diff(1).where(diff>0, 0.0) treats
  // index 0 as a valid 0.0 observation (NaN>0 is False, so it's replaced with 0.0) rather
  // than null — this shifts exactly when `minPeriods` starts counting.
  const n = closes.length;
  const upDir = new Array(n).fill(0.0);
  const downDir = new Array(n).fill(0.0);
  for (let i = 1; i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    upDir[i] = diff > 0 ? diff : 0.0;
    downDir[i] = diff < 0 ? -diff : 0.0;
  }
  const alpha = 1 / period;
  const emaUp = ewmAdjustFalse(upDir, alpha, period);
  const emaDown = ewmAdjustFalse(downDir, alpha, period);

  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (emaUp[i] == null || emaDown[i] == null) continue;
    out[i] = emaDown[i] === 0 ? 100 : 100 - (100 / (1 + emaUp[i] / emaDown[i]));
  }
  return out;
}

function rollingMin(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1);
    if (window.some(v => v == null)) continue;
    out[i] = Math.min(...window);
  }
  return out;
}
function rollingMax(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1);
    if (window.some(v => v == null)) continue;
    out[i] = Math.max(...window);
  }
  return out;
}
function rollingMean(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1);
    if (window.some(v => v == null)) continue;
    out[i] = window.reduce((a, b) => a + b, 0) / period;
  }
  return out;
}

function stochRsi(closes, period = 14, smooth1 = 3, smooth2 = 3) {
  // ta's StochRSIIndicator: rolling min/max of the RSI series itself (not raw price),
  // then a `smooth1`-period rolling-mean smoothing applied to %K (easy to miss - the
  // "stochrsi_k" output is NOT the raw stochastic RSI, it's already smoothed).
  const rsiVals = rsi(closes, period);
  const lowestLow = rollingMin(rsiVals, period);
  const highestHigh = rollingMax(rsiVals, period);
  const rawStochRsi = rsiVals.map((v, i) => {
    if (v == null || lowestLow[i] == null || highestHigh[i] == null) return null;
    const range = highestHigh[i] - lowestLow[i];
    return range === 0 ? null : (v - lowestLow[i]) / range;
  });
  const k = rollingMean(rawStochRsi, smooth1);
  const d = rollingMean(k, smooth2);
  return { stochRsi: rawStochRsi, k, d };
}

function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) => (emaFast[i] != null && emaSlow[i] != null) ? emaFast[i] - emaSlow[i] : null);
  const signalLine = ema(macdLine, signalPeriod);
  const hist = macdLine.map((v, i) => (v != null && signalLine[i] != null) ? v - signalLine[i] : null);
  return { macdLine, signalLine, hist };
}

function bollingerBands(closes, period = 20, stdDevMult = 2) {
  const middle = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const window = closes.slice(i - period + 1, i + 1);
    const mean = middle[i];
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    upper[i] = mean + stdDevMult * std;
    lower[i] = mean - stdDevMult * std;
  }
  return { upper, middle, lower };
}

function atr(highs, lows, closes, period = 14) {
  const n = closes.length;
  const tr = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i === 0) { tr[i] = highs[i] - lows[i]; continue; }
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  const out = new Array(n).fill(null);
  let prevAtr = null;
  for (let i = 0; i < n; i++) {
    if (i === period - 1) {
      prevAtr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
      out[i] = prevAtr;
    } else if (i >= period) {
      prevAtr = (prevAtr * (period - 1) + tr[i]) / period;
      out[i] = prevAtr;
    }
  }
  return out;
}

function adx(highs, lows, closes, period = 14) {
  const n = closes.length;
  const plusDM = new Array(n).fill(0), minusDM = new Array(n).fill(0), tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  const smooth = (arr) => {
    const out = new Array(n).fill(null);
    let prev = null;
    for (let i = 0; i < n; i++) {
      if (i === period) { prev = arr.slice(1, period + 1).reduce((a, b) => a + b, 0); out[i] = prev; }
      else if (i > period) { prev = prev - (prev / period) + arr[i]; out[i] = prev; }
    }
    return out;
  };
  const smTR = smooth(tr), smPlusDM = smooth(plusDM), smMinusDM = smooth(minusDM);
  const plusDI = new Array(n).fill(null), minusDI = new Array(n).fill(null), dx = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (smTR[i]) {
      plusDI[i] = (smPlusDM[i] / smTR[i]) * 100;
      minusDI[i] = (smMinusDM[i] / smTR[i]) * 100;
      const sum = plusDI[i] + minusDI[i];
      dx[i] = sum === 0 ? 0 : (Math.abs(plusDI[i] - minusDI[i]) / sum) * 100;
    }
  }
  const adxOut = new Array(n).fill(null);
  let prevAdx = null;
  const firstDxIdx = dx.findIndex(v => v != null);
  for (let i = 0; i < n; i++) {
    if (firstDxIdx < 0) break;
    if (i === firstDxIdx + period - 1) {
      const window = dx.slice(firstDxIdx, i + 1).filter(v => v != null);
      prevAdx = window.reduce((a, b) => a + b, 0) / window.length;
      adxOut[i] = prevAdx;
    } else if (i > firstDxIdx + period - 1) {
      prevAdx = (prevAdx * (period - 1) + dx[i]) / period;
      adxOut[i] = prevAdx;
    }
  }
  return { adx: adxOut, plusDI, minusDI };
}

function obv(closes, volumes) {
  // ta library: unchanged close counts as +volume (not flat), and bar 0 always adds
  // volume since there's no prior close to compare against (NaN comparison is False).
  const out = new Array(closes.length).fill(0);
  let cumulative = 0;
  for (let i = 0; i < closes.length; i++) {
    const isLess = i > 0 && closes[i] < closes[i - 1];
    cumulative += isLess ? -volumes[i] : volumes[i];
    out[i] = cumulative;
  }
  return out;
}

function ichimoku(highs, lows, w1 = 9, w2 = 26, w3 = 52) {
  const n = highs.length;
  const rollingMidpoint = (period, allowPartial = false) => {
    const out = new Array(n).fill(null);
    const startIdx = allowPartial ? 0 : period - 1;
    for (let i = startIdx; i < n; i++) {
      const windowStart = Math.max(0, i - period + 1);
      const hi = Math.max(...highs.slice(windowStart, i + 1));
      const lo = Math.min(...lows.slice(windowStart, i + 1));
      out[i] = (hi + lo) / 2;
    }
    return out;
  };
  const conversion = rollingMidpoint(w1);
  const base = rollingMidpoint(w2);
  const spanA = conversion.map((c, i) => (c != null && base[i] != null) ? (c + base[i]) / 2 : null);
  // ta library quirk: ichimoku_b specifically uses min_periods=0, so it returns a value
  // from a partial window rather than requiring the full window3 (52) bars like span A does.
  const spanB = rollingMidpoint(w3, true);
  return { conversion, base, spanA, spanB };
}

function findSupportResistance(highs, lows, lookback = 100, numLevels = 3) {
  const start = Math.max(0, highs.length - lookback);
  const pivotHighs = [], pivotLows = [];
  for (let i = start + 2; i < highs.length - 2; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2]) pivotHighs.push(highs[i]);
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2]) pivotLows.push(lows[i]);
  }
  return {
    resistance: pivotHighs.sort((a, b) => b - a).slice(0, numLevels),
    support: pivotLows.sort((a, b) => a - b).slice(0, numLevels),
  };
}

function computeAllIndicators(bars) {
  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume);

  const rsi14 = rsi(closes, 14);
  const stochRsiResult = stochRsi(closes, 14, 3, 3);
  const { macdLine, signalLine, hist } = macd(closes);
  const ema9 = ema(closes, 9), ema21 = ema(closes, 21), ema50 = ema(closes, 50);
  const ema100 = ema(closes, 100), ema200 = ema(closes, 200);
  const sma20 = sma(closes, 20);
  const bb = bollingerBands(closes, 20, 2);
  const atr14 = atr(highs, lows, closes, 14);
  const adxResult = adx(highs, lows, closes, 14);
  const obvVals = obv(closes, volumes);
  const ichi = ichimoku(highs, lows);

  return bars.map((bar, i) => ({
    ...bar,
    rsi14: rsi14[i], stochRsiK: stochRsiResult.k[i] != null ? stochRsiResult.k[i] * 100 : null,
    macd: macdLine[i], macdSignal: signalLine[i], macdHist: hist[i],
    ema9: ema9[i], ema21: ema21[i], ema50: ema50[i], ema100: ema100[i], ema200: ema200[i], sma20: sma20[i],
    bbUpper: bb.upper[i], bbMiddle: bb.middle[i], bbLower: bb.lower[i],
    atr14: atr14[i], adx: adxResult.adx[i], plusDI: adxResult.plusDI[i], minusDI: adxResult.minusDI[i],
    obv: obvVals[i],
    ichimokuA: ichi.spanA[i], ichimokuB: ichi.spanB[i],
  }));
}

if (typeof module !== 'undefined') {
  module.exports = { ema, sma, rsi, stochRsi, macd, bollingerBands, atr, adx, obv, ichimoku, findSupportResistance, computeAllIndicators };
}
