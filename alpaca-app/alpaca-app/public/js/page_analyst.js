// Session id for chat memory - regenerated each page load, sent with every message so the
// backend's per-session history (server/index.js's chatSessions map) knows the context.
let _analystSessionId = null;
let _analystHorizon = 'short_term';
let _analystHistory = []; // [{role:'user'|'assistant', text, payload?}] for re-rendering

const QUICK_ACTIONS = [
  { label: 'Analyze Stock', template: 'Analyze ' },
  { label: 'Analyze Crypto', template: 'Analyze ' },
  { label: 'Analyze ETF', template: 'Analyze ' },
  { label: 'Analyze Nasdaq', send: 'Analyze Nasdaq' },
  { label: 'Compare Assets', template: 'Compare ' },
  { label: 'Market Overview', send: 'What is happening in the market?' },
  { label: 'Find Momentum', template: 'Is ' },
  { label: 'Explain This Move', template: 'Why is ' },
];
const EXAMPLE_PROMPTS = [
  'Analyze NVDA', 'Is QQQ showing bullish momentum?', 'Why is BTC moving today?',
  'Compare AAPL vs MSFT', 'Analyze ETH and explain the risks',
];

PAGE_RENDERERS.analyst = async function () {
  if (!_analystSessionId) _analystSessionId = 'sess-' + Math.random().toString(36).slice(2) + Date.now();
  const el = document.getElementById('page-analyst');

  el.innerHTML = `
    <div class="horizon-toggle mb-16" id="analyst-horizon-toggle">
      <button data-h="short_term" class="${_analystHorizon === 'short_term' ? 'active' : ''}">Day Trading</button>
      <button data-h="long_term" class="${_analystHorizon === 'long_term' ? 'active' : ''}">Long-Term Holds</button>
    </div>

    <div class="card mb-16" id="analyst-chat-card">
      <div id="analyst-messages"></div>

      <div style="position:relative; margin-top:12px;">
        <div style="display:flex; gap:8px;">
          <input type="text" id="analyst-input" class="form-input" autocomplete="off"
            placeholder="Ask me to analyze a stock, crypto, ETF, index, or market...">
          <button class="btn btn-primary" id="analyst-send-btn">Send</button>
        </div>
        <div id="analyst-autocomplete" class="analyst-autocomplete hidden"></div>
      </div>

      <div class="analyst-quick-actions">
        ${QUICK_ACTIONS.map((a, i) => `<button class="btn btn-ghost btn-sm" data-quick-idx="${i}">${escapeHtml(a.label)}</button>`).join('')}
      </div>
      <div class="form-hint" style="margin-top:10px;">Try: ${EXAMPLE_PROMPTS.map((p, i) => `<span class="analyst-example" data-example-idx="${i}">"${escapeHtml(p)}"</span>`).join(' &nbsp;\u00b7&nbsp; ')}</div>
    </div>

    <div class="form-hint" style="text-align:center;">This tool provides educational and informational market analysis, not personalized financial advice or a guarantee of investment results. Verify independently before making financial decisions.</div>
  `;

  renderAnalystHistory();

  document.querySelectorAll('#analyst-horizon-toggle button').forEach(btn => {
    btn.addEventListener('click', () => { _analystHorizon = btn.dataset.h; switchTab('analyst'); });
  });
  document.querySelectorAll('[data-quick-idx]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = QUICK_ACTIONS[parseInt(btn.dataset.quickIdx, 10)];
      if (action.send) sendAnalystMessage(action.send);
      else { const input = document.getElementById('analyst-input'); input.value = action.template; input.focus(); }
    });
  });
  document.querySelectorAll('[data-example-idx]').forEach(exEl => {
    exEl.addEventListener('click', () => sendAnalystMessage(EXAMPLE_PROMPTS[parseInt(exEl.dataset.exampleIdx, 10)]));
  });

  const input = document.getElementById('analyst-input');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value.trim()) sendAnalystMessage(input.value.trim()); });
  document.getElementById('analyst-send-btn').addEventListener('click', () => { if (input.value.trim()) sendAnalystMessage(input.value.trim()); });

  wireAnalystAutocomplete(input);
};

// ---------- Autocomplete ----------

