// @ts-check
import { ScreenLink } from './screen-link.js';
import { planScreenRoutes, screenBudget } from './screen-plan.js';
import { parseScreenMessage } from './screen-protocol.js';

/** @typedef {import('./screen-protocol.js').ScreenMessage} ScreenMessage */
/** @typedef {import('./screen-protocol.js').RoutePlan} RoutePlan */
/** @typedef {import('./screen-protocol.js').WireRoute} WireRoute */
/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('./screen-preferences.js').ScreenPreferences} ScreenPreferences */
/** @typedef {import('./screen-ice.js').ScreenIceCandidate} ScreenIceCandidate */
/** @typedef {{id:string,negotiationId:string,after:number,next:number,candidates:ScreenIceCandidate[],complete:boolean}} CandidateBatch */
/** @typedef {{id:string,negotiationId:string,role:'publish'|'subscribe',source:string,sdp:{type:'offer',sdp:string},network:{iceServers:{urls:string[],username:string,credential:string}[],policy:'all'|'relay'},admission:{streamBps:number,subscriberBudgetBps:number,sourceBudgetBps:number,locality:'remote'|'loopback-preview'}}} RelayOffer */
/** @typedef {{screenRelayRoom:(request:{roomKey:string|null})=>Promise<void>,screenRelayBudget:(request:{sourceBudgetBps:number})=>Promise<{sourceBudgetBps:number,admittedBps:number}>,screenRelayOffer:(request:RelayOffer)=>Promise<{id:string,negotiationId:string,sdp:{type:'answer',sdp:string}}>,screenRelayIce:(request:{id:string,negotiationId:string,candidate:ScreenIceCandidate})=>Promise<void>,screenRelayCandidates:(request:{id:string,negotiationId:string,after:number})=>Promise<CandidateBatch>,screenRelayRemove:(id:string)=>Promise<void>,screenRelayStats:()=>Promise<import('../../desktop/screen-relay-ipc.cjs').RelayStats>}} RelayBridge */
/** @typedef {{selfId:string,getContentEncryption?:()=>import('./screen-link.js').ScreenContentEncryption|null,getNetwork:()=>import('./network-protocol.js').NetworkConfig,getPreferences:()=>ScreenPreferences,peerIds:()=>string[],send:(peerId:string,message:ScreenMessage)=>boolean,onStream:(userId:string,stream:MediaStream|null)=>void,onError:(error:Error)=>void}} RelayOptions */
/** @typedef {{message:Extract<ScreenMessage,{kind:'capacity'}>,at:number}} CapacityReport */
/** @typedef {{id:string,negotiationId:string,sourceId:string,shareId:string,peerId:string,role:'direct'|'publish'|'subscribe'|'preview',link:ScreenLink,bitrateBps:number,iceReady:boolean,iceCursor:number,iceComplete:boolean,iceTail:Promise<void>}} BrowserEdge */
/** @typedef {{id:string,negotiationId:string,sourceId:string,shareId:string,peerId:string,role:'publish'|'subscribe',ready:Promise<void>,iceReady:boolean,iceCursor:number,iceComplete:boolean,iceReceived:number,iceTail:Promise<void>}} NativeEdge */
/** @typedef {{id:string,negotiationId:string,sourceId:string,shareId:string,peerId:string,role:'direct'|'publish'|'subscribe',expires:number}} RetiredEdge */

/** @returns {RelayBridge|null} */
export function screenRelayBridge() {
  const bridge = /** @type {Window & {deepscord?:RelayBridge}} */ (window).deepscord;
  return typeof bridge?.screenRelayOffer === 'function' ? bridge : null;
}

/** @param {RoutePlan} plan @param {WireRoute} route @returns {boolean} */
function isRelay(plan, route) { return plan.routes.some((child) => child.parentId === route.viewerId); }

/** A publisher-coordinated one-hop transport over authenticated peer controls. */
export class ScreenRelay {
  /** @param {RelayOptions} options */
  constructor(options) {
    this.options = options;
    this.bridge = screenRelayBridge();
    /** @type {string|null} */ this.channelId = null;
    /** @type {string|null} */ this.shareId = null;
    /** @type {MediaStream|null} */ this.stream = null;
    /** @type {Map<string,string>} */ this.shares = new Map();
    /** @type {Set<string>} */ this.watching = new Set();
    /** @type {Set<string>} */ this.viewers = new Set();
    /** @type {Map<string,CapacityReport>} */ this.capacities = new Map();
    /** @type {Map<string,RoutePlan>} */ this.plans = new Map();
    /** @type {Map<string,BrowserEdge>} */ this.edges = new Map();
    /** @type {Map<string,NativeEdge>} */ this.native = new Map();
    /** @type {Map<string,RetiredEdge>} */ this.retired = new Map();
    /** @type {Map<string,number>} */ this.excludedRelays = new Map();
    /** @type {Map<string,number>} */ this.failures = new Map();
    /** @type {Set<string>} */ this.invalidEdges = new Set();
    /** @type {Map<string,{frames:number,activeAt:number}>} */ this.sourceProgress = new Map();
    /** @type {Set<string>} */ this.nativeFaults = new Set();
    this.sentFrames = 0;
    /** @type {ReturnType<typeof setInterval>|null} */ this.timer = null;
    /** @type {ReturnType<typeof setInterval>|null} */ this.iceTimer = null;
    this.pollingIce = false;
    /** @type {ReturnType<typeof setTimeout>|null} */ this.replanTimer = null;
    /** @type {Promise<void>} */ this.roomReady = Promise.resolve();
    /** @type {Promise<void>} */ this.budgetReady = Promise.resolve();
    /** @type {number|null} */ this.requestedBudget = null;
    this.epoch = 0;
    this.generation = 0;
    this.capacityFactor = 1;
    this.goodSamples = 0;
    this.measuring = false;
    this.lastReplan = 0;
  }

