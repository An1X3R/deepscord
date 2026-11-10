// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {launch,stop,object,string} from './server-ws-helpers.mjs';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('electron').BrowserWindow} Window */
const root=fileURLToPath(new URL('../',import.meta.url));
/** @param {number} milliseconds @returns {Promise<void>} */
function pause(milliseconds){return new Promise(resolve=>setTimeout(resolve,milliseconds));}
/** @param {Window} window @param {string} expression @returns {Promise<JsonValue>} */
async function evaluate(window,expression){return window.webContents.executeJavaScript(expression,true);}
/** @param {Window} window @param {string} expression @param {string} label @returns {Promise<void>} */
async function until(window,expression,label){const end=Date.now()+15000;while(Date.now()<end){if(await evaluate(window,expression))return;await pause(50);}throw new Error('Channel/member UI timed out: '+label);}
/** @param {Window} window @param {string} id @returns {Promise<void>} */
async function click(window,id){await evaluate(window,'(()=>{const node=document.getElementById('+JSON.stringify(id)+');if(!(node instanceof HTMLElement))throw new Error("Missing stable UI ID");node.click();return true})()');}
/** @param {Window} window @param {string} userId @returns {Promise<void>} */
async function memberMenu(window,userId){const selector='#membersScroll [data-user-id='+JSON.stringify(userId)+']';await evaluate(window,'(()=>{const node=document.querySelector('+JSON.stringify(selector)+');if(!(node instanceof HTMLElement))throw new Error("Missing member ID");node.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:1000,clientY:200}));return true})()');}

/** @param {Window} window @param {string} prototype @param {string} operation @returns {Promise<JsonValue>} */
async function inspectInstances(window,prototype,operation){
  const debuggerClient=window.webContents.debugger;if(!debuggerClient.isAttached())debuggerClient.attach('1.3');
  const evaluated=object(await debuggerClient.sendCommand('Runtime.evaluate',{expression:prototype,awaitPromise:true}));
  const prototypeObjectId=string(object(evaluated.result).objectId);
  const queried=object(await debuggerClient.sendCommand('Runtime.queryObjects',{prototypeObjectId}));
  const objectId=string(object(queried.objects).objectId);
  const result=object(await debuggerClient.sendCommand('Runtime.callFunctionOn',{objectId,functionDeclaration:operation,returnByValue:true,awaitPromise:true}));
  if(result.exceptionDetails)throw new Error('Live runtime inspection failed: '+JSON.stringify(result.exceptionDetails));
  const value=object(result.result).value;assert(value!==undefined);return value;
}

