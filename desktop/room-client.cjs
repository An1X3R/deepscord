// @ts-check
'use strict';

const fs = require('node:fs');
const {createStaticAssets}=require('./static-assets.cjs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const { X509Certificate, randomBytes, createHash } = require('node:crypto');

/** @typedef {{origin:string,fingerprint:string|null}} Connection */

/** @typedef {{origin:string,url:string,stop:()=>Promise<void>}} RoomClient */
const TIMEOUT = 10000;
const MAX_CONNECTIONS = 32;
const MAX_RESPONSE = 1024 * 1024;



/** @param {Connection} connection @returns {URL} */
function upstreamOrigin(connection) {
  if (!connection || typeof connection.origin !== 'string' || (connection.fingerprint !== null && (typeof connection.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(connection.fingerprint)))) throw new TypeError('Room connection requires an exact origin and a lowercase SHA256 fingerprint or null');
  const url = new URL(connection.origin);
  if (url.origin !== connection.origin || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new TypeError('Room connection must be an exact HTTP or HTTPS origin');
  const loopback = ['localhost','[::1]'].includes(url.hostname) || (net.isIP(url.hostname) === 4 && url.hostname.startsWith('127.'));
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && connection.fingerprint === null)) throw new TypeError('Room connections require HTTPS; HTTP is permitted only on loopback without a certificate pin');
  return url;
}

/** @param {URL} upstream @param {string|null} fingerprint @param {Set<net.Socket>} sockets @returns {Promise<net.Socket>} */
function connect(upstream, fingerprint, sockets) {
  const hostname = upstream.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const secure = upstream.protocol === 'https:';
    const port = Number(upstream.port || (secure ? 443 : 80));
    const socket = secure ? tls.connect({ host:hostname,port,servername:net.isIP(hostname) ? undefined : hostname,rejectUnauthorized:fingerprint === null }) : net.connect({ host:hostname,port });
    sockets.add(socket);
    socket.once('close', () => { sockets.delete(socket); reject(new Error('Room upstream connection closed')); });
    socket.once('error', reject);
    socket.setTimeout(TIMEOUT, () => socket.destroy(new Error('Room upstream connection timed out')));
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      try {
        if (secure && fingerprint !== null) {
          const certificate = new X509Certificate(/** @type {tls.TLSSocket} */ (socket).getPeerCertificate().raw);
          const now = Date.now();
          const start = Date.parse(certificate.validFrom);
          const end = Date.parse(certificate.validTo);
          if (!Number.isFinite(start) || !Number.isFinite(end) || now < start || now >= end) throw new Error('Room upstream certificate is outside its validity period');
          if (certificate.fingerprint256.replaceAll(':','').toLowerCase() !== fingerprint) throw new Error('Room upstream certificate does not match the approved SHA256 fingerprint');
        }
        socket.setTimeout(0);
        resolve(socket);
      } catch (error) { socket.destroy(); reject(error); }
    });
  });
}

