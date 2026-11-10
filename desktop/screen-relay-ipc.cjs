// @ts-check
'use strict';

const { app, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{[key:string]:JsonValue}} JsonObject */
/** @typedef {{getWindow:()=>Electron.BrowserWindow|null}} RelayOptions */
/** @typedef {{key:string,owner:number,url:string}} Room */
/** @typedef {{streamBps:number,subscriberBudgetBps:number,sourceBudgetBps:number,locality:'remote'|'loopback-preview'}} Admission */
/** @typedef {{urls:string[],username:string,credential:string}} IceServer */
/** @typedef {{id:string,negotiationId:string,role:'publish'|'subscribe',source:string,sdp:{type:'offer',sdp:string},network:{iceServers:IceServer[],policy:'all'|'relay'},admission:Admission}} Offer */
/** @typedef {{candidate:string,sdpMid:string|null,sdpMLineIndex:number|null,usernameFragment:string|null}} IceCandidate */
/** @typedef {{id:string,negotiationId:string,candidate:IceCandidate}} IceRequest */
/** @typedef {{id:string,negotiationId:string,after:number,next:number,candidates:IceCandidate[],complete:boolean}} CandidateBatch */
/** @typedef {{id:string,role:'publish'|'subscribe',source:string,state:string,codec:string,rtpBytes:number,rtpPackets:number,wireRtpBytesSent:number,wireRtpBytesReceived:number,lastPacketAt:string|null,diagnostic:string,queueBytes:number,duplicatePackets:number,repairedPackets:number,filteredRepairNacks:number,outsideRepairWindowPackets:number,admission:Admission}} RelaySession */
/** @typedef {{running:boolean,pid:number|null,heapBytes:number,cpuTimeSeconds:number|null,sourceBudgetBps:number,admittedBps:number,sessions:RelaySession[]}} RelayStats */
/** @typedef {{child:import('node:child_process').ChildProcessWithoutNullStreams,token:string,port:number,epoch:number,exited:Promise<void>,stopping:boolean,diagnostics:string}} Child */

const helper = path.join(__dirname, 'native', 'bin', 'screen-relay.exe');
/** @type {RelayOptions|null} */ let settings = null;
/** @type {Room|null} */ let room = null;
/** @type {Child|null} */ let active = null;
/** @type {Promise<Child>|null} */ let starting = null;
/** @type {WeakSet<Electron.WebContents>} */ const watched = new WeakSet();
let generation = 0;
let pending = 0;
let roomIntent = 0;
let budgetUpdating = false;
/** @type {number|null} */ let configuredBudgetBps = null;

