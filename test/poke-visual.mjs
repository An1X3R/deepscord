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
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'deepscord-poke-visual-'));
const routes = new Map([
  ['/app.css', ['public/app.css', 'text/css']],
  ['/poke-visual.js', ['public/js/poke-visual.js', 'text/javascript']],
]);
const server = http.createServer(async (request, response) => {
  const route = routes.get(request.url ?? '');
  if (route) { response.writeHead(200, { 'Content-Type': route[1] }); response.end(await fs.readFile(path.join(root, route[0]))); return; }
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end('<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><main id="app"><div data-testid="stage" style="position:relative;width:800px;height:500px;margin:40px;background:#15191b"><video data-testid="video" autoplay muted style="display:block;width:800px;height:500px;object-fit:contain"></video><div data-testid="layer" class="poke-overlay-layer"></div></div></main></body></html>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
const address = server.address(); assert(address && typeof address !== 'string');
const portProbe = net.createServer();
await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', () => resolve(undefined)));
const debugAddress = portProbe.address(); assert(debugAddress && typeof debugAddress !== 'string');
const debugPort = debugAddress.port;
await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve(undefined)));
const url = `http://127.0.0.1:${address.port}/`;
/** @type {import('node:child_process').ChildProcess|null} */
let browser = null;
try {
  browser = (await launchChrome({ port: debugPort, userDataDir: profile, url, headless: true })).child;
  const page = await connectPage(debugPort, url);
  try {
    await page.waitFor("document.readyState === 'complete' && !!document.querySelector('[data-testid=video]')", { timeout: 10000, interval: 100, label: 'real video stage ready' });
    const result = await page.eval(`(async () => {
      const {getVideoContentRect,createPokeMarker}=await import('/poke-visual.js');
      const video=document.querySelector('[data-testid="video"]');
      const layer=document.querySelector('[data-testid="layer"]');
      const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
      const context=canvas.getContext('2d');context.fillStyle='#26383a';context.fillRect(0,0,640,360);
      video.srcObject=canvas.captureStream(10);await video.play();
      const letterbox=getVideoContentRect(video);const box=video.getBoundingClientRect();
      const markers=[1,3,5].map((combo,index)=>{const marker=createPokeMarker({combo},'指点者 '+combo);marker.style.left=(200+index*180)+'px';marker.style.top='240px';layer.append(marker);return marker;});
      video.style.width='400px';video.style.height='500px';
      const pillarbox=getVideoContentRect(video);
      video.style.width='800px';video.style.height='200px';
      const wide=getVideoContentRect(video);
      video.style.width='800px';video.style.height='500px';
      const inactive=document.createElement('video');
      return {letterbox,box:{left:box.left,top:box.top},pillarbox,wide,heats:markers.map(node=>node.dataset.heat),hands:markers.map(node=>({text:node.querySelector('.poke-hand').textContent,size:getComputedStyle(node.querySelector('.poke-hand')).fontSize,scale:getComputedStyle(node).getPropertyValue('--poke-scale').trim()})),inactive:getVideoContentRect(inactive)};
    })()`);
    assert.equal(result.letterbox.width, 800); assert.equal(result.letterbox.height, 450);
    assert.equal(result.letterbox.left, result.box.left); assert.equal(result.letterbox.top, result.box.top + 25);
    assert.equal(result.pillarbox.width, 400); assert.equal(result.pillarbox.height, 225);
    assert(Math.abs(result.wide.width - 355.55555555555554) < 0.001); assert.equal(result.wide.height, 200);
    assert.deepEqual(result.heats, ['1', '2', '3']); assert(result.hands.every(hand => hand.text === '👆' && hand.size === '32px')); assert.deepEqual(result.hands.map(hand => hand.scale), ['1', '1.1', '1.2']); assert.equal(result.inactive, null);
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const animations = await page.eval("[...document.querySelectorAll('[data-testid=poke-finger]')].map(node=>[getComputedStyle(node).animationName,getComputedStyle(node.querySelector('.poke-hand')).animationName])");
    assert.deepEqual(animations, [['none', 'none'], ['none', 'none'], ['none', 'none']]);
    await page.screenshot(path.join(root, '.qa-tools', 'results', 'poke-visual.png'));
    await page.eval("document.querySelector('[data-testid=video]').srcObject.getTracks().forEach(track=>track.stop())");
    console.log('PASS: real video geometry, small emoji pointer, bounded heat scaling and reduced motion');
  } finally { page.close(); }
} finally {
  await closeChrome(debugPort);
  if (browser && browser.exitCode === null) browser.kill();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve(undefined)));
  assert.equal(path.dirname(profile), os.tmpdir()); assert(path.basename(profile).startsWith('deepscord-poke-visual-'));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
