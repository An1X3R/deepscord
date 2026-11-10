// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import media from '../lib/media-store.cjs';
import codec from '../lib/avif-codec.cjs';
import {mediaObject} from '../public/js/chat-protocol.js';

/** @typedef {import('../lib/media-store.cjs').MediaKind} MediaKind */
/** @typedef {import('../lib/media-store.cjs').MediaLimits} MediaLimits */
/** @typedef {ReturnType<typeof media.openMediaStore>} Store */
const {openMediaStore}=media;
/** @type {MediaLimits} */const limits={rootBytes:512*1024*1024,roomBytes:256*1024*1024,stagingBytes:8*1024*1024,concurrentUploads:4,uploadTtlMs:60000,unpublishedTtlMs:300000};
const encodeLimits={maxBytes:1536*1024,maxDimension:1920,maxFrames:180,maxDecodedPixels:24*1024*1024,maxDurationMs:10000,timeoutMs:30000};

/** @param {Buffer} bytes @returns {string} */function sha256(bytes){return createHash('sha256').update(bytes).digest('hex');}
/** @param {number} width @param {number} height @param {number} seed @returns {Uint8Array} */function pixels(width,height,seed){
  const output=new Uint8Array(width*height*4);let value=seed;
  for(let index=0;index<output.length;index++){value=(Math.imul(value,1664525)+1013904223)>>>0;output[index]=value>>>24;}
  return output;
}
/** @param {number} width @param {number} height @param {number} seed @returns {Promise<Buffer>} */function image(width,height,seed){
  return codec.encode({width,height,timescale:1000,repetitionCount:0,frames:[{rgba:pixels(width,height,seed),durationTicks:1000}]},{quality:100,speed:10},encodeLimits,new AbortController().signal);
}
/** @param {Store} store @param {Buffer} bytes @param {MediaKind} kind @returns {Promise<import('../lib/media-store.cjs').MediaAsset>} */async function upload(store,bytes,kind){
  const opened=store.beginUpload({kind,totalBytes:bytes.length,expectedSha256:sha256(bytes)});
  for(let offset=0;offset<bytes.length;offset+=opened.chunkBytes)store.writeChunk(opened.uploadId,offset,bytes.subarray(offset,Math.min(offset+opened.chunkBytes,bytes.length)));
  return store.finishUpload(opened.uploadId);
}
/** @returns {string} */function directory(){return fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-media-'));}
/** @param {string} root @returns {void} */function cleanup(root){assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('deepscord-media-'));fs.rmSync(root,{recursive:true,force:true});}
/** @param {number} milliseconds @returns {Promise<void>} */function delay(milliseconds){return new Promise(resolve=>setTimeout(resolve,milliseconds));}

const first=await image(96,96,7),second=await image(8,8,13),wide=await image(241,1,17);
const animation=await codec.encode({width:12,height:12,timescale:1000,repetitionCount:0,frames:[{rgba:pixels(12,12,23),durationTicks:500},{rgba:pixels(12,12,29),durationTicks:1250}]},{quality:100,speed:10},encodeLimits,new AbortController().signal);