/** @param {JsonValue} value @param {string} name @returns {JsonObject} */
function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(name + ' must be an object');
  return value;
}
/** @param {JsonValue} value @param {string} name @param {number} limit @returns {string} */
function text(value, name, limit) {
  if (typeof value !== 'string' || value.length > limit) throw new TypeError(name + ' must be a bounded string');
  return value;
}
/** @param {JsonValue} value @param {string} name @returns {number} */
function integer(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(name + ' must be a nonnegative safe integer');
  return value;
}
/** @param {JsonValue} value @param {string} name @returns {number} */
function gauge(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError(name + ' must be a finite nonnegative number');
  return value;
}
/** @param {JsonValue} value @param {string} name @returns {string} */
function identifier(value, name) {
  const id = text(value, name, 128);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new TypeError(name + ' must contain 1-128 safe characters');
  return id;
}
/** @param {JsonValue} value @returns {string} */
function negotiationIdentifier(value) {
  const id = text(value, 'negotiationId', 96);
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(id)) throw new TypeError('negotiationId must contain 1-96 safe characters');
  return id;
}
/** @param {JsonValue} value @returns {IceCandidate} */
function parseCandidate(value) {
  const row = object(value, 'candidate');
  const candidate = text(row.candidate, 'candidate.candidate', 4096);
  if (/[\r\n\x00]/.test(candidate) || (candidate !== '' && !candidate.startsWith('candidate:'))) throw new TypeError('ICE candidate must be a single candidate: line or the explicit empty end marker');
  const sdpMid = row.sdpMid === null ? null : text(row.sdpMid, 'candidate.sdpMid', 128);
  const usernameFragment = row.usernameFragment === null ? null : text(row.usernameFragment, 'candidate.usernameFragment', 256);
  const sdpMLineIndex = row.sdpMLineIndex === null ? null : integer(row.sdpMLineIndex, 'candidate.sdpMLineIndex');
  if (sdpMid === '' || usernameFragment === '' || (sdpMLineIndex !== null && sdpMLineIndex !== 0)) throw new TypeError('ICE metadata must identify the single video section with bounded nonempty fields');
  if (candidate && (usernameFragment === null || (sdpMid === null && sdpMLineIndex === null))) throw new TypeError('Nonempty ICE candidates require usernameFragment and a video mid or index');
  return { candidate, sdpMid, sdpMLineIndex, usernameFragment };
}
/** @param {JsonValue} value @returns {Admission} */
function admission(value) {
  const row = object(value, 'admission');
  const streamBps = integer(row.streamBps, 'admission.streamBps'), subscriberBudgetBps = integer(row.subscriberBudgetBps, 'admission.subscriberBudgetBps'), sourceBudgetBps = integer(row.sourceBudgetBps, 'admission.sourceBudgetBps');
  if (streamBps < 128000 || streamBps > 40000000 || subscriberBudgetBps > 48000000 || sourceBudgetBps > 1000000000 || (row.locality !== 'remote' && row.locality !== 'loopback-preview')) throw new RangeError('Explicit screen admission is outside the supported range');
  return { streamBps, subscriberBudgetBps, sourceBudgetBps, locality: row.locality };
}
/** @param {JsonValue} value @returns {Offer} */
function parseOffer(value) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 256 * 1024) throw new RangeError('Relay offer exceeds 256 KiB');
  const row = object(value, 'offer'), sdp = object(row.sdp, 'offer.sdp'), network = object(row.network, 'offer.network');
  if (row.role !== 'publish' && row.role !== 'subscribe') throw new TypeError('offer.role must be publish or subscribe');
  if (sdp.type !== 'offer' || !sdp.sdp) throw new TypeError('A complete nonempty SDP offer is required');
  if (network.policy !== 'all' && network.policy !== 'relay') throw new TypeError('network.policy must explicitly be all or relay');
  if (!Array.isArray(network.iceServers) || network.iceServers.length > 8) throw new TypeError('network.iceServers must be an explicit array with at most eight servers');
  const iceServers = network.iceServers.map(value => {
    const server = object(value, 'ICE server');
    if (!Array.isArray(server.urls) || server.urls.length < 1 || server.urls.length > 4) throw new TypeError('ICE server urls must contain 1-4 URLs');
    const urls = server.urls.map(url => { const result = text(url, 'ICE URL', 2048); if (!/^(stun|stuns|turn|turns):[^\s]+$/.test(result)) throw new TypeError('Only explicit STUN/TURN URLs are supported'); return result; });
    return { urls, username: text(server.username, 'ICE username', 512), credential: text(server.credential, 'ICE credential', 512) };
  });
  return { id: identifier(row.id, 'offer.id'), negotiationId: negotiationIdentifier(row.negotiationId), role: row.role, source: identifier(row.source, 'offer.source'), sdp: { type: 'offer', sdp: text(sdp.sdp, 'offer.sdp.sdp', 128 * 1024) }, network: { iceServers, policy: network.policy }, admission: admission(row.admission) };
}

