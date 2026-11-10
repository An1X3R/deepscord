import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, connectPage, closeChrome } from './cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.qa-tools', 'results');
await fs.mkdir(output, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'deepscord-interaction-renderer-'));
const routes = new Map([
  ['/app.css', ['public/app.css', 'text/css']],
  ['/interaction.css', ['public/interaction.css', 'text/css']],
  ['/custom.avif', ['test/avif-codec-fixtures/transparent-animation.avif', 'image/avif']],
  ['/interaction-scene.js', ['public/js/interaction-scene.js', 'text/javascript']],
  ['/interaction-scene-drawing.js', ['public/js/interaction-scene-drawing.js', 'text/javascript']],
  ['/interaction-scene-examples.js', ['public/js/interaction-scene-examples.js', 'text/javascript']],
  ['/interaction-renderer.js', ['public/js/interaction-renderer.js', 'text/javascript']],
  ['/interaction-catalog.js', ['public/js/interaction-catalog.js', 'text/javascript']],
]);
const server = http.createServer(async (request, response) => {
  const route = routes.get(request.url ?? '');
  if (route) { response.writeHead(200, { 'Content-Type': route[1] }); response.end(await fs.readFile(path.join(root, route[0]))); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html><head><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/interaction.css"><style>body{overflow:auto}#app{display:block;padding:45px;width:900px}#members{display:flex;justify-content:space-between;margin-bottom:30px}.tile{width:180px}.avatar{display:grid;place-items:center;width:64px;height:64px;font-size:26px;background:#3a6761;color:#e5faf4}video{display:block;width:720px;height:300px;background:#171f20}</style></head><body><main id="app"><div id="members"><div class="tile"><div id="from" class="avatar">A</div><div class="tile-name">发起成员</div></div><div class="tile"><div id="to" class="avatar">B</div><div class="tile-name">目标成员</div></div></div><video id="video" autoplay muted playsinline></video></main></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert(address && typeof address !== 'string');
const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const debug = probe.address(); assert(debug && typeof debug !== 'string');
const debugPort = debug.port;
await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
const url = `http://127.0.0.1:${address.port}/`;
let browser = null;
try {
  browser = (await launchChrome({ port: debugPort, userDataDir: profile, url, headless: true, windowSize: '1000,760' })).child;
  const page = await connectPage(debugPort, url);
  try {
    const errors = [];
    await page.send('Runtime.enable'); page.on('Runtime.exceptionThrown', event => errors.push(event));
    await page.waitFor("document.readyState==='complete'&&!!document.getElementById('video')", { timeout: 10000, interval: 100, label: 'renderer fixture ready' });
    await page.eval(`(async()=>{
      const {createInteractionRenderer}=await import('/interaction-renderer.js');
      const {INTERACTIONS}=await import('/interaction-catalog.js');
      window.catalog=INTERACTIONS;window.impacts=[];window.started=new Map();window.sequence=0;
      window.renderer=createInteractionRenderer({getAvatar:id=>document.getElementById(id),onImpact:event=>window.impacts.push({id:event.eventId,kind:event.kind,elapsed:performance.now()-window.started.get(event.eventId)})});
      window.play=(kind,from,to)=>{const event={eventId:'event-'+(++window.sequence),channelId:'voice',fromUserId:from,toUserId:to,kind,soundIndex:0};window.started.set(event.eventId,performance.now());window.renderer.play(event);return event.eventId;};
      window.wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      window.pixels=()=>{const canvas=document.querySelector('[data-testid="interaction-animation"]');if(!canvas)return null;const bytes=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let count=0,left=canvas.width,top=canvas.height,right=0,bottom=0;for(let index=3;index<bytes.length;index+=4)if(bytes[index]){const pixel=(index-3)/4,x=pixel%canvas.width,y=Math.floor(pixel/canvas.width);count++;left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}return{count,left,top,right,bottom,width:canvas.width,height:canvas.height};};
      const source=document.createElement('canvas');source.width=720;source.height=300;const context=source.getContext('2d');
      window.liveFrame=0;window.paint=()=>{context.fillStyle='#263b3a';context.fillRect(0,0,720,300);context.fillStyle='#87d8ce';context.fillRect((window.liveFrame*5)%660,105,60,90);context.font='20px sans-serif';context.fillText('LIVE VIDEO · '+window.liveFrame,24,42);window.liveFrame++;window.paintRequest=requestAnimationFrame(window.paint);};window.paint();
      const video=document.getElementById('video');video.srcObject=source.captureStream(30);window.streamBefore=video.srcObject;window.videoBefore=video;await video.play();window.timeBefore=video.currentTime;
      window.frameBefore=video.getVideoPlaybackQuality().totalVideoFrames;
    })()`);
    const catalog = await page.eval('window.catalog');
    assert.deepEqual(catalog.map(item => [item.id, item.durationMs]), [['bomb', 1000], ['poop', 650]]);
    const bombPixels = await page.eval(`(async()=>{window.bombId=window.play('bomb','from','to');await window.wait(280);return window.pixels();})()`);
    assert(bombPixels && bombPixels.count > 300, 'Bomb mesh produced no substantial visible pixels');
    assert(bombPixels.top >= 8, 'Bomb flight clipped against the viewport top edge');
    await page.screenshot(path.join(output, 'interaction-renderer-bomb.png'));
    await page.waitFor(`window.impacts.some(event=>event.id===window.bombId)&&!document.querySelector('[data-testid="interaction-animation"]')`, { timeout: 3000, interval: 50, label: 'bomb impact and idle canvas release' });
    const poopPixels = await page.eval(`(async()=>{window.poopId=window.play('poop','from','to');await window.wait(230);return window.pixels();})()`);
    assert(poopPixels && poopPixels.count > 300, 'Poop glyph produced no substantial visible pixels');
    await page.screenshot(path.join(output, 'interaction-renderer-poop.png'));
    await page.waitFor(`window.impacts.some(event=>event.id===window.poopId)&&!document.querySelector('[data-testid="interaction-animation"]')`, { timeout: 2500, interval: 50, label: 'poop impact and idle canvas release' });
    const playback = await page.eval(`(()=>{const video=document.getElementById('video');return{identity:video===window.videoBefore&&video.srcObject===window.streamBefore,playing:!video.paused&&!video.ended,time:video.currentTime-window.timeBefore,frames:video.getVideoPlaybackQuality().totalVideoFrames-window.frameBefore};})()`);
    assert(playback.identity && playback.playing && playback.time > 1.5 && playback.frames > 20, 'Live video failed to keep playing through both animations: '+JSON.stringify(playback));
    const timing = await page.eval('window.impacts.slice()');
    for (const hit of timing) { const duration = catalog.find(item => item.id === hit.kind).durationMs; assert(hit.elapsed >= duration - 20 && hit.elapsed < duration + 500, 'Impact callback outside flight timing: '+JSON.stringify(hit)); }
    const burst = await page.eval(`(async()=>{window.impacts=[];window.burstIds=[];let max=0;for(let index=0;index<12;index++){window.burstIds.push(window.play('bomb','from','to'));max=Math.max(max,document.querySelectorAll('[data-testid="interaction-animation"]').length);}await window.wait(60);return{max,pixels:window.pixels()};})()`);
    assert.equal(burst.max, 1); assert(burst.pixels.count > 300);
    await page.waitFor(`window.impacts.length===8&&!document.querySelector('[data-testid="interaction-animation"]')`, { timeout: 3000, interval: 50, label: 'bounded burst impacts and canvas cleanup' });
    assert.deepEqual(await page.eval('window.impacts.map(hit=>hit.id)'), await page.eval('window.burstIds.slice(-8)'));
    const cancellation = await page.eval(`(async()=>{window.impacts=[];window.play('bomb','from','to');window.renderer.clear();window.play('poop','from','to');window.renderer.clearMember('to');window.play('bomb','from','to');window.renderer.clearMember('from');await window.wait(1150);return{impacts:window.impacts.length,canvases:document.querySelectorAll('[data-testid="interaction-animation"]').length};})()`);
    assert.deepEqual(cancellation, { impacts: 0, canvases: 0 });
    const invisible = await page.eval(`(async()=>{window.impacts=[];document.getElementById('to').style.display='none';window.play('poop','from','to');window.play('poop','from','missing');const canvases=document.querySelectorAll('[data-testid="interaction-animation"]').length;await window.wait(800);document.getElementById('to').style.display='';return{canvases,impacts:window.impacts.length};})()`);
    assert.deepEqual(invisible, { canvases: 0, impacts: 2 });
    const silence = await page.eval(`(async()=>{window.renderer.clear();window.impacts=[];const before=window.play('bomb','from','to');window.renderer.silence();const visible=document.querySelectorAll('[data-testid="interaction-animation"]').length;const after=window.play('poop','from','to');await window.wait(1150);return{visible,ids:window.impacts.map(hit=>hit.id),before,after};})()`);
    assert.equal(silence.visible, 1); assert.deepEqual(silence.ids, [silence.after]);
    const senderSilence = await page.eval(`(async()=>{window.renderer.clear();window.impacts=[];const outgoing=window.play('poop','from','to');const incoming=window.play('poop','to','from');window.renderer.silenceSender('from');const fresh=window.play('poop','from','to');await window.wait(800);return{ids:window.impacts.map(hit=>hit.id),outgoing,incoming,fresh};})()`);
    assert.deepEqual(senderSilence.ids, [senderSilence.incoming,senderSilence.fresh], 'Voice mute suppressed a recipient impact or revived an old outgoing impact');
    const suspended = await page.eval(`(async()=>{window.renderer.clear();window.impacts=[];window.play('bomb','from','to');const until=performance.now()+1700;while(performance.now()<until){}await window.wait(100);return{impacts:window.impacts.length,canvases:document.querySelectorAll('[data-testid="interaction-animation"]').length};})()`);
    assert.deepEqual(suspended, { impacts: 0, canvases: 0 }, 'Suspended renderer replayed an expired impact');
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const reduced = await page.eval(`(async()=>{window.renderer.clear();window.play('bomb','from','to');await window.wait(100);const first=window.pixels();await window.wait(180);const second=window.pixels();const target=document.getElementById('to').getBoundingClientRect();return{first,second,target:{x:target.x+target.width/2,y:target.y+target.height/2},scale:Math.min(devicePixelRatio,1.5)};})()`);
    assert(reduced.first.count > 300); assert.deepEqual(reduced.first, reduced.second, 'Reduced-motion mesh moved or rotated');
    assert(Math.abs((reduced.first.left + reduced.first.right)/2/reduced.scale - reduced.target.x) < 15);
    await page.screenshot(path.join(output, 'interaction-renderer-reduced.png'));
    const destruction = await page.eval(`(async()=>{window.renderer.clear();window.impacts=[];window.play('bomb','from','to');window.renderer.destroy();window.play('poop','from','to');await window.wait(1150);cancelAnimationFrame(window.paintRequest);document.getElementById('video').srcObject.getTracks().forEach(track=>track.stop());return{impacts:window.impacts.length,canvases:document.querySelectorAll('[data-testid="interaction-animation"]').length};})()`);
    assert.deepEqual(destruction, { impacts: 0, canvases: 0 });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    const customPlayback = await page.eval(`(async()=>{
      const {createInteractionRenderer}=await import('/interaction-renderer.js');
      let loads=0,releases=0,hits=0;const errors=[];
      const definition={id:'custom',name:'Custom',thumbnail:{sha256:'a'.repeat(64),bytes:1,width:100,height:100,animated:true,frames:2,durationMs:100},model:'thumbnail',trajectory:'arc',sound:'none',durationMs:500};
      const renderer=createInteractionRenderer({getAvatar:id=>document.getElementById(id),resolveCustom:(id,revision)=>revision==='current'?definition:null,onImpact:()=>hits++,reportError:error=>errors.push(error.message),loadThumbnail:async(asset,signal)=>{loads++;const blob=await(await fetch('/custom.avif',{signal})).blob();const url=URL.createObjectURL(blob);return {url,release:()=>{releases++;URL.revokeObjectURL(url);}};}});
      const event={eventId:'custom-one',channelId:'voice',fromUserId:'from',toUserId:'to',kind:'custom',customId:'custom',customRevision:'current',soundIndex:0};
      renderer.play({...event,customRevision:'stale'});const staleCanvas=document.querySelector('[data-testid="interaction-animation"]')!==null;
      renderer.play(event);await window.wait(180);const pixels=window.pixels();await window.wait(850);
      const completed={loads,releases,hits};renderer.play({...event,eventId:'custom-two'});renderer.clear();await window.wait(80);renderer.destroy();
      return {staleCanvas,pixels,completed,loads,releases,hits,errors};
    })()`);
    assert.equal(customPlayback.staleCanvas,false);assert(customPlayback.pixels.count>50,'Custom AVIF produced no canvas pixels');
    assert.deepEqual(customPlayback.completed,{loads:1,releases:1,hits:1});
    assert.equal(customPlayback.hits,1);assert.equal(customPlayback.releases,1);assert.deepEqual(customPlayback.errors,[]);
    const scenes = await page.eval(`(async()=>{
      const {createInteractionRenderer}=await import('/interaction-renderer.js');
      const {SCENE_EXAMPLES}=await import('/interaction-scene-examples.js');
      const renderer=createInteractionRenderer({getAvatar:id=>document.getElementById(id),resolveCustom:id=>SCENE_EXAMPLES.find(item=>item.id===id)??null,onImpact:()=>{}});
      const event={eventId:'scene-fist',channelId:'voice',fromUserId:'from',toUserId:'to',kind:'custom',customId:'playful-fist',customRevision:'current',soundIndex:0};
      renderer.play(event);await window.wait(200);const fist=window.pixels();
      const target=document.getElementById('to').getBoundingClientRect();
      renderer.clear();renderer.play({...event,eventId:'scene-money',customId:'dollar-wallet'});await window.wait(100);const moneyStart=window.pixels();
      await window.wait(1450);const moneyEnd=window.pixels();
      const sender=document.getElementById('from').getBoundingClientRect();
      renderer.clearMember('to');const cleaned=!document.querySelector('[data-testid="interaction-animation"]');renderer.destroy();
      return {fist,target:{x:target.x+target.width/2},sender:{x:sender.x+sender.width/2},moneyStart,moneyEnd,cleaned,scale:Math.min(devicePixelRatio,1.5)};
    })()`);
    assert(scenes.fist.count>300,'Scene fist produced no visible glyph');
    assert(Math.abs((scenes.fist.left+scenes.fist.right)/2/scenes.scale-scenes.target.x)<40,'Fist did not originate directly on target');
    assert(scenes.moneyStart.count>300 && scenes.moneyEnd.count>300,'Dollar/wallet scene produced no visible geometry');
    assert(scenes.moneyStart.right/scenes.scale>scenes.target.x-60,'Dollar did not start at target');
    assert(scenes.moneyEnd.right/scenes.scale<scenes.sender.x+100,'Dollar did not fly back into sender wallet');
    assert(scenes.cleaned,'Scene canvas survived member departure');
    assert.deepEqual(errors, [], 'Unexpected browser exceptions');
    await fs.writeFile(path.join(output, 'interaction-renderer-report.json'), JSON.stringify({ passed: true, scenes, customPlayback, bombPixels, poopPixels, playback, timing, burstMaxCanvas: burst.max, cancellation, invisible, silence, suspended, reduced, destruction, browserErrors: errors }, null, 2));
    console.log('PASS: visible bomb/poop, live video continuity, bounded burst canvas, timed impacts, cancellation, invisible avatars, silence, reduced motion and destroy');
  } finally { page.close(); }
} finally {
  await closeChrome(debugPort); if (browser && browser.exitCode === null) browser.kill();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  assert.equal(path.dirname(profile), os.tmpdir()); assert(path.basename(profile).startsWith('deepscord-interaction-renderer-'));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
