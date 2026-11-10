// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {page as debuggerPage,targets,pause} from './security-cdp.mjs';
import {launch,stop,reservePort} from './server-ws-helpers.mjs';

/** @typedef {ReturnType<typeof debuggerPage> extends Promise<infer T> ? T : never} Page */
/** @typedef {import('./security-cdp.mjs').JsonValue} JsonValue */
const root=fileURLToPath(new URL('../',import.meta.url));
const mode=process.argv.includes('--steam')?'steam':'direct';
const source=fs.realpathSync(process.env.ELECTRON_TEST_BINARY||path.join(root,'.qa-tools/screen-diagnostics-runtime/Deepscord.exe'));
const main=fs.realpathSync(process.env.DESKTOP_TEST_MAIN||path.join(root,'desktop/main.js'));
const directory=fs.mkdtempSync(path.join(root,'.qa-tools/session-switch-'));
const data=path.join(directory,'profile'),runtime=path.join(directory,'runtime');fs.mkdirSync(data);
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({autoConnect:false,trustedHosts:['127.0.0.1']}));
fs.writeFileSync(path.join(data,'desktop-settings.json'),JSON.stringify({muteShortcut:'Control+Alt+Shift+F23',overlay:{enabled:false,locked:true,x:24,y:80,width:280,height:300,scale:1}}));
const original=path.dirname(source);
/** @param {string} from @param {string} to @returns {void} */
function stage(from,to){fs.mkdirSync(to,{recursive:true});for(const entry of fs.readdirSync(from,{withFileTypes:true})){const file=path.join(from,entry.name),relative=path.relative(original,file);if(relative==='resources'+path.sep+'app'||relative==='resources'+path.sep+'app.asar')continue;assert(!entry.isSymbolicLink());const target=path.join(to,entry.name);if(entry.isDirectory())stage(file,target);else fs.linkSync(file,target);}}
stage(original,runtime);
const app=path.join(runtime,'resources/app');fs.mkdirSync(app,{recursive:true});
fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({name:'deepscord-session-switch-test',version:'1.0.0',main:'main.cjs'}));
fs.writeFileSync(path.join(app,'main.cjs'),`const {app,Menu}=require('electron');
app.on('browser-window-created',(_event,window)=>window.on('show',()=>window.hide()));
process.on('message',message=>{
  if(message==='session-test-quit')app.quit();
  if(message==='session-test-reconnect'){
    const menu=Menu.getApplicationMenu();
    if(!menu?.items[0]?.submenu?.items[1])throw new Error('Production File reconnect menu is missing');
    menu.items[0].submenu.items[1].click();
  }
});
require(${JSON.stringify(main)});
`);
const debug=await reservePort();
/** @type {import('node:child_process').ChildProcess|null} */let desktop=null;
/** @type {Awaited<ReturnType<typeof launch>>|null} */let backend=null;
/** @type {Page[]} */const pages=[];
/** @type {string[]} */const checks=[];
/** @type {string[]} */const attemptErrors=[];
/** @type {WebSocket|null} */let observer=null;
/** @type {string[]} */const wireEvents=[];
/** @type {{message:string,stack:string}|null} */let failure=null;
/** @type {JsonValue} */let steamIdentity=null;
/** @param {string} name @returns {string} */
const filePage=name=>pathToFileURL(path.join(path.dirname(main),name)).href;
/** @param {string} label @returns {void} */function pass(label){checks.push(label);console.log(JSON.stringify({event:'session-switch-pass',label}));}
/** @returns {Promise<void>} */async function waitDebug(){const deadline=Date.now()+15000;while(Date.now()<deadline){try{const response=await fetch('http://127.0.0.1:'+debug+'/json/version',{signal:AbortSignal.timeout(500)});if(response.ok)return;}catch(error){if(!(error instanceof TypeError)&&!(error instanceof DOMException))throw error;}await pause(100);}throw new Error('Owned desktop debugger did not start');}
/** @param {string} prefix @returns {Promise<Page>} */async function page(prefix){const ui=await debuggerPage(debug,prefix);pages.push(ui);return ui;}
/** @param {Page} ui @param {string} expression @param {number} timeout @returns {Promise<void>} */async function wait(ui,expression,timeout){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await ui.evaluate(expression))return;await pause(100);}throw new Error('Desktop condition timed out: '+expression);}
/** @param {Page} ui @returns {Promise<void>} */async function steamCreated(ui){await wait(ui,'document.getElementById("createdResult")?.hidden===false || document.getElementById("connectionError")?.hidden===false',30000);assert.equal(await ui.evaluate('document.getElementById("connectionError").hidden'),true,String(await ui.evaluate('document.getElementById("connectionError").textContent')));assert.equal(await ui.evaluate('/^deepscord:\\/\\/steam\\?appid=480&lobby=/.test(document.getElementById("createdInvite").value)'),true);}
/** @param {Page} ui @returns {Promise<void>} */async function ready(ui){await ui.wait('!!window.echo && (!!document.getElementById("welcomeEnterBtn") || window.echo.getState().roomReady)');if(await ui.evaluate('!!document.getElementById("welcomeEnterBtn")'))await ui.evaluate('document.getElementById("welcomeNameInput").value="Session switch acceptance";document.getElementById("welcomeEnterBtn").click()');await ui.wait('window.echo.getState().roomReady && !!window.echo.getState().selfKey');}
/** @param {string} excludedUrl @returns {Promise<Page>} */async function room(excludedUrl){const deadline=Date.now()+20000;while(Date.now()<deadline){const target=(await targets(debug)).find(row=>row.type==='page'&&row.url.startsWith('http://127.0.0.1:')&&row.url!==excludedUrl);if(target){const ui=await page(target.url);await ready(ui);return ui;}await pause(100);}throw new Error('Production local room page did not appear');}
/** @param {Page} ui @returns {Promise<Page>} */async function workspace(ui){await ui.evaluate('window.deepscord.openConnectionPanel("workspace")');const panel=await page(filePage('workspace.html'));await panel.wait('document.getElementById("workspaceLoading")?.hidden === true');return panel;}
/** @param {Page} panel @param {string} entry @returns {Promise<void>} */async function select(panel,entry){await panel.evaluate('document.querySelector('+JSON.stringify('[data-entry-id="'+entry+'"]')+').click()');}
/** @param {'cancel'|'accept'} choice @returns {Promise<void>} */async function decide(choice){const ui=await page(filePage('desktop-consent.html'));await ui.wait('document.getElementById("consentAccept")?.disabled === false');assert.equal(await ui.evaluate('document.getElementById("consentTitle").textContent'),'切换服务器');assert.equal(await ui.evaluate('document.getElementById("consentAccept").textContent'),'确认切换');await ui.evaluate('document.getElementById("consent'+(choice==='accept'?'Accept':'Deny')+'").click()');}
/** @param {Page} ui @param {JsonValue} initial @param {number} previous @returns {Promise<void>} */async function preserved(ui,initial,previous){assert.deepEqual(await ui.evaluate('({selfId:window.echo.getState().selfId,voiceChannelId:window.echo.getState().voiceChannelId,micReady:window.echo.getVoiceStats().micReady,roomReady:window.echo.getState().roomReady})'),initial);assert.equal(wireEvents.length,previous,'Existing room WebSocket must stay open without a replacement socket');if(mode==='steam')assert.deepEqual(await ui.evaluate('window.deepscord.getSteamSession().then(session=>({lobbyId:session.lobbyId,role:session.role,origin:session.origin}))'),steamIdentity);}

