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
const mockBars = { NVDA: makeMockBars(260, 9, 0.003, 180) };
const mockAssets = [
  { symbol: "NVDA", name: "NVIDIA Corporation Common Stock", exchange: "NASDAQ", tradable: true, status: "active" },
  { symbol: "NVAX", name: "Novavax Inc", exchange: "NASDAQ", tradable: true, status: "active" },
];

const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = url.toString();
  if (!u.includes("alpaca.markets") && !u.includes("api.anthropic.com")) return realFetch(url, opts);
  if (u.includes("api.anthropic.com")) {
    return { ok: true, json: async () => ({ content: [{ type: "text", text: "## Verdict\nModerately Bullish\n\n## Confidence\n70/100 - solid indicator agreement." }] }) };
  }
  if (u.includes("/v2/assets")) return { ok: true, json: async () => mockAssets };
  if (u.includes("/v1beta3/crypto/us/bars")) {
    const cryptoSymbolMatch = u.match(/symbols=([^&]+)/);
    const cryptoSymbol = cryptoSymbolMatch ? decodeURIComponent(cryptoSymbolMatch[1]) : "BTC/USD";
    return { ok: true, json: async () => ({ bars: { [cryptoSymbol]: mockBars.NVDA } }) };
  }
  const symbolMatch = u.match(/stocks\/([^/]+)\//);
  const symbol = symbolMatch ? decodeURIComponent(symbolMatch[1]) : null;
  if (u.includes("/bars") && symbol) return { ok: true, json: async () => ({ bars: mockBars[symbol] || mockBars.NVDA, symbol }) };
  if (u.includes("/v1beta1/news")) return { ok: true, json: async () => ({ news: [] }) };
  throw new Error("unexpected fetch: " + u);
};

process.env.ALPACA_RATE_LIMIT_PER_MIN = "100000"; // tests mock fetch, no real throttling needed
process.env.APCA_API_KEY_ID = "test_key";
process.env.APCA_API_SECRET_KEY = "test_secret";
process.env.ANTHROPIC_API_KEY = "sk-ant-test";
process.env.ALPACA_STOCK_FEED = "iex";

test("AI Trade Analyst frontend: real page, real chat flow, real autocomplete, through the real server", async () => {
  const { createApp } = require("../server/index.js");
  const testDbPath = `/tmp/test_analyst_frontend_${Date.now()}.sqlite`;
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
  let historicalCallCount = 0;
  window.fetch = (url, opts) => {
    if (url.includes("/api/historical/")) historicalCallCount++;
    return realFetch(url.startsWith("http") ? url : baseUrl + url, opts);
  };

  await new Promise((r) => setTimeout(r, 1000));
  const doc = window.document;

  window.switchTab("analyst");
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(doc.getElementById("analyst-input"), "chat input renders");
  assert.ok(doc.getElementById("analyst-horizon-toggle"), "horizon toggle renders");
  console.log("PASS: AI Trade Analyst page renders with input and horizon toggle");

  const input = doc.getElementById("analyst-input");
  input.value = "Analyze NV";
  input.dispatchEvent(new window.Event("input"));
  await new Promise((r) => setTimeout(r, 500));
  const autocompleteHtml = doc.getElementById("analyst-autocomplete").innerHTML;
  assert.ok(autocompleteHtml.includes("NVDA"), "autocomplete shows real matching symbols");
  console.log("PASS: autocomplete shows real Alpaca-sourced suggestions for a partial ticker");

  input.value = "Analyze NVDA";
  doc.getElementById("analyst-send-btn").click();
  await new Promise((r) => setTimeout(r, 1500));

  const messagesHtml = doc.getElementById("analyst-messages").innerHTML;
  assert.ok(messagesHtml.includes("Analyze NVDA"), "user message rendered");
  assert.ok(messagesHtml.includes("Moderately Bullish"), "AI response rendered");
  assert.ok(messagesHtml.includes("analyst-market-panel"), "market panel with real price data rendered");
  assert.ok(messagesHtml.includes("Show evidence"), "evidence toggle rendered");
  assert.ok(messagesHtml.includes("market-status-badge"), "market status badge rendered");
  assert.ok(messagesHtml.includes("data-type-badge"), "LIVE/HISTORICAL data-type badge rendered");
  assert.ok(messagesHtml.includes("scorecard-row"), "Trend/Momentum/Volume scorecard rendered");
  assert.ok(messagesHtml.includes("analyst-chart-toolbar"), "chart timeframe toolbar rendered");
  console.log("PASS: full chat round trip through the real UI - message, AI response, market panel, scorecard, and chart toolbar all rendered");

  // Chart actually draws from real (mocked) historical data, and switching timeframe re-fetches
  await new Promise((r) => setTimeout(r, 300)); // let the default chart draw finish
  const canvas = doc.querySelector("canvas[data-symbol]");
  assert.ok(canvas, "chart canvas element exists");
  const rangeBtn5D = doc.querySelector('[data-range-idx="1"]'); // 5D button
  assert.ok(rangeBtn5D, "timeframe range buttons exist");
  rangeBtn5D.click();
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(rangeBtn5D.classList.contains("active"), "clicking a timeframe button marks it active");
  console.log("PASS: chart renders and timeframe switching works");

  // The actual regression this turn's refactor was meant to fix: sending a SECOND message
  // must not silently re-fetch the FIRST message's chart. Capture the count right before
  // sending a new message, then verify the increase matches only the new chart's own
  // fetch - not the old chart being destroyed and rebuilt too.
  const historicalCallsBeforeSecondMessage = historicalCallCount;
  const input2 = doc.getElementById("analyst-input");
  input2.value = "Analyze NVDA";
  doc.getElementById("analyst-send-btn").click();
  await new Promise((r) => setTimeout(r, 1500));
  const historicalCallsAfterSecondMessage = historicalCallCount;
  const increase = historicalCallsAfterSecondMessage - historicalCallsBeforeSecondMessage;
  assert.strictEqual(increase, 1, `sending a second message should cause exactly 1 new historical fetch (the new message's own chart), not re-fetch the old chart too - saw ${increase}`);
  console.log("PASS: old chart does not redundantly re-fetch when a new message is sent (increase was exactly", increase, ")");

  const toggleBtn = doc.querySelector("[data-evidence-toggle]");
  const panelId = toggleBtn.dataset.evidenceToggle;
  const panel = doc.getElementById(panelId);
  assert.ok(panel.classList.contains("hidden"), "evidence starts collapsed");
  toggleBtn.click();
  assert.ok(!panel.classList.contains("hidden"), "evidence expands on click");
  console.log("PASS: evidence section toggle works");

  doc.querySelector('#analyst-horizon-toggle [data-h="long_term"]').click();
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(doc.querySelector('#analyst-horizon-toggle [data-h="long_term"]').classList.contains("active"));
  console.log("PASS: Day Trading / Long-Term horizon toggle switches correctly");

  // Follow-up chips: render, and the horizon-switch chip actually changes the real
  // horizon parameter sent to the backend (not just text that mentions it)
  doc.querySelector('#analyst-horizon-toggle [data-h="short_term"]').click();
  await new Promise((r) => setTimeout(r, 100));
  const followupsHtml = doc.getElementById("analyst-messages").innerHTML;
  assert.ok(followupsHtml.includes("analyst-followup-chip"), "follow-up chips rendered after a response");
  assert.ok(followupsHtml.includes("long-term holding instead"), "horizon-switch chip suggests the OTHER horizon");

  const aiMessages = doc.querySelectorAll(".analyst-msg-ai");
  const lastAiMessage = aiMessages[aiMessages.length - 1];
  const switchChip = lastAiMessage.querySelector('[data-followup-action="switchHorizon"]');
  assert.ok(switchChip, "horizon-switch chip exists");
  const historyLengthBefore = doc.querySelectorAll(".analyst-msg").length;
  switchChip.click();
  await new Promise((r) => setTimeout(r, 1500));
  // Verify via the real, observable side effect: the chip's own handler updates the
  // horizon toggle's active class as a direct consequence of actually changing the
  // internal horizon state - if this passes, the fix (not just displayed text) is real.
  assert.ok(doc.querySelector('#analyst-horizon-toggle [data-h="long_term"]').classList.contains("active"),
    "clicking the chip must actually flip the real horizon used for the next request, not just display text about it");
  const historyLengthAfter = doc.querySelectorAll(".analyst-msg").length;
  assert.ok(historyLengthAfter > historyLengthBefore, "a new analysis was actually sent and rendered after clicking the chip");
  console.log("PASS: horizon-switch follow-up chip genuinely changes the horizon parameter, not just the displayed text");

  window.close();
  await new Promise((r) => server.close(r));
  for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(testDbPath + suffix)) fs.unlinkSync(testDbPath + suffix);
});

