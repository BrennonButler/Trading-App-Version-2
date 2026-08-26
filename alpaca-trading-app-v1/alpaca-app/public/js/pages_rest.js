// ============================================================
// Allocator ("Put Money In")
// ============================================================
PAGE_RENDERERS.allocator = async function () {
  const el = document.getElementById('page-allocator');
  el.innerHTML = `
    <div class="grid" style="grid-template-columns: 320px 1fr; gap:24px; align-items:start;">
      <div class="card">
        <div class="card-title">How much do you want to put in?</div>
        <div class="form-group"><label class="form-label">Amount (USD)</label><input type="number" id="alloc-budget" class="form-input" placeholder="1000" min="1"></div>
        <div class="form-group"><label class="form-label">Min confidence</label>
          <select id="alloc-min-confidence" class="form-select">
            <option value="55">55 — looser</option><option value="60" selected>60 — balanced</option><option value="70">70 — stricter</option>
          </select>
        </div>
        <button class="btn btn-primary btn-block" id="alloc-submit-btn">Find opportunities</button>
        <div class="form-hint" style="margin-top:14px;">Checks both day-trading and long-term signals for every symbol and uses whichever is stronger.</div>
      </div>
      <div id="alloc-results">${emptyState('Nothing yet', 'Enter an amount and click "Find opportunities."')}</div>
    </div>`;
  document.getElementById('alloc-submit-btn').addEventListener('click', runAllocation);
};

