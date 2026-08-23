function fmtMoney(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPct(n, d = 2) { return (n === null || n === undefined || isNaN(n)) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`; }
function fmtNum(n, d = 4) { return (n === null || n === undefined || isNaN(n)) ? '—' : Number(n).toFixed(d); }
function fmtDate(iso) { return iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function directionTag(direction) {
  const map = { long: 'tag-long', short: 'tag-short', flat: 'tag-flat' };
  const label = { long: 'LONG', short: 'SHORT', flat: 'FLAT' };
  return `<span class="tag ${map[direction] || 'tag-flat'}">${label[direction] || direction}</span>`;
}
function horizonTag(h) { return `<span class="tag tag-horizon">${h === 'long_term' ? 'LONG-TERM' : 'DAY TRADE'}</span>`; }
function dirClass(d) { return d === 'long' ? 'dir-long' : d === 'short' ? 'dir-short' : ''; }

function freshnessBadge(freshness) {
  const label = { live: 'LIVE', recent: 'RECENT', stale: 'STALE', disconnected: 'DISCONNECTED' }[freshness] || 'DISCONNECTED';
  return `<span class="freshness-badge freshness-${freshness}"><span class="dot"></span>${label}</span>`;
}

function confidenceMeter(score, size = 56) {
  const stroke = 5, r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const offset = c * (1 - pct);
  let color = '#8B93A1';
  if (score >= 65) color = '#3EE6A0'; else if (score >= 55) color = '#3DDCFF';
  else if (score <= 35) color = '#FF5C7A'; else if (score <= 45) color = '#F5A623';
  return `<div class="meter-wrap" style="width:${size}px;height:${size}px;">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle class="meter-track" cx="${size/2}" cy="${size/2}" r="${r}"></circle>
      <circle class="meter-fill" cx="${size/2}" cy="${size/2}" r="${r}" stroke="${color}" stroke-dasharray="${c}" stroke-dashoffset="${offset}"></circle>
    </svg>
    <div class="meter-label" style="color:${color}">${Math.round(score)}</div>
  </div>`;
}

function factorList(factors, cls) {
  if (!factors || !factors.length) return '';
  const dot = cls === 'bull' ? '▲' : '▼';
  return `<div class="factor-list">${factors.map(f => `<div class="factor ${cls}"><span>${dot}</span><span>${escapeHtml(f)}</span></div>`).join('')}</div>`;
}
function emptyState(title, body) {
  return `<div class="empty-state"><div class="empty-state-title">${escapeHtml(title)}</div><div class="empty-state-body">${escapeHtml(body)}</div></div>`;
}
function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}
function plainLanguageSummary(signal) {
  if (signal.direction === 'flat') return `No clear edge on ${signal.symbol} right now — the signals are mixed.`;
  const dirWord = signal.direction === 'long' ? 'buying' : 'selling / avoiding';
  const strength = Math.abs(signal.masterConfidence - 50);
  const strengthWord = strength >= 25 ? 'a strong' : strength >= 15 ? 'a decent' : 'a slight';
  const riskWord = signal.riskScore >= 65 ? 'high' : signal.riskScore <= 35 ? 'low' : 'moderate';
  return `This looks like ${strengthWord} case for ${dirWord} ${signal.symbol} right now, with ${riskWord} volatility risk.`;
}
function dollarProjection(signal, amount = 1000) {
  const targetGain = amount * ((signal.expectedReturnPct || 0) / 100);
  const stopLoss = amount * ((signal.expectedDrawdownPct || 0) / 100);
  return { amount, targetValue: amount + targetGain, targetGain, stopValue: amount - stopLoss, stopLoss };
}
function dollarProjectionHtml(signal, amount, isExample) {
  const p = dollarProjection(signal, amount);
  const label = isExample ? `Example with ${fmtMoney(amount)}` : `Your ${fmtMoney(amount)}`;
  return `<div class="projection-box">
    <div class="projection-label">${label}</div>
    <div class="projection-row"><span class="projection-outcome up">If it hits target: <strong>${fmtMoney(p.targetValue)}</strong> (+${fmtMoney(p.targetGain)})</span></div>
    <div class="projection-row"><span class="projection-outcome down">If it hits stop: <strong>${fmtMoney(p.stopValue)}</strong> (-${fmtMoney(p.stopLoss)})</span></div>
  </div>`;
}
