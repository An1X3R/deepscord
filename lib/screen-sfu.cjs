'use strict';
// @ts-check

const crypto = require('node:crypto');
const http = require('node:http');

/** @typedef {null|boolean|number|string|JsonValue[]|{[key:string]:JsonValue}} JsonValue */
/** @typedef {{mode:'peer-relay'}|{mode:'sfu',url:string,internalUrl:string,apiKey:string,apiSecret:string,ttlSeconds:number}} ScreenPolicy */
/** @typedef {{userId:string,channelId:string,sessionId:string}} Member */
/** @typedef {{channelId:string,sourceUserId:string,url:string,token:string,expiresAt:number,identity:string,publisherIdentity:string}} ScreenSfuCredential */
/** @typedef {{channelId:string,sourceUserId:string,requestId:string,identity?:string}} ScreenRequest */
/** @typedef {{identity:string,room:string,userId:string,sourceUserId:string,channelId:string,sessionId:string,sourceSessionId:string,publisherIdentity:string,role:'publish'|'watch',sockets:Set<import('node:stream').Duplex>}} Lease */
/** @typedef {{lease:Lease,affected:Lease[],pending:Promise<void>|null}} Revocation */

class ScreenSfuError extends Error {
  /** @param {string} code @param {string} message @param {number} status */
  constructor(code, message, status) { super(message); this.name = 'ScreenSfuError'; this.code = code; this.status = status; }
}

/** @param {NodeJS.ProcessEnv} env @returns {ScreenPolicy} */
function readScreenPolicy(env) {
  const mode = env.ECHO_SCREEN_MODE || 'peer-relay';
  if (mode === 'peer-relay') return { mode };
  if (mode !== 'sfu') throw new TypeError('ECHO_SCREEN_MODE must be peer-relay or sfu');
  const url = new URL(env.ECHO_SCREEN_SFU_URL || '');
  if ((url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) || url.pathname !== '/screen-sfu' || url.username || url.password || url.search || url.hash) {
    throw new TypeError('ECHO_SCREEN_SFU_URL must be wss://<room-server>/screen-sfu (ws is allowed only on loopback)');
  }
  const internal = new URL(env.LIVEKIT_INTERNAL_URL || '');
  if (internal.protocol !== 'http:' || internal.hostname !== '127.0.0.1' || !internal.port || internal.pathname !== '/' || internal.username || internal.password || internal.search || internal.hash) {
    throw new TypeError('LIVEKIT_INTERNAL_URL must be http://127.0.0.1:<private-signaling-port>; LiveKit signaling must bind loopback');
  }
  const apiKey = env.LIVEKIT_API_KEY || '';
  const apiSecret = env.LIVEKIT_API_SECRET || '';
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(apiKey) || apiSecret.length < 32 || apiSecret.length > 256) throw new TypeError('LiveKit requires a server-only API key and a 32–256 character API secret');
  const ttlSeconds = Number(env.ECHO_SCREEN_TOKEN_TTL_SECONDS || '60');
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 15 || ttlSeconds > 120) throw new TypeError('ECHO_SCREEN_TOKEN_TTL_SECONDS must be an integer from 15 to 120');
  return { mode, url: url.href, internalUrl: internal.href, apiKey, apiSecret, ttlSeconds };
}

/** @param {ScreenPolicy} policy @returns {{mode:'peer-relay'}|{mode:'sfu',url:string}} */
function publicScreenConfig(policy) { return policy.mode === 'sfu' ? { mode: 'sfu', url: policy.url } : { mode: 'peer-relay' }; }

/** @param {{[key:string]:JsonValue}} raw @returns {ScreenRequest} */
function parseScreenRequest(raw) {
  const { requestId, channelId, sourceUserId } = raw;
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) throw new ScreenSfuError('invalid-request', 'requestId must contain 1–80 letters, digits, underscores or hyphens', 400);
  if (typeof channelId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(channelId) || typeof sourceUserId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(sourceUserId)) throw new ScreenSfuError('invalid-request', 'channelId and sourceUserId must be explicit valid identifiers', 400);
  if (raw.t === 'screenSfuRelease') {
    if (typeof raw.identity !== 'string' || !/^[A-Za-z0-9_-]{1,80}\.screen\.[a-f0-9]{32}$/.test(raw.identity)) throw new ScreenSfuError('invalid-request', 'Screen permission release requires the exact credential identity', 400);
    return { requestId, channelId, sourceUserId, identity: raw.identity };
  }
  return { requestId, channelId, sourceUserId };
}

/** @param {Error} error @param {string} operation */
function reportScreenError(error, operation) {
  console.error(JSON.stringify({ event: 'screen-sfu-error', operation, name: error.name, code: error instanceof ScreenSfuError ? error.code : 'upstream-failure', message: error instanceof ScreenSfuError ? error.message : 'LiveKit operation failed; check the private service logs' }));
}