/** @param {Error} error @returns {void} */
function reportCleanup(error) { console.error('screen_relay_cleanup_failed', { message: error.message }); }
/** @param {Electron.WebContents} owner @returns {void} */
function watch(owner) {
  if (watched.has(owner)) return;
  watched.add(owner);
  const invalidate = () => { if (room?.owner === owner.id || settings?.getWindow()?.webContents === owner) { roomIntent += 1; room = null; void stopScreenRelay().catch(reportCleanup); } };
  owner.on('will-navigate', invalidate);
  owner.on('did-navigate-in-page', invalidate);
  owner.on('render-process-gone', invalidate);
  owner.once('destroyed', invalidate);
}
/** @param {Electron.IpcMainInvokeEvent} event @returns {Electron.WebContents} */
function mainFrame(event) {
  const window = settings?.getWindow();
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Screen relay is restricted to the current room main frame');
  watch(event.sender);
  return event.sender;
}
/** @param {Electron.IpcMainInvokeEvent} event @returns {number} */
function ownership(event) {
  const owner = mainFrame(event);
  if (!room || room.owner !== owner.id || room.url !== owner.getURL()) throw new Error('Screen relay has no active ownership grant for this room');
  return generation;
}
/** @param {number} epoch @returns {void} */
function requireEpoch(epoch) { if (!room || epoch !== generation) throw new Error('Screen relay operation was cancelled by a room or navigation change'); }

/** @param {string|null} roomKey @returns {Promise<void>} */
async function setScreenRelayRoom(roomKey) {
  if (roomKey !== null) identifier(roomKey, 'roomKey');
  const window = settings?.getWindow();
  if (roomKey !== null && (!window || window.isDestroyed())) throw new Error('Current desktop window is unavailable');
  const owner = window?.webContents;
  const url = owner?.getURL() ?? '';
  if (roomKey !== null && !/^https?:$/.test(new URL(url).protocol)) throw new Error('Screen relay rooms require a connected HTTP(S) app');
  if (roomKey !== null && room?.key === roomKey && room.owner === owner?.id && room.url === url) return;
  const intent = ++roomIntent;
  if (owner) watch(owner);
  room = null;
  configuredBudgetBps = null;
  await stopScreenRelay();
  if (intent !== roomIntent) throw new Error('Room ownership request was superseded');
  if (roomKey !== null && owner && !owner.isDestroyed() && owner.getURL() === url) { watch(owner); room = { key: roomKey, owner: owner.id, url }; }
}

/** @returns {Promise<void>} */
async function stopScreenRelay() {
  generation += 1;
  const child = active;
  if (!child) return;
  child.stopping = true;
  child.child.stdin.end();
  const kill = setTimeout(() => child.child.kill(), 1000);
  /** @type {ReturnType<typeof setTimeout>|null} */ let timeout = null;
  try {
    await Promise.race([child.exited, new Promise((_, reject) => { timeout = setTimeout(() => { child.child.kill(); reject(new Error('Screen relay did not exit within three seconds')); }, 3000); })]);
  } finally { clearTimeout(kill); if (timeout) clearTimeout(timeout); }
}

