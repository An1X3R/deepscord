// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import state from '../lib/steam-state.cjs';
import continuity from '../desktop/steam-continuity.cjs';
import replica from '../lib/room-replica.cjs';
import {parseIdentityChallenge,identityPayload} from '../lib/server-identity.cjs';
import {parseGovernance,governancePayload,appendGovernance,governanceState} from '../lib/server-governance.cjs';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{[key:string]:JsonValue}} Message */
/** @typedef {import('../lib/steam-state.cjs').RoomStore} RoomStore */
/** @typedef {import('../lib/steam-state.cjs').SteamPublicUser} SteamPublicUser */
/** @typedef {{t:'steam-state',store:RoomStore,users:SteamPublicUser[],roomDocument:import('../lib/room-replica.cjs').RoomDocument}} Snapshot */
/** @typedef {{code:number|null,signal:NodeJS.Signals|null}} Exit */
/** @typedef {{child:import('node:child_process').ChildProcess,origin:string,directory:string,snapshots:Snapshot[],fatal:()=>Error|null,output:()=>string,exited:Promise<Exit>}} Backend */
/** @typedef {{socket:WebSocket,inbox:Message[],fatal:()=>Error|null,closed:Promise<void>}} Client */
/** @typedef {{selfId:string,you:SteamPublicUser,users:SteamPublicUser[],store:RoomStore,resumeToken:string}} Welcome */

const { parseSteamStore, parseSteamUsers, parseSteamCheckpoint, stableSteamUserId, signSteamIdentity } = state;
const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = path.join(root, '.qa-tools', 'host-continuity');
const lobbyId = '109775244000000001';
const steamA = '76561198000000001', steamB = '76561198000000002';
const steamC = '76561198000000003';
const idA = stableSteamUserId(steamA), idB = stableSteamUserId(steamB);

/** @param {JsonValue} value @returns {Message} */
function object(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Backend message must be a JSON object.');
  return value;
}

/** @param {JsonValue} value @param {string} field @returns {string} */
function string(value, field) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${field} must be a nonempty string.`);
  return value;
}

/** @param {() => boolean} condition @param {() => Error|null} fatal @param {string} description @returns {Promise<void>} */
async function until(condition, fatal, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const error = fatal(); if (error) throw error;
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Steam backend integration exceeded five seconds: ${description}`);
}

/** @returns {Promise<number>} */
async function reservePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', () => resolve(undefined)); });
  const address = listener.address(); assert(address && typeof address !== 'string');
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve(undefined)));
  return address.port;
}

/** @param {JsonValue} value @returns {Snapshot} */
function parseSnapshot(value) {
  const input = object(value);
  assert.equal(input.t, 'steam-state');
  const store = parseSteamStore(input.store), users = parseSteamUsers(input.users, store);
  const rawDocument = object(input.roomDocument);
  const descriptor = replica.parseRoomDescriptor(rawDocument);
  const roomDocument = replica.parseRoomDocument(rawDocument, descriptor);
  /** @type {Snapshot} */ const clean = { t: 'steam-state', store, users, roomDocument };
  assert(isDeepStrictEqual(value, clean), 'IPC snapshot contains fields outside the approved store/users schema');
  return clean;
}

/** @param {number} port @param {string} directory @param {Buffer} key @param {string} password @param {import('../lib/steam-state.cjs').SteamRoomSeed} roomSeed @returns {Promise<Backend>} */
async function launch(port, directory, key, password, roomSeed) {
  const seed = state.parseSteamRoomSeed(roomSeed), seedPath = path.join(directory, 'room-seed.json');
  await fs.writeFile(seedPath, JSON.stringify(seed.document), { flag: 'wx' });
  const excluded = /^(?:PORT|HTTP_|HTTPS_|ECHO_|STUN_|TURN_|HISTORY_LIMIT)/;
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !excluded.test(name)));
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...inherited, PORT: String(port), HTTP_HOST: '127.0.0.1', HTTPS_PORTS: '0', ECHO_DATA_DIR: directory, ECHO_PASSWORD: password, ECHO_NETWORK_MODE: 'server', ECHO_MEDIA_POLICY: 'direct', ECHO_SCREEN_MODE: 'peer-relay', STUN_URLS: '', ECHO_STEAM_LOBBY_ID: lobbyId, ECHO_STEAM_BRIDGE_KEY: key.toString('hex'), ECHO_ROOM_ID: seed.roomId, ECHO_ROOM_CREATOR_KEY: seed.creatorKey, ECHO_ROOM_SEED_PATH: seedPath },
  });
  /** @type {Snapshot[]} */ const snapshots = [];
  /** @type {Error|null} */ let failure = null;
  let output = '';
  const collect = (/** @type {Buffer} */ chunk) => {
    const text = chunk.toString('utf8');
    if (output.length + text.length > 256 * 1024) { failure = new RangeError('Backend integration log exceeded 256 KiB'); return; }
    output += text;
  };
  child.stdout?.on('data', collect); child.stderr?.on('data', collect);
  child.once('error', error => { failure = error; });
  child.on('message', (/** @type {JsonValue} */ value) => {
    try {
      if (snapshots.length >= 128) throw new RangeError('Backend integration snapshot count exceeded 128');
      snapshots.push(parseSnapshot(value));
    } catch (error) { failure = error instanceof Error ? error : new Error('Non-Error IPC schema failure'); }
  });
  /** @type {Promise<Exit>} */
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, origin: 'http://127.0.0.1:' + port, directory, snapshots, fatal: () => failure, output: () => output, exited };
}

