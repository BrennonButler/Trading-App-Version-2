# Signalwright — Live Alpaca Trading App

> ⚠️ **PENDING DEPLOYMENT (as of this build):** the code in this zip is newer than what's
> live on Render. These files need to reach GitHub before the new features go live:
> - **NEW FILE:** `server/services/alpacaScreenerClient.js` (Trending Now data source)
> - **NEW FILE:** `server/services/rateLimiter.js` (guaranteed Alpaca rate-limit protection)
> - **MODIFIED:** `server/index.js` (added `/api/symbols/universe` and `/api/symbols/trending` routes + screener client wiring)
> - **MODIFIED:** `public/js/page_scanner.js` (full rewrite - universe selector, chunked full-market scanning, sort/filter)
> - **MODIFIED:** `public/css/style.css` (appended scanner + universe styles)
> - **MODIFIED:** `server/services/alpacaRestClient.js`, `alpacaAssetsClient.js`, `alpacaNewsClient.js` (each: one-line change, now routes through the new shared rate limiter instead of calling fetch directly)
> - **MODIFIED:** `public/js/pages_rest.js` (Settings page - added the missing Risk Limits section: max risk per trade, max daily loss, max exposure, max open positions, all now editable and verified to genuinely govern live trading, not just save to the database)
>
> What this unlocks once deployed: a "Trending Now" default (real Alpaca screener data -
> today's most-active/biggest-moving stocks, no manual ticker entry), the option to scan
> the entire real NYSE/NASDAQ stock universe with honest time estimates, live progress, a
> working Stop button, and a sort/filter dropdown (confidence, expected return, risk) - plus
> a real, tested, guaranteed rate limiter protecting every Alpaca call app-wide, replacing
> what used to be an untested assumption about network timing being "probably slow enough."
> All of it is already built and tested (32/32 tests passing) - just not on GitHub yet.
>
> Recommended path: upload these files into their exact existing folders in the
> `alpaca-app/` subfolder of the repo (same folders they're already in below) using GitHub's
> "Add file" button on each folder - no need to touch anything else or redo the whole repo.

A real-time market data + AI trade analysis + paper trading web app, backed by Alpaca's
Market Data API. Your browser never sees your Alpaca credentials — they live only on the
server, loaded from environment variables.

**This is a real app you deploy once, not a file you download and open.** After deployment
it's just a URL you visit — nothing to install or re-run locally.

---

## Quickstart: deploy to Render (free tier, ~10 minutes)

1. **Get Alpaca API keys** — sign up at alpaca.markets, go to your dashboard, and generate
   an API key pair (a free paper-trading account works fine for market data — you don't
   need a funded live account).
2. **Push this folder to a GitHub repo** (Render deploys from GitHub).
3. **Go to render.com**, sign up, click **New -> Blueprint**, and point it at your repo.
   Render will read `render.yaml` in this project and configure everything automatically —
   service type, build command, persistent disk.
4. When prompted, paste in your `APCA_API_KEY_ID` and `APCA_API_SECRET_KEY` (Render asks for
   these because `render.yaml` marks them `sync: false` — secrets are never committed to
   your repo).
5. Click deploy. Render gives you a URL like `https://alpaca-trading-app.onrender.com` —
   that's your app, live, from any device, forever after.

**Free tier note:** Render's free web service tier spins down after 15 minutes of no
traffic and takes ~30-60 seconds to wake back up on the next visit. This is a Render
platform behavior, not something in this code — if you want always-on, their paid tier
($7/mo) removes it.

### Alternative: Docker

A `Dockerfile` is included for any host that runs containers (Fly.io, Railway, a VPS, etc).
**I was not able to actually build or run this Dockerfile** — Docker isn't available in the
sandbox I built this in. It follows standard, well-established Node.js Docker patterns, but
treat it as unverified until you build it yourself. If it fails, the likely fix is a Node
base image or `better-sqlite3` native-build tooling mismatch.

### Running locally instead (for development/testing)

```bash
cd alpaca-app
cp .env.example .env
npm install
npm start
```
Open http://localhost:3000.

---

## Answers to your final-report checklist

**1. Files created** - everything in this project is new (server/, public/, tests/, config
files). Full list:
```
server/index.js, server/config.js
server/services/alpacaFeedClient.js    (WebSocket client: auth, subscribe, reconnect)
server/services/alpacaRestClient.js    (REST client: historical bars, latest snapshot)
server/services/marketDataService.js   (orchestrator: one shared connection, many clients)
server/services/analyst.js             (bridges Alpaca data to the indicator/agent engine)
server/services/db.js                  (SQLite persistence for paper trades/settings/logs)
server/lib/*.js                        (indicators, agents, paper trading, backtest,
                                         allocator, exit-signal - see note below)
public/index.html, public/css/style.css, public/js/*.js  (frontend)
tests/*.test.js                        (23 tests, see Testing below)
package.json, .env.example, .gitignore, Dockerfile, render.yaml
```

**2. Files modified** - none; there was no prior backend to modify (the earlier version of
this project was a client-side-only HTML file, architecturally incompatible with holding
secrets, so this is a fresh backend rather than a patch).

**3. Dependencies added** - express (HTTP server), ws (WebSocket, both server and the
Alpaca client), better-sqlite3 (persistence), dotenv (env var loading). Dev-only: jsdom
(used to test the frontend, not shipped to production).

**4. Environment variables required** - see .env.example. Required: APCA_API_KEY_ID,
APCA_API_SECRET_KEY. Everything else has a sensible default.

**5. Alpaca feed being used** - configurable via ALPACA_STOCK_FEED (iex | sip |
delayed_sip), defaulting to iex since that's what free/paper accounts have access to. If
your account doesn't have access to whichever feed you set, the server surfaces a clear
"forbidden" configuration error rather than silently retrying or pretending IEX data
represents the full consolidated tape.

**6. Exact data types supported** - trades, quotes, and minute bars, for both stocks and
crypto, live (via WebSocket) and historical (via REST). Latest-snapshot (combined
trade+quote) is also available via REST for on-demand checks.

**7. WebSocket architecture** - MarketDataService holds exactly ONE WebSocket connection to
Alpaca per feed (one for stocks, one for crypto), regardless of how many browser tabs are
connected. Browser clients connect to our /ws endpoint; when a client subscribes to a
symbol, the service only sends an upstream Alpaca subscribe message if no other client has
already subscribed to that symbol (reference-counted). Verified with a real test: two
simulated browser clients subscribing to the same symbol produce exactly one upstream
Alpaca subscription, torn down only once the last interested client disconnects.

**8. How the frontend receives data** - browser JS (public/js/api.js's LiveFeed class)
opens a WebSocket to /ws on our own server, sends {type:'subscribe', symbol, assetType},
and receives normalized trade/quote/bar messages as they happen. Auto-reconnects with
backoff on drop and re-subscribes to everything it cared about.

**9. How the AI Trade Analyst receives market data** - server/services/analyst.js calls the
Alpaca REST client for historical bars, runs them through the same indicator/scoring engine
from the earlier version of this project (RSI, MACD, EMA/SMA, Bollinger, ATR, ADX,
Ichimoku, OBV, support/resistance -> multi-agent scoring -> master confidence), and returns
a signal. The AI never invents prices - every number in a signal traces back to a real bar
Alpaca returned.

**10. Historical data retrieval** - AlpacaRestClient.getHistoricalBars({symbol, assetType,
timeframe, start, end, limit}), hitting /v2/stocks/{symbol}/bars for stocks and
/v1beta3/crypto/us/bars for crypto, normalized to one consistent shape either way.

**11. How to start the application** - see Quickstart above (npm start locally, or deploy
via Render/Docker).

**12. How to test a stock such as AAPL** - open the app; the Live Watchlist tab shows AAPL
by default with a LIVE/RECENT/STALE badge that updates in real time. Go to Scanner and
click "Scan my watchlist" for an AI read on it. Go to "Put Money In" to see it ranked
against other opportunities.

**13. How to test crypto such as BTC/USD** - same flow; BTC/USD is in the default crypto
watchlist. Crypto streams 24/7 regardless of stock market hours.

**14. Limitations caused by your Alpaca subscription** - if your account only has IEX
access (true for free/paper accounts) and you set ALPACA_STOCK_FEED=sip, the server
reports a clear "forbidden" error rather than connecting. IEX itself only reflects trades
on the IEX exchange, not the full consolidated U.S. tape - disclosed, never presented as
the complete market.

**15. Errors or remaining work - read this section honestly:**
- I could not verify a live connection to real Alpaca servers from the sandbox I built this
  in (no network access to alpaca.markets). Everything is built precisely against Alpaca's
  documented, stable protocol and tested against a realistic mock server standing in for
  Alpaca - including a full end-to-end test of the real frontend talking to the real
  backend over a real WebSocket - but the actual live credential handshake against Alpaca's
  production servers is unverified until you run it with your real keys.
- The Dockerfile is unverified (no Docker available to test-build it here).
- Simplified from your original spec: market-hours detection (pre-market/after-hours/
  closed distinction) is not implemented - freshness (LIVE/RECENT/STALE) is time-based
  only, not market-session-aware. Per-client rate limiting is a simple max-symbol-count cap,
  not a request-throttling system. Symbol search/autocomplete against Alpaca's asset
  reference list isn't built - the app validates symbol format client- and server-side, not
  whether the symbol actually exists (discovered on first fetch).
- A real bug I found and fixed along the way, worth knowing about: while building the full
  end-to-end test, I caught a bug where the server's WebSocket broadcast code was silently
  corrupting every live message's type field ({type: "data", ...data} - object spread lets
  the inner object's own type field silently overwrite the outer one), which would have
  made every live tick invisible to the frontend with no error anywhere. Fixed and
  re-verified with a real round-trip test. Mentioning this because it's the kind of bug
  individual unit tests can't catch - only an integration test that makes real data flow
  through the whole path found it.

---

## Architecture

```
Alpaca (real-time WS + historical REST)
        |
        v
MarketDataService (server/services/) - ONE connection per feed, shared across all clients
        |                              reconnect w/ backoff+jitter, snapshot cache, freshness
        v
Express + ws server (server/index.js) - REST API + /ws endpoint
        |
        +--> SQLite (paper trades, settings, logs - survives restarts)
        +--> Indicator/Agent engine (server/lib/ - reused, unchanged, from the earlier
        |    browser version of this project; RSI/MACD/EMA/etc -> multi-agent scoring)
        v
Browser (public/) - REST for on-demand actions, WebSocket for live ticks
```

## Testing

```bash
node --test tests/alpacaFeedClient.test.js       # Alpaca WS client vs. real mock server
node --test tests/alpacaRestClient.test.js       # Alpaca REST parsing vs. documented shapes
node --test tests/marketDataService.test.js      # subscription dedup, freshness, validation
node --test tests/server.integration.test.js     # full REST API against a real server
node --test tests/fullstack.integration.test.js  # real frontend + real backend + real WS
```
23 tests total, all passing as of this build. Run files individually as shown above rather
than `node --test tests/` in one shot - Node's test runner parallelizes across files by
default, and the integration tests open real network ports, which can contend under
parallel execution in some environments.

## Not financial advice

Signals are a rules-based statistical read on technical indicators, not a prediction
guarantee. This is decision-support and paper-trading software.
