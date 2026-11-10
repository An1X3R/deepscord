// @ts-check
'use strict';
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const target=process.env.DEEPSCORD_MEMORY_APP;assert(target,'DEEPSCORD_MEMORY_APP must identify the packaged resources/app directory');const production=fs.realpathSync(target),frontend=fs.realpathSync(path.join(production,'app-server'));
/** @type {typeof import('../desktop/capture-ipc.cjs')} */const capture=require(path.join(production,'capture-ipc.cjs'));
const inputDirectory=process.env.DEEPSCORD_MEMORY_MEDIA_DATA;assert(inputDirectory);const directory=fs.realpathSync(inputDirectory);app.setPath('userData',path.join(directory,'profile'));
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
/** @type {Electron.BrowserWindow[]} */const windows=[];
/** @type {http.Server|null} */let server=null;let exitCode=0;
/** @param {number} milliseconds @returns {Promise<void>} */function delay(milliseconds){return new Promise(resolve=>setTimeout(resolve,milliseconds));}
/** @template T @param {Electron.BrowserWindow} window @param {string} expression @returns {Promise<T>} */
function evaluate(window,expression){return window.webContents.executeJavaScript(expression,true);}
/** @param {Electron.BrowserWindow} window @returns {Promise<import('./memory-media-regression-page.js').MediaSnapshot>} */
function readStats(window){return evaluate(window,'window.memoryMediaRegression.stats()');}
/** @param {string} label @param {()=>Promise<boolean>} probe @returns {Promise<void>} */
async function until(label,probe){const deadline=Date.now()+20000;while(Date.now()<deadline){if(await probe())return;await delay(80);}throw new Error('Media regression timed out: '+label);}
/** @returns {number} */
function helpers(){return Number(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"@(Get-CimInstance Win32_Process -Filter \"Name='process-audio.exe'\" | Where-Object { $_.ParentProcessId -eq "+process.pid+" }).Count"],{encoding:'utf8',windowsHide:true}).trim());}
/** @param {'voice-only'|'voice-with-window-share'} stage @returns {Promise<void>} */
async function sampleStage(stage){await delay(1500);const request=path.join(directory,'stage-'+stage+'.json'),response=path.join(directory,'samples-'+stage+'.json');fs.writeFileSync(request,JSON.stringify({stage,pid:process.pid}));await until('external root-tree memory sampling '+stage,async()=>fs.existsSync(response));}
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  server=http.createServer((request,response)=>{void (async()=>{
    const pathname=new URL(request.url ?? '/','http://localhost').pathname;
    if(pathname==='/'){response.writeHead(200,{'content-type':'text/html'});response.end('<!doctype html><title>Memory media regression</title><body><script type="module" src="/test/memory-media-regression-page.js"></script></body>');return;}
    const base=pathname.startsWith('/public/')?frontend:root;const filename=path.resolve(base,'.'+pathname);assert(filename.startsWith(base+path.sep));response.writeHead(200,{'content-type':'text/javascript'});response.end(await fs.promises.readFile(filename));
  })().catch(error=>{response.writeHead(500);response.end(String(error));});});
  const listener=server;await new Promise(resolve=>listener.listen(0,'127.0.0.1',()=>resolve(undefined)));const address=server.address();assert(address && typeof address!=='string');
  for(const side of ['a','b']){const win=new BrowserWindow({show:true,width:600,height:400,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,preload:side==='a'?path.join(production,'preload.js'):undefined,partition:'memory-media-'+side}});windows.push(win);await win.loadURL('http://127.0.0.1:'+address.port+'/?side='+side);await until('module initialization',()=>evaluate(win,'!!window.memoryMediaRegression'));await evaluate(win,'window.memoryMediaRegression.start('+JSON.stringify(side)+')');}
  const [sender,receiver]=windows;capture.registerCaptureIpc({getWindow:()=>sender});capture.configureCaptureSession(sender.webContents.session);
  /** @returns {Promise<void>} */async function pump(){for(let index=0;index<2;index++){/** @type {import('../public/js/network-protocol.js').PeerSignal[]} */const packets=await evaluate(windows[index],'window.memoryMediaRegression.takeSignals()');for(const packet of packets)await evaluate(windows[1-index],'window.memoryMediaRegression.receive('+JSON.stringify(packet)+')');}}
  await until('real PeerLink handshake',async()=>{await pump();const snapshots=await Promise.all(windows.map(win=>readStats(win)));for(const entry of snapshots)assert.deepEqual(entry.errors,[]);return snapshots.every(entry=>entry.state==='connected');});
  await until('non-silent voice before screen sharing',async()=>{await pump();const state=await readStats(receiver);assert.deepEqual(state.errors,[]);return state.amplitudes.some(entry=>entry.kind==='microphone' && entry.rms>0.0001) && state.inbound.some(entry=>entry.kind==='audio' && entry.samples>0.5);});
  await sampleStage('voice-only');
  /** @type {import('../public/js/desktop-capture.js').ScreenSource[]} */const sources=await evaluate(sender,'window.memoryMediaRegression.listScreenSources()');const source=sources.find(entry=>entry.kind==='window' && entry.name==='Deepscord capture acceptance window');assert(source,'Controlled capture window must exist');
  /** @type {import('../public/js/desktop-capture.js').ProcessSource[]} */const processes=await evaluate(sender,'window.memoryMediaRegression.listAudioProcesses()');const pid=Number(process.env.DEEPSCORD_MEMORY_MEDIA_TONE_PID);assert(processes.some(entry=>entry.pid===pid));
  await evaluate(sender,'window.memoryMediaRegression.share('+pid+','+JSON.stringify(source.id)+')');assert.equal(helpers(),1);
  await until('real received microphone/accompaniment/window frames',async()=>{await pump();const state=await readStats(receiver);fs.writeFileSync(path.join(directory,'receiving.json'),JSON.stringify(state,null,2));assert.deepEqual(state.errors,[]);return state.amplitudes.filter(entry=>entry.rms>0.0001).length===2 && state.inbound.some(entry=>entry.kind==='video' && entry.frames>5);});
  await sampleStage('voice-with-window-share');
  /** @type {number[]} */const pixel=await evaluate(receiver,'window.memoryMediaRegression.videoPixel()');assert(Math.min(Math.abs(pixel[0]-216)+Math.abs(pixel[1]-36)+Math.abs(pixel[2]-49),Math.abs(pixel[0]-36)+Math.abs(pixel[1]-89)+Math.abs(pixel[2]-216))<70,'Remote decoded pixels must match the controlled window');
  const visible=await Promise.all(windows.map(win=>readStats(win)));
  for(const win of windows)win.hide();assert(windows.every(win=>!win.isVisible()),'Both real native windows must be hidden');
  const hiddenStart=await Promise.all(windows.map(win=>readStats(win)));await delay(4000);const hiddenEnd=await Promise.all(windows.map(win=>readStats(win)));
  const before=hiddenStart[1].inbound,after=hiddenEnd[1].inbound;assert.equal(after.length,3);
  for(const entry of after){const previous=before.find(item=>item.id===entry.id);assert(previous);assert(entry.bytes>previous.bytes,'Hidden receiver RTP bytes must continue');if(entry.kind==='video')assert(entry.frames>previous.frames,'Hidden receiver decoded screen frames must continue');else assert(entry.samples>previous.samples,'Hidden receiver audio samples must continue');}
  assert.equal(hiddenEnd[1].amplitudes.filter(entry=>entry.rms>0.0001).length,2,'Both decoded audio signals must remain non-silent while hidden');
  for(const state of hiddenEnd){assert.equal(state.state,'connected');assert.equal(state.context,'running');assert.deepEqual(state.errors,[]);}
  sender.show();receiver.show();assert(windows.every(win=>win.isVisible()));
  /** @type {import('./memory-media-regression-page.js').StoppedSnapshot[]} */const stopped=await Promise.all(windows.map(win=>evaluate(win,'window.memoryMediaRegression.stop()')));for(const state of stopped){assert.equal(state.peer,'closed');assert.equal(state.context,'closed');assert(state.tracks.every(track=>track==='ended'));assert.deepEqual(state.errors,[]);}assert.equal(helpers(),0);
  const report={productionApp:production,productionFrontend:frontend,electron:process.versions.electron,pid:process.pid,passed:true,nativeWindowsHiddenVerified:true,scope:'Local real Windows window/process capture, WebAudio voice through MicrophoneGraph, production PeerLink; no microphone or cross-device Steam claim',source:source.name,remotePixel:pixel,visible,hiddenStart,hiddenEnd,stopped,helpersAfterStop:helpers()};fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,report:path.join(directory,'report.json')}));
}).catch(error=>{console.error(error instanceof Error ? error.stack : String(error));exitCode=1;}).finally(async()=>{await capture.stopAllCapture();for(const win of windows)if(!win.isDestroyed())win.destroy();if(server){const listener=server;listener.closeAllConnections();await new Promise(resolve=>listener.close(()=>resolve(undefined)));}app.exit(exitCode);});