/** @param {string} directory @returns {Promise<void>} */
async function run(directory){
  const {app,BrowserWindow,session}=await import('electron');
  const backend=await launch(path.join(directory,'server'),{});
  /** @type {Window[]} */const windows=[];
  /** @type {string[]} */const errors=[];
  /** @type {string[]} */const checks=[];
  /** @param {string} name @returns {Promise<Window>} */
  async function open(name){
    const ses=session.fromPartition('persist:channel-member-'+name);
    ses.setPermissionRequestHandler((contents,permission,callback,details)=>callback(contents.getURL().startsWith(backend.origin+'/') && permission==='media' && 'mediaTypes' in details && details.mediaTypes?.length===1 && details.mediaTypes[0]==='audio'));
    ses.setPermissionCheckHandler((contents,permission,origin,details)=>Boolean(contents?.getURL().startsWith(backend.origin+'/') && origin===backend.origin && permission==='media' && details.mediaType==='audio'));
    const window=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{session:ses,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});windows.push(window);
    window.webContents.on('console-message',details=>{if(details.level==='error')errors.push(name+': '+details.message);});
    await window.loadURL(backend.origin+'/?name='+encodeURIComponent(name));
    await until(window,'window.echo?.getState().roomReady && !!window.echo.getState().selfKey','verified browser identity');
    return window;
  }
  /** @param {string} label @returns {void} */
  function pass(label){checks.push(label);console.log(JSON.stringify({event:'channel-member-ui-pass',label}));}
  try{
    await app.whenReady();
    const owner=await open('Owner'),member=await open('<img src=x>');
    const ownerKey=await evaluate(owner,'window.echo.getState().selfKey'),memberKey=await evaluate(member,'window.echo.getState().selfKey'),memberId=await evaluate(member,'window.echo.getState().selfId');assert.equal(typeof memberId,'string');
    await click(owner,'serverName');await click(owner,'serverGovernanceMenuBtn');
    const token=fs.readFileSync(path.join(directory,'server/owner-claim.txt'),'utf8').trim();
    await evaluate(owner,'document.getElementById("ownerClaimToken").value='+JSON.stringify(token));await click(owner,'claimOwnerBtn');
    await until(owner,'window.echo.getState().ownerKey === '+JSON.stringify(ownerKey),'owner claimed through governance UI');
    pass('Owner claimed through actual governance UI with verified browser identity');
    await evaluate(owner,'document.querySelector("[data-channel-id=ch-lobby]").click()');
    assert.equal(await evaluate(owner,'document.getElementById("chat").hidden && getComputedStyle(document.getElementById("chat")).display === "none" && document.getElementById("voiceStage").hidden === false'),true);
    await evaluate(owner,'document.querySelector("#stageActions [data-action=join]").click()');
    await until(owner,'window.echo.getState().voiceChannelId === "ch-lobby" && window.echo.getVoiceStats().micReady','physical microphone joined');
    await evaluate(member,'document.querySelector("[data-channel-id=ch-lobby]").click();document.querySelector("#stageActions [data-action=join]").click()');
    await until(member,'window.echo.getState().voiceChannelId === "ch-lobby" && window.echo.getVoiceStats().micReady','member physical microphone joined');
    await evaluate(owner,'document.querySelector("[data-channel-id=ch-chat]").click()');
    assert.equal(await evaluate(owner,'window.echo.getState().voiceChannelId === "ch-lobby" && window.echo.getVoiceStats().channelId === "ch-lobby" && document.getElementById("chat").hidden === false && document.getElementById("voiceStage").hidden'),true);
    pass('Voice UI excludes composer; browsing text preserves actual microphone connection');
    await memberMenu(owner,/** @type {string} */(memberId));await click(owner,'mentionMemberMenuBtn');
    assert.equal(await evaluate(owner,'document.getElementById("msgInput").value'),'<@'+memberKey+'> ');
    await click(owner,'sendBtn');
    await evaluate(member,'document.querySelector("[data-channel-id=ch-chat]").click()');
    await until(member,'document.querySelector("#messages .chat-mention.self")?.textContent === '+JSON.stringify('@<img src=x>'),'safe self mention render');
    assert.equal(await evaluate(member,'document.querySelector("#messages .chat-mention.self img") === null'),true);
    pass('Right-click mention inserts stable identity and renders escaped display name with own highlight');
    await memberMenu(owner,/** @type {string} */(memberId));await click(owner,'assignMemberPermissionsMenuBtn');
    assert.equal(await evaluate(owner,'document.getElementById("governanceMemberSelect").value'),memberKey);await click(owner,'closeGovernanceBtn');
    pass('Member permissions menu opens governance UI preselected to exact member');
    await memberMenu(owner,/** @type {string} */(memberId));await click(owner,'serverMuteMemberMenuBtn');
    await until(member,'window.echo.getState().users.find(user=>user.id===window.echo.getState().selfId)?.serverMuted === true','member sees management mute');
    await until(owner,'document.querySelector('+JSON.stringify('#membersScroll [data-user-id='+JSON.stringify(memberId)+'] .member-flag')+')?.getAttribute("title") === "管理静音"','owner sees management label');
    await until(member,'Object.values(window.echo.getVoiceStats().peers).some(peer=>peer.controlState==="open")','actual peer control channel open');
    assert.equal(await inspectInstances(member,'RTCDataChannel.prototype','function(){const channel=this.find(channel=>channel.label==="deepscord-control-v1"&&channel.readyState==="open");if(!channel)throw new Error("No live control channel");channel.send(JSON.stringify({type:"state",muted:false,deafened:false}));return true;}'),true);
    assert.equal(await evaluate(owner,'window.echo.getState().users.find(user=>user.id==='+JSON.stringify(memberId)+').serverMuted'),true);
    assert.equal(await inspectInstances(member,'RTCDataChannel.prototype','function(){const channel=this.find(channel=>channel.label==="deepscord-control-v1"&&channel.readyState==="open");if(!channel)throw new Error("No live control channel");channel.send(JSON.stringify({type:"leave"}));return true;}'),true);
    await until(owner,'window.echo.getState().users.find(user=>user.id==='+JSON.stringify(memberId)+')?.voiceChannelId === null','normal P2P departure notification');
    assert.equal(await evaluate(owner,'window.echo.getState().users.find(user=>user.id==='+JSON.stringify(memberId)+').serverMuted'),true);
    await evaluate(member,'window.echo.actions.leaveVoice();document.querySelector("[data-channel-id=ch-lobby]").click();document.querySelector("#stageActions [data-action=join]").click()');
    await until(member,'window.echo.getState().voiceChannelId === "ch-lobby" && window.echo.getState().users.find(user=>user.id===window.echo.getState().selfId)?.serverMuted === true','real peer rejoin retains management mute');
    await until(owner,'Object.values(window.echo.getVoiceStats().peers).some(peer=>peer.controlState==="open")','restarted peer control channel open');
    assert.equal(await evaluate(owner,'window.echo.getState().users.find(user=>user.id==='+JSON.stringify(memberId)+').serverMuted'),true);
    pass('Actual P2P state and leave notifications preserve management mute, including a real peer rejoin');
    await evaluate(member,'document.querySelector("[data-channel-id=ch-chat]").click()');
    await evaluate(member,'window.echo.actions.toggleMute();true');
    assert.equal(await evaluate(member,'window.echo.getState().users.find(user=>user.id===window.echo.getState().selfId).serverMuted'),true);
    await memberMenu(owner,/** @type {string} */(memberId));await click(owner,'serverMuteMemberMenuBtn');
    await until(member,'window.echo.getState().users.find(user=>user.id===window.echo.getState().selfId)?.serverMuted === false','member management unmute');
    pass('Owner context menu mutes and unmutes actual voice member; member cannot self-release management mute');
    assert.deepEqual(errors,[]);
    await evaluate(owner,'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
    await evaluate(member,'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
    fs.writeFileSync(path.join(directory,'owner.png'),(await owner.webContents.capturePage({x:0,y:0,width:1200,height:800},{stayHidden:true,stayAwake:true})).toPNG());
    fs.writeFileSync(path.join(directory,'member.png'),(await member.webContents.capturePage({x:0,y:0,width:1200,height:800},{stayHidden:true,stayAwake:true})).toPNG());
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({checks,errors,status:'passed'},null,2));
  }catch(error){fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({checks,errors,status:'failed',message:error instanceof Error ? error.stack : String(error)},null,2));throw error;}
  finally{for(const window of windows)window.destroy();fs.writeFileSync(path.join(directory,'server.log'),backend.output());await stop(backend);app.quit();}
}

