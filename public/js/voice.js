// @ts-check
import { PeerLink } from './peer-link.js';
import { parseNetworkConfig } from './network-protocol.js';
import { MicrophoneCapture, capturePreferences } from './microphone-capture.js';
import { MicrophoneGraph } from './microphone-graph.js';
import { RemoteAudio } from './remote-audio.js';
import { ScreenRelay, screenRelayBridge } from './screen-relay.js';
import { ScreenSfu } from './screen-sfu.js';
import { getScreenPreferences } from './screen-preferences.js';
import { screenBudget } from './screen-plan.js';
import { createScreenPoke } from './screen-poke.js';
import { createInteractions } from './interactions.js';

/** @typedef {import('./microphone-capture.js').CapturePreferences & import('./screen-preferences.js').ScreenPreferenceSettings & {micVolume:number,outVolume:number,mode:'ptt'|'vad',vadThreshold:number,monitor:boolean,outputDeviceId:string}} VoiceSettings */
/** @typedef {{type:'speaking',userId:string,speaking:boolean}|{type:'peer-state',userId:string,state:RTCPeerConnectionState}|{type:'error',message:string}|{type:'monitor',enabled:boolean}|{type:'muted',muted:boolean}|{type:'deafened',deafened:boolean}|{type:'peer-mic-state',userId:string,muted:boolean,deafened:boolean}|{type:'peer-left'|'peer-removed'|'remote-audio',userId:string}|{type:'media',userId:string}|{type:'mic-ready'|'mic-stopped'|'left'|'poke-state'|'output-settings'|'interaction-state'}|{type:'poke-hit',hit:import('./screen-poke.js').PokeHit}|{type:'poke-clear',targetUserId:string}|{type:'interaction',event:import('./interaction-protocol.js').InteractionEvent}|{type:'interaction-clear',memberId:string|null}} VoiceEvent */
/** @typedef {{getSettings:()=>VoiceSettings,config:import('./network-protocol.js').NetworkConfig,sendSignal:(to:string,data:import('./network-protocol.js').PeerSignal)=>void,onEvent:(event:VoiceEvent)=>void,selfId:string,screenSfu?:{requestToken:(channelId:string,sourceUserId:string)=>Promise<import('./screen-sfu.js').ScreenSfuCredential>,releaseToken:(channelId:string,sourceUserId:string,identity:string)=>Promise<void>}}} VoiceOptions */
/** @typedef {{link:PeerLink,pc:RTCPeerConnection,remoteStream:MediaStream|null,playback:RemoteAudio|null,musicPlayback:RemoteAudio|null,screenStream:MediaStream|null,screenSharing:boolean,musicActive:boolean,watching:boolean,viewer:boolean,analyser:AnalyserNode|null,state:RTCPeerConnectionState,speaking:boolean,level:number}} VoicePeer */
/** @typedef {import('./peer-stats.js').LinkStats & {state:RTCPeerConnectionState,pcState:RTCPeerConnectionState,iceState:RTCIceConnectionState,speaking:boolean,level:number,hasAudio:boolean,screenSharing:boolean,accompaniment:boolean,watching:boolean,volume:number,controlState:RTCDataChannelState}} PeerInfo */
/** @typedef {AudioContext & {setSinkId?:(deviceId:string)=>Promise<void>}} OutputContext */


/* 语音引擎：麦克风处理链 + WebRTC mesh + 音量/说话检测 */

const VAD_HOLD_MS = 260;

/** @type {WeakMap<AnalyserNode,Float32Array<ArrayBuffer>>} */
const meterBuffers = new WeakMap();

/** @param {AnalyserNode|null} analyser @returns {number} */
function rms(analyser) {
  if (!analyser) return 0;
  let data = meterBuffers.get(analyser);
  if (!data || data.length !== analyser.fftSize) {
    data = new Float32Array(analyser.fftSize);
    meterBuffers.set(analyser, data);
  }
  analyser.getFloatTimeDomainData(data);
  let maximum = 0;
  // Keep the original 512-sample threshold sensitivity across the retained history.
  for (let offset = 0; offset < data.length; offset += 512) {
    let sum = 0;
    const end = Math.min(offset + 512, data.length);
    for (let index = offset; index < end; index += 1) {
      const value = data[index];
      sum += value * value;
    }
    maximum = Math.max(maximum, sum / (end - offset));
  }
  return Math.sqrt(maximum);
}

/** @param {number} level @returns {number} */
const toDb = (level) => 20 * Math.log10(level + 1e-7);

/** @param {import('./network-protocol.js').NetworkConfig} config @returns {import('./network-protocol.js').NetworkConfig} */
function validateVoiceConfig(config) {
  return parseNetworkConfig({
    ...config,
    iceServers: config.iceServers.map((server) => ({
      urls: server.urls, username: server.username ?? null, credential: server.credential ?? null,
    })),
  });
}

