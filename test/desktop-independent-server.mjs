import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPage, sleep, waitForPort } from './cdp.mjs';

const source = process.env.DEEPSCORD_ELECTRON_RUNTIME;
assert.ok(source, 'Set DEEPSCORD_ELECTRON_RUNTIME to the existing packaged executable');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'deepscord-client-split-'));
const runtime = path.join(temporary, 'runtime');
const originalApp = path.join(path.dirname(source), 'resources', 'app');
fs.cpSync(path.dirname(source), runtime, { recursive: true, filter: (entry) => entry !== originalApp });
const runtimeApp = path.join(runtime, 'resources', 'app');
fs.cpSync(path.join(root, 'desktop'), runtimeApp, { recursive: true });
const runtimeServer = path.join(runtimeApp, 'app-server');
fs.mkdirSync(runtimeServer, { recursive: true });
fs.copyFileSync(path.join(root, 'server.js'), path.join(runtimeServer, 'server.js'));
for (const directory of ['lib', 'public']) fs.cpSync(path.join(root, directory), path.join(runtimeServer, directory), { recursive: true });
const executable = path.join(runtime, path.basename(source));

/** @returns {Promise<number>} */
async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  listener.close();
  await once(listener, 'close');
  return port;
}

/** @returns {Promise<void>} */
async function assertNoLegacyListener() {
  const probe = net.createConnection({ host: '127.0.0.1', port: 38480 });
  await new Promise((resolve, reject) => {
    probe.once('connect', () => { probe.destroy(); reject(new Error('Unexpected listener on legacy local port 38480')); });
    probe.once('error', (error) => {
      if ('code' in error && error.code === 'ECONNREFUSED') resolve(undefined);
      else reject(error);
    });
    probe.setTimeout(2000, () => { probe.destroy(); reject(new Error('Legacy port probe timed out')); });
  });
}

/** @param {'fresh'|'legacy'} scenario @returns {Promise<void>} */
async function checkClient(scenario) {
  const data = path.join(temporary, scenario);
  fs.mkdirSync(data);
  if (scenario === 'legacy') fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ serverUrl: 'http://127.0.0.1:38480/', autoConnect: true, trustedHosts: [] }));
  const port = await freePort();
  const environment = { ...process.env, DEEPSCORD_USER_DATA: data };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { env: environment, windowsHide: true, stdio: 'ignore' });
  const exited = once(child, 'exit');
  /** @type {Awaited<ReturnType<typeof connectPage>> | null} */
  let page = null;
  try {
    await waitForPort(port, 15000);
    page = await connectPage(port, 'file:');
    await page.waitFor('document.getElementById("version").textContent.includes("Electron")', { timeout: 10000, interval: 100, label: scenario });
    const state = await page.eval(`({ localButton: !!document.getElementById('localBtn'), startLocal: typeof window.deepscord.startLocal, create: !!document.getElementById('directCreateBtn'), join: !!document.getElementById('directJoinBtn'), connect: !!document.getElementById('connectBtn'), error: document.getElementById('error').textContent, apiCreate: typeof window.deepscord.createDirect, apiConnect: typeof window.deepscord.connect })`, { awaitPromise: true, userGesture: true });
    assert.equal(state.localButton, false);
    assert.equal(state.startLocal, 'undefined');
    assert.equal(state.create && state.join && state.connect, true);
    assert.equal(state.apiCreate, 'function');
    assert.equal(state.apiConnect, 'function');
    if (scenario === 'legacy') assert.match(state.error, /独立服务端/);
    else assert.equal(state.error, '');
    await assertNoLegacyListener();
    assert.equal(fs.existsSync(path.join(data, 'local-data')), false);
    if (scenario === 'legacy') {
      const roomPort = await freePort();
      await page.eval(`document.getElementById('directAddress').value = '127.0.0.1'; document.getElementById('directPort').value = '${roomPort}'; document.getElementById('directCreateBtn').click();`, { awaitPromise: true, userGesture: true });
      await page.waitFor('!document.getElementById("directCreated").hidden || document.getElementById("error").classList.contains("show") && !document.getElementById("directCreateBtn").disabled', { timeout: 25000, interval: 100, label: 'real direct room creation' });
      const room = await page.eval(`({created: !document.getElementById('directCreated').hidden, invite: document.getElementById('directInvite').value, error: document.getElementById('error').textContent})`, { awaitPromise: true, userGesture: true });
      assert.equal(room.created, true, room.error);
      assert.match(room.invite, /^deepscord:\/\/join\?/);
      await assertNoLegacyListener();
      console.log('PASS real direct room creation with invitation');
    }
    console.log(`PASS ${scenario}: no local entry/API/listener; direct and independent server entries retained`);
    page.send('Runtime.evaluate', { expression: 'window.deepscord.quit()', userGesture: true }).catch((error) => console.warn('Quit request response unavailable', { message: error.message }));
    await Promise.race([exited, sleep(5000).then(() => { if (child.exitCode === null) throw new Error('Electron failed to quit'); })]);
    if (scenario === 'legacy') assert.equal(fs.readdirSync(path.join(data, 'direct-rooms')).length, 0);
    await assertNoLegacyListener();
  } finally {
    if (page) page.close();
    if (child.exitCode === null) child.kill();
    await exited;
  }
}

try {
  await assertNoLegacyListener();
  await checkClient('fresh');
  await checkClient('legacy');
} finally {
  assert.equal(path.dirname(temporary), os.tmpdir());
  assert.ok(path.basename(temporary).startsWith('deepscord-client-split-'));
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
