// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {launchChrome,connectPage,closeChrome} from './cdp.mjs';
import {launch,stop,connect,authenticate,identity,send,receive,object} from './server-ws-helpers.mjs';
import codec from '../lib/avif-codec.cjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'deepscord-media-budget-'));
const fixture=await fs.readFile(path.join(root,'test/avif-codec-fixtures/transparent-animation.avif'));
const metadata={...await codec.validate(fixture,'personal',new AbortController().signal),sha256:createHash('sha256').update(fixture).digest('hex'),bytes:fixture.length};
const backend=await launch(path.join(temporary,'server'),{});
const member=await connect(backend,'Cache integration');await authenticate(member,identity());
let reads=0;
const server=http.createServer((request,response)=>{void serve(request,response).catch(error=>{response.writeHead(500);response.end(String(error));});});
/** @param {http.IncomingMessage} request @param {http.ServerResponse} response @returns {Promise<void>} */
async function serve(request,response){
  const pathname=new URL(request.url ?? '/','http://localhost').pathname;
  if(pathname==='/request'){
    const chunks=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const frame=object(JSON.parse(Buffer.concat(chunks).toString()));
    if(frame.op==='read')reads++;
    const cursor=send(member,frame);const result=await receive(member,cursor,event=>event.requestId===frame.requestId && event.t==='mediaResult','real cache media request');
    response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(result));return;
  }
  if(pathname==='/fixture'){response.writeHead(200,{'content-type':'image/avif'});response.end(fixture);return;}
  if(pathname.startsWith('/public/')){const filename=path.resolve(root,'.'+pathname);assert(filename.startsWith(root+path.sep));response.writeHead(200,{'content-type':filename.endsWith('.wasm')?'application/wasm':'text/javascript'});response.end(await fs.readFile(filename));return;}
  response.writeHead(200,{'content-type':'text/html'});response.end('<!doctype html><body><main id="host"><form id="composer"><textarea id="input"></textarea><button id="emojiPanelBtn" type="button"></button><button id="imageUploadBtn" type="button"></button></form><div id="messages"></div></main></body>');
}
await new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(undefined)));const address=server.address();assert(address && typeof address!=='string');
const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',()=>resolve(undefined)));const debug=probe.address();assert(debug && typeof debug!=='string');await new Promise((resolve,reject)=>probe.close(error=>error?reject(error):resolve(undefined)));
const url='http://127.0.0.1:'+address.port+'/';
/** @type {import('node:child_process').ChildProcess|null} */let browser=null;
try{
  browser=(await launchChrome({port:debug.port,userDataDir:path.join(temporary,'chrome'),url,headless:true})).child;
  const page=await connectPage(debug.port,url);
  try{
    await page.waitFor("document.readyState==='complete' && location.protocol==='http:'",{timeout:10000,interval:50,label:'media cache browser fixture'});
    const result=await page.eval(`(async()=>{
      const {createChatMediaClient}=await import('/public/js/chat-media-client.js');
      const {createChatMedia}=await import('/public/js/chat-media.js');
      const {createChatView}=await import('/public/js/chat-view.js');
      const util=await import('/public/js/util.js');const {icon}=await import('/public/js/icons.js');
      const errors=[];const client=createChatMediaClient({isReady:()=>true,send:frame=>{fetch('/request',{method:'POST',body:JSON.stringify(frame)}).then(response=>response.json()).then(reply=>client.receive(reply)).catch(error=>errors.push(String(error)));return true;}});
      const asset=${JSON.stringify(metadata)},signal=new AbortController().signal,blob=await(await fetch('/fixture')).blob();
      await client.upload(blob,asset,'personal',null,signal);
      const context={roomId:'cache-room',channelId:'channel',domainId:null,selfKey:'verified',actorId:null,domains:[],policy:null};
      const view=createChatView(document.getElementById('messages'),{escape:util.esc,body:util.renderText,time:util.fmtTime,day:util.fmtDay,color:util.colorFor,avatar:()=>'',icon});
      const media=await createChatMedia({input:document.getElementById('input'),form:document.getElementById('composer'),host:document.getElementById('host'),anchor:document.getElementById('emojiPanelBtn'),view,client,getContext:()=>({...context}),submitGovernance:async()=>{throw new Error('No governance changes in this test');},acceptMessage:()=>{throw new Error('No chat writes in this test');},reportError:error=>errors.push(error.message)});
      const first=await media.loadInteractionThumbnail(asset,signal);const completed=media.stats().codec.completed;
      for(let index=0;index<7;index++)client.cachePoster('pressure-'+index,new Blob([new Uint8Array(1024*1024)]));
      client.getPoster(asset.sha256);client.cachePoster('pressure-last',new Blob([new Uint8Array(1024*1024)]));
      const pressure=media.stats();if(pressure.cacheBytes!==0)throw new Error('Original must be evicted for this test');
      for(let index=0;index<20;index++){const lease=await media.loadInteractionThumbnail(asset,signal);lease.release();}
      const repeated=media.stats();for(let index=0;index<8;index++)client.cachePoster('eviction-'+index,new Blob([new Uint8Array(1024*1024)]));if(client.getPoster(asset.sha256)!==null)throw new Error('Leased poster must be evicted before its URL is checked');const response=await fetch(first.url);if(!response.ok)throw new Error('Live lease failed after cache pressure');const bitmap=await createImageBitmap(await response.blob());bitmap.close();
      const cold=await client.download(asset,signal);if(cold.size!==asset.bytes)throw new Error('Original redownload failed validation');
      const beforeOversize=client.stats().mediaCacheBytes;client.cachePoster('oversize',new Blob([new Uint8Array(9*1024*1024)]));const oversizePreserved=client.stats().mediaCacheBytes===beforeOversize;
      context.roomId='other-room';media.refresh();const reset=media.stats();let revoked=false;try{await fetch(first.url);}catch(error){revoked=error instanceof TypeError;}
      first.release();media.destroy();view.destroy();
      return {pressure,repeated,completed,reset,revoked,oversizePreserved,errors};
    })()`);
    assert(result && typeof result==='object' && !Array.isArray(result));const report=/** @type {{pressure:{mediaCacheBytes:number,cacheBytes:number},repeated:{codec:{completed:number},ownedUrls:number},completed:number,reset:{mediaCacheBytes:number,ownedUrls:number},revoked:boolean,oversizePreserved:boolean,errors:string[]}} */(result);
    assert(report.pressure.mediaCacheBytes<=8*1024*1024);assert.equal(report.pressure.cacheBytes,0);assert.equal(report.repeated.codec.completed,report.completed);assert.equal(report.repeated.ownedUrls,1);
    assert.equal(reads,2*Math.ceil(fixture.length/16384),'Twenty poster hits must not read the evicted original');assert.equal(report.reset.mediaCacheBytes,0);assert.equal(report.reset.ownedUrls,0);assert.equal(report.revoked,true);assert.equal(report.oversizePreserved,true);assert.deepEqual(report.errors,[]);
    console.log(JSON.stringify({passed:true,reads,posterLoadsWithoutDownload:20,...report}));
  }finally{page.close();}
}finally{
  await closeChrome(debug.port);if(browser && browser.exitCode===null)browser.kill();server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve(undefined)));await stop(backend);assert.equal(path.dirname(temporary),os.tmpdir());assert(path.basename(temporary).startsWith('deepscord-media-budget-'));await fs.rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