test('real AVIF uploads persist by room/hash, support bounded reads and revalidate existing content for each kind',async()=>{
  const root=directory(),roomId=randomUUID();let store=openMediaStore({rootDir:root,roomId,validate:codec.validate,limits});
  try{
    const asset=await upload(store,first,'server');assert.equal(asset.sha256,sha256(first));assert.equal(asset.width,96);assert.equal(asset.bytes,first.length);
    assert.equal(first.length>16384,true,'The real fixture should exercise multiple chunks');
    const parts=[];for(let offset=0;offset<first.length;offset+=16384)parts.push(store.readRange(asset.sha256,offset,Math.min(16384,first.length-offset)));
    assert.deepEqual(Buffer.concat(parts),first);
    assert.throws(()=>store.readRange(asset.sha256,0,16385),/16384/);
    assert.throws(()=>store.readRange(asset.sha256,first.length,1),/size/);
    assert.equal(store.metadata('0'.repeat(64)),null);assert.throws(()=>store.metadata('invalid'),/SHA256/);
    assert.throws(()=>store.readRange('0'.repeat(64),0,1),/not present/);
    assert.deepEqual(await upload(store,first,'personal'),asset);assert.equal(store.inventory().length,1);
    const widthAsset=await upload(store,wide,'image');assert.equal(widthAsset.width,241);
    await assert.rejects(upload(store,wide,'server'),/width|dimension|240/i);
    assert.deepEqual(store.metadata(widthAsset.sha256),widthAsset);
    const returned=store.inventory();returned[0].width=1;assert.equal(store.metadata(asset.sha256)?.width,96);
    store.replaceReferences({catalog:[asset.sha256],history:[widthAsset.sha256],backupPins:[asset.sha256]});
    store.close();store=openMediaStore({rootDir:root,roomId,validate:codec.validate,limits});
    assert.deepEqual(store.metadata(asset.sha256),asset);assert.deepEqual(store.readRange(asset.sha256,0,first.length<16384?first.length:16384),first.subarray(0,16384));
    assert.deepEqual(store.references(),{catalog:[asset.sha256],history:[widthAsset.sha256],backupPins:[asset.sha256]});
  }finally{store.close();cleanup(root);}
});

test('catalog/history/backup references independently protect real files while unpublished media can be collected',async()=>{
  const root=directory(),roomId=randomUUID(),store=openMediaStore({rootDir:root,roomId,validate:codec.validate,limits:{...limits,unpublishedTtlMs:0}});
  try{
    const asset=await upload(store,first,'server'),unpublished=await upload(store,second,'personal');
    assert.throws(()=>store.replaceReferences({catalog:[],history:[],backupPins:['0'.repeat(64)]}),/not present/);
    store.replaceReferences({catalog:[asset.sha256],history:[asset.sha256],backupPins:[asset.sha256]});
    store.replaceReferences({catalog:[],history:[asset.sha256],backupPins:[asset.sha256]});
    assert.deepEqual(store.collectGarbage().removedHashes,[unpublished.sha256]);assert(store.metadata(asset.sha256));
    store.replaceReferences({catalog:[],history:[asset.sha256],backupPins:[]});assert.deepEqual(store.collectGarbage().removedHashes,[]);
    store.replaceReferences({catalog:[],history:[],backupPins:[]});assert.deepEqual(store.collectGarbage().removedHashes,[asset.sha256]);
    assert.equal(store.stats().roomBytes,0);assert.deepEqual(store.inventory(),[]);
  }finally{store.close();cleanup(root);}
});

test('real multi-frame AVIF metadata survives restart and truncated encoded content never becomes present',async()=>{
  const root=directory(),roomId=randomUUID();let store=openMediaStore({rootDir:root,roomId,validate:codec.validate,limits});
  try{
    const asset=await upload(store,animation,'personal');assert.equal(asset.animated,true);assert.equal(asset.frames,2);assert.equal(asset.durationMs,1750);
    assert.deepEqual(store.readRange(asset.sha256,0,animation.length),animation);
    store.close();store=openMediaStore({rootDir:root,roomId,validate:codec.validate,limits});assert.deepEqual(store.metadata(asset.sha256),asset);
    const truncated=animation.subarray(0,animation.length-8);await assert.rejects(upload(store,truncated,'image'));
    assert.equal(store.metadata(sha256(truncated)),null);assert.deepEqual(store.inventory(),[asset]);assert.equal(store.stats().activeUploads,0);
    assert.deepEqual(fs.readdirSync(path.join(root,roomId,'staging')),[]);
  }finally{store.close();cleanup(root);}
});

