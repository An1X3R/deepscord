// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {connectPage,waitForPort} from './cdp.mjs';
import codec from '../lib/avif-codec.cjs';
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=process.env.ELECTRON_TEST_BINARY;assert(source,'ELECTRON_TEST_BINARY must identify a real Electron executable');
const sourceDirectory=path.dirname(path.resolve(source)),runtime=path.join(root,'.qa-tools','sticker-library-runtime'),marker=path.join(runtime,'.sticker-library-owner');
if(fs.existsSync(runtime))assert.equal(fs.readFileSync(marker,'utf8'),sourceDirectory);
else{const originalApp=path.join(sourceDirectory,'resources','app');assert(!runtime.startsWith(sourceDirectory+path.sep));fs.cpSync(sourceDirectory,runtime,{recursive:true,filter:entry=>entry!==originalApp && !entry.startsWith(originalApp+path.sep) && entry!==path.join(sourceDirectory,'resources','app.asar')});fs.writeFileSync(marker,sourceDirectory);}
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-sticker-browser-')),output=path.join(root,'output','playwright','sticker-library');fs.mkdirSync(output,{recursive:true});
const entry=path.join(runtime,'resources','app');fs.mkdirSync(entry,{recursive:true});fs.writeFileSync(path.join(entry,'package.json'),JSON.stringify({name:'deepscord-sticker-library-test',version:'1.0.0',main:'main.cjs'}));
fs.writeFileSync(path.join(entry,'main.cjs'),"const {app,BrowserWindow}=require('electron');app.setPath('userData',process.env.DEEPSCORD_LIBRARY_USER_DATA);app.on('window-all-closed',()=>app.quit());app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await window.loadURL(process.env.DEEPSCORD_LIBRARY_URL);});");
/** @returns {Promise<number>} */
async function freePort(){const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(undefined));});const address=server.address();assert(address && typeof address!=='string');await new Promise((resolve,reject)=>server.close(error=>error ? reject(error) : resolve(undefined)));return address.port;}
const limits=codec.limitsForKind('personal');
/** @param {number} seed @returns {Promise<Buffer>} */
async function image(seed){const rgba=new Uint8Array(96*64*4);for(let index=0;index<rgba.length;index++)rgba[index]=(index*seed+seed)%256;return codec.encode({width:96,height:64,timescale:1000,repetitionCount:0,frames:[{rgba,durationTicks:1000}]},{quality:80,speed:10},limits,new AbortController().signal);}
const fixtures=new Map([['first',await image(7)],['second',await image(19)],['third',await image(31)]]);
const frames=[0,1,2].map(frame=>{const rgba=new Uint8Array(64*64*4);for(let index=0;index<rgba.length;index++)rgba[index]=(index*13+frame*89)%256;return {rgba,durationTicks:100};});
const animation=await codec.encode({width:64,height:64,timescale:1000,repetitionCount:0,frames},{quality:80,speed:10},limits,new AbortController().signal);fixtures.set('animated',animation);
const decoded=await codec.decode(animation,limits,new AbortController().signal),poster=await codec.encode({width:decoded.metadata.width,height:decoded.metadata.height,timescale:1000,repetitionCount:0,frames:[{rgba:decoded.frames[0].rgba,durationTicks:1000}]},{quality:80,speed:10},limits,new AbortController().signal);
/** @type {Map<string,Buffer>} */const assets=new Map();
/** @type {{[key:string]:import('../public/js/chat-protocol.js').MediaMetadata}} */const catalog={};
for(const [name,bytes] of fixtures){const sha256=createHash('sha256').update(bytes).digest('hex');assets.set(sha256,bytes);catalog[name]={...await codec.validate(bytes,'personal',new AbortController().signal),sha256,bytes:bytes.length};}
const animationHash=createHash('sha256').update(animation).digest('hex');
const server=http.createServer((request,response)=>{void serve(request,response).catch(error=>{if(response.destroyed)return;response.writeHead(400,{'content-type':'text/plain; charset=utf-8'});response.end(error instanceof Error ? error.message : String(error));});});
/** @param {http.IncomingMessage} request @param {http.ServerResponse} response @returns {Promise<void>} */
async function serve(request,response){
  const url=new URL(request.url ?? '/', 'http://127.0.0.1');
  if(request.method==='POST' && url.pathname==='/validate'){
    const controller=new AbortController();response.once('close',()=>{if(!response.writableFinished)controller.abort();});
    /** @type {Buffer[]} */const chunks=[];let size=0;for await(const chunk of request){const data=Buffer.from(chunk);size+=data.length;if(size>160*1024)throw new RangeError('Validation upload exceeds 160 KiB');chunks.push(data);}
    const metadata=await codec.validate(Buffer.concat(chunks),'personal',controller.signal);if(response.destroyed)return;response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(metadata));return;
  }
  if(request.method!=='GET'){response.writeHead(405);response.end();return;}
  if(url.pathname==='/catalog'){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(catalog));return;}
  if(url.pathname.startsWith('/asset/')){const sha256=url.pathname.slice('/asset/'.length),bytes=assets.get(sha256);if(!bytes){response.writeHead(404);response.end();return;}response.writeHead(200,{'content-type':'image/avif'});response.end(sha256===animationHash && url.searchParams.get('intent')==='thumbnail' ? poster : bytes);return;}
  if(url.pathname.startsWith('/fixture/')){const bytes=fixtures.get(url.pathname.slice('/fixture/'.length));if(!bytes){response.writeHead(404);response.end();return;}response.writeHead(200,{'content-type':'image/avif'});response.end(bytes);return;}
  if(!url.pathname.startsWith('/public/') && !url.pathname.startsWith('/test/media-library-page.') && !url.pathname.startsWith('/test/chat-media-page.')){response.writeHead(404);response.end();return;}
  const filename=path.resolve(root,'.'+decodeURIComponent(url.pathname));if(!filename.startsWith(root+path.sep)){response.writeHead(403);response.end();return;}
  const type=filename.endsWith('.html') ? 'text/html' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';response.writeHead(200,{'content-type':type+'; charset=utf-8','cache-control':'no-store'});response.end(await fs.promises.readFile(filename));
}
const port=await freePort(),debug=await freePort();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve(undefined));});
const url='http://127.0.0.1:'+port+'/test/media-library-page.html';
/** @type {NodeJS.ProcessEnv} */const environment={...process.env,DEEPSCORD_LIBRARY_USER_DATA:temporary,DEEPSCORD_LIBRARY_URL:url};delete environment.ELECTRON_RUN_AS_NODE;
const child=spawn(path.join(runtime,path.basename(source)),['--remote-debugging-port='+debug],{cwd:root,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',chunk=>{log+=String(chunk);});child.stderr.on('data',chunk=>{log+=String(chunk);});
/** @type {Awaited<ReturnType<typeof connectPage>>|null} */let page=null;
try{
  await waitForPort(debug,20000);page=await connectPage(debug,url);const ui=page;
  await ui.waitFor('!!window.personalLibraryTest',{timeout:10000,interval:25,label:'actual browser library initialization'});
  const persistence=await ui.eval('window.personalLibraryTest.runPersistence()');assert.deepEqual(persistence,{persistent:true,deduplicated:true,transactions:true,leasesReleased:true,finalReferenceRemoved:true,canceled:true});
  console.log('Real IndexedDB persistence, reference deletion, cancellation and URL ownership passed');
  const validationCache=await ui.eval('window.personalLibraryTest.runValidationCache()');assert.deepEqual(validationCache,{repeatedLoads:20,completeValidations:1,currentBytesVerified:true,indexMetadataVerified:true,destroyClearsCache:true});
  console.log('Real AVIF repeated-load validation cache, current-byte hashes, index comparison and destroy cleanup passed');
  await ui.eval('window.personalLibraryTest.seedPanel()');await ui.eval("window.personalLibraryTest.cancelNextPanelRead();document.getElementById('emojiPanelBtn').click()");
  await ui.waitFor('window.personalLibraryTest.metrics().aborted>0 && window.personalLibraryTest.metrics().active===0 && window.personalLibraryTest.metrics().leases===0',{timeout:10000,interval:25,label:'tab change during a real IndexedDB read'});
  const canceled=await ui.eval('window.personalLibraryTest.metrics()');assert(canceled.aborted>0,'Switching tabs must cancel an in-flight real media read');assert(canceled.maxActive<=4,'Sticker media load concurrency must remain bounded');
  await ui.eval("document.getElementById('stickerPanelTabpersonal').click()");await ui.waitFor('window.personalLibraryTest.metrics().leases===3 && window.personalLibraryTest.metrics().active===0',{timeout:10000,interval:25,label:'actual AVIF previews'});
  const itemId=await ui.eval('window.personalLibraryTest.firstId()');
  await ui.eval('document.getElementById('+JSON.stringify('stickerPanelItem-personal-'+itemId)+').dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:440,clientY:400}))');
  await ui.eval("document.getElementById('stickerPanelsticker-pin-personal').click()");await ui.waitFor('window.personalLibraryTest.library().list().find(item=>item.id===window.personalLibraryTest.firstId()).pinned===true',{timeout:5000,interval:25,label:'real context pin persistence'});
  await ui.waitFor('window.personalLibraryTest.metrics().active===0',{timeout:10000,interval:25,label:'pin refresh previews'});await ui.screenshot(path.join(output,'personal-library.png'));
  await ui.eval("document.getElementById('stickerPanelCloseBtn').click()");await ui.waitFor('window.personalLibraryTest.metrics().active===0 && window.personalLibraryTest.metrics().leases===0',{timeout:10000,interval:25,label:'close releases all media'});
  assert.equal(await ui.eval("document.getElementById('libraryTestStatus').hasAttribute('data-error')"),false);
  const metrics=await ui.eval('window.personalLibraryTest.metrics()');fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({persistence,validationCache,canceled,metrics,screenshot:path.join(output,'personal-library.png')},null,2));
  console.log('Real Electron sticker panel tab cancellation, pin action and close cleanup passed');
  await ui.eval('window.personalLibraryTest.destroy()');await ui.send('Page.navigate',{url:'http://127.0.0.1:'+port+'/test/chat-media-page.html'});
  await ui.waitFor('!!window.chatMediaTest',{timeout:10000,interval:25,label:'real attachment renderer'});
  assert.equal(await ui.eval('window.chatMediaTest.metrics().reads'),0,'Distant history attachments must remain unloaded');
  await ui.eval("document.getElementById('chatRendererMessages').scrollTop=0");
  await ui.waitFor('window.chatMediaTest.metrics().leases===3 && window.chatMediaTest.metrics().active===0',{timeout:10000,interval:25,label:'real AVIF attachment and reaction thumbnails'});
  assert.equal(await ui.eval('window.chatMediaTest.metrics().animations'),0,'Default message and reaction previews must be static posters');
  assert.equal(await ui.eval("document.getElementById('chatAttachment-media-animated').parentNode.querySelector('.msg-text')===null"),true,'Attachment-only messages must not create an empty text body');
  assert.equal(await ui.eval('window.unsafeChat===undefined'),true);
  assert.equal(await ui.eval("document.querySelector('#chatRendererMessages .msg-text a').href"),'https://example.test/media');
  assert.equal(await ui.eval('window.chatMediaTest.refresh()'),0,'Unrelated renders must cause no DOM mutations');
  await ui.eval('window.rendererFirstImage=window.chatMediaTest.firstImage();window.rendererAnimatedImage=window.chatMediaTest.animatedImage();window.chatMediaTest.changeReactions()');
  assert.equal(await ui.eval('window.rendererFirstImage===window.chatMediaTest.firstImage()'),true,'Reaction updates must retain the original image node');
  const readsBeforeTitles=await ui.eval('window.chatMediaTest.metrics().reads');
  await ui.eval('window.chatMediaTest.setTitles(["Rail Engineer","<img src=x onerror=window.unsafeTitle=true>"])');
  assert.deepEqual(await ui.eval('[...document.querySelectorAll("[data-msg-id=media-first] .msg-author-title")].map(node=>node.textContent)'),['Rail Engineer','<img src=x onerror=window.unsafeTitle=true>']);
  assert.equal(await ui.eval('document.querySelector(".msg-author-title img")===null && window.unsafeTitle===undefined'),true,'Group titles must render as safe plain text');
  assert.equal(await ui.eval('document.querySelector("[data-msg-id=bot-title-check] .msg-author-title")===null && !!document.querySelector("[data-msg-id=bot-title-check] .badge-bot")'),true,'Bot badge must not acquire member titles');
  assert.equal(await ui.eval('window.rendererFirstImage===window.chatMediaTest.firstImage() && window.rendererAnimatedImage===window.chatMediaTest.animatedImage()'),true,'Title updates must retain loaded static and animated media nodes');
  assert.equal(await ui.eval('window.chatMediaTest.metrics().reads'),readsBeforeTitles,'Title changes must not restart media reads');
  assert.equal(await ui.eval('window.chatMediaTest.refresh()'),0,'Stable titles must cause no DOM mutations');
  await ui.eval('window.chatMediaTest.setTitles([])');
  assert.equal(await ui.eval('document.querySelectorAll(".msg-author-title").length'),0,'Revoked group titles must disappear on the existing rows');
  const outside=await ui.eval("(()=>{const bounds=document.getElementById('chatTestFocusBtn').getBoundingClientRect();return {x:bounds.left+10,y:bounds.top+10}})()");await ui.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:outside.x,y:outside.y});
  await ui.eval("document.getElementById('chatAttachment-media-animated').focus()");
  await ui.waitFor('window.chatMediaTest.metrics().animations===1',{timeout:5000,interval:25,label:'focused animation playback'});
  await ui.eval("document.getElementById('chatTestFocusBtn').focus()");await ui.waitFor('window.chatMediaTest.metrics().animations===0',{timeout:5000,interval:25,label:'blur releases animation'});
  await ui.eval("document.getElementById('chatFavorite-media-animated').click()");await ui.waitFor('window.chatMediaTest.favoriteExists()',{timeout:10000,interval:25,label:'actual attachment favorite import'});
  await ui.eval("document.getElementById('chatAttachment-media-first').click()");await ui.waitFor("document.getElementById('chatMediaPreview').open && document.getElementById('chatMediaPreviewImage').complete && !!document.getElementById('chatMediaPreviewImage').getAttribute('src')",{timeout:10000,interval:25,label:'same-page image preview'});
  await ui.screenshot(path.join(output,'chat-image-preview.png'));await ui.eval("document.getElementById('chatMediaPreviewCloseBtn').click()");
  await ui.waitFor("!document.getElementById('chatMediaPreview').open && !document.getElementById('chatMediaPreviewImage')",{timeout:5000,interval:25,label:'preview close releases owned image'});
  await ui.eval('window.chatMediaTest.removeFirst()');assert.equal(await ui.eval('window.rendererAnimatedImage===window.chatMediaTest.animatedImage()'),true,'Author grouping changes must preserve unaffected media nodes');
  await ui.eval("document.getElementById('chatRendererMessages').scrollTop=document.getElementById('chatRendererMessages').scrollHeight");await ui.waitFor('window.chatMediaTest.metrics().leases===0 && window.chatMediaTest.metrics().active===0',{timeout:5000,interval:25,label:'offscreen media release'});
  await ui.eval("document.getElementById('chatRendererMessages').scrollTop=0");await ui.waitFor('window.chatMediaTest.metrics().leases>0',{timeout:5000,interval:25,label:'scroll back reload'});await ui.send('Emulation.setDeviceMetricsOverride',{width:1100,height:850,deviceScaleFactor:1,mobile:false});await ui.screenshot(path.join(output,'chat-media-renderer.png'));
  await ui.eval('window.chatMediaTest.switchChannel()');await ui.waitFor('window.chatMediaTest.metrics().leases===0 && window.chatMediaTest.metrics().active===0',{timeout:5000,interval:25,label:'channel switch releases all media'});
  const renderer=await ui.eval('window.chatMediaTest.metrics()');assert(renderer.maxActive<=4);assert(renderer.maximumAnimations<=1);assert.deepEqual(renderer.errors,[]);fs.writeFileSync(path.join(output,'renderer-result.json'),JSON.stringify(renderer,null,2));
  console.log('Real Electron chat attachment renderer, keyed reactions, animation, preview and channel cleanup passed');await ui.eval('window.chatMediaTest.destroy()');
}catch(error){if(page)await page.screenshot(path.join(output,'failure.png'));console.error(error);console.error(log);throw error;}
finally{
  if(page && child.exitCode===null)await page.send('Page.close',{});page?.close();if(child.exitCode===null){await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,3000))]);if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}}
  await new Promise((resolve,reject)=>server.close(error=>error ? reject(error) : resolve(undefined)));assert.equal(path.dirname(temporary),os.tmpdir());assert(path.basename(temporary).startsWith('deepscord-sticker-browser-'));fs.rmSync(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