export class VoiceEngine {
  /** @param {VoiceOptions} options */
  constructor({ getSettings, config, sendSignal, onEvent, selfId, screenSfu }) {
    this.getSettings = getSettings;
    this.config = validateVoiceConfig(config);
    this.sendSignal = sendSignal;
    this.onEvent = onEvent || (() => {});
    this.selfId = selfId;
    /** @type {import('./screen-link.js').ScreenContentEncryption|null} */this.contentEncryption=null;
    this.contentEncryptionChanging=false;
    /** @type {Error|null} */this.contentEncryptionFailure=null;
    this.poke = createScreenPoke({ getSelfId: () => this.selfId, send: (id, data) => this.peers.get(id)?.link.sendControl({ type: 'poke', data }) === true, onState: () => this._emit({ type: 'poke-state' }), onHit: (hit) => this._emit({ type: 'poke-hit', hit }), onClear: (targetUserId) => this._emit({ type: 'poke-clear', targetUserId }), onError: (error) => this._emit({ type: 'error', message: error.message }) });

    /** @type {string|null} */ this.channelId = null;
    /** @type {Map<string,VoicePeer>} */ this.peers = new Map();
    this.interactions = createInteractions({
      getSelfId: () => this.selfId, getPeerIds: () => [...this.peers.keys()],
      send: (id, data) => this.peers.get(id)?.link.sendControl({ type: 'interaction', data }) === true,
      onEvent: (event) => this._emit({ type: 'interaction', event }),
      onState: () => this._emit({ type: 'interaction-state' }),
      onClear: (memberId) => this._emit({ type: 'interaction-clear', memberId }),
    });
    /** @type {OutputContext|null} */ this.ctx = null;
    /** @type {MicrophoneGraph|null} */ this.chain = null;
    /** @type {MediaStream|null} */ this.outStream = null;
    /** @type {MediaStreamTrack|null} */ this.outTrack = null;
    this.localLevel = 0;
    this.localDb = -100;
    this.presentationActive = true;
    this.localMeterActive = false;
    this.muted = false;
    this.serverMuted = false;
    /** @type {Set<string>} */ this.serverMutedPeers = new Set();
    this.deafened = false;
    this.pttDown = false;
    this.vadOpen = false;
    this.lastVoiceAt = 0;
    this.speakingSelf = false;
    this.monitorEnabled = false;
    /** @type {Map<string,number>} */ this.peerVolumes = new Map();
    /** @type {MediaStream|null} */ this.accompanimentStream = null;
    /** @type {MediaStream|null} */ this.screenStream = null;
    /** @type {import('./screen-preferences.js').ScreenPreferences|null} */ this.screenMediaPreferences = null;
    /** @type {ReturnType<typeof setInterval>|null} */ this._loop = null;
    /** @type {Promise<void>|null} */ this._micPromise = null;
    /** @type {boolean|null} */ this._gateOpen = null;
    this._micGeneration = 0;
    this.capture = new MicrophoneCapture((stream) => this._buildChain(stream));
    const onScreenStream = (/** @type {string} */ userId, /** @type {MediaStream|null} */ stream) => {
      const peer = this.peers.get(userId);
      if (peer) { peer.screenStream = stream; this._emit({ type: 'media', userId }); }
      if (userId === this.selfId && stream === null && this.screenTransport instanceof ScreenSfu && this.screenStream) {
        const capture = this.screenStream;
        this.screenStream = null;
        this.poke.end();
        for (const track of capture.getTracks()) track.stop();
        this._publishMediaState();
      }
    };
    const onScreenError = (/** @type {Error} */ error) => this._emit({ type: 'error', message: error.message });
    const onSourceEnded = (/** @type {string} */ userId) => {
      const peer = this.peers.get(userId);
      if (!peer) return;
      peer.screenSharing = false;
      peer.watching = false;
      peer.screenStream = null;
      this.poke.unwatch(userId);
      this._emit({ type: 'media', userId });
    };
    if (this.config.screen?.mode === 'sfu') {
      if (!screenSfu) throw new TypeError('SFU mode requires authenticated room token callbacks');
      this.screenTransport = new ScreenSfu({ selfId, ...screenSfu, getContentEncryption:()=>this.contentEncryption, getBitrateBps: () => this.screenBitrate(), getFrameRate: () => this.screenPreferences().screenFrameRate, getContentMode: () => this.screenPreferences().screenContentMode, onStream: onScreenStream, onSourceEnded, onError: onScreenError });
    } else {
      this.screenTransport = new ScreenRelay({ selfId, getContentEncryption:()=>this.contentEncryption, getNetwork: () => this.config, getPreferences: () => this.screenPreferences(), peerIds: () => [...this.peers.keys()], send: (id, data) => this.peers.get(id)?.link.sendControl({ type: 'screen', data }) === true, onStream: onScreenStream, onError: onScreenError });
    }
  }

  get rawStream() { return this.capture.stream; }

