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
    bars.push({ t: new Date(start + i * 3600000).toISOString(), o: price, h: price * 1.005, l: price * 0.995, c: price, v: 1000 + rand() * 4000 });
  }
  return bars;
}
const mockBarsBySymbol = { NVDA: makeMockBars(260, 3, 0.003, 180), AMD: makeMockBars(260, 4, 0.001, 140) };

const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = url.toString();
  if (!u.includes("alpaca.markets") && !u.includes("api.anthropic.com")) {
    return realFetch(url, opts);
  }
  if (u.includes("api.anthropic.com")) {
    const body = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: `## Verdict\nModerately Bullish\n\n## Confidence\n62/100 - based on ${body.messages[0].content.includes("NVDA") ? "NVDA" : "the asset"} data provided.` }],
        usage: { input_tokens: 800, output_tokens: 200 },
      }),
    };
  }
  const stockSymbolMatch = u.match(/stocks\/([^/]+)\//);
  const stockSymbol = stockSymbolMatch ? decodeURIComponent(stockSymbolMatch[1]) : null;
  if (u.includes("/v1beta3/crypto/us/bars")) {
    const cryptoSymbolMatch = u.match(/symbols=([^&]+)/);
    const cryptoSymbol = cryptoSymbolMatch ? decodeURIComponent(cryptoSymbolMatch[1]) : "BTC/USD";
    return { ok: true, json: async () => ({ bars: { [cryptoSymbol]: mockBarsBySymbol.NVDA } }) };
  }
  if (u.includes("/bars") && stockSymbol) return { ok: true, json: async () => ({ bars: mockBarsBySymbol[stockSymbol] || mockBarsBySymbol.NVDA, symbol: stockSymbol }) };
  if (u.includes("/v1beta1/news")) return { ok: true, json: async () => ({ news: [] }) };
  throw new Error("unexpected fetch: " + u);
};

process.env.ALPACA_RATE_LIMIT_PER_MIN = "100000"; // tests mock fetch, no real throttling needed
process.env.APCA_API_KEY_ID = "test_key";
process.env.APCA_API_SECRET_KEY = "test_secret";
process.env.ANTHROPIC_API_KEY = "sk-ant-test";
process.env.ALPACA_STOCK_FEED = "iex";

const { createApp } = require("../server/index.js");

async function startTestServer() {
  const testDbPath = `/tmp/test_analyst_${Date.now()}_${Math.random().toString(36).slice(2)}.sqlite`;
  const { app } = createApp({ dbPath: testDbPath });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return { port: server.address().port, server, testDbPath };
}
async function cleanup(ctx) {
  await new Promise((r) => ctx.server.close(r));
  for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(ctx.testDbPath + suffix)) fs.unlinkSync(ctx.testDbPath + suffix);
}

test("chat route: full flow from message to AI response with real evidence attached", async () => {
  const ctx = await startTestServer();
  const base = `http://localhost:${ctx.port}`;

  const res = await fetch(`${base}/api/analyst/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Analyze NVDA", sessionId: "s1", horizon: "short_term" }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.symbol, "NVDA");
  assert.ok(body.reply.includes("Moderately Bullish"));
  assert.ok(body.payload.currentPrice > 0, "real price should be attached as evidence");
  assert.ok(body.payload.sources.length > 0, "evidence sources should be populated");
  console.log("PASS: chat route full flow -", body.reply.slice(0, 40));

  await cleanup(ctx);
});

test("chat route: chat memory - follow-up question without a symbol reuses context", async () => {
  const ctx = await startTestServer();
  const base = `http://localhost:${ctx.port}`;

  let res = await fetch(`${base}/api/analyst/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Analyze NVDA", sessionId: "s2", horizon: "short_term" }),
  });
  await res.json();

  res = await fetch(`${base}/api/analyst/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "What about the downside?", sessionId: "s2", horizon: "short_term" }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.symbol, "NVDA", "follow-up should remember NVDA from the prior turn, not misfire on DOWN(SIDE)");
  console.log("PASS: chat memory correctly carries the symbol across turns, and the DOWNSIDE bug stays fixed in the real route");

  await cleanup(ctx);
});

test("chat route: comparison mode builds both assets' evidence", async () => {
  const ctx = await startTestServer();
  const base = `http://localhost:${ctx.port}`;

  const res = await fetch(`${base}/api/analyst/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Compare NVDA vs AMD", sessionId: "s3", horizon: "short_term" }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.ok(body.payload.comparison, "should be flagged as a comparison payload");
  assert.strictEqual(body.payload.assetA.asset, "NVDA");
  assert.strictEqual(body.payload.assetB.asset, "AMD");
  console.log("PASS: comparison mode builds real evidence for both assets");

  await cleanup(ctx);
});

test("chat route: no symbol and no memory asks for clarification instead of guessing", async () => {
  const ctx = await startTestServer();
  const base = `http://localhost:${ctx.port}`;

  const res = await fetch(`${base}/api/analyst/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Should I buy something today?", sessionId: "s4" }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.symbol, null);
  assert.ok(body.reply.toLowerCase().includes("symbol") || body.reply.toLowerCase().includes("ticker"));
  console.log("PASS: correctly asks for a symbol instead of guessing -", body.reply);

  await cleanup(ctx);
});

test("chat route: Market Overview button now works (previously a confirmed bug)", async () => {
  const ctx = await startTestServer();
  const base = `http://localhost:${ctx.port}`;

  const res = await fetch(`${base}/api/analyst/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "What is happening in the market?", sessionId: "s6" }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.isMarketOverview, true);
  assert.ok(body.payload.assets.length > 0, "should have real data for multiple market assets, not a generic non-answer");
  assert.ok(body.payload.assets.some(a => a.asset === "QQQ"));
  assert.ok(body.payload.assets.some(a => a.asset === "BTC/USD"));
  assert.ok(!body.reply.toLowerCase().includes("i don't have a symbol"), "must not fall through to the old broken response");
  console.log("PASS: Market Overview now returns real multi-asset data instead of the old 'no symbol' bug ->", body.payload.assets.map(a => a.asset));

  await cleanup(ctx);
});

test("chat route: missing Anthropic key surfaces a clear error, not a fake analysis", async () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete require.cache[require.resolve("../server/config.js")];
  delete require.cache[require.resolve("../server/index.js")];
  const { createApp: createAppNoKey } = require("../server/index.js");

  const testDbPath = `/tmp/test_analyst_nokey_${Date.now()}.sqlite`;
  const { app } = createAppNoKey({ dbPath: testDbPath });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;

  const res = await fetch(`http://localhost:${port}/api/analyst/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Analyze NVDA", sessionId: "s5" }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 502);
  assert.ok(body.error.includes("ANTHROPIC_API_KEY"));
  console.log("PASS: missing Anthropic key fails clearly, no fake analysis returned -", body.error);

  await new Promise((r) => server.close(r));
  for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(testDbPath + suffix)) fs.unlinkSync(testDbPath + suffix);
  process.env.ANTHROPIC_API_KEY = savedKey;
});
