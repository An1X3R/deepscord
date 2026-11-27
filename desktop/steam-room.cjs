// @ts-check
'use strict';

const fs = require('node:fs');
const {createStaticAssets}=require('./static-assets.cjs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { setTimeout: delay } = require('node:timers/promises');
const { SteamClient } = require('./steam-client.cjs');
const { createSteamAdmission } = require('./steam-admission.cjs');
const { parseSteamInvite, steamInvite, encodeMessage, decodePacket, SteamWireError, MAX_MESSAGE_BYTES } = require('./steam-wire.cjs');
const { cleanClientCommand } = require('./steam-commands.cjs');
const { createMediaQueue } = require('./media-queue.cjs');
const { createSteamMediaStorage } = require('./steam-media-storage.cjs');
const { createMediaReplicas } = require('./media-replicas.cjs');
/** @type {typeof import('../lib/chat-assets.cjs')} */const {collectContentAssets,policyMedia}=require('./app-server/lib/chat-assets.cjs');
/** @type {typeof import('../lib/server-governance.cjs')} */const {createGovernanceVerifier}=require('./app-server/lib/server-governance.cjs');
/** @type {typeof import('../lib/steam-state.cjs')} */
const { parseSteamRoomSeed, signSteamIdentity, stableSteamUserId,createSteamStateReader } = require('./app-server/lib/steam-state.cjs');
const { REPLICA_SESSION, encodeReplica, checkpointDigest, newerCheckpoint,createCheckpointEncoder,createReplicaDecoder } = require('./steam-continuity.cjs');

/** @typedef {import('./steam-wire.cjs').SteamInvitation} Invitation */
/** @typedef {import('./steam-wire.cjs').SteamMessageKind} Kind */
/** @typedef {import('./steam-client.cjs').SteamEvent} SteamEvent */
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {typeof import('../public/js/network-protocol.js').parsePeerSignal} SignalParser */
/** @typedef {{userData:string,serverDirectory:string,executable:string}} Paths */
/** @typedef {{appId:number,stunUrls:string[],roomSeed?:import('../lib/steam-state.cjs').SteamRoomSeed}} HostOptions */
/** @typedef {{origin:string,url:string,invite:string,role:'host'|'guest',appId:number,lobbyId:string,readonly stunUrls:string[],stop:()=>Promise<void>}} SteamRoom */
/** @typedef {import('node:events').EventEmitter & {send:(data:string)=>boolean,close:(code:number,reason:string)=>void,readyState:string}} LocalSocket */
/** @typedef {import('node:events').EventEmitter & {handleUpgrade:(req:import('node:http').IncomingMessage,socket:import('node:stream').Duplex,head:Buffer)=>void,closeAll:(code:number,reason:string)=>void}} SocketServer */
/** @typedef {{WebSocketServer:new(options:{maxConnections:number})=>SocketServer}} SocketModule */
/** @typedef {{socket:LocalSocket,session:string,opened:boolean,pending:string[],pendingBytes:number,createdAt:number}} LocalLink */
/** @typedef {{socket:WebSocket,peerId:string,session:string,createdAt:number}} BackendLink */
/** @typedef {{kind:Kind,count:number,chunks:Buffer[],bytes:number,createdAt:number}} Assembly */

/** @typedef {import('../lib/steam-state.cjs').SteamCheckpoint} SteamCheckpoint */
/** @typedef {import('./steam-continuity.cjs').ReplicaMessage} ReplicaMessage */
/** @typedef {{ownerId:string,epoch:string,requestId:string,generation:number,candidate:SteamCheckpoint|null,failure:string|null,responders:Set<string>}} Recovery */

const EMPTY = Buffer.alloc(0);
const PUBLIC_CONFIG = { networkMode: 'server', mediaPolicy: 'direct', iceTransportPolicy: 'all', requirePassword: true };
const SERVER_EVENTS = new Set(['radioResult','radioState','contentResult','mediaResult','chatResult','reactionResult','governanceResult','messageReactions','identityChallenge', 'serverState', 'messageDeleted', 'authFailed', 'error', 'message', 'networkConfig', 'pong', 'resumeRejected', 'roomSyncOffer', 'roomSyncCommit', 'roomSyncConflict', 'servers', 'signal', 'userConnection', 'userJoined', 'userLeft', 'userUpdated', 'voicePeers', 'voiceState', 'welcome']);

/** @returns {Promise<number>} */
async function reservePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', () => resolve(undefined)); });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local Steam room port');
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve(undefined)));
  return address.port;
}


/** @param {Buffer} payload @returns {string} */
function serverMessage(payload) {
  if (payload.length > MAX_MESSAGE_BYTES) throw new RangeError('Room event exceeds the Steam signaling limit');
  const text = payload.toString('utf8');
  /** @type {JsonValue} */ const value = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value) || typeof value.t !== 'string' || !SERVER_EVENTS.has(value.t)) throw new TypeError('Unsupported room event over Steam signaling');
  return text;
}

class SteamRoomBridge {
  /** @type {Invitation|null} */ invitation = null;
  /** @type {InstanceType<typeof SteamClient>} */ client;
  /** @type {Paths} */ paths;
  /** @type {(message:string)=>void} */ onFailure;
  /** @type {SignalParser|null} */ parseSignal = null;
  /** @type {import('node:child_process').ChildProcess|null} */ backend = null;
  /** @type {http.Server|null} */ httpServer = null;
  /** @type {ReturnType<typeof createStaticAssets>|null} */ assets = null;
  /** @type {SocketServer|null} */ sockets = null;
  /** @type {ReturnType<typeof setInterval>|null} */ timer = null;
  /** @type {Map<string,LocalLink>} */ localLinks = new Map();
  /** @type {Map<string,BackendLink>} */ backendLinks = new Map();
  /** @type {Map<string,Assembly>} */ assemblies = new Map();
  /** @type {ReturnType<typeof createSteamAdmission>|null} */ admission = null;
  ownerId = '';
  origin = '';
  backendOrigin = '';
  directory = '';
  failed = '';
  stopping = false;
  epoch = '';
  sequence = 0;
  generation = 0;
  migrating = false;
  migrationStarted = 0;
  bridgeKey = Buffer.alloc(0);
  /** @type {string[]} */ stunUrls = [];
  /** @type {Set<string>} */ members = new Set();
  /** @type {SteamCheckpoint|null} */ checkpoint = null;
  checkpointEncoder = createCheckpointEncoder();
  replicaDecoder = createReplicaDecoder({ maxEntries:4,maxBytes:8 * 1024 * 1024 });
  stateReader = createSteamStateReader({ maxEntries:4,maxBytes:8 * 1024 * 1024 });
  /** @type {import('../lib/steam-state.cjs').SteamRoomSeed|null} */ roomSeed = null;
  /** @type {Recovery|null} */ recovery = null;
  /** @type {Map<string,{epoch:string,sequence:number,digest:string,at:number,attempts:number}>} */ replicaAcks = new Map();
  /** @type {Promise<void>} */ migration = Promise.resolve();
  /** @type {Promise<void>|null} */ stoppingPromise = null;
  /** @type {ReturnType<typeof createMediaQueue>} */ mediaQueue;
  /** @type {ReturnType<typeof createSteamMediaStorage>|null} */ mediaStorage=null;
  /** @type {ReturnType<typeof createMediaReplicas>|null} */ mediaReplicas=null;
  /** @type {import('./media-replicas.cjs').MediaReplicaStatus[]} */ mediaStatuses=[];
  /** @type {Promise<void>} */ mediaWork=Promise.resolve();
  mediaWorking=false;
  mediaRefreshRequested=false;
  mediaGeneration=0;
  mediaContext='';
  mediaClosing=false;
  mediaGovernanceVerifier=createGovernanceVerifier({maxEntries:2,maxBytes:4*1024*1024});

