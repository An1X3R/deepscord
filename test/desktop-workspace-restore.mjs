// @ts-check
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connectPage,waitForPort,sleep} from './cdp.mjs';
import {initialSettings} from '../desktop/desktop-schema.cjs';

const source=process.env.DEEPSCORD_ELECTRON_RUNTIME;
assert(source,'Set DEEPSCORD_ELECTRON_RUNTIME to an existing packaged executable');
const root=fileURLToPath(new URL('../',import.meta.url));
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-workspace-restore-'));
const runtime=path.join(temporary,'runtime');
const originalApp=path.join(path.dirname(source),'resources','app');
fs.cpSync(path.dirname(source),runtime,{recursive:true,filter:entry=>entry!==originalApp});
fs.cpSync(path.join(root,'desktop'),path.join(runtime,'resources','app'),{recursive:true});
const executable=path.join(runtime,path.basename(source));
/** @type {import('node:child_process').ChildProcess[]} */
const children=[];

/** @returns {Promise<number>} */
async function reservePort() {
  const listener=net.createServer();
  listener.listen(0,'127.0.0.1');
  await once(listener,'listening');
  const address=listener.address();
  assert(address && typeof address==='object');
  listener.close();
  await once(listener,'close');
  return address.port;
}

/** @param {string} data @returns {Promise<{child:import('node:child_process').ChildProcess,port:number}>} */
async function launch(data) {
  const port=await reservePort();
  const environment={...process.env,DEEPSCORD_USER_DATA:data};
  delete environment.ELECTRON_RUN_AS_NODE;
  const child=spawn(executable,[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],{env:environment,windowsHide:true,stdio:'ignore'});
  children.push(child);
  await waitForPort(port,15000);
  return {child,port};
}

/** @param {import('node:child_process').ChildProcess} child @returns {Promise<void>} */
async function stop(child) {
  if(child.exitCode!==null || child.signalCode!==null) return;
  const exited=once(child,'exit');
  child.kill();
  await exited;
}

/** @param {number} port @returns {Promise<Awaited<ReturnType<typeof connectPage>>>} */
async function connectFailurePage(port) {
  const deadline=Date.now()+15000;
  while(Date.now()<deadline) {
    /** @type {{type:string,url:string}[]} */
    const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target=targets.find(item=>item.type==='page' && item.url.startsWith('file:') && item.url.includes('?error='));
    if(target) return connectPage(port,target.url);
    await sleep(100);
  }
  throw new Error('Native client did not display the failed connection workspace');
}

try {
  const serverPort=await reservePort();
  const origin=`http://127.0.0.1:${serverPort}/`;
  const inherited=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(?:PORT|HTTP_|HTTPS_|ECHO_|STUN_|TURN_)/.test(key)));
  const backend=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,env:{...inherited,PORT:String(serverPort),HTTP_HOST:'127.0.0.1',HTTPS_PORTS:'0',ECHO_DATA_DIR:path.join(temporary,'server'),ECHO_NETWORK_MODE:'server',ECHO_MEDIA_POLICY:'direct',STUN_URLS:''},windowsHide:true,stdio:'ignore'});
  children.push(backend);
  const deadline=Date.now()+15000;
  let ready=false;
  while(Date.now()<deadline) {
    try {ready=(await fetch(origin)).ok;} catch(error) {if(!(error instanceof TypeError)) throw error;}
    if(ready) break;
    await sleep(100);
  }
  assert(ready,'Real backend did not start');
  const data=path.join(temporary,'client');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data,'desktop-settings.json'),JSON.stringify({...initialSettings(),muteShortcut:'Control+Alt+Shift+F22'}));
  const initial=await launch(data);
  let page=await connectPage(initial.port,'file:');
  await page.waitFor('!!document.getElementById("savedRoomList")',{timeout:10000,interval:100,label:'workspace'});
  await page.eval(`void window.deepscord.connect(${JSON.stringify(origin)})`,{awaitPromise:false,userGesture:true});
  page.close();
  page=await connectPage(initial.port,origin);
  await page.waitFor('!!document.getElementById("welcomeNameInput")',{timeout:10000,interval:100,label:'profile'});
  await page.eval('document.getElementById("welcomeNameInput").value="Restore test";document.getElementById("welcomeEnterBtn").click()', {awaitPromise:true,userGesture:true});
  const commitDeadline=Date.now()+12000;
  let savedId='';
  while(Date.now()<commitDeadline) {
    const filename=path.join(data,'config.json');
    if(fs.existsSync(filename)) savedId=JSON.parse(fs.readFileSync(filename,'utf8')).lastWorkspaceEntryId || '';
    if(savedId) break;
    await sleep(100);
  }
  assert(savedId,'Only a successful validated room commit may set the startup connection');
  const workspace=JSON.parse(fs.readFileSync(path.join(data,'workspace.json'),'utf8'));
  assert(workspace.entries.find(/** @param {{id:string,document:object|null}} entry */ entry=>entry.id===savedId)?.document);
  page.close();
  await stop(initial.child);
  const restored=await launch(data);
  page=await connectPage(restored.port,origin);
  await page.waitFor('!!document.getElementById("channelScroll") && document.getElementById("channelScroll").children.length>0',{timeout:10000,interval:100,label:'restored channels'});
  assert.equal(await page.eval('document.querySelectorAll("[data-action=leave]").length'),0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data,'config.json'),'utf8')).lastWorkspaceEntryId,savedId);
  console.log('PASS native restart automatically reloads the last successful server and channel UI');
  page.close();
  await stop(restored.child);
  await stop(backend);
  const unavailable=await launch(data);
  page=await connectFailurePage(unavailable.port);
  await page.waitFor('!!document.getElementById("workspaceError") && !document.getElementById("workspaceError").hidden',{timeout:10000,interval:100,label:'unavailable server error'});
  assert.match(await page.eval('document.getElementById("workspaceError").textContent'),/无法连接|无法恢复/);
  assert.equal(await page.eval('!!document.getElementById("savedRoomList")'),true);
  console.log('PASS unavailable saved server reports an error and leaves server switching available');
  page.close();
  await stop(unavailable.child);
  const configuration=JSON.parse(fs.readFileSync(path.join(data,'config.json'),'utf8'));
  fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({...configuration,lastWorkspaceEntryId:'invalid-entry'}));
  const invalid=await launch(data);
  page=await connectFailurePage(invalid.port);
  await page.waitFor('!document.getElementById("workspaceError").hidden',{timeout:10000,interval:100,label:'invalid saved entry'});
  assert.match(await page.eval('document.getElementById("workspaceError").textContent'),/无法恢复/);
  assert.equal(await page.eval('!!document.getElementById("savedRoomList")'),true);
  console.log('PASS invalid last-entry setting reports an error without crashing or replacing the server');
  page.close();
  await stop(invalid.child);
} finally {
  await Promise.all(children.map(stop));
  assert.equal(path.dirname(temporary),os.tmpdir());
  fs.rmSync(temporary,{recursive:true,force:true});
}