  /** Apply a verified room key before joining. Key changes terminate screen sessions.
   * @param {import('./screen-link.js').ScreenContentEncryption|null} value @returns {Promise<void>} */
  async setContentEncryption(value) {
    if(this.contentEncryptionChanging)throw new Error('Room screen encryption is already changing');
    if(value!==null&&(!(value.key instanceof Uint8Array)||value.key.byteLength!==32||typeof value.keyId!=='string'||!value.keyId||value.keyId.length>256))throw new TypeError('Room screen encryption requires a 32-byte key and bounded key identifier');
    const previous=this.contentEncryption;
    if(!this.contentEncryptionFailure&&previous===null&&value===null)return;
    if(!this.contentEncryptionFailure&&previous&&value&&previous.keyId===value.keyId&&previous.key.every((byte,index)=>byte===value.key[index]))return;
    const next=value?{key:new Uint8Array(value.key),keyId:value.keyId}:null;
    this.contentEncryptionChanging=true;
    try {
      const stopping=this.stopScreenShare();
      const leaving=this.screenTransport.leave();
      for(const [userId,peer] of this.peers){peer.watching=false;peer.screenStream=null;this.poke.unwatch(userId);this._emit({type:'media',userId});}
      await Promise.all([stopping,leaving]);
      previous?.key.fill(0);
      this.contentEncryption=next;
      if(this.channelId)await this.screenTransport.join(this.channelId);
      this.contentEncryptionFailure=null;
    } catch(error) {next?.key.fill(0);this.contentEncryptionFailure=error instanceof Error?error:new Error('Room screen encryption change failed');throw error;}
    finally {this.contentEncryptionChanging=false;}
  }

  get micReady() {
    return !!(this.rawStream?.active && this.chain && this.outTrack?.readyState === 'live');
  }

  get inVoice() {
    return !!this.channelId;
  }

