// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import media from '../lib/media-store.cjs';
import validators from '../lib/media-validator.cjs';
import codec from '../lib/avif-codec.cjs';
import content from '../lib/content-crypto.cjs';
import http from 'node:http';
import {once} from 'node:events';
import steamBackend from '../lib/steam-media-backend.cjs';
import roomMedia from '../lib/room-media.cjs';
import replicas from '../desktop/media-replicas.cjs';
import steamStorage from '../desktop/steam-media-storage.cjs';
import {setTimeout as delay} from 'node:timers/promises';
import {parseMediaMetadata,checkMediaKind,parseMediaRequest,mediaObject,parseMediaKind} from '../public/js/chat-protocol.js';

/** @typedef {ReturnType<typeof media.openMediaStore>} Store */
/** @typedef {import('../lib/media-store.cjs').MediaKind} MediaKind */
/** @typedef {import('../lib/media-store.cjs').MediaAsset} MediaAsset */
/** @type {import('../lib/media-store.cjs').MediaLimits} */
const limits={rootBytes:32*1024*1024,roomBytes:16*1024*1024,stagingBytes:8*1024*1024,concurrentUploads:2,uploadTtlMs:60000,unpublishedTtlMs:300000};
const encodeLimits={maxBytes:160*1024,maxDimension:240,maxFrames:180,maxDecodedPixels:24*1024*1024,maxDurationMs:10000,timeoutMs:30000};

/** @param {Store} store @param {Buffer} bytes @param {MediaKind} kind @returns {Promise<MediaAsset>} */
async function uploadLegacy(store,bytes,kind){
  const started=store.beginUpload({kind,totalBytes:bytes.length,expectedSha256:content.contentDigest(bytes)});
  for(let offset=0;offset<bytes.length;offset+=started.chunkBytes)store.writeChunk(started.uploadId,offset,bytes.subarray(offset,offset+started.chunkBytes));
  return store.finishUpload(started.uploadId);
}
/** @param {Store} store @param {Buffer} bytes @param {MediaKind} kind @returns {Promise<MediaAsset>} */
async function uploadEncrypted(store,bytes,kind){
  const request=parseMediaRequest({requestId:'encrypted_upload',op:'begin',kind,sha256:content.contentDigest(bytes),bytes:bytes.length,domainId:null,encrypted:true});
  assert.equal(request.op,'begin');
  if(request.op!=='begin')throw new TypeError('Expected a begin request');
  const started=store.beginUpload({kind:request.kind,totalBytes:request.bytes,expectedSha256:request.sha256,...(request.encrypted===true?{encrypted:/** @type {const} */(true)}:{})});
  for(let offset=0;offset<bytes.length;offset+=started.chunkBytes)store.writeChunk(started.uploadId,offset,bytes.subarray(offset,offset+started.chunkBytes));
  return store.finishUpload(started.uploadId);
}
/** @param {Store} store @param {MediaAsset} asset @returns {Buffer} */
function readAsset(store,asset){
  /** @type {Buffer[]} */const chunks=[];
  for(let offset=0;offset<asset.bytes;offset+=16384)chunks.push(store.readRange(asset.sha256,offset,Math.min(16384,asset.bytes-offset)));
  return Buffer.concat(chunks);
}
/** @param {number} frames @returns {Promise<Buffer>} */
function fixture(frames){
  return codec.encode({width:96,height:96,timescale:1000,repetitionCount:0,frames:Array.from({length:frames},()=>({rgba:new Uint8Array(randomBytes(96*96*4)),durationTicks:500}))},{quality:100,speed:10},encodeLimits,new AbortController().signal);
}
/** @param {string} root @returns {void} */
function cleanup(root){
  assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('deepscord-content-media-'));
  fs.rmSync(root,{recursive:true,force:true});
}

