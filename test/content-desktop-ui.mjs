// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {page as debuggerPage,pause as sleep} from './security-cdp.mjs';
import {identity,launch,stop,connect,authenticate,send,receive,object} from './server-ws-helpers.mjs';
import replica from '../lib/room-replica.cjs';
import governance from '../lib/server-governance.cjs';
import codec from '../lib/avif-codec.cjs';
import {parseMediaMetadata} from '../public/js/chat-protocol.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const source=fs.realpathSync(process.env.ELECTRON_TEST_BINARY||path.join(root,'.qa-tools/screen-diagnostics-runtime/Deepscord.exe'));
const mainPath=process.env.DESKTOP_TEST_MAIN||path.join(root,'desktop/main.js');assert(path.isAbsolute(mainPath),'Desktop test main must be an absolute file path');const mainSource=fs.realpathSync(mainPath);assert(fs.statSync(mainSource).isFile(),'Desktop test main must be a regular file');
const directory=fs.mkdtempSync(path.join(root,'.qa-tools/content-desktop-ui-'));
const data=path.join(directory,'profile'),runtime=path.join(directory,'runtime');fs.mkdirSync(data);
const owner=identity(),roomId=randomUUID(),descriptor={version:/** @type {const} */(1),roomId,creatorKey:owner.key};
fs.writeFileSync(path.join(data,'workspace.json'),JSON.stringify({version:1,privateKey:owner.privateKey.export({format:'der',type:'pkcs8'}).toString('base64'),entries:[]}));
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({autoConnect:false,trustedHosts:['127.0.0.1']}));
fs.writeFileSync(path.join(data,'desktop-settings.json'),JSON.stringify({muteShortcut:'Control+Alt+Shift+F23',overlay:{enabled:false,locked:true,x:24,y:80,width:280,height:300,scale:1}}));
const original=path.dirname(source);
/** @param {string} from @param {string} to @returns {void} */
function stage(from,to){fs.mkdirSync(to,{recursive:true});for(const entry of fs.readdirSync(from,{withFileTypes:true})){const file=path.join(from,entry.name),relative=path.relative(original,file);if(relative==='resources'+path.sep+'app'||relative==='resources'+path.sep+'app.asar')continue;assert(!entry.isSymbolicLink());const target=path.join(to,entry.name);if(entry.isDirectory())stage(file,target);else fs.linkSync(file,target);}}
stage(original,runtime);
const app=path.join(runtime,'resources/app');fs.mkdirSync(app,{recursive:true});
fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({name:'deepscord-content-desktop-test',version:'1.0.0',main:'main.cjs'}));
fs.writeFileSync(path.join(app,'main.cjs'),"const {app}=require('electron');process.on('message',message=>{if(message==='content-test-quit')app.quit();});app.on('browser-window-created',(_event,window)=>{window.on('show',()=>window.hide());window.webContents.on('render-process-gone',(_event,details)=>console.error('content_renderer_gone',details));});require("+JSON.stringify(mainSource)+");\n");
const document=replica.createRoomDocument(descriptor,0,[{id:'srv-main',name:'Content desktop room',icon:'C',color:'#123456',channels:[{id:'ch-history',name:'History',type:'text',userLimit:0},{id:'ch-other',name:'Other',type:'text',userLimit:0}]}]);
const seed=path.join(directory,'room.json'),journal=path.join(directory,'governance.json');fs.writeFileSync(seed,JSON.stringify(document));fs.writeFileSync(journal,JSON.stringify(governance.createGovernance(descriptor)));
/** @type {Awaited<ReturnType<typeof launch>>|null} */let backend=null;
/** @type {import('node:child_process').ChildProcess|null} */let desktop=null;
/** @type {Awaited<ReturnType<typeof connectPage>>|null} */let page=null;
/** @type {string[]} */const checks=[];
/** @type {{message:string,stack:string}|null} */let failure=null;
const legacy='Historical text survives encrypted migration';
const fresh='New encrypted text from actual desktop UI';
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{eval:(expression:string)=>Promise<JsonValue>,send:(method:string,params:{[key:string]:JsonValue})=>Promise<{[key:string]:JsonValue}>,waitFor:(expression:string,options:{timeout:number,interval:number,label:string})=>Promise<void>,close:()=>void}} Ui */
/** @param {number} port @param {string} prefix @returns {Promise<Ui>} */
async function connectPage(port,prefix){const debuggerClient=await debuggerPage(port,prefix);return{eval:debuggerClient.evaluate,send:debuggerClient.send,close:debuggerClient.close,waitFor:async(expression,options)=>{const deadline=Date.now()+options.timeout;while(Date.now()<deadline){if(await debuggerClient.evaluate(expression))return;await sleep(options.interval);}throw new Error('Desktop condition timed out: '+options.label+' / '+expression);}};}
/** @param {string} label @returns {void} */function pass(label){checks.push(label);console.log(JSON.stringify({event:'content-desktop-pass',label}));}
/** @param {number} port @param {number} timeout @returns {Promise<void>} */async function waitForPort(port,timeout){const deadline=Date.now()+timeout;while(Date.now()<deadline){try{const response=await fetch('http://127.0.0.1:'+port+'/json/version',{signal:AbortSignal.timeout(500)});if(response.ok)return;}catch(error){if(!(error instanceof TypeError)&&!(error instanceof DOMException))throw error;}await sleep(100);}throw new Error('Desktop debugger did not start');}
/** @returns {Promise<number>} */async function freePort(){const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address==='object');server.close();await once(server,'close');return address.port;}
/** @returns {Promise<void>} */async function closeDesktop(){page?.close();page=null;const owned=desktop;desktop=null;if(!owned?.pid||owned.exitCode!==null)return;assert(owned.connected,'Owned desktop control channel is disconnected');/** @type {ReturnType<typeof setTimeout>|null} */let timer=null;const exited=once(owned,'exit');owned.send('content-test-quit');try{await Promise.race([exited,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Owned desktop did not quit cleanly')),10000);})]);}catch(error){const result=spawnSync('taskkill.exe',['/PID',String(owned.pid),'/T','/F'],{windowsHide:true,encoding:'utf8'});if(result.error)throw result.error;throw error;}finally{if(timer)clearTimeout(timer);}}
/** @returns {Promise<void>} */async function interruptDesktop(){page?.close();page=null;const owned=desktop;desktop=null;assert(owned?.pid);const result=spawnSync('taskkill.exe',['/PID',String(owned.pid),'/T','/F'],{windowsHide:true,encoding:'utf8'});if(result.error)throw result.error;assert.equal(result.status,0,result.stderr);}
/** @param {string} label @returns {void} */function snapshotProtection(label){const files=['Local State','content-keys.dpapi'].map(name=>{const filename=path.join(data,name);if(!fs.existsSync(filename))return{name,exists:false};const bytes=fs.readFileSync(filename),stat=fs.statSync(filename);fs.copyFileSync(filename,path.join(directory,label+'-'+name));return{name,exists:true,bytes:stat.size,modified:stat.mtime.toISOString(),sha256:createHash('sha256').update(bytes).digest('hex')};});fs.writeFileSync(path.join(directory,label+'-protection.json'),JSON.stringify({profile:data,files},null,2));}
/** @returns {Promise<Ui>} */
async function launchDesktop(){
  const port=await freePort();
  /** @type {NodeJS.ProcessEnv} */
  const environment={...process.env,DEEPSCORD_USER_DATA:data};delete environment.ELECTRON_RUN_AS_NODE;
  const log=fs.openSync(path.join(directory,'desktop-'+port+'.log'),'a');desktop=spawn(path.join(runtime,path.basename(source)),['--remote-debugging-port='+port,'--remote-debugging-address=127.0.0.1'],{env:environment,cwd:root,windowsHide:true,stdio:['ignore',log,log,'ipc']});fs.closeSync(log);
  await waitForPort(port,15000);
  if(!fs.existsSync(path.join(data,'config.json'))||!JSON.parse(fs.readFileSync(path.join(data,'config.json'),'utf8')).lastWorkspaceEntryId){const workspace=await connectPage(port,'file:');await workspace.waitFor('typeof window.deepscord?.connect === "function"',{timeout:10000,interval:50,label:'production workspace'});assert(backend);await workspace.eval('setTimeout(()=>void window.deepscord.connect('+JSON.stringify(backend.origin)+'),100)');workspace.close();}
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){
    /** @type {{url:string,type:string}[]} */const targets=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    const target=targets.find(target=>target.type==='page'&&target.url.startsWith('http://127.0.0.1:'));
    if(target){const room=await connectPage(port,target.url);page=room;await room.waitFor('!!window.echo && (!!document.getElementById("welcomeNameInput") || window.echo.getState().roomReady)',{timeout:15000,interval:50,label:'bundled room interface'});if(await room.eval('!!document.getElementById("welcomeEnterBtn")'))await room.eval('document.getElementById("welcomeNameInput").value="Content desktop owner";document.getElementById("welcomeEnterBtn").click()');return room;}
    await sleep(100);
  }
  throw new Error('Production desktop did not open its bundled room interface');
}
/** @param {Awaited<ReturnType<typeof connectPage>>} ui @returns {Promise<void>} */async function ready(ui){await ui.waitFor('window.echo?.getState().roomReady && window.echo.getState().selfKey === '+JSON.stringify(owner.key)+' && !!window.echo.getState().chatMedia',{timeout:15000,interval:50,label:'verified owner and media ready'});}
/** @param {number} previous @returns {Promise<void>} */async function replicaCommitted(previous){const deadline=Date.now()+15000;while(Date.now()<deadline){/** @type {{document:{revision:number}}} */const persisted=JSON.parse(fs.readFileSync(path.join(directory,'server/room-identity.json'),'utf8'));if(persisted.document.revision>previous)return;await sleep(50);}throw new Error('Authenticated desktop room replica did not commit before migration');}
/** @param {Awaited<ReturnType<typeof connectPage>>} ui @param {string} id @param {string} file @returns {Promise<void>} */async function chooseFile(ui,id,file){const document=object(await ui.send('DOM.getDocument',{})),node=object(await ui.send('DOM.querySelector',{nodeId:object(document.root).nodeId,selector:'#'+id}));assert(typeof node.nodeId==='number'&&node.nodeId>0);await ui.send('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[file]});}
try{
  backend=await launch(path.join(directory,'server'),{ECHO_ROOM_ID:roomId,ECHO_ROOM_CREATOR_KEY:owner.key,ECHO_ROOM_SEED_PATH:seed,ECHO_GOVERNANCE_SEED_PATH:journal});
  const client=await connect(backend,'Historical owner');await authenticate(client,owner);
  /** @param {string} type @param {JsonValue} payload @returns {Promise<JsonValue>} */
  async function request(type,payload){assert(payload&&typeof payload==='object'&&!Array.isArray(payload));const requestId=randomUUID(),cursor=send(client,{t:type,...payload,requestId}),reply=await receive(client,cursor,message=>message.t===(type==='chat'?'chatResult':'mediaResult')&&message.requestId===requestId,'normal seed '+type);assert.equal(reply.ok,true,JSON.stringify(reply));assert(reply.result!==undefined);return reply.result;}
  await request('chat',{channelId:'ch-history',text:legacy});
  const image=fs.readFileSync(path.join(root,'test/avif-codec-fixtures/transparent-animation.avif')),asset=parseMediaMetadata({...await codec.validate(image,'image',new AbortController().signal),sha256:createHash('sha256').update(image).digest('hex'),bytes:image.length});
  const begun=object(await request('mediaRequest',{op:'begin',kind:'image',domainId:null,sha256:asset.sha256,bytes:asset.bytes}));
  if(begun.asset===undefined){for(let offset=0;offset<image.length;offset+=16384)await request('mediaRequest',{op:'write',uploadId:begun.uploadId,offset,data:image.subarray(offset,offset+16384).toString('base64')});await request('mediaRequest',{op:'finish',uploadId:begun.uploadId});}
  const historicImage=object(object(await request('chat',{channelId:'ch-history',text:'Historical actual AVIF',attachment:{...asset,kind:'image',name:'history-animation.avif'}})).message);assert(typeof historicImage.id==='string');
  const imageButton='chatAttachment-'+historicImage.id,imageDecoded='(()=>{const image=document.getElementById("chatMediaPreviewImage");return image instanceof HTMLImageElement && image.complete && image.naturalWidth === '+asset.width+' && image.naturalHeight === '+asset.height+';})()';client.socket.close();await client.closed;
  pass('normal authenticated historical text and real AVIF seeded');
  /** @type {{document:{revision:number}}} */const priorReplica=JSON.parse(fs.readFileSync(path.join(directory,'server/room-identity.json'),'utf8'));
  page=await launchDesktop();await ready(page);await replicaCommitted(priorReplica.document.revision);const uiOrigin=await page.eval('location.origin');assert.notEqual(uiOrigin,backend.origin);pass('verified owner uses a separate bundled frontend origin');
  await page.waitFor('document.getElementById("messages").textContent.includes('+JSON.stringify(legacy)+')',{timeout:10000,interval:50,label:'plaintext historical text'});
  await page.eval('document.getElementById("serverMenuBtn").click();document.getElementById("contentSettingsMenuBtn").click()');
  await page.waitFor('!!document.getElementById("contentMigrationStart") && !document.getElementById("contentMigrationStart").hidden',{timeout:10000,interval:50,label:'owner migration setting'});
  pass('owner migration confirmation opened via stable UI IDs');
  await page.eval('document.getElementById("contentMigrationStart").click();document.getElementById("contentMigrationConfirm").click()');
  await page.waitFor('window.echo?.getState().roomReady && !document.getElementById("contentMigrationProgress") && document.getElementById("messages")?.textContent.includes('+JSON.stringify(legacy)+')',{timeout:45000,interval:100,label:'actual UI migration commit and reload'});
  await ready(page);
  await page.eval('document.getElementById('+JSON.stringify(imageButton)+').click()');await page.waitFor(imageDecoded,{timeout:15000,interval:50,label:'decrypted historical AVIF decoded after UI migration'});await page.eval('document.getElementById("chatMediaPreviewCloseBtn").click()');
  /** @type {{content:object,messages:{[key:string]:import('../public/js/chat-protocol.js').ChatMessage[]}}} */const stored=JSON.parse(fs.readFileSync(path.join(directory,'server/store.json'),'utf8'));assert(stored.content);assert(stored.messages['ch-history'].filter(row=>!row.system).every(row=>row.text===''&&row.sealed));assert(!fs.readFileSync(path.join(directory,'server/store.json'),'utf8').includes(legacy));pass('UI migrated historical text and actual media to ciphertext and reloaded readable history');
  await page.eval('document.getElementById("msgInput").value='+JSON.stringify(fresh)+';document.getElementById("composer").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}))');
  await page.waitFor('document.getElementById("messages").textContent.includes('+JSON.stringify(fresh)+') && document.getElementById("msgInput").value === ""',{timeout:15000,interval:50,label:'encrypted new chat acknowledgement'});pass('new encrypted chat sent through the actual composer');
  await chooseFile(page,'chatImageFileInput',path.join(root,'test/avif-codec-fixtures/transparent-animation.avif'));
  await page.waitFor('!document.getElementById("mediaComposerPreview").hidden && !document.getElementById("mediaSendBtn").disabled',{timeout:30000,interval:50,label:'new image staging'});
  await page.eval('document.getElementById("mediaSendBtn").click()');await page.waitFor('document.getElementById("mediaComposerPreview").hidden && window.echo.getState().chatMedia.requests === 0',{timeout:20000,interval:50,label:'encrypted image accepted'});
  pass('real AVIF image sent through the encrypted image composer');
  await page.eval('window.deepscord.saveClientPreferences({...window.echo.getState().settings,micVolume:87,screenPreferences:{...window.echo.getState().settings.screenPreferences,uploadLimitMbps:17,screenResolution:1080,screenFrameRate:24}})');await page.eval('document.querySelector("[data-channel-id=ch-other]").click()');await page.waitFor('window.echo.getState().activeChannelId === "ch-other"',{timeout:10000,interval:50,label:'ordinary channel selection before restart'});
  await page.waitFor('(async()=>{const preferences=await window.deepscord.getClientPreferences();return preferences.settings.micVolume===87 && preferences.settings.screenPreferences.uploadLimitMbps===17 && preferences.lastChannel.channelId==="ch-other";})()',{timeout:10000,interval:50,label:'native preference and channel persistence'});
  snapshotProtection('before-restart');
  const restart=process.argv.includes('--forced-restart')?interruptDesktop:closeDesktop;await restart();snapshotProtection('after-shutdown');page=await launchDesktop();await ready(page);snapshotProtection('after-reopen');
  assert.equal(await page.eval('window.echo.getState().settings.micVolume'),87);assert.equal(await page.eval('window.echo.getState().settings.screenPreferences.uploadLimitMbps'),17);assert.equal(await page.eval('window.echo.getState().settings.screenPreferences.screenResolution'),1080);assert.equal(await page.eval('window.echo.getState().settings.screenPreferences.screenFrameRate'),24);assert.equal(await page.eval('window.echo.getState().activeChannelId'),'ch-other');pass('microphone volume screen preferences and selected channel survived desktop restart');await page.eval('document.querySelector("[data-channel-id=ch-history]").click()');
  await page.waitFor('document.getElementById("messages").textContent.includes('+JSON.stringify(legacy)+') && document.getElementById("messages").textContent.includes('+JSON.stringify(fresh)+')',{timeout:15000,interval:50,label:'protected key after desktop restart'});
  await page.eval('document.getElementById('+JSON.stringify(imageButton)+').click()');await page.waitFor(imageDecoded,{timeout:15000,interval:50,label:'historical AVIF decoded after fresh desktop restart'});await page.eval('document.getElementById("chatMediaPreviewCloseBtn").click()');
  /** @type {{messages:{[key:string]:import('../public/js/chat-protocol.js').ChatMessage[]}}} */const finalStore=JSON.parse(fs.readFileSync(path.join(directory,'server/store.json'),'utf8'));const accepted=finalStore.messages['ch-history'].filter(row=>!row.system);assert.equal(accepted.length,4);assert(accepted.every(row=>row.text===''&&row.sealed));assert(accepted.filter(row=>row.attachment).every(row=>row.attachment?.encrypted===true));assert(!fs.readFileSync(path.join(directory,'server/store.json'),'utf8').includes(fresh));
  pass('fresh desktop process reopened protected room key and decrypted old and new history');
  
}catch(error){failure={message:error instanceof Error?error.message:String(error),stack:error instanceof Error?error.stack||'':''};snapshotProtection('after-failure');if(page){try{fs.writeFileSync(path.join(directory,'page-state.json'),JSON.stringify(await page.eval('({url:location.origin,status:document.getElementById("contentMigrationStatus")?.textContent,body:document.body.innerText.slice(-5000),state:window.echo?.getState()})'),null,2));}catch(diagnostic){console.error('content-desktop-diagnostic',String(diagnostic));}}}
finally{await closeDesktop();if(backend){fs.writeFileSync(path.join(directory,'server.log'),backend.output());await stop(backend);}fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({source,mainSource,checks,failure},null,2));console.log(JSON.stringify({event:'content-desktop-finished',directory,checks:checks.length,failure}));}
if(failure)process.exitCode=1;