/** @param {number} epoch @returns {Promise<Child>} */
async function startChild(epoch) {
  requireEpoch(epoch);
  const token = randomBytes(32).toString('hex');
  const child = spawn(helper, ['--listen', '127.0.0.1:0'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SCREEN_RELAY_TOKEN: token } });
  /** @type {(value:void)=>void} */ let finish = () => {};
  /** @type {Promise<void>} */ const exited = new Promise(resolve => { finish = resolve; });
  /** @type {Child} */ const state = { child, token, port: 0, epoch, exited, stopping: false, diagnostics: '' };
  active = state;
  /** @type {(value:void)=>void} */ let ready = () => {};
  /** @type {(error:Error)=>void} */ let failed = () => {};
  /** @type {Promise<void>} */ const startup = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
  let output = '';
  let acknowledged = false;
  const timer = setTimeout(() => failed(new Error('Screen relay startup exceeded five seconds')), 5000);
  child.stdin.on('error', error => { console.warn('screen_relay_parent_pipe_error', { pid: child.pid, message: error.message }); if (!state.stopping) failed(error); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (/** @type {string} */ data) => {
    output += data;
    if (output.length > 4096) { failed(new Error('Screen relay startup record exceeded its limit')); child.kill(); return; }
    if (!output.includes('\n')) return;
    try {
      if (acknowledged || output.trim().includes('\n')) throw new TypeError('Screen relay emitted multiple startup records');
      /** @type {JsonValue} */ const input = JSON.parse(output.trim());
      const record = object(input, 'startup record'), port = integer(record.port, 'startup port');
      if (record.event !== 'ready' || record.pid !== child.pid || port < 1 || port > 65535) throw new TypeError('Screen relay startup PID or port is invalid');
      state.port = port; acknowledged = true; ready();
    } catch (error) { failed(error instanceof Error ? error : new Error('Screen relay startup record is invalid')); child.kill(); }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (/** @type {string} */ data) => { state.diagnostics = (state.diagnostics + data).slice(-8192); });
  child.once('error', failed);
  child.once('close', code => {
    if (active === state) active = null;
    if (!acknowledged) failed(new Error('Screen relay exited before startup: ' + JSON.stringify({ code, diagnostics: state.diagnostics })));
    if (!state.stopping) console.error('screen_relay_child_exited', { pid: child.pid, code, diagnostics: state.diagnostics });
    finish();
  });
  try { await startup; requireEpoch(epoch); if (active !== state || state.stopping) throw new Error('Screen relay startup was cancelled'); return state; }
  catch (error) { state.stopping = true; child.kill(); await exited; throw error; }
  finally { clearTimeout(timer); }
}

/** @param {Child} child @param {string} method @param {string} endpoint @param {JsonValue} body @returns {Promise<JsonValue>} */
async function request(child, method, endpoint, body) {
  requireEpoch(child.epoch);
  const payload = body === null ? null : Buffer.from(JSON.stringify(body));
  if (payload && payload.length > 256 * 1024) throw new RangeError('Relay request exceeds its size limit');
  if (pending >= 16) throw new RangeError('Screen relay pending-operation limit reached');
  pending += 1;
  try { return await new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: child.port, path: endpoint, method, headers: { Authorization: 'Bearer ' + child.token, 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': payload.length } : {}) } }, response => {
      /** @type {Buffer[]} */ const chunks = []; let bytes = 0;
      response.on('data', (/** @type {Buffer} */ chunk) => { bytes += chunk.length; if (bytes > 256 * 1024) { request.destroy(new RangeError('Relay response exceeds 256 KiB')); return; } chunks.push(chunk); });
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('Screen relay response was aborted: ' + endpoint)));
      response.once('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode !== 200) throw new Error('Screen relay HTTP request failed: ' + JSON.stringify({ status: response.statusCode, endpoint, body: text.slice(0, 4096) }));
          /** @type {JsonValue} */ const value = JSON.parse(text);
          requireEpoch(child.epoch); resolve(value);
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('Screen relay HTTP operation exceeded ten seconds: ' + endpoint)), 10000);
    request.once('close', () => clearTimeout(timer));
    request.once('error', reject);
    request.end(payload);
  }); } finally { pending -= 1; }
}

