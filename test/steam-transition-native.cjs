// @ts-check
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { SteamClient } = require('../desktop/steam-client.cjs');
const { createSteamRoom, joinSteamRoom } = require('../desktop/steam-room.cjs');
const { parseSteamInvite } = require('../desktop/steam-wire.cjs');

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{[key:string]:JsonValue}} Message */
/** @typedef {{socket:WebSocket,inbox:Message[],failure:()=>Error|null}} LocalPeer */
/** @typedef {Awaited<ReturnType<typeof createSteamRoom>>} Room */

/** @param {()=>boolean} condition @param {()=>Error|null} failure @param {string} label @returns {Promise<void>} */
async function until(condition, failure, label) {
  const deadline = Date.now() + 8000;
  while (!condition()) {
    const error = failure();
    if (error) throw error;
    if (Date.now() >= deadline) throw new Error(`Steam transition native acceptance timed out: ${label}`);
    await delay(20);
  }
}

/** @param {Message[]} inbox @param {MessageEvent} event @returns {void} */
function collect(inbox, event) {
  assert.equal(typeof event.data, 'string');
  assert(Buffer.byteLength(event.data) <= 4 * 1024 * 1024 && inbox.length < 512);
  /** @type {JsonValue} */ const value = JSON.parse(event.data);
  assert(value && typeof value === 'object' && !Array.isArray(value) && typeof value.t === 'string');
  inbox.push(value);
}

/** @param {Room} room @returns {Promise<LocalPeer>} */
async function connectRoom(room) {
  const NativeWebSocket = /** @type {new(url:string,options:string[]|{headers:{Origin:string}})=>WebSocket} */ (WebSocket);
  const socket = new NativeWebSocket(room.origin.replace('http:', 'ws:') + '/ws', { headers: { Origin: room.origin } });
  /** @type {Message[]} */ const inbox = [];
  /** @type {Error|null} */ let failure = null;
  socket.addEventListener('error', () => { failure = new Error('Owned Steam bridge local socket failed'); });
  socket.addEventListener('message', event => {
    try { collect(inbox, event); }
    catch (error) { failure = error instanceof Error ? error : new TypeError('Invalid local bridge response'); }
  });
  const peer = { socket, inbox, failure: () => failure || (inbox.some(message => ['error', 'authFailed'].includes(String(message.t))) ? new Error('Owned room rejected its valid local client: ' + JSON.stringify(inbox.filter(message => ['error', 'authFailed'].includes(String(message.t))))) : null) };
  try {
    await until(() => socket.readyState === WebSocket.OPEN, peer.failure, 'local bridge socket open');
    socket.send(JSON.stringify({ t: 'hello', name: 'Transition acceptance', color: '#123456', password: parseSteamInvite(room.invite).token, resumable: true }));
    await until(() => inbox.some(message => message.t === 'welcome'), peer.failure, 'authenticated old room welcome');
    return peer;
  } catch (error) { socket.close(); throw error; }
}

/** @param {LocalPeer} peer @param {number} sequence @returns {Promise<void>} */
async function roundTrip(peer, sequence) {
  assert.equal(peer.socket.readyState, WebSocket.OPEN);
  peer.socket.send(JSON.stringify({ t: 'ping', ts: sequence }));
  await until(() => peer.inbox.some(message => message.t === 'pong' && message.ts === sequence), peer.failure, `old backend round trip ${sequence}`);
}

/** @returns {Promise<{checks:string[],metadataEvents:number,deadJoinFailures:number}>} */
async function clientOverlap() {
  /** @type {import('../desktop/steam-client.cjs').SteamEvent[]} */ const events = [];
  /** @type {string[]} */ const checks = [];
  const old = new SteamClient(480, event => events.push(event));
  let deadJoinFailures = 0;
  try {
    const first = await old.create();
    assert.equal(first.ownerId, old.selfId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const candidate = new SteamClient(480, () => {});
      /** @type {string} */ let deadId;
      try {
        const second = await candidate.create();
        deadId = second.lobbyId;
        assert.notEqual(deadId, first.lobbyId);
        assert.deepEqual(old.members(), [old.selfId]);
        assert.deepEqual(candidate.members(), [old.selfId]);
        assert.equal(old.authority().ownerId, old.selfId);
        assert.equal(candidate.authority().ownerId, old.selfId);
      } finally { candidate.dispose(); }
      assert.deepEqual(old.members(), [old.selfId]);
      const joining = new SteamClient(480, () => {});
      try {
        await assert.rejects(joining.join(deadId));
        assert.deepEqual(joining.members(), []);
        deadJoinFailures += 1;
      } finally { joining.dispose(); }
      const epoch = randomBytes(16).toString('hex');
      const before = events.length;
      old.claimAuthority(epoch);
      await until(() => events.slice(before).some(event => event.type === 'members' && event.epoch === epoch), () => null, 'old authority update after candidate disposal');
      await delay(150);
      assert.deepEqual(old.authority(), { ownerId: old.selfId, epoch });
      assert.deepEqual(old.publishedAuthority(), { ownerId: old.selfId, epoch });
      assert.deepEqual(old.members(), [old.selfId]);
    }
    assert(!events.some(event => event.type === 'error'));
    checks.push('two invisible native lobbies overlap in one process without removing old owner membership');
    checks.push('two disposed candidate lobby joins fail while old owner remains joined and publishes fresh authority');
    checks.push('old connector membership notifications and native metadata reads remain functional after candidate callback unsubscription');
    return { checks, metadataEvents: events.filter(event => event.type === 'members').length, deadJoinFailures };
  } finally { old.dispose(); }
}

