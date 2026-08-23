"use strict";
const Database = require("better-sqlite3");
const path = require("path");

function initDb(dbPath) {
  const db = new Database(dbPath || path.join(__dirname, "../../data.sqlite"));
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      direction TEXT NOT NULL,
      horizon TEXT NOT NULL DEFAULT 'short_term',
      entry_price REAL NOT NULL,
      exit_price REAL,
      quantity REAL NOT NULL,
      stop_loss REAL,
      take_profit REAL,
      entry_confidence REAL,
      status TEXT NOT NULL DEFAULT 'open',
      pnl REAL,
      pnl_pct REAL,
      close_reason TEXT,
      opened_at TEXT NOT NULL,
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      level TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);

  return {
    raw: db,

    insertTrade(t) {
      const stmt = db.prepare(`
        INSERT INTO trades (symbol, asset_type, direction, horizon, entry_price, quantity, stop_loss, take_profit, entry_confidence, status, opened_at)
        VALUES (@symbol, @assetType, @direction, @horizon, @entryPrice, @quantity, @stopLoss, @takeProfit, @entryConfidence, 'open', @openedAt)
      `);
      const info = stmt.run(t);
      return this.getTrade(info.lastInsertRowid);
    },

    getTrade(id) {
      return db.prepare("SELECT * FROM trades WHERE id = ?").get(id);
    },

    getOpenTrades() {
      return db.prepare("SELECT * FROM trades WHERE status = 'open'").all();
    },

    getAllTrades(limit = 200) {
      return db.prepare("SELECT * FROM trades ORDER BY opened_at DESC LIMIT ?").all(limit);
    },

    closeTrade(id, { exitPrice, pnl, pnlPct, status, closeReason, closedAt }) {
      db.prepare(`
        UPDATE trades SET exit_price = ?, pnl = ?, pnl_pct = ?, status = ?, close_reason = ?, closed_at = ?
        WHERE id = ?
      `).run(exitPrice, pnl, pnlPct, status, closeReason, closedAt, id);
      return this.getTrade(id);
    },

    getSetting(key, fallback) {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
      return row ? JSON.parse(row.value) : fallback;
    },

    setSetting(key, value) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, JSON.stringify(value));
    },

    log(level, category, message) {
      db.prepare("INSERT INTO logs (timestamp, level, category, message) VALUES (?, ?, ?, ?)")
        .run(new Date().toISOString(), level, category, message);
    },

    getLogs(limit = 200) {
      return db.prepare("SELECT * FROM logs ORDER BY id DESC LIMIT ?").all(limit);
    },
  };
}

module.exports = { initDb };
