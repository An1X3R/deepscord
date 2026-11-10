// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {connectPage,waitForPort,sleep} from './cdp.mjs';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{directory:string,label:string}} PackageInput */
/** @typedef {{packageDirectory:string,baseline:string|null,report:string}} Arguments */
/** @typedef {{path:string,bytes:number,sha256:string}} PackageFile */
/** @typedef {{child:import('node:child_process').ChildProcess,exited:Promise<void>}} OwnedProcess */

/** @param {string[]} values @returns {Arguments} */
function parseArguments(values) {
  /** @type {Map<string,string>} */ const fields=new Map();
  for(let index=0;index<values.length;index+=2) {
    const name=values[index],value=values[index+1];
    if(!['--package','--baseline','--report'].includes(name) || !value || fields.has(name) || !path.isAbsolute(value)) throw new TypeError('Usage: node test/packaged-desktop.mjs --package <absolute-package-directory> [--baseline <absolute-package-directory>] --report <absolute-new-report.json>');
    fields.set(name,value);
  }
  const directory=fields.get('--package'),report=fields.get('--report'),baseline=fields.get('--baseline');
  if(!directory || !report) throw new TypeError('--package and --report are required');
  if(fs.existsSync(report)) throw new Error('Report already exists: '+report);
  const packageDirectory=fs.realpathSync(directory),previous=baseline===undefined ? null : fs.realpathSync(baseline);
  for(const candidate of [packageDirectory,...(previous ? [previous] : [])]) {
    const relative=path.relative(candidate,path.resolve(report));
    if(!relative || !relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative)) throw new TypeError('Report must be outside the immutable package directories');
  }
  return {packageDirectory,baseline:previous,report:path.resolve(report)};
}

/** @param {string} directory @returns {PackageFile[]} */
function inventory(directory) {
  /** @param {string} current @returns {PackageFile[]} */
  function walk(current) {
    return fs.readdirSync(current,{withFileTypes:true}).flatMap(entry=>{
      const filename=path.join(current,entry.name);
      if(entry.isSymbolicLink()) throw new TypeError('Package may not contain symbolic links: '+filename);
      if(entry.isDirectory()) return walk(filename);
      assert(entry.isFile());
      const bytes=fs.readFileSync(filename);
      return [{path:path.relative(directory,filename),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}];
    });
  }
  return walk(directory).sort((left,right)=>left.path.localeCompare(right.path,'en'));
}

/** @returns {Promise<number>} */
async function freePort() {
  const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert(address && typeof address==='object');
  server.close();await once(server,'close');return address.port;
}

/** @param {string} executable @param {string[]} args @param {string} directory @param {NodeJS.ProcessEnv} environment @param {string} log @returns {OwnedProcess} */
function launch(executable,args,directory,environment,log) {
  const handle=fs.openSync(log,'wx');
  try {
    const child=spawn(executable,args,{cwd:directory,env:environment,windowsHide:true,stdio:['ignore',handle,handle]});
    const exited=new Promise(/** @param {(value:void)=>void} resolve @param {(error:Error)=>void} reject */ (resolve,reject)=>{
      child.once('error',reject);child.once('exit',()=>resolve());
    });
    return {child,exited};
  } finally {fs.closeSync(handle);}
}

/** @param {OwnedProcess} owned @returns {Promise<void>} */
async function stop(owned) {
  if(owned.child.exitCode!==null || owned.child.signalCode!==null) return;
  owned.child.kill();
  await Promise.race([owned.exited,sleep(10000).then(()=>{if(owned.child.exitCode===null && owned.child.signalCode===null) throw new Error('Owned process did not stop: '+owned.child.pid);})]);
}

/** @param {string} origin @param {OwnedProcess} backend @returns {Promise<void>} */
async function waitBackend(origin,backend) {
  const deadline=Date.now()+15000;
  while(Date.now()<deadline) {
    assert(backend.child.exitCode===null && backend.child.signalCode===null,'Packaged backend exited during startup');
    try {if((await fetch(origin+'/api/health',{signal:AbortSignal.timeout(1000)})).ok) return;}
    catch(error) {if(!(error instanceof TypeError)) throw error;}
    await sleep(100);
  }
  throw new Error('Packaged backend did not become healthy');
}

/** @param {string} directory @returns {Promise<void>} */
async function waitRoomSaved(directory) {
  const deadline=Date.now()+12000;
  while(Date.now()<deadline) {
    const filename=path.join(directory,'workspace.json');
    if(fs.existsSync(filename)) {
      /** @type {JsonValue} */ const value=JSON.parse(fs.readFileSync(filename,'utf8'));
      if(value && typeof value==='object' && !Array.isArray(value) && Array.isArray(value.entries) && value.entries.some(entry=>entry && typeof entry==='object' && !Array.isArray(entry) && entry.document!==null && entry.governance!==null)) return;
    }
    await sleep(50);
  }
  throw new Error('Packaged client did not save a validated room and governance journal');
}

