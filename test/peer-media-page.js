// @ts-check
import { PeerLink } from '../public/js/peer-link.js';
import { parseNetworkConfig, parsePeerSignal, objectValue } from '../public/js/network-protocol.js';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../public/js/network-protocol.js').PeerSignal} PeerSignal */
/** @typedef {import('../public/js/network-protocol.js').PeerControl} PeerControl */
/** @typedef {{scope:string,candidateType:string,protocol:string,relayProtocol:string}} CandidateSummary */
/** @typedef {{id:string,muted:boolean,enabled:boolean,readyState:string}} TrackSnapshot */
/** @typedef {{id:string,localUfrag:string,state:string,connectionState:string,signalingState:string,iceConnectionState:string,iceGatheringState:string,controlState:string,ready:boolean,route:string,bytes:number,energy:number,controls:PeerControl[],left:boolean,candidates:CandidateSummary[],remoteTracks:TrackSnapshot[],receiverTracks:TrackSnapshot[],inboundTotalAudioEnergy:number,inboundAudioLevel:number,inboundTotalSamplesDuration:number,inboundPackets:number,playback:{present:boolean,paused:boolean,readyState:number,currentTime:number,started:boolean}}} PeerSnapshot */
/** @typedef {{link:PeerLink,analyser:AnalyserNode|null,source:MediaStreamAudioSourceNode|null,audio:HTMLAudioElement|null,stream:MediaStream|null,playbackStarted:boolean,state:string,ready:boolean,controls:PeerControl[],left:boolean,queue:Promise<void>}} Peer */
/** @type {Map<string,Peer>} */
const peers = new Map();
/** @type {Map<string,PeerSignal[]>} */ const pending = new Map();
/** @type {string[]} */ const errors = [];
/** @type {{code:number,text:string,url:string}[]} */ const iceCandidateErrors = [];
const context = new AudioContext();
const oscillator = context.createOscillator();
const amplitude = context.createGain();
const destination = context.createMediaStreamDestination();
const silent = context.createGain();
const localAnalyser = context.createAnalyser();
localAnalyser.fftSize = 2048;
oscillator.frequency.value = 440;
amplitude.gain.value = 0.2;
silent.gain.value = 0;
oscillator.connect(amplitude).connect(destination);
amplitude.connect(localAnalyser).connect(silent);
silent.connect(context.destination);
oscillator.start();
const track = destination.stream.getAudioTracks()[0];
/** @type {WebSocket|null} */ let socket = null;
/** @type {import('../public/js/network-protocol.js').NetworkConfig|null} */ let config = null;
let selfId = '';
let offline = false;
let joined = false;
let refreshCount = 0;

/** @param {Error|string} error @returns {void} */
function fail(error) { errors.push(error instanceof Error ? error.message : error); }
window.addEventListener('error', (event) => fail(event.message));
window.addEventListener('unhandledrejection', (event) => fail(event.reason instanceof Error ? event.reason : 'Unhandled browser rejection'));

/** @param {{url:string,password:string,name:string}} options @returns {Promise<string>} */
async function start(options) {
  await context.resume();
  return new Promise((resolve, reject) => {
    socket = new WebSocket(options.url);
    const timer = setTimeout(() => reject(new Error('Real signaling room join timed out')), 10000);
    socket.onopen = () => socket?.send(JSON.stringify({ t: 'hello', name: options.name, password: options.password, resumable: true }));
    socket.onerror = () => { fail('Signaling WebSocket error'); reject(new Error('Signaling WebSocket error')); };
    socket.onclose = () => { if (!offline) fail('Signaling WebSocket closed before outage test'); };
    socket.onmessage = (event) => {
      try {
        /** @type {JsonValue} */ const raw = JSON.parse(String(event.data));
        const message = objectValue(raw);
        if (message.t === 'welcome') {
          if (typeof message.selfId !== 'string') throw new TypeError('Missing authenticated peer identity');
          selfId = message.selfId;
          config = parseNetworkConfig(message.config === undefined ? null : message.config);
          if (!Array.isArray(message.servers)) throw new TypeError('Missing server list');
          const channels = message.servers.flatMap((server) => { const value = objectValue(server); return Array.isArray(value.channels) ? value.channels : []; });
          const channel = channels.map(objectValue).find((value) => value.type === 'voice');
          if (!channel || typeof channel.id !== 'string') throw new TypeError('Missing voice channel');
          socket?.send(JSON.stringify({ t: 'joinVoice', channelId: channel.id, muted: false, deafened: false }));
        } else if (message.t === 'voicePeers') {
          joined = true;
          clearTimeout(timer);
          resolve(selfId);
        } else if (message.t === 'networkConfig') {
          config = parseNetworkConfig(message.config === undefined ? null : message.config);
          for (const peer of peers.values()) peer.link.configure(config);
          refreshCount += 1;
        } else if (message.t === 'signal') {
          if (typeof message.from !== 'string' || message.data === undefined) throw new TypeError('Invalid routed signal');
          const peer = peers.get(message.from);
          if (peer) peer.queue = peer.queue.then(() => peer.link.receive(message.data)).catch(fail);
          else { if (!config) throw new Error('Signal before authenticated network config'); const queued = pending.get(message.from) || []; queued.push(parsePeerSignal(message.data, config.mediaPolicy)); pending.set(message.from, queued); }
        } else if (message.t === 'error' || message.t === 'authFailed' || message.t === 'resumeRejected') throw new Error('Backend rejected test room request: ' + String(message.message));
      } catch (error) {
        const failure = error instanceof Error ? error : new Error('Invalid backend message');
        fail(failure); clearTimeout(timer); reject(failure);
      }
    };
  });
}