/** @param {Error} error @returns {boolean} */
function isMissing(error) { return 'status' in error && error.status === 404 || 'code' in error && error.code === 'not_found'; }

/** @template T @param {string} operation @param {()=>Promise<T>} request @returns {Promise<T>} */
async function adminRequest(operation, request) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await request(); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      const status = 'status' in error && typeof error.status === 'number' ? error.status : 0;
      if (attempt === 3 || isMissing(error) || status >= 400 && status < 500) throw error;
      console.warn(JSON.stringify({ event: 'screen-sfu-admin-retry', operation, attempt, status, name: error.name }));
      await new Promise((resolve) => setTimeout(resolve, attempt * 150));
    }
  }
  throw new Error('LiveKit administration retry state is unreachable');
}

class ScreenSfuService {
  /** @param {Extract<ScreenPolicy,{mode:'sfu'}>} policy @param {(id:string)=>Member|null} member */
  constructor(policy, member) {
    const sdk = require('livekit-server-sdk');
    this.policy = policy;
    this.member = member;
    this.sdk = sdk;
    this.api = new sdk.RoomServiceClient(policy.internalUrl, policy.apiKey, policy.apiSecret, { requestTimeout: 5, failover: false });
    this.verifier = new sdk.TokenVerifier(policy.apiKey, policy.apiSecret);
    /** @type {Map<string,Lease>} */ this.leases = new Map();
    /** @type {Map<string,Lease>} */ this.publishers = new Map();
    /** @type {Map<string,number>} */ this.operations = new Map();
    /** @type {Map<string,Revocation>} */ this.revocations = new Map();
    this.closing = false;
  }

  /** @param {string} userId @param {string} channelId @returns {Member} */
  requireMember(userId, channelId) {
    if (this.closing) throw new ScreenSfuError('service-stopping', 'The room server is shutting down screen media', 503);
    const value = this.member(userId);
    if (!value || value.channelId !== channelId) throw new ScreenSfuError('not-in-channel', 'Screen access requires an authenticated connection in the requested voice channel', 403);
    return value;
  }

  /** @param {Lease} lease @returns {boolean} */
  active(lease) {
    const owner = this.member(lease.userId);
    const source = this.member(lease.sourceUserId);
    return !this.closing && this.leases.get(lease.identity) === lease && !!owner && !!source && owner.sessionId === lease.sessionId && source.sessionId === lease.sourceSessionId && owner.channelId === lease.channelId && source.channelId === lease.channelId;
  }

  /** @param {string} userId @param {ScreenRequest} request @returns {Promise<ScreenSfuCredential>} */
  async issue(userId, request) {
    const owner = this.requireMember(userId, request.channelId);
    const source = this.requireMember(request.sourceUserId, request.channelId);
    const operationKey = `${userId}/${request.sourceUserId}`;
    const operation = (this.operations.get(operationKey) || 0) + 1;
    this.operations.set(operationKey, operation);
    const role = userId === source.userId ? 'publish' : 'watch';
    let publisher = this.publishers.get(source.userId);
    if (role === 'watch') {
      if (!publisher || !this.active(publisher)) throw new ScreenSfuError('source-not-publishing', 'The requested user has no active screen publication', 409);
      let participant;
      const currentPublisher = publisher;
      try { participant = await adminRequest('get-publisher', () => this.api.getParticipant(currentPublisher.room, currentPublisher.identity)); }
      catch (error) {
        if (error instanceof Error && isMissing(error)) throw new ScreenSfuError('source-not-publishing', 'The screen publisher has not connected yet', 409);
        throw error;
      }
      if (!participant.tracks.some((track) => track.type === this.sdk.TrackType.VIDEO && track.source === this.sdk.TrackSource.SCREEN_SHARE)) throw new ScreenSfuError('source-not-publishing', 'The requested screen video is not published', 409);
    }
    const previous = [...this.leases.values(), ...[...this.revocations.values()].flatMap((item) => item.affected)].find((lease) => lease.userId === userId && lease.sourceUserId === source.userId);
    if (previous) await this.releaseLease(previous);
    if (this.requireMember(userId, request.channelId).sessionId !== owner.sessionId || this.requireMember(source.userId, request.channelId).sessionId !== source.sessionId) throw new ScreenSfuError('membership-changed', 'Room membership changed while authorizing the screen', 409);
    const identity = `${userId}.screen.${crypto.randomBytes(16).toString('hex')}`;
    if (role === 'watch' && !publisher) throw new ScreenSfuError('source-not-publishing', 'The screen publisher left', 409);
    const room = role === 'publish' ? `screen-${crypto.randomBytes(24).toString('hex')}` : /** @type {Lease} */ (publisher).room;
    const publisherIdentity = role === 'publish' ? identity : /** @type {Lease} */ (publisher).identity;
    /** @type {Lease} */ const lease = { identity, room, userId, sourceUserId: source.userId, channelId: request.channelId, sessionId: owner.sessionId, sourceSessionId: source.sessionId, publisherIdentity, role, sockets: new Set() };
    const token = new this.sdk.AccessToken(this.policy.apiKey, this.policy.apiSecret, { identity, ttl: this.policy.ttlSeconds, metadata: JSON.stringify({ sourceUserId: source.userId }), name: userId });
    token.addGrant({ roomJoin: true, room, canPublish: role === 'publish', canSubscribe: role === 'watch', canPublishData: false, canUpdateOwnMetadata: false, canPublishSources: role === 'publish' ? [this.sdk.TrackSource.SCREEN_SHARE] : [] });
    const jwt = await token.toJwt();
    if (this.operations.get(operationKey) !== operation || this.requireMember(userId, request.channelId).sessionId !== owner.sessionId || this.requireMember(source.userId, request.channelId).sessionId !== source.sessionId || role === 'watch' && (!publisher || !this.active(publisher))) throw new ScreenSfuError('membership-changed', 'Screen membership changed before the credential was issued', 409);
    this.leases.set(identity, lease);
    if (role === 'publish') this.publishers.set(userId, lease);
    return { channelId: request.channelId, sourceUserId: source.userId, url: this.policy.url, token: jwt, expiresAt: Date.now() + this.policy.ttlSeconds * 1000, identity, publisherIdentity };
  }

