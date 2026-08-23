// Talks only to our own backend (same origin). The browser never sees Alpaca credentials -
// they live server-side in server/config.js, loaded from environment variables.
const API = {
  async _req(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch('/api' + path, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  },
  get(path) { return this._req('GET', path); },
  post(path, body) { return this._req('POST', path, body); },

  status() { return this.get('/status'); },
  scan(symbols, horizon) { return this.post('/scan', { symbols, horizon }); },
  allocate(payload) { return this.post('/allocate', payload); },
  backtest(payload) { return this.post('/backtest', payload); },
  portfolio() { return this.get('/portfolio'); },
  positions() { return this.get('/positions'); },
  openPosition(payload) { return this.post('/positions', payload); },
  closePosition(id, reason) { return this.post(`/positions/${id}/close`, { reason: reason || 'manual' }); },
  exitCheck(id) { return this.get(`/positions/${id}/exit-check`); },
  trades(limit) { return this.get(`/trades?limit=${limit || 200}`); },
  logs(limit) { return this.get(`/logs?limit=${limit || 200}`); },
  settings() { return this.get('/settings'); },
  saveSettings(payload) { return this.post('/settings', payload); },
  historical(assetType, symbol, params) {
    const q = new URLSearchParams(params || {}).toString();
    return this.get(`/historical/${assetType}/${encodeURIComponent(symbol)}${q ? '?' + q : ''}`);
  },
  snapshot(assetType, symbol) { return this.get(`/snapshot/${assetType}/${encodeURIComponent(symbol)}`); },
};

// Live WebSocket connection to our own backend (/ws), which fans out data from the ONE
// shared Alpaca connection the server holds. Reconnects automatically on drop.
class LiveFeed {
  constructor() {
    this.ws = null;
    this.subscriptions = new Map(); // "assetType:symbol" -> Set of callback fns
    this.snapshotCallbacks = new Map();
    this.connected = false;
    this.reconnectAttempts = 0;
    this._connect();
  }

  _connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      // Re-subscribe to everything we cared about before a reconnect
      for (const key of this.subscriptions.keys()) {
        const [assetType, symbol] = this._splitKey(key);
        this._send({ type: 'subscribe', symbol, assetType });
      }
      document.dispatchEvent(new CustomEvent('livefeed:connected'));
    };

    this.ws.onclose = () => {
      this.connected = false;
      document.dispatchEvent(new CustomEvent('livefeed:disconnected'));
      const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 15000);
      this.reconnectAttempts++;
      setTimeout(() => this._connect(), delay);
    };

    this.ws.onerror = () => { /* onclose will fire next and handle reconnect */ };

    this.ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      const isLiveData = msg.type === 'trade' || msg.type === 'quote' || msg.type === 'bar' || msg.type === 'snapshot';
      if (isLiveData) {
        const key = `${msg.assetType}:${msg.symbol}`;
        const callbacks = this.subscriptions.get(key);
        if (callbacks) callbacks.forEach((cb) => cb(msg));
      } else if (msg.type === 'error') {
        console.warn('LiveFeed error:', msg.error);
      }
    };
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  _splitKey(key) {
    const idx = key.indexOf(':');
    return [key.slice(0, idx), key.slice(idx + 1)];
  }

  subscribe(symbol, assetType, callback) {
    const key = `${assetType}:${symbol}`;
    if (!this.subscriptions.has(key)) {
      this.subscriptions.set(key, new Set());
      this._send({ type: 'subscribe', symbol, assetType });
    }
    this.subscriptions.get(key).add(callback);
    return () => this.unsubscribe(symbol, assetType, callback);
  }

  unsubscribe(symbol, assetType, callback) {
    const key = `${assetType}:${symbol}`;
    const callbacks = this.subscriptions.get(key);
    if (!callbacks) return;
    callbacks.delete(callback);
    if (callbacks.size === 0) {
      this.subscriptions.delete(key);
      this._send({ type: 'unsubscribe', symbol, assetType });
    }
  }
}
