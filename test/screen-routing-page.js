// @ts-check
import { PeerLink } from '../public/js/peer-link.js';
import { ScreenRelay } from '../public/js/screen-relay.js';
import { DEFAULT_SCREEN_PREFERENCES } from '../public/js/screen-preferences.js';
import { RemoteAudio } from '../public/js/remote-audio.js';
import { objectValue, parsePeerSignal } from '../public/js/network-protocol.js';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../public/js/network-protocol.js').PeerSignal} PeerSignal */
/** @typedef {import('../public/js/screen-protocol.js').ScreenMessage} ScreenMessage */
/** @typedef {{link:PeerLink,source:MediaStreamAudioSourceNode|null,analyser:AnalyserNode|null,playback:RemoteAudio|null}} Peer */
/** @typedef {{from:string,kind:string,message:string}} Rejection */
/** @typedef {{type:string,kind?:string,trackIdentifier?:string,bytesReceived?:number,packetsReceived?:number,totalSamplesDuration?:number,totalAudioEnergy?:number,jitterBufferEmittedCount?:number,framesDecoded?:number,framesEncoded?:number}} Rtp */
const query = new URLSearchParams(location.search);
const inputId = query.get('id'), token = query.get('token');
if (!inputId || !/^n0[0-5]$/.test(inputId) || !token || !/^[a-f0-9]{64}$/.test(token)) throw new TypeError('Explicit process identity and broker token are required');
const id = inputId;
const ids = ['n00', 'n01', 'n02', 'n03', 'n04', 'n05'];
/** @type {Map<string,Peer>} */ const peers = new Map();
/** @type {Map<string,PeerSignal[]>} */ const waitingSignals = new Map();
/** @type {string[]} */ const errors = [];
/** @type {Rejection[]} */ const rejections = [];
/** @type {string[]} */ const supersededPlayRequests = [];
/** @type {Array<{from:string,kind:string,pattern:string}>} */ let expectedForgery = [];
/** @type {Map<string,number>} */ const sentControls = new Map();
/** @type {Map<string,number>} */ const receivedControls = new Map();
const context = new AudioContext({ sampleRate: 48000 });
const output = context.createMediaStreamDestination();
const audio = context.createBufferSource();
const buffer = context.createBuffer(1, 48000, 48000), channel = buffer.getChannelData(0);
let seed = Number(id.slice(1)) + 12345;
for (let sample = 0; sample < channel.length; sample += 1) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; const t = sample / 48000; channel[sample] = 0.12 * Math.sin(2 * Math.PI * (190 + Number(id.slice(1)) * 31) * t) + 0.05 * Math.sin(2 * Math.PI * 830 * t) + ((seed >>> 0) / 4294967296 - 0.5) * 0.025; }
audio.buffer = buffer; audio.loop = true; audio.connect(output); audio.connect(context.destination);
/** @type {MediaStream|null} */ let screenStream = null;
/** @type {ReturnType<typeof setInterval>|null} */ let drawing = null;
let left = false, displayedFrames = 0, displayCallbacks = 0;
const videoElement = document.getElementById('screen'), canvasElement = document.getElementById('source');
if (!(videoElement instanceof HTMLVideoElement) || !(canvasElement instanceof HTMLCanvasElement)) throw new TypeError('Test media elements are missing');
const video = videoElement, canvas = canvasElement;