/** @param {string} target @returns {boolean} */
function screenPath(target) { return /^\/screen-sfu\/rtc(?:\/[a-zA-Z0-9_-]+)*(?:\?[^#]*)?$/.test(target); }

/** @param {{serverDirectory:string,connection:Connection}} options @returns {Promise<RoomClient>} */
async function startRoomClient(options) {
  const upstream = upstreamOrigin(options.connection);
  const fingerprint = options.connection.fingerprint;
  const assets = createStaticAssets(path.join(options.serverDirectory,'public'));
  /** @type {Set<net.Socket>} */ const remoteSockets = new Set();
  /** @type {Set<net.Socket>} */ const localSockets = new Set();
  /** @type {Set<http.ClientRequest>} */ const requests = new Set();
  let origin = '';
  let stopping = false;
  let pending = 0;
  /** @type {Promise<void>|null} */ let stopped = null;

  /** @param {http.IncomingMessage} request @returns {boolean} */
  function permitted(request) {
    return !stopping && request.headers.host === origin.slice(7) && (request.headers.origin === undefined || request.headers.origin === origin) && (request.method === 'GET' || request.method === 'HEAD') && request.headers['transfer-encoding'] === undefined && (request.headers['content-length'] === undefined || request.headers['content-length'] === '0') && typeof request.url === 'string' && request.url.startsWith('/') && !request.url.startsWith('//') && request.url.length <= 16384 && !request.url.includes('#');
  }

  /** @param {http.IncomingMessage} request @returns {Promise<http.ClientRequest>} */
  async function forward(request) {
    if (pending >= 16) throw new Error('Room upstream connection limit reached');
    pending++;
    /** @type {net.Socket} */ let socket;
    try { socket = await connect(upstream,fingerprint,remoteSockets); }
    finally { pending--; }
    if (stopping || request.socket.destroyed) { socket.destroy(); throw new Error('Local room request closed before upstream connection completed'); }
    // Only a verified socket can receive HTTP bytes, including WebSocket credentials.
    const agent = new http.Agent({ keepAlive:false });
    agent.createConnection = () => socket;
    /** @type {http.OutgoingHttpHeaders} */
    const headers = { host:upstream.host,origin:upstream.origin };
    if (request.headers.upgrade?.toLowerCase() === 'websocket') {
      headers.connection = 'Upgrade'; headers.upgrade = 'websocket';
      for (const name of ['sec-websocket-key','sec-websocket-version','sec-websocket-protocol','sec-websocket-extensions']) if (request.headers[name] !== undefined) headers[name] = request.headers[name];
    }
    const outgoing = http.request({ hostname:upstream.hostname,port:Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80)),method:request.method,path:request.url,headers,agent,timeout:TIMEOUT,maxHeaderSize:16384 });
    requests.add(outgoing);
    outgoing.once('close', () => { requests.delete(outgoing); agent.destroy(); });
    outgoing.once('timeout', () => outgoing.destroy(new Error('Room upstream response timed out')));
    return outgoing;
  }

  const server = http.createServer({ maxHeaderSize:16384,headersTimeout:TIMEOUT,requestTimeout:TIMEOUT,keepAliveTimeout:5000 }, (request,response) => {
    response.setHeader('Cache-Control','no-store');
    response.setHeader('X-Frame-Options','DENY');
    response.setHeader('X-Content-Type-Options','nosniff');
    if (!permitted(request) || request.headers.upgrade !== undefined) { response.writeHead(403); response.end(); return; }
    const target = request.url || '/';
    if (target === '/api/config' || screenPath(target)) {
      forward(request).then(outgoing => {
        if (response.destroyed) { outgoing.destroy(); return; }
        response.once('close', () => outgoing.destroy());
        outgoing.on('error', () => { if (!response.headersSent) { response.writeHead(502); response.end('Room upstream request failed'); } else response.destroy(); });
        outgoing.once('response', incoming => {
          const contentType = incoming.headers['content-type'] || 'text/plain';
          const allowed = target === '/api/config' ? /^application\/json(?:;|$)/i.test(contentType) : /^(?:application\/json|text\/plain)(?:;|$)/i.test(contentType);
          if (!allowed) { incoming.destroy(); response.writeHead(502); response.end('Room upstream returned an unsupported content type'); return; }
          /** @type {Buffer[]} */ const chunks = [];
          let bytes = 0;
          incoming.on('data', (/** @type {Buffer} */ chunk) => { bytes += chunk.length; if (bytes > MAX_RESPONSE) incoming.destroy(new RangeError('Room upstream response exceeds the size limit')); else chunks.push(chunk); });
          incoming.once('error', () => { outgoing.destroy(); if (!response.headersSent) { response.writeHead(502); response.end('Room upstream response failed'); } else response.destroy(); });
          incoming.once('end', () => { response.writeHead(incoming.statusCode || 502,{ 'Content-Type':contentType }); response.end(request.method === 'HEAD' ? undefined : Buffer.concat(chunks)); });
        });
        outgoing.end();
      }).catch(() => { if (!response.destroyed) { response.writeHead(502); response.end('Room upstream connection failed'); } });
      return;
    }
    const pathname = target.split('?')[0];
    void assets.serve(response,pathname,request.method || 'GET').catch(error=>{console.error('room_asset_cleanup_failed',{message:error.message});response.destroy();});
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.on('connection', socket => {
    localSockets.add(socket);
    socket.once('close', () => localSockets.delete(socket));
    socket.on('error', () => socket.destroy());
  });
  server.on('upgrade', (request,socket,head) => {
    if (!permitted(request) || request.method !== 'GET' || request.headers.origin !== origin || (request.url !== '/ws' && !screenPath(request.url || '')) || request.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return; }
    socket.pause();
    forward(request).then(outgoing => {
      if (socket.destroyed) { outgoing.destroy(); return; }
      socket.once('close', () => outgoing.destroy());
      outgoing.on('error', () => socket.destroy());
      outgoing.once('response', response => { response.destroy(); socket.destroy(); });
      outgoing.once('upgrade', (response,remote,remoteHead) => {
        if (socket.destroyed || stopping) { remote.destroy(); return; }
        remote.setTimeout(90000, () => remote.destroy());
        remote.on('error', () => socket.destroy());
        remote.once('close', () => socket.destroy());
        socket.once('close', () => remote.destroy());
        const headers = ['HTTP/1.1 101 Switching Protocols','Connection: Upgrade','Upgrade: websocket'];
        for (const name of ['sec-websocket-accept','sec-websocket-protocol','sec-websocket-extensions']) {
          const value = response.headers[name];
          if (typeof value === 'string') headers.push(`${name}: ${value}`);
        }
        socket.write(headers.join('\r\n') + '\r\n\r\n');
        if (remoteHead.length) socket.write(remoteHead);
        if (head.length) remote.write(head);
        remote.pipe(socket); socket.pipe(remote); socket.resume();
      });
      outgoing.end();
    }).catch(() => socket.destroy());
  });
  server.on('clientError', (_error,socket) => socket.destroy());
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',() => { server.removeListener('error',reject); resolve(undefined); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local room interface has no listening address');
  origin = `http://127.0.0.1:${address.port}`;
  return { origin,url:origin + '/',stop:() => {
    if (stopped) return stopped;
    stopping = true;
    assets.close();
    stopped = new Promise((resolve,reject) => {
      server.close(error => error ? reject(error) : resolve());
      for (const request of requests) request.destroy();
      for (const socket of remoteSockets) socket.destroy();
      for (const socket of localSockets) socket.destroy();
    });
    return stopped;
  } };
}

/** @param {RoomClient} client @returns {Promise<void>} */
async function probeRoomConfig(client) {
  const target = client.origin + '/api/config';
  const response = await fetch(target, { signal:AbortSignal.timeout(TIMEOUT),redirect:'error',headers:{ Origin:client.origin } });
  const body = await response.text();
  if (response.status !== 200) throw new Error(`Room preparation config failed: GET ${target}; HTTP ${response.status}; body=${body.slice(0,600)}`);
  /** @type {import('../public/js/network-protocol.js').JsonValue} */
  const value = JSON.parse(body);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (value.networkMode !== 'server' && value.networkMode !== 'direct') ||
      (value.mediaPolicy !== 'direct' && value.mediaPolicy !== 'relay-allowed' && value.mediaPolicy !== 'relay-only') ||
      (value.iceTransportPolicy !== 'all' && value.iceTransportPolicy !== 'relay') ||
      typeof value.requirePassword !== 'boolean' ||
      (value.networkMode === 'direct' && value.mediaPolicy !== 'direct') ||
      (value.mediaPolicy === 'relay-only' ? value.iceTransportPolicy !== 'relay' : value.iceTransportPolicy !== 'all')) {
    throw new TypeError(`Room preparation config is invalid: GET ${target}; HTTP ${response.status}; body=${body.slice(0,600)}`);
  }
}

/** @param {RoomClient} client @returns {Promise<void>} */
function probeRoomWebSocket(client) {
  const target = client.origin + '/ws';
  const key = randomBytes(16).toString('base64');
  const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  return new Promise((resolve,reject) => {
    const request = http.request(target,{ headers:{ Origin:client.origin,Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':key },agent:false,maxHeaderSize:16384 });
    const timer = setTimeout(() => request.destroy(new Error(`Room preparation WebSocket timed out after ${TIMEOUT}ms: GET ${target}`)),TIMEOUT);
    request.once('error',reject);
    request.once('close',() => clearTimeout(timer));
    request.once('response',response => {
      response.destroy();
      reject(new Error(`Room preparation WebSocket upgrade failed: GET ${target}; HTTP ${response.statusCode}`));
    });
    request.once('upgrade',(response,socket) => {
      clearTimeout(timer);
      socket.destroy();
      if (response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== expected) {
        reject(new TypeError(`Room preparation WebSocket handshake is invalid: GET ${target}; HTTP ${response.statusCode}; accept=${String(response.headers['sec-websocket-accept'])}`));
        return;
      }
      resolve(undefined);
    });
    request.end();
  });
}

/** @param {{serverDirectory:string,connection:Connection}} options @returns {Promise<RoomClient>} */
async function prepareRoomClient(options) {
  const client = await startRoomClient(options);
  try {
    await probeRoomConfig(client);
    await probeRoomWebSocket(client);
    return client;
  } catch (error) {
    try { await client.stop(); }
    catch (cleanupError) { console.warn('room_preparation_cleanup_failed',{ origin:client.origin,message:cleanupError instanceof Error ? cleanupError.message : String(cleanupError) }); }
    throw error;
  }
}

module.exports = { startRoomClient, prepareRoomClient };
