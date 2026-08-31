"use strict";

/**
 * Tiny in-memory TTL cache, shared across Alpaca clients. Historical bars for a symbol
 * don't change once a bar has closed - if the Scanner just fetched AAPL's daily bars and
 * the AI Analyst asks about AAPL 10 seconds later, there's no reason to hit Alpaca again
 * for the exact same data. Deliberately short-lived (default 45s) so intraday/live data
 * never goes meaningfully stale - this is about avoiding redundant calls seconds apart,
 * not long-term caching.
 */
class TTLCache {
  constructor({ ttlMs = 45000 } = {}) {
    this.ttlMs = ttlMs;
    this.store = new Map(); // key -> { value, expiresAt }
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Calls fetchFn only on a cache miss; stores and returns the fresh result otherwise. */
  async getOrFetch(key, fetchFn) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const fresh = await fetchFn();
    this.set(key, fresh);
    return fresh;
  }
}

// Shared instance for historical bars specifically - one cache, reused across every
// AlpacaRestClient call site (Scanner, AI Analyst, Backtest, direct API requests).
const barsCache = new TTLCache({ ttlMs: 45000 });

module.exports = { TTLCache, barsCache };
