"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const WebSocket = require("ws");
const { AlpacaFeedClient } = require("../server/services/alpacaFeedClient.js");

function startMockAlpacaServer(port, behavior) {
  const wss = new WebSocket.Server({ port });
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify([{ T: "success", msg: "connected" }]));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      behavior(ws, msg);
    });
  });
  return wss;
}

test("successful auth + subscribe + receives normalized trade", async () => {
  const port = 8901;
  const wss = startMockAlpacaServer(port, (ws, msg) => {
    if (msg.action === "auth") {
      if (msg.key === "goodkey" && msg.secret === "goodsecret") {
        ws.send(JSON.stringify([{ T: "success", msg: "authenticated" }]));
      } else {
        ws.send(JSON.stringify([{ T: "error", code: 402, msg: "auth failed" }]));
      }
    } else if (msg.action === "subscribe") {
      ws.send(JSON.stringify([{ T: "subscription", trades: msg.trades || [] }]));
      if (msg.trades && msg.trades.length) {
        ws.send(JSON.stringify([{ T: "t", S: msg.trades[0], p: 123.45, s: 100, t: "2026-01-01T00:00:00Z" }]));
      }
    }
  });

  const client = new AlpacaFeedClient({
    url: `ws://localhost:${port}`, keyId: "goodkey", secretKey: "goodsecret", assetType: "stock", feed: "iex",
  });

  const receivedData = [];
  const authPromise = new Promise((resolve) => client.once("authenticated", resolve));
  client.on("data", (d) => receivedData.push(d));

  client.start();
  await authPromise;
  client.subscribe({ trades: ["AAPL"] });

  await new Promise((r) => setTimeout(r, 300));

  assert.strictEqual(receivedData.length, 1);
  assert.deepStrictEqual(receivedData[0], {
    type: "trade", symbol: "AAPL", assetType: "stock", price: 123.45, size: 100,
    timestamp: "2026-01-01T00:00:00Z", source: "alpaca", feed: "iex",
  });

  client.stop();
  wss.close();
});

test("auth failure is treated as fatal - does not retry forever", async () => {
  const port = 8902;
  const wss = startMockAlpacaServer(port, (ws, msg) => {
    if (msg.action === "auth") {
      ws.send(JSON.stringify([{ T: "error", code: 402, msg: "auth failed" }]));
    }
  });

  const client = new AlpacaFeedClient({
    url: `ws://localhost:${port}`, keyId: "badkey", secretKey: "badsecret", assetType: "stock", feed: "iex",
  });

  const errorPromise = new Promise((resolve) => client.once("error", resolve));
  client.start();
  const err = await errorPromise;

  assert.strictEqual(err.fatal, true);
  assert.ok(err.message.includes("402"));
  assert.strictEqual(client.fatalErrorSeen, true);
  assert.strictEqual(client.stopped, true);

  wss.close();
});

test("missing credentials fails immediately without ever connecting", async () => {
  const client = new AlpacaFeedClient({ url: "ws://localhost:9999", keyId: "", secretKey: "", assetType: "stock", feed: "iex" });
  const errorPromise = new Promise((resolve) => client.once("error", resolve));
  client._authenticate();
  const err = await errorPromise;
  assert.strictEqual(err.fatal, true);
  assert.ok(err.message.includes("Missing"));
});

test("reconnects after unexpected close and resubscribes", async () => {
  const port = 8903;
  let connectionCount = 0;
  const subscribedSymbolsPerConnection = [];

  const wss = new WebSocket.Server({ port });
  wss.on("connection", (ws) => {
    connectionCount++;
    subscribedSymbolsPerConnection.push([]);
    const myIndex = connectionCount - 1;
    ws.send(JSON.stringify([{ T: "success", msg: "connected" }]));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.action === "auth") {
        ws.send(JSON.stringify([{ T: "success", msg: "authenticated" }]));
      } else if (msg.action === "subscribe") {
        subscribedSymbolsPerConnection[myIndex].push(...(msg.trades || []));
        if (myIndex === 0) {
          setTimeout(() => ws.terminate(), 50); // simulate an abrupt network drop, not a clean close
        }
      }
    });
  });

  const client = new AlpacaFeedClient({
    url: `ws://localhost:${port}`, keyId: "k", secretKey: "s", assetType: "stock", feed: "iex",
  });
  client.maxReconnectAttempts = 5;

  let authCount = 0;
  client.on("authenticated", () => { authCount++; });

  client.start();
  await new Promise((resolve) => client.once("authenticated", resolve));
  client.subscribe({ trades: ["TSLA"] });
  await new Promise((r) => setTimeout(r, 200));

  await new Promise((r) => setTimeout(r, 2500));

  assert.ok(connectionCount >= 2, `expected at least 2 connections (reconnect happened), got ${connectionCount}`);
  assert.ok(authCount >= 2, `expected re-authentication after reconnect, authCount=${authCount}`);
  assert.deepStrictEqual(subscribedSymbolsPerConnection[1], ["TSLA"], "resubscribed to TSLA automatically after reconnect");

  client.stop();
  wss.close();
});
