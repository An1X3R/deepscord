// @ts-check
/** @typedef {null|boolean|number|string|JsonValue[]|{[key:string]:JsonValue}} JsonValue */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { connectPage, waitForPort } from './cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.DEEPSCORD_MEDIA_UI_OUTPUT || path.join(root, 'output', 'playwright', 'desktop-media-ui-smoke'));
fs.mkdirSync(output, { recursive:true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'deepscord-ui-review-'));
const source = process.env.ELECTRON_TEST_BINARY;
assert(source, 'ELECTRON_TEST_BINARY must point to a real Electron executable.');
const sourceDirectory = path.dirname(path.resolve(source));
const desktopMain=fs.realpathSync(process.env.DESKTOP_TEST_MAIN || path.join(root,'desktop/main.js'));
assert(path.isAbsolute(desktopMain));
const runtime = path.join(root, '.qa-tools', 'desktop-media-ui-runtime-'+createHash('sha256').update(sourceDirectory).digest('hex').slice(0,12));
const marker = path.join(runtime, '.desktop-media-ui-owner');
if (fs.existsSync(runtime)) assert.equal(fs.readFileSync(marker, 'utf8'), sourceDirectory);
else {
  const appDirectory = path.join(sourceDirectory, 'resources', 'app');
  assert(!runtime.startsWith(sourceDirectory + path.sep));
  fs.cpSync(sourceDirectory, runtime, { recursive:true, filter:(entry) => entry !== appDirectory && !entry.startsWith(appDirectory + path.sep) && entry !== path.join(sourceDirectory, 'resources', 'app.asar') });
  fs.writeFileSync(marker, sourceDirectory);
}
const entry = path.join(runtime, 'resources', 'app');
fs.mkdirSync(entry, { recursive:true });
fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name:'deepscord-ui-review',version:'1.0.0',main:'main.cjs' }));
fs.writeFileSync(path.join(entry, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.on('browser-window-created',(_event,window)=>window.hide());app.whenReady().then(async()=>{const publisher=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,partition:'ui-review-publisher'}});await publisher.loadURL(process.env.DEEPSCORD_UI_PEER_URL);});require(${JSON.stringify(desktopMain)});`);

/** @returns {Promise<number>} */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(undefined)); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined)));
  return port;
}
const port = await freePort();
const debug = await freePort();
const base = 'http://127.0.0.1:' + port;
const serverEnvironment = { ...process.env, PORT:String(port),HTTPS_PORTS:'0',HTTP_HOST:'127.0.0.1',ECHO_DATA_DIR:path.join(temporary, 'server'),ECHO_MEDIA_POLICY:'direct',ECHO_NETWORK_MODE:'server',ECHO_PASSWORD:'' };
const server = spawn(process.execPath, [path.join(root, 'server.js')], { cwd:root,env:serverEnvironment,windowsHide:true,stdio:['ignore','pipe','pipe'] });
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += String(chunk); });
server.stderr.on('data', (chunk) => { serverLog += String(chunk); });
const data = path.join(temporary, 'client'); fs.mkdirSync(data);
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ serverUrl:base,autoConnect:true,trustedHosts:[] }));
fs.writeFileSync(path.join(data, 'desktop-settings.json'), JSON.stringify({ muteShortcut:'Control+Alt+Shift+F9',overlay:{ enabled:false,locked:true,x:24,y:80,width:280,height:300,scale:1 } }));
/** @type {import('node:child_process').ChildProcess|null} */
let client = null;
/** @type {Awaited<ReturnType<typeof connectPage>>|null} */
let page = null;
/** @type {Awaited<ReturnType<typeof connectPage>>|null} */
let publisher = null;
/** @type {string[]} */
const checks = [];
/** @param {string} label */
function pass(label) { checks.push(label); console.log('PASS ' + label); }
try {
  const deadline = Date.now() + 12000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    try { ready = (await fetch(base + '/api/health')).ok; }
    catch (error) { if (!(error instanceof TypeError)) throw error; }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(ready, serverLog);
  /** @type {NodeJS.ProcessEnv} */
  const environment = { ...process.env,DEEPSCORD_USER_DATA:data,DEEPSCORD_UI_PEER_URL:base + '/?ui-review-peer=1' }; delete environment.ELECTRON_RUN_AS_NODE;
  client = spawn(path.join(runtime, path.basename(source)), [`--remote-debugging-port=${debug}`, '--autoplay-policy=no-user-gesture-required'], { env:environment,cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'] });
  let clientLog = ''; client.stderr?.on('data', (chunk) => { clientLog += String(chunk); });
  await waitForPort(debug, 20000);
  const workspace = await connectPage(debug, pathToFileURL(path.join(path.dirname(desktopMain),'workspace.html')).href);
  await workspace.waitFor("document.readyState==='complete' && document.getElementById('workspaceLoading')?.hidden===true", { timeout:12000,interval:100,label:'workspace initial records loaded' });
  assert.equal(await workspace.eval("document.getElementById('workspaceError').hidden"), true, await workspace.eval("document.getElementById('workspaceError').textContent"));
  await workspace.eval("document.getElementById('workspaceAddBtn').click()");
  const connection = await connectPage(debug, pathToFileURL(path.join(path.dirname(desktopMain),'connections.html')).href);
  await connection.send('Emulation.setFocusEmulationEnabled', { enabled:true });
  await connection.waitFor("document.getElementById('connectionChoice')?.hidden===false", { timeout:5000,interval:100,label:'add opens intent chooser' });
  assert.equal(await connection.eval("document.getElementById('connectionBody').hidden"), true);
  assert.equal(await connection.eval("document.getElementById('serverUrl').value"), '');
  assert.equal(await workspace.eval('window.deepscord.getWorkspace().then(snapshot=>snapshot.entries.length)'), 0);
  await connection.screenshot(path.join(output, 'connection-choice.png'));
  pass('Workspace plus opens only create/join choices without adding a saved server');
  await connection.eval("document.getElementById('chooseCreateBtn').click()");
  assert.equal(await connection.eval("document.getElementById('connectionChoice').hidden && !document.getElementById('connectionBody').hidden && document.activeElement?.id==='connectionTitle'"), true);
  for (const method of ['steam', 'direct', 'server']) {
    await connection.eval(`document.getElementById('${method}MethodBtn').click()`);
    assert.deepEqual(await connection.eval("[...document.querySelectorAll('.method-form')].filter(section=>!section.hidden).map(section=>section.id)"), [method === 'server' ? 'serverSection' : method + 'CreateSection']);
  }
  assert.equal(await connection.eval("document.getElementById('serverDeployment').open"), true);
  await connection.screenshot(path.join(output, 'connection-create.png'));
  await connection.eval("document.getElementById('connectionBackBtn').click()");
  assert.equal(await connection.eval("document.activeElement?.id"), 'chooseCreateBtn');
  await connection.eval("document.getElementById('chooseJoinBtn').focus()");
  await connection.send('Input.dispatchKeyEvent', { type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r' });
  await connection.send('Input.dispatchKeyEvent', { type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13 });
  assert.equal(await connection.eval("document.getElementById('connectionChoice').hidden"), true);
  for (const method of ['steam', 'direct', 'server']) {
    await connection.eval(`document.getElementById('${method}MethodBtn').click()`);
    assert.deepEqual(await connection.eval("[...document.querySelectorAll('.method-form')].filter(section=>!section.hidden).map(section=>section.id)"), [method === 'server' ? 'serverSection' : method + 'JoinSection']);
  }
  assert.equal(await connection.eval("document.getElementById('serverDeployment').open"), false);
  await connection.eval("document.getElementById('directMethodBtn').click();document.getElementById('directJoinInvite').value='invalid-invite';document.getElementById('directJoinBtn').click()");
  await connection.waitFor("document.getElementById('connectionError').hidden===false", { timeout:5000,interval:100,label:'invalid invite rejected' });
  await connection.eval("document.getElementById('connectionBackBtn').click()");
  assert.equal(await connection.eval("document.getElementById('connectionError').hidden && document.getElementById('createdResult').hidden && document.activeElement?.id==='chooseJoinBtn'"), true);
  assert.equal(await workspace.eval('window.deepscord.getWorkspace().then(snapshot=>snapshot.entries.length)'), 0);
  pass('Create/join have separate three-method forms, return restores focus and clears stale errors');
  await connection.eval("document.getElementById('chooseJoinBtn').click();document.getElementById('serverMethodBtn').click()");
  await connection.screenshot(path.join(output, 'connection-join.png'));
  await connection.eval("document.getElementById('serverUrl').value=" + JSON.stringify(base) + ";setTimeout(()=>document.getElementById('serverConnectBtn').click(),0)");
  connection.close();
  workspace.close();
  const targetDeadline=Date.now()+15000;let lastTargets=[];
  while(!page && Date.now()<targetDeadline){
    const targets=await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json();lastTargets=targets.map(candidate=>candidate.url);
    const target=targets.find(candidate=>candidate.type==='page' && candidate.url.startsWith('http://127.0.0.1:') && !candidate.url.includes('ui-review-peer=1'));
    if(target)page=await connectPage(debug,target.url);
    else await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert(page,'Connected production application page did not appear within 15 seconds: '+JSON.stringify(lastTargets)+' '+clientLog);
  if (page.target.url.includes('ui-review-peer=1')) { page.close(); throw new Error('Desktop app CDP target unexpectedly selected the publisher'); }
  const ui = page;
  await ui.send('Runtime.enable'); await ui.send('Page.enable'); await ui.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  /** @type {string[]} */
  const errors = [];
  ui.on('Runtime.exceptionThrown', /** @param {JsonValue} event */ (event) => errors.push(JSON.stringify(event)));
  await ui.waitFor("!!document.getElementById('welcomeNameInput')", { timeout:12000,interval:100,label:'real welcome' });
  await ui.eval("document.getElementById('welcomeNameInput').value='界面验收'; document.getElementById('welcomeEnterBtn').click();");
  await ui.waitFor("window.echo?.getState().roomReady && !document.querySelector('.modal-backdrop')", { timeout:15000,interval:100,label:'real room ready' });
  await ui.eval("document.getElementById('railSettingsBtn').click()");
  await ui.waitFor("!!document.querySelector('[data-testid=overlay-adjust]')", {timeout:5000,interval:100,label:'production desktop settings'});
  await ui.waitFor("document.activeElement?.id==='profileName' && getComputedStyle(document.querySelector('.modal-backdrop')).opacity==='1'",{timeout:5000,interval:50,label:'settings autofocus and entrance settled'});
  await ui.eval("Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished))");
  await ui.eval("document.querySelector('[data-testid=desktop-feature-settings]').scrollIntoView({block:'center'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  await ui.screenshot(path.join(output,'settings.png'));
  assert.equal(await ui.eval("document.getElementById('screenPlaybackBufferSeconds')===null && document.getElementById('screenPlaybackBufferHint')===null"),true);
  await ui.eval("document.getElementById('audioSettingsDone').click()");
  await ui.waitFor("!document.querySelector('.modal-backdrop')",{timeout:5000,interval:50,label:'settings closed after checking frozen controls'});
  await ui.eval("document.getElementById('railSettingsBtn').click()");
  await ui.waitFor("!!document.querySelector('[data-testid=desktop-feature-settings]')",{timeout:5000,interval:50,label:'reopened production settings'});
  await ui.waitFor("document.activeElement?.id==='profileName' && getComputedStyle(document.querySelector('.modal-backdrop')).opacity==='1'",{timeout:5000,interval:50,label:'reopened settings entrance settled'});
  assert.equal(await ui.eval("document.getElementById('screenPlaybackBufferSeconds')===null"),true);
  await ui.eval("document.getElementById('screenTransmissionSettings').scrollIntoView({block:'center'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  await ui.screenshot(path.join(output,'screen-settings-current.png'));
  pass('Frozen playback buffer controls are absent from initial and reopened production settings');
  await ui.eval("document.querySelector('[data-testid=overlay-adjust]').click()");
  const overlay = await connectPage(debug,pathToFileURL(path.join(path.dirname(desktopMain),'voice-overlay.html')).href);
  await overlay.waitFor("document.body.classList.contains('unlocked')",{timeout:5000,interval:100,label:'native edit mode'});
  await overlay.screenshot(path.join(output,'overlay-edit.png'));
  await overlay.eval('window.voiceOverlay.resize({width:320,height:260})');
  await overlay.eval("document.querySelector('[data-testid=overlay-adjust-done]').click()");
  overlay.close();
  const stored = JSON.parse(fs.readFileSync(path.join(data,'desktop-settings.json'),'utf8'));
  assert.equal(stored.overlay.locked,true); assert(Math.abs(stored.overlay.width-320)<=1);
  await ui.eval("document.getElementById('audioSettingsDone').click()");
  const channel = await ui.eval("window.echo.getState().servers.flatMap(server=>server.channels).find(channel=>channel.type==='voice').id");
  await ui.eval('void window.echo.actions.joinVoice('+JSON.stringify(channel)+')');
  const microphoneConsent = await connectPage(debug,pathToFileURL(path.join(path.dirname(desktopMain),'desktop-consent.html')).href);
  await microphoneConsent.waitFor("!document.getElementById('consentAccept').disabled",{timeout:10000,interval:100,label:'real session microphone permission'});
  await microphoneConsent.eval("document.getElementById('consentAccept').click()"); microphoneConsent.close();
  await ui.waitFor('!!window.echo.getState().voiceChannelId',{timeout:15000,interval:100,label:'real local voice join'});
  await ui.eval('window.echo.actions.selectChannel('+JSON.stringify(channel)+')');
  const normal = await connectPage(debug,pathToFileURL(path.join(path.dirname(desktopMain),'voice-overlay.html')).href);
  await normal.waitFor("document.body.classList.contains('locked') && document.querySelectorAll('#members li').length>0",{timeout:5000,interval:100,label:'native normal overlay'});
  assert.equal(await normal.eval('getComputedStyle(document.getElementById("overlay")).backgroundColor'),'rgba(0, 0, 0, 0)');
  await normal.screenshot(path.join(output,'overlay-normal.png')); normal.close();
  await ui.eval("document.querySelector('[data-testid=music-start]').click()");
  await ui.waitFor("!!document.querySelector('[data-testid=music-source-global]')",{timeout:10000,interval:100,label:'real native process list plus global source'});
  await ui.screenshot(path.join(output,'music-chooser.png'));
  assert.equal(await ui.eval('window.echo.getVoiceStats().accompaniment'),false);
  await ui.eval("document.querySelector('[data-testid=media-source-cancel]').click()");
  pass('Production settings adjustment, persisted geometry, transparent normal native overlay and real global audio source chooser; no accompaniment capture started');
  publisher = await connectPage(debug, base + '/?ui-review-peer=1');
  await publisher.waitFor("!!document.getElementById('welcomeNameInput')",{timeout:10000,interval:100,label:'publisher welcome'});
  await publisher.eval("document.getElementById('welcomeNameInput').value='Canvas publisher';document.getElementById('welcomeEnterBtn').click()");
  await publisher.waitFor("!!window.echo && window.echo.getState().roomReady",{timeout:15000,interval:100,label:'production publisher room ready'});
  await publisher.eval('void window.echo.actions.joinVoice('+JSON.stringify(channel)+')');
  await publisher.waitFor("window.echo.getVoiceStats()?.micReady===true",{timeout:15000,interval:100,label:'production publisher microphone ready'});
  const publisherId = await publisher.eval('window.echo.getState().selfId');
  const prototype = await publisher.send('Runtime.evaluate',{expression:"import('/js/voice.js').then(module=>module.VoiceEngine.prototype)",awaitPromise:true});
  const instances = await publisher.send('Runtime.queryObjects',{prototypeObjectId:prototype.result.objectId});
  const publication = await publisher.send('Runtime.callFunctionOn',{objectId:instances.objects.objectId,functionDeclaration:`async function() {
    const engine=this.find(candidate=>candidate.inVoice);
    if(!engine)throw new Error('Live production voice engine missing');
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
    const context=canvas.getContext('2d');if(!context)throw new Error('Canvas capture context missing');
    let frame=0;
    const draw=()=>{frame+=1;context.fillStyle=frame%2?'#30b0d0':'#d0b030';context.fillRect(0,0,640,360);};
    draw();const timer=setInterval(draw,66);const stream=canvas.captureStream(15);
    stream.getVideoTracks()[0].addEventListener('ended',()=>clearInterval(timer),{once:true});
    await engine.startScreenShare(stream);return true;
  }`,awaitPromise:true,returnByValue:true});
  assert(!publication.exceptionDetails,JSON.stringify(publication));
  await ui.waitFor("!!document.querySelector('#stageGrid [data-user-id="+JSON.stringify(publisherId)+"] [data-testid=screen-watch]')",{timeout:15000,interval:100,label:'remote actual canvas screen advertised'});
  await ui.eval("document.querySelector('#stageGrid [data-user-id="+JSON.stringify(publisherId)+"] [data-testid=screen-watch]').click()");
  await ui.waitFor("document.querySelector('[data-testid=screen-video]')?.readyState>=2",{timeout:15000,interval:100,label:'actual VP8 screen received'});
  const routesBefore=await publisher.eval('window.echo.getVoiceStats().screenTransport.plans');
  const lifecycle = await ui.eval(`(async()=>{
    const card=document.querySelector('#stageGrid [data-user-id='+${JSON.stringify(JSON.stringify(publisherId))}+']');
    const video=card.querySelector('[data-testid=screen-video]');const stream=video.srcObject;
    const sample=document.createElement('canvas');sample.width=1;sample.height=1;const context=sample.getContext('2d');
    const colors=new Set();let frames=0,blackFrames=0,removedVideos=0,emptied=0,maxGapMs=0,lastFrameAt=performance.now(),running=true;
    video.addEventListener('emptied',()=>emptied+=1);
    const observer=new MutationObserver(records=>{for(const record of records)for(const node of record.removedNodes)if(node===video || node.contains?.(video))removedVideos+=1;});
    observer.observe(document.getElementById('stageGrid'),{childList:true,subtree:true});
    const presented=()=>{const now=performance.now();maxGapMs=Math.max(maxGapMs,now-lastFrameAt);lastFrameAt=now;frames+=1;context.drawImage(video,0,0,1,1);const pixel=context.getImageData(0,0,1,1).data;if(pixel[0]+pixel[1]+pixel[2]<30)blackFrames+=1;colors.add(pixel[0]+','+pixel[1]+','+pixel[2]);if(running)video.requestVideoFrameCallback(presented);};
    video.requestVideoFrameCallback(presented);
    for(let index=0;index<120;index+=1){window.echo.actions.selectChannel(window.echo.getState().activeChannelId);await new Promise(resolve=>setTimeout(resolve,50));}
    running=false;observer.disconnect();
    return {frames,blackFrames,removedVideos,emptied,maxGapMs,colors:colors.size,sameCard:document.querySelector('#stageGrid [data-user-id='+${JSON.stringify(JSON.stringify(publisherId))}+']')===card,sameVideo:card.querySelector('[data-testid=screen-video]')===video,sameStream:video.srcObject===stream};
  })()`);
  fs.writeFileSync(path.join(output,'screen-lifecycle.json'),JSON.stringify(lifecycle,null,2));
  assert(lifecycle.sameCard && lifecycle.sameVideo && lifecycle.sameStream,JSON.stringify(lifecycle));
  assert(lifecycle.frames>=10 && lifecycle.colors>=2,JSON.stringify(lifecycle));
  assert.equal(lifecycle.removedVideos,0);assert.equal(lifecycle.emptied,0);assert.equal(lifecycle.blackFrames,0);
  const routesAfter=await publisher.eval('window.echo.getVoiceStats().screenTransport.plans');
  assert.deepEqual(routesAfter,routesBefore,'Periodic capacity planning must retain unchanged live routes');
  pass('Real production VP8 screen keeps card, video and stream attached through 120 stage renders and periodic planning with advancing nonblack frames');
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({checks,errors,serverLog,clientLog},null,2));
  console.log('SCREENSHOTS '+output);
} finally {
  if(publisher) publisher.close();
  if(page) page.close();
  if(client && client.exitCode===null) client.kill();
  server.kill();
}