  /** @param {string} channelId @returns {void} */
  join(channelId) {
    if (this.channelId === channelId) return;
    this.leave();
    this.channelId = channelId;
    const generation = this.generation;
    const open = async () => {
      if (this.bridge && generation === this.generation) await this.bridge.screenRelayRoom({ roomKey: channelId });
    };
    this.roomReady = this.roomReady.then(open, open);
    this.roomReady.catch((error) => this.report(error));
    this.timer = setInterval(() => { this.tick().catch((error) => this.report(error)); }, 2000);
    this.iceTimer = setInterval(() => { this.pollNativeIce().catch((error) => this.report(error)); }, 200);
  }

  /** @returns {number} */
  hardBudget() { return screenBudget(this.options.getPreferences().uploadLimitMbps * 1000000, this.options.peerIds().length); }

  /** @param {RoutePlan} plan @returns {number} */
  commitment(plan) {
    const self = this.options.selfId;
    return plan.routes.filter((route) => route.parentId === self).length * plan.wireBps;
  }

  /** @returns {Extract<ScreenMessage,{kind:'capacity'}>} */
  capacity() {
    const reservations = [...this.plans.values()].map((plan) => ({ shareId: plan.shareId, bps: this.commitment(plan) })).filter((entry) => entry.bps > 0);
    const used = reservations.reduce((sum, entry) => sum + entry.bps, 0);
    return { kind: 'capacity', version: 2, availableBps: Math.max(0, Math.floor(this.hardBudget() * this.capacityFactor - used)), relay: this.bridge !== null && this.options.getPreferences().relayEnabled, reservations };
  }

  /** @param {string} peerId @returns {void} */
  peerReady(peerId) {
    if (!this.channelId) return;
    this.send(peerId, this.capacity());
    this.send(peerId, { kind: 'share', version: 2, shareId: this.shareId });
  }

  /** @param {string} peerId @param {ScreenMessage} message @returns {void} */
  send(peerId, message) {
    if (!this.options.send(peerId, message)) throw new Error(`屏幕控制连接尚未就绪：${peerId}`);
  }

  /** @param {ScreenMessage} message @returns {void} */
  broadcast(message) {
    for (const id of this.options.peerIds()) if (this.capacities.has(id)) this.send(id, message);
  }

  /** @param {Error|object|string|number|boolean|null|undefined} error @returns {void} */
  report(error) {
    const failure = error instanceof Error ? error : new TypeError('Invalid screen operation failure');
    if (failure.name === 'AbortError') return;
    console.error('screen_transport_failed', { name: failure.name, message: failure.message, channelId: this.channelId });
    this.options.onError(failure);
  }

  /** @param {MediaStream} stream @returns {Promise<void>} */
  async publish(stream) {
    if (!this.channelId || this.stream) throw new DOMException('Screen publication is not ready', 'InvalidStateError');
    const generation = this.generation;
    const channelId = this.channelId;
    await this.roomReady;
    if (generation !== this.generation || channelId !== this.channelId || this.stream || stream.getVideoTracks()[0]?.readyState !== 'live') throw new DOMException('屏幕分享已取消', 'AbortError');
    this.stream = stream;
    this.shareId = crypto.randomUUID();
    this.sentFrames = 0;
    this.shares.set(this.options.selfId, this.shareId);
    this.epoch = 0;
    this.broadcast({ kind: 'share', version: 2, shareId: this.shareId });
  }

  /** @returns {Promise<void>} */
  async unpublish() {
    this.shareId = null;
    this.stream = null;
    this.viewers.clear();
    this.shares.delete(this.options.selfId);
    await this.clearSource(this.options.selfId);
    if (this.channelId) this.broadcast({ kind: 'share', version: 2, shareId: null });
  }

  /** @param {string} userId @returns {Promise<void>} */
  async watch(userId) {
    const shareId = this.shares.get(userId);
    if (!shareId) throw new Error('对方尚未提供新版屏幕传输会话，请双方更新客户端');
    this.watching.add(userId);
    try { this.send(userId, { kind: 'watch', version: 2, shareId, watching: true }); }
    catch (error) { this.watching.delete(userId); throw error; }
  }

  /** @param {string} userId @returns {Promise<void>} */
  async unwatch(userId) {
    this.watching.delete(userId);
    const shareId = this.shares.get(userId);
    if (shareId && this.capacities.has(userId)) this.send(userId, { kind: 'watch', version: 2, shareId, watching: false });
    await this.clearSource(userId);
  }

