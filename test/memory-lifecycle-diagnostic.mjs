// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {connectPage,waitForPort} from './cdp.mjs';
import {launch,stop,object} from './server-ws-helpers.mjs';
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {Awaited<ReturnType<typeof connectPage>>} Page */
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const target=process.env.DEEPSCORD_MEMORY_APP,suppliedOutput=process.env.DEEPSCORD_MEMORY_OUTPUT;assert(target&&suppliedOutput);
const output=path.resolve(suppliedOutput),app=fs.realpathSync(target);fs.mkdirSync(output,{recursive:true});
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-memory-diagnostic-')),data=path.join(temporary,'client');fs.mkdirSync(data);
const backend=await launch(path.join(temporary,'server'),{});
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({serverUrl:backend.origin,autoConnect:false,trustedHosts:[]}));
fs.writeFileSync(path.join(data,'desktop-settings.json'),JSON.stringify({muteShortcut:'Control+Alt+Shift+F9',overlay:{enabled:false,locked:true,x:24,y:80,width:280,height:300,scale:1}}));
/** @returns {Promise<number>} */async function port(){const listener=net.createServer();await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',()=>resolve(undefined));});const address=listener.address();assert(address&&typeof address!=='string');await new Promise((resolve,reject)=>listener.close(error=>error?reject(error):resolve(undefined)));return address.port;}
const debug=await port(),controlPort=await port();
/** @type {NodeJS.ProcessEnv} */const environment={...process.env,DEEPSCORD_USER_DATA:data,DEEPSCORD_MEMORY_APP:app,DEEPSCORD_MEMORY_CONTROL_PORT:String(controlPort),DEEPSCORD_MEMORY_DIAGNOSTIC:'native-visibility'};delete environment.ELECTRON_RUN_AS_NODE;
const child=spawn(path.join(root,'node_modules/electron/dist/electron.exe'),[path.join(root,'test/memory-lifecycle-wrapper.cjs'),'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+debug],{cwd:root,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='';child.stdout.on('data',chunk=>{log+=String(chunk);});child.stderr.on('data',chunk=>{log+=String(chunk);});
/** @type {Page[]} */const pages=[];
/** @type {JsonValue[]} */const observations=[];
/** @param {string} endpoint @returns {Promise<JsonValue>} */async function control(endpoint){const response=await fetch('http://127.0.0.1:'+controlPort+endpoint);assert.equal(response.status,200);return response.json();}
/** @param {string} url @returns {Promise<Page>} */async function attach(url){const page=await connectPage(debug,url);pages.push(page);return page;}
/** @param {Page} page @param {string} expression @param {string} label @returns {Promise<void>} */async function ready(page,expression,label){await page.waitFor(expression,{timeout:20000,interval:25,label});}
/** @param {Page} page @returns {Promise<boolean>} */async function visibleWithinDeadline(page){const deadline=Date.now()+20000;while(Date.now()<deadline){if(await page.eval("document.visibilityState==='visible'"))return true;await new Promise(resolve=>setTimeout(resolve,25));}return false;}
/** @param {Page} picker @param {string} stage @returns {Promise<void>} */async function observe(picker,stage){observations.push({stage,at:new Date().toISOString(),application:await control('/metrics'),document:await picker.eval("({visibilityState:document.visibilityState,active:document.body.dataset.active,focused:document.hasFocus(),grid:document.getElementById('personalStickerPickerGrid')?.getBoundingClientRect().toJSON(),busy:document.getElementById('personalStickerPicker')?.getAttribute('aria-busy'),images:[...document.querySelectorAll('#personalStickerPickerGrid img')].map(image=>({src:image.getAttribute('src'),width:image.naturalWidth,complete:image.complete}))})")});fs.writeFileSync(path.join(output,'observations.json'),JSON.stringify(observations,null,2));console.log('OBSERVED '+stage);}
try{
 await waitForPort(debug,20000);const workspace=await attach(pathToFileURL(path.join(app,'workspace.html')).href);await ready(workspace,"document.getElementById('workspaceLoading')?.hidden===true",'workspace');
 await workspace.eval("document.getElementById('workspaceAddBtn').click()");const connection=await attach(pathToFileURL(path.join(app,'connections.html')).href);await ready(connection,"document.getElementById('connectionChoice')?.hidden===false",'chooser');
 await connection.eval("document.getElementById('chooseJoinBtn').click();document.getElementById('serverMethodBtn').click();document.getElementById('serverUrl').value="+JSON.stringify(backend.origin)+";document.getElementById('serverConnectBtn').click()");
 const ui=await attach('http://127.0.0.1:');await ready(ui,"!!document.getElementById('welcomeNameInput')",'welcome');await ui.eval("document.getElementById('welcomeNameInput').value='Visibility diagnostic';document.getElementById('welcomeEnterBtn').click()");await ready(ui,"window.echo?.getState().roomReady && !!window.echo.getState().selfKey && !document.querySelector('.modal-backdrop')",'authenticated');
 await control('/show');await ui.eval("document.getElementById('emojiPanelBtn').click()");const picker=await attach(pathToFileURL(path.join(app,'sticker-picker.html')).href);await picker.send('Page.bringToFront',{});await ready(picker,"document.body.dataset.active==='true'",'picker active');
 const initiallyVisible=await visibleWithinDeadline(picker);await observe(picker,'before-import');
 const documentNode=await picker.send('DOM.getDocument',{}),input=await picker.send('DOM.querySelector',{nodeId:documentNode.root.nodeId,selector:'#personalStickerPickerImportInput'});assert(input.nodeId>0);await picker.send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[path.join(root,'test/fixtures/avatar-96.jpg'),path.join(root,'test/avif-codec-fixtures/transparent-animation.gif')]});
 await ready(picker,"document.querySelectorAll('#personalStickerPickerGrid [data-testid=sticker-cell]').length===2 && !document.getElementById('personalStickerPicker').hasAttribute('aria-busy')",'imports committed');await observe(picker,'before-diagnostic-unthrottle');
 const start=performance.now();await control('/diagnostic-unthrottle-private');await observe(picker,'immediately-after-diagnostic-unthrottle');
 await ready(picker,"document.visibilityState==='visible' && [...document.querySelectorAll('#personalStickerPickerGrid img')].length===2 && [...document.querySelectorAll('#personalStickerPickerGrid img')].every(image=>image.naturalWidth>0)",'diagnostic unthrottle restores visibility and real image decoding');
 const recoveryMs=performance.now()-start;await observe(picker,'restored-after-diagnostic-unthrottle');
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({app,temporary,data,initiallyVisible,recoveryMs,observations,log,scope:'Diagnostic only. Explicitly changes backgroundThrottling for the actual private WebContentsView after recording native and renderer visibility. Excluded from memory comparison.'},null,2));console.log(JSON.stringify({initiallyVisible,recoveryMs,output}));
}catch(error){fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:error instanceof Error?error.stack:String(error),app,temporary,data,observations,log},null,2));throw error;}
finally{for(const page of pages)page.close();if(child.exitCode===null)child.kill();await stop(backend);}
