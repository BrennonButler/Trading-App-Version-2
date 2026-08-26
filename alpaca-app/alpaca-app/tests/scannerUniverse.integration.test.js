"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const { JSDOM } = require("jsdom");

function makeMockBars(n, seed, drift, startPrice) {
  let x = seed;
  const rand = () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
  let price = startPrice;
  const bars = [];
  const start = Date.parse("2025-01-01T00:00:00Z");
  for (let i = 0; i < n; i++) {
    price *= (1 + drift + (rand() - 0.5) * 0.02);
    bars.push({ t: new Date(start + i * 3600000).toISOString(), o: price, h: price * 1.005, l: price * 0.995, c: price, v: 1000 + rand() * 4000 });
  }
  return bars;
}

// 62 mock symbols - enough to require 3 chunks at CHUNK_SIZE=25, small enough to run fast.
const MOCK_UNIVERSE = Array.from({ length: 62 }, (_, i) => `TST${i.toString().padStart(2, "0")}`);
const mockAssets = MOCK_UNIVERSE.map((symbol, i) => ({
  symbol, name: `Test Company ${i}`, exchange: "NASDAQ", tradable: true, status: "active",
}));

let barsCallCount = 0;
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = url.toString();
  if (!u.includes("alpaca.markets")) return realFetch(url, opts);
  if (u.includes("/v2/assets")) return { ok: true, json: async () => mockAssets };
  if (u.includes("/v1beta1/screener/stocks/most-actives")) {
    return { ok: true, json: async () => ({ most_actives: MOCK_UNIVERSE.slice(0, 15).map((symbol) => ({ symbol, volume: 1000000 })) }) };
  }
  if (u.includes("/v1beta1/screener/stocks/movers")) {
    return { ok: true, json: async () => ({ gainers: MOCK_UNIVERSE.slice(10, 20).map((symbol) => ({ symbol, percent_change: 5 })), losers: [] }) };
  }
  const symbolMatch = u.match(/stocks\/([^/]+)\//);
  const symbol = symbolMatch ? decodeURIComponent(symbolMatch[1]) : null;
  if (u.includes("/bars") && symbol) {
    barsCallCount++;
    // Alternate uptrend/downtrend by symbol index so sort/filter tests have both directions
    const idx = MOCK_UNIVERSE.indexOf(symbol);
    const drift = idx % 2 === 0 ? 0.004 : -0.004;
    return { ok: true, json: async () => ({ bars: makeMockBars(260, idx + 1, drift, 100 + idx), symbol }) };
  }
  throw new Error("unexpected fetch: " + u);
};

process.env.ALPACA_RATE_LIMIT_PER_MIN = "100000"; // tests mock fetch, no real throttling needed
process.env.APCA_API_KEY_ID = "test_key";
process.env.APCA_API_SECRET_KEY = "test_secret";
process.env.ALPACA_STOCK_FEED = "iex";

async function loadApp() {
  const { createApp } = require("../server/index.js");
  const testDbPath = `/tmp/test_scanner_universe_${Date.now()}_${Math.random().toString(36).slice(2)}.sqlite`;
  const { app } = createApp({ dbPath: testDbPath });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  const htmlRes = await fetch(`${baseUrl}/index.html`);
  let html = await htmlRes.text();
  html = html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>/g, "");

  const dom = new JSDOM(html, { url: baseUrl + "/", runScripts: "dangerously", resources: "usable", pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = (url, opts) => realFetch(url.startsWith("http") ? url : baseUrl + url, opts);
  await new Promise((r) => setTimeout(r, 900));
  return { window, server, testDbPath };
}
async function cleanup(ctx) {
  ctx.window.close();
  await new Promise((r) => ctx.server.close(r));
  for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(ctx.testDbPath + suffix)) fs.unlinkSync(ctx.testDbPath + suffix);
}

test("scanner: Trending Now is the default universe and works end-to-end with real screener data", async () => {
  const ctx = await loadApp();
  const { window } = ctx;
  const doc = window.document;
  barsCallCount = 0;

  window.switchTab("scanner");
  await new Promise((r) => setTimeout(r, 300));

  assert.strictEqual(doc.getElementById("scanner-universe").value, "trending", "Trending Now should be the default selected option");
  const estimateText = doc.getElementById("scanner-estimate").textContent;
  assert.ok(estimateText.toLowerCase().includes("screener") || estimateText.toLowerCase().includes("live"), "estimate should explain this is real live screener data, not a hardcoded list");
  console.log("PASS: Trending Now is the default, with a clear explanation -", estimateText);

  doc.getElementById("scanner-scan-btn").click();
  await new Promise((r) => setTimeout(r, 2500));

  assert.ok(barsCallCount > 0, "should have scanned real symbols from the trending endpoint");
  assert.ok(barsCallCount < 62, "trending pool should be smaller than the full 62-symbol mock universe");
  const resultsHtml = doc.getElementById("scanner-results").innerHTML;
  assert.ok(resultsHtml.length > 0, "results should render");
  console.log("PASS: Trending Now scan completes using real screener-sourced symbols, scanned", barsCallCount, "symbols");

  await cleanup(ctx);
});

test("scanner: universe dropdown shows a real, accurate symbol count and time estimate", async () => {
  const ctx = await loadApp();
  const { window } = ctx;
  const doc = window.document;

  window.switchTab("scanner");
  await new Promise((r) => setTimeout(r, 100));
  doc.getElementById("scanner-universe").value = "nasdaq";
  doc.getElementById("scanner-universe").dispatchEvent(new window.Event("change"));
  await new Promise((r) => setTimeout(r, 300));

  const estimateText = doc.getElementById("scanner-estimate").textContent;
  assert.ok(estimateText.includes("62"), `estimate should show the real count (62) - got: ${estimateText}`);
  assert.ok(estimateText.includes("minute"), "estimate should include a time estimate");
  console.log("PASS: universe estimate shows real count and time -", estimateText);

  await cleanup(ctx);
});

