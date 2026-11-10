// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import continuity from '../desktop/steam-continuity.cjs';
import wire from '../desktop/steam-wire.cjs';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../lib/steam-state.cjs').SteamCheckpoint} SteamCheckpoint */
/** @typedef {import('../desktop/steam-continuity.cjs').ReplicaMessage} ReplicaMessage */
const { REPLICA_SESSION, encodeReplica, decodeReplica, checkpointDigest, newerCheckpoint } = continuity;
const { encodeMessage, decodePacket, SteamWireError } = wire;
const epoch = '1234567890abcdef1234567890abcdef';
const requestId = 'abcdef1234567890abcdef1234567890';
const ownerId = '76561198000000001';
const maximum = 4 * 1024 * 1024;

test('checkpoint fanout encodes once without trusting mutable input or sharing mutable buffers', () => {
  const encoder = continuity.createCheckpointEncoder();
  const source = checkpoint();
  const first = encoder.encode(source);
  const second = encoder.encode(structuredClone(source));
  assert.deepEqual(first,second);
  assert.deepEqual(encoder.stats(),{ encodes:1,hits:1 });
  first.payload.fill(0);
  assert.deepEqual(decodeReplica(encoder.encode(source).payload),{ t:'checkpoint',checkpoint:source });
  const changed = structuredClone(source);
  changed.store.messages['ch-chat'][0].text = 'A changed message needs a new encoding';
  assert.notEqual(encoder.encode(changed).digest,second.digest);
  assert.equal(encoder.stats().encodes,2);
  assert.throws(()=>encoder.encode({ ...changed,ownerId:'bad' }),TypeError);
  assert.deepEqual(decodeReplica(encoder.encode(changed).payload),{ t:'checkpoint',checkpoint:changed });
  assert.equal(encoder.stats().encodes,2);
});

/** @returns {SteamCheckpoint} */
function checkpoint() {
  return { version: 1, lobbyId: '109775244000000001', ownerId, epoch, sequence: 2, stunUrls: [], store: { version: 1, servers: [{ id: 'srv-main', name: 'Friends', icon: '🙂', color: '#123abc', channels: [{ id: 'ch-chat', name: 'Chat', type: 'text', userLimit: 0 }] }], messages: { 'ch-chat': [{ id: 'msg-1', userId: 'u_steam_' + ownerId, name: 'Pilot', color: '#123abc', text: '连续接替：第二任的新消息🙂', ts: 1700000000000, system: false }] } }, users: [] };
}

/** @param {JsonValue} value @returns {ReplicaMessage} */
function decodeJSON(value) { return decodeReplica(deflateRawSync(Buffer.from(JSON.stringify(value), 'utf8'))); }

test('all typed ReplicaMessage branches survive actual compression and authenticated wire roundtrips', () => {
  const saved = checkpoint();
  const receiver = continuity.createReplicaDecoder({maxEntries:4,maxBytes:8*1024*1024});
  /** @type {ReplicaMessage[]} */
  const messages = [{ t: 'checkpoint', checkpoint: saved }, { t: 'ack', epoch, sequence: saved.sequence, digest: checkpointDigest(saved) }, { t: 'request', epoch }, { t: 'recover', epoch, ownerId, requestId }, { t: 'recovered', requestId, checkpoint: saved }];
  const invitation = { appId: 480, lobbyId: saved.lobbyId, token: randomBytes(32).toString('base64url') };
  for (const message of messages) {
    const encoded = encodeReplica(message);
    assert.deepEqual(decodeReplica(encoded), message);
    const received = receiver.decode(encoded);
    assert.deepEqual(received, message);
    if(received.t==='checkpoint' || received.t==='recovered') received.checkpoint.store.messages['ch-chat'][0].text='Caller mutation must stay private';
    assert.deepEqual(receiver.decode(encoded),message);
    const packets = encodeMessage(invitation, REPLICA_SESSION, 'replica', encoded);
    const decoded = packets.map(packet => decodePacket(invitation, packet));
    assert(decoded.every(packet => packet.kind === 'replica' && packet.session === REPLICA_SESSION));
    assert.deepEqual(decoded.map(packet => packet.index), decoded.map((_, index) => index));
    assert.deepEqual(decodeReplica(Buffer.concat(decoded.map(packet => packet.data))), message);
  }
  assert.deepEqual(decodeJSON({ t: 'request', epoch, ignored: 'discarded' }), { t: 'request', epoch });
});

