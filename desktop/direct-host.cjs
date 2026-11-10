// @ts-check
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID, X509Certificate } = require('node:crypto');
/** @type {typeof import('../lib/steam-state.cjs')} */
const { parseSteamRoomSeed } = require('./app-server/lib/steam-state.cjs');

/** @typedef {{origin:string,fingerprint:string,token:string}} Invitation */
/** @typedef {{address:string,port:number,roomSeed?:import('../lib/steam-state.cjs').SteamRoomSeed}} HostOptions */
/** @typedef {{process:import('node:child_process').ChildProcess, directory:string, origin:string, fingerprint:string, token:string, invite:string}} HostedRoom */

/** @param {string} value @returns {string} */
function endpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new TypeError('房间地址长度不正确');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('房间地址必须是 HTTPS 地址和端口，不能带路径、账号或参数');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!net.isIP(hostname) && (hostname.length > 253 || !hostname.replace(/\.$/, '').split('.').every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label)))) throw new TypeError('房间地址中的主机名不正确');
  return url.origin;
}

/** @param {string} value @returns {Invitation} */
function parseInvitation(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new TypeError('邀请格式不正确');
  const url = new URL(value.trim());
  const fingerprint = url.searchParams.get('fingerprint') || '';
  const token = new URLSearchParams(url.hash.slice(1)).get('token') || '';
  if (url.protocol !== 'deepscord:' || url.hostname !== 'join' || url.username || url.password || url.port || (url.pathname !== '' && url.pathname !== '/') || !/^[a-fA-F0-9]{64}$/.test(fingerprint) || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new TypeError('邀请必须包含房间地址、SHA-256 证书指纹及完整访问密钥');
  }
  for (const key of ['address', 'fingerprint']) if (url.searchParams.getAll(key).length !== 1) throw new TypeError('邀请字段重复或缺失');
  if (new URLSearchParams(url.hash.slice(1)).getAll('token').length !== 1) throw new TypeError('邀请密钥重复或缺失');
  return { origin: endpoint(url.searchParams.get('address') || ''), fingerprint: fingerprint.toLowerCase(), token };
}

/** @param {Invitation} invitation @returns {string} */
function invitationText(invitation) {
  return `deepscord://join?${new URLSearchParams({ address: invitation.origin, fingerprint: invitation.fingerprint })}#token=${invitation.token}`;
}

/** @returns {string[]} */
function localAddresses() {
  return [...new Set(Object.values(os.networkInterfaces()).flatMap((entries) => (entries || []).filter((entry) => !entry.internal && !entry.address.includes('%')).map((entry) => entry.family === 'IPv6' ? `[${entry.address}]` : entry.address)))];
}

/** @param {HostOptions} options @returns {HostOptions} */
function hostOptions(options) {
  if (!options || typeof options.address !== 'string' || typeof options.port !== 'number' || !Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new TypeError('请输入有效的房间地址和 1024–65535 端口');
  const origin = endpoint(`https://${options.address.trim()}:${options.port}`);
  return { address: new URL(origin).hostname, port: options.port, ...(options.roomSeed === undefined ? {} : { roomSeed: parseSteamRoomSeed(options.roomSeed) }) };
}

/** @returns {Promise<number>} */
function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (!address || typeof address === 'string') { listener.close(); reject(new Error('无法分配房间健康检查端口')); return; }
      listener.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

/** @param {string} directory @param {string} password @returns {Promise<string>} */
async function certificate(directory, password) {
  const pfxPath = path.join(directory, 'room.pfx');
  const windowsDirectory = process.env.SystemRoot;
  if (!windowsDirectory) throw new Error('Windows system directory is unavailable');
  const powershellPath = path.join(windowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await new Promise((resolve, reject) => {
    const child = spawn(powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'direct-certificate.ps1')], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, DEEPSCORD_PFX_PATH: pfxPath, DEEPSCORD_PFX_PASSWORD: password },
    });
    let errors = '';
    child.stderr.on('data', (chunk) => { errors = (errors + String(chunk)).slice(-4096); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(pfxPath) : reject(new Error(`创建临时房间证书失败 (${code}): ${errors.replaceAll(password, '[redacted]')}`)));
  });
  return pfxPath;
}

/** @param {number} port @param {string} instanceId @returns {Promise<boolean>} */
function healthy(port, instanceId) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 750 }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += String(chunk); if (body.length > 8192) request.destroy(); });
      response.on('end', () => {
        try { const data = JSON.parse(body); resolve(response.statusCode === 200 && data !== null && typeof data === 'object' && data.networkMode === 'direct' && data.instanceId === instanceId); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; resolve(false); }
      });
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => request.destroy());
  });
}

/** @param {number} port @param {string} instanceId @param {X509Certificate} expected @returns {Promise<boolean>} */
function healthyTls(port, instanceId, expected) {
  return new Promise((resolve) => {
    const request = https.get({ hostname: 'localhost', port, path: '/api/health', timeout: 750, ca: expected.toString(), checkServerIdentity: (_hostname, peer) => peer.fingerprint256 === expected.fingerprint256 ? undefined : new Error('Room certificate fingerprint mismatch') }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += String(chunk); if (body.length > 8192) request.destroy(); });
      response.on('end', () => {
        try { const data = JSON.parse(body); resolve(response.statusCode === 200 && data !== null && typeof data === 'object' && data.networkMode === 'direct' && data.instanceId === instanceId); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; resolve(false); }
      });
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => request.destroy());
  });
}

