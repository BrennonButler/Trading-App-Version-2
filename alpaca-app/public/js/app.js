const App = {
  settings: { cryptoSymbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'], stockSymbols: ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN'], riskLimits: {}, alertConfidenceThreshold: 65 },
  activeTab: 'watchlist',
  scannerHorizon: 'short_term',
  allocatorHorizon: 'auto',
  backtestHorizon: 'short_term',
  lastScanResults: [],
  liveFeed: null,
  watchlistData: {}, // "assetType:symbol" -> latest snapshot message
};

const PAGE_TITLES = { watchlist: 'Live Watchlist', analyst: 'AI Trade Analyst', allocator: 'Put Money In', scanner: 'Scanner', portfolio: 'Portfolio', history: 'Trade History', backtest: 'Backtesting', settings: 'Settings' };
const PAGE_RENDERERS = {};

function switchTab(tab) {
  App.activeTab = tab;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.getElementById(`page-${tab}`).classList.remove('hidden');
  document.getElementById('page-title').textContent = PAGE_TITLES[tab];
  PAGE_RENDERERS[tab]().catch(err => {
    console.error(err);
    document.getElementById(`page-${tab}`).innerHTML = emptyState('Something went wrong', err.message);
  });
}

async function initApp() {
  try {
    const status = await API.status();
    const pill = document.getElementById('mode-pill');
    const connEl = document.getElementById('conn-status');
    if (!status.alpacaConfigured) {
      pill.textContent = 'ALPACA NOT CONFIGURED';
      connEl.textContent = 'Add APCA_API_KEY_ID / APCA_API_SECRET_KEY on the server';
      connEl.className = 'notif-status warn';
    } else {
      pill.textContent = `FEED: ${status.stockFeed.toUpperCase()}`;
      connEl.textContent = 'Connecting to Alpaca…';
    }
  } catch (e) {
    toast('Could not reach the backend. Is the server running?', 'error');
  }

  try {
    App.settings = { ...App.settings, ...(await API.settings()) };
    if (!App.settings.cryptoSymbols || !App.settings.cryptoSymbols.length) App.settings.cryptoSymbols = ['BTC/USD', 'ETH/USD', 'SOL/USD'];
    if (!App.settings.stockSymbols || !App.settings.stockSymbols.length) App.settings.stockSymbols = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN'];
  } catch (e) { /* use defaults */ }

  App.liveFeed = new LiveFeed();
  document.addEventListener('livefeed:connected', () => {
    const el = document.getElementById('conn-status');
    if (el) { el.textContent = 'Live feed connected'; el.className = 'notif-status ok'; }
  });
  document.addEventListener('livefeed:disconnected', () => {
    const el = document.getElementById('conn-status');
    if (el) { el.textContent = 'Reconnecting…'; el.className = 'notif-status warn'; }
  });

  document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
  switchTab('watchlist');
}

document.addEventListener('DOMContentLoaded', () => { initApp().catch(err => { console.error(err); toast('Init failed: ' + err.message, 'error'); }); });

// Exposed for debugging / testing
if (typeof window !== 'undefined') { window.App = App; window.PAGE_RENDERERS = PAGE_RENDERERS; window.switchTab = switchTab; }