test('real encrypted AVIF survives chunk upload, ciphertext disk reads, legacy index migration and restart',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-content-media-')),roomId=randomUUID(),key=content.generateContentKey();
  const validator=validators.createMediaValidator({maxPending:2}),encryptedValidator=validators.createEncryptedMediaValidator({roomId});
  let store=media.openMediaStore({rootDir:root,roomId,validate:validator.validate,limits});
  try{
    const plaintext=await fixture(1),decoded=await codec.validate(plaintext,'server',new AbortController().signal);
    const legacy=await uploadLegacy(store,plaintext,'server');
    assert.equal(legacy.encrypted,undefined);
    store.close();
    store=media.openMediaStore({rootDir:root,roomId,validate:validator.validate,validateEncrypted:encryptedValidator.validate,limits});
    assert.deepEqual(store.inventory(),[legacy]);
    const sealed=content.sealFile({version:1,roomId,keyId:key.id,nonce:randomBytes(12).toString('base64url'),kind:'server',bytes:plaintext.length,width:decoded.width,height:decoded.height,animated:decoded.animated,frames:decoded.frames,durationMs:decoded.durationMs},key.key,plaintext);
    const asset=await uploadEncrypted(store,sealed,'server');
    assert.equal(asset.encrypted,true);assert.equal(asset.bytes,sealed.length);assert.equal(asset.sha256,content.contentDigest(sealed));
    assert.notEqual(asset.sha256,legacy.sha256);assert.deepEqual(checkMediaKind(parseMediaMetadata(asset),'server'),asset);
    assert.deepEqual(readAsset(store,asset),sealed);assert.deepEqual(readAsset(store,legacy),plaintext);
    assert.deepEqual(fs.readFileSync(path.join(root,roomId,'objects',asset.sha256+'.avif')),sealed);
    assert.equal(store.stats().roomBytes,plaintext.length+sealed.length);
    store.replaceReferences({catalog:[asset.sha256],history:[legacy.sha256],backupPins:[asset.sha256]});
    store.close();
    store=media.openMediaStore({rootDir:root,roomId,validate:validator.validate,validateEncrypted:encryptedValidator.validate,limits});
    assert.deepEqual(store.metadata(asset.sha256),asset);assert.deepEqual(store.metadata(legacy.sha256),legacy);
    const opened=content.openFile(roomId,key.key,readAsset(store,asset));
    assert.deepEqual(opened.bytes,plaintext);
    const verified=await codec.validate(opened.bytes,'server',new AbortController().signal);
    assert.equal(verified.width,asset.width);assert.equal(verified.height,asset.height);assert.equal(verified.frames,asset.frames);
    assert.deepEqual(store.collectGarbage(),{removedHashes:[],freedBytes:0});
    assert.deepEqual(store.purgeUnreferenced([legacy.sha256,asset.sha256]),{removedHashes:[],freedBytes:0});
    store.replaceReferences({catalog:[asset.sha256],history:[],backupPins:[asset.sha256]});
    assert.deepEqual(store.purgeUnreferenced([legacy.sha256,asset.sha256]),{removedHashes:[legacy.sha256],freedBytes:plaintext.length});
    assert.deepEqual(store.inventory(),[asset]);
  }finally{store.close();validator.close();encryptedValidator.close();cleanup(root);}
});

test('real animated encrypted AVIF uses envelope byte quotas and preserves playback metadata',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-content-media-')),roomId=randomUUID(),key=content.generateContentKey();
  const plaintext=await fixture(2),decoded=await codec.validate(plaintext,'personal',new AbortController().signal);
  const sealed=content.sealFile({version:1,roomId,keyId:key.id,nonce:randomBytes(12).toString('base64url'),kind:'personal',bytes:plaintext.length,width:decoded.width,height:decoded.height,animated:decoded.animated,frames:decoded.frames,durationMs:decoded.durationMs},key.key,plaintext);
  const encryptedValidator=validators.createEncryptedMediaValidator({roomId}),validator=validators.createMediaValidator({maxPending:2});
  const exactLimits={...limits,rootBytes:sealed.length,roomBytes:sealed.length,stagingBytes:sealed.length};
  let store=media.openMediaStore({rootDir:root,roomId,validate:validator.validate,validateEncrypted:encryptedValidator.validate,limits:exactLimits});
  try{
    const asset=await uploadEncrypted(store,sealed,'personal');
    assert.equal(asset.animated,true);assert.equal(asset.frames,2);assert.equal(asset.durationMs,1000);
    assert.equal(store.stats().roomBytes,sealed.length);assert.equal(store.stats().stagingBytes,0);
    store.close();store=media.openMediaStore({rootDir:root,roomId,validate:validator.validate,validateEncrypted:encryptedValidator.validate,limits:exactLimits});
    assert.deepEqual(store.inventory(),[asset]);assert.deepEqual(content.openFile(roomId,key.key,readAsset(store,asset)).bytes,plaintext);
  }finally{store.close();validator.close();encryptedValidator.close();cleanup(root);}
});