/** @param {Error|string} error @returns {void} */
function fail(error) { errors.push(error instanceof Error ? error.message : error); }
window.addEventListener('error', event => fail(event.message));
window.addEventListener('unhandledrejection', event => fail(event.reason instanceof Error ? event.reason : 'Unhandled renderer rejection'));
/** @param {string} endpoint @param {JsonValue} body @returns {Promise<JsonValue>} */
async function post(endpoint, body) {
  const response = await fetch(endpoint + '?id=' + id + '&token=' + token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Test broker rejected ' + endpoint + ': HTTP ' + response.status + ' ' + await response.text());
  return /** @type {JsonValue} */ (await response.json());
}
const stunPort = Number(query.get('stunPort'));
if (!Number.isInteger(stunPort) || stunPort < 0 || stunPort > 65535) throw new TypeError('Fault-injection STUN port is invalid');
/** @type {import('../public/js/network-protocol.js').NetworkConfig} */
const network = { networkMode: stunPort > 0 ? 'server' : 'direct', mediaPolicy: 'direct', iceTransportPolicy: 'all', iceServers: stunPort > 0 ? [{ urls: 'stun:127.0.0.1:' + stunPort }] : [], iceExpiresAt: null, screen: { mode: 'peer-relay' } };
const relay = new ScreenRelay({ selfId: id, getNetwork: () => network, getPreferences: () => ({ ...DEFAULT_SCREEN_PREFERENCES, uploadLimitMbps: id === 'n01' || id === 'n02' ? 20 : 5, screenBitrateMbps: 1 }), peerIds: () => [...peers.keys()],
  send: (peerId, message) => { const peer = peers.get(peerId); if (!peer) return false; const sent = peer.link.sendControl({ type: 'screen', data: message }); if (sent) sentControls.set(message.kind, (sentControls.get(message.kind) ?? 0) + 1); return sent; },
  onStream: (sourceId, stream) => { if (sourceId !== 'n00') { if (stream) fail('Unexpected screen source identity'); return; } video.srcObject = stream; if (stream) video.play().catch(error => { if (error instanceof DOMException && error.name === 'AbortError' && video.srcObject !== stream) supersededPlayRequests.push(error.message); else fail(error instanceof Error ? error : 'Non-error video playback rejection'); }); }, onError: fail });
/** @param {number} _time @param {VideoFrameCallbackMetadata} metadata @returns {void} */
function presented(_time, metadata) { displayedFrames += 1; displayCallbacks = metadata.presentedFrames; if (!left) video.requestVideoFrameCallback(presented); }
video.requestVideoFrameCallback(presented);

/** @param {string} peerId @returns {void} */
function removePeer(peerId) {
  const peer = peers.get(peerId);
  if (!peer) return;
  peers.delete(peerId); peer.playback?.dispose(); peer.link.close(); relay.peerRemoved(peerId);
}
/** @param {string} peerId @returns {void} */
function connect(peerId) {
  /** @type {Peer} */ let peer;
  const link = new PeerLink({ selfId: id, peerId, config: network, track: output.stream.getAudioTracks()[0], stream: output.stream,
    sendSignal: data => { post('/signal', { to: peerId, data: /** @type {JsonValue} */ (JSON.parse(JSON.stringify(data))) }).catch(fail); },
    onReady: () => relay.peerReady(peerId), onState: () => {}, onError: fail,
    onTrack: (stream, kind) => { if (kind !== 'microphone' || left) return; peer.playback?.dispose(); peer.playback = new RemoteAudio(context, stream, 1, fail); peer.source = peer.playback.source; peer.analyser = peer.playback.analyser; },
    onControl: message => {
      if (message.type === 'leave') { removePeer(peerId); return; }
      if (message.type !== 'screen') return;
      receivedControls.set(message.data.kind, (receivedControls.get(message.data.kind) ?? 0) + 1);
      relay.receive(peerId, message.data).catch(error => {
        const failure = error instanceof Error ? error : new TypeError('Screen receiver rejected a non-error');
        const expected = expectedForgery.find(row => row.from === peerId && row.kind === message.data.kind && failure.message.includes(row.pattern));
        if (expected) { rejections.push({ from: peerId, kind: message.data.kind, message: failure.message }); expectedForgery = expectedForgery.filter(row => row !== expected); }
        else fail(failure);
      });
    } });
  peer = { link, source: null, analyser: null, playback: null }; peers.set(peerId, peer);
  for (const signal of waitingSignals.get(peerId) ?? []) link.receive(signal).catch(fail);
  waitingSignals.delete(peerId);
}

/** @returns {Promise<JsonValue>} */
async function snapshot() {
  const voice = await Promise.all([...peers].map(async ([peerId, peer]) => {
    /** @type {Rtp[]} */ const inbound = [];
    (await peer.link.pc.getStats()).forEach(/** @param {Rtp} row */ row => { if (row.type === 'inbound-rtp' && row.kind === 'audio') inbound.push(row); });
    let rms = 0;
    if (peer.analyser) { const pcm = new Float32Array(peer.analyser.fftSize); peer.analyser.getFloatTimeDomainData(pcm); rms = Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length); }
    return { peerId, state: peer.link.pc.connectionState, control: peer.link.control.readyState, rms, receiver: peer.source ? { tracks: peer.source.mediaStream.getTracks().map(track => ({kind:track.kind,id:track.id,state:track.readyState,muted:track.muted,enabled:track.enabled})) } : null, transceivers: peer.link.pc.getTransceivers().map(t => ({mid:t.mid,direction:t.currentDirection,sent:t.sender.track?.readyState??null,received:t.receiver.track.readyState,muted:t.receiver.track.muted})), inbound: inbound.map(row => ({ bytes: row.bytesReceived ?? null, packets: row.packetsReceived ?? null, duration: row.totalSamplesDuration ?? null, energy: row.totalAudioEnergy ?? null, emitted: row.jitterBufferEmittedCount ?? null, trackIdentifier: row.trackIdentifier ?? null })) };
  }));
  const screen = await Promise.all([...relay.edges.values()].map(async edge => ({ id: edge.id, sourceId: edge.sourceId, peerId: edge.peerId, role: edge.role, state: edge.link.pc.connectionState, stats: await edge.link.stats(), local: edge.link.pc.localDescription?.toJSON() ?? null, remote: edge.link.pc.remoteDescription?.toJSON() ?? null })));
  let native = null;
  if (!left && relay.bridge) native = await relay.bridge.screenRelayStats();
  return /** @type {JsonValue} */ ({ id, timestamp: Date.now(), left, errors: [...errors], supersededPlayRequests: [...supersededPlayRequests], rejections: [...rejections], peers: [...peers.keys()], voice, displayedFrames, displayCallbacks, width: video.videoWidth, height: video.videoHeight, videoPresent: video.srcObject !== null, bridgePresent: relay.bridge !== null, controller: relay.snapshot(), native, screen, sentControls: Object.fromEntries(sentControls), receivedControls: Object.fromEntries(receivedControls), core: { edges: relay.edges.size, native: relay.native.size, plans: relay.plans.size, watching: relay.watching.size, shares: relay.shares.size, channel: relay.channelId, audioContext: context.state } });
}

