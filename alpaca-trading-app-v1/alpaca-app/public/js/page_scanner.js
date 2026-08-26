function signalCardHtml(signal, withAction) {
  const canTrade = withAction && signal.direction !== 'flat';
  return `
    <div class="signal-card ${dirClass(signal.direction)}">
      ${confidenceMeter(signal.masterConfidence)}
      <div class="signal-main">
        <div class="signal-header">
          <span class="signal-symbol">${escapeHtml(signal.symbol)}</span>
          ${directionTag(signal.direction)}
          ${horizonTag(signal.horizon)}
          <span class="text-low mono" style="font-size:11.5px;">risk ${Math.round(signal.riskScore)}/100</span>
        </div>
        <div class="plain-summary">${escapeHtml(plainLanguageSummary(signal))}</div>
        ${signal.direction !== 'flat' ? dollarProjectionHtml(signal, 1000, true) : ''}
        <button class="details-toggle" data-toggle-target="dt-${Math.random().toString(36).slice(2)}">Show technical details ▾</button>
        <div class="details-panel hidden" id="dt-details">
          <div class="signal-meta">entry ${fmtNum(signal.entryPrice, 2)} · stop ${fmtNum(signal.suggestedStopLoss, 2)} · target ${fmtNum(signal.suggestedTakeProfit, 2)} · suggested size ${fmtNum(signal.suggestedPositionSizePct, 2)}%</div>
          ${factorList(signal.bullishFactors.slice(0, 4), 'bull')}
          ${factorList(signal.bearishFactors.slice(0, 4), 'bear')}
        </div>
        ${canTrade ? `<div style="margin-top:10px;"><button class="btn btn-primary btn-sm" data-open-signal='${escapeHtml(JSON.stringify(signal))}'>Open as paper trade</button></div>` : ''}
      </div>
    </div>`;
}

function wireSignalCardActions(container) {
  container.querySelectorAll('[data-open-signal]').forEach(btn => {
    btn.addEventListener('click', () => openTradeFromSignal(JSON.parse(btn.dataset.openSignal), btn));
  });
  container.querySelectorAll('[data-toggle-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = btn.nextElementSibling;
      const wasHidden = panel.classList.contains('hidden');
      panel.classList.toggle('hidden');
      btn.textContent = wasHidden ? 'Hide technical details ▴' : 'Show technical details ▾';
    });
  });
}

async function openTradeFromSignal(signal, btnEl) {
  btnEl.disabled = true; btnEl.textContent = 'Opening…';
  try {
    await API.openPosition({
      symbol: signal.symbol, assetType: signal.assetType, direction: signal.direction,
      positionSizePct: Math.max(signal.suggestedPositionSizePct, 0.5),
      stopLoss: signal.suggestedStopLoss, takeProfit: signal.suggestedTakeProfit,
      horizon: signal.horizon, entryConfidence: signal.masterConfidence,
    });
    toast(`Paper trade opened: ${signal.direction.toUpperCase()} ${signal.symbol}`, 'success');
    btnEl.textContent = 'Opened ✓';
  } catch (e) {
    toast(e.message, 'error'); btnEl.disabled = false; btnEl.textContent = 'Open as paper trade';
  }
}

// ============================================================
// Universe tiers - real, verifiable Alpaca exchange listings, not a fabricated index list.
// Time estimates: scanner uses 1 Alpaca request per symbol, real verified limit is 200
// req/min on the free tier - paced conservatively here at ~150/min for safety margin.
// ============================================================
const SCAN_REQUESTS_PER_MIN = 150;
const UNIVERSE_TIERS = [
  { id: 'trending', label: '⚡ Trending Now (recommended)' },
  { id: 'watchlist', label: 'My Watchlist' },
  { id: 'nasdaq', label: 'All NASDAQ', exchanges: 'NASDAQ' },
  { id: 'nyse', label: 'All NYSE', exchanges: 'NYSE' },
  { id: 'all', label: 'NYSE + NASDAQ (Everything)', exchanges: 'NYSE,NASDAQ' },
];
const CHUNK_SIZE = 25;
const CHUNK_PAUSE_MS = 400; // safety margin between chunks, on top of natural per-request latency

let _scanState = { running: false, stopRequested: false, scannedCount: 0, totalCount: 0 };
let _scanSort = 'confidence';
let _scanDirectionFilter = 'all';

