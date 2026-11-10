// @ts-check
import { screenIce, validateScreenIceDescription } from './screen-ice.js';
import { MAX_SCREEN_BITRATE_BPS, screenEncodingPolicy } from './screen-preferences.js';

/** @typedef {{iceServers:RTCIceServer[],iceTransportPolicy:RTCIceTransportPolicy}} ScreenNetwork */
/** @typedef {import('./screen-ice.js').ScreenIceCandidate} ScreenIceCandidate */
/** @typedef {{key:Uint8Array,keyId:string}} ScreenContentEncryption */
/** @typedef {Awaited<ReturnType<typeof import('./screen-encryption.js').createScreenEncryption>>} ScreenEncryption */
/** @typedef {{network:ScreenNetwork,contentEncryption?:ScreenContentEncryption|null,onStream:(stream:MediaStream)=>void,onIce:(candidate:ScreenIceCandidate)=>void,onFault:(error:Error)=>void}} ScreenLinkOptions */
/** @typedef {{sentBytes:number,receivedBytes:number,framesDecoded:number,framesEncoded:number,lost:number,receivedPackets:number,nacks:number,rttMs:number|null,availableBps:number|null,timestamp:number}} ScreenLinkStats */

/** One video-only WebRTC connection; voice and accompaniment remain independent. */
export class ScreenLink {
  /** @param {ScreenLinkOptions} options */
  constructor(options) {
    this.pc = new RTCPeerConnection(options.contentEncryption ? { ...options.network, ...{encodedInsertableStreams:true} } : options.network);
    /** @type {Promise<ScreenEncryption>|null} */ this.encryption = null;
    /** @type {ScreenEncryption|null} */ this.activeEncryption = null;
    this.closed = false;
    this.started = performance.now();
    this.lastProgress = this.started;
    this.lastCounter = 0;
    this.failed = false;
    this.options = options;
    this.iceReleased = false;
    this.localCandidateCount = 0;
    this.remoteCandidateCount = 0;
    /** @type {ScreenIceCandidate[]} */ this.localIce = [];
    /** @type {ScreenIceCandidate[]} */ this.remoteIce = [];
    /** @type {Promise<void>} */ this.remoteIceTail = Promise.resolve();
    /** @type {string[]} */ this.discoveryErrors = [];
    /** @type {ScreenLinkStats|null} */ this.previous = null;
    this.pc.onicecandidate = (event) => {
      if (this.closed) return;
      try {
        if (++this.localCandidateCount > 128) throw new RangeError('Screen local ICE candidate limit exceeded');
        const candidate = screenIce(event.candidate);
        if (this.iceReleased) options.onIce(candidate); else this.localIce.push(candidate);
      } catch (error) { this.fault(error instanceof Error ? error : new TypeError('Screen ICE transmission failed')); }
    };
    this.pc.onicecandidateerror = (event) => {
      if (this.closed) return;
      const error = `地址发现返回 ${event.errorCode}: ${event.errorText}`;
      if (this.discoveryErrors.length < 8) this.discoveryErrors.push(error);
      console.warn('screen_ice_discovery_error', { code: event.errorCode, message: event.errorText, gathering: this.pc.iceGatheringState });
    };
    this.pc.ontrack = (event) => {
      if (event.track.kind !== 'video') { this.fault(new TypeError('Screen connection returned a non-video track')); return; }
      options.onStream(new MediaStream([event.track]));
    };
    this.pc.onconnectionstatechange = () => {
      if (!this.closed && this.pc.connectionState === 'failed') this.fault(new Error(`屏幕连接失败：ICE=${this.pc.iceConnectionState}，地址收集=${this.pc.iceGatheringState}，候选消息=${this.localCandidateCount}/${this.remoteCandidateCount}`));
    };
  }

  /** @param {Error} error @returns {void} */
  fault(error) {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.options.onFault(error);
    if (this.options.contentEncryption) this.close();
  }