test('real replica stores copy encrypted personal media with its original purpose and reopen ciphertext',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-content-media-')),roomId=randomUUID(),key=content.generateContentKey();
  const plaintext=await fixture(2),decoded=await codec.validate(plaintext,'personal',new AbortController().signal);
  const sealed=content.sealFile({version:1,roomId,keyId:key.id,nonce:randomBytes(12).toString('base64url'),kind:'personal',bytes:plaintext.length,width:decoded.width,height:decoded.height,animated:decoded.animated,frames:decoded.frames,durationMs:decoded.durationMs},key.key,plaintext);
  const hash=content.contentDigest(sealed),a=steamStorage.createSteamMediaStorage({rootDir:path.join(root,'a'),roomId,backend:null});
  let b=steamStorage.createSteamMediaStorage({rootDir:path.join(root,'b'),roomId,backend:null});
  /** @type {Map<string,ReturnType<typeof replicas.createMediaReplicas>>} */const peers=new Map();
  /** @type {Error[]} */const errors=[];
  /** @param {string} selfId @param {ReturnType<typeof steamStorage.createSteamMediaStorage>} storage */
  function peer(selfId,storage){
    return replicas.createMediaReplicas({selfId,storage,send:async(id,session,payload)=>{await delay(0);const target=peers.get(id);if(!target)throw new Error('Replica transport has no peer '+id);await target.receive(selfId,session,payload);},onStatus:()=>{},reportError:error=>errors.push(error)});
  }
  const replicaA=peer('101',a),replicaB=peer('202',b);peers.set('101',replicaA);peers.set('202',replicaB);
  let replicaBClosed=false;
  try{
    await a.references([hash]);
    const started=mediaObject(await a.execute({op:'begin',kind:'personal',domainId:null,sha256:hash,bytes:sealed.length,encrypted:true}),'Encrypted replica begin');
    if(typeof started.uploadId!=='string')throw new TypeError('Encrypted replica upload requires an ID');
    for(let offset=0;offset<sealed.length;offset+=16384)await a.execute({op:'write',uploadId:started.uploadId,offset,data:sealed.subarray(offset,offset+16384).toString('base64')});
    const asset=parseMediaMetadata(mediaObject(await a.execute({op:'finish',uploadId:started.uploadId}),'Encrypted replica finish').asset??null);
    assert.equal(asset.mediaKind,'personal');assert.equal(asset.encrypted,true);
    await Promise.all([replicaA.update({roomId,assets:[asset],members:['101'],ownerId:'101'}),replicaB.update({roomId,assets:[asset],members:['202'],ownerId:'202'})]);
    const shared={roomId,assets:[asset],members:['101','202'],ownerId:'101'};
    await Promise.all([replicaA.update(shared),replicaB.update(shared)]);
    const deadline=Date.now()+15000;
    while(true){
      const inventory=mediaObject(await b.execute({op:'inventory'}),'Encrypted replica inventory');
      if(Array.isArray(inventory.assets) && inventory.assets.some(value=>parseMediaMetadata(value).sha256===hash))break;
      if(Date.now()>deadline)throw new Error('Encrypted replica did not reach durable storage');
      await delay(25);
    }
    await replicaB.close();replicaBClosed=true;await b.close();
    b=steamStorage.createSteamMediaStorage({rootDir:path.join(root,'b'),roomId,backend:null});await b.references([hash]);
    const restored=parseMediaMetadata(mediaObject(await b.execute({op:'info',sha256:hash}),'Restored encrypted metadata').asset??null);
    assert.deepEqual(restored,asset);assert.equal(parseMediaKind(restored.mediaKind),'personal');
    /** @type {Buffer[]} */const chunks=[];
    for(let offset=0;offset<sealed.length;offset+=16384){const response=mediaObject(await b.execute({op:'read',sha256:hash,offset,length:Math.min(16384,sealed.length-offset)}),'Restored encrypted bytes');if(typeof response.data!=='string')throw new TypeError('Encrypted replica read requires base64 bytes');chunks.push(Buffer.from(response.data,'base64'));}
    assert.deepEqual(Buffer.concat(chunks),sealed);assert.deepEqual(content.openFile(roomId,key.key,Buffer.concat(chunks)).bytes,plaintext);
    assert.deepEqual(errors,[]);
  }finally{await replicaA.close();if(!replicaBClosed)await replicaB.close();await a.close();await b.close();cleanup(root);}
});