let _autocompleteDebounceTimer = null;
function wireAnalystAutocomplete(input) {
  const dropdown = document.getElementById('analyst-autocomplete');
  input.addEventListener('input', () => {
    const lastWord = input.value.split(/\s+/).pop();
    clearTimeout(_autocompleteDebounceTimer);
    if (!lastWord || lastWord.length < 1) { dropdown.classList.add('hidden'); return; }
    _autocompleteDebounceTimer = setTimeout(async () => {
      try {
        const { results } = await API.searchSymbols(lastWord, 6);
        if (!results.length) { dropdown.classList.add('hidden'); return; }
        dropdown.innerHTML = results.map(r => `<div class="analyst-autocomplete-item" data-symbol="${escapeHtml(r.symbol)}"><span class="mono">${escapeHtml(r.symbol)}</span><span class="text-low">${escapeHtml(r.name)}</span></div>`).join('');
        dropdown.classList.remove('hidden');
        dropdown.querySelectorAll('[data-symbol]').forEach(item => {
          item.addEventListener('click', () => {
            const words = input.value.split(/\s+/);
            words[words.length - 1] = item.dataset.symbol;
            input.value = words.join(' ') + ' ';
            dropdown.classList.add('hidden');
            input.focus();
          });
        });
      } catch (e) { dropdown.classList.add('hidden'); }
    }, 250); // debounced so every keystroke doesn't fire a request
  });
  input.addEventListener('blur', () => setTimeout(() => dropdown.classList.add('hidden'), 150));
}

// ---------- Chat ----------

async function sendAnalystMessage(text) {
  const input = document.getElementById('analyst-input');
  const sendBtn = document.getElementById('analyst-send-btn');
  input.value = '';
  document.getElementById('analyst-autocomplete').classList.add('hidden');

  _analystHistory.push({ role: 'user', text });
  renderAnalystHistory();

  sendBtn.disabled = true;
  input.disabled = true;
  _analystHistory.push({ role: 'assistant', text: '', loading: true });
  renderAnalystHistory();

  try {
    const result = await API.analystChat(text, _analystSessionId, _analystHorizon);
    _analystHistory[_analystHistory.length - 1] = { role: 'assistant', text: result.reply, payload: result.payload, symbol: result.symbol };
  } catch (e) {
    _analystHistory[_analystHistory.length - 1] = { role: 'assistant', text: '', error: e.message };
  }
  renderAnalystHistory();
  sendBtn.disabled = false;
  input.disabled = false;
  input.focus();
}

function renderAnalystHistory() {
  const el = document.getElementById('analyst-messages');
  if (!el) return;
  if (!_analystHistory.length) {
    el.innerHTML = emptyState('Ask about any stock, crypto, or ETF', 'Try one of the example prompts below, or type your own question.');
    return;
  }
  if (el.querySelector('.empty-state')) el.innerHTML = '';

  _analystHistory.forEach((m, i) => {
    const existing = document.getElementById(`analyst-msg-${i}`);
    const isLast = i === _analystHistory.length - 1;
    // Only touch the DOM for a message that doesn't exist yet, or the most recent one
    // (which may be transitioning from a loading placeholder into the real response).
    // Every earlier message - and any chart inside it - is left completely alone, so
    // charts that already loaded don't silently re-fetch every time a new message arrives.
    if (existing && !isLast) return;

    const html = renderOneAnalystMessageHtml(m, i);
    if (existing) {
      existing.outerHTML = html;
    } else {
      el.insertAdjacentHTML('beforeend', html);
    }
  });

  el.scrollTop = el.scrollHeight;
  const lastEl = document.getElementById(`analyst-msg-${_analystHistory.length - 1}`);
  if (lastEl) wireAnalystMessageInteractions(lastEl);
}

function renderOneAnalystMessageHtml(m, i) {
  if (m.role === 'user') return `<div class="analyst-msg analyst-msg-user" id="analyst-msg-${i}">${escapeHtml(m.text)}</div>`;
  if (m.loading) return `<div class="analyst-msg analyst-msg-ai" id="analyst-msg-${i}"><span class="spinner"></span> Checking market data, calculating indicators, checking recent news\u2026</div>`;
  if (m.error) return `<div class="analyst-msg analyst-msg-ai analyst-msg-error" id="analyst-msg-${i}">Couldn't complete that analysis: ${escapeHtml(m.error)}</div>`;
  return `<div class="analyst-msg analyst-msg-ai" id="analyst-msg-${i}">
    ${m.payload ? marketPanelHtml(m.payload) : ''}
    <div class="analyst-response-text">${renderAnalystMarkdown(m.text)}</div>
    ${m.payload ? evidenceSectionHtml(m.payload, i) : ''}
    ${followUpChipsHtml(m)}
  </div>`;
}

