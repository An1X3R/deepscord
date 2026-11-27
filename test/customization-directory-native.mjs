// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {connectPage,waitForPort} from './cdp.mjs';
import {parseInterfaceScheme} from '../public/js/interface-scheme.js';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {Awaited<ReturnType<typeof connectPage>>} Page */
const root=fileURLToPath(new URL('../',import.meta.url));
const packageDirectory=path.resolve(root,process.env.DEEPSCORD_ACCEPTANCE_PACKAGE??'dist/customization-library-20261108-01/Deepscord-win32-x64');
const app=path.join(packageDirectory,'resources/app'),server=path.join(app,'app-server');
assert(fs.existsSync(path.join(packageDirectory,'../manifest.json')),'Final package manifest must exist');
const output=fs.mkdtempSync(path.join(root,'.qa-tools/results/customization-directory-native-'));
const profile=path.join(output,'profile');fs.mkdirSync(profile);
/** @type {Record<string,string>} */ const logs={};
/** @type {string[]} */ const checks=[];
/** @type {JsonValue[]} */ const exceptions=[];
/** @type {JsonValue[]} */ const observations=[];
/** @type {import('node:child_process').ChildProcess[]} */ const children=[];
/** @type {Page[]} */ const pages=[];
/** @param {string} name @param {boolean} condition @returns {void} */
function check(name,condition){assert(condition,name);checks.push(name);}
/** @param {number} milliseconds @returns {Promise<void>} */
function delay(milliseconds){return new Promise(resolve=>setTimeout(resolve,milliseconds));}
/** @param {string} directory @returns {Record<string,string>} */
function manifest(directory){return Object.fromEntries(fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{const filename=path.join(directory,entry.name);assert(!entry.isSymbolicLink());return entry.isDirectory()?Object.entries(manifest(filename)).map(([name,hash])=>[path.join(entry.name,name),hash]):[[entry.name,createHash('sha256').update(fs.readFileSync(filename)).digest('hex')]];}));}
/** @returns {Promise<number>} */
async function freePort(){const listener=net.createServer();await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',()=>resolve(undefined));});const address=listener.address();assert(address&&typeof address!=='string');await new Promise((resolve,reject)=>listener.close(error=>error?reject(error):resolve(undefined)));return address.port;}
/** @param {string} name @param {string} executable @param {string[]} args @param {string} cwd @param {NodeJS.ProcessEnv} env */
function launch(name,executable,args,cwd,env){const child=spawn(executable,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});logs[name]='';child.stdout?.on('data',part=>{logs[name]+=String(part);});child.stderr?.on('data',part=>{logs[name]+=String(part);});children.push(child);return child;}
/** @param {import('node:child_process').ChildProcess} child @returns {Promise<void>} */
async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned client failed to exit: '+child.pid)),10000);child.once('exit',()=>{clearTimeout(timer);resolve(undefined);});child.once('error',error=>{clearTimeout(timer);reject(error);});assert(child.kill());});}
/** @param {'inspect'|'capture'|'close'} mode @returns {JsonValue} */
function explorer(mode){return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'test/customization-directory-explorer.ps1'),'-ProfileDirectory',profile,'-Mode',mode,'-OutputDirectory',output],{encoding:'utf8',windowsHide:true,timeout:15000}));}
/** @param {number} debug @param {string} origin @returns {Promise<Page>} */
async function attach(debug,origin){
  await waitForPort(debug,20000);
  const workspace=await connectPage(debug,pathToFileURL(path.join(app,'workspace.html')).href);
  await workspace.waitFor("!!document.getElementById('savedRoomList')",{timeout:10000,interval:100,label:'native workspace'});
  await workspace.eval(`void window.deepscord.connect(${JSON.stringify(origin)})`,{awaitPromise:false,userGesture:true});workspace.close();
  return attachRoom(debug);
}
/** @param {number} debug @returns {Promise<Page>} */
async function attachRoom(debug){
  await waitForPort(debug,20000);
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){
    /** @type {{type:string,url:string}[]} */ const targets=await fetch('http://127.0.0.1:'+debug+'/json/list').then(response=>response.json());
    const target=targets.find(row=>row.type==='page'&&row.url.startsWith('http://127.0.0.1:'));
    if(target){const page=await connectPage(debug,target.url);pages.push(page);await page.send('Runtime.enable',{});page.on('Runtime.exceptionThrown',/** @param {JsonValue} event */event=>exceptions.push(event));return page;}
    await delay(100);
  }
  throw new Error('Native room page failed to appear');
}
/** @param {Page} page @param {string} id @returns {Promise<void>} */
async function click(page,id){await page.eval(`(()=>{const node=document.getElementById(${JSON.stringify(id)});if(!node)throw new Error('Missing stable ID: '+${JSON.stringify(id)});node.click();})()`);}
/** @param {Page} page @returns {Promise<void>} */
async function openPanel(page){await page.eval('window.echo.actions.openSettings()');await click(page,'themeCustomizationMenuBtn');await page.waitFor("!!document.getElementById('customizationInterfacePreset')&&!document.getElementById('customizationThemeSave').disabled",{timeout:7000,interval:50,label:'native scheme panel'});}
/** @param {Page} page @returns {Promise<JsonValue>} */
async function communication(page){return page.eval('(()=>{const s=window.echo.getState();return {selfId:s.selfId,selfKey:s.selfKey,activeServerId:s.activeServerId,activeChannelId:s.activeChannelId,servers:s.servers.map(server=>({id:server.id,channels:server.channels.map(channel=>({id:channel.id,type:channel.type}))})),roomReady:s.roomReady,connStatus:s.connStatus};})()');}
const before=manifest(packageDirectory);fs.writeFileSync(path.join(output,'package-before.json'),JSON.stringify(before,null,2));
let passed=false;
/** @type {ReturnType<typeof setTimeout>|null} */let timer=null;
try{
 await Promise.race([(async()=>{
  const port=await freePort(),origin='http://127.0.0.1:'+port+'/';
  launch('server',process.execPath,[path.join(server,'server.js')],server,{...process.env,PORT:String(port),HTTP_HOST:'127.0.0.1',HTTPS_PORTS:'0',ECHO_DATA_DIR:path.join(output,'server-data'),ECHO_MEDIA_POLICY:'direct',ECHO_NETWORK_MODE:'server',ECHO_PASSWORD:''});
  const deadline=Date.now()+12000;let ready=false;
  while(Date.now()<deadline){try{ready=(await fetch(origin+'api/health')).ok;}catch(error){if(!(error instanceof TypeError))throw error;console.warn('native_backend_pending',{message:error.message});}if(ready)break;await delay(100);}assert(ready,logs.server);
  fs.writeFileSync(path.join(profile,'config.json'),JSON.stringify({autoConnect:false}));
  fs.writeFileSync(path.join(profile,'desktop-settings.json'),JSON.stringify({muteShortcut:'Control+Alt+Shift+F24',overlay:{enabled:false,locked:true,x:24,y:80,width:280,height:300,scale:1}}));
  /** @type {NodeJS.ProcessEnv} */const environment={...process.env,DEEPSCORD_USER_DATA:profile};delete environment.ELECTRON_RUN_AS_NODE;
  const debug=await freePort();let client=launch('client',path.join(packageDirectory,'Deepscord.exe'),['--remote-debugging-port='+debug,'--mute-audio','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'],packageDirectory,environment);
  let page=await attach(debug,origin);
  await page.waitFor("!!document.getElementById('welcomeNameInput')",{timeout:12000,interval:100,label:'native welcome'});
  await page.eval("document.getElementById('welcomeNameInput').value='Directory acceptance';document.getElementById('welcomeEnterBtn').click()");
  await page.waitFor("window.echo?.getState().roomReady===true&&!!window.echo.getState().selfKey",{timeout:15000,interval:100,label:'real backend connected identity'});
  const connection=await communication(page);observations.push({connection});
  await click(page,'railSettingsBtn');await page.waitFor("!!document.getElementById('developerGuide-interfaces')",{timeout:5000,interval:50,label:'settings native directory links'});
  for(const kind of ['interfaces','interactions']){
    await click(page,'developerGuide-'+kind);
    const directory=path.join(profile,'customization',kind),guide=path.join(directory,'DEVELOPMENT.md');
    const deadline=Date.now()+10000;let found=false;
    while(Date.now()<deadline){const windows=explorer('inspect');assert(Array.isArray(windows));found=windows.some(row=>row!==null&&typeof row==='object'&&!Array.isArray(row)&&typeof row.path==='string'&&path.normalize(row.path).toLowerCase()===directory.toLowerCase());if(found)break;await delay(100);}
    check('actual-explorer-target-'+kind,found);
    observations.push({directoryKind:kind,explorer:explorer('capture')});
    check('latest-guide-byte-identical-'+kind,fs.readFileSync(guide).equals(fs.readFileSync(path.join(server,'public/customization',kind,'DEVELOPMENT.md'))));
    check('no-legacy-guide-modal-'+kind,await page.eval("!document.getElementById('developerGuideContent')&&!!document.getElementById('softwareSettingsDone')"));
  }
  await page.eval("document.getElementById('developerGuide-interfaces').scrollIntoView({block:'center',behavior:'instant'})");
  await page.screenshot(path.join(output,'settings-directory-links.png'));
  assert.deepEqual(await communication(page),connection,'Directory guide actions must preserve communication state');checks.push('guide-actions-preserve-communication');
  await click(page,'softwareSettingsDone');await openPanel(page);
  observations.push({closedSettingsExplorerWindows:explorer('close')});
  await click(page,'customizationInterfacePreset');await click(page,'customizationSchemeDirectory');
  await page.waitFor("document.getElementById('customizationSchemeStatus')?.dataset.state==='saved'",{timeout:5000,interval:50,label:'scheme plus opens directory'});
  const schemeWindows=explorer('inspect');assert(Array.isArray(schemeWindows));
  check('scheme-plus-opens-actual-directory',schemeWindows.some(row=>row!==null&&typeof row==='object'&&!Array.isArray(row)&&typeof row.path==='string'&&path.normalize(row.path).toLowerCase()===path.join(profile,'customization/interfaces').toLowerCase()));
  const source=JSON.parse(fs.readFileSync(path.join(server,'public/customization/interfaces/industrial.json'),'utf8'));
  const custom=parseInterfaceScheme({...source,id:'native-acceptance',name:'Native directory acceptance',description:'Real directory import with select, range and toggle options.',options:[
    {id:'spacing',label:'Spacing',type:'range',default:12,min:8,max:24,step:1,unit:'px',cssVariable:'--scheme-content-spacing'},
    {id:'title',label:'Title scale',type:'select',default:'normal',choices:[{value:'normal',label:'Normal',cssValue:'1'},{value:'large',label:'Large',cssValue:'1.3'}],cssVariable:'--scheme-title-scale'},
    {id:'marks',label:'Marks',type:'toggle',default:false,on:'1',off:'0',cssVariable:'--scheme-marks'}]});
  await page.send('Emulation.setFocusEmulationEnabled',{enabled:false});
  fs.writeFileSync(path.join(profile,'customization/interfaces/native-acceptance.json'),JSON.stringify(custom,null,2));
  await page.send('Page.bringToFront',{});await page.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await page.waitFor("!!document.querySelector('#customizationInterfacePresetList [data-value=\"native-acceptance\"]')",{timeout:10000,interval:100,label:'focus refresh sees new native file'});
  await click(page,'customizationInterfacePreset');
  const selectionId=await page.eval("document.querySelector('#customizationInterfacePresetList [data-value=\"native-acceptance\"]').id");assert.equal(typeof selectionId,'string');await click(page,selectionId);
  await page.eval("(()=>{const range=document.getElementById('customizationSchemeOption-spacing');range.value='21';range.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await click(page,'customizationSchemeOption-title');await click(page,'customizationSchemeOption-titleOption-1');await click(page,'customizationSchemeOption-marks');
  const expected="getComputedStyle(document.documentElement).getPropertyValue('--scheme-content-spacing').trim()==='21px'&&getComputedStyle(document.documentElement).getPropertyValue('--scheme-title-scale').trim()==='1.3'&&getComputedStyle(document.querySelector('.stage-grid')).gap==='21px'&&getComputedStyle(document.querySelector('.stage-title')).fontSize==='28.6px'";
  await page.waitFor(expected,{timeout:5000,interval:50,label:'select and range change actual CSS consumers'});
  await click(page,'customizationThemeSave');await page.waitFor("document.getElementById('customizationSchemeStatus')?.dataset.state==='saved'",{timeout:7000,interval:50,label:'native preferences saved'});
  const persisted=JSON.parse(fs.readFileSync(path.join(profile,'client-preferences.json'),'utf8'));
  assert.deepEqual(persisted.settings.interfaceSelection,{scheme:custom,values:{spacing:21,title:'large',marks:true}});checks.push('new-directory-scheme-select-range-toggle-persisted');
  assert.deepEqual(await communication(page),connection,'Scheme UI must preserve communication state');checks.push('scheme-ui-preserves-communication');
  await page.screenshot(path.join(output,'custom-scheme-saved.png'));await click(page,'customizationClose');
  page.close();await stop(client);
  const restartDebug=await freePort();client=launch('client-restart',path.join(packageDirectory,'Deepscord.exe'),['--remote-debugging-port='+restartDebug,'--mute-audio'],packageDirectory,environment);
  page=await attachRoom(restartDebug);
  await page.waitFor("window.echo?.getState().roomReady===true&&!!window.echo.getState().selfKey",{timeout:15000,interval:100,label:'native restart reconnects'});
  await page.waitFor(expected,{timeout:5000,interval:50,label:'native restart restores saved scheme variables and computed layout'});
  await openPanel(page);
  check('native-restart-controls-restored',await page.eval("document.getElementById('customizationSchemeOption-spacing').value==='21'&&document.querySelector('#customizationSchemeOption-titleList [aria-selected=true]').dataset.value==='large'&&document.getElementById('customizationSchemeOption-marks').checked"));
  const afterRestart=await communication(page);observations.push({afterRestart});
  const original=/** @type {{selfKey:JsonValue,servers:JsonValue}} */(connection),restarted=/** @type {{selfKey:JsonValue,servers:JsonValue}} */(afterRestart);
  assert.deepEqual(restarted.servers,original.servers);assert.equal(restarted.selfKey,original.selfKey);checks.push('restart-preserves-server-channel-structure-and-identity');
  await page.screenshot(path.join(output,'custom-scheme-restarted.png'));
  check('no-renderer-exceptions',exceptions.length===0);passed=true;
 })(),new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Native directory acceptance exceeded 120 seconds')),120000);})]);
}catch(error){
 fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:error instanceof Error?{message:error.message,stack:error.stack}:String(error),logs,exceptions},null,2));
 for(const [index,page] of pages.entries()){
  if(page.ws.readyState!==WebSocket.OPEN)continue;
  let screenshotTimer;
  try{await Promise.race([page.screenshot(path.join(output,'failure-'+index+'.png')),new Promise((resolve,reject)=>{screenshotTimer=setTimeout(()=>reject(new Error('Failure screenshot timed out')),5000);})]);}
  catch(diagnostic){console.error('native_directory_diagnostic_failed',{message:String(diagnostic)});}
  finally{clearTimeout(screenshotTimer);}
 }
 throw error;
}finally{
 if(timer)clearTimeout(timer);for(const page of pages)page.close();for(const child of children.reverse())await stop(child);
 observations.push({closedOwnedExplorerWindows:explorer('close')});
 const after=manifest(packageDirectory);fs.writeFileSync(path.join(output,'package-after.json'),JSON.stringify(after,null,2));assert.deepEqual(after,before,'Packaged app changed during acceptance');
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed,packageDirectory,profile,checks,observations,exceptions,logs,packageImmutable:true,packageFilesChecked:Object.keys(before).length,realBackend:true,realNativeClient:true,realExplorer:true,microphoneTested:false},null,2));
}
console.log(JSON.stringify({passed,output,checks}));