/** @param {RelayOptions} options @returns {void} */
function installScreenRelay(options) {
  if (settings) throw new Error('Screen relay IPC was already installed');
  settings = options;
  ipcMain.handle('screen-relay:room', async (event, /** @type {JsonValue} */ value) => {
    mainFrame(event);
    const input = object(value, 'room');
    if (input.roomKey !== null && typeof input.roomKey !== 'string') throw new TypeError('roomKey must explicitly be a string or null');
    await setScreenRelayRoom(input.roomKey);
  });
  ipcMain.handle('screen-relay:offer', async (event, /** @type {JsonValue} */ value) => {
    const epoch = ownership(event), offer = parseOffer(value);
    if (configuredBudgetBps !== null && configuredBudgetBps !== offer.admission.sourceBudgetBps) throw new RangeError('Offer admission differs from the explicitly configured room screen budget');
    if (pending >= 16) throw new RangeError('Screen relay pending-operation limit reached');
    pending += 1;
    try {
      if (starting) await starting;
      else if (!active) { starting = startChild(epoch).finally(() => { starting = null; }); await starting; }
      requireEpoch(epoch);
      const child = active;
      if (!child || child.stopping) throw new Error('Screen relay process is unavailable');
      const answer = object(await request(child, 'POST', '/session', offer), 'relay answer');
      const sdp = object(answer.sdp, 'answer.sdp');
      if (answer.id !== offer.id || answer.negotiationId !== offer.negotiationId || sdp.type !== 'answer') throw new TypeError('Relay answer does not match the offered session and negotiation');
      requireEpoch(epoch);
      if (active !== child || child.stopping) throw new Error('Screen relay process changed during the offer');
      if (configuredBudgetBps === null) configuredBudgetBps = offer.admission.sourceBudgetBps;
      return { id: offer.id, negotiationId: offer.negotiationId, sdp: { type: 'answer', sdp: text(sdp.sdp, 'answer.sdp.sdp', 128 * 1024) } };
    } finally { pending -= 1; }
  });
  ipcMain.handle('screen-relay:ice', async (event, /** @type {JsonValue} */ value) => {
    const epoch = ownership(event), row = object(value, 'ICE request');
    const id = identifier(row.id, 'session id'), negotiationId = negotiationIdentifier(row.negotiationId), candidate = parseCandidate(row.candidate);
    const child = active;
    if (!child || child.stopping) throw new Error('Screen relay process is unavailable for ICE');
    const response = object(await request(child, 'POST', '/session/' + encodeURIComponent(id) + '/ice', { negotiationId, candidate }), 'ICE acknowledgement');
    requireEpoch(epoch);
    if (active !== child || child.stopping || response.id !== id || response.negotiationId !== negotiationId) throw new Error('Screen relay ICE acknowledgement is no longer current');
  });
  ipcMain.handle('screen-relay:candidates', async (event, /** @type {JsonValue} */ value) => {
    const epoch = ownership(event), row = object(value, 'ICE cursor');
    const id = identifier(row.id, 'session id'), negotiationId = negotiationIdentifier(row.negotiationId), after = integer(row.after, 'after');
    if (after > 128) throw new RangeError('ICE cursor exceeds 128 candidates');
    const child = active;
    if (!child || child.stopping) throw new Error('Screen relay process is unavailable for ICE');
    const response = object(await request(child, 'GET', '/session/' + encodeURIComponent(id) + '/ice?after=' + after + '&negotiationId=' + encodeURIComponent(negotiationId), null), 'ICE batch');
    requireEpoch(epoch);
    if (active !== child || child.stopping || response.id !== id || response.negotiationId !== negotiationId || response.after !== after || typeof response.complete !== 'boolean' || !Array.isArray(response.candidates) || response.candidates.length > 128) throw new TypeError('Invalid or stale relay ICE batch');
    const next = integer(response.next, 'next'), candidates = response.candidates.map(parseCandidate);
    if (next !== after + candidates.length || next > 128 || candidates.some((candidate, index) => candidate.candidate === '' && (!response.complete || index !== candidates.length - 1)) || (response.complete && candidates.length > 0 && candidates[candidates.length - 1].candidate !== '')) throw new TypeError('Invalid relay ICE cursor or completion marker');
    return { id, negotiationId, after, next, candidates, complete: response.complete };
  });
  ipcMain.handle('screen-relay:remove', async (event, /** @type {JsonValue} */ value) => {
    const epoch = ownership(event), id = identifier(value, 'session id');
    if (starting) await starting;
    requireEpoch(epoch);
    const child = active;
    if (!child) return { id, state: 'closed' };
    if (child.stopping) { await child.exited; requireEpoch(epoch); return { id, state: 'closed' }; }
    const result = object(await request(child, 'DELETE', '/session/' + encodeURIComponent(id), null), 'remove response');
    requireEpoch(epoch);
    if (result.id !== id || result.state !== 'closed') throw new TypeError('Invalid relay removal acknowledgement');
    return { id, state: 'closed' };
  });
  ipcMain.handle('screen-relay:stats', async event => {
    ownership(event);
    return relayStats();
  });
  ipcMain.handle('screen-relay:budget', async (event, /** @type {JsonValue} */ value) => {
    const epoch = ownership(event), input = object(value, 'budget');
    const sourceBudgetBps = integer(input.sourceBudgetBps, 'sourceBudgetBps');
    if (sourceBudgetBps > 1000000000) throw new RangeError('sourceBudgetBps exceeds 1000000000');
    if (starting) await starting;
    requireEpoch(epoch);
    if (!active) { configuredBudgetBps = sourceBudgetBps; return { sourceBudgetBps, admittedBps: 0 }; }
    if (active.stopping) throw new Error('Screen relay is stopping');
    if (budgetUpdating) throw new Error('Screen relay budget update is already in progress');
    budgetUpdating = true;
    try {
    const result = object(await request(active, 'POST', '/budget', { sourceBudgetBps }), 'budget response');
    requireEpoch(epoch);
    const admittedBps = integer(result.admittedBps, 'admittedBps');
    if (result.sourceBudgetBps !== sourceBudgetBps || admittedBps > sourceBudgetBps) throw new TypeError('Relay budget response is inconsistent');
    configuredBudgetBps = sourceBudgetBps;
    return { sourceBudgetBps, admittedBps };
    } finally { budgetUpdating = false; }
  });
  app.once('will-quit', () => { active?.child.kill(); });
  process.once('exit', () => { active?.child.kill(); });
}

