// @ts-check
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {generateKeyPairSync,sign} from 'node:crypto';
import identityProtocol from '../lib/server-identity.cjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER_PATH = path.join(ROOT, 'server.js');
const PASSWORD = 'network-session-test-pass';
const TURN_SECRET = 'network-session-test-turn-secret';
const TOKEN_WAIT_MS = 5000;

/** @typedef {Record<string, unknown>} Message */
/** @typedef {{ws: WebSocket, inbox: Message[], send: (message: Message) => void, wait: (type: string, predicate?: (message: Message) => boolean, timeoutMs?: number) => Promise<Message>, waitClosed: () => Promise<void>, close: () => Promise<void>}} Client */

async function reservePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function serverEnvironment(port, dataDir) {
  const isolatedKeys = new Set([
    'PORT', 'HTTP_PORT', 'HTTP_HOST', 'HTTPS_PORT', 'HTTPS_PORTS', 'HTTPS_HOST', 'ECHO_DATA_DIR',
    'ECHO_PASSWORD', 'ECHO_NETWORK_MODE', 'ECHO_MEDIA_POLICY', 'ECHO_STUN_URL', 'ECHO_STUN_URLS',
    'ECHO_TURN_URL', 'ECHO_TURN_SECRET', 'ECHO_TURN_TTL_SECONDS', 'STUN_URL', 'STUN_URLS',
    'TURN_URL', 'TURN_SECRET', 'TURN_TTL_SECONDS', 'TURN_USERNAME', 'TURN_CREDENTIAL',
  ]);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !isolatedKeys.has(key)));
  return {
    ...inherited,
    PORT: String(port),
    HTTP_HOST: '127.0.0.1',
    HTTPS_PORTS: '0',
    ECHO_DATA_DIR: dataDir,
    ECHO_PASSWORD: PASSWORD,
    ECHO_NETWORK_MODE: 'server',
    ECHO_MEDIA_POLICY: 'relay-allowed',
    TURN_URL: 'turn:127.0.0.1:3478',
    TURN_SECRET,
    TURN_TTL_SECONDS: '60',
  };
}

function launchServer(port, dataDir) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    env: serverEnvironment(port, dataDir),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  return { child, getOutput: () => output };
}

async function waitForHealth(baseUrl, child, getOutput) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null && child.exitCode !== undefined) throw new Error(`Server exited before becoming ready: ${getOutput()}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Server readiness timed out: ${getOutput()}`);
}

async function stopServer(child) {
  if (child.exitCode !== null && child.exitCode !== undefined) return;
  child.kill();
  const exited = once(child, 'exit').then(() => true);
  let timeoutHandle;
  const timedOut = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve(false), 3000);
  });
  const stopped = await Promise.race([exited, timedOut]);
  clearTimeout(timeoutHandle);
  if (!stopped) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

