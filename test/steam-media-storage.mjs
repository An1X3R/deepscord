// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {MessageChannel} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import storageModule from '../desktop/steam-media-storage.cjs';
import backendModule from '../lib/steam-media-backend.cjs';
import storeModule from '../lib/media-store.cjs';
import validatorModule from '../lib/media-validator.cjs';
import codec from '../lib/avif-codec.cjs';
import {mediaObject,parseMediaMetadata} from '../public/js/chat-protocol.js';
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../public/js/chat-protocol.js').MediaMetadata} MediaMetadata */
/** @typedef {ReturnType<typeof storageModule.createSteamMediaStorage>} Adapter */
/** @typedef {{[key:string]:JsonValue}} Message */
const animation=fs.readFileSync(new URL('avif-codec-fixtures/transparent-animation.avif',import.meta.url));
/** @param {Buffer} bytes @returns {string} */function hash(bytes){return createHash('sha256').update(bytes).digest('hex');}
/** @param {Buffer} bytes @returns {Promise<MediaMetadata>} */async function metadata(bytes){return parseMediaMetadata({sha256:hash(bytes),...await codec.validate(bytes,'image',new AbortController().signal)});}
/** @param {number} size @param {number} seed @returns {Promise<Buffer>} */async function encode(size,seed){const rgba=new Uint8Array(size*size*4);let value=seed;for(let index=0;index<rgba.length;index++){value=(Math.imul(value,1664525)+1013904223)>>>0;rgba[index]=value>>>24;}return codec.encode({width:size,height:size,timescale:1000,repetitionCount:0,frames:[{rgba,durationTicks:1000}]},{quality:100,speed:10},{maxBytes:1536*1024,maxDimension:1920,maxFrames:180,maxDecodedPixels:24*1024*1024,maxDurationMs:10000,timeoutMs:30000},new AbortController().signal);}
/** @returns {string} */function directory(){return fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-steam-media-'));}
/** @param {string} root @returns {void} */function cleanup(root){assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('deepscord-steam-media-'));fs.rmSync(root,{recursive:true,force:true});}
/** @param {Adapter} adapter @param {Buffer} bytes @returns {Promise<MediaMetadata>} */async function upload(adapter,bytes){const opened=mediaObject(await adapter.execute({op:'begin',kind:'image',domainId:null,sha256:hash(bytes),bytes:bytes.length}),'Replica begin');if(opened.asset!==undefined)return parseMediaMetadata(opened.asset);const uploadId=opened.uploadId;assert.equal(typeof uploadId,'string');for(let offset=0;offset<bytes.length;offset+=16384)await adapter.execute({op:'write',uploadId:uploadId ?? null,offset,data:bytes.subarray(offset,offset+16384).toString('base64')});const completed=mediaObject(await adapter.execute({op:'finish',uploadId:uploadId ?? null}),'Replica finish');return parseMediaMetadata(completed.asset ?? null);}
/** @param {string} rootDir @param {string} roomId @param {()=>MediaMetadata[]} manifest @param {number} uploadTtlMs */async function openBackend(rootDir,roomId,manifest,uploadTtlMs){
  const validator=validatorModule.createMediaValidator({maxPending:4}),store=storeModule.openMediaStore({rootDir,roomId,validate:validator.validate,limits:{rootBytes:512*1024*1024,roomBytes:256*1024*1024,stagingBytes:8*1024*1024,concurrentUploads:4,uploadTtlMs,unpublishedTtlMs:300000}}),key=randomBytes(32),channel=new MessageChannel();
  const bridge=backendModule.createSteamMediaBackend({key,storage:store,manifest,send:value=>channel.port1.postMessage(value)});channel.port1.on('message',/** @param {JsonValue} value */ value=>bridge.receive(value));
  /** @type {Error|null} */let failure=null;
  const server=http.createServer((request,response)=>{void bridge.handle(request,response).catch(error=>{failure=error instanceof Error?error:new TypeError('Media HTTP handler failed without an Error');response.destroy(failure);});});
  server.listen(0,'0.0.0.0');await once(server,'listening');const address=server.address();assert(address && typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
  /** @param {JsonValue} input @param {string} token @returns {Promise<{status:number,value:Message|null}>} */async function post(input,token){const response=await fetch(origin+'/api/steam-media',{method:'POST',headers:{'Content-Type':'application/json','x-deepscord-media-key':token},body:JSON.stringify(input),signal:AbortSignal.timeout(5000)});const body=await response.text();if(failure)throw failure;return{status:response.status,value:body?mediaObject(JSON.parse(body),'Private media response'):null};}
  /** @returns {Promise<void>} */async function close(){bridge.close();validator.close();store.close();channel.port1.close();channel.port2.close();server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve(undefined)));}
  return{bridge,store,validator,key,channel,origin,port:address.port,server,post,close};
}
const large=await encode(96,701),privateBytes=await encode(8,709),largeAsset=await metadata(large),animationAsset=await metadata(animation),privateAsset=await metadata(privateBytes);

