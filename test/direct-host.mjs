// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import https from 'node:https';
import { X509Certificate, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import direct from '../desktop/direct-host.cjs';
import replica from '../lib/room-replica.cjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fingerprint = 'a'.repeat(64);
const token = randomBytes(32).toString('base64url');

test('invitations preserve IPv4, IPv6 and hostname origins and strip unrelated fields', () => {
  for (const origin of ['https://192.168.1.20:38481', 'https://[2001:db8::20]:38481', 'https://room.example:38481']) {
    const invite = direct.invitationText({ origin, fingerprint, token });
    assert.deepEqual(direct.parseInvitation(invite.replace('#token=', '&ignored=value#token=')), { origin, fingerprint, token });
  }
});

test('invitations reject insecure origins, missing secrets and ambiguous fields', () => {
  const valid = direct.invitationText({ origin: 'https://localhost:38481', fingerprint, token });
  for (const invite of [valid.replace('https%3A', 'http%3A'), valid.replace(fingerprint, 'bad'), valid.replace(token, 'short'), valid.replace('#token=', '&address=https%3A%2F%2Fevil.example#token='), valid + '&token=duplicate']) assert.throws(() => direct.parseInvitation(invite));
  for (const origin of ['http://host:8080', 'https://user:pass@host:443', 'https://host:443/path', 'https://host:443/#token=secret']) assert.throws(() => direct.endpoint(origin));
  assert.throws(() => direct.hostOptions({ address: 'localhost', port: 0 }));
  assert.deepEqual(direct.hostOptions({ address: '[2001:db8::1]', port: 38481 }), { address: '[2001:db8::1]', port: 38481 });
});

test('temporary certificate works with real TLS and never needs a trust-store install', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deepscord-certificate-'));
  const password = randomBytes(32).toString('base64url');
  /** @type {import('node:https').Server | null} */ let server = null;
  try {
    const pfxPath = await direct.certificate(directory, password);
    const certificate = new X509Certificate(fs.readFileSync(pfxPath + '.cer'));
    const expected = certificate.fingerprint256;
    server = https.createServer({ pfx: fs.readFileSync(pfxPath), passphrase: password }, (_request, response) => response.end('encrypted'));
    await new Promise((resolve, reject) => { server?.once('error', reject); server?.listen(0, '127.0.0.1', () => resolve(undefined)); });
    const address = server.address();
    assert(address && typeof address !== 'string');
    const result = await new Promise((resolve, reject) => {
      const request = https.get({ hostname: '127.0.0.1', port: address.port, ca: certificate.toString(), checkServerIdentity: (_hostname, peer) => peer.fingerprint256 === expected ? undefined : new Error('Invitation certificate mismatch') }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += String(chunk); });
        response.on('end', () => resolve(body));
      });
      request.once('error', reject);
    });
    assert.equal(result, 'encrypted');
  } finally {
    if (server) await new Promise((resolve, reject) => server?.close((error) => error ? reject(error) : resolve(undefined)));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('host lifecycle runs the real isolated direct server and deletes temporary credentials after exit', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deepscord-host-'));
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '::', () => resolve(undefined)); });
  const address = listener.address();
  assert(address && typeof address !== 'string');
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve(undefined)));
  /** @type {import('../desktop/direct-host.cjs').HostedRoom | null} */ let room = null;
  try {
    const pair = generateKeyPairSync('ed25519');
    const descriptor = { version: /** @type {const} */ (1), roomId: randomUUID(), creatorKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
    const document = replica.createRoomDocument(descriptor, 13, [{ id: 'srv-seeded', name: 'Saved room', icon: 'S', color: '#123abc', channels: [{ id: 'ch-seeded', name: 'Saved voice', type: 'voice', userLimit: 7 }] }]);
    const roomSeed = { roomId: descriptor.roomId, creatorKey: descriptor.creatorKey, document };
    room = await direct.startRoom({ address: 'localhost', port: address.port, roomSeed }, directory, root, process.execPath);
    assert.equal(direct.parseInvitation(room.invite).fingerprint, room.fingerprint);
    assert(fs.existsSync(path.join(room.directory, 'room.pfx')));
    const certificate = new X509Certificate(fs.readFileSync(path.join(room.directory, 'room.pfx.cer')));
    const health = await new Promise((resolve, reject) => {
      const request = https.get({ hostname: 'localhost', port: address.port, path: '/api/health', ca: certificate.toString(), checkServerIdentity: (_hostname, peer) => peer.fingerprint256 === certificate.fingerprint256 ? undefined : new Error('Invitation certificate mismatch') }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += String(chunk); });
        response.on('end', () => resolve(JSON.parse(body)));
      });
      request.once('error', reject);
    });
    assert.equal(health.networkMode, 'direct');
    const identity = JSON.parse(fs.readFileSync(path.join(room.directory, 'room-identity.json'), 'utf8'));
    assert.deepEqual(identity.document, document, 'Actual child backend did not restore the pinned seed document');
    assert.equal(identity.authorityPrivateKey, null, 'Client-owned room leaked or manufactured a server authority key');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(room.directory, 'room-seed.json'), 'utf8')), document);
    await direct.stopRoom(room);
    assert.equal(fs.existsSync(room.directory), false);
    room = null;
  } finally {
    if (room) await direct.stopRoom(room);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('occupied HTTPS port fails room creation and cleans credentials', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deepscord-occupied-'));
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '::', () => resolve(undefined)); });
  const address = listener.address();
  assert(address && typeof address !== 'string');
  try {
    await assert.rejects(() => direct.startRoom({ address: 'localhost', port: address.port }, directory, root, process.execPath), /EADDRINUSE|退出/);
    assert.deepEqual(fs.readdirSync(path.join(directory, 'direct-rooms')), []);
  } finally {
    await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve(undefined)));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