/** @param {PackageInput} input @param {number} trial @param {string} temporary */
async function measureTrial(input,trial,temporary) {
  const directory=path.join(temporary,input.label+'-'+trial),data=path.join(directory,'client'),serverData=path.join(directory,'server');
  fs.mkdirSync(data,{recursive:true});fs.mkdirSync(serverData);
  fs.writeFileSync(path.join(data,'desktop-settings.json'),JSON.stringify({muteShortcut:'Control+Alt+Shift+F24',overlay:{enabled:false,locked:true,x:24,y:80,width:280,height:300,scale:1}}));
  const executable=path.join(input.directory,'Deepscord.exe'),app=path.join(input.directory,'resources','app'),backendPort=await freePort(),debugPort=await freePort(),origin=`http://127.0.0.1:${backendPort}`;
  const inherited=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^(?:PORT|HTTP_|HTTPS_|ECHO_|STUN_|TURN_|ELECTRON_RUN_AS_NODE|DEEPSCORD_USER_DATA)/.test(name)));
  const backend=launch(executable,[path.join(app,'app-server','server.js')],directory,{...inherited,ELECTRON_RUN_AS_NODE:'1',PORT:String(backendPort),HTTP_HOST:'127.0.0.1',HTTPS_PORTS:'0',ECHO_DATA_DIR:serverData,ECHO_NETWORK_MODE:'server',ECHO_MEDIA_POLICY:'direct',STUN_URLS:''},path.join(directory,'backend.log'));
  /** @type {OwnedProcess|null} */ let client=null;
  /** @type {Awaited<ReturnType<typeof connectPage>>[]} */ const pages=[];
  try {
    await waitBackend(origin,backend);
    const started=performance.now();
    client=launch(executable,[`--remote-debugging-port=${debugPort}`,'--remote-debugging-address=127.0.0.1'],directory,{...inherited,DEEPSCORD_USER_DATA:data},path.join(directory,'client.log'));
    await waitForPort(debugPort,15000);
    const workspace=await connectPage(debugPort,pathToFileURL(path.join(app,'workspace.html')).href);pages.push(workspace);
    await workspace.waitFor('!!document.getElementById("savedRoomList") && document.getElementById("workspaceLoading").hidden',{timeout:10000,interval:50,label:'packaged workspace'});
    const workspaceReadyMs=performance.now()-started;
    await workspace.eval('document.getElementById("workspaceAddBtn").click()',{awaitPromise:false,userGesture:true});
    const connections=await connectPage(debugPort,pathToFileURL(path.join(app,'connections.html')).href);pages.push(connections);
    await connections.waitFor('!!document.getElementById("chooseJoinBtn") && !document.getElementById("connectionChoice").hidden',{timeout:10000,interval:50,label:'connection panel'});
    await connections.eval('document.getElementById("chooseJoinBtn").click();document.getElementById("serverMethodBtn").click()',{awaitPromise:false,userGesture:true});
    const joinStarted=performance.now();
    await connections.eval(`document.getElementById('serverUrl').value=${JSON.stringify(origin)};document.getElementById('serverConnectBtn').click()`,{awaitPromise:false,userGesture:true});
    const room=await connectPage(debugPort,origin);pages.push(room);
    await room.waitFor('!!document.getElementById("welcomeNameInput")',{timeout:10000,interval:50,label:'packaged profile'});
    await room.eval('document.getElementById("welcomeNameInput").value="Package trial";document.getElementById("welcomeEnterBtn").click()',{awaitPromise:false,userGesture:true});
    await waitRoomSaved(data);
    await room.waitFor('document.getElementById("channelScroll").children.length>0',{timeout:10000,interval:50,label:'packaged channels'});
    const roomReadyMs=performance.now()-started,joinToRoomMs=performance.now()-joinStarted;
    await room.send('Performance.enable',{});
    await sleep(1000);
    /** @type {{metrics:{name:string,value:number}[]}} */ const metrics=await room.send('Performance.getMetrics',{});
    const metricValues=Object.fromEntries(metrics.metrics.filter(metric=>['JSHeapUsedSize','JSHeapTotalSize','Nodes','Documents','LayoutCount','TaskDuration'].includes(metric.name)).map(metric=>[metric.name,metric.value]));
    const resources=await room.eval('performance.getEntriesByType("resource").map(entry=>({name:entry.name,duration:entry.duration,transferSize:entry.transferSize,encodedBodySize:entry.encodedBodySize,decodedBodySize:entry.decodedBodySize,initiatorType:entry.initiatorType}))',{awaitPromise:true,userGesture:false});
    const noLiveKitLoaded=await room.eval('!performance.getEntriesByType("resource").some(entry=>/livekit/i.test(entry.name))',{awaitPromise:true,userGesture:false});
    const domElements=await room.eval('document.getElementsByTagName("*").length',{awaitPromise:true,userGesture:false});
    const capture=await room.eval(`(async()=>{const api=window.deepscord,sources=await api.listCaptureSources(),source=sources.find(item=>item.kind==='screen');if(!source)throw new Error('No actual display source enumerated');await api.selectCaptureSource(source.id);const stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});const track=stream.getVideoTracks()[0];if(!track || track.readyState!=='live')throw new Error('Display track did not start');const settings=track.getSettings();stream.getTracks().forEach(item=>item.stop());if(track.readyState!=='ended')throw new Error('Display track did not stop');const processes=await api.listAudioProcesses();return{sources:sources.length,displayStarted:true,displayStopped:true,width:settings.width,height:settings.height,packagedAudioHelperEnumeratedProcesses:processes.length};})()`,{awaitPromise:true,userGesture:true});
    const settings=await room.eval('(async()=>{const api=window.deepscord,original=await api.getDesktopSettings();await api.setDesktopSettings({...original,overlay:{...original.overlay,enabled:true}});const saved=await api.getDesktopSettings();await api.setDesktopSettings(original);if(!saved.overlay.enabled)throw new Error("Overlay setting was not saved");return {overlaySettingsRoundtrip:true,shortcut:await api.getShortcutStatus()};})()',{awaitPromise:true,userGesture:true});
    await room.eval('document.querySelector("[data-self-action=settings]").click()',{awaitPromise:false,userGesture:true});
    await room.waitFor('!!document.getElementById("audioSettingsDone")',{timeout:10000,interval:50,label:'packaged settings popup'});
    await room.eval('document.getElementById("audioSettingsDone").click()',{awaitPromise:false,userGesture:true});
    await room.eval('document.getElementById("serverMenuBtn").click()',{awaitPromise:false,userGesture:true});
    await room.waitFor('!!document.getElementById("serverGovernanceMenuBtn")',{timeout:10000,interval:50,label:'governance menu'});
    await room.eval('document.getElementById("serverGovernanceMenuBtn").click()',{awaitPromise:false,userGesture:true});
    await room.waitFor('!!document.getElementById("ownerClaimToken")',{timeout:10000,interval:50,label:'desktop identity and owner claim'});
    const token=fs.readFileSync(path.join(serverData,'owner-claim.txt'),'utf8').trim();
    await room.eval(`document.getElementById('ownerClaimToken').value=${JSON.stringify(token)};document.getElementById('claimOwnerBtn').click()`,{awaitPromise:false,userGesture:true});
    await room.waitFor('!document.getElementById("ownerClaimToken")',{timeout:10000,interval:50,label:'signed owner claim'});
    await room.eval('document.getElementById("serverMenuBtn").click();document.getElementById("serverGovernanceMenuBtn").click()',{awaitPromise:false,userGesture:true});
    await room.waitFor('!!document.getElementById("renameConnectionServerBtn")',{timeout:10000,interval:50,label:'owner controls'});
    const controls=await room.eval('({serverOwner:true,domainControls:!!document.getElementById("governanceMemberSelect"),settingsPopup:true})',{awaitPromise:true,userGesture:false});
    await room.eval('void window.deepscord.quit()',{awaitPromise:false,userGesture:true});
    await Promise.race([client.exited,sleep(10000).then(()=>{if(client?.child.exitCode===null)throw new Error('Packaged client did not quit cleanly');})]);
    return {trial,workspaceReadyMs,roomReadyMs,joinToRoomMs,metrics:metricValues,domElements,noLiveKitLoaded,resources,capture,settings,controls,coldBrowserProfile:true,physicalMicrophoneUsed:false};
  } finally {
    for(const page of pages) page.close();
    if(client) await stop(client);
    await stop(backend);
  }
}