/** @param {import('../public/js/network-protocol.js').JsonObject} command @returns {Promise<JsonValue>} */
async function execute(command) {
  if (command.op === 'snapshot') return snapshot();
  if (command.op === 'publish') {
    if (id !== 'n00') throw new Error('Only n00 may publish test video');
    const drawingContext = canvas.getContext('2d'); if (!drawingContext) throw new Error('Canvas context unavailable');
    let frame = 0;
    drawing = setInterval(() => { frame += 1; drawingContext.fillStyle = '#102331'; drawingContext.fillRect(0, 0, 640, 360); drawingContext.fillStyle = '#f8df32'; drawingContext.fillRect(frame * 11 % 540, 60, 100, 100); drawingContext.fillStyle = '#dceaff'; drawingContext.font = '20px sans-serif'; drawingContext.fillText('Real VP8 screen ' + frame, 30, 250); }, 66);
    const captured = canvas.captureStream(15); screenStream = captured; await relay.publish(captured); return { published: true };
  }
  if (command.op === 'watch') { await relay.watch('n00'); return { watching: true }; }
  if (command.op === 'unwatch') { await relay.unwatch('n00'); return { watching: false }; }
  if (command.op === 'unpublish') { await relay.unpublish(); screenStream?.getTracks().forEach(track => track.stop()); screenStream = null; if (drawing) clearInterval(drawing); drawing = null; return { published: false }; }
  if (command.op === 'expect-forgery') { expectedForgery = [{ from: 'n03', kind: 'plan', pattern: 'Only the sharing user' }, { from: 'n03', kind: 'offer', pattern: 'Unauthorized screen relay subscriber' }]; return { expecting: expectedForgery.length }; }
  if (command.op === 'forge') {
    const plan = relay.plans.get('n00'), victim = peers.get('n02');
    if (id !== 'n03' || !plan || !victim) throw new Error('Forgery test has no current authenticated target');
    const route = plan.routes.find(row => row.parentId === 'n02' && row.viewerId !== id);
    const sdp = [...relay.edges.values()].find(edge => edge.sourceId === 'n00')?.link.pc.localDescription?.sdp;
    if (!route || !sdp) throw new Error('Forgery requires an unrelated route and real one-video SDP');
    if (!victim.link.sendControl({ type: 'screen', data: { ...plan, epoch: plan.epoch + 1000 } })) throw new Error('Forged plan did not enter the real data channel');
    if (!victim.link.sendControl({ type: 'screen', data: { kind: 'offer', version: 2, sourceId: 'n00', shareId: plan.shareId, edgeId: route.routeId, negotiationId: crypto.randomUUID(), role: 'subscribe', sdp } })) throw new Error('Forged offer did not enter the real data channel');
    return { forgedPlanAndOfferSent: true };
  }
  if (command.op === 'leave') {
    left = true;
    relay.leave();
    for (const peer of peers.values()) if (!peer.link.sendControl({ type: 'leave' })) throw new Error('Graceful leave could not enter a peer data channel');
    await new Promise(resolve => setTimeout(resolve, 200));
    await relay.roomReady;
    for (const peerId of [...peers.keys()]) removePeer(peerId);
    audio.stop(); output.stream.getTracks().forEach(track => track.stop()); await context.close();
    return snapshot();
  }
  throw new TypeError('Unsupported explicit test command: ' + String(command.op));
}