  /** @param {number} appId @param {Paths} paths @param {(message:string)=>void} onFailure */
  constructor(appId, paths, onFailure) {
    this.paths = paths;
    this.onFailure = onFailure;
    this.client = new SteamClient(appId, (event) => this.steamEvent(event));
    this.mediaQueue=createMediaQueue({send:(peer,packet)=>{if(!this.members.has(peer) || !this.admission)throw new Error('Steam media recipient left the room');this.admission.sendAuthorized(peer,packet);},bytesPerSecond:256*1024,maxQueuedBytes:512*1024});
  }

  /** @param {HostOptions} options @returns {Promise<SteamRoom>} */
  async host(options) {
    this.roomSeed = options.roomSeed === undefined ? null : parseSteamRoomSeed(options.roomSeed);
    const address = await this.client.create();
    this.ownerId = address.ownerId;
    if (!address.epoch) throw new Error('Steam owner has no published authority epoch');
    this.epoch = address.epoch;
    this.members = new Set(this.client.members());
    this.invitation = { appId: options.appId, lobbyId: address.lobbyId, token: randomBytes(32).toString('base64url') };
    this.startAdmission();
    await this.startBackend(options.stunUrls, null);
    return this.startLocal();
  }

  /** @param {Invitation} invitation @returns {Promise<SteamRoom>} */
  async join(invitation) {
    const address = await this.client.join(invitation.lobbyId);
    this.ownerId = address.ownerId;
    this.invitation = invitation;
    this.members = new Set(this.client.members());
    this.startAdmission();
    this.migrating = true;
    this.migrationStarted = Date.now();
    if (address.ownerId === this.client.selfId) {
      this.migration = this.promote(this.client.publishedAuthority(), ++this.generation);
      await this.migration;
    } else if (address.epoch) this.sendReplica(address.ownerId, { t: 'request', epoch: address.epoch });
    const room = await this.startLocal();
    const deadline = Date.now() + 30000;
    while (!this.failed && !this.stopping && (this.migrating || !this.checkpoint)) {
      if (Date.now() >= deadline) throw new Error('目标 Steam 房间未在 30 秒内完成邀请验证和频道同步，请确认房间仍在线且邀请有效');
      await delay(25);
    }
    if (this.failed || this.stopping) throw new Error(this.failed || '目标 Steam 房间已关闭');
    return room;
  }

  /** @returns {void} */
  startAdmission() {
    this.admission = createSteamAdmission(this.requireInvitation(), this.client.selfId,
      (peer, packet) => this.client.send(peer, packet), peer => this.peerAdmitted(peer), Date.now);
    this.client.setPacketMatcher((peer, packet) => {
      if (this.admission?.isPacket(packet)) return this.admission.matches(peer, packet);
      try { decodePacket(this.requireInvitation(), packet); return true; }
      catch (error) { if (error instanceof SteamWireError) return false; throw error; }
    });
    this.admission.update([...this.members]);
  }

  /** @param {string} peer @returns {void} */
  peerAdmitted(peer) {
    this.sendCheckpoint(peer, 1);
    const recovery = this.recovery;
    if (recovery) this.sendReplica(peer, { t: 'recover', ownerId: recovery.ownerId, epoch: recovery.epoch, requestId: recovery.requestId });
    const authority = this.client.authority();
    if (peer === this.ownerId && peer !== this.client.selfId && authority.epoch) this.sendReplica(peer, { t: 'request', epoch: authority.epoch });
    this.queueMediaUpdate();
  }

