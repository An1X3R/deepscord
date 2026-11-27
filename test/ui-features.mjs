// @ts-check
/** @typedef {null|boolean|number|string|JsonValue[]|{[key:string]:JsonValue}} JsonValue */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { connectPage, waitForPort } from './cdp.mjs';
import { parseGovernance, governanceState } from '../lib/server-governance.cjs';
import {runChatMediaUi,runBrowserIdentityUi} from './chat-media-ui.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'output', 'playwright', 'feature-ui');
fs.mkdirSync(output, { recursive:true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'deepscord-ui-review-'));
const source = process.env.ELECTRON_TEST_BINARY;
assert(source, 'ELECTRON_TEST_BINARY must point to a real Electron executable.');
const sourceDirectory = path.dirname(path.resolve(source));
const runtime = path.join(root, '.qa-tools', 'ui-review-runtime');
const marker = path.join(runtime, '.ui-review-owner');
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
fs.writeFileSync(path.join(entry, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.on('browser-window-created',(_event,window)=>window.hide());app.whenReady().then(async()=>{const publisher=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,partition:'ui-review-publisher'}});await publisher.loadURL(process.env.DEEPSCORD_UI_PEER_URL);});require(${JSON.stringify(path.join(root, 'desktop', 'main.js'))});`);

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
/** @returns {string} */
function savedWorkspaceEntryId() {
  /** @type {JsonValue} */ const snapshot=JSON.parse(fs.readFileSync(path.join(data,'workspace.json'),'utf8'));
  assert(snapshot && typeof snapshot==='object' && !Array.isArray(snapshot));
  assert(Array.isArray(snapshot.entries) && snapshot.entries.length===1);
  const entry=snapshot.entries[0];
  assert(entry && typeof entry==='object' && !Array.isArray(entry) && typeof entry.id==='string');
  return entry.id;
}
/** @returns {import('../lib/server-governance.cjs').GovernanceState} */
function savedGovernance() {
  /** @type {JsonValue} */ const snapshot=JSON.parse(fs.readFileSync(path.join(data,'workspace.json'),'utf8'));
  assert(snapshot && typeof snapshot==='object' && !Array.isArray(snapshot));
  assert(Array.isArray(snapshot.entries));
  assert.equal(snapshot.entries.length,1);
  const entry=snapshot.entries[0];
  assert(entry && typeof entry==='object' && !Array.isArray(entry));
  assert.equal(typeof entry.roomId,'string');assert.equal(typeof entry.creatorKey,'string');
  assert(typeof entry.roomId==='string' && typeof entry.creatorKey==='string' && entry.governance);
  return governanceState(parseGovernance(entry.governance,{version:1,roomId:entry.roomId,creatorKey:entry.creatorKey}));
}
/** @param {(state:import('../lib/server-governance.cjs').GovernanceState)=>boolean} predicate @param {string} label @returns {Promise<void>} */
async function waitForSavedGovernance(predicate,label) {
  const deadline=Date.now()+7000;
  while(Date.now()<deadline) {
    if(predicate(savedGovernance()))return;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error('Validated native governance did not reach expected state: '+label);
}
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
  const workspace = await connectPage(debug, new URL('../desktop/workspace.html', import.meta.url).href);
  await workspace.waitFor("document.readyState==='complete' && document.getElementById('workspaceLoading')?.hidden===true", { timeout:12000,interval:100,label:'workspace initial records loaded' });
  assert.equal(await workspace.eval("document.getElementById('workspaceError').hidden"), true, await workspace.eval("document.getElementById('workspaceError').textContent"));
  await workspace.eval("document.getElementById('workspaceAddBtn').click()");
  const connection = await connectPage(debug, new URL('../desktop/connections.html', import.meta.url).href);
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
  await connection.eval("document.getElementById('serverUrl').value=" + JSON.stringify(base) + ";document.getElementById('serverConnectBtn').click()");
  connection.close();
  workspace.close();
  page = await connectPage(debug, base + '/');
  if (page.target.url.includes('ui-review-peer=1')) { page.close(); throw new Error('Desktop app CDP target unexpectedly selected the publisher'); }
  const ui = page;
  await ui.send('Runtime.enable'); await ui.send('Page.enable'); await ui.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  /** @type {string[]} */
  const errors = [];
  ui.on('Runtime.exceptionThrown', /** @param {JsonValue} event */ (event) => errors.push(JSON.stringify(event)));
  await ui.waitFor("!!document.getElementById('welcomeNameInput')", { timeout:12000,interval:100,label:'real welcome' });
  await ui.eval("document.getElementById('welcomeNameInput').value='界面验收'; document.getElementById('welcomeEnterBtn').click();");
  await ui.waitFor("window.echo?.getState().roomReady && !document.querySelector('.modal-backdrop')", { timeout:15000,interval:100,label:'real room ready' });
  await ui.waitFor("document.getElementById('connectionServerName').textContent!=='服务器' && !document.getElementById('connectionServerName').textContent.includes('普通成员')", {timeout:10000,interval:100,label:'native signed identity verified'});
  assert.equal(await ui.eval("document.getElementById('addServerBtn').disabled"),true);
  await ui.eval("document.getElementById('serverMenuBtn').click();document.getElementById('serverGovernanceMenuBtn').click()");
  await ui.waitFor("!!document.getElementById('ownerClaimToken')",{timeout:5000,interval:100,label:'unclaimed independent server exposes token form'});
  const ownerToken=fs.readFileSync(path.join(temporary,'server','owner-claim.txt'),'utf8').trim();
  assert(ownerToken.length>0);
  await ui.eval("document.getElementById('ownerClaimToken').value="+JSON.stringify(ownerToken)+";document.getElementById('claimOwnerBtn').click()");
  await ui.waitFor("document.getElementById('addServerBtn').disabled===false && !document.querySelector('.modal-backdrop')",{timeout:10000,interval:100,label:'real management token grants server owner'});
  assert.equal(await ui.eval(`document.querySelector('[data-user-id="'+CSS.escape(window.echo.getState().selfId)+'"] .member-role').textContent`),'服主');
  pass('Verified native identity claims independent server ownership with actual separate management token');
  const connectionEntryId=savedWorkspaceEntryId();
  const initialDomainCount=await ui.eval('window.echo.getState().servers.length');
  await ui.eval("document.getElementById('addServerBtn').click()");
  await ui.waitFor("!!document.getElementById('createDomainNameInput')",{timeout:3000,interval:100,label:'room plus creates domain'});
  await ui.eval("document.getElementById('createDomainNameInput').value='权限验收域';document.getElementById('createDomainSubmitBtn').click()");
  await ui.waitFor("window.echo.getState().servers.some(domain=>domain.name==='权限验收域') && !document.querySelector('.modal-backdrop')",{timeout:7000,interval:100,label:'owner-created domain appears in same server'});
  assert.equal(await ui.eval('window.echo.getState().servers.length'),initialDomainCount+1);
  assert.equal(savedWorkspaceEntryId(),connectionEntryId);
  const testDomainId=await ui.eval("window.echo.getState().servers.find(domain=>domain.name==='权限验收域').id");
  await ui.eval(`document.querySelector('[data-server-id="'+${JSON.stringify(testDomainId)}+'"]').click()`);
  assert.equal(await ui.eval('window.echo.getState().activeServerId'),testDomainId);
  await ui.screenshot(path.join(output,'server-domain-hierarchy.png'));
  pass('Room rail plus adds a domain and domain selection preserves current connection-level server');
  await ui.eval("document.getElementById('serverMenuBtn').click();document.getElementById('serverGovernanceMenuBtn').click()");
  await ui.waitFor("!!document.getElementById('governanceServerName')",{timeout:3000,interval:100,label:'server owner rename control'});
  await ui.eval("document.getElementById('governanceServerName').value='UI 集成服务器';document.getElementById('renameConnectionServerBtn').click()");
  await ui.waitFor("document.getElementById('connectionServerName').textContent==='UI 集成服务器' && !document.querySelector('.modal-backdrop')",{timeout:7000,interval:100,label:'signed server rename applied'});
  await waitForSavedGovernance(state=>state.name==='UI 集成服务器','server rename');
  await ui.eval("document.getElementById('serverMenuBtn').click();document.getElementById('serverGovernanceMenuBtn').click()");
  await ui.waitFor("!!document.getElementById('governanceGroupName')",{timeout:3000,interval:100,label:'domain permission group editor'});
  await ui.eval("document.getElementById('governanceGroupName').value='频道值守';document.getElementById('grant-manageChannels').checked=true");
  const presenceSnapshotTime=fs.statSync(path.join(data,'workspace.json')).mtimeMs;
  await ui.eval(`(()=>{const socket=new WebSocket(location.origin.replace('http','ws')+'/ws');window.reviewGovernancePeer={socket,id:''};socket.onopen=()=>socket.send(JSON.stringify({t:'hello',name:'权限编辑期间加入',color:'#87d8ce',resumable:false}));socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.t==='welcome')window.reviewGovernancePeer.id=message.selfId;};})()`);
  await ui.waitFor('window.reviewGovernancePeer.id && window.echo.getState().users.some(user=>user.id===window.reviewGovernancePeer.id)',{timeout:5000,interval:100,label:'real member joins while editing role panel'});
  const presenceDeadline=Date.now()+5000;
  while(fs.statSync(path.join(data,'workspace.json')).mtimeMs<=presenceSnapshotTime && Date.now()<presenceDeadline)await new Promise(resolve=>setTimeout(resolve,50));
  assert(fs.statSync(path.join(data,'workspace.json')).mtimeMs>presenceSnapshotTime,'Member presence must deliver a fresh native-validated serverState');
  await ui.eval('new Promise(resolve=>requestAnimationFrame(()=>resolve()))');
  assert.equal(await ui.eval("document.getElementById('governanceGroupName')?.value"),'频道值守');
  assert.equal(await ui.eval("document.getElementById('grant-manageChannels')?.checked"),true);
  await ui.eval("window.reviewGovernancePeer.socket.close();document.getElementById('saveGovernanceGroupBtn').click()");
  pass('Unrelated real member presence refresh preserves an open permission editor and unsaved fields');
  await waitForSavedGovernance(state=>state.domains.some(domain=>domain.id===testDomainId && domain.groups.some(group=>group.name==='频道值守' && group.permissions.length===1 && group.permissions[0]==='manageChannels')),'create custom permission group');
  await ui.waitFor("!document.querySelector('.modal-backdrop')",{timeout:3000,interval:100,label:'group creation editor closes'});
  const testGroup=savedGovernance().domains.find(domain=>domain.id===testDomainId)?.groups.find(group=>group.name==='频道值守');
  assert(testGroup);
  await ui.eval("document.getElementById('serverMenuBtn').click();document.getElementById('serverGovernanceMenuBtn').click()");
  await ui.waitFor("!!document.getElementById('governanceGroupSelect')",{timeout:3000,interval:100,label:'saved custom group editor'});
  await ui.eval("document.getElementById('governanceGroupSelect').value="+JSON.stringify(testGroup.id)+";document.getElementById('governanceGroupSelect').dispatchEvent(new Event('change'));document.getElementById('governanceGroupName').value='频道与消息值守';document.getElementById('grant-manageMessages').checked=true");
  await ui.waitFor("document.querySelector('#modalRoot .modal-backdrop')?.classList.contains('open') && document.getElementById('modalRoot').getAnimations({subtree:true}).every(animation=>animation.playState!=='running')",{timeout:3000,interval:50,label:'role editor transition settled'});
  await ui.screenshot(path.join(output,'domain-role-management.png'));
  await ui.eval("document.getElementById('governanceGroupName').focus();document.getElementById('governanceGroupName').scrollIntoView({block:'center'})");
  await ui.screenshot(path.join(output,'domain-permission-group.png'));
  await ui.eval("document.getElementById('saveGovernanceGroupBtn').click()");
  await waitForSavedGovernance(state=>state.domains.some(domain=>domain.id===testDomainId && domain.groups.some(group=>group.id===testGroup.id && group.name==='频道与消息值守' && group.permissions.includes('manageChannels') && group.permissions.includes('manageMessages'))),'update custom permission group');
  await ui.waitFor("!document.querySelector('.modal-backdrop')",{timeout:3000,interval:100,label:'group update editor closes'});
  await ui.eval("document.getElementById('serverMenuBtn').click();document.getElementById('serverGovernanceMenuBtn').click()");
  await ui.waitFor("!!document.getElementById('governanceGroupSelect')",{timeout:3000,interval:100,label:'delete custom group editor'});
  await ui.eval("document.getElementById('governanceGroupSelect').value="+JSON.stringify(testGroup.id)+";document.getElementById('governanceGroupSelect').dispatchEvent(new Event('change'));document.getElementById('deleteGovernanceGroupBtn').click()");
  await waitForSavedGovernance(state=>!state.domains.find(domain=>domain.id===testDomainId)?.groups.some(group=>group.id===testGroup.id),'delete custom permission group');
  await ui.waitFor("!document.querySelector('.modal-backdrop')",{timeout:3000,interval:100,label:'group deletion editor closes'});
  pass('Real signed server rename and domain custom permission group create/update/delete persist in validated native journal');
  await ui.eval("document.getElementById('serverMenuBtn').click();document.getElementById('deleteDomainMenuBtn').click()");
  await ui.waitFor("!!document.getElementById('deleteDomainConfirmBtn')",{timeout:3000,interval:100,label:'domain deletion confirmation'});
  await ui.eval("document.getElementById('deleteDomainConfirmBtn').click()");
  await ui.waitFor("!window.echo.getState().servers.some(domain=>domain.id==="+JSON.stringify(testDomainId)+") && !document.querySelector('.modal-backdrop')",{timeout:7000,interval:100,label:'signed domain deletion removes actual domain'});
  await waitForSavedGovernance(state=>!state.domains.some(domain=>domain.id===testDomainId),'deleted domain policy removed');
  assert.equal(await ui.eval('window.echo.getState().servers.length'),initialDomainCount);
  assert.equal(await ui.eval('window.echo.getState().activeServerId===window.echo.getState().servers[0].id'),true);
  assert.equal(savedWorkspaceEntryId(),connectionEntryId);
  pass('Signed domain deletion removes live domain and its policy while selecting a remaining domain in the same server');
  const mediaChannel=await ui.eval('window.echo.getState().activeChannelId');assert(typeof mediaChannel==='string');
  await runChatMediaUi({ui,temporary,output,pass,savedGovernance,openPersonalPicker:()=>connectPage(debug,pathToFileURL(path.join(root,'desktop','sticker-picker.html')).href)});
  const browserReader=await connectPage(debug,base+'/?ui-review-peer=1');await runBrowserIdentityUi(browserReader,pass);browserReader.close();
  const channel = await ui.eval("window.echo.getState().servers.flatMap(server=>server.channels).find(channel=>channel.type==='voice').id");
  await ui.eval(`void window.echo.actions.joinVoice(${JSON.stringify(channel)})`);
  const microphoneConsent=await connectPage(debug,pathToFileURL(path.join(root,'desktop','desktop-consent.html')).href);await microphoneConsent.waitFor("!document.getElementById('consentAccept').disabled",{timeout:10000,interval:50,label:'trusted microphone consent ready'});await microphoneConsent.eval("document.getElementById('consentAccept').click()");microphoneConsent.close();
  await ui.waitFor('!!window.echo.getState().voiceChannelId', { timeout:15000,interval:100,label:'physical microphone joined' });
  await ui.eval('window.echo.actions.selectChannel(' + JSON.stringify(channel) + ')');
  pass('Real desktop client, server and physical microphone joined');
  publisher = await connectPage(debug, base + '/?ui-review-peer=1');
  assert.equal(await publisher.eval('typeof window.deepscord'), 'undefined');
  await publisher.eval(`(async()=>{
    const {PeerLink}=await import('/js/peer-link.js');
    const {ScreenRelay}=await import('/js/screen-relay.js');
    const {DEFAULT_SCREEN_PREFERENCES}=await import('/js/screen-preferences.js');
    const canvas=document.createElement('canvas'); canvas.width=1280;canvas.height=720;
    const context=canvas.getContext('2d'); if(!context)throw new Error('Canvas unavailable');
    let frame=0; const draw=()=>{frame++;context.fillStyle='#152c30';context.fillRect(0,0,1280,720);context.fillStyle='#91dbbd';context.fillRect(72,72,1136,4);context.fillStyle='#eef0e9';context.font='46px sans-serif';context.fillText('Deepscord · Real peer video',72,170);context.font='24px sans-serif';context.fillText('Canvas capture → WebRTC → member card',72,225);context.fillStyle='#87d8ce';context.fillRect(72+(frame%900),340,120,160);};draw();
    const timer=setInterval(draw,50);const stream=canvas.captureStream(20);const track=stream.getVideoTracks()[0];
    const socket=new WebSocket(location.origin.replace('http','ws')+'/ws');const links=new Map();let identity='';let config;let relay=null;
    const fail=error=>{window.reviewPeer.error=error.message;};
    const connect=(id)=>{if(links.has(id))return links.get(id);const link=new PeerLink({selfId:identity,peerId:id,config,track:null,stream:null,sendSignal:data=>socket.send(JSON.stringify({t:'signal',to:id,data})),onTrack:()=>{},onState:()=>{},onControl:message=>{if(message.type==='leave'){relay.peerRemoved(id);link.close();links.delete(id);return;}if(message.type==='screen')relay.receive(id,message.data).catch(fail);},onReady:()=>{link.sendControl({type:'media',screen:true,accompaniment:false});link.sendControl({type:'state',muted:true,deafened:false});relay.peerReady(id);},onError:fail});links.set(id,link);return link;};
    socket.onopen=()=>socket.send(JSON.stringify({t:'hello',name:'媒体验收端',color:'#87d8ce',resumable:false}));
    socket.onmessage=event=>{const msg=JSON.parse(event.data);if(msg.t==='welcome'){identity=msg.selfId;config=msg.config;window.reviewPeer.id=identity;relay=new ScreenRelay({selfId:identity,getNetwork:()=>config,getPreferences:()=>({...DEFAULT_SCREEN_PREFERENCES,relayEnabled:false}),peerIds:()=>[...links.keys()],send:(id,data)=>links.get(id)?.sendControl({type:'screen',data})===true,onStream:()=>{},onError:fail});relay.join(${JSON.stringify(channel)});relay.publish(stream).then(()=>socket.send(JSON.stringify({t:'joinVoice',channelId:${JSON.stringify(channel)},muted:true,deafened:false}))).catch(fail);}else if(msg.t==='voicePeers'){for(const peer of msg.peers)connect(peer.id);}else if(msg.t==='voiceState'&&msg.userId!==identity){if(msg.channelId===null){const old=links.get(msg.userId);if(old){relay.peerRemoved(msg.userId);old.close();links.delete(msg.userId);}}else{connect(msg.userId);}}else if(msg.t==='signal'){connect(msg.from).receive(msg.data).catch(fail);}};
    window.reviewPeer={id:'',error:'',canvas,stream,links,stop:()=>{clearInterval(timer);relay?.leave();track.stop();for(const link of links.values())link.close();socket.close();}};
  })()`);
  await publisher.waitFor('!!window.reviewPeer.id', { timeout:10000,interval:100,label:'publisher authenticated' });
  assert.equal(await publisher.eval('window.reviewPeer.error'), '');
  await ui.waitFor("!!document.querySelector('[data-testid=screen-watch]')", { timeout:20000,interval:100,label:'real canvas screen peer advertisement' });
  pass('Actual WS member and production ScreenRelay advertises generated Canvas capture');
  const peerId = await publisher.eval('window.reviewPeer.id');
  await ui.eval(`document.querySelector('[data-testid="peer-volume"][data-user-id="${peerId}"]').value='165'; document.querySelector('[data-testid="peer-volume"][data-user-id="${peerId}"]').dispatchEvent(new Event('input',{bubbles:true}));`);
  assert.equal(await ui.eval(`window.echo.getVoiceStats().peers['${peerId}'].volume`), 165);
  pass('Per-member gain slider applies 165% to actual peer');
  await ui.eval("document.querySelector('[data-testid=screen-watch]').click()");
  await ui.waitFor("document.querySelector('[data-testid=screen-video]')?.videoWidth>0", { timeout:20000,interval:100,label:'actual remote video decoded' });
  await ui.eval("window.reviewVideo=document.querySelector('[data-testid=screen-video]')");
  pass('WATCH receives actual decoded remote video');
  for (const width of [980,1366,1920]) {
    await ui.send('Emulation.setDeviceMetricsOverride', { width,height:900,deviceScaleFactor:1,mobile:false });
    await ui.eval('new Promise(resolve=>setTimeout(resolve,250))');
    const layout = await ui.eval("({width:innerWidth,scroll:document.documentElement.scrollWidth,rail:document.querySelector('.rail').getBoundingClientRect().width,side:document.querySelector('.sidebar').getBoundingClientRect().right,main:document.querySelector('.main').getBoundingClientRect().width})");
    assert.equal(layout.scroll, width, JSON.stringify(layout));
    await ui.screenshot(path.join(output, `inline-${width}.png`));
    await ui.eval("document.querySelector('[data-testid=screen-expand]').click()");
    const expanded = await ui.eval("(()=>{const media=document.querySelector('.media-expanded').getBoundingClientRect();const side=document.querySelector('.sidebar').getBoundingClientRect();return{left:media.left,right:media.right,top:media.top,bottom:media.bottom,sidebar:side.right,width:innerWidth,height:innerHeight,same:window.reviewVideo===document.querySelector('[data-testid=screen-video]')};})()");
    assert(expanded.same);assert.equal(expanded.left, expanded.sidebar);assert(Math.abs(expanded.right - width) < 1, JSON.stringify(expanded));assert.equal(expanded.top, 0);assert.equal(expanded.bottom, 900);
    await ui.screenshot(path.join(output, `expanded-${width}.png`));
    await ui.send('Input.dispatchKeyEvent', { type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27 });
    await ui.send('Input.dispatchKeyEvent', { type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27 });
    assert.equal(await ui.eval("!!document.querySelector('.media-expanded')"), false);
    pass(`Inline / expanded layout and Escape at ${width}px`);
  }
  await ui.eval("window.echo.actions.toggleMute()");
  await ui.waitFor("window.reviewVideo===document.querySelector('[data-testid=screen-video]') && document.querySelector('[data-testid=screen-video]').videoWidth>0", { timeout:5000,interval:100,label:'video persists rerender' });
  pass('Video DOM and decoded stream survive real mute rerender');
  await ui.eval("document.querySelector('[data-self-action=mute]').focus()");
  await ui.waitFor("getComputedStyle(document.querySelector('[data-testid=quick-mic-volume]').parentElement).visibility==='visible'", {timeout:3000,interval:100,label:'keyboard quick volume opens'});
  const popup = await ui.eval("(()=>{const panel=document.querySelector('[data-testid=quick-mic-volume]').parentElement;const r=panel.getBoundingClientRect();return{visible:getComputedStyle(panel).visibility,active:document.activeElement?.outerHTML,within:panel.parentElement.matches(':focus-within'),focus:document.hasFocus(),left:r.left,right:r.right,top:r.top};})()");
  assert.equal(popup.visible, 'visible'); assert(popup.left>=0 && popup.top>=0 && popup.right<=1920);
  await ui.eval("document.querySelector('[data-testid=quick-mic-volume]').value='120';document.querySelector('[data-testid=quick-mic-volume]').dispatchEvent(new Event('input',{bubbles:true}));");
  await ui.waitFor('window.echo.getState().settings.micVolume===120', { timeout:5000,interval:100,label:'mic quick gain' });
  await ui.screenshot(path.join(output, 'quick-volume.png'));
  pass('Keyboard-reachable quick microphone volume applies 120%');
  await ui.eval("window.reviewSlider=document.querySelector('[data-testid=quick-mic-volume]');document.querySelector('[data-self-action=mute]').click()");
  assert.equal(await ui.eval("document.querySelector('[data-self-action=mute]').getAttribute('aria-pressed')"),'false');
  assert.equal(await ui.eval("window.reviewSlider===document.querySelector('[data-testid=quick-mic-volume]')"),true);
  pass('Focused quick slider survives mute toggle and aria-pressed refreshes');
  await ui.eval("document.getElementById('railSettingsBtn').click()");
  await ui.waitFor("!!document.getElementById('profileAvatarFile')", { timeout:5000,interval:100,label:'profile settings' });
  const image = await ui.eval("(()=>{const canvas=document.createElement('canvas');canvas.width=96;canvas.height=96;const ctx=canvas.getContext('2d');ctx.fillStyle='#87d8ce';ctx.fillRect(0,0,96,96);ctx.fillStyle='#152c30';ctx.fillRect(22,18,16,60);ctx.fillRect(38,18,32,12);ctx.fillRect(38,66,32,12);return canvas.toDataURL('image/png').split(',')[1]})()");
  const avatar = path.join(temporary, 'avatar.png'); fs.writeFileSync(avatar, Buffer.from(image, 'base64'));
  const doc = await ui.send('DOM.getDocument');
  const input = await ui.send('DOM.querySelector', { nodeId:doc.root.nodeId,selector:'#profileAvatarFile' });
  await ui.send('DOM.setFileInputFiles', { nodeId:input.nodeId,files:[avatar] });
  await ui.waitFor("!!document.getElementById('avatarCropSave')", {timeout:5000,interval:100,label:'avatar crop confirmation'});
  await ui.eval("document.getElementById('avatarCropSave').click()");
  await ui.waitFor("window.echo.getState().settings.avatar?.startsWith('data:image/')", { timeout:10000,interval:100,label:'uploaded avatar persisted' });
  const avatarDeadline=Date.now()+7000;
  let avatarPersisted=false;
  while(!avatarPersisted && Date.now()<avatarDeadline) {
    /** @type {JsonValue} */ const persisted=JSON.parse(fs.readFileSync(path.join(data,'profile.json'),'utf8'));
    assert(persisted && typeof persisted==='object' && !Array.isArray(persisted));
    avatarPersisted=typeof persisted.avatar==='string' && persisted.avatar.startsWith('data:image/');
    if(!avatarPersisted)await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert(avatarPersisted,'Native profile avatar must persist after renderer update');
  pass('Real image file upload compressed and persisted through desktop profile IPC');
  await ui.eval("document.querySelector('[data-testid=overlay-adjust]').click()");
  await ui.waitFor("document.querySelector('[data-testid=desktop-settings-status]').textContent.includes('完成调整')", { timeout:5000,interval:100,label:'native overlay adjustment opened from actual settings' });
  assert.equal(await ui.eval("document.querySelector('[data-testid=overlay-width]') === null && document.querySelector('[data-testid=overlay-height]') === null"),true);
  const overlayPage = await connectPage(debug, new URL('../desktop/voice-overlay.html', import.meta.url).href);
  await overlayPage.waitFor("document.body.classList.contains('unlocked') && !document.getElementById('resize-grip').hidden", {timeout:5000,interval:100,label:'interactive native adjustment grip'});
  await overlayPage.eval('window.voiceOverlay.resize({width:320,height:260})');
  await overlayPage.eval("document.querySelector('[data-testid=overlay-adjust-done]').click()");
  await overlayPage.waitFor("document.body.classList.contains('locked') && document.getElementById('resize-grip').hidden", {timeout:5000,interval:100,label:'completion restores transparent locked overlay'});
  assert.equal(await overlayPage.eval('getComputedStyle(document.getElementById("overlay")).backgroundColor'), 'rgba(0, 0, 0, 0)');
  overlayPage.close();
  const desktop = JSON.parse(fs.readFileSync(path.join(data, 'desktop-settings.json'), 'utf8')); assert.equal(desktop.overlay.enabled,true); assert.equal(desktop.overlay.locked,true); assert(Math.abs(desktop.overlay.width-320)<=1);
  await ui.eval("document.querySelector('[data-testid=desktop-feature-settings]').scrollIntoView({block:'center'})");
  await ui.screenshot(path.join(output, 'desktop-settings.png'));
  /** @type {JsonValue} */
  const targets = await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json();
  assert(Array.isArray(targets));
  assert(targets.some((target) => target !== null && typeof target === 'object' && !Array.isArray(target) && typeof target.url === 'string' && target.url.endsWith('/voice-overlay.html')));
  pass('Desktop settings save uses actual IPC and creates live overlay');
  await ui.eval("document.getElementById('softwareSettingsDone').click()");
  await ui.waitFor("!document.querySelector('.modal-backdrop')", { timeout:3000,interval:100,label:'settings closed' });
  await ui.eval("document.querySelector('[data-testid=music-start]').click()");
  await ui.waitFor("!!document.querySelector('[data-testid=music-source-global]')", {timeout:10000,interval:100,label:'actual native audio process enumeration plus global source'});
  assert.equal(await ui.eval('window.echo.getVoiceStats().accompaniment'),false);
  await ui.screenshot(path.join(output,'music-source-chooser.png'));
  await ui.eval("document.querySelector('[data-testid=media-source-cancel]').click()");
  pass('Global accompaniment source offered beside real processes; cancelling leaves capture inactive');
  await ui.eval("document.querySelector('[data-testid=screen-unwatch]').click()");
  assert.equal(await ui.eval("document.querySelector('[data-testid=member-screen]').hidden"), true);
  await ui.eval("document.querySelector('[data-testid=screen-start]').click()");
  await ui.waitFor("document.querySelectorAll('[data-testid=screen-source]').length>0",{timeout:10000,interval:100,label:'native screen source thumbnails'});
  await ui.screenshot(path.join(output,'screen-source-chooser.png'));
  await ui.eval("window.reviewChoice=document.querySelector('[data-testid=screen-source]');window.reviewChoice.click();document.querySelector('[data-testid=media-source-cancel]').click()");
  await ui.waitFor("!window.reviewChoice.disabled",{timeout:15000,interval:100,label:'cancelled native capture completes'});
  assert.equal(await ui.eval("window.echo.getVoiceStats().screenSharing"),false);
  pass('Cancel pending native source selection prevents screen sharing');
  await ui.eval("document.querySelector('[data-testid=screen-start]').click()");
  await ui.waitFor("!!document.querySelector('[data-testid=screen-source]')",{timeout:10000,interval:100,label:'native chooser reopened'});
  await ui.eval("document.querySelector('[data-testid=screen-source]').click()");
  await ui.waitFor("window.echo.getVoiceStats().screenSharing",{timeout:15000,interval:100,label:'native screen capture started'});
  await ui.eval("document.querySelector('[data-testid=screen-stop]').click()");
  await ui.waitFor("!window.echo.getVoiceStats().screenSharing",{timeout:5000,interval:100,label:'native screen capture stopped'});
  pass('Native capture starts and stops independently after cancelled chooser');
  await ui.eval('window.echo.actions.leaveVoice()');
  await ui.waitFor('!window.echo.getState().voiceChannelId', { timeout:5000,interval:100,label:'left voice' });
  await ui.eval(`window.echo.actions.joinVoice(${JSON.stringify(channel)})`);
  await ui.waitFor("!!document.querySelector('[data-testid=screen-watch]')", { timeout:15000,interval:100,label:'screen advertises after rejoin' });
  await ui.eval("document.querySelector('[data-testid=screen-watch]').click()");
  await ui.waitFor("document.querySelector('[data-testid=screen-video]')?.videoWidth>0", { timeout:20000,interval:100,label:'screen decodes after rejoin' });
  await ui.eval("document.querySelector('[data-testid=screen-expand]').click()");
  await ui.send('Input.dispatchKeyEvent', { type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27 });
  await ui.send('Input.dispatchKeyEvent', { type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27 });
  assert.equal(await ui.eval("!!document.querySelector('.media-expanded')"), false);
  pass('Leave/rejoin reuses media controller and Escape still collapses');
  await ui.eval(`document.querySelector('#serverRail [aria-label="切换或添加服务器"]').click()`);
  const roomWorkspace=await connectPage(debug,new URL('../desktop/workspace.html',import.meta.url).href);
  await roomWorkspace.waitFor("document.getElementById('workspaceLoading')?.hidden===true && document.getElementById('savedRoomTitle').textContent==='UI 集成服务器'",{timeout:7000,interval:100,label:'brand opens workspace showing renamed server'});
  assert.equal(await roomWorkspace.eval('window.deepscord.getWorkspace().then(snapshot=>snapshot.activeEntryId)'),connectionEntryId);
  await roomWorkspace.screenshot(path.join(output,'workspace-server-hierarchy.png'));
  await roomWorkspace.eval("document.getElementById('workspaceAddBtn').click()");
  const roomConnection = await connectPage(debug, new URL('../desktop/connections.html', import.meta.url).href);
  await roomConnection.waitFor("document.getElementById('connectionChoice')?.hidden===false", { timeout:5000,interval:100,label:'workspace plus opens chooser from room brand' });
  assert.equal(await roomConnection.eval("document.getElementById('connectionBody').hidden"), true);
  for (const width of [720,380]) {
    await roomConnection.send('Emulation.setDeviceMetricsOverride', { width,height:700,deviceScaleFactor:1,mobile:false });
    assert.equal(await roomConnection.eval('document.documentElement.scrollWidth'), width);
    await roomConnection.screenshot(path.join(output, `connection-choice-${width}.png`));
  }
  await roomConnection.send('Page.close');
  roomConnection.close();
  roomWorkspace.close();
  pass('Room brand opens renamed server workspace; workspace plus retains two-stage chooser at narrow widths');
  const publisherError = await publisher.eval('window.reviewPeer.error');
  assert.equal(publisherError, '');
  await ui.eval('window.echo.actions.selectChannel('+JSON.stringify(mediaChannel)+');document.getElementById("messages").scrollTop=document.getElementById("messages").scrollHeight');
  await ui.waitFor('window.echo.getState().chatMedia.ownedUrls>0',{timeout:10000,interval:50,label:'visible actual attachments hold media leases before disconnect'});
  const mediaBeforeDisconnect=await ui.eval('window.echo.getState().chatMedia');server.kill();
  await ui.waitFor("window.echo.getState().connStatus!=='open' && window.echo.getState().chatMedia.ownedUrls===0 && window.echo.getState().chatMedia.requests===0 && window.echo.getState().chatMedia.downloads===0 && window.echo.getState().chatMedia.queuedDownloads===0 && window.echo.getState().chatMedia.queuedImages===0 && window.echo.getState().chatMedia.queuedImageBytes===0 && window.echo.getState().chatMedia.activeImageBytes===0 && window.echo.getState().chatMedia.codec.active===0 && window.echo.getState().chatMedia.codec.queued===0",{timeout:10000,interval:50,label:'actual disconnect reclaims media work and URLs'});
  const mediaAfterDisconnect=await ui.eval('window.echo.getState().chatMedia');fs.writeFileSync(path.join(output,'chat-media-disconnect.json'),JSON.stringify({before:mediaBeforeDisconnect,after:mediaAfterDisconnect},null,2));
  pass('An actual server disconnect cancels requests/downloads/codec work and releases every owned media URL');
  assert.deepEqual(errors, [], errors.join('\n'));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ checks, errors, publisherError, popup, serverLog, clientLog }, null, 2));
  console.log('SCREENSHOTS ' + output);
} catch (error) {
  if (publisher) console.error(await publisher.eval('JSON.stringify({peerError:window.reviewPeer?.error})'));
  if (page) { await page.screenshot(path.join(output, 'failure.png')); console.error(await page.eval('JSON.stringify({voice:window.echo?.getVoiceStats()})')); }
  throw error;
} finally {
  if (publisher) { await publisher.eval('window.reviewPeer?.stop()'); publisher.close(); }
  if (page) { await page.send('Runtime.evaluate',{expression:'window.deepscord.quit()'}).catch((error)=>console.warn('Quit response closed', {message:error.message}));page.close(); }
  if (client && client.exitCode === null) client.kill();
  server.kill();
}
