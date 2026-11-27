// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {initialSettings} from '../desktop/desktop-schema.cjs';
import {parseChatUnread,CHAT_UNREAD_KEY} from '../public/js/chat-unread.js';
import {page,pause} from './security-cdp.mjs';
import {launch,stop,reservePort,identity,connect,authenticate,send,receive,object} from './server-ws-helpers.mjs';
/** @typedef {Awaited<ReturnType<typeof page>>} Page */
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../public/js/chat-unread.js').UnreadDocument} UnreadDocument */
const root=fileURLToPath(new URL('..',import.meta.url));

test('production desktop unread bridge and app adapter survive a forced loopback origin change',{timeout:90000},async()=>{
  const source=fs.realpathSync(process.env.ELECTRON_TEST_BINARY||path.join(root,'.qa-tools/screen-diagnostics-runtime/Deepscord.exe'));
  const directory=fs.mkdtempSync(path.join(root,'.qa-tools/chat-unread-native-')),data=path.join(directory,'profile'),runtime=path.join(directory,'runtime');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({autoConnect:false,trustedHosts:['127.0.0.1']}));
  fs.writeFileSync(path.join(data,'desktop-settings.json'),JSON.stringify({...initialSettings(),muteShortcut:'Control+Alt+Shift+F17',deafenShortcut:'Control+Alt+Shift+F18'}));
  const original=path.dirname(source);
  /** @param {string} from @param {string} to @returns {void} */
  function stage(from,to){fs.mkdirSync(to,{recursive:true});for(const entry of fs.readdirSync(from,{withFileTypes:true})){const file=path.join(from,entry.name),relative=path.relative(original,file);if(relative==='resources'+path.sep+'app'||relative==='resources'+path.sep+'app.asar')continue;assert(!entry.isSymbolicLink());const target=path.join(to,entry.name);if(entry.isDirectory())stage(file,target);else fs.linkSync(file,target);}}
  stage(original,runtime);
  const app=path.join(runtime,'resources/app');fs.mkdirSync(app,{recursive:true});
  fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({name:'deepscord-unread-native-test',version:'1.0.0',main:'main.cjs'}));
  fs.writeFileSync(path.join(app,'main.cjs'),`const {app}=require('electron');app.on('browser-window-created',(_event,window)=>window.on('show',()=>window.hide()));process.on('message',message=>{if(message==='unread-test-quit')app.quit();});require(${JSON.stringify(path.join(root,'desktop/main.js'))});`);
  const backend=await launch(path.join(directory,'server'),{});
  /** @type {import('node:child_process').ChildProcess|null} */let desktop=null;
  /** @type {Page[]} */let pages=[];
  /** @type {net.Server|null} */let occupied=null;
  let log='';
  /** @returns {Promise<void>} */
  async function close(){
    for(const ui of pages)ui.close();pages=[];
    if(desktop&&desktop.exitCode===null&&desktop.signalCode===null){const child=desktop,exited=once(child,'exit');assert(child.connected);child.send('unread-test-quit');const timer=setTimeout(()=>child.kill(),10000);try{await exited;}finally{clearTimeout(timer);}}
    desktop=null;
  }
  /** @returns {Promise<Page>} */
  async function start(){
    const debug=await reservePort();
    /** @type {NodeJS.ProcessEnv} */const env={...process.env,DEEPSCORD_USER_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(path.join(runtime,path.basename(source)),['--remote-debugging-port='+debug,'--remote-debugging-address=127.0.0.1'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});desktop=child;
    child.stdout?.on('data',chunk=>{log+=String(chunk);});child.stderr?.on('data',chunk=>{log+=String(chunk);});
    const deadline=Date.now()+15000;
    while(Date.now()<deadline&&!log.includes('127.0.0.1:'+debug+'/')){if(child.exitCode!==null)throw new Error('Owned desktop exited: '+log.slice(-5000));await pause(50);}
    if(!JSON.parse(fs.readFileSync(path.join(data,'config.json'),'utf8')).lastWorkspaceEntryId){
      const workspace=await page(debug,pathToFileURL(path.join(root,'desktop/workspace.html')).href);pages.push(workspace);
      await workspace.wait('typeof window.deepscord?.connect === "function"');
      await workspace.evaluate('setTimeout(()=>void window.deepscord.connect('+JSON.stringify(backend.origin)+'),50)');
    }
    const ui=await page(debug,'http://127.0.0.1:');pages.push(ui);
    await ui.wait('!!window.echo && (!!document.getElementById("welcomeEnterBtn") || window.echo.getState().roomReady)');
    if(await ui.evaluate('!!document.getElementById("welcomeEnterBtn")'))await ui.evaluate('document.getElementById("welcomeNameInput").value="Native unread reviewer";document.getElementById("welcomeEnterBtn").click()');
    await ui.wait('window.echo.getState().roomReady && !!window.echo.getState().selfKey');
    return ui;
  }
  try{
    const actor=identity(),sender=await connect(backend,'Unread sender');await authenticate(sender,actor);
    let ui=await start();
    const firstOrigin=await ui.evaluate('location.origin');assert.equal(typeof firstOrigin,'string');
    const roomId=sender.challenge.roomId;
    /** @type {UnreadDocument} */const expected={version:1,entries:[{roomId:String(roomId),channelId:'ch-chat',read:null,latest:{id:'native-pending',ts:Date.now()},floor:null,muted:true,pending:[{id:'native-pending',ts:Date.now(),mention:true}]}]};
    expected.entries[0].pending[0].ts=expected.entries[0].latest?.ts||0;
    await ui.evaluate('window.deepscord.saveChatUnread('+JSON.stringify(expected)+')');
    assert.deepEqual(parseChatUnread(await ui.evaluate('window.deepscord.getChatUnread()')),expected);
    assert.deepEqual(parseChatUnread(JSON.parse(fs.readFileSync(path.join(data,'chat-unread.json'),'utf8'))),expected);
    await close();
    occupied=net.createServer(socket=>socket.destroy());occupied.listen(Number(new URL(String(firstOrigin)).port),'127.0.0.1');await once(occupied,'listening');
    ui=await start();
    const secondOrigin=await ui.evaluate('location.origin');assert.notEqual(secondOrigin,firstOrigin);
    await ui.wait('document.querySelector("[data-channel-id=ch-chat] .chat-mention-count")?.textContent === "@1"');
    const restored=parseChatUnread(await ui.evaluate('window.deepscord.getChatUnread()'));
    const restoredEntry=restored.entries.find(entry=>entry.roomId===roomId&&entry.channelId==='ch-chat');assert(restoredEntry);
    assert.equal(restoredEntry.muted,true);assert.deepEqual(restoredEntry.pending,expected.entries[0].pending);assert.equal(restoredEntry.read,null);
    assert.equal(await ui.evaluate('localStorage.getItem('+JSON.stringify(CHAT_UNREAD_KEY)+')'),null);
    const memberKey=await ui.evaluate('window.echo.getState().selfKey');assert.equal(typeof memberKey,'string');
    const cursor=send(sender,{t:'chat',channelId:'ch-chat',text:'Live persisted mention <@'+memberKey+'>',requestId:'native-live-unread'});
    const accepted=await receive(sender,cursor,frame=>frame.t==='chatResult'&&frame.requestId==='native-live-unread','live native unread send');assert.equal(accepted.ok,true);
    const messageId=object(object(accepted.result).message).id;assert.equal(typeof messageId,'string');
    await ui.wait('(async()=>{const document=await window.deepscord.getChatUnread();return document.entries.some(entry=>entry.roomId==='+JSON.stringify(roomId)+'&&entry.channelId==="ch-chat"&&entry.muted&&entry.pending.some(item=>item.id==='+JSON.stringify(messageId)+'&&item.mention));})()');
    await ui.wait('document.querySelector("[data-channel-id=ch-chat] .chat-mention-count")?.textContent === "@2"');
    /** @returns {number} */
    function ownedDesktopPid(){if(!desktop?.pid)throw new Error('The isolated desktop process is missing');return desktop.pid;}
    const desktopPid=ownedDesktopPid();
    /** @returns {number[]} */
    function helperPids(){
      const script=`$ErrorActionPreference='Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${desktopPid}' | Where-Object Name -eq 'global-ptt.exe' | ForEach-Object { $_.ProcessId })`;
      /** @type {JsonValue} */const value=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:10000,windowsHide:true}));
      if(!Array.isArray(value)||value.some(pid=>typeof pid!=='number'||!Number.isSafeInteger(pid)||pid<1))throw new TypeError('Owned native helper process query returned invalid PIDs');
      return /** @type {number[]} */(value);
    }
    assert.deepEqual(helperPids(),[]);
    await ui.evaluate('window.deepscord.updateGlobalPTT({connected:true,mode:"ptt",key:"F24"})');
    const helpers=helperPids();assert.equal(helpers.length,1,'Trusted native PTT update must start exactly one owned helper');
    const crashed=ui.send('Page.crash',{}).catch(error=>{if(!(error instanceof Error))throw error;return {message:error.message};});
    await pause(300);
    assert.deepEqual(helperPids(),[],'Renderer crash must terminate its native PTT helper');
    ui.close();await crashed;
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({firstOrigin,secondOrigin,restarted:true,restoredMention:true,muted:true,liveMentionSaved:true,localStorageUnused:true,ownedHelperPid:helpers[0],rendererCrashStoppedHelper:true},null,2));
    console.log(JSON.stringify({event:'chat_unread_native_verified',directory,firstOrigin,secondOrigin}));
  }finally{await close();if(occupied)await new Promise((resolve,reject)=>occupied?.close(error=>error?reject(error):resolve(undefined)));await stop(backend);fs.writeFileSync(path.join(directory,'desktop.log'),log);}
});