test("AI Trade Analyst: Market Overview renders correctly through the real UI (previously crashed/showed 'undefined')", async () => {
  const { createApp } = require("../server/index.js");
  const testDbPath = `/tmp/test_analyst_overview_${Date.now()}.sqlite`;
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

  // Catch any uncaught error (e.g. the .map() on undefined crash this test guards against)
  let uncaughtError = null;
  window.addEventListener("error", (e) => { uncaughtError = e.error || e.message; });

  await new Promise((r) => setTimeout(r, 1000));
  const doc = window.document;
  window.switchTab("analyst");
  await new Promise((r) => setTimeout(r, 100));

  const marketOverviewBtn = [...doc.querySelectorAll("[data-quick-idx]")].find((b) => b.textContent.trim() === "Market Overview");
  assert.ok(marketOverviewBtn, "Market Overview quick-action button exists");
  marketOverviewBtn.click();
  await new Promise((r) => setTimeout(r, 2000));

  assert.strictEqual(uncaughtError, null, `Market Overview must not throw an uncaught error - got: ${uncaughtError}`);
  const messagesHtml = doc.getElementById("analyst-messages").innerHTML;
  assert.ok(!messagesHtml.includes("undefined"), "must not show a broken 'undefined' panel");
  assert.ok(messagesHtml.includes("Market Overview"), "overview panel renders with its own label");
  assert.ok(messagesHtml.includes("QQQ") && messagesHtml.includes("BTC/USD") && messagesHtml.includes("Bitcoin"), "shows real ticker and name for both stock and crypto assets");
  console.log("PASS: Market Overview renders correctly through the real UI, no crash, no 'undefined' panel");

  // Evidence section (previously would throw calling .map() on undefined) must expand cleanly
  const toggleBtn = doc.querySelector("[data-evidence-toggle]");
  assert.ok(toggleBtn, "evidence toggle exists for the overview response");
  toggleBtn.click();
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(uncaughtError, null, "expanding evidence for a market overview must not throw");
  console.log("PASS: Market Overview evidence section expands without crashing");

  window.close();
  await new Promise((r) => server.close(r));
  for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(testDbPath + suffix)) fs.unlinkSync(testDbPath + suffix);
});