test('real staging enforces all reservations, hash/order checks, cancellation and expiration without leftover files',async()=>{
  const root=directory(),roomId=randomUUID();let store=openMediaStore({rootDir:root,roomId,validate:codec.validate,limits:{...limits,roomBytes:first.length,stagingBytes:first.length,concurrentUploads:1,uploadTtlMs:300}});
  try{
    const firstUpload=store.beginUpload({kind:'server',totalBytes:first.length,expectedSha256:sha256(first)});
    assert.throws(()=>store.beginUpload({kind:'personal',totalBytes:second.length,expectedSha256:sha256(second)}),/concurrency/);
    store.cancelUpload(firstUpload.uploadId);assert.equal(store.stats().stagingBytes,0);
    assert.throws(()=>store.writeChunk(firstUpload.uploadId,0,Buffer.from('x')),/unknown/);
    const invalidOffset=store.beginUpload({kind:'server',totalBytes:first.length,expectedSha256:sha256(first)});
    assert.throws(()=>store.writeChunk(invalidOffset.uploadId,1,Buffer.from('x')),/offset/);assert.equal(store.stats().activeUploads,0);
    const invalidHash=store.beginUpload({kind:'personal',totalBytes:second.length,expectedSha256:'0'.repeat(64)});
    store.writeChunk(invalidHash.uploadId,0,second);await assert.rejects(store.finishUpload(invalidHash.uploadId),/SHA256/);assert.equal(store.stats().validations,0);
    const invalidAvif=Buffer.from('This is not a valid AVIF file');
    await assert.rejects(upload(store,invalidAvif,'server'));assert.equal(store.stats().activeUploads,0);
    const incomplete=store.beginUpload({kind:'personal',totalBytes:second.length,expectedSha256:sha256(second)});
    store.writeChunk(incomplete.uploadId,0,second.subarray(0,1));await assert.rejects(store.finishUpload(incomplete.uploadId),/incomplete/);
    const oversizedChunk=store.beginUpload({kind:'server',totalBytes:first.length,expectedSha256:sha256(first)});
    assert.throws(()=>store.writeChunk(oversizedChunk.uploadId,0,Buffer.alloc(16385)),/16384/);
    store.beginUpload({kind:'personal',totalBytes:second.length,expectedSha256:sha256(second)});await delay(350);
    assert.equal(store.stats().activeUploads,0);assert.equal(store.stats().stagingBytes,0);
    assert.deepEqual(fs.readdirSync(path.join(root,roomId,'staging')),[]);
    store.close();store=openMediaStore({rootDir:root,roomId,validate:codec.validate,limits:{...limits,roomBytes:first.length,stagingBytes:first.length,concurrentUploads:1}});
    const accepted=await upload(store,first,'server');store.replaceReferences({catalog:[],history:[],backupPins:[accepted.sha256]});
    assert.throws(()=>store.beginUpload({kind:'personal',totalBytes:second.length,expectedSha256:sha256(second)}),/disk budget/);
    assert(store.metadata(accepted.sha256));
  }finally{store.close();cleanup(root);}
});

test('staging and per-kind limits reject reservations before creating partial files',()=>{
  const root=directory(),roomId=randomUUID(),store=openMediaStore({rootDir:root,roomId,validate:codec.validate,limits:{...limits,stagingBytes:second.length}});
  try{
    assert.throws(()=>store.beginUpload({kind:'server',totalBytes:96*1024+1,expectedSha256:sha256(first)}),/Upload bytes/);
    assert.throws(()=>store.beginUpload({kind:'personal',totalBytes:first.length,expectedSha256:sha256(first)}),/staging/);
    const opened=store.beginUpload({kind:'personal',totalBytes:second.length,expectedSha256:sha256(second)});
    assert.throws(()=>store.beginUpload({kind:'personal',totalBytes:second.length,expectedSha256:sha256(second)}),/staging/);
    store.cancelUpload(opened.uploadId);assert.deepEqual(fs.readdirSync(path.join(root,roomId,'staging')),[]);
  }finally{store.close();cleanup(root);}
});

test('cancelling real decoder validation aborts publication and retains its bounded slot until settlement',async()=>{
  const root=directory(),roomId=randomUUID(),store=openMediaStore({rootDir:root,roomId,validate:codec.validate,limits:{...limits,concurrentUploads:1}});
  try{
    const opened=store.beginUpload({kind:'personal',totalBytes:second.length,expectedSha256:sha256(second)});store.writeChunk(opened.uploadId,0,second);
    const pending=store.finishUpload(opened.uploadId);store.cancelUpload(opened.uploadId);
    assert.equal(store.stats().validations,1);assert.throws(()=>store.beginUpload({kind:'personal',totalBytes:second.length,expectedSha256:sha256(second)}),/concurrency/);
    await assert.rejects(pending,/cancel|abort|expired/i);
    const deadline=Date.now()+5000;while(store.stats().validations>0 && Date.now()<deadline)await delay(10);
    assert.equal(store.stats().validations,0);assert.equal(store.metadata(sha256(second)),null);assert.equal(store.stats().roomBytes,0);
    assert.deepEqual(fs.readdirSync(path.join(root,roomId,'staging')),[]);
    const retry=store.beginUpload({kind:'personal',totalBytes:second.length,expectedSha256:sha256(second)});store.cancelUpload(retry.uploadId);
  }finally{store.close();cleanup(root);}
});

