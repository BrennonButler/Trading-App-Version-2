"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { AlpacaRestClient } = require("../server/services/alpacaRestClient.js");

test("getHistoricalBars normalizes stock bars correctly, sends auth headers not query params", async () => {
  let capturedUrl, capturedHeaders;
  global.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts.headers;
    return {
      ok: true,
      json: async () => ({
        bars: [
          { t: "2026-01-01T00:00:00Z", o: 100, h: 105, l: 99, c: 103, v: 123456 },
          { t: "2026-01-02T00:00:00Z", o: 103, h: 108, l: 102, c: 107, v: 234567 },
        ],
        symbol: "AAPL", next_page_token: null,
      }),
    };
  };

  const client = new AlpacaRestClient({ keyId: "mykey", secretKey: "mysecret" });
  const bars = await client.getHistoricalBars({ symbol: "AAPL", assetType: "stock", timeframe: "1Day", limit: 2, feed: "iex" });

  assert.strictEqual(bars.length, 2);
  assert.deepStrictEqual(bars[0], {
    type: "bar", symbol: "AAPL", assetType: "stock", open: 100, high: 105, low: 99, close: 103,
    volume: 123456, timestamp: "2026-01-01T00:00:00Z", timeframe: "1Day", source: "alpaca", feed: "iex",
  });

  // Critical security check: secret must be in headers, never in the URL
  assert.ok(!capturedUrl.includes("mysecret"), "secret leaked into URL!");
  assert.strictEqual(capturedHeaders["APCA-API-KEY-ID"], "mykey");
  assert.strictEqual(capturedHeaders["APCA-API-SECRET-KEY"], "mysecret");
  console.log("PASS: stock bars normalized correctly, credentials sent as headers not query params");
});

test("getHistoricalBars normalizes crypto bars correctly (nested by symbol)", async () => {
  global.fetch = async (url) => ({
    ok: true,
    json: async () => ({
      bars: { "BTC/USD": [{ t: "2026-01-01T00:00:00Z", o: 65000, h: 65500, l: 64800, c: 65200, v: 12.5 }] },
      next_page_token: null,
    }),
  });
  const client = new AlpacaRestClient({ keyId: "k", secretKey: "s" });
  const bars = await client.getHistoricalBars({ symbol: "BTC/USD", assetType: "crypto", timeframe: "1Hour", limit: 1 });
  assert.strictEqual(bars.length, 1);
  assert.strictEqual(bars[0].close, 65200);
  assert.strictEqual(bars[0].assetType, "crypto");
  console.log("PASS: crypto bars (nested-by-symbol shape) normalized correctly");
});

test("missing credentials throws a clear error before attempting any request", async () => {
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
  const client = new AlpacaRestClient({ keyId: "", secretKey: "" });
  await assert.rejects(
    () => client.getHistoricalBars({ symbol: "AAPL", assetType: "stock" }),
    /credentials are not configured/
  );
  assert.strictEqual(fetchCalled, false, "should not attempt a network call with no credentials");
  console.log("PASS: missing credentials fail fast without a wasted request");
});

test("API error response (e.g. bad symbol) surfaces a clear error, not a crash", async () => {
  global.fetch = async () => ({ ok: false, status: 404, statusText: "Not Found", json: async () => ({ message: "symbol not found" }) });
  const client = new AlpacaRestClient({ keyId: "k", secretKey: "s" });
  await assert.rejects(
    () => client.getHistoricalBars({ symbol: "FAKE", assetType: "stock" }),
    /Alpaca REST error \(404\)/
  );
  console.log("PASS: API errors surface clearly");
});

test("getLatestSnapshot combines trade + quote for a stock", async () => {
  global.fetch = async (url) => {
    if (url.includes("/trades/latest")) return { ok: true, json: async () => ({ trade: { p: 123.45, s: 100, t: "2026-01-01T00:00:00Z" } }) };
    if (url.includes("/quotes/latest")) return { ok: true, json: async () => ({ quote: { bp: 123.40, bs: 5, ap: 123.50, as: 3, t: "2026-01-01T00:00:01Z" } }) };
    throw new Error("unexpected url " + url);
  };
  const client = new AlpacaRestClient({ keyId: "k", secretKey: "s" });
  const snap = await client.getLatestSnapshot({ symbol: "AAPL", assetType: "stock", feed: "iex" });
  assert.strictEqual(snap.latestTrade.price, 123.45);
  assert.strictEqual(snap.latestQuote.bidPrice, 123.40);
  assert.strictEqual(snap.latestQuote.askPrice, 123.50);
  console.log("PASS: latest snapshot combines trade+quote correctly");
});