  /** @param {string[]} stunUrls @param {SteamCheckpoint|null} restored @returns {Promise<void>} */
  async startBackend(stunUrls, restored) {
    await this.stopMedia();
    const generation = this.generation;
    const invitation = this.requireInvitation();
    const parent = path.join(this.paths.userData, 'steam-rooms');
    fs.mkdirSync(parent, { recursive: true });
    this.directory = fs.mkdtempSync(path.join(parent, 'room-'));
    this.stunUrls = [...stunUrls];
    this.bridgeKey = randomBytes(32);
    const seed = restored?.roomDocument ? parseSteamRoomSeed({ roomId: restored.roomDocument.roomId, creatorKey: restored.roomDocument.creatorKey, document: restored.roomDocument, ...(restored.store.governance ? {governance:restored.store.governance} : {}) }) : this.roomSeed;
    /** @type {NodeJS.ProcessEnv} */ const roomEnvironment = {};
    if (seed) {
      const seedPath = path.join(this.directory, 'room-seed.json');
      fs.writeFileSync(seedPath, JSON.stringify(seed.document), { flag: 'wx' });
      roomEnvironment.ECHO_ROOM_ID = seed.roomId;
      roomEnvironment.ECHO_ROOM_CREATOR_KEY = seed.creatorKey;
      roomEnvironment.ECHO_ROOM_SEED_PATH = seedPath;
      this.roomSeed = seed;
    }
    const governance=restored?.store.governance || seed?.governance;
    if (governance) {
      const governancePath=path.join(this.directory,'governance-seed.json');
      fs.writeFileSync(governancePath,JSON.stringify(governance),{flag:'wx'});
      roomEnvironment.ECHO_GOVERNANCE_SEED_PATH=governancePath;
    }
    if (restored) {
      fs.writeFileSync(path.join(this.directory, 'store.json'), JSON.stringify(restored.store), { flag: 'wx' });
      fs.writeFileSync(path.join(this.directory, 'steam-users.json'), JSON.stringify(restored.users.filter(user => this.members.has(user.id.slice('u_steam_'.length)))), { flag: 'wx' });
    }
    const port = await reservePort();
    this.backendOrigin = `http://127.0.0.1:${port}`;
    const instanceId = randomUUID();
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ECHO_|TURN_|STUN_|HTTP_|HTTPS_)/i.test(key) && !['PORT', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())));
    const child = spawn(this.paths.executable, [path.join(this.paths.serverDirectory, 'server.js')], {
      cwd: this.paths.serverDirectory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...inherited, ...roomEnvironment, ELECTRON_RUN_AS_NODE: '1', PORT: String(port), HTTP_HOST: '127.0.0.1', HTTPS_PORTS: '0', ECHO_DATA_DIR: this.directory, ECHO_MEDIA_ROOT:path.join(this.paths.userData,'chat-media'), ECHO_NETWORK_MODE: 'server', ECHO_MEDIA_POLICY: 'direct', ECHO_SCREEN_MODE: 'peer-relay', ECHO_PASSWORD: invitation.token, ECHO_INSTANCE_ID: instanceId, STUN_URLS: stunUrls.join(','), ECHO_STEAM_LOBBY_ID: invitation.lobbyId, ECHO_STEAM_BRIDGE_KEY: this.bridgeKey.toString('hex') },
    });
    this.backend = child;
    let diagnostic = '';
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk) => { diagnostic = (diagnostic + String(chunk)).slice(-4000); });
    child.on('message', message => {
      if (this.backend !== child || this.stopping || this.ownerId !== this.client.selfId) return;
      try {
        const value=/** @type {JsonValue} */(message);
        if(value && typeof value==='object' && !Array.isArray(value) && value.t==='steam-media-needed')this.restoreMedia(child,value);
        else this.captureCheckpoint(value);
      }
      catch (error) { this.fail(error instanceof Error ? error.message : 'Invalid Steam backend state'); }
    });
    child.on('error', (error) => this.fail(`Local Steam room process failed: ${error.message}`));
    child.on('exit', (code) => { if (this.backend === child && !this.stopping) this.fail(`Local Steam room process exited: code=${code}`); });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (generation !== this.generation || this.stopping) throw new DOMException('Steam backend startup superseded', 'AbortError');
      if (this.failed || child.exitCode !== null) throw new Error(`Steam room startup failed: ${this.failed}; ${diagnostic.replaceAll(invitation.token, '[redacted]')}`);
      try {
        const response = await fetch(this.backendOrigin + '/api/health', { signal: AbortSignal.timeout(500) });
        /** @type {JsonValue} */ const health = await response.json();
        if (response.ok && health !== null && typeof health === 'object' && !Array.isArray(health) && health.instanceId === instanceId) {
          while ((!this.checkpoint || this.checkpoint.epoch !== this.epoch) && Date.now() < deadline && !this.failed && generation === this.generation && !this.stopping) await delay(25);
          if (generation !== this.generation || this.stopping) throw new DOMException('Steam checkpoint startup superseded', 'AbortError');
          if (this.checkpoint?.epoch !== this.epoch || this.failed) throw new Error('Steam backend did not provide its initial checkpoint');
          return;
        }
        throw new Error('Another process answered the Steam room readiness check');
      } catch (error) {
        if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === 'TimeoutError')) throw error;
        await delay(100);
      }
    }
    throw new Error('Local Steam room did not become ready within 10 seconds');
  }

  /** @returns {Promise<SteamRoom>} */
  async startLocal() {
    const invitation = this.requireInvitation();
    /** @type {typeof import('../public/js/network-protocol.js')} */
    const protocol = await import(pathToFileURL(path.join(this.paths.serverDirectory, 'public', 'js', 'network-protocol.js')).href);
    this.parseSignal = protocol.parsePeerSignal;
    const assets = createStaticAssets(path.join(this.paths.serverDirectory, 'public'));
    this.assets = assets;
    /** @type {SocketModule} */ const module = require(path.join(this.paths.serverDirectory, 'lib', 'ws.js'));
    const sockets = new module.WebSocketServer({ maxConnections: 2 });
    this.sockets = sockets;
    const server = http.createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Frame-Options', 'DENY');
      if (request.headers.host !== this.origin.slice(7) || !['GET', 'HEAD'].includes(request.method || '')) { response.writeHead(403); response.end(); return; }
      let pathname;
      try { pathname = decodeURIComponent(new URL(request.url || '/', this.origin).pathname); }
      catch (error) { response.writeHead(400); response.end(); return; }
      if (pathname === '/api/config') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(PUBLIC_CONFIG)); return; }
      void assets.serve(response,pathname,request.method || 'GET').catch(error=>{console.error('steam_asset_cleanup_failed',{message:error.message});response.destroy();});
    });
    this.httpServer = server;
    server.on('upgrade', (request, socket, head) => {
      if (this.client.recovering || (this.ownerId !== this.client.selfId && !this.migrating && !this.admission?.authorized(this.ownerId)) || this.stopping || this.failed || request.url !== '/ws' || request.headers.origin !== this.origin || request.headers.host !== this.origin.slice(7)) { socket.destroy(); return; }
      sockets.handleUpgrade(request, socket, head);
    });
    sockets.on('connection', (socket) => this.openLocal(socket));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(undefined)); });
    server.on('error', (error) => this.fail(`Steam room interface failed: ${error.message}`));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Steam room interface has no local address');
    this.origin = `http://127.0.0.1:${address.port}`;
    this.timer = setInterval(() => this.sweep(), 1000);
    const bridge = this;
    return { origin: this.origin, url: `${this.origin}/#invite=${invitation.token}`, invite: steamInvite(invitation), get role() { return bridge.ownerId === bridge.client.selfId ? 'host' : 'guest'; }, get stunUrls() { return [...(bridge.checkpoint?.stunUrls ?? bridge.stunUrls)]; }, appId: invitation.appId, lobbyId: invitation.lobbyId, stop: () => this.stop() };
  }

  /** @param {JsonValue} message @returns {void} */
  captureCheckpoint(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.t !== 'steam-state') throw new TypeError('Unexpected Steam backend IPC state');
    const checkpoint = this.stateReader.parseCheckpoint({ version: 1, lobbyId: this.requireInvitation().lobbyId, ownerId: this.client.selfId, epoch: this.epoch, sequence: ++this.sequence, stunUrls: this.stunUrls, store: message.store, users: message.users, ...(message.roomDocument === undefined ? {} : { roomDocument: message.roomDocument }) });
    this.checkpoint = checkpoint;
    this.queueMediaUpdate();
    if (!this.migrating) for (const peer of this.members) if (peer !== this.client.selfId) this.sendCheckpoint(peer, 1);
  }

  /** @param {string} peerId @param {ReplicaMessage} message @returns {void} */
  sendReplica(peerId, message) { this.transmit(peerId, REPLICA_SESSION, 'replica', encodeReplica(message)); }

  /** @param {string} peerId @param {number} attempts @returns {void} */
  sendCheckpoint(peerId, attempts) {
    const checkpoint = this.checkpoint;
    if (!this.admission?.authorized(peerId) || !checkpoint || checkpoint.ownerId !== this.client.selfId || checkpoint.epoch !== this.epoch || this.migrating) return;
    const encoded = this.checkpointEncoder.encode(checkpoint);
    this.replicaAcks.set(peerId, { epoch: checkpoint.epoch, sequence: checkpoint.sequence, digest:encoded.digest, at: Date.now(), attempts });
    this.transmit(peerId, REPLICA_SESSION, 'replica', encoded.payload);
  }

  /** @returns {void} */
  resumeLinks() {
    this.migrating = false;
    this.migrationStarted = 0;
    this.queueMediaUpdate();
    for (const link of this.localLinks.values()) if (!link.opened) {
      link.createdAt = Date.now();
      if (this.ownerId === this.client.selfId) this.openBackend(this.client.selfId, link.session);
      else this.transmit(this.ownerId, link.session, 'open', EMPTY);
    }
  }

  /** @param {string} sender @param {Buffer} payload @returns {void} */
  receiveReplica(sender, payload) {
    const message = this.replicaDecoder.decode(payload);
    const authority = this.client.authority();
    if (message.t === 'checkpoint') {
      const incoming = message.checkpoint;
      if (sender !== authority.ownerId || incoming.ownerId !== sender || incoming.epoch !== authority.epoch || incoming.lobbyId !== this.requireInvitation().lobbyId) throw new Error('Steam checkpoint does not match the current native authority');
      try { this.checkpoint = newerCheckpoint(this.checkpoint?.epoch === incoming.epoch ? this.checkpoint : null, incoming); }
      catch (error) { this.fail('Steam 房间出现同版本状态冲突，已停止状态写入'); throw error; }
      this.epoch = incoming.epoch;
      this.queueMediaUpdate();
      this.sendReplica(sender, { t: 'ack', epoch: incoming.epoch, sequence: incoming.sequence, digest: checkpointDigest(incoming) });
      if (this.migrating && this.ownerId === sender) this.resumeLinks();
      return;
    }
    if (message.t === 'request') {
      if (authority.ownerId !== this.client.selfId || message.epoch !== authority.epoch || this.epoch !== authority.epoch) throw new Error('Steam replica request targets an inactive authority');
      this.sendCheckpoint(sender, 1); return;
    }
    if (message.t === 'ack') {
      if (authority.ownerId !== this.client.selfId || message.epoch !== this.epoch) throw new Error('Steam replica acknowledgement targets another authority');
      const pending = this.replicaAcks.get(sender);
      if (pending && pending.epoch === message.epoch && pending.sequence === message.sequence) {
        if (pending.digest !== message.digest) throw new Error('Steam replica acknowledgement checksum differs');
        this.replicaAcks.delete(sender);
      }
      return;
    }
    if (message.t === 'recover') {
      if (sender !== authority.ownerId || sender === this.client.selfId) throw new Error('Only the new native Steam owner can request recovery');
      const checkpoint = this.checkpoint;
      if (checkpoint && checkpoint.ownerId === message.ownerId && checkpoint.epoch === message.epoch) this.sendReplica(sender, { t: 'recovered', requestId: message.requestId, checkpoint });
      return;
    }
    const recovery = this.recovery;
    if (authority.ownerId !== this.client.selfId || !recovery || recovery.generation !== this.generation || message.requestId !== recovery.requestId) throw new Error('Steam recovery reply has no active request');
    if (message.checkpoint.ownerId !== recovery.ownerId || message.checkpoint.epoch !== recovery.epoch || message.checkpoint.lobbyId !== this.requireInvitation().lobbyId) throw new Error('Steam recovery reply belongs to another prior authority');
    try { recovery.candidate = newerCheckpoint(recovery.candidate, message.checkpoint); recovery.responders.add(sender); }
    catch (error) { recovery.failure = error instanceof Error ? error.message : 'Invalid recovery conflict'; throw error; }
  }

  /** @param {{ownerId:string,epoch:string}|null} previous @param {number} generation @returns {Promise<void>} */
  async promote(previous, generation) {
    if (!previous) throw new Error('无法接替房主：房间没有可验证的上一任状态，拒绝创建空白频道');
    const candidate = this.checkpoint?.ownerId === previous.ownerId && this.checkpoint.epoch === previous.epoch ? this.checkpoint : null;
    /** @type {Recovery} */ const recovery = { ...previous, requestId: randomBytes(16).toString('hex'), generation, candidate, failure: null, responders: new Set() };
    this.recovery = recovery;
    const peers = [...this.members].filter(peer => peer !== this.client.selfId);
    for (const peer of peers) this.sendReplica(peer, { t: 'recover', ...previous, requestId: recovery.requestId });
    const started = Date.now();
    let retried = false;
    while (Date.now() - started < 4000 && peers.some(peer => this.members.has(peer) && !recovery.responders.has(peer))) {
      if (generation !== this.generation || this.stopping) return;
      if (recovery.failure) throw new Error('无法接替房主：副本内容冲突；' + recovery.failure);
      if (!retried && Date.now() - started >= 1500) {
        retried = true;
        console.warn('steam_recovery_retry', { ownerId: this.client.selfId, epoch: previous.epoch, attempt: 2 });
        for (const peer of peers) if (this.members.has(peer) && !recovery.responders.has(peer)) this.sendReplica(peer, { t: 'recover', ...previous, requestId: recovery.requestId });
      }
      await delay(25);
    }
    if (generation !== this.generation || this.stopping) return;
    if (recovery.failure) throw new Error('无法接替房主：副本内容冲突；' + recovery.failure);
    if (!recovery.candidate) throw new Error('无法接替房主：存活成员没有完整频道副本，现有媒体连接保留');
    const missing = peers.filter(peer => this.members.has(peer) && !recovery.responders.has(peer));
    if (missing.length) console.warn('steam_recovery_collection_incomplete', { epoch: previous.epoch, missingPeers: missing.length, recoveredSequence: recovery.candidate.sequence });
    const restored = recovery.candidate;
    this.recovery = null;
    this.epoch = randomBytes(16).toString('hex');
    this.sequence = 0;
    await this.stopBackend();
    if (generation !== this.generation || this.stopping) return;
    await this.startBackend(restored.stunUrls, restored);
    if (generation !== this.generation || this.stopping) return;
    this.client.claimAuthority(this.epoch);
    this.resumeLinks();
    for (const peer of this.members) if (peer !== this.client.selfId) this.sendCheckpoint(peer, 1);
    console.info('steam_host_migrated', { ownerId: this.client.selfId, epoch: this.epoch, restoredSequence: restored.sequence });
  }

  /** @param {Extract<SteamEvent,{type:'members'}>} event @returns {void} */
  membershipChanged(event) {
    const before = this.members;
    this.members = new Set(event.members);
    this.admission?.update(event.members);
    for (const peer of before) if (!this.members.has(peer)) {
      this.admission?.remove(peer);
      for (const key of this.assemblies.keys()) if (key.startsWith(peer + ':')) this.assemblies.delete(key);
      this.replicaAcks.delete(peer);
      for (const link of this.localLinks.values()) link.socket.send(JSON.stringify({ t: 'userLeft', id: stableSteamUserId(peer), reason: 'lobby-left' }));
      for (const link of this.backendLinks.values()) if (link.peerId === peer) this.closeBackend(peer, link.session);
      if (event.ownerId === this.client.selfId && this.backend?.connected && !this.migrating) this.backend.send({ t: 'steam-departed', steamId: peer });
    }
    if (event.ownerId !== this.ownerId) {
      const previous = this.client.publishedAuthority();
      this.ownerId = event.ownerId;
      this.migrating = true; this.migrationStarted = Date.now(); this.replicaAcks.clear();
      this.mediaGeneration+=1;
      const generation = ++this.generation;
      this.assemblies.clear();
      this.sockets?.closeAll(1012, 'Steam room owner is changing');
      for (const link of this.backendLinks.values()) this.closeBackend(link.peerId, link.session);
      if (this.ownerId === this.client.selfId) {
        this.migration = this.migration.then(() => this.promote(previous, generation)).catch(error => {
          if (generation !== this.generation || this.stopping) { console.info('steam_migration_superseded', { generation }); return; }
          this.fail(error instanceof Error ? error.message : 'Steam host recovery failed');
        });
      } else {
        this.stopBackend().catch(error => this.fail(error instanceof Error ? error.message : 'Old Steam backend did not stop'));
        if (event.epoch) this.sendReplica(this.ownerId, { t: 'request', epoch: event.epoch });
      }
      return;
    }
    if (this.ownerId === this.client.selfId) {
      if (!this.migrating) for (const peer of this.members) if (peer !== this.client.selfId && !before.has(peer)) this.sendCheckpoint(peer, 1);
    } else if (event.epoch && (this.migrating || this.epoch !== event.epoch)) {
      this.migrating = true; if (!this.migrationStarted) this.migrationStarted = Date.now();
      this.sendReplica(this.ownerId, { t: 'request', epoch: event.epoch });
    }
    this.queueMediaUpdate();
  }

  /** @returns {Invitation} */
  requireInvitation() {
    if (!this.invitation) throw new Error('Steam room has not finished joining');
    return this.invitation;
  }

  /** @param {LocalSocket} socket @returns {void} */
  openLocal(socket) {
    for (const link of this.localLinks.values()) link.socket.close(1000, 'Replaced by a new local room page');
    const session = randomBytes(16).toString('hex');
    /** @type {LocalLink} */ const link = { socket, session, opened: false, pending: [], pendingBytes: 0, createdAt: Date.now() };
    this.localLinks.set(session, link);
    socket.on('message', (/** @type {string} */ text, /** @type {boolean} */ binary) => {
      try {
        if (binary || !this.parseSignal) throw new TypeError('Only validated room commands are accepted over Steam');
        const command = cleanClientCommand(text, this.parseSignal);
        if (link.opened) this.clientCommand(session, command);
        else {
          if (link.pending.length >= 32 || link.pendingBytes + Buffer.byteLength(command) > 256 * 1024) throw new RangeError('Steam room admission queue is full');
          link.pending.push(command);
          link.pendingBytes += Buffer.byteLength(command);
        }
      } catch (error) { this.rejectLocal(link, error instanceof Error ? error.message : 'Invalid room command'); }
    });
    socket.on('close', () => {
      this.localLinks.delete(session);
      if (this.ownerId === this.client.selfId) this.closeBackend(this.client.selfId, session);
      else if (!this.stopping && !this.failed && !this.migrating) this.transmit(this.ownerId, session, 'close', EMPTY);
    });
    if (this.migrating) return;
    if (this.ownerId === this.client.selfId) this.openBackend(this.client.selfId, session);
    else this.transmit(this.ownerId, session, 'open', EMPTY);
  }

  /** @param {string} session @param {string} command @returns {void} */
  clientCommand(session, command) {
    if (this.ownerId === this.client.selfId) this.sendBackend(this.client.selfId, session, command);
    else this.transmit(this.ownerId, session, command.startsWith('{"t":"mediaRequest"') ? 'bulk' : 'data', Buffer.from(command));
  }

  /** @param {string} peerId @param {string} session @returns {void} */
  openBackend(peerId, session) {
    if (!this.backendOrigin || this.failed || this.stopping || this.migrating || this.client.authority().ownerId !== this.client.selfId) throw new Error('Steam room authority is not ready for admission');
    for (const link of this.backendLinks.values()) if (link.peerId === peerId) this.closeBackend(peerId, link.session);
    if (this.backendLinks.size >= 10) { this.respond(peerId, session, 'error', Buffer.from('Steam room is full')); return; }
    const key = peerId + ':' + session;
    const socket = new WebSocket(this.backendOrigin.replace('http:', 'ws:') + '/ws');
    const link = { socket, peerId, session, createdAt: Date.now() };
    this.backendLinks.set(key, link);
    socket.addEventListener('open', () => {
      if (this.backendLinks.get(key) !== link) { socket.close(); return; }
      this.respond(peerId, session, 'opened', EMPTY);
    });
    socket.addEventListener('message', (event) => {
      try {
        if (typeof event.data !== 'string') throw new TypeError('Unexpected binary room response');
        const payload = Buffer.from(event.data);
        serverMessage(payload);
        if (!this.migrating && this.client.authority().ownerId === this.client.selfId) this.respond(peerId, session, event.data.startsWith('{"t":"mediaResult"') ? 'bulk' : 'data', payload);
      } catch (error) { this.respond(peerId, session, 'error', Buffer.from(error instanceof Error ? error.message : 'Invalid room response')); this.closeBackend(peerId, session); }
    });
    socket.addEventListener('error', () => this.respond(peerId, session, 'error', Buffer.from('Local room signaling connection failed')));
    socket.addEventListener('close', () => {
      if (this.backendLinks.get(key) !== link) return;
      this.backendLinks.delete(key);
      if (!this.stopping && !this.migrating) this.respond(peerId, session, 'close', EMPTY);
    });
  }

  /** @param {string} peerId @param {string} session @param {string} text @returns {void} */
  sendBackend(peerId, session, text) {
    const link = this.backendLinks.get(peerId + ':' + session);
    if (!link || link.socket.readyState !== WebSocket.OPEN) throw new Error('Room signaling session is not ready');
    /** @type {JsonValue} */ const command = JSON.parse(text);
    if (command && typeof command === 'object' && !Array.isArray(command) && command.t === 'hello') {
      link.socket.send(JSON.stringify({ ...command, steamIdentity: signSteamIdentity(this.bridgeKey, this.requireInvitation().lobbyId, peerId, session) }));
    } else link.socket.send(text);
  }

  /** @param {string} peerId @param {string} session @returns {void} */
  closeBackend(peerId, session) {
    const key = peerId + ':' + session;
    for (const assembly of this.assemblies.keys()) if (assembly.startsWith(key + ':')) this.assemblies.delete(assembly);
    const link = this.backendLinks.get(key);
    this.backendLinks.delete(key);
    if (link) link.socket.close();
  }

  /** @param {string} target @param {string} session @param {Kind} kind @param {Buffer} payload @returns {void} */
  respond(target, session, kind, payload) {
    if (target === this.client.selfId) this.receiveLocal(session, kind, payload);
    else this.transmit(target, session, kind, payload);
  }

  /** @param {string} target @param {string} session @param {Kind} kind @param {Buffer} payload @returns {void} */
  transmit(target, session, kind, payload) {
    if (this.stopping || this.failed || this.client.recovering || !this.admission?.authorized(target)) return;
    if(kind==='bulk'){
      this.mediaQueue.send(target,encodeMessage(this.requireInvitation(),session,kind,payload)).catch(error=>console.warn('steam_media_send_failed',{peerId:target,message:error.message}));return;
    }
    try { for (const packet of encodeMessage(this.requireInvitation(), session, kind, payload)) this.admission.sendAuthorized(target, packet); }
    catch (error) { this.peerFailed(target, error instanceof Error ? error.message : 'Steam signaling send failed'); }
  }

  /** @param {string} session @param {Kind} kind @param {Buffer} payload @returns {void} */
  receiveLocal(session, kind, payload) {
    const link = this.localLinks.get(session);
    if (!link) return;
    if (kind === 'opened') {
      if (link.opened || payload.length) throw new TypeError('Invalid Steam room admission response');
      link.opened = true;
      for (const command of link.pending.splice(0)) this.clientCommand(session, command);
      link.pendingBytes = 0;
    } else if (kind === 'data' || kind==='bulk') {
      if (!link.opened || !link.socket.send(serverMessage(payload))) throw new Error('Local room page cannot receive Steam signaling');
      if(payload.toString('utf8').startsWith('{"t":"welcome"') && this.mediaStatuses.length)link.socket.send(JSON.stringify({t:'mediaStatus',items:this.mediaStatuses}));
    } else if (kind === 'close') link.socket.close(1013, 'Steam room signaling closed');
    else if (kind === 'error') this.rejectLocal(link, payload.toString('utf8').slice(0, 500));
    else throw new TypeError('Unexpected Steam signaling response');
  }

  /** @param {SteamEvent} event @returns {void} */
  steamEvent(event) {
    if (this.stopping) return;
    if (event.type === 'retrying') {
      console.warn('steam_connection_retrying', {reason:event.reason});
      for (const peer of this.members) this.admission?.remove(peer);
      this.replicaAcks.clear();
      this.assemblies.clear();
      this.sockets?.closeAll(1012, 'Steam signaling is reconnecting');
      for (const link of this.backendLinks.values()) this.closeBackend(link.peerId, link.session);
      return;
    }
    if (event.type === 'warning') { console.warn('Steam signaling warning', { message: event.message }); return; }
    if (event.type === 'error') { this.fail(event.message); return; }
    if (event.type === 'revoked') {
      this.admission?.remove(event.peerId);
      this.replicaAcks.delete(event.peerId);
      for (const key of this.assemblies.keys()) if (key.startsWith(event.peerId + ':')) this.assemblies.delete(key);
      for (const link of this.backendLinks.values()) if (link.peerId === event.peerId) this.closeBackend(event.peerId, link.session);
      return;
    }
    if (event.type === 'peer-error') { this.peerFailed(event.peerId, event.message); return; }
    if (!this.ownerId || !this.invitation) return;
    if (event.type === 'members') {
      this.membershipChanged(event);
      return;
    }
    if (event.type !== 'packet' || this.failed) return;
    try { this.receivePacket(event.sender, event.data); }
    catch (error) { console.warn('Rejected Steam signaling packet', { sender: event.sender, bytes: event.data.length, message: error instanceof Error ? error.message : 'Invalid packet' }); }
  }

  /** @param {string} sender @param {Buffer} packet @returns {void} */
  receivePacket(sender, packet) {
    if (!this.members.has(sender)) throw new TypeError('Steam signaling sender is not a current member');
    if (this.admission?.isPacket(packet)) { this.admission.receive(sender, packet); return; }
    if (!this.admission) throw new Error('Steam admission is not initialized');
    this.admission.requireAuthorized(sender);
    const frame = decodePacket(this.requireInvitation(), packet);
    const key = sender + ':' + frame.session + ':' + frame.kind;
    if (!['data','replica','media','bulk'].includes(frame.kind) && (frame.count !== 1 || (frame.kind === 'error' ? frame.data.length > 500 : frame.data.length !== 0))) throw new TypeError('Steam control messages cannot contain fragmented payloads');
    if((frame.kind==='bulk' || frame.kind==='media') && frame.count>2)throw new RangeError('Steam media frames exceed the independent 24 KiB message limit');
    if (frame.kind === 'replica') {
      if (frame.session !== REPLICA_SESSION) throw new TypeError('Steam replica has an invalid control session');
    } else if(frame.kind==='media'){
      if(this.migrating || !this.mediaReplicas)throw new Error('Steam media replicas are not ready');
    } else if (this.migrating) throw new Error('Steam room is changing authority; reconnect after readiness');
    else if (this.ownerId === this.client.selfId) {
      if (!['open', 'data', 'close','bulk'].includes(frame.kind)) throw new TypeError('Unexpected Steam room request kind');
      if (this.client.authority().ownerId !== this.client.selfId || (frame.kind !== 'open' && !this.backendLinks.has(sender + ':' + frame.session))) throw new TypeError('Steam signaling authority or session is no longer current');
    } else if (sender !== this.ownerId || this.client.authority().epoch !== this.epoch || !this.localLinks.has(frame.session)) throw new TypeError('Steam room response is outside the current authority/session');
    let assembly = this.assemblies.get(key);
    if (frame.index === 0) {
      if (assembly || this.assemblies.size >= 16) throw new RangeError('Steam signaling reassembly is busy');
      assembly = { kind: frame.kind, count: frame.count, chunks: [], bytes: 0, createdAt: Date.now() };
      this.assemblies.set(key, assembly);
    }
    if (!assembly || assembly.kind !== frame.kind || assembly.count !== frame.count || assembly.chunks.length !== frame.index) { this.assemblies.delete(key); throw new TypeError('Steam signaling fragments are out of order'); }
    assembly.chunks.push(frame.data);
    assembly.bytes += frame.data.length;
    if (assembly.bytes > MAX_MESSAGE_BYTES) { this.assemblies.delete(key); throw new RangeError('Steam signaling message exceeds the limit'); }
    if (assembly.chunks.length !== frame.count) return;
    this.assemblies.delete(key);
    const payload = Buffer.concat(assembly.chunks);
    if(frame.kind==='media'){
      if(payload.length>24576)throw new RangeError('Steam media message exceeds 24 KiB');
      this.mediaReplicas?.receive(sender,frame.session,payload).catch(error=>this.mediaError(error));return;
    }
    if (frame.kind === 'replica') { this.receiveReplica(sender, payload); return; }
    if (this.ownerId !== this.client.selfId) { this.receiveLocal(frame.session, frame.kind, payload); return; }
    if (frame.kind === 'open' && payload.length === 0) this.openBackend(sender, frame.session);
    else if (frame.kind === 'close' && payload.length === 0) this.closeBackend(sender, frame.session);
    else if ((frame.kind === 'data' || frame.kind==='bulk') && this.parseSignal) this.sendBackend(sender, frame.session, cleanClientCommand(payload.toString('utf8'), this.parseSignal));
    else throw new TypeError('Unsupported Steam room request');
  }

  /** @param {LocalLink} link @param {string} message @returns {void} */
  rejectLocal(link, message) {
    link.socket.send(JSON.stringify({ t: 'error', message }));
    link.socket.close(1013, 'Steam room signaling unavailable');
    this.onFailure(message);
  }

  /** @param {string} peerId @param {string} message @returns {void} */
  peerFailed(peerId, message) {
    console.warn('Steam peer signaling failed', { peerId, message });
    if (peerId === this.ownerId && this.ownerId !== this.client.selfId) for (const link of this.localLinks.values()) this.rejectLocal(link, message);
    for (const link of this.backendLinks.values()) if (link.peerId === peerId) {
      this.closeBackend(peerId, link.session);
      try {
        this.transmit(peerId, link.session, 'error', Buffer.from('Steam peer signaling disconnected; reconnecting'));
      } catch (error) { console.warn('Steam disconnect notice could not be delivered', { peerId, message: error instanceof Error ? error.message : 'Native send failed' }); }
    }
  }

  /** @param {string} message @returns {void} */
  fail(message) {
    if (this.failed || this.stopping) return;
    this.failed = message;
    for (const link of this.localLinks.values()) this.rejectLocal(link, message);
    for (const link of this.backendLinks.values()) this.closeBackend(link.peerId, link.session);
    this.onFailure(message);
  }

  /** @returns {void} */
  sweep() {
    if (this.client.recovering || this.failed || this.stopping) return;
    try { this.admission?.tick(); }
    catch (error) { this.fail(error instanceof Error ? error.message : String(error)); return; }
    if (this.migrating && this.migrationStarted && Date.now() - this.migrationStarted > 30000) { this.fail('房主接替超过 30 秒，未收到新房主的完整频道状态；现有媒体连接保留'); return; }
    if (this.ownerId === this.client.selfId && !this.migrating) for (const [peer, pending] of this.replicaAcks) {
      if (Date.now() - pending.at < 2000) continue;
      if (pending.attempts >= 4) { pending.at = Infinity; this.peerFailed(peer, '频道副本同步未获确认，此成员尚不能保证接替房主'); continue; }
      console.warn('steam_replica_retry', { peerId: peer, sequence: pending.sequence, attempt: pending.attempts + 1 });
      this.sendCheckpoint(peer, pending.attempts + 1);
    }
    const cutoff = Date.now() - 30000;
    for (const link of this.localLinks.values()) if (!link.opened && link.createdAt < cutoff) this.rejectLocal(link, 'Steam room signaling timed out; check that both Steam clients are online');
    for (const [key, assembly] of this.assemblies) if (assembly.createdAt < cutoff) { this.assemblies.delete(key); console.warn('Steam signaling fragment timeout', { session: key }); }
    for (const link of this.backendLinks.values()) if (link.socket.readyState === WebSocket.CONNECTING && link.createdAt < cutoff) this.closeBackend(link.peerId, link.session);
  }

  /** @param {Error} error @returns {void} */
  mediaError(error){
    console.warn('steam_media_failed',{roomId:this.checkpoint?.roomDocument?.roomId ?? null,message:error.message});
  }

  /** @returns {void} */
  queueMediaUpdate(){
    this.mediaRefreshRequested=true;
    if(this.mediaWorking || this.mediaClosing || this.stopping || this.migrating || !this.checkpoint)return;
    this.mediaWorking=true;
    const generation=this.mediaGeneration;
    this.mediaWork=(async()=>{
      while(this.mediaRefreshRequested && !this.stopping && !this.migrating && generation===this.mediaGeneration){
        this.mediaRefreshRequested=false;
        const checkpoint=this.checkpoint;
        if(!checkpoint?.roomDocument)throw new TypeError('Steam media requires a pinned room document');
        const descriptor=checkpoint.roomDocument,owner=this.ownerId===this.client.selfId,context=descriptor.roomId+':'+(owner?'host':'guest');
        if(this.mediaContext && this.mediaContext!==context)throw new Error('Steam media storage ownership changed without closing the previous connector');
        if(!this.mediaStorage){
          for(let attempt=1;attempt<=3;attempt++){
            if(generation!==this.mediaGeneration || this.stopping || this.migrating)return;
            try{this.mediaStorage=createSteamMediaStorage({rootDir:path.join(this.paths.userData,'chat-media'),roomId:descriptor.roomId,backend:owner ? {origin:this.backendOrigin,key:this.bridgeKey} : null});break;}
            catch(error){
              if(!(error instanceof Error) || !('code' in error) || error.code!=='media-busy' || attempt===3)throw error;
              console.warn('steam_media_open_retry',{roomId:descriptor.roomId,attempt,message:error.message});await delay(attempt*50);
            }
          }
          if(!this.mediaStorage)throw new Error('Steam media storage did not open');
          this.mediaReplicas=createMediaReplicas({selfId:this.client.selfId,storage:this.mediaStorage,send:(peer,session,payload)=>this.mediaQueue.send(peer,encodeMessage(this.requireInvitation(),session,'media',payload)),onStatus:items=>{
            this.mediaStatuses=items;
            for(const link of this.localLinks.values())if(link.opened)link.socket.send(JSON.stringify({t:'mediaStatus',items}));
          },reportError:error=>this.mediaError(error)});
          this.mediaContext=context;
        }
        const emojis=checkpoint.store.governance ? policyMedia(this.mediaGovernanceVerifier.verify(checkpoint.store.governance,descriptor).policy) : [];
        const manifest=collectContentAssets(emojis,checkpoint.store.messages,checkpoint.store.content ?? null);
        for(const asset of checkpoint.store.retainedReactionAssets ?? [])if(!manifest.assets.some(item=>item.sha256===asset.sha256)){manifest.assets.push(asset);manifest.history.push(asset.sha256);}
        await this.mediaReplicas?.update({roomId:descriptor.roomId,assets:manifest.assets,members:[...this.members].filter(peer=>peer===this.client.selfId || this.admission?.authorized(peer)),ownerId:this.ownerId});
      }
    })().catch(error=>this.mediaError(error instanceof Error ? error : new Error('Steam media synchronization failed'))).finally(()=>{this.mediaWorking=false;if(this.mediaRefreshRequested && !this.mediaClosing && !this.stopping && !this.migrating)this.queueMediaUpdate();});
  }

  /** @param {import('node:child_process').ChildProcess} child @param {{[key:string]:JsonValue}} message @returns {void} */
  restoreMedia(child,message){
    const hash=message.sha256;
    if(typeof hash!=='string' || !/^[a-f0-9]{64}$/.test(hash))throw new TypeError('Invalid backend media recovery hash');
    const restore=async()=>{
      await this.mediaWork;
      if(!this.mediaReplicas || this.backend!==child || this.stopping || this.migrating)throw new Error('Steam media recovery authority changed');
      await this.mediaReplicas.ensure(hash);
    };
    restore().then(()=>{if(this.backend===child && child.connected)child.send({t:'steam-media-ready',sha256:hash,ok:true});},error=>{
      this.mediaError(error instanceof Error ? error : new Error('Steam media recovery failed'));
      if(this.backend===child && child.connected)child.send({t:'steam-media-ready',sha256:hash,ok:false,message:error instanceof Error ? error.message.slice(0,500) : 'Media recovery failed'});
    });
  }

  /** @returns {Promise<void>} */
  async stopMedia(){
    this.mediaClosing=true;
    this.mediaGeneration+=1;
    const replicas=this.mediaReplicas,storage=this.mediaStorage;
    this.mediaReplicas=null;this.mediaStorage=null;this.mediaContext='';this.mediaStatuses=[];
    const closing=replicas?.close();
    await storage?.close();
    await closing;
    await this.mediaWork;
    this.mediaClosing=false;
  }

  /** @returns {Promise<void>} */
  stop() {
    if (!this.stoppingPromise) this.stoppingPromise = this.close();
    return this.stoppingPromise;
  }

  /** @returns {Promise<void>} */
  async close() {
    if (this.ownerId === this.client.selfId && this.backend?.connected && !this.failed && !this.migrating) {
      const sequence = this.sequence;
      this.backend.send({ t: 'steam-snapshot' });
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && (this.sequence === sequence || this.replicaAcks.size > 0)) await delay(25);
      if (this.sequence === sequence || this.replicaAcks.size > 0) console.warn('steam_final_replica_unconfirmed', { sequence: this.sequence, pendingPeers: this.replicaAcks.size });
    }
    this.stopping = true;
    this.assets?.close();
    this.assets = null;
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.mediaQueue.close();
    try { await this.stopMedia(); }
    finally { this.client.dispose(); }
    for (const link of this.backendLinks.values()) this.closeBackend(link.peerId, link.session);
    this.sockets?.closeAll(1000, 'Steam room closed');
    this.assemblies.clear();
    const server = this.httpServer;
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined)));
    }
    try { await this.migration; }
    catch (error) { console.warn('steam_stopped_failed_migration', { message: error instanceof Error ? error.message : 'Invalid migration failure' }); }
    finally { await this.stopBackend(); }
  }

  /** @returns {Promise<void>} */
  async stopBackend() {
    await this.stopMedia();
    const child = this.backend;
    const directory = this.directory;
    this.backend = null;
    this.backendOrigin = '';
    this.directory = '';
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Local Steam room process did not stop within 5 seconds')), 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(undefined); });
        child.kill();
      });
    }
    if (directory) {
      const parent = path.resolve(this.paths.userData, 'steam-rooms');
      if (path.dirname(path.resolve(directory)) !== parent || fs.realpathSync(directory) !== path.resolve(directory)) throw new Error('Refusing to clean a redirected Steam room directory');
      fs.rmSync(directory, { recursive: true });
    }
  }
}

