// @ts-check
'use strict';
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { installScreenRelay, stopScreenRelay } = require('../../screen-relay-ipc.cjs');
/** @typedef {import('../../screen-relay-ipc.cjs').Offer} Offer */
/** @typedef {import('../../screen-relay-ipc.cjs').RelayStats} RelayStats */
/** @typedef {import('../../screen-relay-ipc.cjs').IceCandidate} IceCandidate */
/** @typedef {{screenRelayRoom:(key:string|null)=>Promise<void>,screenRelayOffer:(offer:Offer)=>Promise<{id:string,negotiationId:string,sdp:RTCSessionDescriptionInit}>,screenRelayIce:(request:import('../../screen-relay-ipc.cjs').IceRequest)=>Promise<void>,screenRelayCandidates:(request:{id:string,negotiationId:string,after:number})=>Promise<import('../../screen-relay-ipc.cjs').CandidateBatch>,screenRelayRemove:(id:string)=>Promise<{id:string,state:string}>,screenRelayStats:()=>Promise<RelayStats>,screenRelayBudget:(budget:number)=>Promise<{sourceBudgetBps:number,admittedBps:number}>}} Bridge */
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
const profile = process.env.SCREEN_RELAY_TEST_PROFILE;
if (!profile || !path.isAbsolute(profile)) throw new Error('An explicit isolated SCREEN_RELAY_TEST_PROFILE is required');
app.setPath('userData', profile);
/** @type {Electron.BrowserWindow|null} */ let window = null;
installScreenRelay({ getWindow: () => window });

/** Execute inside the isolated renderer using the actual preload IPC bridge.
 * @returns {Promise<{decodedFrames:number,width:number,height:number,stats:RelayStats,cascadeClosed:boolean,roomRevoked:boolean}>} */