/** @returns {Promise<void>} */
async function main() {
  await /** @type {AudioContext & {setSinkId:(sink:{type:'none'})=>Promise<void>}} */ (context).setSinkId({ type: 'none' }); await context.resume(); audio.start();
  relay.join('screen-routing-room'); await relay.roomReady;
  for (const peerId of ids) if (peerId !== id) connect(peerId);
  await post('/report', { requestId: 'ready', ok: true, payload: { id, sampleRate: context.sampleRate, silentSink: true } });
  while (true) {
    const response = await fetch('/poll?id=' + id + '&token=' + token, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Test command poll failed: ' + response.status);
    const batch = objectValue(/** @type {JsonValue} */ (await response.json()));
    if (!Array.isArray(batch.signals) || !Array.isArray(batch.commands)) throw new TypeError('Invalid test command batch');
    for (const value of batch.signals) { const signal = objectValue(value); if (typeof signal.from !== 'string') throw new TypeError('Missing authenticated signal sender'); const parsed = parsePeerSignal(signal.data, 'direct'); const peer = peers.get(signal.from); if (peer) await peer.link.receive(parsed); else if (!left) { const queue = waitingSignals.get(signal.from) ?? []; if (queue.length >= 128) throw new RangeError('Pending signal limit exceeded'); queue.push(parsed); waitingSignals.set(signal.from, queue); } }
    for (const value of batch.commands) {
      const command = objectValue(value);
      if (typeof command.requestId !== 'string') throw new TypeError('Test command lacks request identity');
      try { await post('/report', { requestId: command.requestId, ok: true, payload: await execute(command) }); }
      catch (error) { await post('/report', { requestId: command.requestId, ok: false, payload: { message: error instanceof Error ? error.message : 'Non-error test command failure' } }); }
    }
    await new Promise(resolve => setTimeout(resolve, 70));
  }
}
main().catch(fail);