  /** @param {Lease} lease @returns {Promise<void>} */
  async releaseLease(lease) {
    let record = this.revocations.get(lease.identity);
    if (record?.pending) return record.pending;
    if (!record) {
      if (this.leases.get(lease.identity) !== lease) return;
      const roomLeases = [...this.leases.values(), ...[...this.revocations.values()].flatMap((item) => item.affected)];
      const affected = lease.role === 'publish' ? [...new Set(roomLeases.filter((item) => item.room === lease.room))] : [lease];
      record = { lease, affected, pending: null };
      for (const item of affected) {
        this.leases.delete(item.identity);
        if (this.publishers.get(item.userId) === item) this.publishers.delete(item.userId);
        this.revocations.set(item.identity, record);
      }
    }
    const revocation = record;
    const operation = (async () => {
      try {
        try {
          if (revocation.lease.role === 'publish') await adminRequest('delete-source-room', () => this.api.deleteRoom(revocation.lease.room));
          else await adminRequest('remove-viewer', () => this.api.removeParticipant(revocation.lease.room, revocation.lease.identity));
        } catch (error) {
          if (!(error instanceof Error) || !isMissing(error)) throw error;
        }
        for (const item of revocation.affected) if (this.revocations.get(item.identity) === revocation) this.revocations.delete(item.identity);
      } catch (error) {
        console.error(JSON.stringify({ event: 'screen-sfu-revocation-pending', identity: revocation.lease.identity, sourceUserId: revocation.lease.sourceUserId, channelId: revocation.lease.channelId, role: revocation.lease.role, name: error instanceof Error ? error.name : 'NonError' }));
        throw error;
      } finally {
        revocation.pending = null;
        // Let an acknowledged terminal Leave drain before closing the gateway transport.
        setTimeout(() => {
          for (const item of revocation.affected) { for (const socket of item.sockets) socket.destroy(); item.sockets.clear(); }
        }, 100).unref();
      }
    })();
    revocation.pending = operation;
    return operation;
  }

  /** @param {string} userId @param {ScreenRequest} request @returns {Promise<void>} */
  async release(userId, request) {
    if (!request.identity) throw new ScreenSfuError('invalid-request', 'Screen permission release requires the exact credential identity', 400);
    const owned = [...this.leases.values(), ...[...this.revocations.values()].flatMap((item) => item.affected)].filter((item) => item.identity === request.identity && item.userId === userId && item.channelId === request.channelId && item.sourceUserId === request.sourceUserId);
    for (const lease of owned) await this.releaseLease(lease);
  }

  /** @param {string} userId @returns {Promise<void>} */
  async revokeUser(userId) {
    for (const key of this.operations.keys()) if (key.startsWith(`${userId}/`) || key.endsWith(`/${userId}`)) this.operations.delete(key);
    const owned = [...new Set([...this.leases.values(), ...[...this.revocations.values()].flatMap((item) => item.affected)])].filter((item) => item.userId === userId || item.sourceUserId === userId);
    await Promise.all(owned.map((lease) => this.releaseLease(lease)));
  }