PAGE_RENDERERS.scanner = async function () {
  const el = document.getElementById('page-scanner');
  el.innerHTML = `
    <div class="horizon-toggle mb-16" id="scanner-horizon-toggle">
      <button data-h="short_term" class="${App.scannerHorizon === 'short_term' ? 'active' : ''}">Day Trading</button>
      <button data-h="long_term" class="${App.scannerHorizon === 'long_term' ? 'active' : ''}">Long-Term</button>
    </div>

    <div class="card mb-16">
      <div class="scanner-controls-row">
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">Universe</label>
          <select id="scanner-universe" class="form-select">
            ${UNIVERSE_TIERS.map(t => `<option value="${t.id}">${escapeHtml(t.label)}</option>`).join('')}
          </select>
        </div>
        <button class="btn btn-primary" id="scanner-scan-btn">Scan</button>
        <button class="btn btn-danger hidden" id="scanner-stop-btn">Stop</button>
      </div>
      <div class="form-hint" id="scanner-estimate" style="margin-top:8px;"></div>
      <div id="scanner-progress" class="hidden" style="margin-top:10px;">
        <div class="scanner-progress-track"><div class="scanner-progress-fill" id="scanner-progress-fill"></div></div>
        <div class="text-low" id="scanner-progress-text" style="font-size:11.5px; margin-top:4px;"></div>
      </div>
    </div>

    <div class="card mb-16 hidden" id="scanner-filter-bar">
      <div class="scanner-controls-row">
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">Sort by</label>
          <select id="scanner-sort" class="form-select">
            <option value="confidence">Highest confidence</option>
            <option value="return">Highest expected return %</option>
            <option value="risk">Lowest risk</option>
            <option value="symbol">Symbol (A-Z)</option>
          </select>
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label">Show</label>
          <select id="scanner-direction-filter" class="form-select">
            <option value="all">All signals</option>
            <option value="long">Long / bullish only</option>
            <option value="short">Short / bearish only</option>
          </select>
        </div>
      </div>
    </div>

    <div id="scanner-results">${App.lastScanResults.length ? '' : emptyState('No scans yet', 'Choose a universe above and click Scan.')}</div>
  `;
  if (App.lastScanResults.length) { document.getElementById('scanner-filter-bar').classList.remove('hidden'); renderScannerResults(); }

  document.querySelectorAll('#scanner-horizon-toggle button').forEach(btn => {
    btn.addEventListener('click', () => { App.scannerHorizon = btn.dataset.h; App.lastScanResults = []; switchTab('scanner'); });
  });
  document.getElementById('scanner-scan-btn').addEventListener('click', startScan);
  document.getElementById('scanner-stop-btn').addEventListener('click', () => { _scanState.stopRequested = true; });
  document.getElementById('scanner-universe').addEventListener('change', updateScanEstimate);
  document.getElementById('scanner-sort').addEventListener('change', (e) => { _scanSort = e.target.value; renderScannerResults(); });
  document.getElementById('scanner-direction-filter').addEventListener('change', (e) => { _scanDirectionFilter = e.target.value; renderScannerResults(); });

  updateScanEstimate();
};

async function updateScanEstimate() {
  const tierId = document.getElementById('scanner-universe').value;
  const estimateEl = document.getElementById('scanner-estimate');
  if (tierId === 'watchlist') {
    const n = App.settings.cryptoSymbols.length + App.settings.stockSymbols.length;
    estimateEl.textContent = `${n} symbols from your watchlist - a few seconds.`;
    return;
  }
  if (tierId === 'trending') {
    estimateEl.textContent = `Real, live data from Alpaca's own screener (today's most-active and biggest-moving stocks - not a hardcoded list). Roughly 30-50 stocks, done in under a minute. No typing tickers required.`;
    return;
  }
  const tier = UNIVERSE_TIERS.find(t => t.id === tierId);
  estimateEl.textContent = 'Checking how many symbols that is…';
  try {
    const { count } = await API.get(`/symbols/universe?exchanges=${tier.exchanges}`);
    const minutes = Math.ceil(count / SCAN_REQUESTS_PER_MIN);
    estimateEl.textContent = `${count.toLocaleString()} real, tradable stocks on ${tier.label} - roughly ${minutes} minute${minutes === 1 ? '' : 's'} to scan all of them (limited by Alpaca's free-tier rate limit, not by this app). Results appear as they're found - you don't have to wait for it to finish, and you can stop anytime.`;
  } catch (e) {
    estimateEl.textContent = `Could not check symbol count: ${e.message}`;
  }
}