async function browserProbe() {
  const host = /** @type {Window & {relayProbe?:Bridge}} */ (globalThis.window);
  const optionalBridge = host.relayProbe;
  if (!optionalBridge) throw new Error('The real relay preload bridge is unavailable');
  const bridge = optionalBridge;
  /** @param {()=>Promise<boolean>} condition @returns {Promise<void>} */
  async function until(condition) {
    const end = Date.now() + 10000;
    while (Date.now() < end) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw new Error('Real browser relay condition exceeded ten seconds');
  }
  /** @param {RTCPeerConnection} pc @param {Omit<Offer,'sdp'>} request @returns {Promise<void>} */
  async function negotiate(pc, request) {
    /** @type {IceCandidate[]} */ const pending = [];
    pc.onicecandidate = event => {
      if (pending.length >= 128) throw new RangeError('Browser ICE queue exceeded 128');
      const value = event.candidate?.toJSON();
      pending.push(value ? { candidate: value.candidate ?? '', sdpMid: value.sdpMid ?? null, sdpMLineIndex: value.sdpMLineIndex ?? null, usernameFragment: value.usernameFragment ?? null } : { candidate: '', sdpMid: null, sdpMLineIndex: null, usernameFragment: null });
    };
    const offer = await pc.createOffer();
    if (/^a=candidate:/m.test(offer.sdp ?? '')) throw new Error('Initial integration offer must exercise zero-candidate SDP');
    await pc.setLocalDescription(offer);
    const response = await bridge.screenRelayOffer({ ...request, sdp: { type: 'offer', sdp: offer.sdp ?? '' } });
    if (response.negotiationId !== request.negotiationId) throw new Error('Native answer lost its negotiation identity');
    await pc.setRemoteDescription(response.sdp);
    let after = 0;
    let localEnded = false;
    await until(async () => {
      for (const candidate of pending.splice(0)) { await bridge.screenRelayIce({ id: request.id, negotiationId: request.negotiationId, candidate }); if (candidate.candidate === '') localEnded = true; }
      const batch = await bridge.screenRelayCandidates({ id: request.id, negotiationId: request.negotiationId, after });
      if (batch.after !== after || batch.next !== after + batch.candidates.length) throw new Error('Native ICE cursor skipped candidates');
      for (const candidate of batch.candidates) await pc.addIceCandidate(candidate);
      after = batch.next;
      return localEnded && batch.complete && pc.connectionState === 'connected';
    });
  }
  /** @param {RTCRtpTransceiver} transceiver @returns {void} */
  function codecs(transceiver) {
    const supported = RTCRtpSender.getCapabilities('video');
    if (!supported) throw new Error('Browser video codecs are unavailable');
    transceiver.setCodecPreferences(supported.codecs.filter(row => row.mimeType.toLowerCase() === 'video/vp8' || row.mimeType.toLowerCase() === 'video/rtx'));
  }
  const viewer = new RTCPeerConnection({ iceServers: [], iceTransportPolicy: 'all' });
  const publisher = new RTCPeerConnection({ iceServers: [], iceTransportPolicy: 'all' });
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
  const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas context unavailable');
  let frame = 0;
  const drawing = setInterval(() => { frame += 1; context.fillStyle = frame % 2 ? '#135780' : '#dceea0'; context.fillRect(0, 0, 320, 180); context.fillStyle = '#ff0055'; context.fillRect(frame * 7 % 280, 40, 40, 60); }, 80);
  const stream = canvas.captureStream(12);
  const video = document.createElement('video'); video.autoplay = true; video.muted = true; document.body.append(video);
  viewer.ontrack = event => { video.srcObject = new MediaStream([event.track]); void video.play(); };
  try {
    await bridge.screenRelayRoom('relay-integration-room');
    await bridge.screenRelayBudget(8000000);
    codecs(viewer.addTransceiver('video', { direction: 'recvonly' }));
    await negotiate(viewer, { id: 'preview', negotiationId: 'preview-first', role: 'subscribe', source: 'integration-source', network: { iceServers: [], policy: 'all' }, admission: { streamBps: 40000000, subscriberBudgetBps: 0, sourceBudgetBps: 8000000, locality: 'loopback-preview' } });
    await until(async () => viewer.connectionState === 'connected');
    codecs(publisher.addTransceiver(stream.getVideoTracks()[0], { direction: 'sendonly' }));
    await negotiate(publisher, { id: 'publisher', negotiationId: 'publisher-first', role: 'publish', source: 'integration-source', network: { iceServers: [], policy: 'all' }, admission: { streamBps: 40000000, subscriberBudgetBps: 0, sourceBudgetBps: 8000000, locality: 'remote' } });
    const local = publisher.localDescription;
    if (!local?.sdp) throw new Error('Real publisher offer is missing');
    let excessiveRejected = false;
    try { await bridge.screenRelayOffer({ id: 'excessive', negotiationId: 'excessive-first', role: 'publish', source: 'excessive-source', network: { iceServers: [], policy: 'all' }, sdp: { type: 'offer', sdp: local.sdp }, admission: { streamBps: 40000001, subscriberBudgetBps: 0, sourceBudgetBps: 8000000, locality: 'remote' } }); }
    catch (error) { if (!(error instanceof Error) || !error.message.includes('supported range')) throw error; excessiveRejected = true; }
    if (!excessiveRejected) throw new Error('IPC accepted a bitrate above the explicit 40 Mbps media limit');
    let staleRejected = false;
    try { await bridge.screenRelayCandidates({ id: 'publisher', negotiationId: 'old-negotiation', after: 0 }); } catch (error) { if (!(error instanceof Error) || !error.message.includes('409')) throw error; staleRejected = true; }
    if (!staleRejected) throw new Error('Stale native negotiation was not rejected');
    let decodedFrames = 0;
    await until(async () => { (await viewer.getStats()).forEach(row => { if (row.type === 'inbound-rtp' && row.kind === 'video') decodedFrames = row.framesDecoded; }); return decodedFrames >= 12 && video.videoWidth === 320 && video.videoHeight === 180; });
    const stats = await bridge.screenRelayStats();
    if (!stats.running || stats.sessions.length !== 2 || stats.sessions.some(row => row.state !== 'connected' || !row.lastPacketAt || row.rtpPackets <= 0)) throw new Error('Real relay counters or packet timestamps did not grow');
    const budget = await bridge.screenRelayBudget(0);
    if (budget.sourceBudgetBps !== 0 || budget.admittedBps !== 0) throw new Error('Zero WAN budget should retain only the free local preview');
    await bridge.screenRelayRemove('publisher');
    const closed = await bridge.screenRelayStats();
    const cascadeClosed = closed.sessions.length === 2 && closed.sessions.every(row => row.state === 'closed');
    if (!cascadeClosed) throw new Error('Publisher removal did not cascade to its preview');
    let removedRejected = false;
    try { await bridge.screenRelayIce({ id: 'publisher', negotiationId: 'publisher-first', candidate: { candidate: '', sdpMid: null, sdpMLineIndex: null, usernameFragment: null } }); } catch (error) { if (!(error instanceof Error) || !error.message.includes('409')) throw error; removedRejected = true; }
    if (!removedRejected) throw new Error('Removed session continued accepting ICE');
    await bridge.screenRelayRoom(null);
    let roomRevoked = false;
    try { await bridge.screenRelayStats(); } catch (error) { if (!(error instanceof Error) || !error.message.includes('ownership grant')) throw error; roomRevoked = true; }
    if (!roomRevoked) throw new Error('Room exit did not revoke IPC ownership');
    let iceRevoked = false;
    try { await bridge.screenRelayCandidates({ id: 'preview', negotiationId: 'preview-first', after: 0 }); } catch (error) { if (!(error instanceof Error) || !error.message.includes('ownership grant')) throw error; iceRevoked = true; }
    if (!iceRevoked) throw new Error('Room exit did not revoke ICE polling');
    return { decodedFrames, width: video.videoWidth, height: video.videoHeight, stats, cascadeClosed, roomRevoked };
  } finally { clearInterval(drawing); stream.getTracks().forEach(track => track.stop()); viewer.close(); publisher.close(); video.pause(); video.srcObject = null; }
}

/** @returns {Promise<void>} */
async function main() {
  await app.whenReady();
  const server = http.createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><html><body></body></html>'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(undefined)); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('IPC integration HTTP listener has no port');
  window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'test-ipc-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const deadline = setTimeout(() => { console.error('screen_relay_ipc_test_timeout'); app.exit(1); }, 35000);
  try {
    await window.loadURL('http://127.0.0.1:' + address.port);
    /** @type {import('../../../public/js/network-protocol.js').JsonValue} */ const result = await window.webContents.executeJavaScript('(' + browserProbe.toString() + ')()');
    fs.writeFileSync(path.join(__dirname, 'ipc-validation.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ event: 'screen_relay_ipc_integration_passed', result }));
  } finally { clearTimeout(deadline); await stopScreenRelay(); window.destroy(); window = null; await new Promise(resolve => server.close(() => resolve(undefined))); }
}
main().then(() => app.exit(0)).catch(error => { console.error('screen_relay_ipc_integration_failed', { message: error.message, stack: error.stack }); app.exit(1); });