/** @param {string} wsUrl @returns {Promise<Client>} */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  /** @type {Message[]} */
  const inbox = [];
  /** @type {{type: string, predicate: (message: Message) => boolean, resolve: (message: Message) => void, reject: (error: Error) => void, timer: NodeJS.Timeout}[]} */
  const waiters = [];
  ws.addEventListener('message', (event) => {
    assert.equal(typeof event.data, 'string');
    const message = JSON.parse(event.data);
    inbox.push(message);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (message.t === waiter.type && waiter.predicate(message)) {
        waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed.')), { once: true });
  });
  const closed = new Promise((resolve) => ws.addEventListener('close', () => resolve(), { once: true }));
  await opened;

  return {
    ws,
    inbox,
    send(message) {
      ws.send(JSON.stringify(message));
    },
    wait(type, predicate = () => true, timeoutMs = TOKEN_WAIT_MS) {
      const existing = inbox.find((message) => message.t === type && predicate(message));
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          type,
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error(`Timed out waiting for WebSocket message ${type}.`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    waitClosed() {
      return closed;
    },
    async close() {
      if (ws.readyState === WebSocket.CLOSED) return;
      ws.close();
      await closed;
    },
  };
}

/** @param {Client} client @param {string} type @param {(message: Message) => boolean} predicate @param {number} timeoutMs */
async function assertNoMessage(client, type, predicate, timeoutMs = 250) {
  const baseline = client.inbox.length;
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  assert.equal(client.inbox.slice(baseline).some((message) => message.t === type && predicate(message)), false, `Unexpected ${type} message.`);
}

/** @param {Client} client @param {string} token @param {boolean} resumable */
function sendHello(client, token, resumable) {
  client.send({ t: 'hello', name: 'Network session', password: PASSWORD, resumable, ...(token ? { resumeToken: token } : {}) });
}

test('network session auth, resume, room signaling, and persisted identity survive a server restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepscord-network-session-'));
  const resolvedDataDir = path.resolve(dataDir);
  const expectedParent = path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolvedDataDir), expectedParent);
  assert.match(path.basename(resolvedDataDir), /^deepscord-network-session-/);

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  /** @type {Client[]} */
  const clients = [];
  let server = launchServer(port, dataDir);
  try {
    await waitForHealth(baseUrl, server.child, server.getOutput);

    const publicResponse = await fetch(`${baseUrl}/api/config`);
    assert.equal(publicResponse.status, 200);
    const publicConfig = await publicResponse.json();
    assert.deepEqual(Object.keys(publicConfig).sort(), ['iceTransportPolicy', 'mediaPolicy', 'networkMode', 'requirePassword', 'version', 'screen'].sort());
    assert.deepEqual(publicConfig.screen, { mode: 'peer-relay' });
    assert.equal(publicConfig.requirePassword, true);
    assert.equal(publicConfig.networkMode, 'server');
    assert.equal('iceServers' in publicConfig, false);
    assert.equal(JSON.stringify(publicConfig).includes(TURN_SECRET), false);

    const wrongPassword = await connect(wsUrl);
    clients.push(wrongPassword);
    wrongPassword.send({ t: 'hello', name: 'Wrong password', password: 'wrong', resumable: true });
    await wrongPassword.wait('authFailed');
    await assertNoMessage(wrongPassword, 'welcome', () => true);
    wrongPassword.send({ t: 'hello', name: 'Missing password', resumable: true });
    await wrongPassword.wait('authFailed', (message) => String(message.message).includes('口令'));
    await assertNoMessage(wrongPassword, 'resumeRejected', () => true);

    const alice = await connect(wsUrl);
    clients.push(alice);
    sendHello(alice, '', true);
    const firstWelcome = await alice.wait('welcome');
    const userId = firstWelcome.selfId;
    let resumeToken = firstWelcome.resumeToken;
    assert.match(userId, /^u-[a-f0-9]{10}$/);
    assert.equal(typeof resumeToken, 'string');
    assert.equal(firstWelcome.you.signalConnected, true);
    assert.equal(firstWelcome.config.requirePassword, true);
    assert.equal(firstWelcome.config.networkMode, 'server');
    assert.ok(Array.isArray(firstWelcome.config.iceServers));
    assert.equal(typeof firstWelcome.config.iceExpiresAt, 'number');
    assert.equal(JSON.stringify(firstWelcome.config).includes(TURN_SECRET), false);
    const challenge=identityProtocol.parseIdentityChallenge(JSON.parse(JSON.stringify(await alice.wait('identityChallenge'))));
    const pair=generateKeyPairSync('ed25519'),memberKey=pair.publicKey.export({format:'der',type:'spki'}).toString('base64');
    alice.send({t:'identityProof',nonce:challenge.nonce,memberKey,signature:sign(null,Buffer.from(identityProtocol.identityPayload(challenge)),pair.privateKey).toString('base64')});
    await alice.wait('serverState',message=>message.selfKey===memberKey);
    alice.send({t:'claimOwner',token:fs.readFileSync(path.join(dataDir,'owner-claim.txt'),'utf8').trim()});
    await alice.wait('serverState',message=>JSON.parse(JSON.stringify(message.policy)).ownerKey===memberKey);

    const bob = await connect(wsUrl);
    clients.push(bob);
    sendHello(bob, '', true);
    const bobWelcome = await bob.wait('welcome');

    const legacy = await connect(wsUrl);
    clients.push(legacy);
    legacy.send({ t: 'hello', name: 'Legacy client', password: PASSWORD });
    const legacyWelcome = await legacy.wait('welcome');
    await alice.wait('userJoined', (message) => message.user.id === legacyWelcome.selfId);
    const legacyLeft = alice.wait('userLeft', (message) => message.id === legacyWelcome.selfId);
    await legacy.close();
    await legacyLeft;

    const attacker = await connect(wsUrl);
    clients.push(attacker);
    sendHello(attacker, resumeToken, true);
    const activeRejection = await attacker.wait('resumeRejected');
    assert.equal(activeRejection.code, 'session_active');
    await assertNoMessage(attacker, 'welcome', () => true);

    const invalidResume = await connect(wsUrl);
    clients.push(invalidResume);
    sendHello(invalidResume, `${resumeToken.slice(0, -1)}${resumeToken.endsWith('0') ? '1' : '0'}`, true);
    const invalidRejection = await invalidResume.wait('resumeRejected');
    assert.equal(invalidRejection.code, 'token_signature');
    await assertNoMessage(invalidResume, 'welcome', () => true);

    alice.send({ t: 'refreshNetwork' });
    const refreshed = await alice.wait('networkConfig');
    assert.ok(Array.isArray(refreshed.config.iceServers));
    assert.equal(typeof refreshed.config.iceExpiresAt, 'number');
    assert.equal(JSON.stringify(refreshed.config).includes(TURN_SECRET), false);

    alice.send({ t: 'createChannel', serverId: 'srv-main', type: 'voice', name: 'Resume capacity', userLimit: 1 });
    const channelUpdate = await alice.wait('servers', (message) => message.servers[0].channels.some((channel) => channel.name === 'Resume capacity'));
    const limitedChannel = channelUpdate.servers[0].channels.find((channel) => channel.name === 'Resume capacity');
    assert.ok(limitedChannel);
    alice.send({ t: 'joinVoice', channelId: limitedChannel.id });
    await alice.wait('voicePeers', (message) => message.channelId === limitedChannel.id);
    bob.send({ t: 'joinVoice', channelId: limitedChannel.id });
    const capacityError = await bob.wait('error', (message) => message.action === 'joinVoice' && message.channelId === limitedChannel.id);
    assert.match(String(capacityError.message), /人数已满/);

    alice.send({ t: 'leaveVoice' });
    await bob.wait('voiceState', (message) => message.userId === userId && message.channelId === null);

    const lobbyId = 'ch-lobby';
    const otherRoomId = 'ch-night-voice';
    alice.send({ t: 'joinVoice', channelId: lobbyId });
    await alice.wait('voicePeers', (message) => message.channelId === lobbyId);
    bob.send({ t: 'joinVoice', channelId: lobbyId });
    await bob.wait('voicePeers', (message) => message.channelId === lobbyId);
    const charlie = await connect(wsUrl);
    clients.push(charlie);
    sendHello(charlie, '', true);
    const charlieWelcome = await charlie.wait('welcome');
    charlie.send({ t: 'joinVoice', channelId: otherRoomId });
    await charlie.wait('voicePeers', (message) => message.channelId === otherRoomId);

    alice.send({ t: 'signal', to: bobWelcome.selfId, data: { type: 'offer', sdp: 'same-room-offer' } });
    const sameRoomSignal = await bob.wait('signal', (message) => message.from === userId);
    assert.equal(sameRoomSignal.data.sdp, 'same-room-offer');
    alice.send({ t: 'signal', to: charlieWelcome.selfId, data: { type: 'offer', sdp: 'cross-room-offer' } });
    await assertNoMessage(charlie, 'signal', (message) => message.data?.sdp === 'cross-room-offer');
    charlie.send({ t: 'signal', to: userId, data: { type: 'offer', sdp: 'reverse-cross-room-offer' } });
    await assertNoMessage(alice, 'signal', (message) => message.data?.sdp === 'reverse-cross-room-offer');

    const connectionDown = bob.wait('userConnection', (message) => message.id === userId && message.connected === false);
    await alice.close();
    const disconnected = await connectionDown;
    assert.equal(disconnected.connected, false);
    await assertNoMessage(bob, 'userLeft', (message) => message.id === userId);
    await assertNoMessage(bob, 'voiceState', (message) => message.userId === userId && message.channelId === null);

    const resumedAlice = await connect(wsUrl);
    clients.push(resumedAlice);
    sendHello(resumedAlice, resumeToken, true);
    const resumedWelcome = await resumedAlice.wait('welcome');
    resumeToken = resumedWelcome.resumeToken;
    assert.equal(resumedWelcome.selfId, userId);
    assert.equal(resumedWelcome.you.voiceChannelId, lobbyId);
    assert.equal(resumedWelcome.you.signalConnected, true);
    await bob.wait('userConnection', (message) => message.id === userId && message.connected === true);

    resumedAlice.send({ t: 'signal', to: bobWelcome.selfId, data: { type: 'answer', sdp: 'resumed-signal' } });
    const resumedSignal = await bob.wait('signal', (message) => message.from === userId && message.data?.sdp === 'resumed-signal');
    assert.equal(resumedSignal.data.sdp, 'resumed-signal');

    resumedAlice.send({ t: 'leaveVoice' });
    await bob.wait('voiceState', (message) => message.userId === userId && message.channelId === null);

    resumedAlice.send({ t: 'joinVoice', channelId: lobbyId });
    await resumedAlice.wait('voicePeers', (message) => message.channelId === lobbyId);
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const client of clients) await client.close();
    clients.length = 0;
    await stopServer(server.child);

    server = launchServer(port, dataDir);
    await waitForHealth(baseUrl, server.child, server.getOutput);
    const restartedAlice = await connect(wsUrl);
    clients.push(restartedAlice);
    sendHello(restartedAlice, resumeToken, true);
    const restartedWelcome = await restartedAlice.wait('welcome');
    assert.equal(restartedWelcome.selfId, userId);
    assert.equal(restartedWelcome.you.voiceChannelId, null);
    restartedAlice.send({ t: 'joinVoice', channelId: lobbyId });
    const rejoinedPeers = await restartedAlice.wait('voicePeers', (message) => message.channelId === lobbyId);
    assert.deepEqual(rejoinedPeers.peers, []);
    assert.equal(restartedWelcome.config.requirePassword, true);
  } finally {
    for (const client of clients) {
      try {
        await client.close();
      } catch {
        client.ws.close();
      }
    }
    await stopServer(server.child);
    assert.equal(path.dirname(resolvedDataDir), expectedParent);
    assert.match(path.basename(resolvedDataDir), /^deepscord-network-session-/);
    fs.rmSync(resolvedDataDir, { recursive: true, force: true });
  }
});
