"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const WebSocket = require("ws");
const { MarketDataService, isValidSymbol, classifyFreshness } = require("../server/services/marketDataService.js");

// ---------- Pure function tests (no network needed) ----------

test("isValidSymbol accepts real-looking symbols, rejects garbage", () => {
  assert.strictEqual(isValidSymbol("AAPL", "stock"), true);
  assert.strictEqual(isValidSymbol("BRK.B", "stock"), true);
  assert.strictEqual(isValidSymbol("BTC/USD", "crypto"), true);
  assert.strictEqual(isValidSymbol("", "stock"), false);
  assert.strictEqual(isValidSymbol("<script>alert(1)</script>", "stock"), false);
  assert.strictEqual(isValidSymbol("AAPL; DROP TABLE users;", "stock"), false);
  assert.strictEqual(isValidSymbol("BTCUSD", "crypto"), false); // missing slash
  assert.strictEqual(isValidSymbol(null, "stock"), false);
  assert.strictEqual(isValidSymbol(123, "stock"), false);
  console.log("PASS: symbol validation rejects malformed/malicious input");
});

test("classifyFreshness respects per-type thresholds", () => {
  assert.strictEqual(classifyFreshness("trade", 1000), "live");
  assert.strictEqual(classifyFreshness("trade", 10000), "recent");
  assert.strictEqual(classifyFreshness("trade", 60000), "stale");
  assert.strictEqual(classifyFreshness("bar", 60000), "live"); // bars get more slack than trades
  assert.strictEqual(classifyFreshness("bar", 400000), "stale");
  console.log("PASS: freshness classification is type-aware");
});

// ---------- Integration tests against a local mock Alpaca server ----------

function startMockAlpacaServer(port) {
  const subscribeLog = [];
  const wss = new WebSocket.Server({ port });
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify([{ T: "success", msg: "connected" }]));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.action === "auth") ws.send(JSON.stringify([{ T: "success", msg: "authenticated" }]));
      else if (msg.action === "subscribe") subscribeLog.push(msg);
      else if (msg.action === "unsubscribe") subscribeLog.push(msg);
    });
  });
  return { wss, subscribeLog };
}

test("two clients subscribing to the same symbol creates only ONE upstream subscription", async () => {
  const stockPort = 8911, cryptoPort = 8912;
  const stockMock = startMockAlpacaServer(stockPort);
  const cryptoMock = startMockAlpacaServer(cryptoPort);

  // Monkey-patch the WS URLs the service will use, pointing at our local mocks
  const marketDataServiceModule = require("../server/services/marketDataService.js");
  marketDataServiceModule.STOCK_WS_URLS.iex = `ws://localhost:${stockPort}`;
  marketDataServiceModule.CRYPTO_WS_URL = `ws://localhost:${cryptoPort}`;

  const service = new MarketDataService({ keyId: "k", secretKey: "s", stockFeed: "iex" });
  service.start();
  await new Promise((r) => setTimeout(r, 400)); // let both feeds connect+auth

  const r1 = service.subscribeClient("client-A", "AAPL", "stock");
  const r2 = service.subscribeClient("client-B", "AAPL", "stock"); // same symbol, different client
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r2.ok, true);

  await new Promise((r) => setTimeout(r, 200));

  const subscribeMessages = stockMock.subscribeLog.filter((m) => m.action === "subscribe");
  assert.strictEqual(subscribeMessages.length, 1, `expected exactly 1 upstream subscribe message, got ${subscribeMessages.length}`);
  assert.deepStrictEqual(subscribeMessages[0].trades, ["AAPL"]);

  // Now client-A disconnects but client-B is still subscribed - AAPL should NOT be unsubscribed
  service.disconnectClient("client-A");
  await new Promise((r) => setTimeout(r, 150));
  const unsubMessages1 = stockMock.subscribeLog.filter((m) => m.action === "unsubscribe");
  assert.strictEqual(unsubMessages1.length, 0, "should not unsubscribe while client-B still wants AAPL");

  // client-B disconnects too - NOW it should unsubscribe upstream
  service.disconnectClient("client-B");
  await new Promise((r) => setTimeout(r, 150));
  const unsubMessages2 = stockMock.subscribeLog.filter((m) => m.action === "unsubscribe");
  assert.strictEqual(unsubMessages2.length, 1, "should unsubscribe once the last interested client disconnects");

  service.stop();
  stockMock.wss.close();
  cryptoMock.wss.close();
  console.log("PASS: one shared upstream subscription regardless of client count, correct ref-counted cleanup");
});

test("invalid symbol is rejected before ever touching the upstream connection", async () => {
  const stockPort = 8913, cryptoPort = 8914;
  const stockMock = startMockAlpacaServer(stockPort);
  const cryptoMock = startMockAlpacaServer(cryptoPort);
  const marketDataServiceModule = require("../server/services/marketDataService.js");
  marketDataServiceModule.STOCK_WS_URLS.iex = `ws://localhost:${stockPort}`;
  marketDataServiceModule.CRYPTO_WS_URL = `ws://localhost:${cryptoPort}`;

  const service = new MarketDataService({ keyId: "k", secretKey: "s" });
  service.start();
  await new Promise((r) => setTimeout(r, 300));

  const result = service.subscribeClient("client-A", "<script>bad</script>", "stock");
  assert.strictEqual(result.ok, false);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(stockMock.subscribeLog.filter((m) => m.action === "subscribe").length, 0);

  service.stop();
  stockMock.wss.close();
  cryptoMock.wss.close();
  console.log("PASS: malformed symbol never reaches the upstream provider");
});

test("getMarketSnapshot returns 'disconnected' for a symbol with no data yet", () => {
  const service = new MarketDataService({ keyId: "", secretKey: "" });
  const snap = service.getMarketSnapshot("AAPL", "stock");
  assert.strictEqual(snap.freshness, "disconnected");
  assert.strictEqual(snap.latestTrade, null);
  console.log("PASS: unknown symbol correctly reports disconnected, not fake data");
});

test("missing credentials: start() records a config error and does not throw", () => {
  const service = new MarketDataService({ keyId: "", secretKey: "" });
  assert.doesNotThrow(() => service.start());
  assert.ok(service.configErrors.length > 0);
  console.log("PASS: missing credentials handled gracefully with a clear config error");
});
