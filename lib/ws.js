'use strict';

/**
 * 最小可用的 RFC 6455 WebSocket 服务端实现（零依赖）。
 * 只支持服务端所需能力：文本/二进制帧、分片重组、ping/pong、close。
 * 不实现扩展（permessage-deflate 等）。
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { createSendBudget } = require('./connection-policy.cjs');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = {
  CONT: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

const STATE = {
  OPEN: 'open',
  CLOSING: 'closing',
  CLOSED: 'closed',
};

const MAX_MESSAGE = 4 * 1024 * 1024; // 单条消息上限 4MB（SDP 可能较大）
const MAX_SEND_QUEUE = 8 * 1024 * 1024;

class WebSocketConnection extends EventEmitter {
  constructor(socket, req, sendBudget) {
    super();
    this.socket = socket;
    this.req = req;
    this._sendBudget = sendBudget;
    this.readyState = STATE.OPEN;
    this._buf = Buffer.alloc(0);
    this._frag = null; // { opcode, chunks, size }
    this._closeSent = false;
    this._closed = false;
    this._pingTimer = null;
    this._lastPong = Date.now();

    socket.setNoDelay(true);
    socket.setTimeout(0);

    socket.on('data', (d) => this._onData(d));
    socket.on('error', () => this._destroy());
    socket.on('close', () => this._onSocketClose());
    socket.on('end', () => this._destroy());

    // 服务端保活：30s 一次 ping
    this._pingTimer = setInterval(() => {
      if (Date.now()-this._lastPong>90000) { this._destroy(); return; }
      if (this.readyState === STATE.OPEN) this._sendFrame(OP.PING, Buffer.alloc(0));
    }, 30000);
    if (this._pingTimer.unref) this._pingTimer.unref();
  }

  /* ------------------------------------------------------------------ */
  /* 接收                                                                */
  /* ------------------------------------------------------------------ */

  _onData(chunk) {
    if (this.readyState === STATE.CLOSED) return;
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    try {
      // 循环解析，直到缓冲区不足一帧
      while (this._parseFrame()) {
        /* keep going */
      }
    } catch (err) {
      this._fail(1002, 'protocol error');
    }
  }

  /** @returns {boolean} 是否消费了一帧 */
  _parseFrame() {
    const buf = this._buf;
    if (buf.length < 2) return false;

    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;

    if (rsv !== 0) throw new Error('RSV bits must be zero');
    if (!masked) throw new Error('Client frames must be masked');

    if (len === 126) {
      if (buf.length < 4) return false;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return false;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE)) throw new Error('frame too large');
      len = Number(big);
      offset = 10;
    }

    if (buf.length < offset + 4 + len) return false;

    const maskKey = buf.subarray(offset, offset + 4);
    const payload = Buffer.allocUnsafe(len);
    const src = buf.subarray(offset + 4, offset + 4 + len);
    for (let i = 0; i < len; i += 1) payload[i] = src[i] ^ maskKey[i & 3];

    this._buf = buf.subarray(offset + 4 + len);
    this._handleFrame(fin, opcode, payload);
    return this._buf.length >= 2;
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === OP.PING) {
      if (!fin || payload.length > 125) throw new Error('bad ping');
      this._sendFrame(OP.PONG, payload);
      return;
    }
    if (opcode === OP.PONG) { this._lastPong=Date.now(); return; }
    if (opcode === OP.CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      let reason = '';
      if (payload.length > 2) {
        try {
          reason = payload.subarray(2).toString('utf8');
        } catch (_) {
          reason = '';
        }
      }
      this._closeReceived(code, reason);
      return;
    }

    if (opcode === OP.TEXT || opcode === OP.BINARY) {
      if (this._frag) throw new Error('new data frame during fragmented message');
      if (!fin) {
        this._frag = { opcode, chunks: [payload], size: payload.length };
        return;
      }
      this._deliver(opcode, payload);
      return;
    }

    if (opcode === OP.CONT) {
      if (!this._frag) throw new Error('unexpected continuation frame');
      this._frag.chunks.push(payload);
      this._frag.size += payload.length;
      if (this._frag.size > MAX_MESSAGE) throw new Error('message too large');
      if (fin) {
        const frag = this._frag;
        this._frag = null;
        this._deliver(frag.opcode, Buffer.concat(frag.chunks));
      }
      return;
    }

    throw new Error('unknown opcode: ' + opcode);
  }

  _deliver(opcode, payload) {
    if (opcode === OP.TEXT) {
      let text;
      try {
        text = payload.toString('utf8');
      } catch (_) {
        this._fail(1007, 'invalid utf8');
        return;
      }
      this.emit('message', text, false);
    } else {
      this.emit('message', payload, true);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 发送                                                                */
  /* ------------------------------------------------------------------ */

  _sendFrame(opcode, payload) {
    if (this.readyState === STATE.CLOSED || this.socket.destroyed) return false;
    if (this.socket.writableLength + payload.length + 10 > MAX_SEND_QUEUE) {
      console.warn('websocket_send_queue_exceeded',{queuedBytes:this.socket.writableLength,payloadBytes:payload.length});
      this._destroy();return false;
    }
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const release = this._sendBudget.reserve(header.length + payload.length);
    if (!release) {
      console.warn('websocket_global_queue_exceeded',this._sendBudget.stats());
      this._destroy();return false;
    }
    try {
      this.socket.write(Buffer.concat([header, payload]),release);
      return true;
    } catch (_) {
      release();
      return false;
    }
  }

  send(data) {
    if (this.readyState !== STATE.OPEN) return false;
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    return this._sendFrame(OP.TEXT, payload);
  }

  sendBinary(buf) {
    if (this.readyState !== STATE.OPEN) return false;
    return this._sendFrame(OP.BINARY, Buffer.from(buf));
  }

  ping(payload = Buffer.alloc(0)) {
    return this._sendFrame(OP.PING, payload);
  }

  close(code = 1000, reason = '') {
    if (this.readyState !== STATE.OPEN) return;
    this.readyState = STATE.CLOSING;
    const reasonBuf = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code & 0xffff, 0);
    reasonBuf.copy(payload, 2);
    this._closeSent = true;
    this._sendFrame(OP.CLOSE, payload);
    this.socket.end();
    // 兜底：1.5s 后强制销毁
    setTimeout(() => this._destroy(), 1500).unref?.();
  }

  _closeReceived(code, reason) {
    this.readyState = STATE.CLOSING;
    if (!this._closeSent) {
      const reasonBuf = Buffer.from(String(reason).slice(0, 120), 'utf8');
      const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
      payload.writeUInt16BE(code === 1005 ? 1000 : code & 0xffff, 0);
      reasonBuf.copy(payload, 2);
      this._closeSent = true;
      this._sendFrame(OP.CLOSE, payload);
    }
    this.socket.end();
    this._destroy();
  }

  _fail(code, reason) {
    try {
      this.close(code, reason);
    } catch (_) {
      /* ignore */
    }
    this._destroy();
  }

  _destroy() {
    if (this._closed) return;
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = null;
    if (this.readyState !== STATE.CLOSED) {
      this.readyState = STATE.CLOSED;
      try {
        this.socket.destroy();
      } catch (_) {
        /* ignore */
      }
    }
    this._onSocketClose();
  }

  _onSocketClose() {
    if (this._closed) return;
    this._closed = true;
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = null;
    this.readyState = STATE.CLOSED;
    if (this._frag) this._frag = null;
    this._buf = Buffer.alloc(0);
    this.emit('close');
  }
}

class WebSocketServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this._conns = new Set();
    this._maxConnections = options.maxConnections || 512;
    this._sendBudget = createSendBudget({maxBytes:64 * 1024 * 1024,maxFrames:4096});
  }

  get size() {
    return this._conns.size;
  }

  /** 处理 http server 的 upgrade 事件 */
  handleUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    const version = req.headers['sec-websocket-version'];

    const reject = (code, msg) => {
      try {
        socket.write(
          `HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
        );
        socket.destroy();
      } catch (_) {
        /* ignore */
      }
    };

    if (upgrade !== 'websocket' || !key || String(version) !== '13') {
      reject(400, 'Bad Request');
      return;
    }
    if (this._conns.size >= this._maxConnections) {
      reject(503, 'Service Unavailable');
      return;
    }

    const accept = crypto
      .createHash('sha1')
      .update(key + GUID)
      .digest('base64');

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n');

    try {
      socket.write(headers);
    } catch (_) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);

    const conn = new WebSocketConnection(socket, req, this._sendBudget);
    this._conns.add(conn);
    conn.on('close', () => this._conns.delete(conn));
    this.emit('connection', conn, req);
    if (head && head.length) conn._onData(head);
  }

  closeAll(code, reason) {
    for (const conn of [...this._conns]) {
      try {
        conn.close(code, reason);
      } catch (_) {
        /* ignore */
      }
    }
    this._conns.clear();
  }
}

module.exports = { WebSocketServer, WebSocketConnection, OP, STATE };
