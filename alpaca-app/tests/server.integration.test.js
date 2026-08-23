"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");

function makeMockBars(n, seed, drift, startPrice) {
  let x = seed;
  const rand = () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
  let price = startPrice;
  const bars = [];
  const start = Date.parse("2025-01-01T00:00:00Z");
  for (let i = 0; i < n; i++) {
    price *= (1 + drift + (rand() - 0.5) * 0.02);
    bars.push({
      t: new Date(start + i * 3600000).toISOString(),
      o: price, h: price * (1 + rand() * 0.005), l: price * (1 - rand() * 0.005), c: price, v: 1000 + rand() * 4000,
    });
  }
  return bars;
}

const mockBarsBySymbol = {
  AAPL: makeMockBars(320, 11, 0.004, 190),
  TSLA: makeMockBars(320, 22, -0.004, 250),
};

const realFetch = global.fetch;

global.fetch = async (url, opts) => {
  const u = url.toString();
  if (!u.includes("alpaca.markets")) {
    return realFetch(url, opts); // pass through our own test-server calls (localhost) untouched
  }
  const symbolMatch = u.match(/stocks\/([^/]+)\/bars/) || u.match(/stocks\/([^/]+)\/(trades|quotes)\/latest/);
  const symbol = symbolMatch ? decodeURIComponent(symbolMatch[1]) : null;

  if (u.includes("/bars") && symbol) {
    const bars = mockBarsBySymbol[symbol] || makeMockBars(320, 99, 0.001, 100);
    return { ok: true, json: async () => ({ bars, symbol, next_page_token: null }) };
  }
  if (u.includes("/trades/latest") && symbol) {
    const bars = mockBarsBySymbol[symbol] || makeMockBars(2, 1, 0, 100);
    const last = bars[bars.length - 1];
    return { ok: true, json: async () => ({ trade: { p: last.c, s: 100, t: last.t } }) };
  }
  if (u.includes("/quotes/latest") && symbol) {
    const bars = mockBarsBySymbol[symbol] || makeMockBars(2, 1, 0, 100);
    const last = bars[bars.length - 1];
    return { ok: true, json: async () => ({ quote: { bp: last.c - 0.05, bs: 1, ap: last.c + 0.05, as: 1, t: last.t } }) };
  }
  throw new Error("Unexpected Alpaca fetch in test: " + u);
};

process.env.APCA_API_KEY_ID = "test_key";
process.env.APCA_API_SECRET_KEY = "test_secret";
process.env.ALPACA_STOCK_FEED = "iex";

const { createApp } = require("../server/index.js");

async function startTestServer() {
  const testDbPath = `/tmp/test_server_${Date.now()}_${Math.random().toString(36).slice(2)}.sqlite`;
  const { app } = createApp({ dbPath: testDbPath });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  return {
    port, server, testDbPath,
    async close() {
      await new Promise((r) => server.close(r));
      for (const suffix of ["", "-wal", "-shm"]) {
        if (fs.existsSync(testDbPath + suffix)) fs.unlinkSync(testDbPath + suffix);
      }
    },
  };
}