  /** @param {string} from @param {ScreenMessage} message @returns {Promise<void>} */
  async receive(from, message) {
    if (!this.channelId || !this.options.peerIds().includes(from)) throw new Error('Screen message from outside the current voice channel');
    const parsed = parseScreenMessage(/** @type {JsonValue} */ (message), this.options.getNetwork().mediaPolicy);
    if (parsed.kind === 'ice') {
      const retired = this.retired.get(parsed.negotiationId);
      if (retired && retired.expires > performance.now() && retired.id === parsed.edgeId && retired.peerId === from && retired.sourceId === parsed.sourceId && retired.shareId === parsed.shareId && retired.role === parsed.role) {
        console.info('screen_ice_cancelled_route', { edgeId: parsed.edgeId, sourceId: parsed.sourceId });
        return;
      }
    }
    if (parsed.kind === 'capacity') {
      const previous = this.capacities.get(from);
      this.capacities.set(from, { message: parsed, at: performance.now() });
      if (!previous) { this.send(from, this.capacity()); this.send(from, { kind: 'share', version: 2, shareId: this.shareId }); }
      if (this.viewers.has(from)) this.schedulePlan();
      return;
    }
    if (parsed.kind === 'share') {
      const changed = this.shares.get(from) !== parsed.shareId;
      if (parsed.shareId) this.shares.set(from, parsed.shareId); else this.shares.delete(from);
      if (changed) { this.watching.delete(from); this.sourceProgress.delete(from); await this.clearSource(from); }
      return;
    }
    if (parsed.kind === 'progress') {
      if (this.shares.get(from) !== parsed.shareId) return;
      const previous = this.sourceProgress.get(from);
      this.sourceProgress.set(from, { frames: parsed.frames, activeAt: parsed.frames > (previous?.frames || 0) ? performance.now() : previous?.activeAt || 0 });
      return;
    }
    if (parsed.kind === 'watch') {
      if (!this.shareId || parsed.shareId !== this.shareId) throw new Error('Screen watch request refers to an expired publication');
      if (parsed.watching) this.viewers.add(from); else this.viewers.delete(from);
      this.schedulePlan();
      return;
    }
    if (parsed.kind === 'rejected') {
      if (this.shares.get(from) !== parsed.shareId) return;
      this.watching.delete(from);
      await this.clearSource(from);
      throw new Error(parsed.message);
    }
    if (this.shares.get(parsed.sourceId) !== parsed.shareId) throw new Error('Screen message refers to an inactive publication');
    if (parsed.kind === 'plan') {
      if (from !== parsed.sourceId) throw new Error('Only the sharing user can assign screen routes');
      await this.applyPlan(parsed);
      return;
    }
    if (parsed.kind === 'fault') { this.handleFault(from, parsed); return; }
    if (parsed.kind === 'close') {
      const edge = this.edges.get(parsed.edgeId);
      const native = this.native.get(parsed.edgeId);
      if (edge && edge.peerId === from && edge.shareId === parsed.shareId) this.dropEdge(edge.id);
      if (native && native.peerId === from && native.shareId === parsed.shareId) await this.dropNative(native.id);
      return;
    }
    if (parsed.kind === 'answer') {
      const edge = this.edges.get(parsed.edgeId);
      if (!edge || edge.peerId !== from || edge.sourceId !== parsed.sourceId || edge.shareId !== parsed.shareId || edge.role !== parsed.role || edge.negotiationId !== parsed.negotiationId) throw new Error('Screen answer has no matching authorized connection');
      await edge.link.acceptAnswer(parsed.sdp);
      return;
    }
    if (parsed.kind === 'ice') { await this.receiveIce(from, parsed); return; }
    await this.acceptOffer(from, parsed);
  }

  /** @param {string} from @param {Extract<ScreenMessage,{kind:'ice'}>} message @returns {Promise<void>} */
  async receiveIce(from, message) {
    const edge = this.edges.get(message.edgeId) || this.native.get(message.edgeId);
    if (!edge || edge.peerId !== from || edge.sourceId !== message.sourceId || edge.shareId !== message.shareId || edge.role !== message.role || edge.negotiationId !== message.negotiationId || !this.currentRoute(message.sourceId, message.edgeId)) throw new Error('Screen ICE has no matching authorized negotiation');
    if ('link' in edge) { await edge.link.addIce(message.candidate); return; }
    if (++edge.iceReceived > 128) throw new RangeError('Native screen remote ICE candidate limit exceeded');
    const operation = edge.iceTail.then(async () => {
      await edge.ready;
      if (this.native.get(edge.id) !== edge) return;
      if (!this.bridge || !edge.iceReady) throw new Error('Native screen negotiation is unavailable');
      await this.bridge.screenRelayIce({ id: edge.id, negotiationId: edge.negotiationId, candidate: message.candidate });
    });
    edge.iceTail = operation;
    await operation;
  }

  /** @returns {void} */
  schedulePlan() {
    if (this.replanTimer || !this.shareId) return;
    this.replanTimer = setTimeout(() => {
      this.replanTimer = null;
      this.replan().catch((error) => this.report(error));
    }, 300);
  }

