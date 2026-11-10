// @ts-check
'use strict';

const { randomBytes } = require('node:crypto');

/** @typedef {ReturnType<typeof import('steamworks.js').init>} NativeClient */
/** @typedef {import('steamworks.js/client').matchmaking.Lobby} Lobby */
/** @typedef {{ownerId: string, epoch: string|null}} SteamAuthority */
/** @typedef {SteamAuthority & {lobbyId: string}} LobbyAddress */
/** @typedef {{type: 'packet', sender: string, data: Buffer} | {type: 'members', members: string[], ownerId: string, epoch: string|null} | {type:'revoked',peerId:string} | {type: 'warning', message: string} | {type: 'peer-error', peerId: string, message: string} | {type: 'error', message: string}} SteamEvent */

const MAX_PACKET_BYTES = 32 * 1024;
const MAX_NATIVE_PACKET_BYTES = 1024 * 1024;
const MAX_RECEIVED_BYTES_PER_TICK = 256 * 1024;
const MAX_PACKETS_PER_TICK = 64;
const MAX_PENDING_REQUESTS = 16;
const PENDING_REQUEST_TTL_MS = 7500;
const OPERATION_TIMEOUT_MS = 15000;
const NAMESPACE_KEY = 'deepscord:namespace';
const VERSION_KEY = 'deepscord:protocol';
const AUTHORITY_KEY = 'deepscord:authority';
const NAMESPACE = 'deepscord-webrtc-signaling';
const VERSION = '4';
/** @type {NativeClient|null} */
let sharedNative = null;
/** @type {Set<SteamClient>} */
const activeClients = new Set();

/** @template {keyof import('steamworks.js/callbacks').CallbackReturns} C
 * @param {C} kind
 * @returns {(listener:(event:import('steamworks.js/callbacks').CallbackReturns[C])=>void)=>()=>void} */
function sharedCallback(kind) {
  /** @type {Set<(event:import('steamworks.js/callbacks').CallbackReturns[C])=>void>} */
  const listeners = new Set();
  /** @type {import('steamworks.js/client').callback.Handle|null} */
  let handle = null;
  return listener => {
    if (!sharedNative) throw new Error('Steam callbacks require an initialized client');
    listeners.add(listener);
    if (!handle) handle = sharedNative.callback.register(kind, event => { for (const subscriber of [...listeners]) if (listeners.has(subscriber)) subscriber(event); });
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && handle) { handle.disconnect(); handle = null; }
    };
  };
}
// The native binding stores one callback for each event type.
const subscriptions = { disconnected:sharedCallback(2),failed:sharedCallback(3),data:sharedCallback(4),members:sharedCallback(5),request:sharedCallback(6),peerError:sharedCallback(7) };

/** @param {string} value @param {string} name @returns {bigint} */
function parseSteamId(value, name) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{15,19}$/.test(value)) {
    throw new TypeError(`${name} must be a decimal Steam ID: ${String(value)}`);
  }
  const id = BigInt(value);
  if (id > 18446744073709551615n) {
    throw new RangeError(`${name} exceeds the unsigned 64-bit Steam ID range: ${value}`);
  }
  return id;
}

class SteamClient {
  /** @type {NativeClient} */
  #native;
  /** @type {(event: SteamEvent) => void} */
  #onEvent;
  /** @type {Lobby | null} */
  #lobby = null;
  /** @type {Array<()=>void>} */
  #callbacks = [];
  /** @type {ReturnType<typeof setInterval> | null} */
  #pollTimer = null;
  /** @type {(() => void) | null} */
  #cancelPending = null;
  #disposed = false;
  #entering = false;
  #generation = 0;
  #lastMembership = '';
  /** @type {((sender:string,packet:Buffer)=>boolean)|null} */
  #packetMatcher = null;
  /** @type {Map<string, {remote: bigint, expiresAt: number}>} */
  #pendingRequests = new Map();
  /** @type {string} */
  selfId;