test("full paper trading lifecycle: scan -> open -> portfolio -> close -> history", async () => {
  const ctx = await startTestServer();
  const base = `http://localhost:${ctx.port}`;

  let res = await fetch(`${base}/api/status`);
  let body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.alpacaConfigured, true);
  assert.strictEqual(body.stockFeed, "iex");
  console.log("PASS: /api/status");

  res = await fetch(`${base}/api/scan`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbols: [{ symbol: "AAPL", assetType: "stock" }, { symbol: "TSLA", assetType: "stock" }], horizon: "short_term" }),
  });
  body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.results.length, 2);
  assert.ok(body.results.every((r) => r.signal || r.error));
  console.log("PASS: /api/scan ->", body.results.map((r) => r.signal ? `${r.signal.symbol}:${r.signal.direction}(${Math.round(r.signal.masterConfidence)})` : `${r.symbol}:ERROR`));

  res = await fetch(`${base}/api/portfolio`);
  body = await res.json();
  assert.strictEqual(body.cashBalance, 10000);
  assert.strictEqual(body.openPositionsCount, 0);
  console.log("PASS: initial portfolio at starting balance");

  res = await fetch(`${base}/api/positions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol: "AAPL", assetType: "stock", direction: "long", positionSizePct: 10, stopLoss: 1, takeProfit: 99999, horizon: "short_term", entryConfidence: 70 }),
  });
  body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.ok(body.id > 0);
  assert.strictEqual(body.symbol, "AAPL");
  const tradeId = body.id;
  console.log("PASS: opened position, id =", tradeId, "qty =", body.quantity);

  res = await fetch(`${base}/api/portfolio`);
  body = await res.json();
  assert.strictEqual(body.openPositionsCount, 1);
  assert.ok(body.cashBalance < 10000);
  console.log("PASS: portfolio reflects open position");

  res = await fetch(`${base}/api/positions`);
  body = await res.json();
  assert.strictEqual(body.length, 1);
  console.log("PASS: /api/positions lists it");

  res = await fetch(`${base}/api/positions/${tradeId}/exit-check`);
  body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.ok(["hold", "watch", "exit"].includes(body.urgency));
  console.log("PASS: exit-check ->", body.urgency, "-", body.headline);

  res = await fetch(`${base}/api/positions/${tradeId}/close`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "manual" }),
  });
  body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.status, "closed");
  console.log("PASS: closed position, pnl =", body.pnl);

  res = await fetch(`${base}/api/portfolio`);
  body = await res.json();
  assert.strictEqual(body.openPositionsCount, 0);
  console.log("PASS: portfolio shows 0 open positions after close");

  res = await fetch(`${base}/api/trades`);
  body = await res.json();
  assert.strictEqual(body.length, 1);
  assert.strictEqual(body[0].status, "closed");
  console.log("PASS: trade history shows the closed trade");

  res = await fetch(`${base}/api/logs`);
  body = await res.json();
  assert.ok(body.length >= 2, `expected at least 2 log entries, got ${body.length}`);
  console.log("PASS: logs recorded", body.length, "entries");

  res = await fetch(`${base}/api/backtest`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol: "AAPL", assetType: "stock", horizon: "short_term", startingEquity: 10000, positionSizePct: 10 }),
  });
  body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.ok(typeof body.totalTrades === "number");
  console.log("PASS: backtest ->", body.totalTrades, "trades, Sharpe", body.sharpeRatio && body.sharpeRatio.toFixed(2));

  res = await fetch(`${base}/api/allocate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ budget: 2000, symbols: [{ symbol: "AAPL", assetType: "stock" }, { symbol: "TSLA", assetType: "stock" }], minConfidence: 40, horizon: "auto" }),
  });
  body = await res.json();
  assert.strictEqual(res.status, 200);
  console.log("PASS: allocator ->", body.message);

  res = await fetch(`${base}/api/settings`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stockSymbols: ["AAPL", "TSLA", "NVDA"] }),
  });
  assert.strictEqual(res.status, 200);
  res = await fetch(`${base}/api/settings`);
  body = await res.json();
  assert.deepStrictEqual(body.stockSymbols, ["AAPL", "TSLA", "NVDA"]);
  console.log("PASS: settings persist across requests");

  await ctx.close();
});

test("server restart rehydrates open positions from the database", async () => {
  const ctx1 = await startTestServer();
  const base1 = `http://localhost:${ctx1.port}`;

  let res = await fetch(`${base1}/api/positions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol: "AAPL", assetType: "stock", direction: "long", positionSizePct: 10, horizon: "long_term" }),
  });
  const opened = await res.json();
  const dbPath = ctx1.testDbPath;
  await new Promise((r) => ctx1.server.close(r));

  const { createApp } = require("../server/index.js");
  const { app: app2 } = createApp({ dbPath });
  const server2 = app2.listen(0);
  await new Promise((resolve) => server2.once("listening", resolve));
  const port2 = server2.address().port;

  res = await fetch(`http://localhost:${port2}/api/positions`);
  const positions = await res.json();
  assert.strictEqual(positions.length, 1);
  assert.strictEqual(positions[0].symbol, "AAPL");
  assert.strictEqual(positions[0].id, opened.id);
  console.log("PASS: open position survives a server restart (rehydrated from SQLite)");

  await new Promise((r) => server2.close(r));
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
});

test("risk limits are enforced through the real HTTP API, not just in-memory", async () => {
  const ctx = await startTestServer();
  const base = `http://localhost:${ctx.port}`;

  let lastStatus;
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${base}/api/positions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: "AAPL", assetType: "stock", direction: "long", positionSizePct: 5, horizon: "short_term" }),
    });
    lastStatus = res.status;
    if (res.status !== 200) {
      const body = await res.json();
      console.log("PASS: risk limit correctly enforced over HTTP on attempt", i + 1, "-", body.error);
      break;
    }
  }
  assert.notStrictEqual(lastStatus, 200, "expected the risk limit to eventually reject a position");
  await ctx.close();
});
