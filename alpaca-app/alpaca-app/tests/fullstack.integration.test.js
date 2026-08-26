"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const WebSocket = require("ws");
const { JSDOM } = require("jsdom");

function makeMockBars(n, seed, drift, startPrice) {
  let x = seed;
  const rand = () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
  let price = startPrice;
  const bars = [];
  const start = Date.parse("2025-01-01T00:00:00Z");
  for (let i = 0; i < n; i++) {
    price *= (1 + drift + (rand() - 0.5) * 0.02);
    bars.push({ t: new Date(start + i * 3600000).toISOString(), o: price, h: price * 1.005, l: price * 0.995, c: price, v: 1000 });
  }
  return bars;
}
const mockBars = { AAPL: makeMockBars(320, 5, 0.004, 190) };

const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = url.toString();
  if (!u.includes("alpaca.markets")) return realFetch(url, opts);
  const symbolMatch = u.match(/stocks\/([^/]+)\//);
  const symbol = symbolMatch ? decodeURIComponent(symbolMatch[1]) : null;
  if (u.includes("/bars") && symbol) return { ok: true, json: async () => ({ bars: mockBars[symbol] || mockBars.AAPL, symbol }) };
  if (u.includes("/trades/latest")) { const b = (mockBars[symbol] || mockBars.AAPL).slice(-1)[0]; return { ok: true, json: async () => ({ trade: { p: b.c, s: 100, t: b.t } }) }; }
  if (u.includes("/quotes/latest")) { const b = (mockBars[symbol] || mockBars.AAPL).slice(-1)[0]; return { ok: true, json: async () => ({ quote: { bp: b.c - 0.05, bs: 1, ap: b.c + 0.05, as: 1, t: b.t } }) }; }
  throw new Error("unexpected alpaca fetch: " + u);
};

function startMockAlpacaWs(port) {
  const wss = new WebSocket.Server({ port });
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify([{ T: "success", msg: "connected" }]));
    const tickIntervals = new Map(); // one interval PER symbol, not shared - matches real concurrent subscriptions
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.action === "auth") ws.send(JSON.stringify([{ T: "success", msg: "authenticated" }]));
      else if (msg.action === "subscribe" && msg.trades) {
        ws.send(JSON.stringify([{ T: "subscription", trades: msg.trades }]));
        for (const symbol of msg.trades) {
          if (tickIntervals.has(symbol)) continue; // already ticking, don't double-subscribe
          const interval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify([{ T: "t", S: symbol, p: 191.23 + Math.random(), s: 50, t: new Date().toISOString() }]));
            }
          }, 200);
          tickIntervals.set(symbol, interval);
        }
      } else if (msg.action === "unsubscribe" && msg.trades) {
        for (const symbol of msg.trades) {
          if (tickIntervals.has(symbol)) { clearInterval(tickIntervals.get(symbol)); tickIntervals.delete(symbol); }
        }
      }
    });
    ws.on("close", () => { for (const interval of tickIntervals.values()) clearInterval(interval); });
  });
  return wss;
}

process.env.ALPACA_RATE_LIMIT_PER_MIN = "100000"; // tests mock fetch, no real throttling needed
process.env.APCA_API_KEY_ID = "test_key";
process.env.APCA_API_SECRET_KEY = "test_secret";
process.env.ALPACA_STOCK_FEED = "iex";

test("full stack: real frontend HTML/JS + real server + live data over our own WebSocket", async () => {
  const stockWsPort = 8930, cryptoWsPort = 8931;
  const stockMock = startMockAlpacaWs(stockWsPort);
  const cryptoMock = startMockAlpacaWs(cryptoWsPort);

  const { createServer } = require("../server/index.js");
  const testDbPath = `/tmp/test_fullstack_${Date.now()}.sqlite`;
  const { server, marketData } = createServer({
    dbPath: testDbPath,
    stockWsUrls: { iex: `ws://localhost:${stockWsPort}`, sip: `ws://localhost:${stockWsPort}`, delayed_sip: `ws://localhost:${stockWsPort}` },
    cryptoWsUrl: `ws://localhost:${cryptoWsPort}`,
  });
  marketData.start();

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  await new Promise((r) => setTimeout(r, 400));

  const htmlRes = await fetch(`${baseUrl}/index.html`);
  const html = await htmlRes.text();
  assert.ok(html.includes("Signalwright"), "served the real frontend HTML");

  const dom = new JSDOM(html, { url: baseUrl + "/", runScripts: "dangerously", resources: "usable", pretendToBeVisual: true });
  const { window } = dom;
  window.fetch = (url, opts) => realFetch(url.startsWith("http") ? url : baseUrl + url, opts);

  await new Promise((r) => setTimeout(r, 1000)); // jsdom init (6 script tags + DOMContentLoaded) observed to take ~800ms

  const doc = window.document;
  assert.ok(window.App, "frontend App object initialized");
  assert.strictEqual(window.App.activeTab, "watchlist", "lands on the live watchlist by default");

  const watchlistHtml = doc.getElementById("page-watchlist").innerHTML;
  assert.ok(watchlistHtml.includes("AAPL") || watchlistHtml.includes("BTC/USD"), "watchlist shows configured symbols");

  let receivedLiveData = null;
  window.App.liveFeed.subscribe("AAPL", "stock", (data) => { receivedLiveData = data; });

  await new Promise((r) => setTimeout(r, 1000));

  assert.ok(receivedLiveData, "received at least one message over our own WebSocket end-to-end");
  console.log("PASS: full round trip - mock Alpaca -> real marketDataService -> real /ws -> real browser WebSocket client. Received:", JSON.stringify(receivedLiveData).slice(0, 150));

  await new Promise((resolve) => { window.switchTab("scanner"); setTimeout(resolve, 50); });
  doc.getElementById("scanner-scan-btn").click();
  await new Promise((r) => setTimeout(r, 1500));
  const scannerHtml = doc.getElementById("scanner-results").innerHTML;
  assert.ok(scannerHtml.includes("signal-card"), "scanner produced real signal cards via the real backend");
  console.log("PASS: Scanner tab works end-to-end through the real server");

  await new Promise((r) => server.close(r));
  marketData.stop();
  stockMock.close(); cryptoMock.close();
  for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(testDbPath + suffix)) fs.unlinkSync(testDbPath + suffix);
});