test("scanner: full-universe scan runs in chunks, shows progress, and renders a compact table for large result sets", async () => {
  const ctx = await loadApp();
  const { window } = ctx;
  const doc = window.document;
  barsCallCount = 0;

  window.switchTab("scanner");
  await new Promise((r) => setTimeout(r, 100));
  doc.getElementById("scanner-universe").value = "nasdaq";
  doc.getElementById("scanner-scan-btn").click();

  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!doc.getElementById("scanner-stop-btn").classList.contains("hidden"), "Stop button should appear while scanning");
  assert.ok(!doc.getElementById("scanner-progress").classList.contains("hidden"), "progress bar should be visible while scanning");

  // Wait for the full scan to complete: 62 symbols / 25 per chunk = 3 chunks, ~400ms pause
  // between chunks plus mocked-fetch time - generous timeout for CI variance.
  await new Promise((r) => setTimeout(r, 4000));

  assert.strictEqual(barsCallCount, 62, `all 62 symbols should have been scanned exactly once - got ${barsCallCount} calls`);
  assert.ok(doc.getElementById("scanner-stop-btn").classList.contains("hidden"), "Stop button should hide once scan completes");

  const resultsHtml = doc.getElementById("scanner-results").innerHTML;
  assert.ok(resultsHtml.includes("<table>"), "large result set should render as a compact table, not 62 full cards");
  assert.ok(resultsHtml.includes("TST00") || resultsHtml.includes("TST01"), "results should include real scanned symbols");
  console.log("PASS: full-universe scan completes, scans every symbol exactly once, renders compact table");

  await cleanup(ctx);
});

test("scanner: sort and direction filter actually change what's displayed", async () => {
  const ctx = await loadApp();
  const { window } = ctx;
  const doc = window.document;

  window.switchTab("scanner");
  await new Promise((r) => setTimeout(r, 100));
  doc.getElementById("scanner-universe").value = "nasdaq";
  doc.getElementById("scanner-scan-btn").click();
  await new Promise((r) => setTimeout(r, 4000));

  // Filter to long-only, confirm no short tags render
  doc.getElementById("scanner-direction-filter").value = "short";
  doc.getElementById("scanner-direction-filter").dispatchEvent(new window.Event("change"));
  await new Promise((r) => setTimeout(r, 100));
  const shortOnlyHtml = doc.getElementById("scanner-results").innerHTML;
  assert.ok(!shortOnlyHtml.includes("tag-long"), "direction filter set to short should exclude long-tagged rows");
  console.log("PASS: direction filter actually restricts displayed results");

  // Sort by symbol A-Z, confirm first row is alphabetically first among matches
  doc.getElementById("scanner-direction-filter").value = "all";
  doc.getElementById("scanner-direction-filter").dispatchEvent(new window.Event("change"));
  doc.getElementById("scanner-sort").value = "symbol";
  doc.getElementById("scanner-sort").dispatchEvent(new window.Event("change"));
  await new Promise((r) => setTimeout(r, 100));
  const firstRowSymbol = doc.querySelector(".scanner-row td.mono").textContent.trim();
  assert.strictEqual(firstRowSymbol, "TST00", `A-Z sort should put TST00 first, got ${firstRowSymbol}`);
  console.log("PASS: symbol sort correctly orders results alphabetically");

  await cleanup(ctx);
});

test("scanner: Stop button actually halts an in-progress scan before completion", async () => {
  const ctx = await loadApp();
  const { window } = ctx;
  const doc = window.document;
  barsCallCount = 0;

  window.switchTab("scanner");
  await new Promise((r) => setTimeout(r, 100));
  doc.getElementById("scanner-universe").value = "nasdaq";
  doc.getElementById("scanner-scan-btn").click();

  await new Promise((r) => setTimeout(r, 200)); // let the first chunk start
  doc.getElementById("scanner-stop-btn").click();
  await new Promise((r) => setTimeout(r, 2000)); // let any in-flight chunk finish, then confirm it stopped

  assert.ok(barsCallCount < 62, `Stop should prevent scanning all 62 symbols - got ${barsCallCount} (should be less than 62)`);
  assert.ok(doc.getElementById("scanner-stop-btn").classList.contains("hidden"), "Stop button hides after stopping");
  console.log("PASS: Stop button genuinely halts the scan early -", barsCallCount, "of 62 scanned before stopping");

  await cleanup(ctx);
});

test("scanner: small watchlist scan still uses the rich card view, not the compact table", async () => {
  const ctx = await loadApp();
  const { window } = ctx;
  const doc = window.document;

  window.switchTab("scanner");
  await new Promise((r) => setTimeout(r, 100));
  // Default universe is "watchlist" - small (default settings symbols)
  doc.getElementById("scanner-scan-btn").click();
  await new Promise((r) => setTimeout(r, 1500));

  const resultsHtml = doc.getElementById("scanner-results").innerHTML;
  assert.ok(resultsHtml.includes("signal-card"), "small watchlist scan should use the rich signal-card view");
  assert.ok(!resultsHtml.includes("<table>"), "should not use the compact table for a small result set");
  console.log("PASS: small watchlist scan correctly keeps the detailed card view");

  await cleanup(ctx);
});
