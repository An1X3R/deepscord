// @ts-check
import { parsePeerControl, parsePeerSignal } from './network-protocol.js';
import { summarizePeerStats } from './peer-stats.js';
import { withStereoAccompaniment } from './media-description.js';

/** @typedef {import('./network-protocol.js').NetworkConfig} NetworkConfig */
/** @typedef {import('./network-protocol.js').PeerSignal} PeerSignal */
/** @typedef {import('./network-protocol.js').PeerControl} PeerControl */
/** @typedef {import('./peer-stats.js').LinkStats} LinkStats */
/** @typedef {'microphone'|'accompaniment'|'screen'} MediaKind */
/** @typedef {{selfId:string,peerId:string,config:NetworkConfig,track:MediaStreamTrack|null,stream:MediaStream|null,sendSignal:(data:PeerSignal)=>void,onTrack:(stream:MediaStream,kind:MediaKind)=>void,onState:(state:RTCPeerConnectionState)=>void,onControl:(data:PeerControl)=>void,onReady:()=>void,onError:(error:Error)=>void}} LinkOptions */

/** A connector for one authenticated peer, independent of room membership. */
export class PeerLink {
  /** @param {LinkOptions} options */
  constructor(options) {
    this.options = options;
    this.config = options.config;
    this.pc = new RTCPeerConnection({ iceServers: this.config.iceServers, iceTransportPolicy: this.config.iceTransportPolicy });
    this.control = this.pc.createDataChannel('deepscord-control-v1', { negotiated: true, id: 0 });
    this.interactionControl = this.pc.createDataChannel('deepscord-interaction-v1', { negotiated: true, id: 2, ordered: false, maxPacketLifeTime: 800 });
    this.interactionControl.onmessage = (event) => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 1024) throw new TypeError('Invalid interaction datagram');
        const message = parsePeerControl(event.data, this.config.mediaPolicy);
        if (message.type !== 'interaction') throw new TypeError('Only interaction events may use the interaction datagram channel');
        options.onControl(message);
      } catch (error) { this.report(error instanceof Error ? error : new TypeError('Interaction datagram failed')); }
    };
    this.interactionControl.onopen = () => { if (this.control.readyState === 'open') options.onReady(); };
    this.pokeControl = this.pc.createDataChannel('deepscord-poke-v1', { negotiated: true, id: 1, ordered: false, maxPacketLifeTime: 500 });
    this.pokeControl.onmessage = (event) => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 2048) throw new TypeError('Invalid screen poke datagram');
        const message = parsePeerControl(event.data, this.config.mediaPolicy);
        if (message.type !== 'poke' || (message.data.action !== 'hit' && message.data.action !== 'event')) throw new TypeError('Only transient screen poke events may use the datagram channel');
        options.onControl(message);
      } catch (error) { this.report(error instanceof Error ? error : new TypeError('Screen poke datagram failed')); }
    };
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.settingAnswer = false;
    this.closed = false;
    this.leaving = false;
    this.restartPending = false;
    /** @type {RTCIceCandidateInit[]} */
    this.pending = [];
    /** @type {LinkStats} */
    this.lastStats = summarizePeerStats([], []);
    /** @type {import('./peer-stats.js').StatsEntry[]} */
    this.previousStats = [];
    /** @type {RTCRtpTransceiver|null} */ this.microphone = null;
    /** @type {RTCRtpTransceiver|null} */ this.accompaniment = null;
    /** @type {RTCRtpTransceiver|null} */ this.screen = null;
    /** @type {MediaStreamTrack|null} */ this.accompanimentTrack = null;
    if (options.selfId < options.peerId) {
      this.microphone = this.pc.addTransceiver(options.track || 'audio', { direction: 'sendrecv', streams: options.stream ? [options.stream] : [] });
      this.accompaniment = this.pc.addTransceiver('audio', { direction: 'sendrecv' });
      this.screen = this.pc.addTransceiver('video', { direction: 'sendrecv' });
    }
    this.pc.ontrack = (event) => {
      const index = this.pc.getTransceivers().indexOf(event.transceiver);
      if (index < 0 || index > 2 || event.track.kind !== (index === 2 ? 'video' : 'audio')) { this.report(new TypeError('对方媒体通道不兼容，请双方更新到同一版本')); return; }
      const kind = index === 2 ? 'screen' : index === 1 ? 'accompaniment' : 'microphone';
      options.onTrack(event.streams[0] || new MediaStream([event.track]), kind);
    };
    this.pc.onconnectionstatechange = () => {
      options.onState(this.pc.connectionState);
      this.restartWhenReady();
    };
    this.pc.onsignalingstatechange = () => this.restartWhenReady();
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        try { this.transmit({ type: 'ice', candidate: event.candidate.toJSON() }); }
        catch (error) { this.report(error instanceof Error ? error : new TypeError('Peer control operation failed')); }
      }
    };
    this.pc.onnegotiationneeded = () => { this.negotiate().catch((error) => this.report(error)); };
    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === 'failed') {
        options.onError(new Error('语音链路已失败；房间在线时可重新加入，离线时无法重新交换连接信息'));
      }
    };
    this.control.onmessage = (event) => {
      try {
        if (typeof event.data !== 'string') throw new TypeError('Binary peer control is unsupported');
        const message = parsePeerControl(event.data, this.config.mediaPolicy);
        if (message.type === 'interaction') throw new TypeError('Interaction events require the lifetime-limited datagram channel');
        if (message.type === 'poke' && (message.data.action === 'hit' || message.data.action === 'event')) throw new TypeError('Transient screen poke events require the lifetime-limited datagram channel');
        if (message.type === 'signal') this.receive(message.data).catch((error) => this.report(error));
        else if (message.type === 'restart') {
          if (this.options.selfId > this.options.peerId) throw new TypeError('Invalid ICE restart coordinator');
          this.restartPending = true;
          this.restartWhenReady();
        }
        else {
          if (message.type === 'leave') this.leaving = true;
          options.onControl(message);
        }
      } catch (error) { this.report(error instanceof Error ? error : new TypeError('Peer control operation failed')); }
    };
    this.control.onopen = () => { options.onReady(); this.restartWhenReady(); };
    this.control.onerror = (event) => {
      if (this.closed || this.leaving) return;
      this.report(new Error('语音控制连接失败：' + event.error.message));
    };
  }

  /** @param {Error|object|string|number|boolean|null|undefined} error @returns {void} */
  report(error) {
    if (this.closed) return;
    const failure = error instanceof Error ? error : new Error('Peer connection operation failed');
    console.error('Peer connection failed', { peerId: this.options.peerId, name: failure.name, message: failure.message });
    this.options.onError(failure);
  }

  /** @param {PeerSignal} signal @returns {void} */
  transmit(signal) {
    if (this.closed) return;
    if (this.control.readyState === 'open') this.control.send(JSON.stringify({ type: 'signal', data: signal }));
    else this.options.sendSignal(signal);
  }

  /** @returns {Promise<void>} */
  async negotiate() {
    if (this.closed || this.makingOffer || this.pc.signalingState !== 'stable') return;
    // One deterministic initial offer avoids simultaneous ICE gathering rollbacks.
    if (this.options.selfId > this.options.peerId) return;
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription(withStereoAccompaniment(await this.pc.createOffer()));
      const description = this.pc.localDescription;
      if (!description || description.type !== 'offer') return;
      this.transmit({ type: 'offer', sdp: description.toJSON() });
    } finally { this.makingOffer = false; }
  }

  /** @param {import('./network-protocol.js').JsonValue|PeerSignal} raw @returns {Promise<void>} */
  async receive(raw) {
    if (this.closed) return;
    const signal = parsePeerSignal(/** @type {import('./network-protocol.js').JsonValue} */ (raw), this.config.mediaPolicy);
    if (signal.type === 'ice') {
      if (this.ignoreOffer) return;
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(signal.candidate);
      else {
        if (this.pending.length >= 128) throw new RangeError('Too many pending ICE candidates');
        this.pending.push(signal.candidate);
      }
      return;
    }
    const ready = !this.makingOffer && (this.pc.signalingState === 'stable' || this.settingAnswer);
    const collision = signal.type === 'offer' && !ready;
    const polite = this.options.selfId > this.options.peerId;
    this.ignoreOffer = !polite && collision;
    if (this.ignoreOffer) return;
    this.settingAnswer = signal.type === 'answer';
    try { await this.pc.setRemoteDescription(signal.sdp); }
    finally { this.settingAnswer = false; }
    for (const candidate of this.pending.splice(0)) await this.pc.addIceCandidate(candidate);
    if (signal.type === 'offer') {
      const transceivers = this.pc.getTransceivers();
      if (transceivers.length !== 3) throw new TypeError('对方媒体通道版本不兼容，请双方更新客户端');
      [this.microphone, this.accompaniment, this.screen] = transceivers;
      for (const transceiver of transceivers) transceiver.direction = 'sendrecv';
      if (this.options.stream) this.microphone.sender.setStreams(this.options.stream);
      await this.microphone.sender.replaceTrack(this.options.track);
      await this.accompaniment.sender.replaceTrack(this.accompanimentTrack);
      await this.pc.setLocalDescription(withStereoAccompaniment(await this.pc.createAnswer()));
      const description = this.pc.localDescription;
      if (!description || description.type !== 'answer') throw new Error('Answer creation failed');
      this.transmit({ type: 'answer', sdp: description.toJSON() });
    }
  }

  /** @param {PeerControl} message @returns {boolean} */
  sendControl(message) {
    if (message.type === 'interaction') {
      if (this.closed || this.leaving || this.interactionControl.readyState !== 'open' || this.interactionControl.bufferedAmount > 8192) return false;
      const payload = JSON.stringify(message);
      if (payload.length > 1024) throw new RangeError('Interaction exceeds limit');
      this.interactionControl.send(payload);
      return true;
    }
    if (message.type === 'poke' && (message.data.action === 'hit' || message.data.action === 'event')) {
      if (this.pokeControl.readyState !== 'open' || this.pokeControl.bufferedAmount > 8192) return false;
      this.pokeControl.send(JSON.stringify(message));
      return true;
    }
    if (this.control.readyState !== 'open') return false;
    this.control.send(JSON.stringify(message));
    if (message.type === 'leave') this.leaving = true;
    return true;
  }

  /** @param {MediaStreamTrack|null} track @returns {Promise<void>} */
  async setAccompanimentTrack(track) {
    this.accompanimentTrack = track;
    if (!this.accompaniment) return;
    await this.accompaniment.sender.replaceTrack(track);
    if (!track || this.pc.signalingState !== 'stable') return;
    const parameters = this.accompaniment.sender.getParameters();
    if (parameters.encodings.length) {
      parameters.encodings[0].maxBitrate = 128000;
      await this.accompaniment.sender.setParameters(parameters);
    }
  }

  /** @param {MediaStreamTrack|null} track @returns {Promise<void>} */
  async setScreenTrack(track) {
    if (!this.screen) {
      if (track) throw new DOMException('画面传输通道尚未协商完成', 'InvalidStateError');
      return;
    }
    await this.screen.sender.replaceTrack(track);
    if (!track || this.pc.signalingState !== 'stable') return;
    const parameters = this.screen.sender.getParameters();
    if (parameters.encodings.length) {
      parameters.encodings[0].maxBitrate = 2500000;
      parameters.encodings[0].maxFramerate = 30;
      await this.screen.sender.setParameters(parameters);
    }
  }

  /** @param {NetworkConfig} config @returns {void} */
  configure(config) {
    if (config.mediaPolicy !== this.config.mediaPolicy || config.networkMode !== this.config.networkMode) {
      throw new Error('服务器联网策略已变化，请离开通话后重新加入');
    }
    const changed = JSON.stringify(config.iceServers) !== JSON.stringify(this.config.iceServers);
    this.pc.setConfiguration({ iceServers: config.iceServers, iceTransportPolicy: config.iceTransportPolicy });
    this.config = config;
    if (changed) {
      this.restartPending = true;
      this.restartWhenReady();
    }
  }

  /** @returns {void} */
  restartWhenReady() {
    if (!this.restartPending || this.closed || this.leaving || this.pc.signalingState !== 'stable' || this.control.readyState !== 'open') return;
    this.restartPending = false;
    if (this.options.selfId < this.options.peerId) this.pc.restartIce();
    else this.sendControl({ type: 'restart' });
  }

  /** @returns {Promise<LinkStats>} */
  async stats() {
    const report = await this.pc.getStats();
    /** @type {import('./peer-stats.js').StatsEntry[]} */
    const entries = [];
    report.forEach(/** @param {import('./peer-stats.js').StatsEntry} entry */ (entry) => entries.push(entry));
    const next = summarizePeerStats(entries, this.previousStats);
    if (next.route === 'relay' && this.config.mediaPolicy === 'direct') {
      this.close();
      throw new Error('检测到不符合直连策略的中继路径，连接已停止');
    }
    this.previousStats = entries;
    this.lastStats = next;
    return this.lastStats;
  }

  /** Enforce the active ICE routes independently of UI statistics collection.
   * @returns {void} */
  enforceRoutePolicy() {
    if (this.closed || this.config.mediaPolicy !== 'direct') return;
    const transports = new Set([this.pc.sctp?.transport,...this.pc.getSenders().map(sender=>sender.transport),...this.pc.getReceivers().map(receiver=>receiver.transport)]);
    for (const transport of transports) {
      const pair = transport?.iceTransport.getSelectedCandidatePair();
      if (pair?.local.type === 'relay' || pair?.remote.type === 'relay') {
        this.close();
        throw new Error('检测到不符合直连策略的中继路径，连接已停止');
      }
    }
  }

  /** @returns {void} */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.interactionControl.onmessage = null;
    this.interactionControl.onopen = null;
    this.interactionControl.close();
    this.pokeControl.onmessage = null;
    this.pokeControl.close();
    this.control.close();
    this.pc.close();
  }
}
