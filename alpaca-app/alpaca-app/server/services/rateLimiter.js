"use strict";

/**
 * Sliding-window rate limiter for Alpaca API calls, shared across every client in this
 * app (REST bars, assets, news, screener). Alpaca's real, documented free-tier limit is
 * 200 requests/minute - this enforces a safe 170/min ceiling, actually guaranteed rather
 * than assumed from "chunk pacing should probably be slow enough in practice."
 *
 * Why this matters: the scanner's chunking (25 symbols per request, a fixed pause between
 * chunks) was sized assuming real network latency would naturally throttle things enough.
 * That's an assumption, not a guarantee - if Alpaca responds faster than assumed, a large
 * "scan everything" run could hit the real rate limit and start failing requests partway
 * through, exactly when the feature matters most. This makes the limit actually true no
 * matter how fast responses come back, by delaying calls itself when needed.
 */
class RateLimiter {
  constructor({ maxPerWindow = 170, windowMs = 60000 } = {}) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
    this.timestamps = []; // call times still inside the current trailing window
  }

  async acquire() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxPerWindow) {
      const oldestInWindow = this.timestamps[0];
      const waitMs = this.windowMs - (now - oldestInWindow) + 10; // +10ms safety margin
      await new Promise((resolve) => setTimeout(resolve, Math.max(waitMs, 0)));
      return this.acquire(); // re-check after waiting - other calls may have queued too
    }

    this.timestamps.push(Date.now());
  }
}

// One shared limiter instance for the whole app - Alpaca's limit is account-wide, not
// per-endpoint, so every client (bars, assets, news, screener) must share the same budget.
// Configurable via env var so tests (which mock fetch and don't need real throttling,
// since nothing is actually hitting Alpaca's servers) can disable it rather than have
// every mocked call artificially paced too.
const sharedAlpacaLimiter = new RateLimiter({
  maxPerWindow: parseInt(process.env.ALPACA_RATE_LIMIT_PER_MIN || "170", 10),
  windowMs: 60000,
});

/** Drop-in replacement for fetch() to any Alpaca endpoint - waits for rate-limit budget first. */
async function rateLimitedFetch(url, options) {
  await sharedAlpacaLimiter.acquire();
  return fetch(url, options);
}

module.exports = { RateLimiter, rateLimitedFetch, sharedAlpacaLimiter };