/** @param {string} userData @param {string} directory @returns {void} */
function cleanup(userData, directory) {
  const base = path.resolve(userData, 'direct-rooms');
  const target = path.resolve(directory);
  if (path.dirname(target) !== base || !path.basename(target).startsWith('room-')) throw new Error('拒绝清理房间数据：目录超出临时房间范围');
  fs.rmSync(target, { recursive: true, force: true });
}

/** @param {HostedRoom} room @returns {Promise<void>} */
async function stopRoom(room) {
  if (!room.process.pid || room.process.exitCode !== null || room.process.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    room.process.once('exit', () => resolve(undefined));
    if (!room.process.kill()) reject(new Error('无法停止房间进程，临时数据保留'));
  });
}

/** @param {HostOptions} input @param {string} userData @param {string} serverDir @param {string} executable @returns {Promise<HostedRoom>} */
async function startRoom(input, userData, serverDir, executable) {
  if (process.platform !== 'win32') throw new Error('客户端创建直连房间目前仅支持 Windows');
  const options = hostOptions(input);
  if (!fs.existsSync(path.join(serverDir, 'server.js'))) throw new Error('缺少内置房间服务，请重新同步桌面客户端');
  const base = path.join(userData, 'direct-rooms');
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'room-'));
  const password = randomBytes(32).toString('base64url');
  const token = randomBytes(32).toString('base64url');
  /** @type {HostedRoom | null} */
  let room = null;
  try {
    const pfxPath = await certificate(directory, password);
    const expected = new X509Certificate(fs.readFileSync(pfxPath + '.cer'));
    const fingerprint = expected.fingerprint256.replaceAll(':', '').toLowerCase();
    const port = await freePort();
    const instanceId = randomUUID();
    const environment = { ...process.env };
    for (const key of ['STUN_URL', 'STUN_URLS', 'TURN_URL', 'TURN_URLS', 'TURN_SECRET', 'TURN_USERNAME', 'TURN_CREDENTIAL', 'TURN_TTL_SECONDS', 'ECHO_ROOM_ID', 'ECHO_ROOM_CREATOR_KEY', 'ECHO_ROOM_SEED_PATH', 'ECHO_GOVERNANCE_SEED_PATH']) delete environment[key];
    if (options.roomSeed) {
      const seedPath = path.join(directory, 'room-seed.json');
      fs.writeFileSync(seedPath, JSON.stringify(options.roomSeed.document), { flag: 'wx' });
      environment.ECHO_ROOM_ID = options.roomSeed.roomId;
      environment.ECHO_ROOM_CREATOR_KEY = options.roomSeed.creatorKey;
      environment.ECHO_ROOM_SEED_PATH = seedPath;
      if (options.roomSeed.governance) {
        const governancePath=path.join(directory,'governance-seed.json');
        fs.writeFileSync(governancePath,JSON.stringify(options.roomSeed.governance),{flag:'wx'});
        environment.ECHO_GOVERNANCE_SEED_PATH=governancePath;
      }
    }
    const child = spawn(executable, [path.join(serverDir, 'server.js')], { cwd: serverDir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: {
      ...environment, ELECTRON_RUN_AS_NODE: '1', PORT: String(port), HTTP_HOST: '127.0.0.1', HTTPS_HOST: '::', HTTPS_PORTS: String(options.port), ECHO_TLS_PFX_PATH: pfxPath, ECHO_TLS_PFX_PASSWORD: password, ECHO_DATA_DIR: directory, ECHO_MEDIA_ROOT:path.join(userData,'chat-media'), ECHO_NETWORK_MODE: 'direct', ECHO_MEDIA_POLICY: 'direct', ECHO_SCREEN_MODE: 'peer-relay', ECHO_PASSWORD: token, ECHO_INSTANCE_ID: instanceId,
    } });
    const origin = `https://${options.address}:${options.port}`;
    room = { process: child, directory, origin, fingerprint, token, invite: invitationText({ origin, fingerprint, token }) };
    let errors = '';
    /** @type {Error | null} */ let spawnError = null;
    child.stderr.on('data', (chunk) => { errors = (errors + String(chunk)).slice(-4096); });
    child.once('error', (error) => { spawnError = error; if (!child.pid) cleanup(userData, directory); });
    child.once('exit', () => cleanup(userData, directory));
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`房间进程退出 (${child.exitCode}): ${errors.replaceAll(token, '[redacted]').replaceAll(password, '[redacted]')}`);
      if (await healthy(port, instanceId) && await healthyTls(options.port, instanceId, expected)) return room;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`房间启动超时，请检查 TCP 端口 ${options.port} 是否已占用`);
  } catch (error) {
    if (room) await stopRoom(room); else cleanup(userData, directory);
    throw error;
  }
}

module.exports = { endpoint, parseInvitation, invitationText, localAddresses, hostOptions, startRoom, stopRoom, certificate, cleanup };