/** @param {Backend} backend @returns {Promise<void>} */
async function ready(backend) {
  for (let attempt = 1; attempt <= 60; attempt++) {
    const error = backend.fatal(); if (error) throw error;
    if (backend.child.exitCode !== null || backend.child.signalCode !== null) throw new Error('Backend exited before readiness: ' + backend.output());
    try {
      const response = await fetch(backend.origin + '/api/health', { signal: AbortSignal.timeout(1000) });
      assert.equal(response.status, 200);
      /** @type {JsonValue} */ const value = await response.json();
      assert.equal(object(value).ok, true);
      return;
    } catch (error) {
      if (!(error instanceof TypeError) || !String(error.cause).includes('ECONNREFUSED')) throw error;
      if (attempt === 1 || attempt % 20 === 0) console.warn(JSON.stringify({ event: 'steam_backend_startup_retry', attempt, reason: 'listener-not-ready' }));
      if (attempt === 60) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

/** @param {Backend} backend @param {Message} message @returns {Promise<void>} */
async function control(backend, message) {
  await new Promise((resolve, reject) => backend.child.send(message, error => error ? reject(error) : resolve(undefined)));
}

/** @param {Backend} backend @param {number} after @param {(snapshot:Snapshot)=>boolean} predicate @returns {Promise<Snapshot>} */
async function matchingSnapshot(backend, after, predicate) {
  await until(() => backend.snapshots.slice(after).some(predicate), backend.fatal, 'matching private IPC snapshot');
  const value = backend.snapshots.slice(after).find(predicate); assert(value);
  return value;
}

/** @param {Backend} backend @returns {Promise<Snapshot>} */
async function requestSnapshot(backend) {
  const after = backend.snapshots.length;
  await control(backend, { t: 'steam-snapshot' });
  return matchingSnapshot(backend, after, () => true);
}

/** @param {string} origin @returns {Promise<Client>} */
async function connect(origin) {
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws');
  /** @type {Message[]} */ const inbox = [];
  /** @type {Error|null} */ let failure = null;
  socket.addEventListener('error', () => { failure = new Error('Actual backend WebSocket reported an error'); });
  socket.addEventListener('message', event => {
    try {
      if (typeof event.data !== 'string' || Buffer.byteLength(event.data, 'utf8') > 4 * 1024 * 1024 || inbox.length >= 512) throw new RangeError('WebSocket test input exceeded its bounds');
      /** @type {JsonValue} */ const value = JSON.parse(event.data);
      const row = object(value); assert.equal(typeof row.t, 'string'); inbox.push(row);
    } catch (error) { failure = error instanceof Error ? error : new Error('Non-Error WebSocket schema failure'); }
  });
  /** @type {Promise<void>} */ const closed = new Promise(resolve => socket.addEventListener('close', () => resolve(), { once: true }));
  await until(() => socket.readyState === WebSocket.OPEN, () => failure, 'WebSocket open');
  return { socket, inbox, fatal: () => failure, closed };
}

/** @param {Client} client @param {Message} message @returns {void} */
function send(client, message) { client.socket.send(JSON.stringify(message)); }

/** @param {Client} client @param {string} type @param {number} after @returns {Promise<Message>} */
async function waitMessage(client, type, after) {
  await until(() => {
    const messages = client.inbox.slice(after);
    if (type === 'welcome') {
      const rejected = messages.find(message => ['error', 'authFailed', 'resumeRejected'].includes(String(message.t)));
      if (rejected) throw new Error('WebSocket welcome rejected: ' + JSON.stringify({ type: rejected.t, code: rejected.code, message: rejected.message }));
    }
    return messages.some(message => message.t === type);
  }, client.fatal, 'WebSocket ' + type);
  const value = client.inbox.slice(after).find(message => message.t === type); assert(value);
  return value;
}

/** @param {Client} creator @param {Client} newest @param {import('node:crypto').KeyObject} privateKey @param {boolean} fresh @returns {Promise<void>} */
async function commitCreatorVote(creator, newest, privateKey, fresh) {
  await waitMessage(newest, 'roomSyncOffer', 0);
  const offer = newest.inbox.filter(message => message.t === 'roomSyncOffer').at(-1); assert(offer);
  const descriptor = replica.parseRoomDescriptor(offer.descriptor), document = replica.parseRoomDocument(offer.document, descriptor);
  assert.equal(typeof offer.roundId, 'string');
  const roundId = /** @type {string} */ (offer.roundId), memberKey = descriptor.creatorKey;
  const signature = sign(null, Buffer.from(replica.roomVotePayload(roundId, memberKey, document, fresh)), privateKey).toString('base64');
  const after = creator.inbox.length;
  send(creator, { t: 'roomSyncVote', roundId, memberKey, document, signature, fresh });
  const committed = await waitMessage(creator, 'roomSyncCommit', after);
  assert.equal(committed.reason, 'creator');
  assert.deepEqual(replica.parseRoomDocument(committed.document, descriptor), { ...document, revision: document.revision + 1 });
}

/** @param {Client} client @param {Buffer} key @param {string} steamId @param {SteamPublicUser} profile @param {string} password @param {string|null} resumeToken @returns {Promise<Welcome>} */
async function hello(client, key, steamId, profile, password, resumeToken) {
  send(client, { t: 'hello', name: profile.name, color: profile.color, ...(profile.profileId === null ? {} : { profileId: profile.profileId }), avatar: profile.avatar, password, resumable: true, steamIdentity: signSteamIdentity(key, lobbyId, steamId, randomBytes(16).toString('hex')), ...(resumeToken === null ? {} : { resumeToken }) });
  const response = await waitMessage(client, 'welcome', 0);
  const store = parseSteamStore({ version: 1, servers: response.servers, messages: response.messages });
  const users = parseSteamUsers(response.users, store), you = parseSteamUsers([response.you], store)[0];
  return { selfId: string(response.selfId, 'selfId'), you, users, store, resumeToken: string(response.resumeToken, 'resumeToken') };
}

/** @param {Client} client @param {import('node:crypto').KeyObject} privateKey @param {string} memberKey @returns {Promise<import('../lib/server-governance.cjs').GovernanceJournal>} */
async function authenticateWorkspace(client,privateKey,memberKey) {
  const challenge=parseIdentityChallenge(await waitMessage(client,'identityChallenge',0));
  const after=client.inbox.length;
  send(client,{t:'identityProof',nonce:challenge.nonce,memberKey,signature:sign(null,Buffer.from(identityPayload(challenge)),privateKey).toString('base64')});
  await until(()=>client.inbox.slice(after).some(message=>message.t==='serverState' && message.selfKey===memberKey),client.fatal,'workspace identity acceptance');
  const accepted=client.inbox.slice(after).find(message=>message.t==='serverState' && message.selfKey===memberKey);assert(accepted);
  return parseGovernance(accepted.journal,{version:1,roomId:challenge.roomId,creatorKey:challenge.creatorKey});
}

/** @param {Client} client @param {import('node:crypto').KeyObject} privateKey @param {import('../lib/server-governance.cjs').GovernanceJournal} journal @param {import('../lib/server-governance.cjs').GovernanceCommand} command @returns {Promise<import('../lib/server-governance.cjs').GovernanceJournal>} */
async function changeGovernance(client,privateKey,journal,command) {
  const actorKey=journal.creatorKey;
  const event={revision:journal.events.length+1,previousDigest:journal.digest,actorKey,command,signature:sign(null,Buffer.from(governancePayload(journal,actorKey,command)),privateKey).toString('base64')};
  const next=appendGovernance(journal,event),after=client.inbox.length;
  send(client,{t:'governanceChange',event});
  await until(()=>client.inbox.slice(after).some(message=>message.t==='serverState' && object(message.journal).digest===next.digest),client.fatal,'signed governance acceptance');
  await waitMessage(client,'roomSyncOffer',after);
  await commitCreatorVote(client,client,privateKey,false);
  return next;
}

/** @param {Client} client @returns {Promise<void>} */
async function rejectServerCreation(client) {
  const after=client.inbox.length;
  send(client,{t:'createServer',name:'Unauthorized'});
  const error=await waitMessage(client,'error',after);
  assert.match(String(error.message),/服主|权限|身份|owner/i);
}

/** @param {Backend} backend @param {Message} fields @param {Client[]} clients @returns {Promise<void>} */
async function rejectHello(backend, fields, clients) {
  const client = await connect(backend.origin); clients.push(client);
  send(client, { t: 'hello', name: 'Untrusted', color: '#123456', resumable: true, ...fields });
  await waitMessage(client, 'authFailed', 0);
  await until(() => client.socket.readyState === WebSocket.CLOSED, client.fatal, 'invalid identity close');
  assert(!client.inbox.some(message => message.t === 'welcome'), 'Rejected native identity received a welcome');
}

/** @param {Snapshot} snapshot @param {string[]} credentials @returns {void} */
function assertNoCredentials(snapshot, credentials) {
  const text = JSON.stringify(snapshot);
  for (const credential of credentials) assert(!text.includes(credential), 'Private credential value leaked into IPC snapshot');
  /** @param {JsonValue} value @returns {void} */
  function check(value) {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(check); return; }
    for (const [key, nested] of Object.entries(value)) {
      assert(!/(?:secret|password|token|session|sessionkey|bridgekey|steamidentity|mac)$/i.test(key), 'Credential field leaked into IPC snapshot');
      check(nested);
    }
  }
  check(snapshot);
}

/** @param {Backend} backend @returns {Promise<Exit>} */
async function killBackend(backend) {
  if (backend.child.exitCode === null && backend.child.signalCode === null) assert(backend.child.kill('SIGKILL'), 'Could not force-kill the owned backend');
  /** @type {ReturnType<typeof setTimeout>|null} */ let timer = null;
  try { return await Promise.race([backend.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned backend did not exit after SIGKILL')), 3000); })]); }
  finally { if (timer !== null) clearTimeout(timer); }
}

test('actual Steam backend survives three generations with stable authenticated identities', { timeout: 30000 }, async () => {
  await fs.mkdir(evidenceRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(evidenceRoot, 'backend-'));
  const firstDirectory = path.join(directory, 'private-first'), secondDirectory = path.join(directory, 'private-restored'), thirdDirectory = path.join(directory, 'private-third');
  await fs.mkdir(firstDirectory); await fs.mkdir(secondDirectory); await fs.mkdir(thirdDirectory);
  /** @type {Backend[]} */ const backends = [];
  /** @type {Client[]} */ const clients = [];
  /** @type {string[]} */ const credentials = [];
  /** @type {string[]} */ const checks = [];
  /** @type {{pid:number,code:number|null,signal:NodeJS.Signals|null}[]} */ const exits = [];
  const password = randomBytes(24).toString('hex'), firstKey = randomBytes(32), secondKey = randomBytes(32), thirdKey = randomBytes(32);
  const creator = generateKeyPairSync('ed25519');
  const navigator=generateKeyPairSync('ed25519');
  const navigatorKey=navigator.publicKey.export({format:'der',type:'spki'}).toString('base64');
  const thirdHost=generateKeyPairSync('ed25519');
  const thirdHostKey=thirdHost.publicKey.export({format:'der',type:'spki'}).toString('base64');
  const seed = { roomId: randomUUID(), creatorKey: creator.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), document: null };
  credentials.push(password, firstKey.toString('hex'), secondKey.toString('hex'), thirdKey.toString('hex'));
  const avatar = 'data:image/jpeg;base64,' + (await fs.readFile(new URL('./fixtures/avatar-96.jpg', import.meta.url))).toString('base64');
  /** @type {SteamPublicUser} */ const profileA = { id: idA, name: 'Pilot', color: '#123456', profileId: randomUUID(), avatar: null, muted: false, deafened: false, voiceChannelId: null, signalConnected: true };
  /** @type {SteamPublicUser} */ const profileB = { ...profileA, id: idB, name: 'Navigator', profileId: null };
  /** @type {Error|null} */ let failed = null;
  try {
    const first = await launch(await reservePort(), firstDirectory, firstKey, password, seed); backends.push(first); await ready(first);
    const firstSessionKey = await fs.readFile(path.join(firstDirectory, 'session.key')); credentials.push(firstSessionKey.toString('hex'));
    const a = await connect(first.origin), b = await connect(first.origin); clients.push(a, b);
    const welcomeA = await hello(a, firstKey, steamA, profileA, password, null), welcomeB = await hello(b, firstKey, steamB, profileB, password, null);
    await commitCreatorVote(a, b, creator.privateKey, true);
    let journal=await authenticateWorkspace(a,creator.privateKey,seed.creatorKey);
    await authenticateWorkspace(b,navigator.privateKey,navigatorKey);
    await rejectServerCreation(b);
    journal=await changeGovernance(a,creator.privateKey,journal,{type:'renameServer',name:'Persistent Connection Server'});
    credentials.push(welcomeA.resumeToken, welcomeB.resumeToken);
    assert.equal(welcomeA.selfId, idA); assert.equal(welcomeB.selfId, idB); checks.push('two signed users receive stable Steam-derived IDs');
    let after = first.snapshots.length;
    send(a, { t: 'createServer', name: 'Continuity' });
    let current = await matchingSnapshot(first, after, snapshot => snapshot.store.servers.some(server => server.name === 'Continuity'));
    const server = current.store.servers.find(server => server.name === 'Continuity'); assert(server);
    journal=await changeGovernance(a,creator.privateKey,journal,{type:'setDomainOwner',domainId:server.id,memberKey:navigatorKey});
    assert.equal(governanceState(journal).ownerKey,seed.creatorKey);
    checks.push('workspace Ed25519 challenge establishes server owner; another Steam member cannot create domains; signed server name and domain owner persisted');
    after = first.snapshots.length;
    send(a, { t: 'createChannel', serverId: server.id, type: 'voice', name: 'Flight Deck', userLimit: 4 });
    current = await matchingSnapshot(first, after, snapshot => snapshot.store.servers.some(server => server.channels.some(channel => channel.name === 'Flight Deck')));
    const voice = current.store.servers.flatMap(server => server.channels).find(channel => channel.name === 'Flight Deck'); assert(voice);
    after = first.snapshots.length;
    send(a, { t: 'createChannel', serverId: server.id, type: 'text', name: 'Flight Log' });
    current = await matchingSnapshot(first, after, snapshot => snapshot.store.servers.some(server => server.channels.some(channel => channel.name === 'Flight Log')));
    const text = current.store.servers.flatMap(server => server.channels).find(channel => channel.name === 'Flight Log'); assert(text);
    send(a, { t: 'joinVoice', channelId: voice.id, muted: false, deafened: false }); await waitMessage(a, 'voicePeers', 0);
    send(b, { t: 'joinVoice', channelId: voice.id, muted: false, deafened: false });
    const peers = await waitMessage(b, 'voicePeers', 0); assert(Array.isArray(peers.peers)); assert.equal(object(peers.peers[0]).id, idA);
    await requestSnapshot(first);
    after = first.snapshots.length;
    const renamedA = { ...profileA, name: 'Captain', color: '#aa33bb', avatar };
    send(a, { t: 'rename', name: renamedA.name, color: renamedA.color, profileId: renamedA.profileId, avatar });
    send(a, { t: 'micState', muted: true, deafened: false });
    send(a, { t: 'chat', channelId: text.id, text: 'continuity-message-before-kill' });
    const saved = await matchingSnapshot(first, after, snapshot => snapshot.users.find(user => user.id === idA)?.muted === true && snapshot.store.messages[text.id]?.some(message => message.text === 'continuity-message-before-kill') === true);
    assert.equal(saved.roomDocument.roomId, seed.roomId); assert.equal(saved.roomDocument.creatorKey, seed.creatorKey);
    assert.deepEqual(saved.store.governance,journal);
    const firstCheckpoint=parseSteamCheckpoint({version:1,lobbyId,ownerId:steamA,epoch:randomBytes(16).toString('hex'),sequence:1,stunUrls:[],store:saved.store,users:saved.users,roomDocument:saved.roomDocument});
    assert.equal(firstCheckpoint.ownerId,steamA);
    const firstRecovered=continuity.decodeReplica(continuity.encodeReplica({t:'checkpoint',checkpoint:firstCheckpoint}));
    assert.equal(firstRecovered.t,'checkpoint');
    if(firstRecovered.t!=='checkpoint') throw new TypeError('First-generation checkpoint codec returned the wrong branch');
    assert.deepEqual(firstRecovered.checkpoint,firstCheckpoint);
    assert.equal(governanceState(journal).ownerKey,seed.creatorKey);
    assert.deepEqual(saved.roomDocument.servers, saved.store.servers);
    assert.equal(first.snapshots.length - after, 1, 'Semantic burst did not coalesce into one private snapshot');
    const savedA = saved.users.find(user => user.id === idA); assert(savedA);
    assert.equal(savedA.name, renamedA.name); assert.equal(savedA.avatar, avatar); assert.equal(savedA.profileId, renamedA.profileId);
    assert.equal(savedA.memberKey,seed.creatorKey);
    assert.equal(saved.users.find(user=>user.id===idB)?.memberKey,navigatorKey);
    assert(saved.users.every(user => user.signalConnected && user.voiceChannelId === voice.id));
    assert.equal(saved.store.servers.find(candidate => candidate.id === server.id)?.channels.find(channel => channel.id === voice.id)?.userLimit, 4);
    checks.push('actual channel/chat/profile/mic/voice operations emit one coalesced semantic snapshot');
    assertNoCredentials(saved, credentials); await fs.writeFile(path.join(directory, 'snapshot-before-kill.json'), JSON.stringify(saved, null, 2));
    const firstExit = await killBackend(first); assert(first.child.pid); exits.push({ pid: first.child.pid, ...firstExit });
    await Promise.all([a.closed, b.closed]); checks.push('first backend force-killed after snapshot');
    await fs.writeFile(path.join(secondDirectory, 'store.json'), JSON.stringify(parseSteamStore(firstRecovered.checkpoint.store)));
    await fs.writeFile(path.join(secondDirectory, 'steam-users.json'), JSON.stringify(parseSteamUsers(firstRecovered.checkpoint.users, firstRecovered.checkpoint.store)));
    const second = await launch(await reservePort(), secondDirectory, secondKey, password, { ...seed, document: saved.roomDocument }); backends.push(second); await ready(second);
    const secondSessionKey = await fs.readFile(path.join(secondDirectory, 'session.key')); credentials.push(secondSessionKey.toString('hex'));
    assert(!firstSessionKey.equals(secondSessionKey), 'Restart unexpectedly reused the old backend session key');
    const restored = await requestSnapshot(second);
    assert.deepEqual(restored.store, saved.store);
    assert(restored.store.governance);
    assert.equal(governanceState(restored.store.governance).ownerKey,seed.creatorKey);
    assert.equal(governanceState(restored.store.governance).name,'Persistent Connection Server');
    assert.deepEqual(restored.roomDocument, saved.roomDocument);
    assert.deepEqual(restored.users, saved.users.map(user => ({ ...user, signalConnected: false })));
    assertNoCredentials(restored, credentials); await fs.writeFile(path.join(directory, 'snapshot-restored-offline.json'), JSON.stringify(restored, null, 2));
    checks.push('fresh backend key and fresh session.key restore only approved store/user state');
    const proof = signSteamIdentity(secondKey, lobbyId, steamA, randomBytes(16).toString('hex'));
    const wrongPassword = await connect(second.origin); clients.push(wrongPassword);
    send(wrongPassword, { t: 'hello', name: 'Pilot', color: '#123456', password: 'invalid-test-password', steamIdentity: proof });
    await waitMessage(wrongPassword, 'authFailed', 0);
    assert(!wrongPassword.inbox.some(message => message.t === 'welcome'), 'Valid native proof bypassed the room password');
    wrongPassword.socket.close(); await wrongPassword.closed;
    checks.push('valid native identity still requires the room password');
    await rejectHello(second, { password, steamIdentity: { ...proof, steamId: steamB } }, clients);
    await rejectHello(second, { password, steamIdentity: signSteamIdentity(firstKey, lobbyId, steamA, randomBytes(16).toString('hex')) }, clients);
    await rejectHello(second, { password, resumeToken: welcomeA.resumeToken }, clients);
    checks.push('tampered proof, previous backend key, and resume-token-only hello rejected');
    const restoredA = await connect(second.origin), restoredB = await connect(second.origin); clients.push(restoredA, restoredB);
    const rejoinedA = await hello(restoredA, secondKey, steamA, renamedA, password, welcomeA.resumeToken);
    const rejoinedB = await hello(restoredB, secondKey, steamB, profileB, password, welcomeA.resumeToken);
    await commitCreatorVote(restoredA, restoredB, creator.privateKey, false);
    await rejectServerCreation(restoredA);
    assert.deepEqual(await authenticateWorkspace(restoredA,creator.privateKey,seed.creatorKey),journal);
    assert.deepEqual(await authenticateWorkspace(restoredB,navigator.privateKey,navigatorKey),journal);
    await rejectServerCreation(restoredB);
    credentials.push(rejoinedA.resumeToken, rejoinedB.resumeToken);
    assert.equal(rejoinedA.selfId, idA); assert.equal(rejoinedB.selfId, idB);
    assert.equal(rejoinedA.you.voiceChannelId, voice.id); assert.equal(rejoinedB.you.voiceChannelId, voice.id); assert.equal(rejoinedA.you.muted, true);
    const {governance:restoredJournal,...publicStore}=saved.store;
    assert.deepEqual(rejoinedA.store, publicStore); assert.equal(rejoinedA.you.avatar, avatar);
    assert.deepEqual(restoredJournal,journal);
    checks.push('correct native proof ignores old resume token and preserves ID/channel; another user token cannot change the signed identity');
    const final = await requestSnapshot(second); assert(final.users.every(user => user.signalConnected)); assertNoCredentials(final, credentials);
    await fs.writeFile(path.join(directory, 'snapshot-reconnected.json'), JSON.stringify(final, null, 2));
    const secondAfter = second.snapshots.length;
    send(restoredA, { t: 'chat', channelId: text.id, text: 'second-generation-new-message-for-third' });
    const secondSaved = await matchingSnapshot(second, secondAfter, snapshot => snapshot.store.messages[text.id]?.some(message => message.text === 'second-generation-new-message-for-third') === true);
    assertNoCredentials(secondSaved, credentials);
    const checkpoint = parseSteamCheckpoint({ version: 1, lobbyId, ownerId: steamB, epoch: randomBytes(16).toString('hex'), sequence: 2, stunUrls: [], store: secondSaved.store, users: secondSaved.users, roomDocument: secondSaved.roomDocument });
    assert.equal(checkpoint.ownerId,steamB);
    assert(checkpoint.store.governance);
    assert.equal(governanceState(checkpoint.store.governance).ownerKey,seed.creatorKey);
    assert.equal(governanceState(checkpoint.store.governance).domains.find(domain=>domain.id===server.id)?.ownerKey,navigatorKey);
    const recovered = continuity.decodeReplica(continuity.encodeReplica({ t: 'checkpoint', checkpoint }));
    assert.equal(recovered.t, 'checkpoint');
    if (recovered.t !== 'checkpoint') throw new TypeError('Actual second-generation checkpoint codec returned the wrong branch');
    const approved = continuity.newerCheckpoint(null, recovered.checkpoint);
    await fs.writeFile(path.join(directory, 'checkpoint-second-generation.json'), JSON.stringify(approved, null, 2));
    const secondExit = await killBackend(second); assert(second.child.pid); exits.push({ pid: second.child.pid, ...secondExit });
    await Promise.all([restoredA.closed, restoredB.closed]);
    await fs.writeFile(path.join(thirdDirectory, 'store.json'), JSON.stringify(approved.store));
    await fs.writeFile(path.join(thirdDirectory, 'steam-users.json'), JSON.stringify(approved.users));
    assert(approved.roomDocument);
    const third = await launch(await reservePort(), thirdDirectory, thirdKey, password, { ...seed, document: approved.roomDocument }); backends.push(third); await ready(third);
    const thirdSessionKey = await fs.readFile(path.join(thirdDirectory, 'session.key')); credentials.push(thirdSessionKey.toString('hex'));
    assert(!thirdSessionKey.equals(secondSessionKey) && !thirdSessionKey.equals(firstSessionKey), 'Third backend reused a prior session key');
    const thirdOffline = await requestSnapshot(third);
    assert.deepEqual(thirdOffline.roomDocument, approved.roomDocument);
    assert.deepEqual(thirdOffline.store, secondSaved.store);
    assert.deepEqual(thirdOffline.users, secondSaved.users.map(user => ({ ...user, signalConnected: false })));
    await rejectHello(third, { password, steamIdentity: signSteamIdentity(secondKey, lobbyId, steamA, randomBytes(16).toString('hex')) }, clients);
    const thirdA = await connect(third.origin), thirdB = await connect(third.origin), thirdC=await connect(third.origin); clients.push(thirdA, thirdB,thirdC);
    const thirdWelcomeA = await hello(thirdA, thirdKey, steamA, renamedA, password, rejoinedA.resumeToken);
    const thirdWelcomeB = await hello(thirdB, thirdKey, steamB, profileB, password, rejoinedB.resumeToken);
    const thirdWelcomeC=await hello(thirdC,thirdKey,steamC,{...profileB,id:stableSteamUserId(steamC),name:'Transport Host C'},password,null);
    credentials.push(thirdWelcomeC.resumeToken);
    await commitCreatorVote(thirdA, thirdC, creator.privateKey, false);
    await rejectServerCreation(thirdA);
    assert.deepEqual(await authenticateWorkspace(thirdA,creator.privateKey,seed.creatorKey),journal);
    assert.deepEqual(await authenticateWorkspace(thirdB,navigator.privateKey,navigatorKey),journal);
    assert.deepEqual(await authenticateWorkspace(thirdC,thirdHost.privateKey,thirdHostKey),journal);
    await rejectServerCreation(thirdB);
    await rejectServerCreation(thirdC);
    credentials.push(thirdWelcomeA.resumeToken, thirdWelcomeB.resumeToken);
    assert.equal(thirdWelcomeA.selfId, idA); assert.equal(thirdWelcomeB.selfId, idB);
    assert.equal(thirdWelcomeA.you.voiceChannelId, voice.id); assert.equal(thirdWelcomeB.you.voiceChannelId, voice.id);
    assert.equal(thirdWelcomeA.you.muted, true); assert.equal(thirdWelcomeA.you.avatar, avatar);
    assert(thirdWelcomeA.store.messages[text.id].some(message => message.text === 'second-generation-new-message-for-third'));
    assert(thirdWelcomeA.store.messages[text.id].some(message => message.text === 'continuity-message-before-kill'));
    const thirdFinal = await requestSnapshot(third); assertNoCredentials(thirdFinal, credentials);
    const thirdCheckpoint=parseSteamCheckpoint({version:1,lobbyId,ownerId:steamC,epoch:randomBytes(16).toString('hex'),sequence:1,stunUrls:[],store:thirdFinal.store,users:thirdFinal.users,roomDocument:thirdFinal.roomDocument});
    assert.equal(thirdCheckpoint.ownerId,steamC);
    assert.deepEqual(thirdCheckpoint.store.governance,journal);
    assert(thirdCheckpoint.store.governance);
    assert.equal(governanceState(thirdCheckpoint.store.governance).ownerKey,seed.creatorKey);
    checks.push('A/B/C transport-owner checkpoint envelopes preserve the original signed server owner, server name and assigned domain owner across three real backend generations');
    await fs.writeFile(path.join(directory, 'snapshot-third-reconnected.json'), JSON.stringify(thirdFinal, null, 2));
    checks.push('three actual backend generations preserve the second generation new chat through production checkpoint compression and a second force-kill/key rotation');
    const departedAfter = third.snapshots.length;
    await control(third, { t: 'steam-departed', steamId: steamB });
    const departed = await matchingSnapshot(third, departedAfter, snapshot => snapshot.users.length === 2 && snapshot.users.some(user=>user.id===idA) && snapshot.users.some(user=>user.id===stableSteamUserId(steamC)) && !snapshot.users.some(user=>user.id===idB));
    await thirdB.closed; assertNoCredentials(departed, credentials);
    checks.push('real parent IPC steam-departed removes only that lobby member and closes its transport');
    for (const backend of backends) for (const snapshot of backend.snapshots) assertNoCredentials(snapshot, credentials);
    await fs.writeFile(path.join(directory, 'snapshots.json'), JSON.stringify(backends.map((backend, index) => ({ backend: index + 1, snapshots: backend.snapshots })), null, 2));
  } catch (error) { failed = error instanceof Error ? error : new Error('Non-Error backend integration failure'); }
  finally {
    for (const client of clients) if (client.socket.readyState === WebSocket.OPEN) client.socket.close();
    for (const backend of backends) {
      const exit = await killBackend(backend); if (backend.child.pid && !exits.some(record => record.pid === backend.child.pid)) exits.push({ pid: backend.child.pid, ...exit });
      let log = backend.output(); for (const credential of credentials) log = log.replaceAll(credential, '[redacted]');
      await fs.writeFile(path.join(directory, 'backend-' + (backends.indexOf(backend) + 1) + '.log'), log);
    }
    for (const privateDirectory of [firstDirectory, secondDirectory, thirdDirectory]) {
      assert.equal(path.dirname(privateDirectory), directory); await fs.rm(privateDirectory, { recursive: true, force: true });
    }
    let failure = failed?.message ?? null;
    if (failure !== null) for (const credential of credentials) failure = failure.replaceAll(credential, '[redacted]');
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ passed: failed === null, scope: 'Actual local Node backend / HTTP / WebSocket / parent IPC; no Steam native API, multi-account client, WebRTC media or Steam end-to-end claim', checks, exits, privateDirectoriesRemoved: true, failure }, null, 2));
    console.log(JSON.stringify({ event: 'steam_backend_integration_complete', passed: failed === null, evidence: path.relative(root, directory), checks: checks.length, ownedProcessesRemaining: 0 }));
  }
  if (failed) throw failed;
});