/** @returns {Promise<RelayStats>} */
async function relayStats() {
  if (starting) await starting;
  const child = active;
  if (!child || child.stopping) return { running: false, pid: null, heapBytes: 0, cpuTimeSeconds: null, sourceBudgetBps: configuredBudgetBps ?? 0, admittedBps: 0, sessions: [] };
  /** @type {JsonObject} */ let raw;
  try { raw = object(await request(child, 'GET', '/stats', null), 'relay stats'); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || !['ECONNRESET', 'ECONNREFUSED', 'EPIPE'].includes(String(error.code))) throw error;
    let exited = false;
    /** @type {ReturnType<typeof setTimeout>|null} */ let timer = null;
    try { await Promise.race([child.exited.then(() => { exited = true; }), new Promise(resolve => { timer = setTimeout(resolve, 250); })]); }
    finally { if (timer) clearTimeout(timer); }
    if (!exited) throw error;
    console.warn('screen_relay_stats_process_exited', { pid: child.child.pid, code: error.code, message: error.message });
    return { running: false, pid: null, heapBytes: 0, cpuTimeSeconds: null, sourceBudgetBps: configuredBudgetBps ?? 0, admittedBps: 0, sessions: [] };
  }
  if (raw.pid !== child.child.pid || !Array.isArray(raw.sessions) || raw.sessions.length > 40) throw new TypeError('Relay stats PID or session bound is invalid');
  const sessions = raw.sessions.map(/** @returns {RelaySession} */ value => {
    const row = object(value, 'session');
    if (row.role !== 'publish' && row.role !== 'subscribe') throw new TypeError('Invalid relay session role');
    return { id: identifier(row.id, 'session.id'), role: row.role, source: identifier(row.source, 'session.source'), state: text(row.state, 'session.state', 32), codec: text(row.codec, 'session.codec', 32), rtpBytes: integer(row.rtpBytes, 'rtpBytes'), rtpPackets: integer(row.rtpPackets, 'rtpPackets'), wireRtpBytesSent: integer(row.wireRtpBytesSent, 'wireRtpBytesSent'), wireRtpBytesReceived: integer(row.wireRtpBytesReceived, 'wireRtpBytesReceived'), lastPacketAt: row.lastPacketAt === null ? null : text(row.lastPacketAt, 'lastPacketAt', 64), diagnostic: text(row.diagnostic, 'diagnostic', 128), queueBytes: integer(row.queueBytes, 'queueBytes'), duplicatePackets: integer(row.duplicatePackets, 'duplicatePackets'), repairedPackets: integer(row.repairedPackets, 'repairedPackets'), filteredRepairNacks: integer(row.filteredRepairNacks, 'filteredRepairNacks'), outsideRepairWindowPackets: integer(row.outsideRepairWindowPackets, 'outsideRepairWindowPackets'), admission: admission(row.admission) };
  });
  return { running: true, pid: integer(raw.pid, 'pid'), heapBytes: integer(raw.heapBytes, 'heapBytes'), cpuTimeSeconds: raw.cpuTimeSeconds === null ? null : gauge(raw.cpuTimeSeconds, 'cpuTimeSeconds'), sourceBudgetBps: integer(raw.sourceBudgetBps, 'sourceBudgetBps'), admittedBps: integer(raw.admittedBps, 'admittedBps'), sessions };
}

module.exports = { installScreenRelay, stopScreenRelay, setScreenRelayRoom };
