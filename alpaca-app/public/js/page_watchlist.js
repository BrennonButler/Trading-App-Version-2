let _watchlistUnsubscribers = [];

PAGE_RENDERERS.watchlist = async function () {
  const el = document.getElementById('page-watchlist');
  const symbols = [
    ...App.settings.cryptoSymbols.map(s => ({ symbol: s, assetType: 'crypto' })),
    ...App.settings.stockSymbols.map(s => ({ symbol: s, assetType: 'stock' })),
  ];

  el.innerHTML = `
    <div class="text-mid mb-16" style="font-size:12.5px;">
      Streaming live from Alpaca through our own server (your browser never talks to Alpaca directly).
      A pulsing green dot means data arrived within the last few seconds.
    </div>
    <div id="watchlist-rows"></div>
  `;
  const rowsEl = document.getElementById('watchlist-rows');
  rowsEl.innerHTML = symbols.map(s => watchlistRowHtml(s.symbol, s.assetType)).join('');

  // Clean up any previous subscriptions before making new ones (e.g. re-entering this tab)
  _watchlistUnsubscribers.forEach(unsub => unsub());
  _watchlistUnsubscribers = [];

  for (const { symbol, assetType } of symbols) {
    // Seed with a REST snapshot immediately so the row isn't blank while waiting for the
    // first streamed tick (the stream only pushes on new activity, which can take a moment).
    API.snapshot(assetType, symbol).then(snap => updateWatchlistRow(symbol, assetType, snap)).catch(() => {});

    const unsub = App.liveFeed.subscribe(symbol, assetType, (msg) => updateWatchlistRow(symbol, assetType, msg));
    _watchlistUnsubscribers.push(unsub);
  }

  // Re-render freshness badges every few seconds even without new data, since "5 seconds
  // ago" needs to visibly age into "stale" over time, not just on the next tick.
  if (window._watchlistAgeInterval) clearInterval(window._watchlistAgeInterval);
  window._watchlistAgeInterval = setInterval(() => {
    if (App.activeTab !== 'watchlist') return;
    for (const { symbol, assetType } of symbols) {
      const data = App.watchlistData[`${assetType}:${symbol}`];
      if (data) updateWatchlistRow(symbol, assetType, data, /*skipStore*/ true);
    }
  }, 2000);
};

function watchlistRowHtml(symbol, assetType) {
  const rowId = `wl-${assetType}-${symbol.replace(/[^a-zA-Z0-9]/g, '_')}`;
  return `
    <div class="watchlist-row" id="${rowId}">
      <span class="watchlist-symbol">${escapeHtml(symbol)}</span>
      <span class="watchlist-price" id="${rowId}-price">—</span>
      <span class="watchlist-change" id="${rowId}-change">—</span>
      <span class="watchlist-meta" id="${rowId}-meta">Waiting for data…</span>
      <span id="${rowId}-badge">${freshnessBadge('disconnected')}</span>
    </div>`;
}

function computeAgeFreshness(timestampIso, msgType) {
  if (!timestampIso) return 'disconnected';
  const ageMs = Date.now() - new Date(timestampIso).getTime();
  const thresholds = msgType === 'bar' ? { live: 90000, recent: 300000 } : { live: 5000, recent: 30000 };
  if (ageMs < thresholds.live) return 'live';
  if (ageMs < thresholds.recent) return 'recent';
  return 'stale';
}

function updateWatchlistRow(symbol, assetType, data, skipStore) {
  const key = `${assetType}:${symbol}`;
  if (!skipStore) App.watchlistData[key] = data;

  const rowId = `wl-${assetType}-${symbol.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const priceEl = document.getElementById(`${rowId}-price`);
  if (!priceEl) return; // navigated away

  let price = null, timestamp = null, msgType = 'trade', feed = data.feed;
  if (data.latestTrade) { price = data.latestTrade.price; timestamp = data.latestTrade.timestamp; }
  else if (data.type === 'trade') { price = data.price; timestamp = data.timestamp; }
  else if (data.latestQuote) { price = (data.latestQuote.bidPrice + data.latestQuote.askPrice) / 2; timestamp = data.latestQuote.timestamp; msgType = 'quote'; }
  else if (data.type === 'quote') { price = (data.bidPrice + data.askPrice) / 2; timestamp = data.timestamp; msgType = 'quote'; }
  else if (data.latestBar) { price = data.latestBar.close; timestamp = data.latestBar.timestamp; msgType = 'bar'; }
  else if (data.type === 'bar') { price = data.close; timestamp = data.timestamp; msgType = 'bar'; }

  const freshness = data.freshness || computeAgeFreshness(timestamp, msgType);

  document.getElementById(`${rowId}-price`).textContent = price != null ? fmtMoney(price) : '—';
  document.getElementById(`${rowId}-badge`).innerHTML = freshnessBadge(freshness);
  document.getElementById(`${rowId}-meta`).textContent = timestamp
    ? `Updated ${fmtDate(timestamp)}${feed ? ' · feed: ' + feed : ''}`
    : 'Waiting for data…';
}