if(process.versions.electron){const directory=process.env.DEEPSCORD_CHANNEL_MEMBER_DIRECTORY;assert(directory);await run(directory);}
else{
  const directory=fs.mkdtempSync(path.join(root,'.qa-tools/channel-member-ui-')),runtime=path.join(directory,'runtime');
  const source=fs.realpathSync(process.env.ELECTRON_TEST_BINARY ?? path.join(root,'.qa-tools/app-native-runtime/electron.exe')),original=path.dirname(source);
  /** @param {string} from @param {string} to @returns {void} */
  function stage(from,to){fs.mkdirSync(to,{recursive:true});for(const entry of fs.readdirSync(from,{withFileTypes:true})){const file=path.join(from,entry.name),relative=path.relative(original,file);if(relative==='resources'+path.sep+'app'||relative==='resources'+path.sep+'app.asar')continue;assert(!entry.isSymbolicLink());const target=path.join(to,entry.name);if(entry.isDirectory())stage(file,target);else fs.linkSync(file,target);}}
  stage(original,runtime);const app=path.join(runtime,'resources/app');fs.mkdirSync(app,{recursive:true});
  fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({name:'deepscord-channel-member-ui',version:'1.0.0',main:'main.cjs'}));
  fs.writeFileSync(path.join(app,'main.cjs'),"require('electron').app.setPath('userData',"+JSON.stringify(path.join(directory,'profile'))+");import("+JSON.stringify(import.meta.url)+").catch(error=>{console.error(error);process.exitCode=1;require('electron').app.quit();});");
  /** @type {NodeJS.ProcessEnv} */const environment={...process.env,DEEPSCORD_CHANNEL_MEMBER_DIRECTORY:directory,DEEPSCORD_TEST_NODE:process.execPath};delete environment.ELECTRON_RUN_AS_NODE;
  const child=spawn(path.join(runtime,path.basename(source)),[],{cwd:root,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout?.on('data',chunk=>process.stdout.write(chunk));child.stderr?.on('data',chunk=>process.stderr.write(chunk));
  const code=await new Promise(resolve=>child.once('exit',resolve));console.log(JSON.stringify({event:'channel-member-ui-result',directory,code}));assert.equal(code,0);const result=JSON.parse(fs.readFileSync(path.join(directory,'result.json'),'utf8'));assert.equal(result.status,'passed',result.message);process.exitCode=0;
}
