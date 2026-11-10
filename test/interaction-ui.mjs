import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, connectPage, closeChrome } from './cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'deepscord-interaction-ui-'));
const routes = new Map([
  ['/custom.avif', ['test/avif-codec-fixtures/transparent-animation.avif', 'image/avif']],
  ['/app.css', ['public/app.css', 'text/css']],
  ['/interaction.css', ['public/interaction.css', 'text/css']],
  ['/interaction-ui.js', ['public/js/interaction-ui.js', 'text/javascript']],
  ['/interaction-catalog.js', ['public/js/interaction-catalog.js', 'text/javascript']],
  ['/assets/interactions/bomb.svg', ['public/assets/interactions/bomb.svg', 'image/svg+xml']],
  ['/assets/interactions/poop.svg', ['public/assets/interactions/poop.svg', 'image/svg+xml']],
]);
const server = http.createServer(async (request, response) => {
  const route = routes.get(request.url ?? '');
  if (route) { response.writeHead(200, { 'Content-Type': route[1] }); response.end(await fs.readFile(path.join(root, route[0]))); return; }
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end('<!doctype html><html><head><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/interaction.css"></head><body><main id="app" style="display:block;padding:16px"><div id="stage" class="stage-grid"><div id="self" class="tile"><div class="tile-name">Self</div></div><div id="peer" class="tile"><div class="tile-name">Peer</div><video id="video" style="width:100%;height:80px"></video><label class="peer-volume"><span>音量</span><input id="slider" type="range"></label><button id="watch" class="screen-watch">观看画面</button></div><div id="other" class="tile"><div class="tile-name">Other</div></div></div><button id="outside">Outside</button></main></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert(address && typeof address !== 'string');
const portProbe = net.createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const debugAddress = portProbe.address(); assert(debugAddress && typeof debugAddress !== 'string');
const debugPort = debugAddress.port;
await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
const url = `http://127.0.0.1:${address.port}/`;
let browser = null;
try {
  browser = (await launchChrome({ port: debugPort, userDataDir: profile, url, headless: true })).child;
  const page = await connectPage(debugPort, url);
  try {
    await page.waitFor("document.readyState === 'complete' && !!document.getElementById('peer')", { timeout: 10000, interval: 100, label: 'interaction fixture ready' });
    await page.eval(`(async () => {
      const {createInteractionUI} = await import('/interaction-ui.js');
      window.loads=0;window.live=0;window.customCatalog=[{id:'default-bomb',name:'炸弹',thumbnail:null,model:'bomb',trajectory:'arc',sound:'bomb-1',durationMs:1000},{id:'default-poop',name:'便便',thumbnail:null,model:'poop',trajectory:'linear',sound:'poop',durationMs:650}]; window.sent=[]; window.channel='voice'; window.eligible=true; window.errors=[];
      window.ui=createInteractionUI({loadThumbnail:async(asset,signal)=>{window.loads++;const response=await fetch('/custom.avif',{signal});const url=URL.createObjectURL(await response.blob());window.live++;return{url,release:()=>{window.live--;URL.revokeObjectURL(url);}};},getCatalog:()=>window.customCatalog,getSelfId:()=> 'self',getChannelId:()=>window.channel,canThrow:()=>window.eligible,onThrow:(userId,kind)=>{if(window.rejectThrow)throw new Error('Interaction rate limit reached');window.sent.push({userId,kind});},reportError:error=>window.errors.push(error.message)});
      window.videoBefore=document.getElementById('video'); window.sliderBefore=document.getElementById('slider');
      for(const id of ['self','peer','other']) window.ui.decorateCard(document.getElementById(id),id);
      for(let n=0;n<4;n++) window.ui.decorateCard(document.getElementById('peer'),'peer');
    })()`);
    const setup = await page.eval(`(() => ({self:document.querySelectorAll('#self [data-testid="interaction-trigger"]').length,peers:document.querySelectorAll('[data-testid="interaction-trigger"]').length,unchanged:window.videoBefore===document.getElementById('video')&&window.sliderBefore===document.getElementById('slider'),footer:document.querySelector('#peer').lastElementChild.className}))()`);
    assert.deepEqual(setup, { self: 0, peers: 2, unchanged: true, footer: 'interaction-card-actions' });
    await page.eval(`document.querySelector('[data-testid="interaction-trigger"][data-target-user="peer"]').click()`);
    await page.waitFor(`Array.from(document.querySelectorAll('[data-testid="interaction-picker"] img')).every(image=>image.complete&&image.naturalWidth>0)`, { timeout: 5000, interval: 50, label: 'catalog model thumbnails loaded' });
    const opened = await page.eval(`(() => {const picker=document.querySelector('[data-testid="interaction-picker"]');const item=document.querySelector('[data-testid="interaction-default-bomb"]');return {hidden:picker.hidden,target:picker.dataset.targetUser,focused:document.activeElement===item,labels:[...picker.querySelectorAll('.interaction-item-name')].every(name=>getComputedStyle(name).opacity==='1'),images:[...picker.querySelectorAll('img')].every(image=>image.complete&&image.naturalWidth>0)};})()`);
    assert.deepEqual(opened, { hidden: false, target: 'peer', focused: true, labels: true, images: true });
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' });
    assert.equal(await page.eval('document.activeElement.dataset.testid'), 'interaction-default-poop');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    assert.deepEqual(await page.eval('window.sent'), [{ userId: 'peer', kind: 'default-poop' }]);
    assert.equal(await page.eval(`!document.querySelector('[data-testid="interaction-picker"]').hidden&&document.querySelector('[data-testid="interaction-picker"]').dataset.targetUser==='peer'&&document.activeElement.dataset.testid==='interaction-default-poop'`), true, 'Sending closed or retargeted the picker');
    await page.eval(`document.querySelector('[data-testid="interaction-default-poop"]').click();window.rejectThrow=true;document.querySelector('[data-testid="interaction-default-bomb"]').click();window.rejectThrow=false`);
    assert.deepEqual(await page.eval('window.errors.splice(0)'), ['Interaction rate limit reached']);
    assert.equal(await page.eval(`window.sent.length===2&&!document.querySelector('[data-testid="interaction-picker"]').hidden&&document.querySelector('[data-testid="interaction-picker"]').dataset.targetUser==='peer'`), true, 'Repeated send or rate-limit reporting changed the target');
    await page.eval(`document.querySelector('[data-testid="interaction-trigger"][data-target-user="other"]').click();document.querySelector('[data-testid="interaction-default-bomb"]').click()`);
    assert.deepEqual(await page.eval('window.sent'), [{ userId: 'peer', kind: 'default-poop' }, { userId: 'peer', kind: 'default-poop' }, { userId: 'other', kind: 'default-bomb' }]);
    await page.eval(`document.querySelector('[data-testid="interaction-trigger"][data-target-user="peer"]').click()`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    assert.equal(await page.eval(`document.querySelector('[data-testid="interaction-picker"]').hidden&&document.activeElement.dataset.targetUser==='peer'`), true);
    await page.eval(`document.querySelector('[data-testid="interaction-trigger"][data-target-user="peer"]').click();document.getElementById('outside').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
    assert.equal(await page.eval(`document.querySelector('[data-testid="interaction-picker"]').hidden`), true);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 420, deviceScaleFactor: 1, mobile: false });
    await page.eval(`document.querySelector('[data-testid="interaction-trigger"][data-target-user="peer"]').click();window.ui.reconcile()`);
    const narrow = await page.eval(`(() => {const picker=document.querySelector('[data-testid="interaction-picker"]').getBoundingClientRect();const trigger=document.querySelector('#peer [data-testid="interaction-trigger"]').getBoundingClientRect();const watch=document.getElementById('watch').getBoundingClientRect();return {clamped:picker.left>=8&&picker.right<=innerWidth-8&&picker.top>=8&&picker.bottom<=innerHeight-8,separate:trigger.top>=watch.bottom};})()`);
    assert.deepEqual(narrow, { clamped: true, separate: true });
    await page.screenshot(path.join(root, '.qa-tools', 'results', 'interaction-picker-narrow.png'));
    await page.eval(`window.channel='different';window.ui.reconcile()`);
    assert.equal(await page.eval(`document.querySelector('[data-testid="interaction-picker"]').hidden`), true);
    await page.eval(`document.querySelector('[data-testid="interaction-trigger"][data-target-user="peer"]').click();document.getElementById('peer').hidden=true;window.ui.reconcile()`);
    assert.equal(await page.eval(`document.querySelector('[data-testid="interaction-picker"]').hidden&&document.querySelectorAll('#peer [data-testid="interaction-trigger"]').length===0`), true);
    await page.eval(`document.getElementById('peer').hidden=false;window.customCatalog=[{id:'snowball',name:'雪球',thumbnail:{sha256:'a'.repeat(64),bytes:1,width:100,height:100,animated:true,frames:2,durationMs:100},model:'thumbnail',trajectory:'linear',sound:'none',durationMs:400}];window.ui.reconcile();window.ui.decorateCard(document.getElementById('peer'),'peer')`);
    assert.equal(await page.eval('window.loads'),0,'Hidden picker fetched custom media');
    await page.eval(`document.querySelector('#peer [data-testid="interaction-trigger"]').click()`);
    await page.waitFor(`document.querySelector('[data-testid="interaction-snowball"] img').naturalWidth>0`,{timeout:5000,interval:50,label:'custom picker AVIF loaded'});
    assert.equal(await page.eval('window.loads'),1);
    await page.eval(`document.querySelector('[data-testid="interaction-snowball"]').click()`);
    assert.equal(await page.eval('window.live'),1,'Sending released the open picker thumbnail');
    await page.eval('window.ui.close()');
    assert.equal(await page.eval('window.live'),0,'Closing picker leaked a thumbnail lease');
    assert.deepEqual(await page.eval('window.sent.at(-1)'), {userId:'peer',kind:'snowball'});
    assert.equal(await page.eval('window.videoBefore===document.getElementById("video")'), true);
    await page.eval(`window.customCatalog=[];window.ui.reconcile()`);
    assert.equal(await page.eval('document.querySelector("[data-testid=interaction-snowball]")===null'), true);
    assert.equal(await page.eval('document.querySelectorAll(".interaction-item").length'),0,'Empty catalog restored deleted stock items');
    await page.eval(`document.querySelector('#peer [data-testid="interaction-trigger"]').click()`);
    assert.equal(await page.eval('!document.getElementById("interactionPicker").hidden&&!!document.querySelector("[data-testid=interaction-picker-empty]")'),true);
    await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight'});
    assert.deepEqual(await page.eval('window.errors'),[]);
    await page.eval(`window.eligible=false;window.ui.reconcile()`);
    assert.equal(await page.eval(`document.querySelectorAll('[data-testid="interaction-trigger"]').length`), 0);
    await page.eval(`window.ui.destroy()`);
    assert.equal(await page.eval(`document.querySelector('[data-testid="interaction-picker"]')===null&&window.videoBefore===document.getElementById('video')&&window.errors.length===0`), true);
    console.log('PASS: targeted thumbnail menu, keyboard selection, self exclusion, narrow viewport, close/cleanup and stable media DOM');
  } finally { page.close(); }
} finally {
  await closeChrome(debugPort);
  if (browser && browser.exitCode === null) browser.kill();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  assert.equal(path.dirname(profile), os.tmpdir()); assert(path.basename(profile).startsWith('deepscord-interaction-ui-'));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
