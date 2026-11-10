// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {CDP,connectPage,waitForPort} from './cdp.mjs';
import {launch,stop,object,string,until} from './server-ws-helpers.mjs';
import {parseMediaMetadata,parseAttachment} from '../public/js/chat-protocol.js';
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {Awaited<ReturnType<typeof connectPage>>} Page */
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixtureFile=path.join(root,'test/fixtures/memory-lifecycle-animation.avif');
/** @type {JsonValue} */const fixtureManifest=JSON.parse(fs.readFileSync(path.join(root,'test/fixtures/memory-lifecycle-animation.json'),'utf8'));
const fixture=parseMediaMetadata(fixtureManifest),fixtureMime=string(object(fixtureManifest).mime);
assert.deepEqual({width:fixture.width,height:fixture.height,frames:fixture.frames,animated:fixture.animated,durationMs:fixture.durationMs},{width:320,height:192,frames:2,animated:true,durationMs:250});assert.equal(fixtureMime,'image/avif');
assert.equal(createHash('sha256').update(fs.readFileSync(fixtureFile)).digest('hex'),fixture.sha256);assert.equal(fs.statSync(fixtureFile).size,fixture.bytes);
assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root,string(object(fixtureManifest).sourceGif)))).digest('hex'),string(object(fixtureManifest).sourceGifSha256));
const fixtureItemId='personal-'+fixture.sha256;
const app=fs.realpathSync(process.env.DEEPSCORD_MEMORY_APP ?? path.join(root,'dist/personal-retained-20261109-01/Deepscord-win32-x64/resources/app'));
const packagedFrontend=['app.js','presentation-visibility.js'].map(name=>{const file=path.join(app,'app-server/public/js',name),exists=fs.existsSync(file);return {name,file,exists,sha256:exists?createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null};});assert(packagedFrontend[0].exists);
const executable=fs.realpathSync(path.join(root,'node_modules/electron/dist/electron.exe'));
const output=path.resolve(process.env.DEEPSCORD_MEMORY_OUTPUT ?? path.join(root,'.qa-tools/results/memory-lifecycle-20261109/baseline'));
const rounds=Number(process.env.DEEPSCORD_MEMORY_ROUNDS ?? '1');
assert(Number.isInteger(rounds)&&rounds>0&&rounds<=5);
fs.mkdirSync(output,{recursive:true});
const runFile=promisify(execFile);
/** @param {number} milliseconds @returns {Promise<void>} */
function delay(milliseconds){return new Promise(resolve=>setTimeout(resolve,milliseconds));}
/** @returns {Promise<number>} */
async function port(){const listener=net.createServer();await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',()=>resolve(undefined));});const address=listener.address();assert(address&&typeof address!=='string');await new Promise((resolve,reject)=>listener.close(error=>error?reject(error):resolve(undefined)));return address.port;}
/** @param {Page} page @param {string} expression @param {string} label @returns {Promise<void>} */
async function ready(page,expression,label){await page.waitFor(expression,{timeout:20000,interval:25,label});}
/** @param {number} round @returns {Promise<JsonValue>} */
async function run(round){
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-memory-'));
 const backend=await launch(path.join(temporary,'server'),{});
 const data=path.join(temporary,'client');fs.mkdirSync(data);
 fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({serverUrl:backend.origin,autoConnect:false,trustedHosts:[]}));
 fs.writeFileSync(path.join(data,'desktop-settings.json'),JSON.stringify({muteShortcut:'Control+Alt+Shift+F9',overlay:{enabled:false,locked:true,x:24,y:80,width:280,height:300,scale:1}}));
 const debug=await port(),controlPort=await port();
 /** @type {NodeJS.ProcessEnv} */const environment={...process.env,DEEPSCORD_USER_DATA:data,DEEPSCORD_MEMORY_APP:app,DEEPSCORD_MEMORY_CONTROL_PORT:String(controlPort)};delete environment.ELECTRON_RUN_AS_NODE;
 const child=spawn(executable,[path.join(root,'test/memory-lifecycle-wrapper.cjs'),'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+debug],{cwd:root,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let clientLog='';child.stdout.on('data',chunk=>{clientLog+=String(chunk);});child.stderr.on('data',chunk=>{clientLog+=String(chunk);});
 /** @type {Page[]} */ const pages=[];
 /** @type {JsonValue[]} */ const snapshots=[];
 /** @type {number[]} */ const timings=[];
 /** @type {JsonValue[]} */ const lifecycleChecks=[];
 /** @type {JsonValue[]} */ const networkClosures=[];
 /** @type {JsonValue[]} */ const sceneEvidence=[];
 /** @param {string} endpoint @returns {Promise<JsonValue>} */
 async function control(endpoint){const response=await fetch('http://127.0.0.1:'+controlPort+endpoint);assert.equal(response.status,200);return response.json();}
 /** @param {string} url @returns {Promise<Page>} */
 async function attach(url){const page=await connectPage(debug,url);pages.push(page);return page;}
 /** @param {Page} picker @param {string} stage @returns {Promise<void>} */
 async function privateForeground(picker,stage){
  await ready(picker,"document.body.dataset.active==='true'",'private picker activation');
  const before=await control('/metrics'),after=await control('/private-foreground');
  lifecycleChecks.push({stage,control:'Shared foreground condition: only this private WebContentsView backgroundThrottling=false in both versions. Excludes the known old visibility fault from memory savings.',before,after});
  await ready(picker,"document.visibilityState==='visible' && document.body.dataset.active==='true' && document.getElementById('personalStickerPickerGrid')?.getBoundingClientRect().width>0 && document.getElementById('personalStickerPickerGrid').getBoundingClientRect().height>0",'private collection visible in actual foreground with grid layout');
 }
 /** @param {string} stage @returns {Promise<void>} */
 async function privateBackground(stage){const before=await control('/metrics'),after=await control('/private-background');lifecycleChecks.push({stage,control:'Shared inactive condition: only this private WebContentsView backgroundThrottling=true in both versions; pane business state and caches unchanged.',before,after});}
 /** @param {string} stage @returns {Promise<void>} */
 async function sample(stage){
  await delay(1500);
  for(let index=0;index<3;index++){
   const application=object(await control('/metrics'));assert.equal(application.pid,child.pid);assert.equal(path.resolve(string(application.userData)),path.resolve(data));assert.equal(application.electron,fs.readFileSync(path.join(app,'../../version'),'utf8').trim());
   const {stdout}=await runFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'test/memory-lifecycle-processes.ps1'),'-RootPid',String(child.pid)],{windowsHide:true,timeout:15000});
   /** @type {JsonValue} */const raw=JSON.parse(stdout.trim());assert(Array.isArray(raw));const processes=raw.map(object);
   assert(processes.some(row=>row.pid===child.pid));
   /** @type {JsonValue} */const targets=await(await fetch('http://127.0.0.1:'+debug+'/json/list')).json();assert(Array.isArray(targets));
   /** @type {JsonValue[]} */const renderers=[];
   for(const target of targets.map(object).filter(row=>row.type==='page')){
    const page=await CDP.connect(string(target.webSocketDebuggerUrl));
    try {await page.send('Performance.enable',{});const metrics=await page.send('Performance.getMetrics',{}),dom=await page.send('Memory.getDOMCounters',{});const ping=performance.now();await page.eval('document.readyState');const eventLoopRoundTripMs=performance.now()-ping;renderers.push({url:string(target.url),metrics:metrics.metrics,dom,eventLoopRoundTripMs});}finally{page.close();}
   }
   const snapshot={stage,index,at:new Date().toISOString(),privateCommittedBytes:processes.reduce((total,row)=>{assert.equal(typeof row.privateCommittedBytes,'number');return total+Number(row.privateCommittedBytes);},0),processCount:processes.length,processes,application,renderers};snapshots.push(snapshot);
   fs.writeFileSync(path.join(output,'round-'+round+'-partial.json'),JSON.stringify(snapshots,null,2));
   console.log(JSON.stringify({round,stage,index,privateCommittedMiB:snapshot.privateCommittedBytes/1048576,processes:processes.length}));
  }
 }
 const workspaceUrl=pathToFileURL(path.join(app,'workspace.html')).href,pickerUrl=pathToFileURL(path.join(app,'sticker-picker.html')).href;
 try{
  await waitForPort(debug,20000);
  const workspace=await attach(workspaceUrl);await ready(workspace,"document.getElementById('workspaceLoading')?.hidden===true",'workspace ready');
  await sample('startup-workspace');
  await workspace.eval("document.getElementById('workspaceAddBtn').click()");
  const connection=await attach(pathToFileURL(path.join(app,'connections.html')).href);
  await ready(connection,"document.getElementById('connectionChoice')?.hidden===false",'connection chooser');
  await connection.eval("document.getElementById('chooseJoinBtn').click();document.getElementById('serverMethodBtn').click();document.getElementById('serverUrl').value="+JSON.stringify(backend.origin)+";document.getElementById('serverConnectBtn').click()");
  const ui=await attach('http://127.0.0.1:');
  lifecycleChecks.push({stage:'frontend-provenance',backendOrigin:backend.origin,roomRendererUrl:await ui.eval('location.href'),packagedFrontend});
  await ui.send('Network.enable',{});ui.on('Network.webSocketClosed',/** @param {JsonValue} event */event=>networkClosures.push(event));
  await ready(ui,"!!document.getElementById('welcomeNameInput')",'welcome');
  await ui.eval("document.getElementById('welcomeNameInput').value='Memory lifecycle';document.getElementById('welcomeEnterBtn').click()");
  await ready(ui,"window.echo?.getState().roomReady && !!window.echo.getState().selfKey && !document.querySelector('.modal-backdrop')",'connected and identity verified');
  await sample('connected-idle');
  await control('/show');
  await ui.eval("document.getElementById('emojiPanelBtn').click()");const picker=await attach(pickerUrl);
  await picker.send('Page.bringToFront',{});
  await privateForeground(picker,'shared-private-foreground-initial');
  lifecycleChecks.push({stage:'private-foreground-ready',application:await control('/metrics'),picker:await picker.eval("({visibilityState:document.visibilityState,active:document.body.dataset.active,focused:document.hasFocus(),grid:document.getElementById('personalStickerPickerGrid').getBoundingClientRect().toJSON()})")});
  const documentNode=await picker.send('DOM.getDocument',{}),input=await picker.send('DOM.querySelector',{nodeId:documentNode.root.nodeId,selector:'#personalStickerPickerImportInput'});assert(input.nodeId>0);
  await picker.send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[path.join(root,'test/fixtures/avatar-96.jpg'),fixtureFile]});
  await ready(picker,"document.querySelectorAll('#personalStickerPickerGrid [data-testid=sticker-cell]').length===2 && !document.getElementById('personalStickerPicker').hasAttribute('aria-busy')",'actual JPG and frozen animation imports committed');
  await ready(picker,"[...document.querySelectorAll('#personalStickerPickerGrid img')].length===2 && [...document.querySelectorAll('#personalStickerPickerGrid img')].every(image=>image.naturalWidth>0)",'both imported thumbnails actually decoded');
  /** @type {JsonValue} */const persistedIndex=JSON.parse(fs.readFileSync(path.join(data,'stickers/index.json'),'utf8'));const persistedItems=array(object(persistedIndex).items).map(object),selected=persistedItems.find(item=>item.id===fixtureItemId);assert(selected);assert.deepEqual(parseMediaMetadata(selected),fixture);assert.equal(createHash('sha256').update(fs.readFileSync(path.join(data,'stickers',fixture.sha256+'.avif'))).digest('hex'),fixture.sha256);
  const controlId='personalStickerPickerItem-personal-'+fixtureItemId;
  await ready(picker,'!!document.getElementById('+JSON.stringify(controlId)+')','persisted exact animation item control');
  await picker.eval('setTimeout(()=>document.getElementById('+JSON.stringify(controlId)+').click(),0)');
  const attachmentSelector='[data-msg-attachment="'+fixture.sha256+'"]';
  await ready(ui,'document.querySelector('+JSON.stringify(attachmentSelector)+')?.querySelector("img")?.naturalWidth===320','exact animation uploaded and displayed');
  await until(()=>{const filename=path.join(temporary,'server/store.json');if(!fs.existsSync(filename))return false;/** @type {JsonValue} */const value=JSON.parse(fs.readFileSync(filename,'utf8'));return Object.values(object(object(value).messages)).some(messages=>Array.isArray(messages)&&messages.some(message=>{const attachment=object(message).attachment;return attachment!==undefined&&attachment!==null&&object(attachment).sha256===fixture.sha256;}));},backend.failure,'exact animation persisted by the actual backend');
  /** @type {JsonValue} */const storedState=JSON.parse(fs.readFileSync(path.join(temporary,'server/store.json'),'utf8'));const attachments=Object.values(object(object(storedState).messages)).flatMap(messages=>array(messages).map(object).filter(message=>message.attachment!==undefined).map(message=>parseAttachment(message.attachment)));assert.equal(attachments.length,1);assert.deepEqual(parseMediaMetadata(attachments[0]),fixture);assert.equal(attachments[0].kind,'sticker');
  const mediaRoot=path.join(temporary,'server/media'),roomDirectories=fs.readdirSync(mediaRoot,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(entry.name));assert.equal(roomDirectories.length,1);const storedFile=path.join(mediaRoot,roomDirectories[0].name,'objects',fixture.sha256+'.avif'),storedBytes=fs.readFileSync(storedFile);assert.equal(createHash('sha256').update(storedBytes).digest('hex'),fixture.sha256);assert.equal(storedBytes.length,fixture.bytes);assert.equal(storedBytes.toString('ascii',4,8),'ftyp');assert(storedBytes.subarray(8,32).includes(Buffer.from('avis'))||storedBytes.subarray(8,32).includes(Buffer.from('avif')));
  await ui.eval('document.querySelector('+JSON.stringify(attachmentSelector)+').focus()');
  const displayedAnimation='(async()=>{const host=document.querySelector('+JSON.stringify(attachmentSelector)+'),image=host?.querySelector("img");if(!image?.getAttribute("src")||image.naturalWidth!==320||image.naturalHeight!==192)return null;const response=await fetch(image.src);if(!response.ok)throw new Error("Actual animation Blob read failed: "+response.status);const blob=await response.blob(),sha256=[...new Uint8Array(await crypto.subtle.digest("SHA-256",await blob.arrayBuffer()))].map(value=>value.toString(16).padStart(2,"0")).join("");return {sha256,mime:blob.type,bytes:blob.size,width:image.naturalWidth,height:image.naturalHeight};})()';
  await ready(ui,'(async()=>{const value=await '+displayedAnimation+';return value?.mime==="image/avif"&&value.sha256==='+JSON.stringify(fixture.sha256)+';})()','exact animation Blob MIME and SHA after real focus');
  const rendered=object(await ui.eval(displayedAnimation));assert.deepEqual(rendered,{sha256:fixture.sha256,mime:fixtureMime,bytes:fixture.bytes,width:fixture.width,height:fixture.height});sceneEvidence.push({fixture:fixtureManifest,persistedItemId:fixtureItemId,attachment:attachments[0],serverFile:storedFile,rendered});
  await privateBackground('shared-private-background-after-send');
  await ui.eval("document.getElementById('emojiPanelBtn').click()");await privateForeground(picker,'shared-private-foreground-after-send');
  for(let count=0;count<20;count++){
   await picker.eval("setTimeout(()=>document.getElementById('personalStickerPickerTabserver').click(),0)");
   await ready(ui,"document.getElementById('stickerPanelTabserver').getAttribute('aria-pressed')==='true' && !document.getElementById('stickerPanel').hasAttribute('aria-busy')",'server handoff');
   await privateBackground('shared-private-background-switch-'+count);
   const start=performance.now();await ui.eval("document.getElementById('stickerPanelTabpersonal').click()");
   await privateForeground(picker,'shared-private-foreground-switch-'+count);
   await ready(picker,"document.body.dataset.active==='true' && document.querySelector('#personalStickerPickerGrid img')?.naturalWidth>0",'personal restore');timings.push(performance.now()-start);
  }
  await sample('images-and-20-private-switches');
  await picker.screenshot(path.join(output,'round-'+round+'-private.png'));
  await control('/popup-show');await sample('active-popup');
  const activeWindows=array(object(await control('/metrics')).windows).map(object);assert.equal(activeWindows.filter(window=>string(window.url).endsWith('/poke-request.html')&&window.visible===true).length,1);
  await control('/popup-clear');await delay(35000);await sample('popup-idle-35s');
  const popupWindows=array(object(await control('/metrics')).windows).map(object).filter(window=>string(window.url).endsWith('/poke-request.html'));lifecycleChecks.push({stage:'popup-idle-35s',windows:popupWindows,driver:'Controlled parseRequestState/updatePokeRequests module input owned by actual room webContents; no remote authorization or user decision flow exercised.'});
  const networkExpression="(()=>{const state=window.echo.getState();return {networkReady:state.roomReady&&state.connStatus==='open',roomReady:state.roomReady,connStatus:state.connStatus,selfId:state.selfId,uiHidden:document.documentElement.getAttribute('data-ui-hidden'),documentHidden:document.hidden,attachments:[...document.querySelectorAll('[data-testid=chat-attachment] img')].map(image=>({sha256:image.parentElement.dataset.msgAttachment,hasSource:image.hasAttribute('src'),width:image.naturalWidth,height:image.naturalHeight}))};})()";
  const beforeBackground=object(await ui.eval(networkExpression));assert.equal(beforeBackground.networkReady,true);lifecycleChecks.push({stage:'before-background',...beforeBackground});
  const closuresBefore=networkClosures.length;
  const hiddenApplication=await control('/hide'),hiddenWindows=array(object(hiddenApplication).windows).map(object);assert(hiddenWindows.length>0&&hiddenWindows.every(window=>window.visible===false),'Native benchmark windows must all be hidden');lifecycleChecks.push({stage:'shared-private-background-native-hide',control:'Both versions set only the private view backgroundThrottling=true when native windows hide.',application:hiddenApplication});await delay(10000);
  const hidden=object(await ui.eval(networkExpression));assert.equal(hidden.networkReady,true);assert.equal(hidden.selfId,beforeBackground.selfId);
  if(beforeBackground.uiHidden!==null){assert.equal(hidden.uiHidden,'true');assert(array(hidden.attachments).length>0);assert(array(hidden.attachments).map(object).every(image=>image.hasSource===false),'Background UI must release actual chat image sources');}
  lifecycleChecks.push({stage:'hidden-background-10s',...hidden});await sample('hidden-background-10s');
  await control('/show');
  await ready(ui,"!document.hidden && document.querySelector('[data-testid=chat-attachment] img')?.naturalWidth>0",'actual chat image restored after foreground');
  assert.equal(await ui.eval('document.querySelector('+JSON.stringify(attachmentSelector)+').querySelector("img").naturalWidth'),fixture.width);assert.equal(await ui.eval('document.querySelector('+JSON.stringify(attachmentSelector)+').querySelector("img").naturalHeight'),fixture.height);
  const foreground=object(await ui.eval(networkExpression));assert.equal(foreground.networkReady,true);assert.equal(foreground.selfId,beforeBackground.selfId);assert.equal(networkClosures.length,closuresBefore,'Background transition must not close the room WebSocket');lifecycleChecks.push({stage:'foreground-restored',...foreground});
  if(await picker.eval("document.body.dataset.active==='true'"))await picker.eval("setTimeout(()=>document.getElementById('personalStickerPickerCloseBtn').click(),0)");
  await ready(ui,"document.getElementById('stickerPanel').hidden",'panel closed');
  await privateBackground('shared-private-background-after-native-restore-close');
  await ui.eval("document.getElementById('emojiPanelBtn').click()");await privateForeground(picker,'shared-private-foreground-after-background');
  await ready(picker,"[...document.querySelectorAll('#personalStickerPickerGrid img')].length===2 && [...document.querySelectorAll('#personalStickerPickerGrid img')].every(image=>image.naturalWidth>0)",'retained private items decode after native foreground restore');
  await picker.eval("setTimeout(()=>document.getElementById('personalStickerPickerCloseBtn').click(),0)");await ready(ui,"document.getElementById('stickerPanel').hidden",'restored panel closed');
  await privateBackground('shared-private-background-final-close');
  await ui.eval("window.deepscord.back()");const returned=await attach(workspaceUrl);await ready(returned,"document.getElementById('workspaceLoading')?.hidden===true",'workspace panel');
  await sample('workspace-panel-room-still-connected');
  await control('/release-room');await delay(10000);await sample('room-window-destroyed-10s');
  const result={round,temporary,app,executable,backendRoot:process.env.DEEPSCORD_TEST_SERVER_ROOT ?? root,privateMemoryDefinition:'Sum of Windows Process.PrivateMemorySize64 for this root PID and every descendant; private committed bytes, not RSS or working set. Separate backend excluded. Embedded client servers included.',instrumentation:'Same-version Electron runtime, dedicated main wrapper, immutable packaged app source; no fake media devices, forced GC, or global background throttling.',sharedForegroundCondition:'Both versions set only the actual private WebContentsView backgroundThrottling=false at each foreground activation and true at each tab handoff, panel close and native hide. Pane business state and caches unchanged. Package bytes unchanged; no screenshot warmup. This excludes the old native view visibility fault from claimed memory savings. Tab latency includes the same automation control overhead. Optimized product correctness is tested separately without this intervention.',workspaceNote:'back() opens workspace panel while room stays connected. release-room destroys the actual room BrowserWindow through wrapper; this diagnostic is not a UI room-exit acceptance.',switchLatencyMs:timings,sceneEvidence,lifecycleChecks,networkClosures,snapshots,clientLog,serverLog:backend.output()};
  fs.writeFileSync(path.join(output,'round-'+round+'.json'),JSON.stringify(result,null,2));return result;
 }catch(error){
  const application=await control('/metrics');
  const diagnostics=await Promise.allSettled(pages.map((page,index)=>Promise.race([(async()=>{const state=await page.eval("({url:location.href,active:document.body.dataset.active,ready:document.body.dataset.ready,visibilityState:document.visibilityState,viewport:{width:innerWidth,height:innerHeight},status:document.getElementById('personalStickerPickerStatus')?.textContent,busy:document.getElementById('personalStickerPicker')?.getAttribute('aria-busy'),grid:document.getElementById('personalStickerPickerGrid')?.getBoundingClientRect().toJSON(),cells:[...document.querySelectorAll('[data-testid=sticker-cell]')].map(cell=>({id:cell.id,rect:cell.getBoundingClientRect().toJSON(),failed:cell.classList.contains('load-failed')})),images:[...document.querySelectorAll('#personalStickerPickerGrid img')].map(image=>({src:image.getAttribute('src'),width:image.naturalWidth,complete:image.complete,rect:image.getBoundingClientRect().toJSON()}))})");await page.screenshot(path.join(output,'failure-'+index+'.png'));return state;})(),delay(2000).then(()=>({page:index,diagnosticTimeout:true}))])));
  fs.writeFileSync(path.join(output,'round-'+round+'-failure.json'),JSON.stringify({error:error instanceof Error?error.stack:String(error),temporary,data,application,sceneEvidence,lifecycleChecks,networkClosures,snapshots,diagnostics,clientLog,serverLog:backend.output()},null,2));throw error;
 }
 finally{for(const page of pages)page.close();if(child.exitCode===null)child.kill();await stop(backend);}
}
/** @type {JsonValue[]} */const results=[];
for(let round=1;round<=rounds;round++)results.push(await run(round));
/** @param {number[]} values @returns {number} */
function median(values){assert(values.length>0);const sorted=[...values].sort((left,right)=>left-right),index=Math.floor(sorted.length/2);return sorted.length%2===0?(sorted[index-1]+sorted[index])/2:sorted[index];}
/** @param {JsonValue|undefined} value @returns {number} */
function number(value){assert.equal(typeof value,'number');assert(Number.isFinite(value));return Number(value);}
/** @param {JsonValue|undefined} value @returns {JsonValue[]} */
function array(value){assert(Array.isArray(value));return value;}
/** @param {{[key:string]:JsonValue}} snapshot @param {string} metric @returns {number} */
function heap(snapshot,metric){return array(snapshot.renderers).map(object).reduce((total,renderer)=>total+array(renderer.metrics).map(object).filter(row=>row.name===metric).reduce((sum,row)=>sum+number(row.value),0),0);}
/** @param {{[key:string]:JsonValue}} snapshot @param {string} metric @returns {number} */
function dom(snapshot,metric){return array(snapshot.renderers).map(object).reduce((total,renderer)=>total+number(object(renderer.dom)[metric]),0);}
const stages=[...new Set(results.flatMap(result=>array(object(result).snapshots).map(object).map(snapshot=>string(snapshot.stage))))];
const summary=stages.map(stage=>{
 const observations=results.flatMap(result=>array(object(result).snapshots).map(object)).filter(snapshot=>snapshot.stage===stage);
 const commits=observations.map(snapshot=>number(snapshot.privateCommittedBytes));
 return {stage,observations:observations.length,privateCommittedMiBMedian:median(commits)/1048576,privateCommittedMiBMin:Math.min(...commits)/1048576,privateCommittedMiBMax:Math.max(...commits)/1048576,processCountMedian:median(observations.map(snapshot=>number(snapshot.processCount))),popupWindowCountMedian:median(observations.map(snapshot=>array(object(snapshot.application).windows).map(object).filter(window=>string(window.url).endsWith('/poke-request.html')).length)),jsHeapUsedMiBMedian:median(observations.map(snapshot=>heap(snapshot,'JSHeapUsedSize')))/1048576,jsHeapTotalMiBMedian:median(observations.map(snapshot=>heap(snapshot,'JSHeapTotalSize')))/1048576,documentsMedian:median(observations.map(snapshot=>dom(snapshot,'documents'))),nodesMedian:median(observations.map(snapshot=>dom(snapshot,'nodes'))),listenersMedian:median(observations.map(snapshot=>dom(snapshot,'jsEventListeners'))),eventLoopRoundTripMedianMs:median(observations.flatMap(snapshot=>array(snapshot.renderers).map(object).map(renderer=>number(renderer.eventLoopRoundTripMs))))};
});
const switches=results.flatMap(result=>array(object(result).switchLatencyMs).map(number));
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({rounds,summary,switchLatencyMedianMs:median(switches),switchLatencyMaxMs:Math.max(...switches),results},null,2));
console.log('ARTIFACTS '+output);