/** @param {PackageInput} input @param {string} temporary */
async function measurePackage(input,temporary) {
  const before=inventory(input.directory),trials=[];
  for(const trial of [1,2,3]) trials.push(await measureTrial(input,trial,temporary));
  assert.deepEqual(inventory(input.directory),before,'Packaged resources changed during acceptance');
  return {label:input.label,directory:input.directory,bytes:before.reduce((sum,file)=>sum+file.bytes,0),fileCount:before.length,unchangedHashes:true,trials};
}

const input=parseArguments(process.argv.slice(2));
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-packaged-'));
/** @type {Awaited<ReturnType<typeof measurePackage>>[]} */ const results=[];
let failure=null;
try {
  if(input.baseline) results.push(await measurePackage({directory:input.baseline,label:'baseline'},temporary));
  results.push(await measurePackage({directory:input.packageDirectory,label:'candidate'},temporary));
} catch(error) {failure=error instanceof Error ? error.stack : String(error);}
fs.mkdirSync(path.dirname(input.report),{recursive:true});
fs.writeFileSync(input.report,JSON.stringify({passed:failure===null,scope:'Unchanged installed package, real packaged backend, desktop bridge, real display capture; no physical microphone, native Steam SDK initialization, multi-client media or throughput claim',temporaryDirectory:temporary,osFileCacheControlled:false,results,failure},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({event:'packaged_desktop_acceptance_complete',passed:failure===null,report:input.report,packages:results.length}));
if(failure!==null) throw new Error(failure);