/** @param {HostOptions} options @param {Paths} paths @param {(message:string)=>void} onFailure @returns {Promise<SteamRoom>} */
async function createSteamRoom(options, paths, onFailure) {
  if (!options || !Number.isSafeInteger(options.appId) || options.appId < 1 || options.appId > 4294967295 || !Array.isArray(options.stunUrls) || options.stunUrls.length > 8 || options.stunUrls.some((url) => typeof url !== 'string' || url.length > 2048)) throw new TypeError('Invalid Steam room App ID or STUN settings');
  /** @type {typeof import('../lib/network-policy.cjs')} */ const policy = require(path.join(paths.serverDirectory, 'lib', 'network-policy.cjs'));
  const validated = policy.readNetworkPolicy({ ECHO_NETWORK_MODE: 'server', ECHO_MEDIA_POLICY: 'direct', STUN_URLS: options.stunUrls.join(',') });
  const bridge = new SteamRoomBridge(options.appId, paths, onFailure);
  try { return await bridge.host({ appId: options.appId, stunUrls: validated.stunUrls, ...(options.roomSeed === undefined ? {} : { roomSeed: parseSteamRoomSeed(options.roomSeed) }) }); }
  catch (error) { await bridge.stop(); throw error; }
}

/** @param {string} invite @param {Paths} paths @param {(message:string)=>void} onFailure @returns {Promise<SteamRoom>} */
async function joinSteamRoom(invite, paths, onFailure) {
  const invitation = parseSteamInvite(invite);
  const bridge = new SteamRoomBridge(invitation.appId, paths, onFailure);
  try { return await bridge.join(invitation); }
  catch (error) { await bridge.stop(); throw error; }
}

module.exports = { createSteamRoom, joinSteamRoom };