try{
  if(mode==='direct')backend=await launch(path.join(directory,'server'),{});
  const log=fs.openSync(path.join(directory,'desktop.log'),'a');
  /** @type {NodeJS.ProcessEnv} */const environment={...process.env,DEEPSCORD_USER_DATA:data};delete environment.ELECTRON_RUN_AS_NODE;
  desktop=spawn(path.join(runtime,path.basename(source)),['--remote-debugging-port='+debug,'--remote-debugging-address=127.0.0.1','--autoplay-policy=no-user-gesture-required'],{cwd:root,env:environment,windowsHide:true,stdio:['ignore',log,log,'ipc']});fs.closeSync(log);
  await waitDebug();
  const initial=await page(filePage('workspace.html'));await initial.wait('document.getElementById("workspaceLoading")?.hidden === true');
  if(mode==='steam'){
    await initial.evaluate('document.getElementById("workspaceAddBtn").click()');
    const firstCreate=await page(filePage('connections.html'));await firstCreate.wait('document.getElementById("connectionChoice")?.hidden===false');
    await firstCreate.evaluate('document.getElementById("chooseCreateBtn").click();document.getElementById("steamMethodBtn").click();document.getElementById("steamCreateBtn").click()');
    await steamCreated(firstCreate);
    await firstCreate.evaluate('document.getElementById("enterCreatedRoomBtn").click()');
  }else{assert(backend);await initial.evaluate('document.getElementById("workspaceAddBtn").click()');const firstJoin=await page(filePage('connections.html'));await firstJoin.wait('document.getElementById("connectionChoice")?.hidden===false');await firstJoin.evaluate('document.getElementById("chooseJoinBtn").click();document.getElementById("serverMethodBtn").click();document.getElementById("serverUrl").value='+JSON.stringify(backend.origin)+';document.getElementById("serverConnectBtn").click()');}
  const serverUi=await room('');
  const serverFrontend=await serverUi.evaluate('location.href');assert.equal(typeof serverFrontend,'string');
  await serverUi.evaluate('window.deepscord.openConnectionPanel("create")');
  const create=await page(filePage('connections.html'));await create.wait('document.getElementById("connectionBody")?.hidden === false');
  if(mode==='steam')await create.evaluate('document.getElementById("steamMethodBtn").click();document.getElementById("steamCreateBtn").click()');
  else{const hostPort=await reservePort();await create.evaluate('document.getElementById("directMethodBtn").click();document.getElementById("directAddress").value="127.0.0.1";document.getElementById("directPort").value='+JSON.stringify(String(hostPort))+';document.getElementById("directCreateBtn").click()');}
  await decide('accept');
  if(mode==='steam')await steamCreated(create);else await create.wait('!document.getElementById("createdResult").hidden');
  await create.evaluate('document.getElementById("enterCreatedRoomBtn").click()');
  const ui=await room(String(serverFrontend));
  await ui.wait('window.echo.getState().networkMode === '+JSON.stringify(mode==='steam'?'server':'direct'));
  if(mode==='steam'){steamIdentity=await ui.evaluate('window.deepscord.getSteamSession().then(session=>({lobbyId:session.lobbyId,role:session.role,origin:session.origin}))');assert(steamIdentity&&typeof steamIdentity==='object'&&!Array.isArray(steamIdentity)&&typeof steamIdentity.lobbyId==='string'&&steamIdentity.role==='host');pass('Two actual invisible Steam lobbies created through production UI; second room is the active host');}
  const channel=await ui.evaluate('window.echo.getState().servers.flatMap(server=>server.channels).find(channel=>channel.type==="voice").id');assert.equal(typeof channel,'string');
  await ui.evaluate('void window.echo.actions.joinVoice('+JSON.stringify(channel)+')');
  if(mode==='direct'){const consent=await page(filePage('desktop-consent.html'));await consent.wait('document.getElementById("consentAccept")?.disabled === false');await consent.evaluate('document.getElementById("consentAccept").click()');}
  await ui.wait('!!window.echo.getState().voiceChannelId && window.echo.getVoiceStats().micReady');
  const initialState=await ui.evaluate('({selfId:window.echo.getState().selfId,voiceChannelId:window.echo.getState().voiceChannelId,micReady:window.echo.getVoiceStats().micReady,roomReady:window.echo.getState().roomReady})');
  const target=(await targets(debug)).find(row=>row.type==='page'&&row.url.startsWith('http://127.0.0.1:'));assert(target);
  observer=new WebSocket(target.webSocketDebuggerUrl);await once(observer,'open');
  observer.addEventListener('message',event=>{/** @type {{method?:string}} */const value=JSON.parse(String(event.data));if(value.method==='Network.webSocketClosed'||value.method==='Network.webSocketCreated')wireEvents.push(value.method);});
  observer.send(JSON.stringify({id:1,method:'Network.enable',params:{}}));
  await pause(100);
  const panel=await workspace(ui);
  await panel.evaluate('globalThis.__switchErrors=[];new MutationObserver(()=>{const error=document.getElementById("workspaceError");if(error.textContent&&!error.hidden)globalThis.__switchErrors.push(error.textContent)}).observe(document.getElementById("workspaceError"),{childList:true})');
  const snapshot=await panel.evaluate('window.deepscord.getWorkspace()');assert(snapshot&&typeof snapshot==='object'&&!Array.isArray(snapshot)&&Array.isArray(snapshot.entries));
  const serverEntry=snapshot.entries.find(value=>value&&typeof value==='object'&&!Array.isArray(value)&&value.mode===(mode==='steam'?'steam':'server')&&value.id!==snapshot.activeEntryId);assert(serverEntry&&typeof serverEntry==='object'&&!Array.isArray(serverEntry)&&typeof serverEntry.id==='string');
  assert.equal(typeof snapshot.activeEntryId,'string');const activeEntry=String(snapshot.activeEntryId);
  if(backend){await stop(backend);backend=null;}
  await select(panel,serverEntry.id);await decide('cancel');
  await panel.wait('document.body.getAttribute("aria-busy")==="false"');
  await preserved(ui,initialState,0);assert.equal(await panel.evaluate('document.getElementById("workspaceError").hidden'),true);
  pass('Cancel keeps the real '+mode+' host, renderer, signed room session and microphone voice intact');
  for(let attempt=0;attempt<2;attempt++){
    await select(panel,serverEntry.id);await decide('accept');
    await wait(panel,'!document.getElementById("workspaceError").hidden && document.body.getAttribute("aria-busy")==="false"',30000);
    const error=await panel.evaluate('document.getElementById("workspaceError").textContent');assert.equal(typeof error,'string');assert(String(error).length>0);attemptErrors.push(String(error));
    await preserved(ui,initialState,0);
    await pause(2200);await preserved(ui,initialState,0);assert.equal(await panel.evaluate('document.querySelectorAll("#workspaceError:not([hidden])").length'),1);assert.equal(await panel.evaluate('globalThis.__switchErrors.length'),attempt+1,'Each attempt must emit exactly one displayed error');
    assert.equal((await targets(debug)).filter(row=>row.type==='page'&&row.url===target.url).length,1);

  }

  pass('Two unavailable-server attempts each show one recoverable error without replacing the room WebSocket or voice');
  await select(panel,activeEntry);await pause(400);await preserved(ui,initialState,0);
  pass('Selecting the still-active saved room returns to its existing live session');
  observer.close();observer=null;
  assert(desktop.connected);desktop.send('session-test-reconnect');
  await pause(400);await ui.wait('window.echo?.getState().roomReady && !!window.echo.getState().selfKey');
  assert.equal(await ui.evaluate('window.echo.getState().networkMode'),mode==='steam'?'server':'direct');
  if(mode==='steam')assert.deepEqual(await ui.evaluate('window.deepscord.getSteamSession().then(session=>({lobbyId:session.lobbyId,role:session.role,origin:session.origin}))'),steamIdentity);
  assert.equal(await ui.evaluate('window.echo.getState().voiceChannelId'),null);
  pass('Actual File reconnect reloads the same hosted room and returns to a signed ready session');
}catch(error){failure={message:error instanceof Error?error.message:String(error),stack:error instanceof Error?error.stack||'':''};throw error;}
finally{
  observer?.close();for(const ui of pages)ui.close();if(backend)await stop(backend);
  if(desktop?.pid&&desktop.exitCode===null){const child=desktop;assert(child.connected);const exited=once(child,'exit');child.send('session-test-quit');/** @type {ReturnType<typeof setTimeout>|null} */let timer=null;try{await Promise.race([exited,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Owned desktop did not exit cleanly')),10000);})]);}catch(error){const killed=spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{encoding:'utf8',windowsHide:true});if(killed.error)throw killed.error;throw error;}finally{if(timer)clearTimeout(timer);}}
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({mode,checks,attemptErrors,steamIdentity,failure,directory,main},null,2));console.log(JSON.stringify({event:'session-switch-result',mode,directory,checks:checks.length,failure}));
}