test('compressed input, decompressed UTF-8, JSON and the exact 4 MiB boundary are checked', () => {
  assert.throws(() => decodeReplica(Buffer.alloc(0)), RangeError);
  assert.throws(() => decodeReplica(Buffer.alloc(maximum + 1)), RangeError);
  assert.throws(() => decodeReplica(Buffer.from([0xff])));
  assert.throws(() => decodeReplica(deflateRawSync(Buffer.from([0xff, 0xfe]))), /UTF-8/);
  assert.throws(() => decodeReplica(deflateRawSync(Buffer.from('{'))), SyntaxError);
  const shell = JSON.stringify({ t: 'request', epoch, padding: '' });
  const text = shell.replace('"padding":""', '"padding":"' + 'x'.repeat(maximum - Buffer.byteLength(shell)) + '"');
  assert.equal(Buffer.byteLength(text), maximum);
  assert.deepEqual(decodeReplica(deflateRawSync(Buffer.from(text))), { t: 'request', epoch });
  assert.throws(() => decodeReplica(deflateRawSync(Buffer.from(text + ' '))), { code: 'ERR_BUFFER_TOO_LARGE' });
  const saved = checkpoint();
  const large = { ...saved, padding: 'x'.repeat(maximum) };
  assert.throws(() => decodeJSON({ t: 'checkpoint', checkpoint: large }));
  assert.throws(() => encodeReplica({ t: 'checkpoint', checkpoint: large }), /4 MiB/);
});

test('invalid authority epochs, acknowledgements, owners and request IDs fail schema validation', () => {
  const receiver = continuity.createReplicaDecoder({maxEntries:4,maxBytes:8*1024*1024});
  receiver.decode(encodeReplica({t:'checkpoint',checkpoint:checkpoint()}));
  /** @type {JsonValue[]} */
  const invalid = [null, [], { t: 'unsupported' }, { t: 'request', epoch: 'A'.repeat(32) }, { t: 'request', epoch: epoch.slice(1) },
    { t: 'ack', epoch, sequence: 0, digest: 'a'.repeat(64) }, { t: 'ack', epoch, sequence: 1.5, digest: 'a'.repeat(64) },
    { t: 'ack', epoch, sequence: 1, digest: 'A'.repeat(64) }, { t: 'ack', epoch, sequence: 1, digest: '0'.repeat(63) },
    { t: 'recover', epoch, ownerId: 'u_steam_' + ownerId, requestId }, { t: 'recover', epoch, ownerId: '18446744073709551616', requestId },
    { t: 'recover', epoch, ownerId, requestId: 'not-a-request-id' }, { t: 'recovered', requestId: 'A'.repeat(32), checkpoint: checkpoint() },
    { t: 'checkpoint', checkpoint: { ...checkpoint(), epoch: 'wrong' } },
  ];
  for (const input of invalid) {
    assert.throws(() => decodeJSON(input));
    assert.throws(() => receiver.decode(deflateRawSync(Buffer.from(JSON.stringify(input)))));
  }
});

test('real Steam wire rejects malformed or wrong tokens, cross-lobby packets and tampering', () => {
  const saved = checkpoint(), invitation = { appId: 480, lobbyId: saved.lobbyId, token: randomBytes(32).toString('base64url') };
  const payload = encodeReplica({ t: 'checkpoint', checkpoint: saved });
  const [packet] = encodeMessage(invitation, REPLICA_SESSION, 'replica', payload);
  assert.throws(() => decodePacket({ ...invitation, token: 'invalid' }, packet), SteamWireError);
  assert.throws(() => decodePacket({ ...invitation, token: randomBytes(32).toString('base64url') }, packet), SteamWireError);
  assert.throws(() => decodePacket({ ...invitation, lobbyId: '109775244000000002' }, packet), SteamWireError);
  assert.throws(() => encodeMessage(invitation, REPLICA_SESSION, 'replica', Buffer.alloc(maximum + 1)), SteamWireError);
  /** @type {JsonValue} */ const raw = JSON.parse(packet.toString('utf8'));
  assert(raw !== null && typeof raw === 'object' && !Array.isArray(raw));
  assert.throws(() => decodePacket(invitation, Buffer.from(JSON.stringify({ ...raw, mac: '0'.repeat(64) }))), SteamWireError);
});

test('same-authority ordering discards stale checkpoints and loudly rejects same-sequence conflicts', () => {
  const current = checkpoint(), older = { ...current, sequence: 1 }, later = { ...current, sequence: 3 };
  assert.equal(newerCheckpoint(null, current), current);
  assert.equal(newerCheckpoint(current, older), current);
  assert.equal(newerCheckpoint(current, structuredClone(current)), current);
  assert.equal(newerCheckpoint(current, later), later);
  assert.equal(checkpointDigest(current), checkpointDigest(structuredClone(current)));
  const conflict = { ...current, stunUrls: ['stun:example.com'] };
  assert.throws(() => newerCheckpoint(current, conflict), /Conflicting/);
});

test('successive authorities cannot merge cached checkpoints across lobby, owner or epoch', () => {
  const first = checkpoint();
  const second = { ...first, ownerId: '76561198000000002', epoch: '2'.repeat(32), sequence: 1 };
  const third = { ...second, ownerId: '76561198000000003', epoch: '3'.repeat(32), sequence: 1 };
  for (const changed of [{ ...first, lobbyId: '109775244000000002' }, { ...first, ownerId: second.ownerId }, { ...first, epoch: second.epoch }, second]) assert.throws(() => newerCheckpoint(first, changed), /another authority/);
  assert.throws(() => newerCheckpoint(second, third), /another authority/);
  assert.throws(() => newerCheckpoint(third, first), /another authority/);
  assert.equal(newerCheckpoint(null, second), second);
  assert.equal(newerCheckpoint(null, third), third);
});