test('real local and HTTP replica adapters hand the same durable room files to the backend without exposing private hashes',{timeout:15000},async()=>{
  const root=directory(),roomId=randomUUID();let local=storageModule.createSteamMediaStorage({rootDir:root,roomId,backend:null});/** @type {Awaited<ReturnType<typeof openBackend>>|null} */let backend=null;/** @type {Adapter|null} */let remote=null;let localOpen=true;
  try{
    await local.references([largeAsset.sha256,privateAsset.sha256]);assert.deepEqual(await upload(local,large),largeAsset);await upload(local,privateBytes);await local.close();localOpen=false;
    /** @type {MediaMetadata[]} */let manifest=[largeAsset,animationAsset];backend=await openBackend(root,roomId,()=>manifest,60000);const token=backend.key.toString('hex');
    assert.equal((await backend.post({op:'inventory'},'0'.repeat(64))).status,403);const get=await fetch(backend.origin+'/api/steam-media',{headers:{'x-deepscord-media-key':token}});assert.equal(get.status,403);
    const address=Object.values(os.networkInterfaces()).flat().find(entry=>entry && !entry.internal && entry.family==='IPv4');assert(address,'A real non-loopback interface is required for this security test');
    const external=await fetch('http://'+address.address+':'+backend.port+'/api/steam-media',{method:'POST',headers:{'x-deepscord-media-key':token},body:'{"op":"inventory"}',signal:AbortSignal.timeout(5000)});assert.equal(external.status,403);
    const forbidden=await backend.post({op:'info',sha256:privateAsset.sha256},token);assert.equal(forbidden.value?.code,'permission-denied');assert.equal(backend.store.metadata(privateAsset.sha256)?.sha256,privateAsset.sha256);
    remote=storageModule.createSteamMediaStorage({rootDir:root,roomId,backend:{origin:backend.origin,key:backend.key}});await remote.references([largeAsset.sha256,animationAsset.sha256,privateAsset.sha256]);
    const inventory=mediaObject(await remote.execute({op:'inventory'}),'Inventory');assert.deepEqual(inventory.assets,[largeAsset]);await assert.rejects(remote.execute({op:'info',sha256:privateAsset.sha256}),error=>error instanceof Error && 'code' in error && error.code==='permission-denied');
    const range=mediaObject(await remote.execute({op:'read',sha256:largeAsset.sha256,offset:0,length:16384}),'Read');assert.equal(typeof range.data,'string');assert.deepEqual(Buffer.from(/** @type {string} */(range.data),'base64'),large.subarray(0,16384));
    assert.deepEqual(await upload(remote,animation),animationAsset);
    manifest=[{...largeAsset,width:largeAsset.width-1},animationAsset];const conflict=await backend.post({op:'info',sha256:largeAsset.sha256},token);assert.equal(conflict.value?.code,'media-invalid');manifest=[largeAsset,animationAsset];
    await remote.close();remote=null;await backend.close();backend=null;
    local=storageModule.createSteamMediaStorage({rootDir:root,roomId,backend:null});localOpen=true;await local.references([largeAsset.sha256,animationAsset.sha256]);assert.deepEqual(parseMediaMetadata(mediaObject(await local.execute({op:'info',sha256:animationAsset.sha256}),'Recovered').asset ?? null),animationAsset);
    const recovered=mediaObject(await local.execute({op:'read',sha256:largeAsset.sha256,offset:16384,length:16384}),'Recovered read');assert.deepEqual(Buffer.from(String(recovered.data),'base64'),large.subarray(16384,32768));
  }finally{if(remote)await remote.close();if(backend)await backend.close();if(localOpen)await local.close();cleanup(root);}
});