  /** @param {number} appId @param {(event: SteamEvent) => void} onEvent */
  constructor(appId, onEvent) {
    if (!Number.isSafeInteger(appId) || appId <= 0 || appId > 4294967295) {
      throw new RangeError(`Steam App ID must be a positive unsigned 32-bit integer: ${appId}`);
    }
    if (typeof onEvent !== 'function') throw new TypeError('Steam event handler must be a function');
    // Loading the native library is deferred until Steam mode is requested.
    if (!sharedNative) sharedNative = require('steamworks.js').init(appId);
    this.#native = sharedNative;
    this.selfId = this.#native.localplayer.getSteamId().steamId64.toString();
    parseSteamId(this.selfId, 'Local player ID');
    if (this.#native.utils.getAppId() !== appId) {
      throw new Error(`Steam initialized with a different App ID; requested=${appId}, actual=${this.#native.utils.getAppId()}`);
    }
    this.#onEvent = onEvent;
  }

  /** @returns {Promise<LobbyAddress>} */
  async create() {
    return this.#enter(
      () => this.#native.matchmaking.createLobby(3, 10),
      (lobby) => {
        const ownerId = lobby.getOwner().steamId64.toString();
        if (ownerId !== this.selfId) throw new Error(`Created Steam lobby is owned by another player; lobbyId=${lobby.id}, ownerId=${ownerId}`);
        const epoch = randomBytes(16).toString('hex');
        if (!lobby.mergeFullData({ [NAMESPACE_KEY]: NAMESPACE, [VERSION_KEY]: VERSION, [AUTHORITY_KEY]: `${ownerId}:${epoch}` })) {
          throw new Error(`Steam lobby metadata write failed; lobbyId=${lobby.id}`);
        }
        if (!lobby.setJoinable(true)) throw new Error(`Steam lobby could not become joinable; lobbyId=${lobby.id}`);
        this.#validateLobby(lobby);
      },
      'create',
    );
  }

  /** @param {string} lobbyId @returns {Promise<LobbyAddress>} */
  async join(lobbyId) {
    const id = parseSteamId(lobbyId, 'Lobby ID');
    if (this.#lobby || this.#entering) throw new Error('Leave the current Steam lobby before creating or joining another room');
    if ([...activeClients].some(client => client.#lobby?.id === id)) throw new Error('此 Steam 房间已在当前客户端打开');
    return this.#enter(
      () => this.#native.matchmaking.joinLobby(id),
      (lobby) => this.#validateLobby(lobby),
      `join:${lobbyId}`,
    );
  }

  /** @param {(sender:string,packet:Buffer)=>boolean} matcher @returns {void} */
  setPacketMatcher(matcher) { this.#packetMatcher = matcher; }

  /** @returns {string[]} */
  members() {
    this.#assertUsable();
    if (!this.#lobby) return [];
    return this.#lobby.getMembers().map((member) => member.steamId64.toString());
  }

  /** @returns {SteamAuthority} */
  authority() {
    this.#assertUsable();
    if (!this.#lobby) throw new Error('Steam authority requires membership in a lobby');
    const ownerId = this.#lobby.getOwner().steamId64.toString();
    const published = this.publishedAuthority();
    return { ownerId, epoch: published && published.ownerId === ownerId ? published.epoch : null };
  }

  /** @returns {{ownerId:string,epoch:string}|null} */
  publishedAuthority() {
    this.#assertUsable();
    if (!this.#lobby) throw new Error('Published Steam authority requires membership in a lobby');
    const value = this.#lobby.getData(AUTHORITY_KEY);
    const match = typeof value === 'string' ? /^([1-9][0-9]{15,19}):([a-f0-9]{32})$/.exec(value) : null;
    if (!match || BigInt(match[1]) > 18446744073709551615n) return null;
    // Published metadata is a recovery hint, not proof of current ownership.
    return { ownerId: match[1], epoch: match[2] };
  }

  /** @param {string} epoch @returns {void} */
  claimAuthority(epoch) {
    this.#assertUsable();
    if (typeof epoch !== 'string' || !/^[a-f0-9]{32}$/.test(epoch)) throw new TypeError('Steam authority epoch must be 32 lowercase hexadecimal characters');
    if (!this.#lobby) throw new Error('Steam authority claim requires membership in a lobby');
    const { ownerId } = this.authority();
    if (ownerId !== this.selfId) throw new Error(`Only the native Steam lobby owner may claim authority; lobbyId=${this.#lobby.id}, ownerId=${ownerId}, selfId=${this.selfId}`);
    if (!this.#lobby.setData(AUTHORITY_KEY, `${ownerId}:${epoch}`)) throw new Error(`Steam authority metadata write failed; lobbyId=${this.#lobby.id}, ownerId=${ownerId}, epoch=${epoch}`);
    this.#publishMembers();
  }

  /** @param {string} target @param {Buffer} payload @returns {void} */
  send(target, payload) {
    this.#assertUsable();
    const id = parseSteamId(target, 'Packet target');
    if (!Buffer.isBuffer(payload)) throw new TypeError('Steam signaling payload must be a Buffer');
    if (payload.length === 0 || payload.length > MAX_PACKET_BYTES) {
      throw new RangeError(`Steam signaling packet length must be 1..${MAX_PACKET_BYTES}; bytes=${payload.length}, target=${target}`);
    }
    if (target === this.selfId || !this.members().includes(target)) {
      throw new Error(`Steam signaling target is not a remote member of the current lobby; target=${target}`);
    }
    if (!this.#native.networking.sendP2PPacket(id, 2, payload)) {
      throw new Error(`Steam reliable signaling send failed; target=${target}, bytes=${payload.length}`);
    }
  }

  /** @returns {void} */
  leave() {
    activeClients.delete(this);
    this.#generation += 1;
    this.#entering = false;
    const cancel = this.#cancelPending;
    this.#cancelPending = null;
    if (cancel) cancel();
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
    for (const unsubscribe of this.#callbacks) unsubscribe();
    this.#callbacks = [];
    const lobby = this.#lobby;
    this.#lobby = null;
    this.#lastMembership = '';
    this.#pendingRequests.clear();
    if (lobby) lobby.leave();
  }

  /** @returns {void} */
  dispose() {
    this.leave();
    this.#disposed = true;
    // steamworks.js owns its runCallbacks interval and exposes no shutdown API.
  }

  /** @returns {void} */
  #assertUsable() {
    if (this.#disposed) throw new Error('Steam connector has been disposed');
  }

  /** @param {Lobby} lobby @returns {void} */
  #validateLobby(lobby) {
    const namespace = lobby.getData(NAMESPACE_KEY);
    const version = lobby.getData(VERSION_KEY);
    if (namespace !== NAMESPACE || version !== VERSION) {
      throw new Error(`Steam lobby is not a compatible Deepscord room; lobbyId=${lobby.id}, namespace=${namespace}, protocol=${version}`);
    }
  }

  /** @param {() => Promise<Lobby>} operation @param {(lobby: Lobby) => void} configure @param {string} label @returns {Promise<LobbyAddress>} */
  async #enter(operation, configure, label) {
    this.#assertUsable();
    if (this.#lobby || this.#entering) throw new Error('Leave the current Steam lobby before creating or joining another room');
    if (activeClients.size >= 2) throw new Error('Steam room transition already has two active lobbies');
    const generation = this.#generation;
    this.#entering = true;
    try {
      this.#registerCallbacks();
      const lobby = await this.#waitLobby(operation, label);
      if (generation !== this.#generation) {
        lobby.leave();
        throw new Error(`Steam lobby operation was cancelled; operation=${label}`);
      }
      this.#lobby = lobby;
      configure(lobby);
      const { ownerId } = this.authority();
      const members = this.members();
      if (!members.includes(this.selfId) || !members.includes(ownerId) || members.length > 10) {
        throw new Error(`Steam lobby has invalid membership; lobbyId=${lobby.id}, ownerId=${ownerId}, members=${members.join(',')}`);
      }
      activeClients.add(this);
      this.#pollTimer = setInterval(() => this.#poll(), 20);
      this.#publishMembers();
      this.#entering = false;
      return { lobbyId: lobby.id.toString(), ...this.authority() };
    } catch (error) {
      if (generation === this.#generation) this.leave();
      throw error;
    }
  }

  /** @param {() => Promise<Lobby>} operation @param {string} label @returns {Promise<Lobby>} */
  #waitLobby(operation, label) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        this.#cancelPending = null;
        reject(new Error(`Steam lobby operation timed out after ${OPERATION_TIMEOUT_MS}ms; operation=${label}`));
      }, OPERATION_TIMEOUT_MS);
      this.#cancelPending = () => {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Steam lobby operation cancelled; operation=${label}`));
      };
      // Late Steam responses must leave their lobby even after cancellation.
      Promise.resolve().then(operation).then((lobby) => {
        if (settled) {
          lobby.leave();
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.#cancelPending = null;
        resolve(lobby);
      }, (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#cancelPending = null;
        reject(error);
      });
    });
  }

  /** @returns {void} */
  #registerCallbacks() {
    this.#callbacks.push(subscriptions.disconnected((event) => this.#fail(`Steam servers disconnected; reason=${event.reason}`)));
    this.#callbacks.push(subscriptions.failed((event) => this.#fail(`Steam server connection failed; reason=${event.reason}, retrying=${event.still_retrying}`)));
    this.#callbacks.push(subscriptions.members((event) => {
        if (!this.#lobby || event.lobby !== this.#lobby.id) return;
        // Native transitions revoke admission even if a rapid rejoin preserves the polled member list.
        if (event.member_state_change !== 0) this.#onEvent({type:'revoked',peerId:event.user_changed.toString()});
        this.#lastMembership = '';
        this.#publishMembers();
      }));
    this.#callbacks.push(subscriptions.data((event) => {
        if (!this.#lobby || event.lobby !== this.#lobby.id) return;
        if (!event.success) {
          this.#fail(`Steam lobby metadata refresh failed; lobbyId=${event.lobby}`);
          return;
        }
        try {
          this.#validateLobby(this.#lobby);
          this.#publishMembers();
        } catch (error) {
          this.#fail(error instanceof Error ? error.message : String(error));
        }
      }));
    this.#callbacks.push(subscriptions.request((event) => {
        const remote = event.remote.toString();
        if (remote === this.selfId) {
          this.#warn(`Rejected Steam P2P session from the local player; remote=${remote}`);
          return;
        }
        this.#flushPendingRequests();
        if (this.#lobby && this.members().includes(remote)) {
          this.#acceptRequest(event.remote);
          return;
        }
        if ([...activeClients].some(client => client !== this && client.members().includes(remote))) return;
        if (!this.#pendingRequests.has(remote)) {
          if (this.#pendingRequests.size >= MAX_PENDING_REQUESTS) {
            this.#warn(`Rejected Steam P2P request because the pending request limit was reached; remote=${remote}, maximum=${MAX_PENDING_REQUESTS}`);
            return;
          }
          this.#pendingRequests.set(remote, { remote: event.remote, expiresAt: Date.now() + PENDING_REQUEST_TTL_MS });
        }
        this.#flushPendingRequests();
      }));
    this.#callbacks.push(subscriptions.peerError((event) => {
        if (this.members().includes(event.remote.toString())) {
          const peerId = event.remote.toString();
          const message = `Steam P2P session connection failed; remote=${peerId}, code=${event.error}`;
          this.#peerError(peerId, message);
        }
      }));
  }

  /** @returns {void} */
  #publishMembers() {
    if (!this.#lobby) return;
    const members = this.members();
    const { ownerId, epoch } = this.authority();
    if (!members.includes(this.selfId) || !members.includes(ownerId) || members.length > 10) {
      this.#fail(`Steam lobby membership became invalid; lobbyId=${this.#lobby.id}, ownerId=${ownerId}`);
      return;
    }
    this.#flushPendingRequests();
    const signature = `${ownerId}:${epoch}:${[...members].sort().join(',')}`;
    if (signature === this.#lastMembership) return;
    this.#lastMembership = signature;
    this.#onEvent({ type: 'members', members, ownerId, epoch });
  }

  /** @returns {void} */
  #poll() {
    if (!this.#lobby) return;
    try {
      this.#publishMembers();
      if (!this.#lobby) return;
      // Steam exposes one packet queue per process, shared by overlapping lobbies.
      if (activeClients.values().next().value !== this) return;
      let receivedBytes = 0;
      for (let index = 0; index < MAX_PACKETS_PER_TICK; index += 1) {
        if (!this.#lobby || receivedBytes >= MAX_RECEIVED_BYTES_PER_TICK) return;
        const size = this.#native.networking.isP2PPacketAvailable();
        if (size === 0) return;
        if (!Number.isInteger(size) || size < 1 || size > MAX_NATIVE_PACKET_BYTES) {
          throw new RangeError(`Steam native packet size is outside SDK bounds; bytes=${size}, maximum=${MAX_NATIVE_PACKET_BYTES}`);
        }
        // Drain oversized signaling packets within the SDK's hard allocation bound.
        const packet = this.#native.networking.readP2PPacket(size);
        receivedBytes += size;
        const sender = packet.steamId.steamId64.toString();
        if (packet.size !== size || packet.data.length !== size) {
          this.#warn(`Rejected Steam signaling packet with a length mismatch; sender=${sender}, available=${size}, reported=${packet.size}, actual=${packet.data.length}`);
          continue;
        }
        const recipients = [...activeClients].filter(client => client.#lobby && client.members().includes(sender));
        if (sender === this.selfId || recipients.length === 0) {
          this.#warn(`Rejected Steam signaling packet from a nonmember; sender=${sender}, bytes=${size}`);
          continue;
        }
        if (size > MAX_PACKET_BYTES) {
          this.#warn(`Rejected oversized Steam signaling packet; sender=${sender}, bytes=${size}, maximum=${MAX_PACKET_BYTES}`);
          continue;
        }
        const data = Buffer.from(packet.data);
        const matching = recipients.filter(client => !client.#packetMatcher || client.#packetMatcher(sender, data));
        if (matching.length === 0) {
          this.#warn(`Rejected Steam packet outside active room invitations; sender=${sender}, bytes=${size}`);
          continue;
        }
        for (const client of matching) client.#onEvent({ type: 'packet', sender, data });
      }
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : String(error));
    }
  }

  /** @returns {void} */
  #flushPendingRequests() {
    const now = Date.now();
    const members = new Set(this.#lobby ? this.members() : []);
    for (const [peerId, request] of this.#pendingRequests) {
      if (!members.has(peerId) && [...activeClients].some(client => client !== this && client.members().includes(peerId))) {
        this.#pendingRequests.delete(peerId);
        continue;
      }
      if (request.expiresAt <= now) {
        this.#pendingRequests.delete(peerId);
        this.#warn(`Expired unaccepted Steam P2P request; remote=${peerId}, ttlMs=${PENDING_REQUEST_TTL_MS}`);
        continue;
      }
      if (!members.has(peerId)) continue;
      this.#pendingRequests.delete(peerId);
      this.#acceptRequest(request.remote);
    }
  }

  /** @param {bigint} remote @returns {void} */
  #acceptRequest(remote) {
    try {
      this.#native.networking.acceptP2PSession(remote);
    } catch (error) {
      const peerId = remote.toString();
      const reason = error instanceof Error ? error.message : String(error);
      this.#peerError(peerId, `Steam P2P session acceptance failed; remote=${peerId}, reason=${reason}`);
    }
  }

  /** @param {string} peerId @param {string} message @returns {void} */
  #peerError(peerId, message) {
    console.warn('Steam peer connection error', { peerId, message });
    this.#onEvent({ type: 'peer-error', peerId, message });
  }

  /** @param {string} message @returns {void} */
  #warn(message) {
    console.warn('Steam signaling warning', { message, selfId: this.selfId, lobbyId: this.#lobby?.id.toString() ?? null });
    this.#onEvent({ type: 'warning', message });
  }

  /** @param {string} message @returns {void} */
  #report(message) {
    console.error('Steam signaling error', { message, selfId: this.selfId, lobbyId: this.#lobby?.id.toString() ?? null });
    this.#onEvent({ type: 'error', message });
  }

  /** @param {string} message @returns {void} */
  #fail(message) {
    this.leave();
    this.#report(message);
  }
}

module.exports = { SteamClient };
