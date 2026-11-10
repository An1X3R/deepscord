// @ts-check
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import steamWire from '../desktop/steam-wire.cjs';

const {
  MAX_MESSAGE_BYTES,
  MAX_PACKET_BYTES,
  SteamWireError,
  parseSteamInvite,
  steamInvite,
  encodeMessage,
  decodePacket,
} = steamWire;
const INVITATION = Object.freeze({
  appId: 480,
  lobbyId: '76561198000000000',
  token: randomBytes(32).toString('base64url'),
});
const SESSION = '0123456789abcdef0123456789abcdef';

test('formats and parses canonical Steam invites and strips unrelated fields', () => {
  const invite = steamInvite(INVITATION);
  assert.equal(invite, `deepscord://steam?appid=480&lobby=${INVITATION.lobbyId}#token=${INVITATION.token}`);
  assert.deepEqual(parseSteamInvite(invite), INVITATION);
  assert.deepEqual(
    parseSteamInvite(`deepscord://steam?appid=480&lobby=${INVITATION.lobbyId}&campaign=desktop#source=chat&token=${INVITATION.token}`),
    INVITATION,
  );
});

test('rejects duplicate, missing, malformed, and out-of-range invite fields', () => {
  const valid = steamInvite(INVITATION);
  assert.throws(() => parseSteamInvite(valid.replace('?appid=480&', '?appid=480&appid=480&')), SteamWireError);
  assert.throws(() => parseSteamInvite(valid.replace(`&lobby=${INVITATION.lobbyId}`, '')), SteamWireError);
  assert.throws(() => parseSteamInvite(valid.replace('#token=', '#token=x&token=')), SteamWireError);
  assert.throws(() => parseSteamInvite(valid.replace('deepscord://steam', 'https://steam')), SteamWireError);
  assert.throws(() => parseSteamInvite(valid.replace('deepscord://steam?', 'deepscord://user@steam?')), SteamWireError);
  assert.throws(() => parseSteamInvite(valid.replace('deepscord://steam?', 'deepscord://@steam?')), SteamWireError);
  assert.throws(() => parseSteamInvite(valid.replace('deepscord://steam?', 'deepscord://steam:42?')), SteamWireError);
  assert.throws(() => parseSteamInvite(valid.replace('deepscord://steam?', 'deepscord://steam/path?')), SteamWireError);
  assert.throws(() => steamInvite({ ...INVITATION, appId: 0 }), SteamWireError);
  assert.throws(() => steamInvite({ ...INVITATION, appId: 0x1_0000_0000 }), SteamWireError);
  assert.throws(() => steamInvite({ ...INVITATION, lobbyId: '01' }), SteamWireError);
  assert.throws(() => steamInvite({ ...INVITATION, lobbyId: '18446744073709551616' }), SteamWireError);
  assert.throws(() => steamInvite({ ...INVITATION, token: `${INVITATION.token.slice(0, -1)}!` }), SteamWireError);
});

test('encodes and authenticates a single packet, then rejects tampering and wrong credentials', () => {
  const payload = Buffer.from('signaling only', 'utf8');
  const [packet] = encodeMessage(INVITATION, SESSION, 'open', payload);
  assert.deepEqual(decodePacket(INVITATION, packet), {
    session: SESSION,
    kind: 'open',
    index: 0,
    count: 1,
    data: payload,
  });
  const altered = Buffer.from(packet);
  altered[altered.indexOf(payload.toString('base64'))] ^= 1;
  assert.throws(() => decodePacket(INVITATION, altered), SteamWireError);
  assert.throws(() => decodePacket({ ...INVITATION, token: randomBytes(32).toString('base64url') }, packet), SteamWireError);
  assert.throws(() => decodePacket({ ...INVITATION, lobbyId: '76561198000000001' }, packet), SteamWireError);
});

test('uses one authenticated empty packet and preserves fragment indexes', () => {
  const [emptyPacket] = encodeMessage(INVITATION, SESSION, 'opened', Buffer.alloc(0));
  assert.deepEqual(decodePacket(INVITATION, emptyPacket), {
    session: SESSION,
    kind: 'opened',
    index: 0,
    count: 1,
    data: Buffer.alloc(0),
  });

  const payload = randomBytes(16 * 1024 + 1);
  const packets = encodeMessage(INVITATION, SESSION, 'data', payload);
  assert.equal(packets.length, 2);
  assert.ok(packets.every((packet) => packet.length <= MAX_PACKET_BYTES));
  assert.deepEqual(packets.map((packet) => {
    const decoded = decodePacket(INVITATION, packet);
    return [decoded.index, decoded.count, decoded.data.length];
  }), [[0, 2, 16 * 1024], [1, 2, 1]]);
});

test('accepts the maximum message and rejects payload, packet, and empty-packet overflow', () => {
  const packets = encodeMessage(INVITATION, SESSION, 'data', randomBytes(MAX_MESSAGE_BYTES));
  assert.equal(packets.length, 256);
  assert.ok(packets.every((packet) => packet.length <= MAX_PACKET_BYTES));
  assert.throws(() => encodeMessage(INVITATION, SESSION, 'data', Buffer.alloc(MAX_MESSAGE_BYTES + 1)), SteamWireError);
  assert.throws(() => decodePacket(INVITATION, Buffer.alloc(MAX_PACKET_BYTES + 1)), SteamWireError);
  assert.throws(() => decodePacket(INVITATION, Buffer.alloc(0)), SteamWireError);
});

test('rejects invalid packet schemas and fragment sequence metadata', () => {
  assert.throws(() => decodePacket(INVITATION, Buffer.from('{"v":1}', 'utf8')), SteamWireError);
  const [packet] = encodeMessage(INVITATION, SESSION, 'close', Buffer.from('x'));
  const tamperedIndex = Buffer.from(packet.toString('utf8').replace('"index":0', '"index":1'), 'utf8');
  assert.throws(() => decodePacket(INVITATION, tamperedIndex), SteamWireError);
  const tamperedCount = Buffer.from(packet.toString('utf8').replace('"count":1', '"count":257'), 'utf8');
  assert.throws(() => decodePacket(INVITATION, tamperedCount), SteamWireError);
});
