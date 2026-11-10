'use strict';
// @ts-check
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomUUID, randomBytes } = require('node:crypto');
const { liveKitConfig } = require('./livekit-config.cjs');
const { RoomServiceClient } = require('livekit-server-sdk');
const root = path.resolve(__dirname, '..');

/** @param {string} parent @param {string} target @returns {boolean} */
function under(parent, target) { const relative = path.relative(parent, target); return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative); }

/** @returns {string} */
function runtime() {
  const source = process.env.ELECTRON_TEST_BINARY;
  assert(source && fs.statSync(source).isFile(), 'Set ELECTRON_TEST_BINARY to the approved packaged Electron executable');
  const original = path.dirname(path.resolve(source));
  const destination = path.join(root, '.qa-tools', 'screen-sfu-runtime');
  assert(original !== destination && !under(original, destination) && !under(destination, original), 'Runtime source/destination overlap');
  const marker = path.join(destination, '.screen-sfu-runtime.json');
  const identity = JSON.stringify({ source: path.resolve(source), modified: fs.statSync(source).mtimeMs });
  if (fs.existsSync(destination)) assert.equal(fs.readFileSync(marker, 'utf8'), identity, 'Runtime cache belongs to another source');
  else {
    const app = path.join(original, 'resources', 'app');
    const asar = path.join(original, 'resources', 'app.asar');
    fs.cpSync(original, destination, { recursive: true, filter: (value) => value !== app && !under(app, value) && value !== asar });
    fs.writeFileSync(marker, identity);
  }
  const app = path.join(destination, 'resources', 'app'); fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'deepscord-screen-sfu-test', version: '1.0.0', main: 'main.js' }));
  fs.writeFileSync(path.join(app, 'main.js'), "'use strict';\nrequire(" + JSON.stringify(__filename) + ');\n');
  return path.join(destination, path.basename(source));
}

/** @param {http.Server} server @returns {Promise<number>} */
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(undefined)); });
  const address = server.address(); assert(address && typeof address !== 'string'); return address.port;
}
/** @returns {Promise<number>} */
async function freePort() {
  const server = http.createServer(); const value = await listen(server);
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined))); return value;
}