  /** @returns {Promise<void>} */
  async replan() {
    const shareId = this.shareId;
    if (!shareId) return;
    const self = this.options.selfId;
    const old = this.plans.get(self);
    const reservedElsewhere = [...this.plans.values()].filter((plan) => plan.sourceId !== self).reduce((sum, plan) => sum + this.commitment(plan), 0);
    const now = performance.now();
    const viewers = [...this.viewers].filter((id) => this.capacities.has(id) && now - /** @type {CapacityReport} */ (this.capacities.get(id)).at < 9000).map((id) => {
      const report = /** @type {CapacityReport} */ (this.capacities.get(id));
      const existing = report.message.reservations.find((entry) => entry.shareId === shareId)?.bps || 0;
      return { id, availableBps: report.message.availableBps + existing, relay: report.message.relay && (this.excludedRelays.get(id) || 0) < now };
    });
    let proposal;
    try { proposal = planScreenRoutes(self, Math.max(0, Math.floor(this.hardBudget() * this.capacityFactor) - reservedElsewhere), this.options.getPreferences().screenBitrateMbps * 1000000, viewers, old?.routes || []); }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Screen capacity planning failed';
      for (const id of this.viewers) this.send(id, { kind: 'rejected', version: 2, shareId, message });
      this.viewers.clear();
      await this.clearSource(self);
      throw error;
    }
    const stable = old?.bitrateBps === proposal.bitrateBps && old.routes.length === proposal.routes.length && proposal.routes.every((route) => old.routes.some((prior) => prior.viewerId === route.viewerId && prior.parentId === route.parentId && !this.invalidEdges.has(prior.routeId)));
    if (stable) return;
    /** @type {RoutePlan} */
    const plan = { kind: 'plan', version: 2, sourceId: self, shareId, epoch: ++this.epoch, bitrateBps: proposal.bitrateBps, wireBps: proposal.wireBps, routes: [] };
    plan.routes = proposal.routes.map((route) => {
      const prior = old?.routes.find((item) => item.viewerId === route.viewerId && item.parentId === route.parentId);
      const relayNow = proposal.routes.some((item) => item.parentId === route.viewerId);
      const unchanged = prior && old && old.bitrateBps === plan.bitrateBps && isRelay(old, prior) === relayNow && !this.invalidEdges.has(prior.routeId);
      return { ...route, routeId: unchanged ? prior.routeId : crypto.randomUUID() };
    });
    this.lastReplan = now;
    for (const peerId of new Set([...(old?.routes.map((route) => route.viewerId) || []), ...plan.routes.map((route) => route.viewerId)])) {
      if (this.capacities.has(peerId)) this.send(peerId, plan);
    }
    await this.applyPlan(plan);
    this.invalidEdges.clear();
  }

  /** @param {RoutePlan} plan @returns {Promise<void>} */
  async applyPlan(plan) {
    const previous = this.plans.get(plan.sourceId);
    if (previous && plan.epoch <= previous.epoch) return;
    const self = this.options.selfId;
    if (plan.routes.some((route) => !this.options.peerIds().includes(route.viewerId) && route.viewerId !== self)) throw new Error('Screen plan contains a user outside this channel');
    const own = plan.routes.find((route) => route.viewerId === self);
    if (own && !this.watching.has(plan.sourceId)) throw new Error('Screen plan assigned an unsolicited viewer');
    const relay = own && isRelay(plan, own);
    const otherCommitment = [...this.plans.values()].filter((item) => item.sourceId !== plan.sourceId).reduce((sum, item) => sum + this.commitment(item), 0);
    if (relay && (!this.bridge || !this.options.getPreferences().relayEnabled || this.commitment(plan) + otherCommitment > this.hardBudget() * this.capacityFactor)) {
      this.send(plan.sourceId, { kind: 'fault', version: 2, sourceId: plan.sourceId, shareId: plan.shareId, edgeId: own.routeId, message: '中转者上传余量不足或已关闭协作转发' });
      this.send(plan.sourceId, this.capacity());
      return;
    }
    this.plans.set(plan.sourceId, plan);
    const allowed = new Set(plan.routes.map((route) => route.routeId));
    if (own && relay) allowed.add('p_' + own.routeId);
    for (const edge of [...this.edges.values()]) if (edge.sourceId === plan.sourceId && !allowed.has(edge.id)) this.dropEdge(edge.id);
    for (const edge of [...this.native.values()]) if (edge.sourceId === plan.sourceId && !allowed.has(edge.id)) await this.dropNative(edge.id);
    if (this.plans.get(plan.sourceId) !== plan) return;
    if (!own && plan.sourceId !== self) this.options.onStream(plan.sourceId, null);
    if (plan.sourceId === self) {
      for (const route of plan.routes.filter((item) => item.parentId === self)) {
        if (this.edges.has(route.routeId)) continue;
        this.startPublishEdge(plan, route).catch((error) => this.edgeFailure(plan, route.routeId, error));
      }
    } else if (own && own.parentId !== plan.sourceId && !this.edges.has(own.routeId)) {
      this.startSubscriber(plan, own).catch((error) => this.edgeFailure(plan, own.routeId, error));
    }
    this.broadcast(this.capacity());
  }

  /** @param {RoutePlan} plan @param {string} id @param {string} peerId @param {BrowserEdge['role']} role @param {string} negotiationId @param {import('./screen-link.js').ScreenNetwork} network @returns {BrowserEdge} */
  createEdge(plan, id, peerId, role, negotiationId, network) {
    const link = new ScreenLink({ network, contentEncryption:this.options.getContentEncryption?.() || null, onStream: (stream) => {
      if (this.edges.get(id)?.link === link && this.watching.has(plan.sourceId)) this.options.onStream(plan.sourceId, stream);
    }, onIce: (candidate) => {
      if (this.edges.get(id) !== edge) return;
      if (role === 'preview') {
        const operation = edge.iceTail.then(async () => {
          if (this.edges.get(id) !== edge) return;
          if (!this.bridge || !edge.iceReady) throw new Error('Native preview negotiation is unavailable');
          await this.bridge.screenRelayIce({ id, negotiationId, candidate });
        });
        edge.iceTail = operation;
        operation.catch((error) => { if (this.edges.get(id) === edge) this.edgeFailure(plan, id, error); });
      } else this.send(peerId, { kind: 'ice', version: 2, sourceId: plan.sourceId, shareId: plan.shareId, edgeId: id, negotiationId, role, candidate });
    }, onFault: (error) => this.edgeFailure(plan, id, error) });
    const edge = { id, peerId, sourceId: plan.sourceId, shareId: plan.shareId, role, negotiationId, link, bitrateBps: plan.bitrateBps, iceReady: false, iceCursor: 0, iceComplete: false, iceTail: Promise.resolve() };
    this.edges.set(id, edge);
    return edge;
  }

  /** @param {RoutePlan} plan @param {WireRoute} route @returns {Promise<void>} */
  async startPublishEdge(plan, route) {
    const stream = this.stream;
    if (!stream || this.shareId !== plan.shareId) return;
    const role = isRelay(plan, route) ? 'publish' : 'direct';
    const edge = this.createEdge(plan, route.routeId, route.viewerId, role, crypto.randomUUID(), this.options.getNetwork());
    const preferences = this.options.getPreferences();
    const sdp = await edge.link.sendOffer(stream, plan.bitrateBps, preferences.screenFrameRate, preferences.screenContentMode);
    if (this.edges.get(edge.id) !== edge) return;
    this.send(route.viewerId, { kind: 'offer', version: 2, sourceId: plan.sourceId, shareId: plan.shareId, edgeId: edge.id, negotiationId: edge.negotiationId, role, sdp });
    edge.link.releaseIce();
  }

  /** @param {RoutePlan} plan @param {WireRoute} route @returns {Promise<void>} */
  async startSubscriber(plan, route) {
    const edge = this.createEdge(plan, route.routeId, route.parentId, 'subscribe', crypto.randomUUID(), this.options.getNetwork());
    const sdp = await edge.link.receiveOffer();
    if (this.edges.get(edge.id) !== edge) return;
    this.send(route.parentId, { kind: 'offer', version: 2, sourceId: plan.sourceId, shareId: plan.shareId, edgeId: edge.id, negotiationId: edge.negotiationId, role: 'subscribe', sdp });
    edge.link.releaseIce();
  }

  /** @param {string} from @param {Extract<ScreenMessage,{kind:'offer'|'answer'}>} message @returns {Promise<void>} */
  async acceptOffer(from, message) {
    const plan = this.plans.get(message.sourceId);
    const route = plan?.routes.find((item) => item.routeId === message.edgeId);
    if (!plan || !route || plan.shareId !== message.shareId) throw new Error('Screen offer has no current route grant');
    const self = this.options.selfId;
    if (message.role === 'direct') {
      if (from !== plan.sourceId || route.parentId !== from || route.viewerId !== self || isRelay(plan, route) || !this.watching.has(from)) throw new Error('Unauthorized direct screen offer');
      if (this.edges.has(message.edgeId)) throw new Error('Duplicate screen offer');
      const edge = this.createEdge(plan, route.routeId, from, 'direct', message.negotiationId, this.options.getNetwork());
      const sdp = await edge.link.answer(message.sdp);
      if (this.edges.get(edge.id) !== edge) return;
      this.send(from, { ...message, kind: 'answer', sdp });
      edge.link.releaseIce();
      return;
    }
    const owner = plan.routes.find((item) => item.viewerId === self);
    if (!owner || owner.parentId !== plan.sourceId || !isRelay(plan, owner) || !this.bridge) throw new Error('This client is not an authorized screen relay');
    if (message.role === 'publish' && (from !== plan.sourceId || route.viewerId !== self || route.routeId !== owner.routeId)) throw new Error('Unauthorized screen relay publisher');
    if (message.role === 'subscribe' && (route.parentId !== self || route.viewerId !== from)) throw new Error('Unauthorized screen relay subscriber');
    if (this.native.has(message.edgeId)) throw new Error('Duplicate native screen session');
    let done = () => {};
    const ready = new Promise((resolve) => { done = () => resolve(undefined); });
    const entry = { id: message.edgeId, negotiationId: message.negotiationId, sourceId: plan.sourceId, shareId: plan.shareId, peerId: from, role: message.role, ready, iceReady: false, iceCursor: 0, iceComplete: false, iceReceived: 0, iceTail: Promise.resolve() };
    this.native.set(entry.id, entry);
    try {
      await this.roomReady;
      await this.ensureBudget();
      if (message.role === 'subscribe') await this.waitForPublisher(plan, owner.routeId);
      if (this.native.get(entry.id) !== entry || !this.currentRoute(plan.sourceId, route.routeId)) return;
      const response = await this.bridge.screenRelayOffer({ id: entry.id, negotiationId: entry.negotiationId, role: message.role, source: owner.routeId, sdp: { type: 'offer', sdp: message.sdp }, network: this.nativeNetwork(), admission: { streamBps: plan.bitrateBps, subscriberBudgetBps: message.role === 'subscribe' ? plan.wireBps : 0, sourceBudgetBps: this.hardBudget(), locality: 'remote' } });
      if (this.native.get(entry.id) !== entry || !this.currentRoute(plan.sourceId, route.routeId)) { await this.bridge.screenRelayRemove(entry.id); return; }
      this.checkAnswer(response, entry.id, entry.negotiationId);
      entry.iceReady = true;
      done();
      this.send(from, { ...message, kind: 'answer', sdp: response.sdp.sdp });
      if (message.role === 'publish') this.startPreview(plan, owner).catch((error) => this.edgeFailure(plan, owner.routeId, error));
    } catch (error) {
      done();
      if (this.native.get(entry.id) === entry) this.native.delete(entry.id);
      this.edgeFailure(plan, entry.id, error instanceof Error ? error : new TypeError('Native screen negotiation failed'));
      throw error;
    } finally { done(); }
  }

  /** @returns {RelayOffer['network']} */
  nativeNetwork() {
    const config = this.options.getNetwork();
    return { policy: config.iceTransportPolicy, iceServers: config.iceServers.map((server) => ({ urls: typeof server.urls === 'string' ? [server.urls] : server.urls, username: server.username || '', credential: server.credential || '' })) };
  }

  /** @returns {Promise<void>} */
  ensureBudget() {
    const budget = this.hardBudget();
    if (budget === this.requestedBudget) return this.budgetReady;
    this.requestedBudget = budget;
    const generation = this.generation;
    const update = async () => {
      if (generation !== this.generation || !this.channelId || !this.bridge) throw new DOMException('Screen budget update cancelled', 'AbortError');
      await this.roomReady;
      await this.bridge.screenRelayBudget({ sourceBudgetBps: budget });
    };
    this.budgetReady = this.budgetReady.then(update, update);
    this.budgetReady.catch(() => { if (this.requestedBudget === budget) this.requestedBudget = null; });
    return this.budgetReady;
  }

  /** @param {RoutePlan} plan @param {string} id @returns {Promise<void>} */
  async waitForPublisher(plan, id) {
    const deadline = performance.now() + 22000;
    while (performance.now() < deadline) {
      if (!this.currentRoute(plan.sourceId, id)) throw new DOMException('Relay publication cancelled', 'AbortError');
      const publisher = this.native.get(id);
      if (publisher) { await publisher.ready; if (this.native.get(id) !== publisher) throw new Error('Relay publisher failed to start'); return; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('中转者未在 22 秒内收到分享者连接');
  }

  /** @param {{id:string,negotiationId:string,sdp:{type:'answer',sdp:string}}} answer @param {string} id @param {string} negotiationId @returns {void} */
  checkAnswer(answer, id, negotiationId) {
    if (answer.id !== id || answer.negotiationId !== negotiationId || answer.sdp?.type !== 'answer' || typeof answer.sdp.sdp !== 'string' || !answer.sdp.sdp.startsWith('v=0')) throw new TypeError('Native screen relay returned an invalid answer');
  }

  /** @param {RoutePlan} plan @param {WireRoute} owner @returns {Promise<void>} */
  async startPreview(plan, owner) {
    if (!this.bridge || !this.currentRoute(plan.sourceId, owner.routeId)) return;
    const id = 'p_' + owner.routeId;
    if (this.edges.has(id)) return;
    const edge = this.createEdge(plan, id, this.options.selfId, 'preview', crypto.randomUUID(), { iceServers: [], iceTransportPolicy: 'all' });
    const sdp = await edge.link.receiveOffer();
    if (this.edges.get(id) !== edge) return;
    const answer = await this.bridge.screenRelayOffer({ id, negotiationId: edge.negotiationId, role: 'subscribe', source: owner.routeId, sdp: { type: 'offer', sdp }, network: { iceServers: [], policy: 'all' }, admission: { streamBps: plan.bitrateBps, subscriberBudgetBps: 0, sourceBudgetBps: this.hardBudget(), locality: 'loopback-preview' } });
    if (this.edges.get(id) !== edge) { await this.bridge.screenRelayRemove(id); return; }
    this.checkAnswer(answer, id, edge.negotiationId);
    await edge.link.acceptAnswer(answer.sdp.sdp);
    edge.iceReady = true;
    edge.link.releaseIce();
  }

  /** @returns {Promise<void>} */
  async pollNativeIce() {
    if (!this.bridge || !this.channelId || this.pollingIce) return;
    this.pollingIce = true;
    try {
      const entries = [...this.native.values(), ...[...this.edges.values()].filter((edge) => edge.role === 'preview')];
      for (const edge of entries) {
        if (!edge.iceReady || edge.iceComplete) continue;
        const live = () => ('link' in edge ? this.edges.get(edge.id) : this.native.get(edge.id)) === edge;
        try {
          const batch = await this.bridge.screenRelayCandidates({ id: edge.id, negotiationId: edge.negotiationId, after: edge.iceCursor });
          if (!live()) continue;
          if (batch.id !== edge.id || batch.negotiationId !== edge.negotiationId || batch.after !== edge.iceCursor || batch.next !== edge.iceCursor + batch.candidates.length || batch.next > 128) throw new TypeError('Native screen ICE cursor is invalid');
          edge.iceCursor = batch.next;
          edge.iceComplete = batch.complete;
          for (const candidate of batch.candidates) {
            if (!live()) break;
            if ('link' in edge) await edge.link.addIce(candidate);
            else this.send(edge.peerId, { kind: 'ice', version: 2, sourceId: edge.sourceId, shareId: edge.shareId, edgeId: edge.id, negotiationId: edge.negotiationId, role: edge.role, candidate });
          }
        } catch (error) {
          if (!live()) continue;
          edge.iceComplete = true;
          const plan = this.plans.get(edge.sourceId);
          if (plan) this.edgeFailure(plan, edge.id, error instanceof Error ? error : new TypeError('Native screen ICE collection failed'));
        }
      }
    } finally { this.pollingIce = false; }
  }

  /** @param {string} sourceId @param {string} edgeId @returns {boolean} */
  currentRoute(sourceId, edgeId) { return this.plans.get(sourceId)?.routes.some((route) => route.routeId === edgeId) === true; }

  /** @param {RoutePlan} plan @param {string} edgeId @param {Error|object|string|number|boolean|null|undefined} error @returns {void} */
  edgeFailure(plan, edgeId, error) {
    const routeId = edgeId.startsWith('p_') ? edgeId.slice(2) : edgeId;
    if (!this.currentRoute(plan.sourceId, routeId)) return;
    const message = error instanceof Error ? error.message : 'Screen route failed';
    if (error instanceof Error && error.name === 'AbortError') return;
    console.warn('screen_route_failed', { sourceId: plan.sourceId, edgeId, message });
    const fault = /** @type {Extract<ScreenMessage,{kind:'fault'}>} */ ({ kind: 'fault', version: 2, sourceId: plan.sourceId, shareId: plan.shareId, edgeId: routeId, message: message.slice(0, 600) });
    if (plan.sourceId === this.options.selfId) this.handleFault(this.options.selfId, fault);
    else {
      try { this.send(plan.sourceId, fault); }
      catch (failure) { this.report(failure instanceof Error ? failure : new TypeError('Screen fault report failed')); }
    }
  }

  /** @param {string} from @param {Extract<ScreenMessage,{kind:'fault'}>} message @returns {void} */
  handleFault(from, message) {
    if (message.sourceId !== this.options.selfId || message.shareId !== this.shareId) throw new Error('Screen fault is not addressed to this publisher');
    const plan = this.plans.get(this.options.selfId);
    const route = plan?.routes.find((item) => item.routeId === message.edgeId);
    if (!plan || !route) return;
    if (from !== this.options.selfId && from !== route.viewerId && from !== route.parentId) throw new Error('Unrelated user reported a screen route fault');
    if (this.invalidEdges.has(route.routeId)) return;
    const parent = route.parentId !== this.options.selfId ? route.parentId : isRelay(plan, route) ? route.viewerId : null;
    if (parent) this.excludedRelays.set(parent, performance.now() + 60000);
    const count = (this.failures.get(route.viewerId) || 0) + 1;
    this.failures.set(route.viewerId, count);
    console.warn('screen_route_reassigning', { viewerId: route.viewerId, parentId: parent, attempt: count, message: message.message });
    if (count >= 3 && !parent) {
      this.viewers.delete(route.viewerId);
      this.send(route.viewerId, { kind: 'rejected', version: 2, shareId: plan.shareId, message: `屏幕连接连续失败：${message.message}`.slice(0, 600) });
    }
    this.dropEdge(route.routeId);
    this.invalidEdges.add(route.routeId);
    this.schedulePlan();
  }

  /** @returns {Promise<void>} */
  async tick() {
    if (!this.channelId || this.measuring) return;
    this.measuring = true;
    try {
      const now = performance.now();
      for (const [id, report] of this.capacities) if (now - report.at > 10000) this.peerRemoved(id);
      let congested = false;
      for (const edge of [...this.edges.values()]) {
        if (edge.link.closed) continue;
        const stats = await edge.link.stats();
        const previous = edge.link.previous;
        if (previous && this.edges.get(edge.id) === edge) {
          if (edge.sourceId === this.options.selfId) this.sentFrames += Math.max(0, stats.framesEncoded - previous.framesEncoded);
          const received = stats.receivedPackets - previous.receivedPackets;
          const loss = Math.max(0, stats.lost - previous.lost);
          const badLoss = received + loss > 100 && loss / (received + loss) > 0.08;
          const badSender = stats.availableBps !== null && stats.framesEncoded > 0 && stats.availableBps < edge.bitrateBps * 0.65;
          const plan = this.plans.get(edge.sourceId);
          if (plan && badLoss && edge.role !== 'publish' && edge.role !== 'direct') this.edgeFailure(plan, edge.id, new Error('屏幕接收持续丢包，需要重新安排中转'));
          if (badSender) congested = true;
          const source = this.sourceProgress.get(edge.sourceId);
          if (plan && source && now - source.activeAt < 4000 && stats.framesDecoded > 0 && now - edge.link.lastProgress > 8000) this.edgeFailure(plan, edge.id, new Error('分享者仍在发送新画面，但当前路线已连续 8 秒未收到新帧'));
        }
        edge.link.previous = stats;
      }
      if (congested) { this.capacityFactor = Math.max(0.15, this.capacityFactor * 0.8); this.goodSamples = 0; }
      else if (++this.goodSamples >= 15) { this.capacityFactor = Math.min(1, this.capacityFactor + 0.05); this.goodSamples = 0; }
      if (this.bridge && this.native.size) {
        const native = await this.bridge.screenRelayStats();
        for (const entry of this.native.values()) {
          const state = native.sessions.find((session) => session.id === entry.id);
          if ((!native.running || state?.state === 'failed' || state?.state === 'closed' || state?.diagnostic) && !this.nativeFaults.has(entry.id)) {
            this.nativeFaults.add(entry.id);
            const plan = this.plans.get(entry.sourceId);
            if (plan) this.edgeFailure(plan, entry.id, new Error(`原生屏幕中继失败：${state?.diagnostic || state?.state || 'process-exited'}`));
            this.capacityFactor = Math.max(0.15, this.capacityFactor * 0.8);
            this.goodSamples = 0;
          }
        }
      }
      await this.reconcileCapacity();
      for (const peerId of this.options.peerIds()) this.options.send(peerId, this.capacity());
      if (this.shareId) this.broadcast({ kind: 'progress', version: 2, shareId: this.shareId, frames: this.sentFrames });
      if (this.shareId && now - this.lastReplan > 5000) this.schedulePlan();
    } finally { this.measuring = false; }
  }

  /** @returns {Promise<void>} */
  async reconcileCapacity() {
    let used = [...this.plans.values()].reduce((sum, plan) => sum + this.commitment(plan), 0);
    const limit = Math.floor(this.hardBudget() * this.capacityFactor);
    for (const plan of [...this.plans.values()].filter((item) => item.sourceId !== this.options.selfId)) {
      const own = plan.routes.find((route) => route.viewerId === this.options.selfId);
      if (!own || !isRelay(plan, own) || (used <= limit && this.options.getPreferences().relayEnabled)) continue;
      this.send(plan.sourceId, { kind: 'fault', version: 2, sourceId: plan.sourceId, shareId: plan.shareId, edgeId: own.routeId, message: '当前总上传余量下降，中转者正在释放超额路线' });
      used -= this.commitment(plan);
      await this.clearSource(plan.sourceId);
    }
    if (this.bridge && this.channelId) await this.ensureBudget();
  }

  /** @param {string} id @returns {void} */
  dropEdge(id) {
    const edge = this.edges.get(id);
    if (!edge) return;
    this.edges.delete(id);
    this.retire(edge);
    edge.link.close();
    const generation = this.generation;
    if (edge.role === 'preview' && this.bridge) this.bridge.screenRelayRemove(id).catch((error) => { if (generation === this.generation) this.report(error); });
  }

  /** @param {string} id @returns {Promise<void>} */
  async dropNative(id) {
    const edge = this.native.get(id);
    if (!edge) return;
    this.native.delete(id);
    this.retire(edge);
    this.nativeFaults.delete(id);
    const generation = this.generation;
    if (this.bridge) {
      try { await this.bridge.screenRelayRemove(id); }
      catch (error) { if (generation === this.generation) throw error; }
    }
  }

  /** @param {BrowserEdge|NativeEdge} edge @returns {void} */
  retire(edge) {
    if (edge.role === 'preview') return;
    const now = performance.now();
    for (const [nonce, retired] of this.retired) if (retired.expires <= now) this.retired.delete(nonce);
    while (this.retired.size >= 256) { const first = this.retired.keys().next().value; if (first !== undefined) this.retired.delete(first); }
    this.retired.set(edge.negotiationId, { id: edge.id, negotiationId: edge.negotiationId, sourceId: edge.sourceId, shareId: edge.shareId, peerId: edge.peerId, role: edge.role, expires: now + 30000 });
  }

  /** @param {string} sourceId @returns {Promise<void>} */
  async clearSource(sourceId) {
    this.plans.delete(sourceId);
    this.options.onStream(sourceId, null);
    for (const edge of [...this.edges.values()]) if (edge.sourceId === sourceId) this.dropEdge(edge.id);
    for (const edge of [...this.native.values()]) if (edge.sourceId === sourceId) await this.dropNative(edge.id);
  }

  /** @param {string} peerId @returns {void} */
  peerRemoved(peerId) {
    this.capacities.delete(peerId);
    this.shares.delete(peerId);
    this.sourceProgress.delete(peerId);
    this.watching.delete(peerId);
    this.viewers.delete(peerId);
    this.clearSource(peerId).catch((error) => this.report(error));
    for (const edge of [...this.edges.values()]) if (edge.peerId === peerId) this.dropEdge(edge.id);
    for (const edge of [...this.native.values()]) if (edge.peerId === peerId) this.dropNative(edge.id).catch((error) => this.report(error));
    this.schedulePlan();
  }

  /** @returns {Promise<void>} */
  async updatePreferences() {
    for (const plan of [...this.plans.values()]) {
      const own = plan.routes.find((route) => route.viewerId === this.options.selfId);
      if (!own || !isRelay(plan, own)) continue;
      this.send(plan.sourceId, { kind: 'fault', version: 2, sourceId: plan.sourceId, shareId: plan.shareId, edgeId: own.routeId, message: '中转者更新了上传设置，需要重新分配路线' });
      await this.clearSource(plan.sourceId);
    }
    await this.roomReady;
    if (this.bridge && this.channelId) await this.ensureBudget();
    this.broadcast(this.capacity());
    this.schedulePlan();
  }

  /** @returns {void} */
  refreshNetwork() {
    const plan = this.plans.get(this.options.selfId);
    if (plan) for (const route of plan.routes) this.invalidEdges.add(route.routeId);
    this.schedulePlan();
  }

  /** @returns {void} */
  leave() {
    this.generation += 1;
    this.requestedBudget = null;
    this.channelId = null;
    if (this.timer) clearInterval(this.timer);
    if (this.iceTimer) clearInterval(this.iceTimer);
    if (this.replanTimer) clearTimeout(this.replanTimer);
    this.timer = null;
    this.iceTimer = null;
    this.replanTimer = null;
    for (const edge of this.edges.values()) edge.link.close();
    this.edges.clear();
    this.native.clear();
    this.retired.clear();
    this.plans.clear();
    this.shares.clear();
    this.capacities.clear();
    this.viewers.clear();
    this.watching.clear();
    this.excludedRelays.clear();
    this.failures.clear();
    this.invalidEdges.clear();
    this.sourceProgress.clear();
    this.nativeFaults.clear();
    this.shareId = null;
    this.stream = null;
    const close = async () => { if (this.bridge) await this.bridge.screenRelayRoom({ roomKey: null }); };
    if (this.bridge) this.roomReady = this.roomReady.then(close, close);
    this.roomReady.catch((error) => this.report(error));
  }

  /** @returns {{mode:'peer-relay',protocolVersion:2,capacityFactor:number,availableBps:number,plans:RoutePlan[],connections:{id:string,sourceId:string,peerId:string,role:BrowserEdge['role'],state:RTCPeerConnectionState,iceState:RTCIceConnectionState,gathering:RTCIceGatheringState,localCandidateMessages:number,remoteCandidateMessages:number,discoveryErrors:string[]}[]}} */
  snapshot() {
    return { mode: 'peer-relay', protocolVersion: 2, capacityFactor: this.capacityFactor, availableBps: this.capacity().availableBps, plans: [...this.plans.values()], connections: [...this.edges.values()].map((edge) => ({ id: edge.id, sourceId: edge.sourceId, peerId: edge.peerId, role: edge.role, state: edge.link.pc.connectionState, iceState: edge.link.pc.iceConnectionState, gathering: edge.link.pc.iceGatheringState, localCandidateMessages: edge.link.localCandidateCount, remoteCandidateMessages: edge.link.remoteCandidateCount, discoveryErrors: [...edge.link.discoveryErrors] })) };
  }
}
