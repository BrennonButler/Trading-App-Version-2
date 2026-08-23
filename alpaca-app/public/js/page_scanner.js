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

PAGE_RENDERERS.scanner = async function () {
  const el = document.getElementById('page-scanner');
  el.innerHTML = `
    <div class="horizon-toggle mb-16" id="scanner-horizon-toggle">
      <button data-h="short_term" class="${App.scannerHorizon === 'short_term' ? 'active' : ''}">Day Trading</button>
      <button data-h="long_term" class="${App.scannerHorizon === 'long_term' ? 'active' : ''}">Long-Term</button>
    </div>
    <button class="btn btn-primary mb-16" id="scanner-scan-btn">Scan my watchlist</button>
    <div id="scanner-results">${App.lastScanResults.length ? '' : emptyState('No scans yet', 'Click "Scan my watchlist" to run the AI analysis.')}</div>
  `;
  if (App.lastScanResults.length) renderScannerResults();

  document.querySelectorAll('#scanner-horizon-toggle button').forEach(btn => {
    btn.addEventListener('click', () => { App.scannerHorizon = btn.dataset.h; App.lastScanResults = []; switchTab('scanner'); });
  });
  document.getElementById('scanner-scan-btn').addEventListener('click', runScan);
};

async function runScan() {
  const btn = document.getElementById('scanner-scan-btn');
  const resultsEl = document.getElementById('scanner-results');
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Scanning…`;
  resultsEl.innerHTML = `<div class="text-mid">Fetching historical bars from Alpaca and running the AI analyst…</div>`;
  try {
    const symbols = [
      ...App.settings.cryptoSymbols.map(s => ({ symbol: s, assetType: 'crypto' })),
      ...App.settings.stockSymbols.map(s => ({ symbol: s, assetType: 'stock' })),
    ];
    const { results } = await API.scan(symbols, App.scannerHorizon);
    App.lastScanResults = results;
    renderScannerResults();
  } catch (e) {
    resultsEl.innerHTML = emptyState('Scan failed', e.message);
    toast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Scan my watchlist';
  }
}

function renderScannerResults() {
  const resultsEl = document.getElementById('scanner-results');
  const sorted = App.lastScanResults.slice().sort((a, b) => {
    const as = a.signal ? Math.abs(a.signal.masterConfidence - 50) : -1;
    const bs = b.signal ? Math.abs(b.signal.masterConfidence - 50) : -1;
    return bs - as;
  });
  resultsEl.innerHTML = sorted.map(r => {
    if (!r.signal) return `<div class="signal-card"><div class="signal-main"><div class="signal-symbol">${escapeHtml(r.symbol)}</div><div class="text-low" style="font-size:12.5px;">Failed: ${escapeHtml(r.error)}</div></div></div>`;
    return signalCardHtml(r.signal, true);
  }).join('');
  wireSignalCardActions(resultsEl);
}