function wireAnalystMessageInteractions(container) {
  container.querySelectorAll('[data-followup-action]').forEach(chip => {
    chip.addEventListener('click', () => {
      if (chip.dataset.followupAction === 'switchHorizon') {
        _analystHorizon = chip.dataset.followupHorizon;
        const toggle = document.getElementById('analyst-horizon-toggle');
        if (toggle) toggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.h === _analystHorizon));
        sendAnalystMessage(`Analyze ${chip.dataset.followupSymbol}`);
      } else {
        sendAnalystMessage(chip.dataset.followupText);
      }
    });
  });
  container.querySelectorAll('[data-evidence-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = document.getElementById(btn.dataset.evidenceToggle);
      const wasHidden = panel.classList.contains('hidden');
      panel.classList.toggle('hidden');
      btn.textContent = wasHidden ? 'Hide evidence \u25b4' : 'Show evidence \u25be';
    });
  });
  wireChartToolbars(container);
}

function followUpChipsHtml(message) {
  if (!message.payload) return '';
  const chips = []; // {text, action: 'send'|'switchHorizon', symbol?, horizon?}
  if (message.payload.comparison) {
    chips.push({ text: `Show the bear case for ${message.payload.assetA.asset}`, action: 'send' });
    chips.push({ text: `Show recent news for ${message.payload.assetA.asset}`, action: 'send' });
  } else if (message.symbol) {
    chips.push({ text: `Show the bear case for ${message.symbol}`, action: 'send' });
    chips.push({ text: `Show recent news for ${message.symbol}`, action: 'send' });
    chips.push({ text: `Explain the risks for ${message.symbol}`, action: 'send' });
    const otherHorizon = _analystHorizon === 'short_term' ? 'long_term' : 'short_term';
    const otherLabel = otherHorizon === 'long_term' ? 'long-term holding' : 'day trading';
    chips.push({ text: `Analyze ${message.symbol} for ${otherLabel} instead`, action: 'switchHorizon', symbol: message.symbol, horizon: otherHorizon });
  }
  if (!chips.length) return '';
  return `<div class="analyst-followups">${chips.map((c) => `<button class="analyst-followup-chip"
    data-followup-text="${escapeHtml(c.text)}" data-followup-action="${c.action}"
    ${c.symbol ? `data-followup-symbol="${escapeHtml(c.symbol)}"` : ''}
    ${c.horizon ? `data-followup-horizon="${c.horizon}"` : ''}>${escapeHtml(c.text)}</button>`).join('')}</div>`;
}

function marketPanelHtml(payload) {
  if (payload.marketOverview) return marketOverviewPanelHtml(payload);
  if (payload.comparison) {
    return `<div class="analyst-market-panel">${marketPanelSingleHtml(payload.assetA)}${marketPanelSingleHtml(payload.assetB)}</div>`;
  }
  return `<div class="analyst-market-panel">${marketPanelSingleHtml(payload)}</div>`;
}

function marketOverviewPanelHtml(payload) {
  // Compact grid, not a full per-asset breakdown - a chart+scorecard for all 5 assets at
  // once would be overwhelming for what's meant to be a quick multi-asset glance.
  const rows = payload.assets.map((a) => {
    const nameCell = `<span class="mono">${escapeHtml(a.asset)}</span><span class="text-low" style="font-size:10.5px; margin-left:6px;">${escapeHtml(a.label || '')}</span>`;
    if (a.currentPrice == null) {
      return `<div class="overview-row"><span>${nameCell}</span><span class="text-low" style="font-size:11.5px;">Live market data unavailable</span><span></span></div>`;
    }
    const changeCls = a.priceChange && a.priceChange.percent >= 0 ? 'up' : 'down';
    return `<div class="overview-row">
      <span>${nameCell}</span>
      <span class="mono">${fmtMoney(a.currentPrice)}</span>
      ${a.priceChange ? `<span class="watchlist-change ${changeCls}">${a.priceChange.percent >= 0 ? '\u25b2' : '\u25bc'} ${fmtPct(a.priceChange.percent)}</span>` : '<span></span>'}
    </div>`;
  }).join('');
  return `<div class="analyst-market-panel-single"><div class="signal-symbol" style="margin-bottom:6px;">Market Overview</div>${rows}</div>`;
}