test('restart removes owned interrupted uploads and orphans but indexed corruption fails explicitly',async()=>{
  const root=directory(),roomId=randomUUID();let store=openMediaStore({rootDir:root,roomId,validate:codec.validate,limits});let open=true;
  try{
    const asset=await upload(store,first,'server');store.close();open=false;
    const staging=path.join(root,roomId,'staging'),objects=path.join(root,roomId,'objects');
    fs.writeFileSync(path.join(staging,randomUUID()+'.upload'),second);
    fs.writeFileSync(path.join(objects,sha256(second)+'.avif'),second);
    store=openMediaStore({rootDir:root,roomId,validate:codec.validate,limits});open=true;
    assert.deepEqual(fs.readdirSync(staging),[]);assert.equal(fs.existsSync(path.join(objects,sha256(second)+'.avif')),false);assert(store.metadata(asset.sha256));
    assert.throws(()=>openMediaStore({rootDir:root,roomId,validate:codec.validate,limits}),/already open/);
    store.replaceReferences({catalog:[],history:[sha256(second)],backupPins:[]});store.close();open=false;
    fs.writeFileSync(path.join(objects,sha256(second)+'.avif'),second);
    store=openMediaStore({rootDir:root,roomId,validate:codec.validate,limits});open=true;
    assert.equal(store.metadata(sha256(second)),null);assert.equal(store.stats().roomBytes,first.length+second.length);
    assert.equal(fs.existsSync(path.join(objects,sha256(second)+'.avif')),true,'A history reference retains an unindexed orphan without advertising it');
    assert.deepEqual(store.collectGarbage().removedHashes,[]);assert(store.metadata(asset.sha256),'Fresh unpublished media retains its grace period');
    store.replaceReferences({catalog:[],history:[],backupPins:[]});store.collectGarbage();assert.equal(store.stats().roomBytes,first.length);
    store.close();open=false;fs.writeFileSync(path.join(objects,asset.sha256+'.avif'),Buffer.alloc(first.length));
    assert.throws(()=>openMediaStore({rootDir:root,roomId,validate:codec.validate,limits}),/integrity/);
    assert.equal(fs.existsSync(path.join(root,roomId,'store.lock')),false);
  }finally{if(open)store.close();cleanup(root);}
});

test('a failed index commit never advertises the renamed file and recovery accounts for the orphan',async()=>{
  const root=directory(),roomId=randomUUID(),store=openMediaStore({rootDir:root,roomId,validate:codec.validate,limits});
  const index=path.join(root,roomId,'index.json'),readOnlyTarget=process.platform==='win32'?index:path.dirname(index);
  try{
    fs.chmodSync(readOnlyTarget,process.platform==='win32'?0o400:0o500);
    await assert.rejects(upload(store,second,'personal'));
    assert.equal(store.metadata(sha256(second)),null);assert.equal(store.stats().roomBytes,second.length);
    assert.deepEqual(fs.readdirSync(path.join(root,roomId,'staging')),[]);
    fs.chmodSync(readOnlyTarget,0o700);store.collectGarbage();assert.equal(store.stats().roomBytes,0);
  }finally{fs.chmodSync(readOnlyTarget,0o700);store.close();cleanup(root);}
});

