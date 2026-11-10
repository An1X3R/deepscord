// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, connectPage, closeChrome } from './cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'deepscord-poke-session-'));
const server = http.createServer(async (request, response) => {
  const requested = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (requested === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><html><head><link rel="stylesheet" href="/public/app.css"></head><body><main id="app" style="height:100vh"></main></body></html>'); return;
  }
  const file = path.resolve(root, '.' + requested);
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !/^\/(public\/(js\/[^/]+\.js|vendor\/livekit-client\.js|app\.css)|test\/poke-session-(page|voice)\.js)$/.test(requested)) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : 'text/javascript' }); response.end(await fs.readFile(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
const address = server.address(); assert(address && typeof address !== 'string');
const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', () => resolve(undefined)));
const debug = probe.address(); assert(debug && typeof debug !== 'string'); const port = debug.port;
await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve(undefined)));
const url = `http://127.0.0.1:${address.port}/`;
/** @type {import('node:child_process').ChildProcess|null} */ let browser = null;
try {
  browser = (await launchChrome({ port, userDataDir: profile, url, headless: true, extraArgs: ['--allow-loopback-in-peer-connection'] })).child;
  const page = await connectPage(port, url);
  try {
    await page.waitFor("document.readyState === 'complete' && !!document.getElementById('app')", { timeout: 10000, interval: 100, label: 'poke session test ready' });
    const report = await page.eval("import('/test/poke-session-page.js').then(module=>module.run())");
    const voice = await page.eval("import('/test/poke-session-voice.js').then(module=>module.runVoice())");
    report.checks.push(...voice.checks); report.errors.push(...voice.errors);
    assert.equal(report.errors.length, 0); assert(report.checks.length >= 20);
    console.log(JSON.stringify(report, null, 2));
  } finally { page.close(); }
} finally {
  await closeChrome(port); if (browser && browser.exitCode === null) browser.kill();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve(undefined)));
  assert.equal(path.dirname(profile), os.tmpdir()); assert(path.basename(profile).startsWith('deepscord-poke-session-'));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