function marketPanelSingleHtml(p) {
  if (p.currentPrice == null) {
    return `<div class="analyst-market-panel-single"><div class="signal-symbol">${escapeHtml(p.asset)}</div><div class="text-low" style="font-size:12px;">Live market data unavailable</div></div>`;
  }
  const changeCls = p.priceChange && p.priceChange.percent >= 0 ? 'up' : 'down';
  const statusCls = p.marketStatus ? `market-status-${p.marketStatus.status}` : '';
  return `<div class="analyst-market-panel-single">
    <div class="signal-header" style="margin-bottom:4px; flex-wrap:wrap;">
      <span class="signal-symbol">${escapeHtml(p.asset)}</span>
      ${p.indexNote ? `<span class="text-low" style="font-size:10.5px;">(ETF proxy)</span>` : ''}
      ${p.marketStatus ? `<span class="market-status-badge ${statusCls}">${escapeHtml(p.marketStatus.label)}</span>` : ''}
      <span class="data-type-badge ${p.dataType === 'live' ? 'live' : ''}">${p.dataType === 'live' ? '\u25cf LIVE' : 'HISTORICAL'}</span>
    </div>
    <div class="watchlist-price">${fmtMoney(p.currentPrice)}</div>
    ${p.priceChange ? `<div class="watchlist-change ${changeCls}">${p.priceChange.percent >= 0 ? '\u25b2' : '\u25bc'} ${fmtPct(p.priceChange.percent)}</div>` : ''}
    <div class="text-low" style="font-size:11px; margin-top:4px;">Vol ${p.volume != null ? Math.round(p.volume).toLocaleString() : '\u2014'} \u00b7 as of ${fmtDate(p.timestamps.marketData)}</div>
    ${p.scorecard ? scorecardHtml(p.scorecard) : ''}
    ${!p.comparison ? chartSectionHtml(p) : ''}
  </div>`;
}

function scorecardHtml(scorecard) {
  const bar = (key, label) => {
    const cat = scorecard[key];
    if (cat.score == null) return `<div class="scorecard-row"><span class="scorecard-label">${label}</span><span class="text-low" style="font-size:11px;">Insufficient data</span></div>`;
    const color = cat.score >= 55 ? 'var(--mint)' : cat.score <= 45 ? 'var(--rose)' : 'var(--amber)';
    return `<div class="scorecard-item">
      <div class="scorecard-row">
        <span class="scorecard-label">${label}</span>
        <span class="scorecard-bar-track"><span class="scorecard-bar-fill" style="width:${cat.score}%; background:${color};"></span></span>
        <span class="scorecard-value">${cat.score}/100 \u00b7 ${escapeHtml(cat.label)}</span>
      </div>
      <div class="scorecard-why">${escapeHtml(cat.why)}</div>
    </div>`;
  };
  return `<div style="margin-top:10px; padding-top:8px; border-top:1px solid var(--line);">
    ${bar('trend', 'Trend')}${bar('momentum', 'Momentum')}${bar('volume', 'Volume')}
  </div>`;
}

// ---------- Chart (reuses the existing /api/historical endpoint - no new backend needed) ----------

const CHART_RANGES = [
  { label: '1D', timeframe: '1Hour', limit: 8 },
  { label: '5D', timeframe: '1Hour', limit: 40 },
  { label: '1M', timeframe: '1Day', limit: 22 },
  { label: '3M', timeframe: '1Day', limit: 65 },
  { label: '6M', timeframe: '1Day', limit: 130 },
  { label: '1Y', timeframe: '1Day', limit: 260 },
];

function chartSectionHtml(p) {
  const chartId = 'chart-' + Math.random().toString(36).slice(2);
  return `<div style="margin-top:12px;">
    <div class="analyst-chart-toolbar" data-chart-toolbar="${chartId}" data-symbol="${escapeHtml(p.asset)}" data-asset-type="${escapeHtml(p.assetType)}">
      ${CHART_RANGES.map((r, i) => `<button data-range-idx="${i}" class="${i === 2 ? 'active' : ''}">${r.label}</button>`).join('')}
    </div>
    <canvas id="${chartId}" height="140" data-symbol="${escapeHtml(p.asset)}" data-asset-type="${escapeHtml(p.assetType)}"></canvas>
  </div>`;
}

async function loadAndDrawChart(canvasId, symbol, assetType, rangeIdx) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const range = CHART_RANGES[rangeIdx];
  try {
    const { bars } = await API.historical(assetType, symbol, { timeframe: range.timeframe, limit: range.limit });
    drawPriceVolumeChart(canvas, bars);
  } catch (e) {
    console.error('Chart failed to load/draw:', e);
  }
}