/** @param {string} directory @returns {Promise<string[]>} */
async function bridgeOverlap(directory) {
  const root = path.resolve(__dirname, '..');
  const paths = { userData: path.join(directory, 'user-data'), serverDirectory: root, executable: process.execPath };
  /** @type {string[]} */ const failures = [];
  /** @type {Room[]} */ const rooms = [];
  /** @type {LocalPeer|null} */ let peer = null;
  try {
    const old = await createSteamRoom({ appId: 480, stunUrls: [] }, paths, message => failures.push(message));
    rooms.push(old);
    peer = await connectRoom(old);
    await roundTrip(peer, 1);
    const candidate = await createSteamRoom({ appId: 480, stunUrls: [] }, paths, message => failures.push(message));
    rooms.push(candidate);
    assert.notEqual(old.lobbyId, candidate.lobbyId);
    assert.equal(old.role, 'host');
    assert.equal(candidate.role, 'host');
    await roundTrip(peer, 2);
    await candidate.stop();
    rooms.pop();
    await roundTrip(peer, 3);
    await assert.rejects(joinSteamRoom(candidate.invite, paths, message => failures.push(message)));
    await roundTrip(peer, 4);
    assert.equal(old.role, 'host');
    assert.deepEqual(failures, []);
    return ['two production SteamRoomBridge instances create real local backends while old authenticated socket remains usable', 'candidate stop and dead candidate invitation failure preserve four old backend ping/pong round trips and native host ownership'];
  } finally {
    peer?.socket.close();
    const results = await Promise.allSettled(rooms.map(room => room.stop()));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}

/** @param {string} directory @returns {Promise<void>} */
async function worker(directory) {
  const startedAt = Date.now();
  const resultPath = path.join(directory, 'result.json');
  try {
    const native = await clientOverlap();
    const bridgeChecks = await bridgeOverlap(directory);
    const result = { status: 'passed', appId: 480, checks: [...native.checks, ...bridgeChecks], metadataEvents: native.metadataEvents, deadJoinFailures: native.deadJoinFailures + 1, elapsedMs: Date.now() - startedAt, scope: 'Single real Steam account; invisible owned lobbies only. Local authority notifications plus native metadata reads verified; callback delivery is not isolated from production polling. Remote accounts, remote P2P and owner migration are outside this test.' };
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ event: 'steam-transition-native-passed', ...result, resultPath }));
  } catch (error) {
    fs.writeFileSync(resultPath, JSON.stringify({ status: 'failed', name: error instanceof Error ? error.name : 'NonErrorFailure', message: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - startedAt }, null, 2) + '\n');
    throw error;
  }
}

/** @param {string} directory @returns {Promise<void>} */
async function launch(directory) {
  const child = spawn(process.execPath, [__filename, '--worker', directory], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  await new Promise((resolve, reject) => {
    /** @type {Error|null} */ let timeout = null;
    const timer = setTimeout(() => {
      timeout = new Error('Owned native Steam transition worker exceeded 90000ms');
      assert(child.pid && child.exitCode === null);
      const stopped = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      if (stopped.error || stopped.status !== 0) {
        clearTimeout(timer);
        reject(stopped.error || new Error(`Owned Steam worker tree cleanup failed: ${stopped.stderr}`));
      }
    }, 90000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (timeout) reject(timeout);
      else if (code !== 0) reject(new Error(`Native Steam transition subprocess failed; status=${code}, signal=${signal}`));
      else resolve(undefined);
    });
  });
}

if (process.argv[2] === '--worker') {
  const directory = process.argv[3];
  assert.equal(typeof directory, 'string');
  worker(directory).then(() => process.exit(0), error => {
    console.error('steam_transition_native_failed', { message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
} else {
  const directory = path.join(__dirname, '..', '.qa-tools', 'host-continuity', 'steam-transition-native', randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  launch(directory).catch(error => {
    console.error('steam_transition_native_process_failed', { message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}
