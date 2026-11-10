// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {connectPage,waitForPort,sleep} from './cdp.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
assert.equal(process.argv.length,4,'Usage: node test/avif-codec-desktop.mjs --electron ABSOLUTE_EXECUTABLE');assert.equal(process.argv[2],'--electron');
const executable=fs.realpathSync(process.argv[3]);
const temporary=fs.mkdtempSync(path.join(root,'.qa-tools/avif-codec-desktop-')),runtime=path.join(temporary,'runtime'),original=path.dirname(executable),data=path.join(temporary,'user');
/** @param {string} source @param {string} destination @returns {void} */
function stage(source,destination) {
  fs.mkdirSync(destination,{recursive:true});
  for(const entry of fs.readdirSync(source,{withFileTypes:true})) {
    const filename=path.join(source,entry.name),target=path.join(destination,entry.name);
    if(path.relative(original,filename)==='resources'+path.sep+'app')continue;
    assert(!entry.isSymbolicLink());if(entry.isDirectory())stage(filename,target);else fs.linkSync(filename,target);
  }
}
stage(original,runtime);
const app=path.join(runtime,'resources/app');fs.cpSync(path.join(root,'desktop'),app,{recursive:true});
const descriptor=JSON.parse(fs.readFileSync(path.join(app,'package.json'),'utf8'));
fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({...descriptor,main:'avif-test-entry.cjs'}));
const deniedUrl='data:text/html,<title>Deepscord sticker IPC rejection</title><div id="stickerIpcDenied">Untrusted window</div>';
fs.writeFileSync(path.join(app,'avif-test-entry.cjs'),"require('./main.js');const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const window=new BrowserWindow({show:false,webPreferences:{preload:require('node:path').join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false}});return window.loadURL("+JSON.stringify(deniedUrl)+");}).catch(error=>{console.error(error);app.exit(1);});\n");
fs.mkdirSync(data);fs.writeFileSync(path.join(data,'desktop-settings.json'),JSON.stringify({muteShortcut:'Control+Alt+Shift+F19',overlay:{enabled:false,locked:true,x:24,y:80,width:280,height:300,scale:1}}));
/** @returns {Promise<number>} */
async function port() {const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address==='object');server.close();await once(server,'close');return address.port;}
/** @param {import('node:child_process').ChildProcess} child @returns {void} */
function stop(child) {if(child.exitCode!==null||!child.pid)return;const result=spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,encoding:'utf8'});if(result.error)throw result.error;if(result.status!==0)throw new Error('Owned desktop test cleanup failed: '+result.stderr);}
const serverPort=await port(),debugPort=await port(),origin='http://127.0.0.1:'+serverPort+'/';
const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(?:PORT|HTTP_|HTTPS_|ECHO_|STUN_|TURN_|ELECTRON_RUN_AS_NODE)/.test(key)));
const backend=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,env:{...environment,PORT:String(serverPort),HTTP_HOST:'127.0.0.1',HTTPS_PORTS:'0',ECHO_DATA_DIR:path.join(temporary,'server'),ECHO_NETWORK_MODE:'server',ECHO_MEDIA_POLICY:'direct',STUN_URLS:''},windowsHide:true,stdio:'ignore'});
/** @type {import('node:child_process').ChildProcess|null} */ let desktop=null;
/** @type {Awaited<ReturnType<typeof connectPage>>[]} */ const pages=[];
try {
  let ready=false;const deadline=Date.now()+15000;
  while(Date.now()<deadline) {try {ready=(await fetch(origin)).ok;}catch(error){if(!(error instanceof TypeError))throw error;}if(ready)break;await sleep(100);}
  assert(ready,'Real backend did not become ready');
  desktop=spawn(path.join(runtime,path.basename(executable)),['--remote-debugging-port='+debugPort],{env:{...environment,DEEPSCORD_USER_DATA:data},windowsHide:true,stdio:'ignore'});
  await waitForPort(debugPort,15000);
  const bootstrap=await connectPage(debugPort,'file:');pages.push(bootstrap);
  assert.equal(await bootstrap.eval('window.deepscord.listPersonalStickers().then(()=>false,error=>/trusted room/.test(error.message))',{awaitPromise:true,userGesture:true}),true);
  assert.equal(fs.existsSync(path.join(data,'stickers')),false,'Unauthorized bootstrap must not initialize the library');
  const denied=await connectPage(debugPort,'data:text/html');pages.push(denied);
  assert.equal(await denied.eval('window.deepscord.listPersonalStickers().then(()=>false,error=>/主页面|main frame|trusted room/.test(error.message))',{awaitPromise:true,userGesture:true}),true);
  await bootstrap.eval('setTimeout(()=>{void window.deepscord.connect('+JSON.stringify(origin)+')},50)',{awaitPromise:false,userGesture:true});
  const room=await connectPage(debugPort,origin);pages.push(room);
  await room.waitFor('!!window.deepscord && !!document.getElementById("welcomeNameInput")',{timeout:10000,interval:100,label:'Trusted room profile'});
  const fixture=fs.readFileSync(path.join(root,'test/avif-codec-fixtures/transparent-animation.avif')).toString('base64');
  const result=await room.eval('(async()=>{const api=window.deepscord;const initial=await api.listPersonalStickers();const item=await api.addPersonalSticker({name:"IPC transparent animation",data:'+JSON.stringify(fixture)+'});const pinned=await api.pinPersonalSticker(item.id);const used=await api.recordPersonalStickerUse(item.id);const preferences=await api.setStickerPreferences({columns:4,sort:"recent"});const bytes=await api.readPersonalSticker(item.sha256);const rejected=await api.addPersonalSticker({name:"bad path",data:'+JSON.stringify(fixture)+',path:"C:/Windows"}).then(()=>false,()=>true);return{initial:initial.items.length,item,pinned:pinned.pinned,useCount:used.useCount,preferences,bytes,rejected};})()',{awaitPromise:true,userGesture:true});
  assert.equal(result.initial,0);assert.equal(result.item.frames,2);assert.equal(result.item.durationMs,216);assert.equal(result.pinned,true);assert.equal(result.useCount,1);assert.equal(result.bytes,fixture);assert.equal(result.rejected,true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data,'stickers/index.json'),'utf8')).items.length,1);
  await room.eval('window.deepscord.removePersonalSticker('+JSON.stringify(result.item.id)+')',{awaitPromise:true,userGesture:true});
  assert.equal(JSON.parse(fs.readFileSync(path.join(data,'stickers/index.json'),'utf8')).items.length,0);
  console.log(JSON.stringify({passed:true,checks:['trusted production main/preload CRUD','actual transparent multi-frame AVIF verification','pin/use/preferences','path injection rejected','bootstrap rejected without opening storage','untrusted renderer rejected'],directory:path.join(data,'stickers')}));
  await room.eval('void window.deepscord.quit()',{awaitPromise:false,userGesture:true});
  await once(desktop,'exit');desktop=null;
} finally {for(const page of pages)page.close();if(desktop)stop(desktop);stop(backend);}
