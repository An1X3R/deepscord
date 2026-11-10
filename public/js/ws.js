/* WebSocket 客户端：自动重连 + 事件分发 + 延迟测量 */

export class Socket {
  constructor({ url, onStatus, onEvent, onLatency }) {
    this.url = url;
    this.onStatus = onStatus || (() => {});
    this.onEvent = onEvent || (() => {});
    this.onLatency = onLatency || (() => {});
    this.ws = null;
    this.status = 'idle';
    this._retry = 0;
    this._closedByUser = false;
    this._timers = new Set();
    this._pingTimer = null;
    this._lastPong = Date.now();
  }

  connect() {
    this._closedByUser = false;
    this._clearTimers();
    this._setStatus(this._retry === 0 ? 'connecting' : 'reconnecting');

    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this._lastPong = Date.now();
      this._retry = 0;
      this._setStatus('open');
      this._startPing();
    });

    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'pong') {
        this._lastPong = Date.now();
        if (typeof msg.ts === 'number') this.onLatency(Math.max(0, Date.now() - msg.ts));
        return;
      }
      try {
        this.onEvent(msg);
      } catch (err) {
        console.error('[ws] 事件处理异常', msg.t, err);
      }
    });

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this._stopPing();
      if (this._closedByUser) {
        this._setStatus('closed');
        return;
      }
      this._setStatus('disconnected');
      this._scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch (_) {
        /* ignore */
      }
    });
  }

  _startPing() {
    this._stopPing();
    const ping = () => {
      if (this.status !== 'open') return;
      if (Date.now() - this._lastPong > 20000) {
        console.warn('Room heartbeat timed out', { elapsedMs: Date.now() - this._lastPong });
        this.ws.close();
        return;
      }
      this.send({ t: 'ping', ts: Date.now() });
    };
    ping();
    this._pingTimer = setInterval(ping, 5000);
  }

  _stopPing() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  _scheduleReconnect() {
    this._retry += 1;
    const delay = Math.min(8000, 400 * 2 ** Math.min(this._retry, 5)) + Math.random() * 300;
    console.warn('Retrying room connection', { attempt: this._retry, delayMs: Math.round(delay) });
    const timer = setTimeout(() => {
      this._timers.delete(timer);
      this.connect();
    }, delay);
    this._timers.add(timer);
  }

  _clearTimers() {
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
  }

  _setStatus(status) {
    this.status = status;
    this.onStatus(status);
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch (_) {
      return false;
    }
  }

  close() {
    this._closedByUser = true;
    this._stopPing();
    this._clearTimers();
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {
        /* ignore */
      }
    }
  }
}
