// @ts-check
import { objectValue } from './network-protocol.js';

/** @typedef {import('./screen-sfu.js').ScreenSfuCredential} Credential */
/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {{t:'screenSfuToken',requestId:string,channelId:string,sourceUserId:string}|{t:'screenSfuRelease',requestId:string,channelId:string,sourceUserId:string,identity:string}} Request */
/** @typedef {{request:Request,url:string,timer:ReturnType<typeof setTimeout>,resolve:(value:Credential|null)=>void,reject:(error:Error)=>void}} Pending */

/** Correlates authenticated room responses without exposing server secrets. */
export class ScreenRoomRequests {
  /** @param {(request:Request)=>boolean} send @param {()=>string|null} endpoint */
  constructor(send, endpoint) {
    this.send = send;
    this.endpoint = endpoint;
    /** @type {Map<string,Pending>} */ this.pending = new Map();
  }

  /** @param {Request} request @returns {Promise<Credential|null>} */
  request(request) {
    const url = this.endpoint();
    if (!url) return Promise.reject(new Error('当前房间没有配置屏幕 SFU'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(new Error(`屏幕授权请求超时：${request.t} / ${request.channelId}`));
      }, 20000);
      this.pending.set(request.requestId, { request, url, timer, resolve, reject });
      if (!this.send(request)) {
        clearTimeout(timer);
        this.pending.delete(request.requestId);
        reject(new Error('房间连接已断开，无法获取或撤销屏幕授权'));
      }
    });
  }

  /** @param {string} channelId @param {string} sourceUserId @returns {Promise<Credential>} */
  async token(channelId, sourceUserId) {
    const value = await this.request({ t: 'screenSfuToken', requestId: crypto.randomUUID(), channelId, sourceUserId });
    if (!value) throw new TypeError('Screen authorization response is empty');
    return value;
  }

  /** @param {string} channelId @param {string} sourceUserId @param {string} identity @returns {Promise<void>} */
  async release(channelId, sourceUserId, identity) { await this.request({ t: 'screenSfuRelease', requestId: crypto.randomUUID(), channelId, sourceUserId, identity }); }

  /** @param {JsonValue} raw @returns {void} */
  receive(raw) {
    const input = objectValue(raw);
    if (typeof input.requestId !== 'string') throw new TypeError('Screen authorization response has no request id');
    const pending = this.pending.get(input.requestId);
    if (!pending) { console.warn('screen_authorization_response_expired', { requestId: input.requestId }); return; }
    this.pending.delete(input.requestId);
    clearTimeout(pending.timer);
    try {
      if (input.t !== pending.request.t || input.channelId !== pending.request.channelId || input.sourceUserId !== pending.request.sourceUserId) throw new TypeError('Screen authorization response does not match its request');
      if (input.error !== undefined) {
        const error = objectValue(input.error);
        if (typeof error.code !== 'string' || typeof error.message !== 'string') throw new TypeError('Invalid screen authorization error');
        throw new Error(`屏幕授权失败（${error.code}）：${error.message}`);
      }
      if (input.t === 'screenSfuRelease') {
        if (input.ok !== true) throw new TypeError('Screen permission release was not acknowledged');
        pending.resolve(null);
        return;
      }
      if (input.url !== pending.url || typeof input.token !== 'string' || !input.token || input.token.length > 16384 || typeof input.identity !== 'string' || !input.identity || typeof input.publisherIdentity !== 'string' || !input.publisherIdentity || typeof input.expiresAt !== 'number' || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) throw new TypeError('Invalid screen authorization credentials');
      pending.resolve({ channelId: pending.request.channelId, sourceUserId: pending.request.sourceUserId, url: pending.url, token: input.token, identity: input.identity, publisherIdentity: input.publisherIdentity, expiresAt: input.expiresAt });
    } catch (error) { pending.reject(error instanceof Error ? error : new TypeError('Screen authorization response failed')); }
  }

  /** @returns {void} */
  disconnect() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('房间连接中断，屏幕授权请求已取消'));
    }
    this.pending.clear();
  }
}