  /** @param {string} selfId @returns {void} */
  updateIdentity(selfId) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(selfId)) throw new TypeError('Invalid voice member identity');
    if (this.inVoice && selfId !== this.selfId) throw new Error('当前通话身份不能在连接中途替换');
    this.selfId = selfId;
    if (this.screenTransport instanceof ScreenRelay) this.screenTransport.options = { ...this.screenTransport.options, selfId };
    else this.screenTransport.options = { ...this.screenTransport.options, selfId };
  }

  /* ------------------------------------------------------------------ */
  /* 麦克风                                                              */
  /* ------------------------------------------------------------------ */

  async ensureMic() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风采集（需要 HTTPS 或 localhost）');
    if (this._micPromise) return this._micPromise;
    const generation = this._micGeneration;
    const task = this._openMic(generation).finally(() => {
      if (this._micPromise === task) this._micPromise = null;
    });
    this._micPromise = task;
    return task;
  }

  /** @param {number} generation @returns {Promise<void>} */
  async _openMic(generation) {
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    await this._routeMonitor();
    if (generation !== this._micGeneration) throw new DOMException('麦克风操作已取消', 'AbortError');
    await this.capture.open(capturePreferences(this.getSettings()));
    if (generation !== this._micGeneration) throw new DOMException('麦克风操作已取消', 'AbortError');
    this._startLoop();
    this._emit({ type: 'mic-ready' });
  }

  _disposeChain() {
    if (this.chain) this.chain.dispose();
    this.chain = null;
  }

  /** @param {MediaStream} stream @returns {void} */
  _buildChain(stream) {
    if (!this.ctx) throw new DOMException('音频处理上下文尚未启动', 'InvalidStateError');
    if (this.chain) {
      this.chain.replaceSource(stream);
      return;
    }
    this.chain = new MicrophoneGraph(this.ctx, stream, this._micGainValue(), this._monitorGainValue());
    this.outStream = this.chain.dest.stream;
    this.outTrack = this.outStream.getAudioTracks()[0];
    this.localLevel = 0;
    this.vadOpen = false;
    this._gateOpen = null;
    this._tick();
  }

  _micGainValue() {
    const s = this.getSettings();
    const v = typeof s.micVolume === 'number' ? s.micVolume : 100;
    return Math.max(0, Math.min(200, v)) / 100;
  }

  /** @returns {number} */
  _monitorGainValue() {
    const enabled = this.monitorEnabled || this.getSettings().monitor === true;
    return enabled && !this.deafened ? 1 : 0;
  }

  _applyMonitorGain() {
    if (!this.chain || !this.ctx) return;
    this.chain.monitor.gain.setTargetAtTime(this._monitorGainValue(), this.ctx.currentTime, 0.01);
  }

  /** @returns {Promise<void>} */
  async _routeMonitor() {
    if (!this.ctx) return;
    const device = this.getSettings().outputDeviceId;
    if (typeof this.ctx.setSinkId !== 'function') {
      if (device !== 'default') throw new DOMException('当前音频引擎无法选择监听输出设备', 'NotSupportedError');
      return;
    }
    await this.ctx.setSinkId(device === 'default' ? '' : device);
  }

  /** @param {boolean} enabled @returns {Promise<void>} */
  async setMonitor(enabled) {
    if (enabled) await this.ensureMic();
    this.monitorEnabled = enabled;
    this._applyMonitorGain();
    this._emit({ type: 'monitor', enabled });
  }

  stopMic() {
    this._micGeneration += 1;
    this._micPromise = null;
    this.capture.stop();
    this._stopLoop();
    this._disposeChain();
    this.outStream = null;
    this.outTrack = null;
    this.localLevel = 0;
    this.localDb = -100;
    this.vadOpen = false;
    this._gateOpen = null;
    this.speakingSelf = false;
    this._emit({ type: 'mic-stopped' });
  }

  /** @returns {Promise<void>} */
  async restartMic() {
    if (this.micReady || this._micPromise || this.capture.pending) {
      if (this.capture.pending || this.micReady) await this.capture.open(capturePreferences(this.getSettings()));
      else await this._micPromise;
      this._emit({ type: 'mic-ready' });
    }
  }

  getCaptureInfo() {
    return { ...this.capture.info(), outputTrackId: this.outTrack?.id ?? null, contextSampleRate: this.ctx?.sampleRate ?? null, baseLatencyMs: this.ctx ? this.ctx.baseLatency * 1000 : null };
  }

  /* ------------------------------------------------------------------ */
  /* 音量 / 说话检测                                                     */
  /* ------------------------------------------------------------------ */

  _startLoop() {
    this._stopLoop();
    this._loop = setInterval(() => this._tick(), 32);
  }

  _stopLoop() {
    if (this._loop) clearInterval(this._loop);
    this._loop = null;
  }

  _tick() {
    const s = this.getSettings();
    const analyser = this.chain && this.chain.analyser;
    if (analyser) {
      const blocked = this.muted || this.serverMuted || this.deafened;
      const analyse = this.localMeterActive || (s.mode !== 'ptt' && !blocked);
      const level = analyse ? rms(analyser) : 0;
      this.localLevel = level;
      this.localDb = toDb(level);

      const now = performance.now();
      const mode = s.mode === 'ptt' ? 'ptt' : 'vad';
      let target;
      if (blocked) {
        this.vadOpen = false;
        target = false;
      } else if (mode === 'ptt') {
        target = this.pttDown;
      } else {
        const thr = Number.isFinite(s.vadThreshold) ? s.vadThreshold : -42;
        if (!this.vadOpen) {
          if (this.localDb > thr) {
            this.vadOpen = true;
            this.lastVoiceAt = now;
          }
        } else if (this.localDb > thr - 6) {
          this.lastVoiceAt = now;
        }
        if (this.vadOpen && now - this.lastVoiceAt > VAD_HOLD_MS) this.vadOpen = false;
        target = this.vadOpen;
      }
      const open = target && !this.muted && !this.serverMuted && !this.deafened;
      this._setGate(open);
    }

    if (!this.presentationActive) return;
    // Remote metering serves visible presentation consumers only.
    for (const [userId, peer] of this.peers) {
      if (!peer.analyser) continue;
      const level = rms(peer.analyser);
      const db = toDb(level);
      const speaking = db > -48;
      peer.level = level;
      if (speaking !== peer.speaking) {
        peer.speaking = speaking;
        this._emit({ type: 'speaking', userId, speaking });
      }
    }
  }

  /** @param {boolean} active @returns {void} */
  setPresentationActive(active) {
    if (this.presentationActive === active) return;
    this.presentationActive = active;
    if (active) this._tick();
  }

  /** @param {boolean} active @returns {void} */
  setLocalMeterActive(active) {
    if (this.localMeterActive === active) return;
    this.localMeterActive = active;
    this._tick();
  }

  /** @returns {void} */
  enforceLinkPolicies() {
    for (const peer of this.peers.values()) {
      try { peer.link.enforceRoutePolicy(); }
      catch (error) { this._emit({type:'error',message:error instanceof Error?error.message:String(error)}); }
    }
  }

  /** @param {boolean} open @returns {void} */
  _setGate(open) {
    if (!this.chain || !this.ctx) return;
    if (this._gateOpen === open) return;
    this._gateOpen = open;
    const g = this.chain.gate.gain;
    const t = this.ctx.currentTime;
    g.cancelAndHoldAtTime(t);
    g.linearRampToValueAtTime(open ? 1 : 0, t + (open ? 0.003 : 0.005));
    if (this.speakingSelf !== open) {
      this.speakingSelf = open;
      this._emit({ type: 'speaking', userId: this.selfId, speaking: open });
    }
  }

  /* ------------------------------------------------------------------ */
  /* 加入 / 离开语音频道                                                 */
  /* ------------------------------------------------------------------ */

  /** @param {string} channelId @returns {void} */
  join(channelId) {
    if(this.contentEncryptionFailure)throw this.contentEncryptionFailure;
    if(this.contentEncryptionChanging)throw new Error('Wait for room screen encryption before joining');
    if (!this.micReady) throw new Error('麦克风尚未准备好，不能确认加入语音');
    if (this.channelId && this.channelId !== channelId) {
      this._releaseLocalMedia();
      this._teardownPeers();
      this._emit({ type: 'media', userId: this.selfId });
    }
    this.channelId = channelId;
    this.interactions.join(channelId);
    Promise.resolve(this.screenTransport.join(channelId)).catch((error) => this._emit({ type: 'error', message: error.message }));
    this.vadOpen = false;
    this._gateOpen = null;
  }

  leave() {
    Promise.resolve(this.screenTransport.leave()).catch((error) => this._emit({ type: 'error', message: error.message }));
    for (const peer of this.peers.values()) peer.link.sendControl({ type: 'leave' });
    this.channelId = null;
    this.interactions.leave();
    this._releaseLocalMedia();
    this._teardownPeers();
    this.stopMic();
    this._emit({ type: 'left' });
  }

  /** @param {Array<{id:string}>} peers @returns {Promise<void>} */
  async handlePeers(peers) {
    for (const peer of peers) {
      if (peer.id === this.selfId) continue;
      const existing = this.peers.get(peer.id);
      if (existing && (existing.pc.connectionState === 'failed' || existing.pc.connectionState === 'closed')) this.removePeer(peer.id);
      this._ensurePeer(peer.id);
    }
  }

  /** @param {string} userId @returns {void} */
  connectPeer(userId) {
    this._ensurePeer(userId);
  }

  /** @param {import('./network-protocol.js').NetworkConfig} config @returns {void} */
  updateNetwork(config) {
    const next = validateVoiceConfig(config);
    if ((next.screen?.mode || 'peer-relay') !== (this.config.screen?.mode || 'peer-relay') || (next.screen?.mode === 'sfu' && this.config.screen?.mode === 'sfu' && next.screen.url !== this.config.screen.url)) throw new Error('屏幕传输策略已变化，请重新打开房间');
    const changedIce = JSON.stringify(next.iceServers) !== JSON.stringify(this.config.iceServers);
    for (const peer of this.peers.values()) peer.link.configure(next);
    this.config = next;
    if (changedIce && this.screenTransport instanceof ScreenRelay) this.screenTransport.refreshNetwork();
  }

  async measureLinks() {
    for (const [userId, peer] of this.peers) {
      try {
        await peer.link.stats();
      } catch (error) {
        if (this.peers.get(userId) === peer) this._emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    }
    return this.getPeerInfo();
  }

  /** @param {string} userId @returns {VoicePeer} */
  _ensurePeer(userId) {
    const existing = this.peers.get(userId);
    if (existing) return existing;
    if (!this.channelId) throw new Error('Cannot connect audio outside a joined channel');
    const link = new PeerLink({
      selfId: this.selfId, peerId: userId, config: this.config,
      track: this.outTrack, stream: this.outStream,
      sendSignal: (data) => this.sendSignal(userId, data),
      onTrack: (stream, kind) => this._attachMedia(userId, stream, kind),
      onState: (status) => this._setPeerState(peer, userId, status),
      onReady: () => {
        link.sendControl({ type: 'state', muted: this.muted, deafened: this.deafened });
        link.sendControl(this._mediaState());
        this._emit({ type: 'interaction-state' });
        if (this.accompanimentStream) link.setAccompanimentTrack(this.accompanimentStream.getAudioTracks()[0]).catch((error) => this._emit({ type: 'error', message: error.message }));
        if (this.screenTransport instanceof ScreenRelay) this.screenTransport.peerReady(userId);
      },
      onControl: (message) => {
        if (message.type === 'leave') {
          this.removePeer(userId);
          this._emit({ type: 'peer-left', userId });
        } else if (message.type === 'media') {
          peer.screenSharing = message.screen;
          peer.musicActive = message.accompaniment;
          this.poke.advertise(userId, message.poke ?? null);
          this.interactions.advertise(userId, message.interaction ?? null);
          if (message.screen && peer.watching) this.poke.watch(userId);
          if (!message.screen) {
            const watching = peer.watching;
            peer.watching = false;
            if (watching && this.screenTransport instanceof ScreenSfu) this.screenTransport.unwatch(userId).catch((error) => this._emit({ type: 'error', message: error.message }));
          }
          this._emit({ type: 'media', userId });
        } else if (message.type === 'watch') {
          this._emit({ type: 'error', message: '对方使用旧版屏幕协议，请双方更新客户端' });
        } else if (message.type === 'poke') {
          this.poke.receive(userId, message.data);
        } else if (message.type === 'interaction') {
          this.interactions.receive(userId, message.data);
        } else if (message.type === 'screen') {
          if (this.screenTransport instanceof ScreenRelay) this.screenTransport.receive(userId, message.data).catch((error) => this._emit({ type: 'error', message: error.message }));
        } else if (message.type === 'state') {
          this._emit({ type: 'peer-mic-state', userId, muted: message.muted, deafened: message.deafened });
        }
      },
      onError: (error) => this._emit({ type: 'error', message: error.message }),
    });
    /** @type {VoicePeer} */
    const peer = {
      link, pc: link.pc, remoteStream: null, playback: null, musicPlayback: null,
      screenStream: null, screenSharing: false, musicActive: false, watching: false, viewer: false,
      analyser: null, state: 'new', speaking: false, level: 0,
    };
    this.peers.set(userId, peer);
    this.refreshScreenBudget();
    return peer;
  }

  /** @param {VoicePeer} peer @param {string} userId @param {RTCPeerConnectionState} state @returns {void} */
  _setPeerState(peer, userId, state) {
    if (peer.state === state) return;
    peer.state = state;
    if (state === 'failed' || state === 'closed') { this.poke.remove(userId); this.interactions.remove(userId); }
    if (state === 'connected') peer.link.sendControl(this._mediaState());
    this._emit({ type: 'peer-state', userId, state });
  }

  /** @param {string} userId @param {MediaStream} stream @param {import('./peer-link.js').MediaKind} kind @returns {void} */
  _attachMedia(userId, stream, kind) {
    const peer = this.peers.get(userId);
    if (!peer || !this.ctx) return;
    if (kind === 'screen') {
      peer.screenStream = stream;
      this._emit({ type: 'media', userId });
      return;
    }
    const playback = new RemoteAudio(this.ctx, stream, this._peerGain(userId), (error) => this._emit({ type: 'error', message: `成员音频播放失败：${error.message}` }));
    if (kind === 'accompaniment') {
      peer.musicPlayback?.dispose();
      peer.musicPlayback = playback;
    } else {
      peer.playback?.dispose();
      peer.playback = playback;
      peer.remoteStream = stream;
      peer.analyser = playback.analyser;
    }
    this._emit({ type: 'remote-audio', userId });
  }

  /** @param {VoicePeer} peer @returns {void} */
  _detachRemote(peer) {
    peer.playback?.dispose();
    peer.musicPlayback?.dispose();
    peer.playback = null;
    peer.musicPlayback = null;
    peer.analyser = null;
    peer.remoteStream = null;
    peer.screenStream = null;
  }

  /** @param {string} userId @returns {number} */
  _peerGain(userId) {
    return this.deafened || this.serverMutedPeers.has(userId) ? 0 : this.getPeerVolume(userId) / 100 * this.getSettings().outVolume / 100;
  }

  /** @param {string} userId @returns {number} */
  getPeerVolume(userId) { return this.peerVolumes.get(userId) ?? 100; }

  /** @param {string} userId @param {number} value @returns {void} */
  setPeerVolume(userId, value) {
    if (!Number.isFinite(value) || value < 0 || value > 200) throw new RangeError('成员音量必须为 0～200%');
    if (this.getPeerVolume(userId) === value) return;
    this.peerVolumes.set(userId, value);
    const peer = this.peers.get(userId);
    peer?.playback?.setVolume(this._peerGain(userId));
    peer?.musicPlayback?.setVolume(this._peerGain(userId));
    this._emit({ type: 'output-settings' });
  }

  /** @returns {void} */
  _refreshOutputVolumes() {
    for (const [id, peer] of this.peers) {
      peer.playback?.setVolume(this._peerGain(id));
      peer.musicPlayback?.setVolume(this._peerGain(id));
    }
    this._emit({ type: 'output-settings' });
  }

  /** @returns {Extract<import('./network-protocol.js').PeerControl,{type:'media'}>} */
  _mediaState() { return { type: 'media', screen: this.screenStream !== null, accompaniment: this.accompanimentStream !== null, poke: this.poke.advertisement(), interaction: this.interactions.advertisement() }; }

  /** @returns {void} */
  _publishMediaState() {
    for (const peer of this.peers.values()) peer.link.sendControl(this._mediaState());
    this._emit({ type: 'media', userId: this.selfId });
  }

  /** @param {MediaStream} stream @returns {Promise<void>} */
  async startAccompaniment(stream) {
    if (!this.inVoice) throw new Error('请先加入语音频道再播放伴奏');
    if (this.accompanimentStream) throw new Error('当前伴奏尚未停止');
    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState !== 'live') throw new TypeError('伴奏来源没有有效音频');
    track.enabled=!this.serverMuted;
    this.accompanimentStream = stream;
    try { await Promise.all([...this.peers.values()].map((peer) => peer.link.setAccompanimentTrack(track))); }
    catch (error) { await this.stopAccompaniment(); throw error; }
    this._publishMediaState();
    track.addEventListener('ended', () => { if (this.accompanimentStream === stream) this.stopAccompaniment().catch((error) => this._emit({ type: 'error', message: error.message })); }, { once: true });
  }

  /** @returns {Promise<void>} */
  async stopAccompaniment() {
    const stream = this.accompanimentStream;
    this.accompanimentStream = null;
    if (stream) for (const track of stream.getTracks()) track.stop();
    await Promise.all([...this.peers.values()].map((peer) => peer.link.setAccompanimentTrack(null)));
    this._publishMediaState();
  }

  /** @param {MediaStream} stream @returns {Promise<void>} */
  async startScreenShare(stream) {
    if(this.contentEncryptionFailure)throw this.contentEncryptionFailure;
    if(this.contentEncryptionChanging)throw new Error('Wait for room screen encryption before sharing');
    if (!this.inVoice) throw new Error('请先加入语音频道再分享屏幕');
    if (this.screenStream) throw new Error('当前屏幕分享尚未停止');
    const track = stream.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') throw new TypeError('分享来源没有有效画面');
    const channelId = this.channelId;
    this.screenMediaPreferences = getScreenPreferences(this.getSettings(), screenRelayBridge() !== null);
    this.screenStream = stream;
    try {
      await this.screenTransport.publish(stream);
      if (this.screenStream !== stream || this.channelId !== channelId || !this.inVoice || track.readyState !== 'live') throw new DOMException('屏幕分享已取消', 'AbortError');
    } catch (error) { if (this.screenStream === stream) this.screenStream = null; for (const item of stream.getTracks()) item.stop(); throw error; }
    this.poke.start();
    this._publishMediaState();
    track.addEventListener('ended', () => { if (this.screenStream === stream) this.stopScreenShare().catch((error) => this._emit({ type: 'error', message: error.message })); }, { once: true });
  }

  /** @returns {Promise<void>} */
  async stopScreenShare() {
    this.poke.end();
    const stream = this.screenStream;
    this.screenStream = null;
    if (stream) for (const track of stream.getTracks()) track.stop();
    this._publishMediaState();
    await this.screenTransport.unpublish();
  }

  /** @param {string} userId @returns {Promise<void>} */
  async watchScreen(userId) {
    if(this.contentEncryptionFailure)throw this.contentEncryptionFailure;
    if(this.contentEncryptionChanging)throw new Error('Wait for room screen encryption before watching');
    const peer = this.peers.get(userId);
    if (!peer || !peer.screenSharing) throw new Error('该用户已经停止分享');
    const channelId = this.channelId;
    const sessionId = this.poke.state().peers.find(item => item.userId === userId)?.sessionId;
    peer.watching = true;
    try { await this.screenTransport.watch(userId); }
    catch (error) { peer.watching = false; throw error; }
    if (this.peers.get(userId) !== peer || !peer.watching || !peer.screenSharing || this.channelId !== channelId || this.poke.state().peers.find(item => item.userId === userId)?.sessionId !== sessionId) {
      throw new DOMException('共享画面或观看状态已改变，请重新观看', 'AbortError');
    }
    this.poke.watch(userId);
    this._emit({ type: 'media', userId });
  }

  /** @param {string} userId @returns {void} */
  stopWatching(userId) {
    const peer = this.peers.get(userId);
    if (!peer || !peer.watching) return;
    peer.watching = false;
    this.poke.unwatch(userId);
    this.screenTransport.unwatch(userId).catch((error) => this._emit({ type: 'error', message: error.message }));
    this._emit({ type: 'media', userId });
  }

  /** @param {string} userId @returns {MediaStream|null} */
  getScreenStream(userId) {
    if (userId === this.selfId) return this.screenStream;
    const peer = this.peers.get(userId);
    return peer?.watching && peer.screenSharing ? peer.screenStream : null;
  }

  /** @returns {void} */
  _releaseLocalMedia() {
    this.poke.end();
    for (const stream of [this.accompanimentStream, this.screenStream]) if (stream) for (const track of stream.getTracks()) track.stop();
    this.accompanimentStream = null;
    this.screenStream = null;
  }

  /** @param {string} userId @returns {void} */
  removePeer(userId) {
    const peer = this.peers.get(userId);
    if (!peer) return;
    this.poke.remove(userId);
    this.interactions.remove(userId);
    if (this.screenTransport instanceof ScreenRelay) this.screenTransport.peerRemoved(userId);
    else if (peer.watching) this.screenTransport.unwatch(userId).catch((error) => this._emit({ type: 'error', message: error.message }));
    this._detachRemote(peer);
    try {
      peer.link.close();
    } catch (_) {
      /* ignore */
    }
    this.peers.delete(userId);
    this.refreshScreenBudget();
    this._emit({ type: 'peer-removed', userId });
  }

  /** @returns {Promise<void>} */
  async updateScreenPreferences() {
    getScreenPreferences(this.getSettings(), screenRelayBridge() !== null);
    await this.screenTransport.updatePreferences();
  }

  /** Keep capture geometry and content policy fixed until a new share, while applying capacity and bitrate live.
   * @returns {import('./screen-preferences.js').ScreenPreferences} */
  screenPreferences() {
    const configured = getScreenPreferences(this.getSettings(), screenRelayBridge() !== null);
    const active = this.screenStream ? this.screenMediaPreferences : null;
    return active ? { ...configured, screenResolution: active.screenResolution, screenFrameRate: active.screenFrameRate, screenContentMode: active.screenContentMode } : configured;
  }

  /** @returns {number} */
  screenBitrate() {
    const preferences = getScreenPreferences(this.getSettings(), screenRelayBridge() !== null);
    const budget = screenBudget(preferences.uploadLimitMbps * 1000000, this.peers.size);
    const bitrate = Math.min(Math.floor(preferences.screenBitrateMbps * 1000000), Math.floor(budget / 1.2));
    if (bitrate < 300000) throw new RangeError('预留语音带宽后，当前上传额度不足以分享屏幕');
    return bitrate;
  }

  /** @returns {void} */
  refreshScreenBudget() {
    if (!(this.screenTransport instanceof ScreenSfu) || !this.screenStream) return;
    this.screenTransport.updatePreferences().catch(async (error) => {
      this._emit({ type: 'error', message: error instanceof Error ? error.message : '屏幕上传预算更新失败' });
      await this.stopScreenShare();
    }).catch((error) => this._emit({ type: 'error', message: error.message }));
  }

  /** @returns {void} */
  disconnectScreenRoom() {
    if (!(this.screenTransport instanceof ScreenSfu)) return;
    this.poke.end();
    for (const userId of this.peers.keys()) this.poke.unwatch(userId);
    const stream = this.screenStream;
    this.screenStream = null;
    if (stream) for (const track of stream.getTracks()) track.stop();
    for (const peer of this.peers.values()) { peer.watching = false; peer.screenStream = null; }
    this.screenTransport.leave().catch((error) => this._emit({ type: 'error', message: error.message }));
    this._publishMediaState();
  }

  getScreenStats() {
    return this.screenTransport instanceof ScreenRelay ? this.screenTransport.snapshot() : { mode: 'sfu', watching: [...this.peers.entries()].filter(([, peer]) => peer.watching).map(([id]) => id) };
  }

  _teardownPeers() {
    for (const userId of [...this.peers.keys()]) this.removePeer(userId);
  }

  /** @param {string} from @param {import('./network-protocol.js').PeerSignal} data @returns {Promise<void>} */
  async handleSignal(from, data) {
    await this._ensurePeer(from).link.receive(data);
  }

  publishMicState() {
    for (const peer of this.peers.values()) {
      peer.link.sendControl({ type: 'state', muted: this.muted, deafened: this.deafened });
    }
  }

  /* ------------------------------------------------------------------ */
  /* 状态                                                               */
  /* ------------------------------------------------------------------ */

  /** @param {boolean} muted @returns {void} */
  setMuted(muted) {
    if (this.muted === muted) return;
    this.muted = muted;
    this._tick();
    this.publishMicState();
    this._emit({ type: 'muted', muted });
  }

  /** @param {boolean} muted @returns {void} */
  setServerMuted(muted) {
    this.serverMuted=muted;
    for(const track of this.accompanimentStream?.getAudioTracks() ?? [])track.enabled=!muted;
    this._tick();
  }

  /** @param {string} userId @param {boolean} muted @returns {void} */
  setPeerServerMuted(userId,muted) {
    if(muted)this.serverMutedPeers.add(userId);else this.serverMutedPeers.delete(userId);
    const peer=this.peers.get(userId);
    peer?.playback?.setVolume(this._peerGain(userId));
    peer?.musicPlayback?.setVolume(this._peerGain(userId));
  }

  /** @param {boolean} deafened @returns {void} */
  setDeafened(deafened) {
    if (this.deafened === deafened) return;
    this.deafened = deafened;
    this._tick();
    this._refreshOutputVolumes();
    this._applyMonitorGain();
    this.publishMicState();
    this._emit({ type: 'deafened', deafened });
  }

  /** @param {boolean} down @returns {void} */
  setPTTDown(down) {
    this.pttDown = !!down;
    this._tick();
    if (this.pttDown && !this.micReady) this.ensureMic().catch((error) => this._emit({ type: 'error', message: error.message }));
  }

  /** @param {Partial<VoiceSettings>} patch @returns {Promise<void>} */
  async applySettings(patch) {
    const s = this.getSettings();
    if (this.chain && this.ctx) {
      const target = this._micGainValue();
      this.chain.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
    }
    if (patch && ('outVolume' in patch || 'outputDeviceId' in patch)) {
      if ('outputDeviceId' in patch) await this._routeMonitor();
      this._refreshOutputVolumes();
    }
    if (patch && ('mode' in patch)) {
      this.vadOpen = false;
      this._gateOpen = null;
    }
    if (patch && 'monitor' in patch) {
      await this.setMonitor(!!patch.monitor);
    }
    const needRestart =
      patch &&
      ('inputDeviceId' in patch ||
        'echoCancellation' in patch ||
        'noiseSuppression' in patch ||
        'autoGainControl' in patch);
    if (needRestart) await this.restartMic();
    this._tick();
  }

  getLocalLevel() {
    return this.localLevel;
  }

  /** @returns {Record<string,PeerInfo>} */
  getPeerInfo() {
    /** @type {Record<string,PeerInfo>} */
    const out = {};
    for (const [userId, peer] of this.peers) {
      out[userId] = {
        state: peer.state,
        pcState: peer.pc.connectionState,
        iceState: peer.pc.iceConnectionState,
        speaking: peer.speaking,
        level: peer.level,
        hasAudio: !!peer.playback,
        screenSharing: peer.screenSharing,
        accompaniment: peer.musicActive,
        watching: peer.watching,
        volume: this.getPeerVolume(userId),
        ...peer.link.lastStats,
        controlState: peer.link.control.readyState,
      };
    }
    return out;
  }

  destroy() {
    this.leave();
    this.stopMic();
    if (this.ctx) {
      try {
        this.ctx.close();
      } catch (_) {
        /* ignore */
      }
      this.ctx = null;
    }
  }

  /** @param {VoiceEvent} ev @returns {void} */
  _emit(ev) {
    try {
      this.onEvent(ev);
    } catch (err) {
      console.error('[voice] 事件回调异常', err);
    }
  }
}
