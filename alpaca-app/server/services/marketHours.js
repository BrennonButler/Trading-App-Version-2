"use strict";
const { rateLimitedFetch } = require("./rateLimiter.js");
const { TTLCache } = require("./cache.js");

/**
 * Determines US stock market session status (pre-market/open/after-hours/closed) for a
 * given moment, using Alpaca's real trading calendar when credentials are available - so
 * holidays (Thanksgiving, Christmas, etc.) and holiday-shortened sessions (e.g. the day
 * after Thanksgiving closing early) are correctly reflected, not assumed from weekday +
 * a hardcoded 9:30-4:00 window. Crypto markets are always open (24/7), handled separately
 * by the caller and never touches this calendar lookup at all.
 *
 * If no credentials are given, or the real calendar lookup fails (network error, bad
 * credentials, etc.), this falls back to the same honest weekday-only heuristic used
 * before - correct on ordinary days, but unable to tell a holiday apart from a normal
 * closed day, and that limitation is disclosed via `note` rather than hidden.
 */

// Alpaca's trading calendar barely changes once published - caching a whole trading day's
// worth avoids hitting the trading API on every single status check across every request.
const calendarCache = new TTLCache({ ttlMs: 12 * 60 * 60 * 1000 }); // 12 hours

function nyDateParts(now) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit",
  }).formatToParts(now);
  const map = {};
  parts.forEach((p) => { map[p.type] = p.value; });
  return map;
}

/**
 * Fetches (and caches) Alpaca's real trading calendar entry for one date. Uses
 * paper-api.alpaca.markets - the same host every other trading-API call in this app uses,
 * since paper API keys are not authorized against the live api.alpaca.markets host. Returns
 * null when Alpaca confirms the date is not a trading day at all (weekend or holiday).
 */
async function fetchCalendarDay({ keyId, secretKey, baseUrl = "https://paper-api.alpaca.markets" }, dateStr) {
  const cacheKey = `calendar|${dateStr}`;
  return calendarCache.getOrFetch(cacheKey, async () => {
    const url = new URL(`${baseUrl}/v2/calendar`);
    url.searchParams.set("start", dateStr);
    url.searchParams.set("end", dateStr);
    const res = await rateLimitedFetch(url.toString(), {
      headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secretKey },
    });
    if (!res.ok) throw new Error(`Alpaca calendar API error (${res.status})`);
    const days = await res.json();
    return days[0] || null;
  });
}

function weekdayHeuristic(map, minutesSinceMidnight) {
  const isWeekend = map.weekday === "Sat" || map.weekday === "Sun";
  if (isWeekend) {
    return { status: "closed", label: "Market Closed (weekend)", note: "Does not account for market holidays." };
  }
  const PRE_MARKET_START = 4 * 60;
  const REGULAR_START = 9 * 60 + 30;
  const REGULAR_END = 16 * 60;
  const AFTER_HOURS_END = 20 * 60;
  if (minutesSinceMidnight >= REGULAR_START && minutesSinceMidnight < REGULAR_END) {
    return { status: "open", label: "Market Open", note: "Does not account for market holidays." };
  }
  if (minutesSinceMidnight >= PRE_MARKET_START && minutesSinceMidnight < REGULAR_START) {
    return { status: "pre-market", label: "Pre-Market", note: "Does not account for market holidays." };
  }
  if (minutesSinceMidnight >= REGULAR_END && minutesSinceMidnight < AFTER_HOURS_END) {
    return { status: "after-hours", label: "After-Hours", note: "Does not account for market holidays." };
  }
  return { status: "closed", label: "Market Closed", note: "Does not account for market holidays." };
}

async function getUSStockMarketStatus(now = new Date(), credentials = null) {
  const map = nyDateParts(now);
  const dateStr = `${map.year}-${map.month}-${map.day}`;
  const minutesSinceMidnight = parseInt(map.hour, 10) * 60 + parseInt(map.minute, 10);

  if (credentials && credentials.keyId && credentials.secretKey) {
    try {
      const day = await fetchCalendarDay(credentials, dateStr);
      if (!day) {
        // Alpaca confirms this specific date is not a trading day - correctly distinguishes
        // a real market holiday from an ordinary weekend, rather than guessing from weekday.
        const isWeekend = map.weekday === "Sat" || map.weekday === "Sun";
        return { status: "closed", label: isWeekend ? "Market Closed (weekend)" : "Market Closed (holiday)", note: null };
      }
      // day.open / day.close are "HH:MM" in America/New_York and correctly reflect
      // holiday-shortened sessions (e.g. an early 1:00pm close) - never assumed to always
      // be the standard 9:30-4:00 window.
      const [openH, openM] = day.open.split(":").map(Number);
      const [closeH, closeM] = day.close.split(":").map(Number);
      const openMinutes = openH * 60 + openM;
      const closeMinutes = closeH * 60 + closeM;
      const preMarketStart = openMinutes - 330; // same 4:00am ET pre-market start as before
      const afterHoursEnd = closeMinutes + 240; // same 8:00pm ET after-hours end as before

      if (minutesSinceMidnight >= openMinutes && minutesSinceMidnight < closeMinutes) {
        return { status: "open", label: "Market Open", note: null };
      }
      if (minutesSinceMidnight >= preMarketStart && minutesSinceMidnight < openMinutes) {
        return { status: "pre-market", label: "Pre-Market", note: null };
      }
      if (minutesSinceMidnight >= closeMinutes && minutesSinceMidnight < afterHoursEnd) {
        return { status: "after-hours", label: "After-Hours", note: null };
      }
      return { status: "closed", label: "Market Closed", note: null };
    } catch (e) {
      // Real Alpaca lookup failed (network error, credentials issue, etc.) - fall through
      // to the honest weekday-only heuristic below rather than breaking the whole payload.
    }
  }

  return weekdayHeuristic(map, minutesSinceMidnight);
}

async function getMarketStatus(assetType, now = new Date(), credentials = null) {
  if (assetType === "crypto") return { status: "open", label: "Crypto Markets (24/7)", note: null };
  return getUSStockMarketStatus(now, credentials);
}

module.exports = { getUSStockMarketStatus, getMarketStatus };
