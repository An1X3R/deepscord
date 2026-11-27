// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {initialSettings} from '../desktop/desktop-schema.cjs';
import {readInterfaceFile} from '../desktop/customization-store.cjs';
import {parseSchemeValues} from '../public/js/interface-scheme.js';
import {launch,stop,reservePort,until} from './server-ws-helpers.mjs';
import {page} from './security-cdp.mjs';

const root=process.cwd();
const packageInput=process.env.DEEPSCORD_ACCEPTANCE_PACKAGE;
assert(packageInput,'Set DEEPSCORD_ACCEPTANCE_PACKAGE to a complete Windows client package');
const packaged=fs.realpathSync(packageInput);
const directory=path.join(root,'.qa-tools/local-interface-tests',randomUUID());
const data=path.join(directory,'client');
fs.mkdirSync(data,{recursive:true});
fs.writeFileSync(path.join(data,'desktop-settings.json'),JSON.stringify({...initialSettings(),muteShortcut:'Control+Alt+Shift+F24',deafenShortcut:'Control+Alt+Shift+F23'}));
const backend=await launch(path.join(directory,'server'),{});
const port=await reservePort();
const workspaceUrl=pathToFileURL(path.join(packaged,'resources/app/workspace.html')).href;
const connectionsUrl=pathToFileURL(path.join(packaged,'resources/app/connections.html')).href;
/** @type {NodeJS.ProcessEnv} */const environment={...process.env,DEEPSCORD_USER_DATA:data};
delete environment.ELECTRON_RUN_AS_NODE;
let log='';
/** @type {import('node:child_process').ChildProcess|null} */let child=null;
/** @type {Awaited<ReturnType<typeof page>>[]} */const pages=[];
/** @type {string[]} */const checks=[];
/** @returns {Promise<void>} */
async function startClient(){
  const logStart=log.length;
  /** @type {Error|null} */let startupError=null;
  child=spawn(path.join(packaged,'Deepscord.exe'),['--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port],{env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.on('error',error=>{startupError=error;});
  child.stdout?.on('data',chunk=>{log+=String(chunk);});child.stderr?.on('data',chunk=>{log+=String(chunk);});
  await until(()=>log.slice(logStart).includes('DevTools listening on'),()=>startupError,'desktop debugger startup');
}
/** @returns {Promise<void>} */
async function stopClient(){
  for(const ui of pages)ui.close();pages.length=0;
  if(child&&child.exitCode===null){const ended=once(child,'exit');child.kill();await ended;}
  child=null;
}
/** @param {string} url @returns {Promise<Awaited<ReturnType<typeof page>>>} */
async function openPage(url){const ui=await page(port,url);pages.push(ui);return ui;}
/** @param {Awaited<ReturnType<typeof page>>} ui @param {string} name @returns {Promise<void>} */
async function screenshot(ui,name){const result=await ui.send('Page.captureScreenshot',{format:'png'});assert.equal(typeof result.data,'string');fs.writeFileSync(path.join(directory,name+'.png'),Buffer.from(String(result.data),'base64'));}
const colors='JSON.stringify(["--bg","--bg-side","--accent","--text"].map(key=>getComputedStyle(document.documentElement).getPropertyValue(key).trim()))';
try{
  await startClient();
  const initial=await openPage(workspaceUrl);
  await initial.wait('document.documentElement?.dataset.localInterface==="ready" && document.getElementById("workspaceEmpty")?.hidden===false');
  assert.equal(await initial.evaluate('document.documentElement.dataset.localScheme'),'industrial');
  await initial.evaluate('void window.deepscord.connect('+JSON.stringify(backend.origin)+')');
  const room=await openPage('http://127.0.0.1:');
  await room.wait('!!document.getElementById("welcomeNameInput")');
  await room.evaluate('document.getElementById("welcomeNameInput").value="Theme reviewer";document.getElementById("welcomeEnterBtn").click()');
  await room.wait('window.echo?.getState().roomReady && window.echo.getState().selfKey');
  for(const id of ['industrial','industrial-open','lanart-open','constructivist','constructivist-open']){
    const scheme=readInterfaceFile(path.join(root,'public/customization/interfaces',id+'.json'));
    const selection={scheme,values:parseSchemeValues(scheme,{})};
    await room.evaluate('(async()=>{const selection='+JSON.stringify(selection)+';const runtime=await import("/js/interface-scheme-runtime.js");runtime.applyInterfaceSelection(selection);await window.deepscord.saveClientPreferences({...window.echo.getState().settings,interfaceSelection:selection});})()');
    const expected=await room.evaluate(colors);
    await room.evaluate('window.deepscord.openConnectionPanel("workspace")');
    const workspace=await openPage(workspaceUrl);
    await workspace.wait('document.documentElement?.dataset.localInterface==="ready" && document.getElementById("workspaceLoading")?.hidden===true');
    assert.equal(await workspace.evaluate('document.documentElement.dataset.localScheme'),id);
    assert.equal(await workspace.evaluate(colors),expected,id+' workspace palette');
    assert.equal(await workspace.evaluate('document.getElementById("workspaceError").hidden'),true);
    assert.equal(await workspace.evaluate('getComputedStyle(document.body).visibility'),'visible');
    if(id.startsWith('constructivist'))await screenshot(workspace,id+'-workspace');
    await workspace.evaluate('document.getElementById("workspaceAddBtn").click()');
    const connections=await openPage(connectionsUrl);
    await connections.wait('document.documentElement?.dataset.localInterface==="ready"');
    assert.equal(await connections.evaluate(colors),expected,id+' connection palette');
    assert.equal(await connections.evaluate('document.getElementById("connectionError").hidden'),true);
    if(id.startsWith('constructivist'))await screenshot(connections,id+'-connections');
    await connections.evaluate('window.close()');
    connections.close();workspace.close();
    checks.push(id+' saved scheme applies to workspace and connection panel');
  }
  await stopClient();
  fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({serverUrl:'',autoConnect:false}));
  await startClient();
  const restarted=await openPage(workspaceUrl);
  await restarted.wait('document.documentElement?.dataset.localInterface==="ready"');
  assert.equal(await restarted.evaluate('document.documentElement.dataset.localScheme'),'constructivist-open');
  assert.equal(await restarted.evaluate('getComputedStyle(document.body).visibility'),'visible');
  assert.equal(await restarted.evaluate('document.getElementById("workspaceError").hidden'),true);
  checks.push('saved theme loads on cold startup before workspace content is displayed');
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({checks,package:packaged},null,2));
  console.log(JSON.stringify({checks,report:path.join(directory,'result.json')}));
}catch(error){fs.writeFileSync(path.join(directory,'client.log'),log);throw error;}
finally{await stopClient();await stop(backend);}
