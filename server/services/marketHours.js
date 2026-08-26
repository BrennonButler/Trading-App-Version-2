"use strict";

/**
 * Determines US stock market session status (pre-market/open/after-hours/closed) for a
 * given moment. Crypto markets are always open (24/7), handled separately by the caller.
 *
 * Honest limitation: this checks weekday + time-of-day only, via the real America/New_York
 * timezone (correctly handles EST/EDT daylight saving transitions through Node's built-in
 * ICU data) - it does NOT know about US market holidays (Thanksgiving, Christmas, etc.), so
 * it will incorrectly report "closed" as the reason on a holiday rather than naming the
 * holiday, and will say "open" during regular hours on a holiday when the market is actually
 * closed. This is disclosed rather than silently wrong.
 */
function getUSStockMarketStatus(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit",
  }).formatToParts(now);
  const map = {};
  parts.forEach((p) => { map[p.type] = p.value; });

  const weekday = map.weekday;
  const minutesSinceMidnight = parseInt(map.hour, 10) * 60 + parseInt(map.minute, 10);

  if (weekday === "Sat" || weekday === "Sun") {
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

function getMarketStatus(assetType, now = new Date()) {
  if (assetType === "crypto") return { status: "open", label: "Crypto Markets (24/7)", note: null };
  return getUSStockMarketStatus(now);
}

module.exports = { getUSStockMarketStatus, getMarketStatus };