/** @param {number} backendPort @returns {{server:http.Server,failAdmin:()=>void,recoverAdmin:()=>void,stats:()=>{removeRequests:number}}} */
function adminGate(backendPort) {
  let unavailable = false;
  let removeRequests = 0;
  const server = http.createServer((request, response) => {
    if (unavailable && (request.url || '').startsWith('/twirp/')) {
      response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: 'unavailable', msg: 'Controlled integration-test admin transport outage' })); return;
    }
    if ((request.url || '').startsWith('/twirp/livekit.RoomService/RemoveParticipant')) removeRequests += 1;
    const upstream = http.request({ hostname: '127.0.0.1', port: backendPort, method: request.method, path: request.url, headers: request.headers }, (reply) => { response.writeHead(reply.statusCode || 502, reply.headers); reply.pipe(response); });
    upstream.on('error', () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  server.on('upgrade', (request, socket, head) => {
    const upstream = http.request({ hostname: '127.0.0.1', port: backendPort, method: request.method, path: request.url, headers: request.headers });
    upstream.on('upgrade', (reply, remote, remaining) => {
      let headers = `HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n`;
      for (let index = 0; index < reply.rawHeaders.length; index += 2) headers += `${reply.rawHeaders[index]}: ${reply.rawHeaders[index + 1]}\r\n`;
      socket.write(headers + '\r\n'); if (remaining.length) socket.write(remaining); if (head.length) remote.write(head);
      socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy()); socket.once('close', () => remote.destroy()); remote.once('close', () => socket.destroy()); remote.pipe(socket); socket.pipe(remote);
    });
    upstream.on('response', (reply) => { reply.resume(); socket.destroy(); }); upstream.on('error', () => socket.destroy()); socket.once('close', () => upstream.destroy()); upstream.end();
  });
  return { server, failAdmin: () => { unavailable = true; }, recoverAdmin: () => { unavailable = false; }, stats: () => ({ removeRequests }) };
}
/** @param {string} url @returns {Promise<void>} */
async function ready(url) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; }
    catch (error) { if (!(error instanceof Error)) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Service did not become ready: ${url}`);
}
/** @param {string} executable @param {string[]} args @param {NodeJS.ProcessEnv} env @param {string} log @returns {import('node:child_process').ChildProcess} */
function child(executable, args, env, log) {
  const output = fs.openSync(log, 'a');
  const value = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', output, output] });
  fs.closeSync(output);
  value.once('error', (error) => { console.error(JSON.stringify({ event: 'screen-sfu-test-process-error', executable, name: error.name, message: error.message })); });
  return value;
}
/** @param {import('node:child_process').ChildProcess} value @returns {Promise<void>} */
async function stop(value) {
  if (value.exitCode !== null || value.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned test process failed to exit')), 5000);
    value.once('exit', () => { clearTimeout(timer); resolve(undefined); }); value.kill();
  });
}

/** @returns {Promise<void>} */
async function runNode() {
  const operation = process.env.DEEPSCORD_SFU_TEST_OPERATION;
  assert(operation === undefined || operation === 'media-policy', 'Unsupported SFU integration operation');
  const electron = runtime();
  const serverDirectory = process.env.DEEPSCORD_SFU_TEST_SERVER_DIRECTORY ? path.resolve(process.env.DEEPSCORD_SFU_TEST_SERVER_DIRECTORY) : root;
  assert(serverDirectory === root || under(path.join(root, 'dist'), serverDirectory), 'Standalone test target must be this source tree or an owned dist/ package');
  const directory = path.join(root, '.qa-tools', 'screen-sfu-tests', randomUUID()); fs.mkdirSync(directory, { recursive: true });
  const binary = serverDirectory === root ? path.join(root, '.qa-tools', 'livekit-1.13.11', 'livekit-server.exe') : path.join(serverDirectory, 'deploy', 'livekit-runtime', 'livekit-server.exe');
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'deploy', 'livekit-pin.json'), 'utf8'));
  assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), pin.executableSha256, 'LiveKit binary pin differs');
  const internalPort = await freePort(); const roomPort = await freePort(); const udpPort = await freePort(); const tcpPort = await freePort();
  const roomUrl = `http://127.0.0.1:${roomPort}`;
  /** @type {NodeJS.ProcessEnv} */ const env = { ...process.env, ECHO_SCREEN_MODE: 'sfu', ECHO_SCREEN_SFU_URL: `ws://127.0.0.1:${roomPort}/screen-sfu`, ECHO_SCREEN_TOKEN_TTL_SECONDS: '60', LIVEKIT_INTERNAL_URL: `http://127.0.0.1:${internalPort}`, LIVEKIT_NODE_IP: '127.0.0.1', LIVEKIT_UDP_PORT: String(udpPort), LIVEKIT_TCP_PORT: String(tcpPort), LIVEKIT_API_KEY: 'integration_' + randomBytes(8).toString('hex'), LIVEKIT_API_SECRET: randomBytes(48).toString('hex'), PORT: String(roomPort), HTTP_HOST: '127.0.0.1', HTTPS_PORTS: '0', ECHO_PASSWORD: 'screen-sfu-integration', ECHO_DATA_DIR: path.join(directory, 'room-data') };
  delete env.ELECTRON_RUN_AS_NODE;
  const privateConfig = path.join(directory, 'livekit-private.yaml'); fs.writeFileSync(privateConfig, liveKitConfig(env), { mode: 0o600 });
  const gate = adminGate(internalPort);
  /** @type {import('node:child_process').ChildProcess[]} */ const children = [];
  /** @type {(result:string)=>void} */ let complete = () => { throw new Error('Test result handler is not initialized'); };
  const result = new Promise((resolve) => { complete = resolve; });
  const fixture = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (request.method === 'POST' && url.pathname === '/admin-outage') { gate.failAdmin(); response.writeHead(200); response.end('ok'); return; }
    if (request.method === 'POST' && url.pathname === '/admin-recover') { gate.recoverAdmin(); response.writeHead(200); response.end('ok'); return; }
    if (request.method === 'GET' && url.pathname === '/admin-stats') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(gate.stats())); return; }
    if (request.method === 'GET' && url.pathname.startsWith('/screen-sfu/')) {
      http.get(roomUrl + url.pathname + url.search, (upstream) => { response.writeHead(upstream.statusCode || 502); upstream.pipe(response); }).on('error', () => { response.writeHead(502); response.end(); }); return;
    }
    if (request.method === 'POST' && url.pathname === '/result') {
      let body = ''; request.setEncoding('utf8'); request.on('data', (chunk) => { body += chunk; if (body.length > 100000) request.destroy(); });
      request.on('end', () => { response.writeHead(200); response.end('ok'); complete(body); }); return;
    }
    if (request.method !== 'GET' || !/^\/(public\/(js|vendor)\/[^/]+\.(js|json)|deploy\/livekit-test-page\.(html|js))$/.test(url.pathname)) { response.writeHead(404); response.end(); return; }
    const file = path.join(url.pathname.startsWith('/public/') ? serverDirectory : root, url.pathname.slice(1));
    response.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'text/javascript' }); fs.createReadStream(file).pipe(response);
  });
  try {
    children.push(child(binary, ['--config', privateConfig], env, path.join(directory, 'livekit.jsonl')));
    await ready(env.LIVEKIT_INTERNAL_URL || '');
    env.LIVEKIT_INTERNAL_URL = `http://127.0.0.1:${await listen(gate.server)}`;
    const node = serverDirectory === root ? process.execPath : path.join(serverDirectory, 'runtime', 'node.exe');
    children.push(child(node, [path.join(serverDirectory, 'server.js')], env, path.join(directory, 'room.log')));
    await ready(roomUrl + '/api/health');
    const fixturePort = await listen(fixture);
    const electronEnv = { ...env, DEEPSCORD_SFU_TEST_ROLE: 'electron', DEEPSCORD_SFU_TEST_URL: `http://127.0.0.1:${fixturePort}/deploy/livekit-test-page.html?base=${encodeURIComponent(roomUrl)}${operation ? '&operation=' + operation : ''}`, DEEPSCORD_SFU_TEST_PROFILE: path.join(directory, 'profile') };
    children.push(child(electron, [], electronEnv, path.join(directory, 'browser.log')));
    /** @type {ReturnType<typeof setTimeout>|null} */ let timer = null;
    try {
      const body = await Promise.race([result, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Real LiveKit integration exceeded 90000 ms; inspect retained service/browser logs')), 90000); })]);
      assert.equal(typeof body, 'string');
      const parsed = JSON.parse(/** @type {string} */ (body)); fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(parsed, null, 2));
      assert.equal(parsed.status, 'passed', parsed.error);
      assert(env.LIVEKIT_INTERNAL_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);
      const api = new RoomServiceClient(env.LIVEKIT_INTERNAL_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, { requestTimeout: 5, failover: false });
      const rooms = await api.listRooms(); assert.equal(rooms.length, 0, 'Source-room revocation did not delete the LiveKit room');
      console.log(JSON.stringify({ event: 'screen-sfu-integration-passed', result: path.join(directory, 'result.json'), checks: parsed.checks.length, decodedFrames: parsed.decodedFrames, server: pin.version }));
    } finally { if (timer) clearTimeout(timer); }
  } finally {
    for (const value of children.reverse()) await stop(value);
    fixture.closeAllConnections(); await new Promise((resolve) => fixture.close(() => resolve(undefined)));
    gate.server.closeAllConnections(); await new Promise((resolve) => gate.server.close(() => resolve(undefined)));
    fs.rmSync(privateConfig, { force: true });
  }
}

/** @returns {Promise<void>} */
async function runElectron() {
  const { app, BrowserWindow } = require('electron');
  const url = process.env.DEEPSCORD_SFU_TEST_URL; const profile = process.env.DEEPSCORD_SFU_TEST_PROFILE;
  assert(url && profile && under(path.join(root, '.qa-tools', 'screen-sfu-tests'), profile));
  app.setPath('userData', profile); app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
  await app.whenReady();
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  window.webContents.on('console-message', (event) => console.log(JSON.stringify({ event: 'browser-console', level: event.level, message: event.message })));
  window.webContents.on('render-process-gone', (event, details) => { console.error(JSON.stringify({ event: 'browser-renderer-exit', reason: details.reason })); app.exit(1); });
  await window.loadURL(url);
}

(process.versions.electron ? runElectron() : runNode()).catch((error) => { console.error(error); if (process.versions.electron) require('electron').app.exit(1); else process.exitCode = 1; });
