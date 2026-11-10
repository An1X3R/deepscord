// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServerTrust, connectionOrigin } from '../desktop/server-trust.cjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deepscord-server-trust-'));
const root = fileURLToPath(new URL('..', import.meta.url));
/** @param {string} command @param {string[]} args @param {NodeJS.ProcessEnv} env @returns {Promise<void>} */
function command(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += String(data); });
    child.stderr.on('data', (data) => { output += String(data); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Fixture process failed (${code}): ${output}`)));
  });
}
/** @param {string} name @returns {tls.SecureContextOptions} */
function fixture(name) { return { pfx: fs.readFileSync(path.join(directory, name + '.pfx')), passphrase: 'fixture-password' }; }
/** @param {string} name @returns {X509Certificate} */
function certificate(name) { return new X509Certificate(fs.readFileSync(path.join(directory, name + '.cer'))); }
/** @param {string} name @returns {Promise<{server:tls.Server, origin:string, bytes:()=>number}>} */
async function server(name) {
  let bytes = 0;
  const server = tls.createServer(fixture(name), (socket) => { socket.on('data', (data) => { bytes += data.length; }); socket.end(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(undefined)); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return { server, origin: `https://127.0.0.1:${address.port}`, bytes: () => bytes };
}
/** @param {tls.Server} server @returns {Promise<void>} */
function close(server) { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
/** @param {string} name @param {(details:import('../desktop/server-trust.cjs').ConsentDetails)=>Promise<boolean>} requestConsent */
function connector(name, requestConsent) {
  return createServerTrust({ storePath: path.join(directory, name + '.json'), timeoutMs: 3000, requestConsent, logger: { warn: (message, fields) => console.warn(message, fields) } });
}
/** @param {ReturnType<typeof createServerTrust>} trust @param {string} origin @param {string} name @returns {number} */
function verify(trust, origin, name) {
  let result = 999;
  trust.verifyCertificate(origin, { hostname: '127.0.0.1', certificate: { data: certificate(name).toString() } }, (code) => { result = code; });
  return result;
}

test('server certificate trust uses exact origin pins and real TLS without application traffic', async (t) => {
  try {
    assert(process.env.SystemRoot);
    await command(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'test/server-trust-certificates.ps1')], { ...process.env, DEEPSCORD_TEST_CERTIFICATES: directory });
    await t.test('only HTTPS and literal loopback HTTP are accepted', () => {
      assert.equal(connectionOrigin('https://example.org:8443/path'), 'https://example.org:8443');
      for (const address of ['http://localhost:8080', 'http://127.0.0.2:8080', 'http://[::1]:8080']) assert.equal(connectionOrigin(address), address);
      for (const address of ['http://example.org', 'http://localhost.evil.test', 'https://user:pass@example.org', 'file:///tmp/a', 'ws://localhost']) assert.throws(() => connectionOrigin(address));
    });
    await t.test('fresh consent is persisted, reconnects compare pins, changed certificate fails closed', async () => {
      const endpoint = await server('self-a');
      let prompts = 0;
      const trust = connector('accepted', async (details) => {
        prompts += 1;
        assert.equal(details.origin, endpoint.origin);
        assert.equal(details.fingerprint.length, 64);
        assert.match(details.subject, /localhost/);
        assert.match(details.issuer, /localhost/);
        assert(Number.isFinite(Date.parse(details.validTo)));
        return true;
      });
      try {
        const prepared = await trust.prepareConnection(endpoint.origin);
        assert.equal(prepared.fingerprint, certificate('self-a').fingerprint256.replaceAll(':', '').toLowerCase());
        assert.equal(verify(trust, endpoint.origin, 'self-a'), 0);
        assert.equal(verify(trust, endpoint.origin, 'self-b'), -2);
        trust.verifyCertificate(endpoint.origin, { hostname: 'foreign.example', certificate: { data: certificate('self-a').toString() } }, (code) => assert.equal(code, -2));
        trust.verifyCertificate(endpoint.origin, { hostname: '127.0.0.1', certificate: { data: 'invalid certificate' } }, (code) => assert.equal(code, -2));
        assert.equal(verify(trust, endpoint.origin + '1', 'self-a'), -2);
        const restored = connector('accepted', async () => { throw new Error('Persisted certificate must not prompt again'); });
        await restored.prepareConnection(endpoint.origin);
        assert.equal(verify(restored, endpoint.origin, 'self-a'), 0);
        endpoint.server.setSecureContext(fixture('self-b'));
        await assert.rejects(trust.prepareConnection(endpoint.origin), { code: 'CERTIFICATE_PIN_CHANGED' });
        endpoint.server.setSecureContext(fixture('valid-ca'));
        await assert.rejects(trust.prepareConnection(endpoint.origin), { code: 'CERTIFICATE_PIN_CHANGED' });
        assert.equal(prompts, 1);
        assert.equal(endpoint.bytes(), 0);
        assert.throws(() => trust.clearPin(endpoint.origin, '0'.repeat(64)), { code: 'CERTIFICATE_PIN_CHANGED' });
        assert(prepared.fingerprint);
        trust.clearPin(endpoint.origin, prepared.fingerprint);
        assert.equal(verify(trust, endpoint.origin, 'self-a'), -2);
      } finally { await close(endpoint.server); }
    });
    await t.test('same hostname and same certificate on another port requires independent consent', async () => {
      const first = await server('self-a');
      const second = await server('self-a');
      let prompts = 0;
      const trust = connector('ports', async () => { prompts += 1; return prompts === 1; });
      try {
        await trust.prepareConnection(first.origin);
        assert.equal(verify(trust, second.origin, 'self-a'), -2);
        await assert.rejects(trust.prepareConnection(second.origin), { code: 'CERTIFICATE_DECLINED' });
        assert.equal(prompts, 2);
        assert.equal(fs.readFileSync(path.join(directory, 'ports.json'), 'utf8').includes(second.origin), false);
      } finally { await close(first.server); await close(second.server); }
    });
    await t.test('expired and not-yet-valid certificates are rejected before consent', async () => {
      const endpoint = await server('expired');
      const trust = connector('dates', async () => { throw new Error('Invalid dates must not request consent'); });
      try {
        await assert.rejects(trust.prepareConnection(endpoint.origin), { code: 'CERTIFICATE_DATE_INVALID' });
        endpoint.server.setSecureContext(fixture('future'));
        await assert.rejects(trust.prepareConnection(endpoint.origin), { code: 'CERTIFICATE_DATE_INVALID' });
      } finally { await close(endpoint.server); }
    });
    await t.test('concurrent preparation shares one explicit consent and writes only stripped pin fields', async () => {
      const endpoint = await server('self-a');
      let prompts = 0;
      const trust = connector('concurrent', async () => { prompts += 1; return true; });
      try {
        const results = await Promise.all([trust.prepareConnection(endpoint.origin), trust.prepareConnection(endpoint.origin + '/path')]);
        assert.deepEqual(results[0], results[1]);
        assert.equal(prompts, 1);
        assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(directory, 'concurrent.json'), 'utf8')).pins[0]).sort(), ['fingerprint', 'origin']);
        assert.equal(fs.readdirSync(directory).some((name) => name.endsWith('.tmp')), false);
      } finally { await close(endpoint.server); }
    });
    await t.test('malformed, duplicate, oversized and legacy host stores fail closed', () => {
      for (const [name, content] of [
        ['invalid-json', '{'], ['legacy', JSON.stringify({ trustedHosts: ['127.0.0.1'] })],
        ['invalid-fingerprint', JSON.stringify({ version: 1, pins: [{ origin: 'https://localhost', fingerprint: 'bad' }] })],
        ['duplicate', JSON.stringify({ version: 1, pins: Array(2).fill({ origin: 'https://localhost', fingerprint: 'a'.repeat(64) }) })],
        ['oversized', ' '.repeat(131073)],
      ]) {
        fs.writeFileSync(path.join(directory, name + '.json'), content);
        assert.throws(() => connector(name, async () => true));
      }
    });
    await t.test('normal trusted chain uses default verification and hostname mismatch is rejected', async () => {
      const endpoint = await server('valid-ca');
      const env = { ...process.env, NODE_EXTRA_CA_CERTS: path.join(directory, 'root.pem') };
      try {
        await command(process.execPath, [path.join(root, 'test/server-trust-ca-child.cjs'), endpoint.origin, path.join(directory, 'ca.json'), 'valid'], env);
        assert.equal(fs.existsSync(path.join(directory, 'ca.json')), false);
        endpoint.server.setSecureContext(fixture('wrong-host'));
        await command(process.execPath, [path.join(root, 'test/server-trust-ca-child.cjs'), endpoint.origin, path.join(directory, 'ca.json'), 'wrong-host'], env);
        assert.equal(endpoint.bytes(), 0);
      } finally { await close(endpoint.server); }
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
