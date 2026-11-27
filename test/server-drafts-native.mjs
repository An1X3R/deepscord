// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {connectPage,waitForPort} from './cdp.mjs';
import governance from '../lib/server-governance.cjs';
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {Awaited<ReturnType<typeof connectPage>>} Page */
const root=fileURLToPath(new URL('../',import.meta.url));
const packageDirectory=process.env.DEEPSCORD_ACCEPTANCE_PACKAGE?path.resolve(root,process.env.DEEPSCORD_ACCEPTANCE_PACKAGE):null;
const app=packageDirectory?path.join(packageDirectory,'resources/app'):path.join(root,'desktop');
const server=packageDirectory?path.join(app,'app-server'):root;
const executable=packageDirectory?path.join(packageDirectory,'Deepscord.exe'):path.join(root,'node_modules/electron/dist/electron.exe');
const output=fs.mkdtempSync(path.join(root,'.qa-tools/results/server-drafts-native-')),profile=path.join(output,'profile');fs.mkdirSync(profile);
/** @type {import('node:child_process').ChildProcess[]} */const children=[];
/** @type {Page[]} */const pages=[];
/** @type {string[]} */const checks=[];
/** @type {JsonValue[]} */const exceptions=[];
/** @type {JsonValue[]} */const observations=[];
/** @type {Record<string,string>} */const logs={};
/** @param {string} directory @returns {Record<string,string>} */
function manifest(directory){return Object.fromEntries(fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{const filename=path.join(directory,entry.name);assert(!entry.isSymbolicLink(),'Acceptance package must not link to mutable source');return entry.isDirectory()?Object.entries(manifest(filename)).map(([name,hash])=>[path.join(entry.name,name),hash]):[[entry.name,createHash('sha256').update(fs.readFileSync(filename)).digest('hex')]];}));}
const packageBefore=packageDirectory?manifest(packageDirectory):null;
let passed=false;
let roomHandle=0,explorerHandle=0;
/** @param {number} handle @returns {void} */
function activate(handle){assert(Number.isSafeInteger(handle)&&handle>0);execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'test/server-drafts-focus.ps1'),'-WindowHandle',String(handle)],{windowsHide:true,timeout:15000});}
/** @param {number} milliseconds @returns {Promise<void>} */
function delay(milliseconds){return new Promise(resolve=>setTimeout(resolve,milliseconds));}
/** @param {string} name @param {boolean} condition @returns {void} */
function check(name,condition){assert(condition,name);checks.push(name);}
/** @returns {Promise<number>} */
async function freePort(){const listener=net.createServer();await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',()=>resolve(undefined));});const address=listener.address();assert(address&&typeof address!=='string');await new Promise((resolve,reject)=>listener.close(error=>error?reject(error):resolve(undefined)));return address.port;}
/** @param {string} name @param {string} binary @param {string[]} args @param {string} cwd @param {NodeJS.ProcessEnv} env @returns {import('node:child_process').ChildProcess} */
function launch(name,binary,args,cwd,env){const child=spawn(binary,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});logs[name]='';child.stdout?.on('data',part=>{logs[name]+=String(part);});child.stderr?.on('data',part=>{logs[name]+=String(part);});children.push(child);return child;}
/** @param {import('node:child_process').ChildProcess} child @returns {Promise<void>} */
async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned acceptance process failed to exit: '+child.pid)),10000);child.once('exit',()=>{clearTimeout(timer);resolve(undefined);});child.once('error',error=>{clearTimeout(timer);reject(error);});assert(child.kill());});}
/** @param {'inspect'|'capture'|'close'} mode @returns {JsonValue} */
function explorer(mode){return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'test/customization-directory-explorer.ps1'),'-ProfileDirectory',profile,'-Mode',mode,'-OutputDirectory',output],{encoding:'utf8',windowsHide:true,timeout:15000}));}
/** @param {Page} page @param {string} id @returns {Promise<void>} */
async function click(page,id){await page.eval(`(()=>{const node=document.getElementById(${JSON.stringify(id)});if(!(node instanceof HTMLElement))throw new Error('Missing stable ID: '+${JSON.stringify(id)});if(node.disabled)throw new Error('Disabled control: '+${JSON.stringify(id)});node.click();})()`,{userGesture:true});}
/** @param {Page} page @param {string} id @returns {Promise<void>} */
async function trustedClick(page,id){const point=await page.eval('(()=>{const node=document.getElementById('+JSON.stringify(id)+');if(!(node instanceof HTMLElement))throw new Error("Missing native theme action");node.scrollIntoView({block:"center",behavior:"instant"});const bounds=node.getBoundingClientRect();if(bounds.width<=0||bounds.height<=0)throw new Error("Native theme action is not visible");return{x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2};})()');await page.send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});}
/** @param {Page} page @returns {Promise<void>} */
async function mountedPackage(page){await page.waitFor("!!document.getElementById('theme-constructivist')&&document.querySelectorAll('[data-deepscord-slot]').length===7&&document.querySelectorAll('#deepscordThemeScript').length===1&&document.querySelectorAll('#deepscordThemeStyle').length===1",{timeout:10000,interval:50,label:'native full theme content and isolated frame mounted'});check('native-full-theme-seven-real-slots-mounted',await page.eval("(()=>{const slots={rail:'#serverRail',sidebar:'.sidebar',topbar:'.topbar',radio:'#radioStrip',content:'.content',members:'#members',self:'#selfPanel'};return Object.entries(slots).every(([name,selector])=>document.querySelector(selector)?.parentElement===document.querySelector('[data-deepscord-slot='+name+']'))&&document.getElementById('deepscordThemeScript').getAttribute('sandbox')==='allow-scripts';})()"));}
/** @param {number} debug @param {string} origin @returns {Promise<Page>} */
async function attach(debug,origin){
  await waitForPort(debug,20000);const workspace=await connectPage(debug,pathToFileURL(path.join(app,'workspace.html')).href);
  await workspace.waitFor("!!document.getElementById('savedRoomList')",{timeout:10000,interval:100,label:'native workspace'});
  await workspace.eval(`void window.deepscord.connect(${JSON.stringify(origin)})`,{awaitPromise:false,userGesture:true});workspace.close();
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){
    /** @type {{type:string,url:string}[]} */const targets=await fetch('http://127.0.0.1:'+debug+'/json/list').then(response=>response.json());const target=targets.find(row=>row.type==='page'&&row.url.startsWith('http://127.0.0.1:'));
    if(target){const page=await connectPage(debug,target.url);pages.push(page);await page.send('Runtime.enable',{});page.on('Runtime.exceptionThrown',/** @param {JsonValue} event */event=>exceptions.push(event));return page;}await delay(100);
  }
  throw new Error('Native room page failed to appear');
}
/** @returns {import('../lib/server-governance.cjs').GovernanceJournal} */
function journal(){return JSON.parse(fs.readFileSync(path.join(output,'server-data/server-governance.json'),'utf8'));}
/** @returns {import('../public/js/customization-protocol.js').CustomInteraction[]} */
function published(){return governance.governanceState(journal()).customization?.find(scope=>scope.domainId===null)?.interactions??[];}
/** @param {Page} page @returns {Promise<void>} */
async function openPanel(page){await click(page,'serverMenuBtn');await click(page,'interactionCustomizationMenuBtn');await page.waitFor("!!document.getElementById('customizationInteractionAdd')&&!!document.getElementById('customizationInteractionDrafts')",{timeout:7000,interval:50,label:'native interaction management'});}
/** @param {Page} page @param {string} expression @param {string} label @returns {Promise<void>} */
async function focusRefresh(page,expression,label){activate(explorerHandle);activate(roomHandle);await page.waitFor(expression,{timeout:10000,interval:100,label});}
let timer;
try{
 await Promise.race([(async()=>{
  const port=await freePort(),origin='http://127.0.0.1:'+port+'/';
  launch('server',process.execPath,[path.join(server,'server.js')],server,{...process.env,PORT:String(port),HTTP_HOST:'127.0.0.1',HTTPS_PORTS:'0',ECHO_DATA_DIR:path.join(output,'server-data'),ECHO_MEDIA_POLICY:'direct',ECHO_NETWORK_MODE:'server',ECHO_PASSWORD:''});
  const deadline=Date.now()+12000;let ready=false;
  while(Date.now()<deadline){try{ready=(await fetch(origin+'api/health')).ok;}catch(error){if(!(error instanceof TypeError))throw error;}if(ready)break;await delay(100);}assert(ready,'Real backend must become healthy');
  fs.writeFileSync(path.join(profile,'config.json'),JSON.stringify({autoConnect:false}));
  fs.writeFileSync(path.join(profile,'desktop-settings.json'),JSON.stringify({muteShortcut:'Control+Alt+Shift+F24',overlay:{enabled:false,locked:true,x:24,y:80,width:280,height:300,scale:1}}));
  /** @type {NodeJS.ProcessEnv} */const environment={...process.env,DEEPSCORD_USER_DATA:profile};delete environment.ELECTRON_RUN_AS_NODE;
  const debug=await freePort(),client=launch('client',executable,[...(packageDirectory?[]:[app]),'--remote-debugging-port='+debug,'--mute-audio','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'],packageDirectory??root,environment);
  const page=await attach(debug,origin);await page.waitFor("!!document.getElementById('welcomeNameInput')",{timeout:12000,interval:100,label:'native welcome'});
  await page.eval("document.getElementById('welcomeNameInput').value='Server draft acceptance';document.getElementById('welcomeEnterBtn').click()");
  await page.waitFor("window.echo?.getState().roomReady===true&&!!window.echo.getState().selfKey",{timeout:15000,interval:100,label:'real verified client identity'});
  await page.eval("window.acceptanceFocusEvents=0;window.addEventListener('focus',()=>{window.acceptanceFocusEvents+=1;})");
  await click(page,'serverMenuBtn');await click(page,'serverGovernanceMenuBtn');await page.waitFor("!!document.getElementById('ownerClaimToken')",{timeout:7000,interval:50,label:'owner claim form'});
  const token=fs.readFileSync(path.join(output,'server-data/owner-claim.txt'),'utf8').trim();
  await page.eval('document.getElementById("ownerClaimToken").value='+JSON.stringify(token));await click(page,'claimOwnerBtn');
  await page.waitFor("window.echo.getState().ownerKey===window.echo.getState().selfKey&&!document.getElementById('ownerClaimToken')",{timeout:7000,interval:50,label:'signed owner claimed'});
  checks.push('owner-claimed-through-ui');await openPanel(page);
  check('no-domain-scope-selector',await page.eval("!document.getElementById('customizationScope')"));
  await page.waitFor("document.getElementById('customizationInteractionDrafts').textContent.includes('customization')",{timeout:10000,interval:100,label:'native server directory initialized'});
  const interactions=path.join(profile,'customization/interactions'),folders=fs.readdirSync(interactions,{withFileTypes:true}).filter(entry=>entry.isDirectory());assert.equal(folders.length,1);
  const roomId=folders[0].name;assert.match(roomId,/^[a-f0-9-]{36}$/);const serverDirectory=path.join(interactions,roomId);
  check('root-guide-current',fs.readFileSync(path.join(interactions,'DEVELOPMENT.md')).equals(fs.readFileSync(path.join(server,'public/customization/interactions/DEVELOPMENT.md'))));
  check('server-folder-starts-empty',fs.readdirSync(serverDirectory).length===0);
  await click(page,'customizationInteractionAdd');const explorerDeadline=Date.now()+10000;let found=false;
  while(Date.now()<explorerDeadline){const windows=explorer('inspect');assert(Array.isArray(windows));found=windows.some(row=>row!==null&&typeof row==='object'&&!Array.isArray(row)&&typeof row.path==='string'&&path.normalize(row.path).toLowerCase()===interactions.toLowerCase());if(found)break;await delay(150);}
  check('new-opens-actual-explorer-root',found);observations.push({explorer:explorer('capture')});
  const roomHandles=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'test/server-drafts-handles.ps1'),'-OwnerProcessId',String(client.pid)],{encoding:'utf8',windowsHide:true,timeout:15000}));assert(Array.isArray(roomHandles)&&roomHandles.length===1,'One owned native room window must exist');roomHandle=roomHandles[0];
  const explorerWindows=explorer('inspect');assert(Array.isArray(explorerWindows));const ownedExplorer=explorerWindows.find(row=>row!==null&&typeof row==='object'&&!Array.isArray(row)&&row.path===interactions);assert(ownedExplorer&&typeof ownedExplorer==='object'&&!Array.isArray(ownedExplorer)&&typeof ownedExplorer.handle==='number');explorerHandle=ownedExplorer.handle;
  await page.waitFor("document.getElementById('customizationStatus')?.dataset.state==='saved'",{timeout:5000,interval:50,label:'native folder action completes'});
  check('new-does-not-open-editor',await page.eval("!document.getElementById('customizationInteractionForm')"));
  /** @type {import('../public/js/customization-protocol.js').CustomInteraction} */const draft={id:'native-directory-draft',name:'Native folder draft',thumbnail:null,model:'bomb',trajectory:'arc',sound:'none',durationMs:900};
  const otherRoomId=randomUUID(),otherDirectory=path.join(interactions,otherRoomId);fs.mkdirSync(otherDirectory);fs.writeFileSync(path.join(otherDirectory,'other.json'),JSON.stringify({...draft,id:'foreign-room-draft',name:'Foreign draft'}));
  activate(explorerHandle);fs.writeFileSync(path.join(serverDirectory,'draft.json'),JSON.stringify(draft,null,2));
  await focusRefresh(page,"!!document.getElementById('customizationInteractionUpload-native-directory-draft')",'focus refresh discovers native draft');
  check('foreign-room-draft-excluded',await page.eval("!document.querySelector('[data-draft-id=foreign-room-draft]')"));
  check('draft-not-auto-published',!published().some(entry=>entry.id===draft.id));
  await page.eval("document.getElementById('customizationInteractionDrafts').scrollIntoView({block:'center',behavior:'instant'})");await page.screenshot(path.join(output,'draft-ready-native.png'));await click(page,'customizationInteractionUpload-'+draft.id);
  await page.waitFor("!!document.getElementById('customizationInteractionEdit-native-directory-draft')&&document.getElementById('customizationStatus').dataset.state==='saved'",{timeout:10000,interval:100,label:'signed draft upload'});
  check('upload-published-to-global-scope',published().some(entry=>entry.id===draft.id&&entry.name===draft.name));
  activate(explorerHandle);fs.writeFileSync(path.join(serverDirectory,'draft.json'),JSON.stringify({...draft,name:'Updated native draft',durationMs:1200},null,2));
  await focusRefresh(page,"document.querySelector('[data-draft-id=native-directory-draft] strong')?.textContent==='Updated native draft'",'focus refresh discovers edited JSON');
  await click(page,'customizationInteractionUpload-'+draft.id);
  await page.waitFor("document.querySelector('[data-interaction-id=native-directory-draft] strong')?.textContent==='Updated native draft'&&document.getElementById('customizationStatus').dataset.state==='saved'",{timeout:10000,interval:100,label:'same ID updated from disk'});
  check('same-id-upload-updates-definition',published().filter(entry=>entry.id===draft.id).length===1&&published().some(entry=>entry.id===draft.id&&entry.durationMs===1200));
  await page.eval("document.getElementById('customizationInteractionEdit-native-directory-draft').scrollIntoView({block:'center',behavior:'instant'})");await page.screenshot(path.join(output,'draft-updated-native.png'));await click(page,'customizationInteractionDelete-'+draft.id);
  await page.waitFor("!document.getElementById('customizationInteractionEdit-native-directory-draft')&&document.getElementById('customizationStatus').dataset.state==='saved'",{timeout:10000,interval:100,label:'signed deletion'});
  const digest=journal().digest;await click(page,'customizationClose');await openPanel(page);
  await page.waitFor("!!document.getElementById('customizationInteractionUpload-native-directory-draft')",{timeout:10000,interval:100,label:'local draft survives published deletion'});
  await focusRefresh(page,"!!document.getElementById('customizationInteractionUpload-native-directory-draft')",'focus after published deletion');
  check('deleted-publication-not-resurrected',!published().some(entry=>entry.id===draft.id)&&journal().digest===digest);
  check('local-draft-retained-after-delete',fs.existsSync(path.join(serverDirectory,'draft.json')));
  check('all-new-publication-commands-use-null-domain',journal().events.filter(event=>(event.command.type==='putInteraction'||event.command.type==='deleteInteraction')&&('interactionId' in event.command?event.command.interactionId:event.command.interaction.id)===draft.id).every(event=>'domainId' in event.command&&event.command.domainId===null));
  await page.eval("document.getElementById('customizationInteractionDrafts').scrollIntoView({block:'center',behavior:'instant'})");await page.screenshot(path.join(output,'draft-deleted-native.png'));observations.push({roomId,serverDirectory,otherRoomId,serverEvents:journal().events.length,focusEvents:await page.eval('window.acceptanceFocusEvents')});
  await click(page,'customizationClose');await page.eval('window.echo.actions.openSettings()');await click(page,'themeCustomizationMenuBtn');
  await page.waitFor("!!document.getElementById('customizationInterfacePreset')&&!document.getElementById('customizationThemeSave').disabled",{timeout:10000,interval:50,label:'native disk scheme selector ready'});
  await click(page,'customizationInterfacePreset');
  check('native-full-theme-manifests-listed',await page.eval("!!document.querySelector('#customizationInterfacePresetList [data-value=industrial-open]')&&!!document.querySelector('#customizationInterfacePresetList [data-value=constructivist-open]')"));
  await page.eval("window.nativeThemeOriginals=['#serverRail','.sidebar','.topbar','#radioStrip','.content','#members','#selfPanel','#audioSinks','#voiceStage','#stageGrid','#chat'].map(selector=>({selector,node:document.querySelector(selector)}));");
  const choiceId=await page.eval("document.querySelector('#customizationInterfacePresetList [data-value=constructivist-open]').id");assert.equal(typeof choiceId,'string');await click(page,choiceId);
  await page.waitFor("!!document.getElementById('theme-constructivist')",{timeout:10000,interval:50,label:'full theme preview selected from actual disk list'});
  check('native-full-theme-preview-preserves-original-nodes',await page.eval("window.nativeThemeOriginals.every(entry=>entry.node&&entry.node.isConnected&&document.querySelector(entry.selector)===entry.node)"));
  await click(page,'customizationThemeSave');await page.waitFor("document.getElementById('customizationSchemeStatus')?.dataset.state==='saved'",{timeout:10000,interval:50,label:'native full theme snapshot saved'});
  const saved=JSON.parse(fs.readFileSync(path.join(profile,'client-preferences.json'),'utf8')),selected=saved.settings.interfaceSelection;
  assert.equal(selected.scheme.id,'constructivist-open');assert(selected.scheme.presentation);assert.equal(Object.hasOwn(selected.scheme,'files'),false);
  assert.deepEqual(selected.scheme.presentation,{html:fs.readFileSync(path.join(profile,'customization/interfaces/packages/constructivist/layout.html'),'utf8'),css:fs.readFileSync(path.join(profile,'customization/interfaces/packages/constructivist/style.css'),'utf8'),script:fs.readFileSync(path.join(profile,'customization/interfaces/packages/constructivist/script.js'),'utf8')});checks.push('native-full-theme-content-snapshot-persisted');
  await click(page,'customizationClose');await page.screenshot(path.join(output,'native-full-theme-saved.png'));
  await page.send('Page.reload',{ignoreCache:true});await page.waitFor("window.echo?.getState().roomReady===true&&!!window.echo.getState().selfKey",{timeout:15000,interval:100,label:'native reload reconnects from persisted client preferences'});
  await mountedPackage(page);check('native-full-theme-reload-restores-saved-selection',await page.eval("window.echo.getState().settings.interfaceSelection?.scheme.id==='constructivist-open'&&!!window.echo.getState().settings.interfaceSelection.scheme.presentation.script"));
  await page.waitFor("document.getElementById('theme-constructivist-server').textContent===document.getElementById('connectionServerName').textContent",{timeout:10000,interval:50,label:'native isolated script receives current server state'});
  await page.screenshot(path.join(output,'native-full-theme-reloaded.png'));await trustedClick(page,'theme-constructivist-settings');
  await page.waitFor("!!document.getElementById('profileName')&&!!document.getElementById('softwareSettingsDone')",{timeout:7000,interval:50,label:'trusted native theme action opens real settings'});checks.push('native-full-theme-trusted-settings-command');
  for(const kind of ['interfaces','interactions']){
    await click(page,'developerGuide-'+kind);const directory=path.join(profile,'customization',kind);
    await page.waitFor("!!document.getElementById('softwareSettingsDone')",{timeout:5000,interval:50,label:'settings remains open after native guide action'});
    check('native-current-guide-byte-identical-'+kind,fs.readFileSync(path.join(directory,'DEVELOPMENT.md')).equals(fs.readFileSync(path.join(server,'public/customization',kind,'DEVELOPMENT.md'))));
  }
  await click(page,'softwareSettingsDone');await page.screenshot(path.join(output,'native-full-theme-command-complete.png'));check('no-renderer-exceptions',exceptions.length===0);passed=true;
 })(),new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Native server drafts acceptance exceeded 120 seconds')),120000);})]);
}catch(error){
 for(const [index,page] of pages.entries())if(page.ws.readyState===WebSocket.OPEN){observations.push({failureDom:await page.eval("({drafts:document.getElementById('customizationInteractionDrafts')?.textContent,status:document.getElementById('customizationStatus')?.textContent,focusEvents:window.acceptanceFocusEvents,focused:document.hasFocus()})")});await page.screenshot(path.join(output,'failure-'+index+'.png'));}
 throw error;
}finally{
 clearTimeout(timer);for(const page of pages)page.close();for(const child of children.reverse())await stop(child);observations.push({closedOwnedExplorerWindows:explorer('close')});
 const tokenFile=path.join(output,'server-data/owner-claim.txt');if(fs.existsSync(tokenFile)){const token=fs.readFileSync(tokenFile,'utf8').trim();for(const key of Object.keys(logs))logs[key]=logs[key].replaceAll(token,'[redacted owner claim]');}
 if(packageDirectory){assert.deepEqual(manifest(packageDirectory),packageBefore,'Acceptance package must remain byte-identical');checks.push('package-remained-byte-identical');fs.writeFileSync(path.join(output,'package-before.json'),JSON.stringify(packageBefore,null,2));}
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed,source:packageDirectory??app,profile,checks,observations,exceptions,logs,realBackend:true,realNativeClient:true,realExplorer:true},null,2));
}
console.log(JSON.stringify({passed,output,checks}));

