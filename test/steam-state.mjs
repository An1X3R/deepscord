// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync, randomUUID,sign } from 'node:crypto';
import state from '../lib/steam-state.cjs';
import replica from '../lib/room-replica.cjs';
import {createGovernance,appendGovernance,governancePayload} from '../lib/server-governance.cjs';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../lib/steam-state.cjs').RoomStore} RoomStore */
/** @typedef {import('../lib/steam-state.cjs').HistoryMessage} HistoryMessage */
/** @typedef {import('../lib/steam-state.cjs').SteamPublicUser} SteamPublicUser */
/** @typedef {import('../lib/steam-state.cjs').SteamCheckpoint} SteamCheckpoint */
const { parseSteamStore, parseSteamUsers, parseSteamCheckpoint, stableSteamUserId, signSteamIdentity, verifySteamIdentity } = state;

test('room seeds and checkpoints preserve the pinned document and strip unrelated credentials', () => {
  const pair = generateKeyPairSync('ed25519');
  const descriptor = { version: /** @type {const} */ (1), roomId: randomUUID(), creatorKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  const document = replica.createRoomDocument(descriptor, 7, store().servers);
  const seed = { roomId: descriptor.roomId, creatorKey: descriptor.creatorKey, document };
  const governance=createGovernance(descriptor);
  assert.deepEqual(state.parseSteamRoomSeed({...seed,governance}),{...seed,governance});
  assert.throws(()=>state.parseSteamRoomSeed({...seed,governance:{...governance,roomId:randomUUID()}}),/identity/);
  assert.deepEqual(parseSteamStore({...store(),governance}),{...store(),governance});
  assert.deepEqual(state.parseSteamRoomSeed({ ...seed, secret: 'strip', document: { ...document, token: 'strip' } }), seed);
  assert.deepEqual(state.parseSteamRoomSeed({ ...seed, document: null }), { ...seed, document: null });
  assert.throws(() => state.parseSteamRoomSeed({ roomId: descriptor.roomId, creatorKey: descriptor.creatorKey }));
  assert.throws(() => state.parseSteamRoomSeed({ ...seed, roomId: randomUUID() }));
  assert.throws(() => state.parseSteamRoomSeed({ ...seed, creatorKey: 'invalid' }));
  assert.throws(() => state.parseSteamRoomSeed({ ...seed, padding: 'x'.repeat(1024 * 1024) }), RangeError);
  const saved = { ...checkpoint(), roomDocument: { ...document, sessionKey: 'strip' } };
  assert.equal(parseSteamCheckpoint({...saved,store:{...saved.store,governance}}).store.governance?.digest,governance.digest);
  assert.throws(()=>parseSteamCheckpoint({...saved,store:{...saved.store,governance:createGovernance({...descriptor,roomId:randomUUID()})}}),/identity|pinned/);
  assert.deepEqual(parseSteamCheckpoint(saved), { ...checkpoint(), roomDocument: document });
  assert.throws(() => parseSteamCheckpoint({ ...saved, roomDocument: { ...document, digest: '0'.repeat(64) } }));
  assert.throws(() => parseSteamCheckpoint({ ...saved, roomDocument: null }));
});
const steamId = '76561198000000001';
const lobbyId = '109775244000000001';
const session = '1234567890abcdef1234567890abcdef';
const jpeg = await readFile(new URL('./fixtures/avatar-96.jpg', import.meta.url));
const avatar = 'data:image/jpeg;base64,' + jpeg.toString('base64');

/** @returns {HistoryMessage} */
function message() {
  return { id: 'msg-1', userId: stableSteamUserId(steamId), name: 'Pilot', color: '#123aBc', text: 'hello\nworld', ts: 1700000000000, system: false };
}

/** @returns {RoomStore} */
function store() {
  return { version: 1, servers: [{ id: 'srv-main', name: 'Friends', icon: '🙂', color: '#123abc', channels: [{ id: 'ch-voice', name: 'Lounge', type: 'voice', userLimit: 8 }, { id: 'ch-text', name: 'Chat', type: 'text', userLimit: 0 }] }], messages: { 'ch-voice': [message()], 'ch-text': [] } };
}

/** @returns {SteamPublicUser} */
function user() {
  return { id: stableSteamUserId(steamId), name: 'Pilot', color: '#123abc', profileId: null, avatar: null, muted: false, deafened: true, voiceChannelId: 'ch-voice', signalConnected: true };
}

/** @returns {SteamCheckpoint} */
function checkpoint() {
  return { version: 1, lobbyId, ownerId: steamId, epoch: session, sequence: 1, stunUrls: ['stun:stun.example.com:3478'], store: store(), users: [user()] };
}

test('store strips redundant fields at every level without mutating the input', () => {
  const base = store();
  const input = {
    ...base, sessionKey: 'never-migrate',
    servers: base.servers.map(server => ({ ...server, password: 'drop', channels: server.channels.map(channel => ({ ...channel, ignored: 1 })) })),
    messages: { 'ch-voice': [{ ...message(), bot: false, resumeToken: 'drop' }], 'ch-text': [] },
  };
  const before = JSON.stringify(input);
  const expected = { ...base, messages: { 'ch-voice': [{ ...message(), bot: false }], 'ch-text': [] } };
  assert.deepEqual(parseSteamStore(input), expected);
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(parseSteamStore(input).servers, input.servers);
  const seeded = { ...base, messages: { 'ch-text': [{ ...message(), id: 'seed-1', userId: 'bot-deepscord', bot: true }, { ...message(), id: 'system-1', userId: 'system', system: true }] } };
  assert.deepEqual(parseSteamStore(seeded), seeded);
});

test('store rejects duplicate IDs and history keys that do not name an existing channel', () => {
  const base = store();
  const server = base.servers[0];
  const channel = server.channels[0];
  const invalid = [
    { ...base, servers: [server, server] },
    { ...base, servers: [{ ...server, channels: [channel, channel] }] },
    { ...base, servers: [server, { ...server, id: 'srv-other' }] },
    { ...base, messages: { 'ch-missing': [message()] } },
    { ...base, messages: { 'ch-voice': [message(), message()] } },
    { ...base, messages: { 'ch-voice': [message()], 'ch-text': [message()] } },
    { ...base, messages: JSON.parse('{"__proto__":[]}') },
    { ...base, servers: [{ ...server, id: 'constructor' }] },
  ];
  for (const input of invalid) assert.throws(() => parseSteamStore(input), TypeError);
});

test('store validates field types, bounds and explicit required fields', () => {
  const base = store(), server = base.servers[0], channel = server.channels[0];
  /** @type {JsonValue[]} */
  const invalid = [
    null, [], { ...base, version: 2 }, { version: 1, servers: [] },
    { ...base, servers: Array.from({ length: 13 }, (_, i) => ({ ...server, id: 'srv-' + i, channels: [] })) },
    { ...base, servers: [{ ...server, channels: Array.from({ length: 41 }, (_, i) => ({ ...channel, id: 'ch-' + i })) }] },
    { ...base, messages: { 'ch-text': Array.from({ length: 301 }, (_, i) => ({ ...message(), id: 'msg-' + i })) } },
    { ...base, servers: [{ ...server, name: 's'.repeat(21) }] },
    { ...base, servers: [{ ...server, icon: 'two' }] },
    { ...base, servers: [{ ...server, color: 'red' }] },
    { ...base, servers: [{ ...server, channels: [{ ...channel, name: 'c'.repeat(21) }] }] },
    { ...base, servers: [{ ...server, channels: [{ ...channel, type: 'video' }] }] },
    { ...base, servers: [{ ...server, channels: [{ ...channel, userLimit: 101 }] }] },
    { ...base, servers: [{ ...server, channels: [{ ...channel, userLimit: 0.5 }] }] },
    { ...base, servers: [{ ...server, channels: [{ ...channel, type: 'text', userLimit: 1 }] }] },
    { ...base, messages: { 'ch-text': [{ ...message(), name: 'u'.repeat(25) }] } },
    { ...base, messages: { 'ch-text': [{ ...message(), text: 'x'.repeat(2001) }] } },
    { ...base, messages: { 'ch-text': [{ ...message(), text: 'bad\u0000text' }] } },
    { ...base, messages: { 'ch-text': [{ ...message(), ts: -1 }] } },
    { ...base, messages: { 'ch-text': [{ ...message(), system: 'false' }] } },
    { ...base, messages: { 'ch-text': [{ ...message(), bot: null }] } },
    { ...base, messages: { 'ch-text': [{ ...message(), id: 'x'.repeat(81) }] } },
  ];
  for (const input of invalid) assert.throws(() => parseSteamStore(input));
  const largestHistory = { ...base, messages: { 'ch-text': Array.from({ length: 300 }, (_, i) => ({ ...message(), id: 'msg-' + i, text: 'x'.repeat(2000) })) } };
  assert.equal(parseSteamStore(largestHistory).messages['ch-text'].length, 300);
  const maximumRoom = { version: 1, servers: Array.from({ length: 12 }, (_, i) => ({ ...server, id: 'srv-' + i, channels: Array.from({ length: 40 }, (_, j) => ({ ...channel, id: 'ch-' + i + '-' + j, userLimit: 100 })) })), messages: {} };
  assert.equal(parseSteamStore(maximumRoom).servers.flatMap(server => server.channels).length, 480);
});

test('Steam IDs have one canonical stable representation and enforce uint64 limits', () => {
  for (const id of [steamId, '1000000000000000', '18446744073709551615']) assert.equal(stableSteamUserId(id), 'u_steam_' + id);
  for (const id of ['', '123456789012345', '076561198000000001', '18446744073709551616', '100000000000000000000', '+76561198000000001', '76561198000000001x']) assert.throws(() => stableSteamUserId(id), TypeError);
});

test('public users retain only approved profile and media state fields', () => {
  const base = user();
  const profileId = '12345678-1234-4123-8123-123456789ABC';
  const input = [{ ...base, profileId, avatar, password: 'drop', resumeToken: 'drop', sessionKey: 'drop', conn: { id: 'drop' } }];
  const before = JSON.stringify(input);
  assert.deepEqual(parseSteamUsers(input, store()), [{ ...base, profileId: profileId.toLowerCase(), avatar }]);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(parseSteamUsers([{ ...base, voiceChannelId: null, signalConnected: false }], store()), [{ ...base, voiceChannelId: null, signalConnected: false }]);
  /** @type {JsonValue[]} */
  const invalid = [
    [base, base], Array.from({ length: 11 }, (_, i) => ({ ...base, id: stableSteamUserId((BigInt(steamId) + BigInt(i)).toString()) })),
    [{ ...base, id: 'u-random' }], [{ ...base, id: 'u_steam_076561198000000001' }],
    [{ ...base, voiceChannelId: 'ch-text' }], [{ ...base, voiceChannelId: 'missing' }],
    [{ ...base, profileId: 'invalid' }], [{ ...base, avatar: 'https://example.com/avatar.jpg' }],
    [{ ...base, muted: 0 }], [{ ...base, deafened: 'false' }], [{ ...base, signalConnected: null }],
    [{ ...base, name: 'name\ncontrol' }], [{ ...base, color: '#bad' }],
  ];
  for (const input of invalid) assert.throws(() => parseSteamUsers(input, store()));
  const { avatar: omittedAvatar, ...withoutAvatar } = base;
  const { profileId: omittedProfile, ...withoutProfile } = base;
  assert.equal(omittedAvatar, null); assert.equal(omittedProfile, null);
  assert.throws(() => parseSteamUsers([withoutAvatar], store()));
  assert.throws(() => parseSteamUsers([withoutProfile], store()));
});

test('checkpoint strips secrets and canonicalizes STUN using the direct network policy', () => {
  const base = checkpoint();
  const input = { ...base, stunUrls: ['STUN:Stun.Example.com:3478', 'stun:stun.example.com:3478'], sessionKey: 'drop', resumeTokens: ['drop'] };
  const before = JSON.stringify(input);
  assert.deepEqual(parseSteamCheckpoint(input), base);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(parseSteamCheckpoint({ ...base, stunUrls: [] }).stunUrls, []);
  assert.equal(parseSteamCheckpoint({ ...base, lobbyId: '1' }).lobbyId, '1');
});

test('checkpoint rejects excess raw input before stripping, malformed ownership and unsafe ICE', () => {
  const base = checkpoint();
  /** @type {JsonValue[]} */
  const invalid = [
    { ...base, version: 2 }, { ...base, epoch: 'A'.repeat(32) }, { ...base, epoch: 'a'.repeat(31) },
    { ...base, sequence: 0 }, { ...base, sequence: 1.5 }, { ...base, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, ownerId: 'u_steam_' + steamId }, { ...base, ownerId: '0' },
    { ...base, lobbyId: '01' }, { ...base, lobbyId: '18446744073709551616' },
    { ...base, stunUrls: ['turn:example.com:3478'] }, { ...base, stunUrls: ['stun:example.com?transport=udp'] },
    { ...base, stunUrls: ['stun:one.example.com,stun:two.example.com'] },
    { ...base, stunUrls: Array.from({ length: 9 }, (_, i) => 'stun:node' + i + '.example.com') },
    { ...base, padding: 'x'.repeat(4 * 1024 * 1024) }, { ...base, padding: '🙂'.repeat(1024 * 1024) },
  ];
  for (const input of invalid) assert.throws(() => parseSteamCheckpoint(input));
  const { users: removedUsers, ...withoutUsers } = base;
  assert.equal(removedUsers.length, 1);
  assert.throws(() => parseSteamCheckpoint(withoutUsers));
});

test('HMAC identity binds the actual lobby, Steam ID and session with a local 32-byte secret', () => {
  const secret = Buffer.alloc(32, 0x71);
  const signed = signSteamIdentity(secret, lobbyId, steamId, session);
  assert.deepEqual(Object.keys(signed), ['steamId', 'session', 'mac']);
  assert.match(signed.mac, /^[a-f0-9]{64}$/);
  assert.equal(verifySteamIdentity({ ...signed, password: 'discarded' }, secret, lobbyId), stableSteamUserId(steamId));
  assert.deepEqual(signSteamIdentity(secret, lobbyId, steamId, session), signed);
  assert.throws(() => verifySteamIdentity(signed, secret, '109775244000000002'), /signature/);
  assert.throws(() => verifySteamIdentity(signed, Buffer.alloc(32, 0x72), lobbyId), /signature/);
  assert.throws(() => verifySteamIdentity({ ...signed, steamId: '76561198000000002' }, secret, lobbyId), /signature/);
  assert.throws(() => verifySteamIdentity({ ...signed, session: '0'.repeat(32) }, secret, lobbyId), /signature/);
  assert.throws(() => verifySteamIdentity({ ...signed, mac: '0'.repeat(64) }, secret, lobbyId), /signature/);
  assert.throws(() => verifySteamIdentity({ ...signed, mac: signed.mac.toUpperCase() }, secret, lobbyId));
  assert.throws(() => verifySteamIdentity({ ...signed, mac: '00' }, secret, lobbyId));
  for (const length of [0, 31, 33]) {
    assert.throws(() => signSteamIdentity(Buffer.alloc(length), lobbyId, steamId, session));
    assert.throws(() => verifySteamIdentity(signed, Buffer.alloc(length), lobbyId));
  }
  for (const invalidSession of ['', 'a'.repeat(31), 'A'.repeat(32), 'g'.repeat(32)]) assert.throws(() => signSteamIdentity(secret, lobbyId, steamId, invalidSession));
  assert.throws(() => signSteamIdentity(secret, '01', steamId, session));
  assert.throws(() => verifySteamIdentity(null, secret, lobbyId));
});

test('instance readers reuse governance safely while fully validating every changed checkpoint', () => {
  const pair=generateKeyPairSync('ed25519');
  const descriptor={version:/** @type {const} */(1),roomId:randomUUID(),creatorKey:pair.publicKey.export({format:'der',type:'spki'}).toString('base64')};
  const initial=createGovernance(descriptor),command={type:/** @type {const} */('renameServer'),name:'Verified server'};
  const governance=appendGovernance(initial,{revision:1,previousDigest:initial.digest,actorKey:descriptor.creatorKey,command,signature:sign(null,Buffer.from(governancePayload(initial,descriptor.creatorKey,command)),pair.privateKey).toString('base64')});
  const document=replica.createRoomDocument(descriptor,1,store().servers);
  const input={...checkpoint(),roomDocument:document,store:{...store(),governance}};
  const reader=state.createSteamStateReader({maxEntries:4,maxBytes:1024*1024});
  assert.deepEqual(reader.parseStore(input.store),parseSteamStore(input.store));
  const parsed=reader.parseCheckpoint(input);
  assert.deepEqual(parsed,parseSteamCheckpoint(input));
  assert(parsed.store.governance);
  parsed.store.governance.events[0].command={type:'renameServer',name:'Cache poisoning'};
  parsed.store.messages['ch-voice'][0].text='Changed externally';
  assert.deepEqual(reader.parseCheckpoint(input),parseSteamCheckpoint(input));
  const changed={...input,sequence:2,store:{...input.store,messages:{...input.store.messages,'ch-text':[{...message(),id:'msg-next',text:'New chat with the same governance'}]}}};
  assert.deepEqual(reader.parseCheckpoint(changed),parseSteamCheckpoint(changed));
  const altered={...governance,events:[{...governance.events[0],command:{type:'renameServer',name:'Unsigned change'}}]};
  assert.throws(()=>reader.parseCheckpoint({...changed,store:{...changed.store,governance:altered}}),/signature/);
  assert.throws(()=>reader.parseStore({...input.store,governance:{...governance,events:[]}}),/digest/);
  const otherRoom=replica.createRoomDocument({...descriptor,roomId:randomUUID()},1,store().servers);
  assert.throws(()=>reader.parseCheckpoint({...input,roomDocument:otherRoom}),/pinned room document/);
  const otherPair=generateKeyPairSync('ed25519');
  const otherCreator=replica.createRoomDocument({...descriptor,creatorKey:otherPair.publicKey.export({format:'der',type:'spki'}).toString('base64')},1,store().servers);
  assert.throws(()=>reader.parseCheckpoint({...input,roomDocument:otherCreator}),/pinned room document/);
  assert.throws(()=>reader.parseCheckpoint({...input,epoch:'A'.repeat(32)}),/epoch/);
  assert.throws(()=>reader.parseCheckpoint({...input,users:[{...user(),voiceChannelId:'absent'}]}),/voiceChannelId/);
  assert.throws(()=>reader.parseCheckpoint({...input,roomDocument:{...document,digest:'0'.repeat(64)}}),/digest/);
  assert.throws(()=>reader.parseStore({...input.store,messages:{absent:[]}}),/does not exist/);
  assert.throws(()=>reader.parseCheckpoint({...input,padding:'x'.repeat(4*1024*1024)}),/4 MiB/);
  assert.deepEqual(reader.parseCheckpoint({...input,ignored:'stripped'}),input);
  assert.throws(()=>state.createSteamStateReader({maxEntries:0,maxBytes:1024}),RangeError);
});