async function runAllocation() {
  const budget = parseFloat(document.getElementById('alloc-budget').value);
  const minConfidence = parseFloat(document.getElementById('alloc-min-confidence').value);
  const resultsEl = document.getElementById('alloc-results');
  const btn = document.getElementById('alloc-submit-btn');
  if (!budget || budget <= 0) { toast('Enter a budget > $0', 'error'); return; }
  btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Analyzing…`;
  resultsEl.innerHTML = `<div class="text-mid">Scanning your watchlist…</div>`;
  try {
    const symbols = [
      ...App.settings.cryptoSymbols.map(s => ({ symbol: s, assetType: 'crypto' })),
      ...App.settings.stockSymbols.map(s => ({ symbol: s, assetType: 'stock' })),
    ];
    const result = await API.allocate({ budget, symbols, minConfidence, maxPositions: 5, horizon: 'auto' });
    renderAllocationResults(result);
  } catch (e) {
    resultsEl.innerHTML = emptyState('Failed', e.message); toast(e.message, 'error');
  } finally { btn.disabled = false; btn.textContent = 'Find opportunities'; }
}

function renderAllocationResults(result) {
  const resultsEl = document.getElementById('alloc-results');
  const recs = result.recommendations || [];
  if (!recs.length) { resultsEl.innerHTML = emptyState('No matching opportunities', result.message); return; }
  resultsEl.innerHTML = `
    <div class="card mb-16"><div class="grid grid-3">
      <div class="stat"><div class="stat-label">Budget</div><div class="stat-value">${fmtMoney(result.budget)}</div></div>
      <div class="stat"><div class="stat-label">Allocated</div><div class="stat-value">${fmtMoney(result.allocatedTotal)}</div></div>
      <div class="stat"><div class="stat-label">Left in cash</div><div class="stat-value">${fmtMoney(result.unallocated)}</div></div>
    </div></div>
    <div id="alloc-cards"></div>`;
  const cardsEl = document.getElementById('alloc-cards');
  cardsEl.innerHTML = recs.map((r, i) => `
    <div class="signal-card ${dirClass(r.direction)}">
      ${confidenceMeter(r.confidence)}
      <div class="signal-main">
        <div class="signal-header"><span class="signal-symbol">${escapeHtml(r.symbol)}</span>${directionTag(r.direction)}${horizonTag(r.horizon)}</div>
        ${dollarProjectionHtml(r, r.allocatedAmount, false)}
        <div class="form-hint">That's ${r.allocatedPct}% of your budget.</div>
        <div style="margin-top:12px;"><button class="btn btn-primary btn-sm" data-alloc-idx="${i}">Open as paper trade</button></div>
      </div>
    </div>`).join('');
  cardsEl.querySelectorAll('[data-alloc-idx]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const rec = recs[parseInt(btn.dataset.allocIdx, 10)];
      btn.disabled = true; btn.textContent = 'Opening…';
      try {
        await API.openPosition({ symbol: rec.symbol, assetType: rec.assetType, direction: rec.direction, absoluteAmount: rec.allocatedAmount, stopLoss: rec.stopLoss, takeProfit: rec.takeProfit, horizon: rec.horizon, entryConfidence: rec.confidence });
        toast(`Opened ${rec.direction.toUpperCase()} ${rec.symbol}`, 'success'); btn.textContent = 'Opened ✓';
      } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = 'Open as paper trade'; }
    });
  });
}

// ============================================================
// Portfolio
// ============================================================
PAGE_RENDERERS.portfolio = async function () {
  const el = document.getElementById('page-portfolio');
  el.innerHTML = `<div class="text-mid">Loading…</div>`;
  const [portfolio, positions] = await Promise.all([API.portfolio(), API.positions()]);
  let html = `<div class="grid grid-4 mb-16">
    <div class="card stat"><div class="stat-label">Total Equity</div><div class="stat-value">${fmtMoney(portfolio.totalEquity)}</div></div>
    <div class="card stat"><div class="stat-label">Cash</div><div class="stat-value">${fmtMoney(portfolio.cashBalance)}</div></div>
    <div class="card stat"><div class="stat-label">Deployed</div><div class="stat-value">${fmtMoney(portfolio.positionsValue)}</div></div>
    <div class="card stat"><div class="stat-label">Open Positions</div><div class="stat-value">${portfolio.openPositionsCount}</div></div>
  </div>`;
  if (!positions.length) { el.innerHTML = html + emptyState('No open positions', 'Open one from the Scanner or "Put Money In."'); return; }
  html += `<div id="portfolio-rows"></div>`;
  el.innerHTML = html;
  const rowsEl = document.getElementById('portfolio-rows');
  rowsEl.innerHTML = positions.map(p => `<div class="signal-card ${dirClass(p.direction)}" id="pos-${p.id}">
    <div class="signal-main">
      <div class="signal-header"><span class="signal-symbol">${escapeHtml(p.symbol)}</span>${directionTag(p.direction)}${horizonTag(p.horizon)}</div>
      <div class="signal-meta">entry ${fmtNum(p.entryPrice,2)} · stop ${fmtNum(p.stopLoss,2)} · target ${fmtNum(p.takeProfit,2)} · opened ${fmtDate(p.openedAt)}</div>
      <div id="exit-check-${p.id}" class="text-mid" style="font-size:12.5px;margin:8px 0;">Checking exit signal…</div>
      <button class="btn btn-danger btn-sm" data-close-id="${p.id}">Close position</button>
    </div>
  </div>`).join('');

  for (const p of positions) {
    API.exitCheck(p.id).then(check => {
      const badgeEl = document.getElementById(`exit-check-${p.id}`);
      if (!badgeEl) return;
      const cls = { hold: 'exit-hold', watch: 'exit-watch', exit: 'exit-exit' }[check.urgency];
      badgeEl.innerHTML = `<span class="exit-badge ${cls}">${check.headline}</span><div style="margin-top:4px;">${escapeHtml(check.reason)}</div>`;
    }).catch(() => {});
  }
  rowsEl.querySelectorAll('[data-close-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = '…';
      try {
        const closed = await API.closePosition(parseInt(btn.dataset.closeId, 10));
        toast(`Closed ${closed.symbol}: ${fmtMoney(closed.pnl)} (${fmtPct(closed.pnlPct)})`, closed.pnl >= 0 ? 'success' : 'error');
        switchTab('portfolio');
      } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = 'Close position'; }
    });
  });
};

// ============================================================
// Trade History
// ============================================================
PAGE_RENDERERS.history = async function () {
  const el = document.getElementById('page-history');
  const trades = await API.trades();
  const closed = trades.filter(t => t.status !== 'open');
  if (!closed.length) { el.innerHTML = emptyState('No closed trades yet', 'They will show up here once closed.'); return; }
  const wins = closed.filter(t => (t.pnl || 0) > 0).length;
  const winRate = closed.length ? (wins / closed.length * 100) : 0;
  const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  el.innerHTML = `
    <div class="grid grid-3 mb-16">
      <div class="card stat"><div class="stat-label">Closed Trades</div><div class="stat-value">${closed.length}</div></div>
      <div class="card stat"><div class="stat-label">Win Rate</div><div class="stat-value">${winRate.toFixed(1)}%</div></div>
      <div class="card stat"><div class="stat-label">Total P&amp;L</div><div class="stat-value ${totalPnl>=0?'up':'down'}">${fmtMoney(totalPnl)}</div></div>
    </div>
    <div class="card" style="padding:0;overflow-x:auto;">
      <table><thead><tr><th>Symbol</th><th>Dir</th><th>Horizon</th><th class="mono">Entry</th><th class="mono">Exit</th><th class="mono">P&amp;L</th><th>Closed</th></tr></thead>
      <tbody>${closed.map(t => `<tr>
        <td class="mono">${escapeHtml(t.symbol)}</td><td>${directionTag(t.direction)}</td><td>${horizonTag(t.horizon)}</td>
        <td class="mono">${fmtNum(t.entry_price,2)}</td><td class="mono">${fmtNum(t.exit_price,2)}</td>
        <td class="mono" style="color:${(t.pnl||0)>=0?'var(--mint)':'var(--rose)'}">${fmtMoney(t.pnl)}</td>
        <td>${fmtDate(t.closed_at)}</td></tr>`).join('')}</tbody></table>
    </div>`;
};

// ============================================================
// Backtest
// ============================================================
PAGE_RENDERERS.backtest = async function () {
  const el = document.getElementById('page-backtest');
  el.innerHTML = `
    <div class="grid" style="grid-template-columns: 300px 1fr; gap:24px; align-items:start;">
      <div class="card">
        <div class="card-title">Run a backtest</div>
        <div class="horizon-toggle mb-16" id="bt-horizon-toggle">
          <button data-h="short_term" class="${App.backtestHorizon === 'short_term' ? 'active' : ''}">Day Trading</button>
          <button data-h="long_term" class="${App.backtestHorizon === 'long_term' ? 'active' : ''}">Long-Term</button>
        </div>
        <div class="form-group"><label class="form-label">Symbol</label><input type="text" id="bt-symbol" class="form-input" value="AAPL"></div>
        <div class="form-group"><label class="form-label">Asset type</label><select id="bt-asset-type" class="form-select"><option value="stock">Stock</option><option value="crypto">Crypto</option></select></div>
        <button class="btn btn-primary btn-block" id="bt-run-btn">Run backtest</button>
      </div>
      <div id="bt-results">${emptyState('No backtest run yet', 'Configure and run one.')}</div>
    </div>`;
  document.querySelectorAll('#bt-horizon-toggle button').forEach(btn => btn.addEventListener('click', () => { App.backtestHorizon = btn.dataset.h; switchTab('backtest'); }));
  document.getElementById('bt-run-btn').addEventListener('click', async () => {
    const btn = document.getElementById('bt-run-btn'); const resultsEl = document.getElementById('bt-results');
    const symbol = document.getElementById('bt-symbol').value.trim();
    const assetType = document.getElementById('bt-asset-type').value;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    resultsEl.innerHTML = '<div class="text-mid">Running…</div>';
    try {
      const r = await API.backtest({ symbol, assetType, horizon: App.backtestHorizon, startingEquity: 10000, positionSizePct: 10 });
      resultsEl.innerHTML = `<div class="grid grid-4">
        <div class="card stat"><div class="stat-label">Total Return</div><div class="stat-value ${r.totalReturnPct>=0?'up':'down'}">${fmtPct(r.totalReturnPct)}</div></div>
        <div class="card stat"><div class="stat-label">Sharpe</div><div class="stat-value">${fmtNum(r.sharpeRatio,2)}</div></div>
        <div class="card stat"><div class="stat-label">Max Drawdown</div><div class="stat-value down">-${fmtNum(r.maxDrawdownPct,2)}%</div></div>
        <div class="card stat"><div class="stat-label">Trades</div><div class="stat-value">${r.totalTrades}</div></div>
      </div>`;
    } catch (e) { resultsEl.innerHTML = emptyState('Failed', e.message); }
    finally { btn.disabled = false; btn.textContent = 'Run backtest'; }
  });
};

// ============================================================
// Settings
// ============================================================
PAGE_RENDERERS.settings = async function () {
  const el = document.getElementById('page-settings');
  const s = App.settings;
  const rl = s.riskLimits || {};
  el.innerHTML = `
    <div class="card mb-16">
      <div class="card-title">Symbols to watch</div>
      <div class="form-group"><label class="form-label">Crypto (comma-separated)</label><input type="text" id="set-crypto" class="form-input" value="${escapeHtml(s.cryptoSymbols.join(', '))}"></div>
      <div class="form-group"><label class="form-label">Stocks (comma-separated)</label><textarea id="set-stocks" class="form-input" rows="3">${escapeHtml(s.stockSymbols.join(', '))}</textarea></div>
    </div>
    <div class="card mb-16">
      <div class="card-title">Risk Limits</div>
      <p class="text-mid mb-16" style="font-size:13px;line-height:1.5;">
        These guard your paper portfolio against outsized single trades or a bad stretch
        compounding - the same limits the app already enforces server-side, now editable.
      </p>
      <div class="form-group">
        <label class="form-label">Max risk per trade (%)</label>
        <input type="number" id="set-risk-per-trade" class="form-input" value="${rl.maxRiskPerTradePct ?? 1.0}" min="0.1" max="100" step="0.1">
        <div class="form-hint">How much of your total equity one single trade's stop-loss is allowed to risk.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Max daily loss (%)</label>
        <input type="number" id="set-max-daily-loss" class="form-input" value="${rl.maxDailyLossPct ?? 3.0}" min="0.1" max="100" step="0.1">
        <div class="form-hint">If losses in a single day reach this share of equity, new positions stop opening until the next day.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Max portfolio exposure (%)</label>
        <input type="number" id="set-max-exposure" class="form-input" value="${rl.maxPortfolioExposurePct ?? 50.0}" min="1" max="100" step="1">
        <div class="form-hint">The largest share of your total equity allowed to be deployed in open positions at once.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Max open positions</label>
        <input type="number" id="set-max-positions" class="form-input" value="${rl.maxOpenPositions ?? 5}" min="1" max="50" step="1">
        <div class="form-hint">The most positions allowed open at the same time, regardless of available cash.</div>
      </div>
    </div>
    <button class="btn btn-primary mb-16" id="save-settings-btn">Save settings</button>
    <div class="card">
      <div class="card-title">Connection</div>
      <div id="status-details" class="text-mid" style="font-size:13px;">Loading…</div>
    </div>`;
  API.status().then(status => {
    document.getElementById('status-details').innerHTML = `
      Alpaca configured: ${status.alpacaConfigured ? '✅' : '❌'}<br>
      Stock feed: ${escapeHtml(status.stockFeed)}<br>
      ${status.connection.configErrors.length ? '⚠ ' + status.connection.configErrors.map(escapeHtml).join('<br>⚠ ') : ''}
    `;
  });
  document.getElementById('save-settings-btn').addEventListener('click', async () => {
    const cryptoSymbols = document.getElementById('set-crypto').value.split(',').map(s => s.trim()).filter(Boolean);
    const stockSymbols = document.getElementById('set-stocks').value.split(',').map(s => s.trim()).filter(Boolean);
    const riskLimits = {
      maxRiskPerTradePct: parseFloat(document.getElementById('set-risk-per-trade').value) || 1.0,
      maxDailyLossPct: parseFloat(document.getElementById('set-max-daily-loss').value) || 3.0,
      maxPortfolioExposurePct: parseFloat(document.getElementById('set-max-exposure').value) || 50.0,
      maxOpenPositions: parseInt(document.getElementById('set-max-positions').value, 10) || 5,
    };
    await API.saveSettings({ cryptoSymbols, stockSymbols, riskLimits });
    App.settings.cryptoSymbols = cryptoSymbols; App.settings.stockSymbols = stockSymbols; App.settings.riskLimits = riskLimits;
    toast('Saved', 'success');
  });
};
