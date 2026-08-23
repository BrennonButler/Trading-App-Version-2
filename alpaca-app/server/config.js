"use strict";
require("dotenv").config();

const VALID_STOCK_FEEDS = ["iex", "sip", "delayed_sip"];
const stockFeed = (process.env.ALPACA_STOCK_FEED || "iex").toLowerCase();

if (!VALID_STOCK_FEEDS.includes(stockFeed)) {
  console.warn(`WARNING: ALPACA_STOCK_FEED="${stockFeed}" is not one of ${VALID_STOCK_FEEDS.join(", ")}. Defaulting to "iex".`);
}

module.exports = {
  port: parseInt(process.env.PORT || "3000", 10),
  alpaca: {
    keyId: process.env.APCA_API_KEY_ID || "",
    secretKey: process.env.APCA_API_SECRET_KEY || "",
    stockFeed: VALID_STOCK_FEEDS.includes(stockFeed) ? stockFeed : "iex",
  },
  maxSubscriptionsPerClient: parseInt(process.env.MAX_SUBSCRIPTIONS_PER_CLIENT || "30", 10),
  dbPath: process.env.DB_PATH || undefined,
  startingPaperBalance: parseFloat(process.env.STARTING_PAPER_BALANCE || "10000"),
  defaultRiskLimits: {
    maxRiskPerTradePct: parseFloat(process.env.MAX_RISK_PER_TRADE_PCT || "1.0"),
    maxDailyLossPct: parseFloat(process.env.MAX_DAILY_LOSS_PCT || "3.0"),
    maxPortfolioExposurePct: parseFloat(process.env.MAX_PORTFOLIO_EXPOSURE_PCT || "50.0"),
    maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || "5", 10),
  },
};