test('real loopback backup backend stores encrypted server media without changing its purpose',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-content-media-')),roomId=randomUUID(),key=content.generateContentKey();
  const plaintext=await fixture(1),decoded=await codec.validate(plaintext,'server',new AbortController().signal);
  const sealed=content.sealFile({version:1,roomId,keyId:key.id,nonce:randomBytes(12).toString('base64url'),kind:'server',bytes:plaintext.length,width:decoded.width,height:decoded.height,animated:decoded.animated,frames:decoded.frames,durationMs:decoded.durationMs},key.key,plaintext);
  const asset=parseMediaMetadata({...decoded,sha256:content.contentDigest(sealed),bytes:sealed.length,encrypted:true,mediaKind:'server'});
  const validator=validators.createMediaValidator({maxPending:2}),encryptedValidator=validators.createEncryptedMediaValidator({roomId});
  const store=media.openMediaStore({rootDir:root,roomId,validate:validator.validate,validateEncrypted:encryptedValidator.validate,limits});
  const token=randomBytes(32),bridge=steamBackend.createSteamMediaBackend({key:token,storage:store,manifest:()=>[asset],send:()=>{}});
  /** @type {Error[]} */const errors=[];
  const server=http.createServer((request,response)=>{void bridge.handle(request,response).catch(error=>{const failure=error instanceof Error?error:new TypeError(String(error));errors.push(failure);response.destroy(failure);});});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address || typeof address==='string')throw new TypeError('Backup server requires a loopback port');
  const remote=steamStorage.createSteamMediaStorage({rootDir:root,roomId,backend:{origin:'http://127.0.0.1:'+address.port,key:token}});
  try{
    await remote.references([asset.sha256]);
    const started=mediaObject(await remote.execute({op:'begin',kind:'server',domainId:null,sha256:asset.sha256,bytes:asset.bytes,encrypted:true}),'Encrypted backup begin');
    if(typeof started.uploadId!=='string')throw new TypeError('Encrypted backup requires an upload ID');
    for(let offset=0;offset<sealed.length;offset+=16384)await remote.execute({op:'write',uploadId:started.uploadId,offset,data:sealed.subarray(offset,offset+16384).toString('base64')});
    const finished=parseMediaMetadata(mediaObject(await remote.execute({op:'finish',uploadId:started.uploadId}),'Encrypted backup finish').asset??null);
    assert.deepEqual(finished,asset);assert.deepEqual(store.inventory(),[asset]);assert.deepEqual(readAsset(store,asset),sealed);
    assert.deepEqual(mediaObject(await remote.execute({op:'inventory'}),'Encrypted backend inventory').assets,[asset]);
    assert.deepEqual(errors,[]);
  }finally{await remote.close();bridge.close();server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve(undefined)));store.close();validator.close();encryptedValidator.close();cleanup(root);}
});

test('migration owner can retain more than 32 normally uploaded encrypted replacements',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-content-media-')),roomId=randomUUID(),key=content.generateContentKey(),memberKey=randomBytes(32).toString('base64');
  const plaintext=await codec.encode({width:1,height:1,timescale:1000,repetitionCount:0,frames:[{rgba:new Uint8Array([128,64,32,255]),durationTicks:1000}]},{quality:100,speed:10},encodeLimits,new AbortController().signal);
  const decoded=await codec.validate(plaintext,'personal',new AbortController().signal),validator=validators.createMediaValidator({maxPending:2}),encryptedValidator=validators.createEncryptedMediaValidator({roomId});
  const store=media.openMediaStore({rootDir:root,roomId,validate:validator.validate,validateEncrypted:encryptedValidator.validate,limits});
  const actor={id:'migration_owner',memberKey},connector=roomMedia.createRoomMedia({storage:store,getReferences:()=>[],canManage:()=>false,getMigrationOwnerKey:()=>memberKey});
  /** @type {MediaAsset[]} */const uploaded=[];
  try{
    for(let index=0;index<33;index++){
      if(index===16 || index===32)await delay(1000);
      const sealed=content.sealFile({version:1,roomId,keyId:key.id,nonce:randomBytes(12).toString('base64url'),kind:'personal',bytes:plaintext.length,width:decoded.width,height:decoded.height,animated:decoded.animated,frames:decoded.frames,durationMs:decoded.durationMs},key.key,plaintext);
      const started=mediaObject(await connector.execute(actor,{requestId:'begin_'+index,op:'begin',kind:'personal',domainId:null,sha256:content.contentDigest(sealed),bytes:sealed.length,encrypted:true}),'Migration begin');
      if(typeof started.uploadId!=='string')throw new TypeError('Migration replacement requires an upload ID');
      await connector.execute(actor,{requestId:'write_'+index,op:'write',uploadId:started.uploadId,offset:0,data:sealed.toString('base64')});
      const finished=mediaObject(await connector.execute(actor,{requestId:'finish_'+index,op:'finish',uploadId:started.uploadId}),'Migration finish');
      uploaded.push(parseMediaMetadata(finished.asset??null));
    }
    assert.equal(uploaded.length,33);assert.equal(store.inventory().length,33);
    for(const asset of uploaded)assert.deepEqual(connector.authorizeAttachment(actor,asset),asset);
  }finally{connector.dropActor(actor.id);store.close();validator.close();encryptedValidator.close();cleanup(root);}
});