test('real HTTP backup uploads reclaim cancelled, malformed and expired slots and keep busy finishes retryable',{timeout:15000},async()=>{
  const root=directory(),roomId=randomUUID(),invalid=Buffer.from('Invalid AVIF tail data');const invalidAsset={sha256:hash(invalid),bytes:invalid.length,width:1,height:1,animated:false,frames:1,durationMs:0};
  const manifest=[largeAsset,animationAsset,invalidAsset],backend=await openBackend(root,roomId,()=>manifest,60000),adapter=storageModule.createSteamMediaStorage({rootDir:root,roomId,backend:{origin:backend.origin,key:backend.key}});
  try{
    await adapter.references(manifest.map(asset=>asset.sha256));const opened=mediaObject(await adapter.execute({op:'begin',kind:'image',domainId:null,sha256:largeAsset.sha256,bytes:largeAsset.bytes}),'Begin');await adapter.execute({op:'write',uploadId:opened.uploadId ?? null,offset:0,data:large.subarray(0,1).toString('base64')});await adapter.execute({op:'cancel',uploadId:opened.uploadId ?? null});assert.equal(backend.store.stats().activeUploads,0);
    await assert.rejects(upload(adapter,invalid));assert.equal(backend.store.metadata(invalidAsset.sha256),null);assert.equal(backend.store.stats().stagingBytes,0);
    const begun=mediaObject(await adapter.execute({op:'begin',kind:'image',domainId:null,sha256:animationAsset.sha256,bytes:animation.length}),'Begin');await adapter.execute({op:'write',uploadId:begun.uploadId ?? null,offset:0,data:animation.toString('base64')});
    const database=new DatabaseSync(path.join(root,'.budget.sqlite'),{open:true,readOnly:false,enableForeignKeyConstraints:true,enableDoubleQuotedStringLiterals:false,allowExtension:false});database.exec('BEGIN IMMEDIATE;');let locked=true;
    const finished=adapter.execute({op:'finish',uploadId:begun.uploadId ?? null});const unlock=setTimeout(()=>{database.exec('ROLLBACK;');database.close();locked=false;},120);
    try{assert.deepEqual(parseMediaMetadata(mediaObject(await finished,'Finish').asset ?? null),animationAsset);}finally{clearTimeout(unlock);if(locked){database.exec('ROLLBACK;');database.close();}}
    assert.equal(backend.store.stats().activeUploads,0);const oversized=await backend.post({op:'inventory',extra:'x'.repeat(25000)},backend.key.toString('hex'));assert.equal(oversized.value?.code,'media-limit-exceeded');assert.equal(String(oversized.value?.message).includes(root),false);
    const closeBegin=mediaObject(await adapter.execute({op:'begin',kind:'image',domainId:null,sha256:largeAsset.sha256,bytes:largeAsset.bytes}),'Close begin');assert.equal(typeof closeBegin.uploadId,'string');await adapter.close();assert.equal(backend.store.stats().activeUploads,0);assert.equal(backend.store.stats().stagingBytes,0);
    backend.bridge.close();const closed=await backend.post({op:'inventory'},backend.key.toString('hex'));assert.equal(closed.value?.code,'media-unavailable');
  }finally{await adapter.close();await backend.close();cleanup(root);}
});

test('real HTTP expired reservations free both bridge slots and slow private requests remain bounded',{timeout:10000},async()=>{
  const root=directory(),roomId=randomUUID(),backend=await openBackend(root,roomId,()=>[largeAsset,animationAsset],100);
  /** @type {net.Socket[]} */const stalled=[];
  try{
    const token=backend.key.toString('hex');
    for(const asset of [largeAsset,animationAsset]){const result=await backend.post({op:'begin',kind:'image',domainId:null,sha256:asset.sha256,bytes:asset.bytes},token);assert.equal(result.value?.ok,true);}
    await new Promise(resolve=>setTimeout(resolve,160));assert.equal(backend.store.stats().activeUploads,0);assert.equal(backend.store.stats().stagingBytes,0);
    const retry=await backend.post({op:'begin',kind:'image',domainId:null,sha256:largeAsset.sha256,bytes:largeAsset.bytes},token);assert.equal(retry.value?.ok,true);const uploadId=mediaObject(retry.value?.result,'Retry begin').uploadId;assert.equal((await backend.post({op:'cancel',uploadId:uploadId ?? null},token)).value?.ok,true);
    await Promise.all(Array.from({length:8},async()=>{const socket=net.createConnection({host:'127.0.0.1',port:backend.port});stalled.push(socket);await once(socket,'connect');socket.write('POST /api/steam-media HTTP/1.1\r\nHost: 127.0.0.1\r\nx-deepscord-media-key: '+token+'\r\nContent-Length: 128\r\nConnection: close\r\n\r\n{');}));
    await new Promise(resolve=>setTimeout(resolve,30));const busy=await backend.post({op:'inventory'},token);assert.equal(busy.value?.code,'media-busy');assert.equal(busy.value?.retryAfterMs,50);
    for(const socket of stalled)socket.destroy();await new Promise(resolve=>setTimeout(resolve,30));assert.equal((await backend.post({op:'inventory'},token)).value?.ok,true);
  }finally{for(const socket of stalled)socket.destroy();await backend.close();cleanup(root);}
});

test('real recovery IPC coalesces requests and backend close rejects pending recoveries',{timeout:10000},async()=>{
  const root=directory(),roomId=randomUUID(),backend=await openBackend(root,roomId,()=>[animationAsset,largeAsset],60000),adapter=storageModule.createSteamMediaStorage({rootDir:root,roomId,backend:{origin:backend.origin,key:backend.key}});
  try{
    await adapter.references([animationAsset.sha256,largeAsset.sha256]);const needed=once(backend.channel.port2,'message',{signal:AbortSignal.timeout(5000)}),first=backend.bridge.ensure(animationAsset.sha256),second=backend.bridge.ensure(animationAsset.sha256);assert.equal(first,second);
    assert.deepEqual((await needed)[0],{t:'steam-media-needed',sha256:animationAsset.sha256});await upload(adapter,animation);backend.channel.port2.postMessage({sha256:animationAsset.sha256,ok:true});await Promise.all([first,second]);
    const pending=backend.bridge.ensure(largeAsset.sha256),rejected=assert.rejects(pending,/closed/);backend.bridge.close();await rejected;await assert.rejects(backend.bridge.ensure(largeAsset.sha256),/closed/);
  }finally{await adapter.close();await backend.close();cleanup(root);}
});