test('real concurrent processes reserve one shared root budget and recover crashed room ownership without exceeding it',async()=>{
  const temporary=directory(),root=path.join(temporary,'cache'),source=path.join(temporary,'source.avif'),roomIds=[randomUUID(),randomUUID()],rootBytes=Math.floor(first.length*1.5);fs.writeFileSync(source,first);
  /** @type {import('node:child_process').ChildProcess[]} */const children=[];
  /** @param {import('node:child_process').ChildProcess} child @param {string} op @returns {Promise<{[key:string]:import('../public/js/network-protocol.js').JsonValue}>} */async function command(child,op){const answer=once(child,'message',{signal:AbortSignal.timeout(5000)});child.send({op});return mediaObject((await answer)[0],'Budget child reply');}
  try{
    const ready=roomIds.map(roomId=>{
      const child=fork(new URL('media-store-budget-worker.mjs',import.meta.url),[JSON.stringify({rootDir:root,source,roomId,rootBytes})],{stdio:['ignore','pipe','pipe','ipc']});children.push(child);
      child.stdout?.resume();child.stderr?.resume();return once(child,'message',{signal:AbortSignal.timeout(5000)});
    });
    const started=await Promise.all(ready);for(const [reply] of started)assert.equal(mediaObject(reply,'Ready reply').type,'ready');
    const attempts=await Promise.all(children.map(child=>command(child,'reserve'))),winner=attempts.findIndex(reply=>reply.type==='reserved'),loser=winner===0?1:0;
    assert(winner>=0);assert.equal(attempts.filter(reply=>reply.type==='reserved').length,1);assert.equal(attempts[loser].type,'failed');assert.match(String(attempts[loser].message),/Root media disk budget/);
    assert.equal(fs.readdirSync(path.join(root,'.reservations')).length,1,'A zero-byte staging file must still consume its complete declared reservation');
    const written=await command(children[winner],'write');assert.equal(written.type,'written');
    const stopped=once(children[winner],'exit');children[winner].kill();await stopped;
    const recovered=openMediaStore({rootDir:root,roomId:roomIds[winner],validate:codec.validate,limits:{...limits,rootBytes}});recovered.close();
    assert.deepEqual(fs.readdirSync(path.join(root,roomIds[winner],'staging')),[]);assert.equal(fs.readdirSync(path.join(root,'.reservations')).length,0);
    assert.equal((await command(children[loser],'reserve')).type,'reserved');assert.equal((await command(children[loser],'write')).type,'written');assert.equal((await command(children[loser],'finish')).type,'finished');
    let actual=0;for(const roomId of roomIds)for(const folder of ['objects','staging'])for(const file of fs.readdirSync(path.join(root,roomId,folder)))actual+=fs.lstatSync(path.join(root,roomId,folder,file)).size;
    assert.equal(actual,first.length);assert(actual<=rootBytes);assert.equal(fs.readdirSync(path.join(root,'.reservations')).length,0);
    assert.throws(()=>openMediaStore({rootDir:root,roomId:roomIds[winner],validate:codec.validate,limits:{...limits,rootBytes:rootBytes+1}}),/same explicit rootBytes/);
  }finally{
    for(const child of children)if(child.exitCode===null && child.signalCode===null){const stopped=once(child,'exit');child.kill();await stopped;}
    cleanup(temporary);
  }
});

test('root budget scans reject directory links without following them or creating objects in their targets',()=>{
  const root=directory(),outside=directory(),roomId=randomUUID(),linkedRoom=randomUUID(),link=path.join(root,linkedRoom),sentinel=path.join(outside,'sentinel.txt');fs.writeFileSync(sentinel,'untouched');
  const store=openMediaStore({rootDir:root,roomId,validate:codec.validate,limits});
  try{
    fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');
    assert.throws(()=>store.beginUpload({kind:'personal',totalBytes:second.length,expectedSha256:sha256(second)}),/Unexpected.*root entry|link|reparse/);
    assert.throws(()=>openMediaStore({rootDir:root,roomId:linkedRoom,validate:codec.validate,limits}),/link|reparse/);
    assert.equal(fs.existsSync(path.join(outside,'objects')),false);assert.equal(fs.readFileSync(sentinel,'utf8'),'untouched');assert.equal(store.stats().activeUploads,0);
    fs.unlinkSync(link);const opened=store.beginUpload({kind:'personal',totalBytes:second.length,expectedSha256:sha256(second)});store.cancelUpload(opened.uploadId);
  }finally{if(fs.existsSync(link))fs.unlinkSync(link);store.close();cleanup(root);cleanup(outside);}
});