async function startScan() {
  const tierId = document.getElementById('scanner-universe').value;
  const scanBtn = document.getElementById('scanner-scan-btn');
  const stopBtn = document.getElementById('scanner-stop-btn');
  const progressEl = document.getElementById('scanner-progress');
  const resultsEl = document.getElementById('scanner-results');

  let symbols;
  try {
    if (tierId === 'watchlist') {
      symbols = [
        ...App.settings.cryptoSymbols.map(s => ({ symbol: s, assetType: 'crypto' })),
        ...App.settings.stockSymbols.map(s => ({ symbol: s, assetType: 'stock' })),
      ];
    } else if (tierId === 'trending') {
      const { symbols: trendingSymbols } = await API.get('/symbols/trending');
      symbols = trendingSymbols.map(s => ({ symbol: s, assetType: 'stock' }));
    } else {
      const tier = UNIVERSE_TIERS.find(t => t.id === tierId);
      const { symbols: universeSymbols } = await API.get(`/symbols/universe?exchanges=${tier.exchanges}`);
      symbols = universeSymbols.map(s => ({ symbol: s, assetType: 'stock' }));
    }
  } catch (e) {
    toast('Could not load symbol list: ' + e.message, 'error');
    return;
  }
  if (!symbols.length) { toast('No symbols to scan', 'error'); return; }

  App.lastScanResults = [];
  _scanState = { running: true, stopRequested: false, scannedCount: 0, totalCount: symbols.length };
  scanBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');
  progressEl.classList.remove('hidden');
  document.getElementById('scanner-filter-bar').classList.remove('hidden');
  resultsEl.innerHTML = '';

  for (let i = 0; i < symbols.length; i += CHUNK_SIZE) {
    if (_scanState.stopRequested) break;
    const chunk = symbols.slice(i, i + CHUNK_SIZE);
    try {
      const { results } = await API.scan(chunk, App.scannerHorizon);
      App.lastScanResults.push(...results);
    } catch (e) {
      console.error('Scan chunk failed:', e.message);
    }
    _scanState.scannedCount = Math.min(i + CHUNK_SIZE, symbols.length);
    updateScanProgress();
    renderScannerResults();
    if (i + CHUNK_SIZE < symbols.length) await new Promise(r => setTimeout(r, CHUNK_PAUSE_MS));
  }

  _scanState.running = false;
  scanBtn.classList.remove('hidden');
  stopBtn.classList.add('hidden');
  const stopped = _scanState.stopRequested;
  progressEl.classList.add('hidden');
  toast(stopped ? `Stopped - scanned ${_scanState.scannedCount} of ${_scanState.totalCount}` : `Scan complete - ${_scanState.scannedCount} symbols`, 'success');
}

function updateScanProgress() {
  const pct = Math.round((_scanState.scannedCount / _scanState.totalCount) * 100);
  document.getElementById('scanner-progress-fill').style.width = pct + '%';
  document.getElementById('scanner-progress-text').textContent = `Scanned ${_scanState.scannedCount.toLocaleString()} of ${_scanState.totalCount.toLocaleString()} (${pct}%)`;
}

function renderScannerResults() {
  const resultsEl = document.getElementById('scanner-results');
  let list = App.lastScanResults.filter(r => r.signal);
  const failed = App.lastScanResults.filter(r => !r.signal);

  if (_scanDirectionFilter === 'long') list = list.filter(r => r.signal.direction === 'long');
  else if (_scanDirectionFilter === 'short') list = list.filter(r => r.signal.direction === 'short');

  list.sort((a, b) => {
    if (_scanSort === 'confidence') return Math.abs(b.signal.masterConfidence - 50) - Math.abs(a.signal.masterConfidence - 50);
    if (_scanSort === 'return') return (b.signal.expectedReturnPct || -999) - (a.signal.expectedReturnPct || -999);
    if (_scanSort === 'risk') return a.signal.riskScore - b.signal.riskScore;
    if (_scanSort === 'symbol') return a.signal.symbol.localeCompare(b.signal.symbol);
    return 0;
  });

  if (!list.length && !failed.length) {
    resultsEl.innerHTML = '';
    return;
  }

  if (list.length > 20) {
    resultsEl.innerHTML = `
      <div class="text-low" style="font-size:11.5px; margin-bottom:8px;">Showing ${list.length} result${list.length === 1 ? '' : 's'}${failed.length ? ` · ${failed.length} symbol${failed.length === 1 ? '' : 's'} failed to fetch` : ''} · click a row for details</div>
      <div class="card" style="padding:0; overflow-x:auto;">
        <table><thead><tr><th>Symbol</th><th>Dir</th><th>Confidence</th><th class="mono">Exp. Return</th><th class="mono">Risk</th></tr></thead>
        <tbody>${list.map((r, i) => `
          <tr class="scanner-row" data-row-idx="${i}">
            <td class="mono">${escapeHtml(r.signal.symbol)}</td>
            <td>${directionTag(r.signal.direction)}</td>
            <td>${Math.round(r.signal.masterConfidence)}/100</td>
            <td class="mono">${fmtPct(r.signal.expectedReturnPct)}</td>
            <td class="mono">${Math.round(r.signal.riskScore)}/100</td>
          </tr>
          <tr class="scanner-detail-row hidden" id="scanner-detail-${i}"><td colspan="5"></td></tr>
        `).join('')}</tbody></table>
      </div>`;
    resultsEl.querySelectorAll('.scanner-row').forEach(row => {
      row.addEventListener('click', () => {
        const idx = parseInt(row.dataset.rowIdx, 10);
        const detailRow = document.getElementById(`scanner-detail-${idx}`);
        const cell = detailRow.querySelector('td');
        if (detailRow.classList.contains('hidden') && !cell.innerHTML) {
          cell.innerHTML = signalCardHtml(list[idx].signal, true);
          wireSignalCardActions(cell);
        }
        detailRow.classList.toggle('hidden');
      });
    });
    return;
  }

  resultsEl.innerHTML = list.map(r => signalCardHtml(r.signal, true)).join('')
    + failed.map(r => `<div class="signal-card"><div class="signal-main"><div class="signal-symbol">${escapeHtml(r.symbol)}</div><div class="text-low" style="font-size:12.5px;">Failed: ${escapeHtml(r.error)}</div></div></div>`).join('');
  wireSignalCardActions(resultsEl);
}
