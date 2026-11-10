// @ts-check
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import validation from '../lib/profile-avatar.cjs';
import storage from '../desktop/profile-store.cjs';
import commands from '../desktop/steam-commands.cjs';
import { parsePeerSignal } from '../public/js/network-protocol.js';
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{[key: string]: JsonValue}} Message */
const root = fileURLToPath(new URL('../', import.meta.url));
const jpeg = await fs.readFile(new URL('./fixtures/avatar-96.jpg', import.meta.url));
const avatar = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
const profile = { id: randomUUID(), name: 'Pilot', color: '#123abc', avatar };

test('validates bounded JPEG dimensions and strips profile and Steam command fields', () => {
  assert.deepEqual(validation.validateProfile({ ...profile, extra: 'drop' }), profile);
  assert.equal(validation.validateAvatar(avatar), avatar);
  const oversized = Buffer.from(jpeg);
  const frame = oversized.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(frame > 0);
  oversized.writeUInt16BE(97, frame + 7);
  for (const value of ['https://example.com/avatar.jpg', 'data:image/svg+xml;base64,PHN2Zy8+', avatar + 'x', `data:image/jpeg;base64,${oversized.toString('base64')}`, `data:image/jpeg;base64,${Buffer.alloc(12289).toString('base64')}`]) {
    assert.throws(() => validation.validateAvatar(value), TypeError);
  }
  const input = { t: 'hello', name: profile.name, color: profile.color, password: '', profileId: profile.id, avatar, extra: 'drop' };
  const cleaned = JSON.parse(commands.cleanClientCommand(JSON.stringify(input), parsePeerSignal));
  assert.equal(cleaned.extra, undefined);
  assert.equal(cleaned.avatar, avatar);
  assert.equal(cleaned.profileId, profile.id);
  assert.throws(() => commands.cleanClientCommand(JSON.stringify({ ...input, avatar: 'http://evil/avatar' }), parsePeerSignal), TypeError);
});

test('persists a shared desktop profile atomically across store instances and rejects corrupt storage', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deepscord-profile-'));
  try {
    const store = storage.createProfileStore(directory);
    assert.equal(await store.load(), null);
    await store.save(profile);
    assert.deepEqual(await storage.createProfileStore(directory).load(), profile);
    await Promise.all([store.save({ ...profile, name: 'One' }), store.save({ ...profile, name: 'Two' })]);
    assert.equal((await store.load())?.name, 'Two');
    assert.deepEqual(await fs.readdir(directory), ['profile.json']);
    await assert.rejects(store.save({ ...profile, avatar: 'bad' }), TypeError);
    assert.equal((await store.load())?.name, 'Two');
    await fs.writeFile(path.join(directory, 'profile.json'), '{bad');
    await assert.rejects(store.load(), SyntaxError);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

/** @param {string} url */
async function connect(url) {
  const ws = new WebSocket(url);
  /** @type {Message[]} */
  const inbox = [];
  ws.addEventListener('message', (event) => inbox.push(/** @type {Message} */ (JSON.parse(String(event.data)))));
  await once(ws, 'open');
  /** @param {string} type @returns {Promise<Message>} */
  async function wait(type) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const index = inbox.findIndex((message) => message.t === type);
      if (index !== -1) return /** @type {Message} */ (inbox.splice(index, 1)[0]);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${type}`);
  }
  /** @param {Message} message */
  function send(message) { ws.send(JSON.stringify(message)); }
  return { ws, send, wait };
}

test('real server synchronizes avatars, rejects malformed updates, and keeps profile collisions separate from authenticated sessions', async () => {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve(null)));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deepscord-profile-server-'));
  const child = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore', env: { ...process.env, PORT: String(port), HTTP_HOST: '127.0.0.1', HTTPS_PORTS: '0', ECHO_DATA_DIR: directory, ECHO_PASSWORD: '', ECHO_NETWORK_MODE: 'server', ECHO_MEDIA_POLICY: 'direct', TURN_URL: '', TURN_SECRET: '' } });
  /** @type {WebSocket[]} */
  const sockets = [];
  try {
    const deadline = Date.now() + 8000;
    let healthy = false;
    while (Date.now() < deadline) {
      try { healthy = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; }
      catch (error) { if (!(error instanceof TypeError)) throw error; }
      if (healthy) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.ok(healthy, 'Server must become ready');
    const first = await connect(`ws://127.0.0.1:${port}/ws`);
    sockets.push(first.ws);
    const hello = { t: 'hello', name: profile.name, color: profile.color, profileId: profile.id, avatar, resumable: true };
    first.send(hello);
    const welcome = await first.wait('welcome');
    assert.ok(welcome.you && typeof welcome.you === 'object' && !Array.isArray(welcome.you));
    assert.equal(welcome.you.avatar, avatar);
    assert.equal(welcome.you.profileId, profile.id);
    const second = await connect(`ws://127.0.0.1:${port}/ws`);
    sockets.push(second.ws);
    second.send(hello);
    const other = await second.wait('welcome');
    assert.notEqual(welcome.selfId, other.selfId, 'Profile UUID is not a session credential');
    first.send({ t: 'rename', name: profile.name, color: '#abcdef', avatar: null, profileId: profile.id });
    const changed = await second.wait('userUpdated');
    assert.ok(changed.user && typeof changed.user === 'object' && !Array.isArray(changed.user));
    assert.equal(changed.user.avatar, null);
    assert.equal(changed.user.color, '#abcdef');
    first.send({ t: 'rename', name: 'Wrong', avatar: 'https://example.com/avatar' });
    assert.equal((await first.wait('error')).code, 'invalid-profile');
    const third = await connect(`ws://127.0.0.1:${port}/ws`);
    sockets.push(third.ws);
    third.send({ ...hello, resumeToken: welcome.resumeToken });
    assert.equal((await third.wait('resumeRejected')).code, 'session_active');
    const fourth = await connect(`ws://127.0.0.1:${port}/ws`);
    sockets.push(fourth.ws);
    fourth.send({ ...hello, avatar: 'data:image/jpeg;base64,AAAA' });
    assert.equal((await fourth.wait('error')).code, 'invalid-profile');
    fourth.send({ t: 'hello', name: 'Legacy', color: '#aaaaaa' });
    const legacy = await fourth.wait('welcome');
    assert.ok(legacy.you && typeof legacy.you === 'object' && !Array.isArray(legacy.you));
    assert.equal(legacy.you.avatar, null);
    assert.equal(legacy.you.profileId, null);
    first.send({ t: 'rename', name: profile.name, avatar });
    const restored = await second.wait('userUpdated');
    assert.ok(restored.user && typeof restored.user === 'object' && !Array.isArray(restored.user));
    assert.equal(restored.user.avatar, avatar);
    first.send({ t: 'chat', channelId: 'ch-chat', text: 'No repeated avatar' });
    const chat = await first.wait('message');
    assert.equal(JSON.stringify(chat).includes(avatar), false);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const persisted = await fs.readFile(path.join(directory, 'store.json'), 'utf8');
    assert.ok(persisted.includes('No repeated avatar'));
    assert.equal(persisted.includes(avatar), false);
  } finally {
    for (const ws of sockets) ws.close();
    child.kill();
    await once(child, 'exit');
    await fs.rm(directory, { recursive: true, force: true });
  }
});