  /** @returns {Promise<void>} */
  async revokeAll() {
    this.closing = true;
    this.operations.clear();
    const owned = [...new Set([...this.publishers.values(), ...[...this.revocations.values()].map((item) => item.lease)])];
    const results = await Promise.allSettled(owned.map((lease) => this.releaseLease(lease)));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }

  /** @param {import('node:http').IncomingMessage} req @returns {boolean} */
  isGateway(req) { return (req.url || '').split('?')[0].startsWith('/screen-sfu'); }

  /** @param {import('node:http').IncomingMessage} req @returns {Promise<{lease:Lease,path:string}>} */
  async authorize(req) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method !== 'GET' || !/^\/screen-sfu\/rtc(?:\/[a-zA-Z0-9_-]+)*$/.test(url.pathname)) throw new ScreenSfuError('forbidden-endpoint', 'Only the screen media signaling endpoint is public', 403);
    const tokens = url.searchParams.getAll('access_token');
    if (tokens.length !== 1 || !tokens[0] || tokens[0].length > 8192) throw new ScreenSfuError('invalid-credential', 'A single screen access credential is required', 401);
    let claims;
    try { claims = await this.verifier.verify(tokens[0]); }
    catch { throw new ScreenSfuError('invalid-credential', 'The screen credential is invalid or expired', 401); }
    const lease = typeof claims.sub === 'string' ? this.leases.get(claims.sub) : null;
    if (!lease || !this.active(lease) || claims.video?.room !== lease.room || claims.video?.canPublish !== (lease.role === 'publish') || claims.video?.canSubscribe !== (lease.role === 'watch')) throw new ScreenSfuError('revoked-credential', 'The screen credential is no longer authorized by current room membership', 403);
    return { lease, path: url.pathname.slice('/screen-sfu'.length) + url.search };
  }

  /** @param {string} path @param {import('node:http').IncomingMessage} req */
  upstream(path, req) {
    const backend = new URL(this.policy.internalUrl);
    return http.request({ hostname: backend.hostname, port: backend.port, method: 'GET', path, headers: { ...req.headers, host: backend.host }, timeout: 10000 });
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @returns {Promise<void>} */
  async handleHttp(req, res) {
    try {
      const { lease, path } = await this.authorize(req);
      const upstream = this.upstream(path, req);
      upstream.on('response', (response) => {
        if (!this.active(lease)) { response.destroy(); res.writeHead(403); res.end('Screen permission revoked'); return; }
        res.writeHead(response.statusCode || 502, { 'content-type': response.headers['content-type'] || 'text/plain', 'cache-control': 'no-store' });
        response.on('error', (error) => { reportScreenError(error, 'gateway-upstream-response'); res.destroy(); });
        response.pipe(res);
      });
      upstream.on('timeout', () => upstream.destroy(new ScreenSfuError('service-timeout', 'Private media service did not answer in time', 504)));
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Private screen media service unavailable'); });
      req.on('aborted', () => upstream.destroy());
      res.once('close', () => upstream.destroy());
      upstream.end();
    } catch (error) {
      if (!(error instanceof ScreenSfuError)) throw error;
      res.writeHead(error.status, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end(error.message);
    }
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:stream').Duplex} socket @param {Buffer} head @returns {Promise<void>} */
  async handleUpgrade(req, socket, head) {
    socket.on('error', (error) => reportScreenError(error, 'gateway-client-socket'));
    try {
      const { lease, path } = await this.authorize(req);
      const upstream = this.upstream(path, req);
      lease.sockets.add(socket);
      socket.once('close', () => { lease.sockets.delete(socket); upstream.destroy(); });
      upstream.on('upgrade', (response, remote, remoteHead) => {
        if (!this.active(lease)) { remote.destroy(); socket.destroy(); return; }
        lease.sockets.add(remote);
        remote.once('close', () => { lease.sockets.delete(remote); socket.destroy(); });
        remote.on('error', () => socket.destroy());
        socket.on('error', () => remote.destroy());
        const headers = response.rawHeaders;
        let handshake = `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`;
        for (let index = 0; index < headers.length; index += 2) handshake += `${headers[index]}: ${headers[index + 1]}\r\n`;
        socket.write(handshake + '\r\n');
        if (remoteHead.length) socket.write(remoteHead);
        if (head.length) remote.write(head);
        remote.pipe(socket); socket.pipe(remote);
      });
      upstream.on('response', (response) => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode || 502} Screen signaling rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
      upstream.end();
    } catch (error) {
      if (!(error instanceof ScreenSfuError)) throw error;
      socket.end(`HTTP/1.1 ${error.status} Screen authorization rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  }
}

module.exports = { readScreenPolicy, publicScreenConfig, parseScreenRequest, ScreenSfuService, ScreenSfuError, reportScreenError };