/** @param {string[]} ids @returns {void} */
function connectPeers(ids) {
  if (!config || !joined) throw new Error('Peer creation requires authenticated room membership');
  for (const id of ids.filter((value) => value !== selfId)) {
    /** @type {Peer} */ let peer;
    const link = new PeerLink({ selfId, peerId: id, config, track, stream: destination.stream,
      sendSignal: (data) => {
        if (offline) { fail('PeerLink attempted broker signaling after outage'); return; }
        if (!socket || socket.readyState !== WebSocket.OPEN) { fail('Signaling connection is unavailable'); return; }
        socket.send(JSON.stringify({ t: 'signal', to: id, data }));
      },
      onTrack: async (stream, kind) => {
        if (kind !== 'microphone') return;
        if (peer.audio) { peer.audio.pause(); peer.audio.srcObject = null; peer.audio.remove(); }
        peer.source?.disconnect(); peer.analyser?.disconnect();
        const audio = document.createElement('audio');
        audio.autoplay = true;
        audio.setAttribute('playsinline', '');
        audio.volume = 0;
        audio.srcObject = stream;
        document.body.append(audio);
        peer.audio = audio; peer.stream = stream; peer.playbackStarted = false;
        peer.source = context.createMediaStreamSource(stream); peer.analyser = context.createAnalyser(); peer.analyser.fftSize = 2048; peer.source.connect(peer.analyser).connect(silent);
        try { await audio.play(); if (peer.audio === audio) peer.playbackStarted = true; }
        catch (error) { fail(new Error('Native remote audio playback failed: ' + (error instanceof Error ? error.message : String(error)))); }
      },
      onState: (state) => { peer.state = state; },
      onControl: (message) => { peer.controls.push(message); if (message.type === 'leave') { peer.left = true; peer.link.close(); } },
      onReady: () => { peer.ready = true; }, onError: fail,
    });
    peer = { link, analyser: null, source: null, audio: null, stream: null, playbackStarted: false, state: 'new', ready: false, controls: [], left: false, queue: Promise.resolve() };
    link.pc.addEventListener('icecandidateerror', (event) => { iceCandidateErrors.push({ code: event.errorCode, text: event.errorText, url: event.url }); });
    peers.set(id, peer);
    for (const signal of pending.get(id) || []) peer.queue = peer.queue.then(() => peer.link.receive(signal)).catch(fail);
    pending.delete(id);
  }
}