  /** @returns {Promise<ScreenEncryption|null>} */
  async requireEncryption() {
    const content = this.options.contentEncryption;
    if (!content) return null;
    if (!this.encryption) this.encryption = import('./screen-encryption.js').then(({createScreenEncryption}) => createScreenEncryption({...content,identity:crypto.randomUUID(),onError:error=>this.fault(error)})).then(controller=>{
      if (this.closed) {controller.destroy();throw new DOMException('Screen encryption cancelled','AbortError');}
      this.activeEncryption=controller;return controller;
    });
    return this.encryption;
  }

  /** @returns {Promise<void>} */
  async bindReceiverEncryption() {
    const encryption=await this.requireEncryption();
    if (!encryption) return;
    if (this.pc.getTransceivers().length!==1) throw new TypeError('Encrypted screen requires exactly one video transceiver');
    await encryption.bindReceiver(this.pc.getTransceivers()[0].receiver,'screen-receiver');
  }

  /** @returns {void} */
  preferVP8() {
    const capabilities = RTCRtpSender.getCapabilities('video');
    if (!capabilities) throw new DOMException('VP8 screen encoding is unavailable', 'NotSupportedError');
    const codecs = capabilities.codecs.filter((codec) => /video\/(vp8|rtx|red|ulpfec)$/i.test(codec.mimeType));
    if (!codecs.some((codec) => codec.mimeType.toLowerCase() === 'video/vp8')) throw new DOMException('VP8 screen encoding is unavailable', 'NotSupportedError');
    for (const transceiver of this.pc.getTransceivers()) transceiver.setCodecPreferences(codecs);
  }

  /** @param {MediaStream} stream @param {number} bitrateBps @param {number} frameRate @param {import('./screen-preferences.js').ScreenContentMode} contentMode @returns {Promise<string>} */
  async sendOffer(stream, bitrateBps, frameRate, contentMode) {
    if (!Number.isFinite(bitrateBps) || bitrateBps < 300000 || bitrateBps > MAX_SCREEN_BITRATE_BPS || ![15, 24, 30, 60].includes(frameRate)) throw new RangeError('Invalid explicit screen encoding limits');
    const policy = screenEncodingPolicy(contentMode);
    const track = stream.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') throw new DOMException('屏幕采集已经结束', 'InvalidStateError');
    track.contentHint = policy.contentHint;
    const transceiver=this.pc.addTransceiver(track, { direction: 'sendonly', streams: [stream], sendEncodings: [{ maxBitrate: bitrateBps, maxFramerate: frameRate }] });
    this.preferVP8();
    await transceiver.sender.setParameters({ ...transceiver.sender.getParameters(), degradationPreference: policy.degradationPreference });
    const encryption=await this.requireEncryption();
    if (encryption) await encryption.bindSender(transceiver.sender,'screen-sender');
    await this.pc.setLocalDescription(await this.pc.createOffer());
    return this.localDescription();
  }

  /** @returns {Promise<string>} */
  async receiveOffer() {
    await this.requireEncryption();
    this.pc.addTransceiver('video', { direction: 'recvonly' });
    this.preferVP8();
    await this.pc.setLocalDescription(await this.pc.createOffer());
    return this.localDescription();
  }