function drawPriceVolumeChart(canvas, bars) {
  if (!bars || !bars.length) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return; // no canvas support in this environment - fail silently rather than crash
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 400, h = 140;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const priceH = h * 0.72, volH = h * 0.22, pad = 6, labelPad = 44; // labelPad reserves space for price labels on the right
  const chartW = w - labelPad;
  const closes = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  const sma20 = simpleMovingAverage(closes, 20);
  const minP = Math.min(...closes), maxP = Math.max(...closes);
  const rangeP = (maxP - minP) || 1;
  const maxV = Math.max(...volumes) || 1;
  const denom = Math.max(bars.length - 1, 1); // avoid divide-by-zero when there's only 1 bar

  const xFor = (i) => pad + (bars.length === 1 ? (chartW - pad * 2) / 2 : (i / denom) * (chartW - pad * 2));
  const yFor = (price) => pad + (1 - (price - minP) / rangeP) * (priceH - pad * 2);

  // Price line
  ctx.strokeStyle = '#3DDCFF';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  bars.forEach((b, i) => { const x = xFor(i), y = yFor(b.close); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();

  // SMA20 overlay, only where it's actually defined (needs 20 bars of history)
  const hasSma = sma20.some((v) => v != null);
  if (hasSma) {
    ctx.strokeStyle = '#F5A623';
    ctx.lineWidth = 1.25;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    let started = false;
    bars.forEach((b, i) => {
      if (sma20[i] == null) return;
      const x = xFor(i), y = yFor(sma20[i]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Price scale labels (real numeric anchors, not just an abstract line)
  ctx.fillStyle = '#8B93A1';
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(fmtMoney(maxP), chartW + 4, pad + 8);
  ctx.fillText(fmtMoney(minP), chartW + 4, priceH - 2);

  // Volume bars
  const barWidth = Math.max((chartW - pad * 2) / bars.length - 1, 1);
  bars.forEach((b, i) => {
    const x = xFor(i);
    const barH = (b.volume / maxV) * (volH - 4);
    ctx.fillStyle = 'rgba(139,147,161,0.4)';
    ctx.fillRect(x - barWidth / 2, h - barH, barWidth, barH);
  });
}

function simpleMovingAverage(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function wireChartToolbars(container) {
  container.querySelectorAll('[data-chart-toolbar]').forEach(toolbar => {
    const canvasId = toolbar.dataset.chartToolbar;
    const symbol = toolbar.dataset.symbol;
    const assetType = toolbar.dataset.assetType;
    loadAndDrawChart(canvasId, symbol, assetType, 2); // default to 1M
    toolbar.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        toolbar.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loadAndDrawChart(canvasId, symbol, assetType, parseInt(btn.dataset.rangeIdx, 10));
      });
    });
  });
}

function evidenceSectionHtml(payload, idx) {
  let sources, warnings;
  if (payload.marketOverview) {
    sources = payload.assets.flatMap((a) => a.sources || []);
    warnings = [...(payload.errors || []), ...payload.assets.flatMap((a) => a.warnings || [])];
  } else if (payload.comparison) {
    sources = [...payload.assetA.sources, ...payload.assetB.sources];
    warnings = [...payload.assetA.warnings, ...payload.assetB.warnings];
  } else {
    sources = payload.sources;
    warnings = payload.warnings;
  }
  const panelId = `evidence-panel-${idx}`;
  return `
    <button class="details-toggle" data-evidence-toggle="${panelId}">Show evidence \u25be</button>
    <div class="details-panel hidden" id="${panelId}">
      ${sources.map(s => `<div class="analyst-evidence-row">
        <span>${escapeHtml(s.label)}</span>
        <span class="text-low mono" style="font-size:11px;">${escapeHtml(s.provider)}${s.timestamp ? ' \u00b7 ' + fmtDate(s.timestamp) : ''}</span>
      </div>`).join('')}
      ${warnings.length ? `<div class="analyst-warnings">${warnings.map(w => `<div>\u26a0 ${escapeHtml(w)}</div>`).join('')}</div>` : ''}
    </div>`;
}

/**
 * Minimal, SAFE markdown rendering for the AI's response: escapes all HTML first (the
 * response could theoretically echo untrusted text like a news headline), then applies a
 * small set of transformations for the fixed structure our system prompt asks for
 * (## headers, **bold**, - lists). Not a general markdown parser - deliberately narrow.
 */
function renderAnalystMarkdown(text) {
  const escaped = escapeHtml(text);
  const lines = escaped.split('\n');
  let html = '';
  let inList = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<div class="analyst-section-header">${line.replace(/^##\s+/, '')}</div>`;
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) { html += '<ul class="analyst-list">'; inList = true; }
      html += `<li>${applyInlineMarkdown(line.replace(/^[-*]\s+/, ''))}</li>`;
    } else if (line.trim() === '') {
      if (inList) { html += '</ul>'; inList = false; }
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<p>${applyInlineMarkdown(line)}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html;
}
function applyInlineMarkdown(line) {
  return line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}