/** @param {MediaStreamTrack} value @returns {TrackSnapshot} */
function trackSnapshot(value) { return { id: value.id, muted: value.muted, enabled: value.enabled, readyState: value.readyState }; }
/** @param {AnalyserNode} analyser @returns {number} */
function energyOf(analyser) { const values = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(values); return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length); }
/** @returns {Promise<{id:string,iceCandidateErrors:{code:number,text:string,url:string}[],errors:string[],refreshCount:number,iceExpiresAt:number|null,audioContextState:string,audioContextTime:number,sampleRate:number,localOscillatorEnergy:number,sourceTrack:{enabled:boolean,muted:boolean,readyState:string},pendingSignals:number,peers:PeerSnapshot[]}>} */
async function snapshot() {
  const snapshots = await Promise.all([...peers].map(async ([id, peer]) => {
    const stats = await peer.link.stats();
    const report = await peer.link.pc.getStats();
    let bytes = 0;
    let inboundTotalAudioEnergy = 0;
    let inboundAudioLevel = 0;
    let inboundTotalSamplesDuration = 0;
    let inboundPackets = 0;
    /** @type {CandidateSummary[]} */ const candidates = [];
    report.forEach((entry) => {
      if (entry.type === 'inbound-rtp' && entry.kind === 'audio') { bytes += Number(entry.bytesReceived) || 0; inboundTotalAudioEnergy += Number(entry.totalAudioEnergy) || 0; inboundAudioLevel = Math.max(inboundAudioLevel, Number(entry.audioLevel) || 0); inboundTotalSamplesDuration += Number(entry.totalSamplesDuration) || 0; inboundPackets += Number(entry.packetsReceived) || 0; }
      if (entry.type === 'local-candidate' || entry.type === 'remote-candidate') candidates.push({ scope: String(entry.type), candidateType: String(entry.candidateType || ''), protocol: String(entry.protocol || ''), relayProtocol: String(entry.relayProtocol || '') });
    });
    let energy = 0;
    if (peer.analyser) energy = energyOf(peer.analyser);
    return { id, localUfrag: /^a=ice-ufrag:(.+)$/m.exec(peer.link.pc.localDescription?.sdp || '')?.[1].trim() || '', state: peer.state, connectionState: peer.link.pc.connectionState, signalingState: peer.link.pc.signalingState, iceConnectionState: peer.link.pc.iceConnectionState, iceGatheringState: peer.link.pc.iceGatheringState, controlState: peer.link.control.readyState, ready: peer.ready, route: stats.route, bytes, energy, controls: peer.controls, left: peer.left, candidates: candidates.slice(0, 32), remoteTracks: (peer.stream?.getAudioTracks() || []).map(trackSnapshot), receiverTracks: peer.link.pc.getReceivers().map((receiver) => receiver.track).filter((value) => value.kind === 'audio').map(trackSnapshot), inboundTotalAudioEnergy, inboundAudioLevel, inboundTotalSamplesDuration, inboundPackets, playback: { present: Boolean(peer.audio), paused: peer.audio?.paused ?? true, readyState: peer.audio?.readyState ?? 0, currentTime: peer.audio?.currentTime ?? 0, started: peer.playbackStarted } };
  }));
  return { id: selfId, iceCandidateErrors: iceCandidateErrors.slice(-32), errors: [...errors], refreshCount, iceExpiresAt: config?.iceExpiresAt ?? null, audioContextState: context.state, audioContextTime: context.currentTime, sampleRate: context.sampleRate, localOscillatorEnergy: energyOf(localAnalyser), sourceTrack: { enabled: track.enabled, muted: track.muted, readyState: track.readyState }, pendingSignals: [...pending.values()].reduce((sum, values) => sum + values.length, 0), peers: snapshots };
}

/** @returns {void} */
function prepareOutage() { offline = true; }
/** @param {{muted:boolean,deafened:boolean}} state @returns {void} */
function sendState(state) {
  track.enabled = !state.muted;
  for (const peer of peers.values()) if (!peer.link.sendControl({ type: 'state', muted: state.muted, deafened: state.deafened })) throw new Error('Native state DataChannel was not open');
}
/** @returns {void} */
function sendLeave() { for (const peer of peers.values()) if (!peer.link.sendControl({ type: 'leave' })) throw new Error('Native leave DataChannel was not open'); }
/** @returns {void} */
function announceClose() { for (const peer of peers.values()) if (peer.link.control.readyState === 'open' && !peer.link.sendControl({ type: 'leave' })) throw new Error('Teardown leave announcement failed'); }
/** @returns {void} */
function refreshNetwork() { if (!socket || socket.readyState !== WebSocket.OPEN || offline) throw new Error('Refresh requires an authenticated live signaling connection'); socket.send(JSON.stringify({ t: 'refreshNetwork' })); }
/** @returns {Promise<void>} */
async function close() { offline = true; socket?.close(); for (const peer of peers.values()) { peer.link.close(); if (peer.audio) { peer.audio.pause(); peer.audio.srcObject = null; peer.audio.remove(); } } oscillator.stop(); track.stop(); await context.close(); }

Object.assign(window, { peerMediaTest: { start, connectPeers, snapshot, prepareOutage, sendState, sendLeave, announceClose, refreshNetwork, close } });