  /** @param {string} sdp @returns {Promise<string>} */
  async answer(sdp) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.flushRemoteIce();
    if (this.pc.getTransceivers().length !== 1) throw new TypeError('Screen offer has an unexpected transceiver count');
    this.pc.getTransceivers()[0].direction = 'recvonly';
    this.preferVP8();
    await this.bindReceiverEncryption();
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    return this.localDescription();
  }

  /** @param {string} sdp @returns {Promise<void>} */
  async acceptAnswer(sdp) {
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
    if (this.pc.getTransceivers()[0]?.direction==='recvonly') await this.bindReceiverEncryption();
    await this.flushRemoteIce();
  }

  /** @returns {void} */
  releaseIce() {
    if (this.closed) return;
    this.iceReleased = true;
    for (const candidate of this.localIce.splice(0)) this.options.onIce(candidate);
  }

  /** @param {ScreenIceCandidate} candidate @returns {Promise<void>} */
  async addIce(candidate) {
    if (this.closed) return;
    if (++this.remoteCandidateCount > 128) throw new RangeError('Screen remote ICE candidate limit exceeded');
    this.remoteIce.push(candidate);
    await this.flushRemoteIce();
  }

  /** @returns {Promise<void>} */
  flushRemoteIce() {
    const operation = this.remoteIceTail.then(async () => {
      const description = this.pc.remoteDescription;
      if (!description || this.closed) return;
      for (const candidate of this.remoteIce.splice(0)) {
        if (this.closed) return;
        validateScreenIceDescription(candidate, description.sdp);
        await this.pc.addIceCandidate(candidate);
      }
    });
    this.remoteIceTail = operation;
    return operation;
  }

  /** @returns {Promise<string>} */
  async localDescription() {
    if (this.closed) throw new DOMException('Screen negotiation cancelled', 'AbortError');
    const sdp = this.pc.localDescription?.sdp;
    if (!sdp) throw new Error('屏幕连接尚未创建本地描述');
    // Candidate delivery has one ordered path, including its end marker.
    return sdp.split(/\r?\n/).filter((line) => !line.startsWith('a=candidate:') && line !== 'a=end-of-candidates').join('\r\n');
  }

  /** @returns {Promise<ScreenLinkStats>} */
  async stats() {
    /** @type {ScreenLinkStats} */
    const result = { sentBytes: 0, receivedBytes: 0, framesDecoded: 0, framesEncoded: 0, lost: 0, receivedPackets: 0, nacks: 0, rttMs: null, availableBps: null, timestamp: performance.now() };
    const reports = await this.pc.getStats();
    reports.forEach(/** @param {{type:string,kind?:string,bytesSent?:number,bytesReceived?:number,framesDecoded?:number,framesEncoded?:number,packetsLost?:number,packetsReceived?:number,nackCount?:number,state?:string,nominated?:boolean,currentRoundTripTime?:number,availableOutgoingBitrate?:number}} item */ (item) => {
      if (item.kind === 'video' && item.type === 'outbound-rtp') { result.sentBytes += item.bytesSent || 0; result.framesEncoded += item.framesEncoded || 0; result.nacks += item.nackCount || 0; }
      if (item.kind === 'video' && item.type === 'inbound-rtp') { result.receivedBytes += item.bytesReceived || 0; result.framesDecoded += item.framesDecoded || 0; result.lost += item.packetsLost || 0; result.receivedPackets += item.packetsReceived || 0; }
      if (item.type === 'candidate-pair' && item.state === 'succeeded' && item.nominated) {
        result.rttMs = typeof item.currentRoundTripTime === 'number' ? item.currentRoundTripTime * 1000 : null;
        result.availableBps = typeof item.availableOutgoingBitrate === 'number' ? item.availableOutgoingBitrate : null;
      }
    });
    const counter = result.framesDecoded + result.framesEncoded;
    if (counter > this.lastCounter) this.lastProgress = result.timestamp;
    this.lastCounter = counter;
    if (result.timestamp - this.started > 25000 && counter === 0) this.fault(new Error(`屏幕首帧超时：连接=${this.pc.connectionState}，ICE=${this.pc.iceConnectionState}，地址收集=${this.pc.iceGatheringState}，本地/远端候选=${this.localCandidateCount}/${this.remoteCandidateCount}${this.discoveryErrors.length ? '；' + this.discoveryErrors.join('；') : ''}`));
    return result;
  }

  /** @returns {void} */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.localIce.length = 0;
    this.remoteIce.length = 0;
    this.pc.close();
    this.activeEncryption?.destroy();
  }
}
