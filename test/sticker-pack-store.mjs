// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import storage from '../desktop/sticker-store.cjs';
import codec from '../lib/avif-codec.cjs';

const limits={maxBytes:160*1024,maxDimension:360,maxFrames:180,maxDecodedPixels:24*1024*1024,maxDurationMs:10000,timeoutMs:30000};
/** @param {number} seed @returns {Promise<Buffer>} */
async function image(seed){const rgba=new Uint8Array(8*8*4);for(let index=0;index<rgba.length;index++)rgba[index]=(index*seed+seed)%256;return codec.encode({width:8,height:8,timescale:1000,repetitionCount:0,frames:[{rgba,durationTicks:1000}]},{quality:80,speed:10},limits,new AbortController().signal);}
/** @param {Buffer} bytes @param {string} name @returns {{name:string,data:string}} */
function input(bytes,name){return {name,data:bytes.toString('base64')};}
/** @param {string} root @returns {Promise<void>} */
async function cleanup(root){assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('deepscord-sticker-pack-'));await fs.rm(root,{recursive:true,force:true});}
const first=await image(7),second=await image(19),third=await image(31);

test('pack batches deduplicate content, preserve existing metadata and remove only their new references',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'deepscord-sticker-pack-'));let store=await storage.createStickerStore({directory:root,validate:codec.validate});
  try{
    const signal=new AbortController().signal,existing=await store.add(input(first,'My original'),signal);await store.pin(existing.id);await store.recordUse(existing.id);await store.setPreferences({columns:8,sort:'recent'});
    const before=await store.list(),batch=await store.addBatch([input(first,'Pack replacement'),input(second,'Pack new'),input(second,'Repeated bytes'),input(third,'Pack third')],signal);
    assert.deepEqual(batch.items[0],before.items[0]);assert.equal(batch.items[1].id,batch.items[2].id);assert.equal(batch.items[2].name,'Pack new');assert.equal(batch.addedIds.length,2);
    assert.equal((await store.list()).items.length,3);assert.equal((await fs.readdir(root)).filter(name=>name.endsWith('.avif')).length,3);
    assert.deepEqual((await store.addBatch([input(second,'Reimport')],signal)).addedIds,[]);
    await store.destroy();store=await storage.createStickerStore({directory:root,validate:codec.validate});
    await store.removeBatch(batch.addedIds);await store.removeBatch(batch.addedIds);assert.deepEqual(await store.list(),before);
    assert.equal((await fs.readdir(root)).filter(name=>name.endsWith('.avif')).length,1);
  }finally{await store.destroy();await cleanup(root);}
});

test('batch validation, cancellation and failed index writes leave no visible partial import',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'deepscord-sticker-pack-')),store=await storage.createStickerStore({directory:root,validate:codec.validate});
  try{
    const signal=new AbortController().signal;await store.add(input(first,'Existing'),signal);const before=await store.list(),durable=await fs.readFile(path.join(root,'index.json'),'utf8');
    await assert.rejects(store.addBatch([input(second,'Valid first'),input(Buffer.from('Incomplete AVIF'),'Unfinished export')],signal));
    const canceled=new AbortController();canceled.abort();await assert.rejects(store.addBatch([input(second,'Canceled')],canceled.signal),{name:'AbortError'});
    await fs.rename(path.join(root,'index.json'),path.join(root,'saved-index.json'));await fs.mkdir(path.join(root,'index.json'));
    try{await assert.rejects(store.addBatch([input(second,'One'),input(third,'Two')],signal));}
    finally{await fs.rmdir(path.join(root,'index.json'));await fs.rename(path.join(root,'saved-index.json'),path.join(root,'index.json'));}
    assert.deepEqual(await store.list(),before);assert.equal(await fs.readFile(path.join(root,'index.json'),'utf8'),durable);assert.equal((await fs.readdir(root)).filter(name=>name.endsWith('.avif')).length,1);assert.equal((await fs.readdir(root)).some(name=>name.includes('.pending-')),false);
    const imported=await store.addBatch([input(second,'Recovered operation'),input(third,'Third')],signal);assert.equal(imported.addedIds.length,2);
    await assert.rejects(store.removeBatch([imported.addedIds[0],'invalid-id']),/Invalid personal sticker ID/);assert.equal((await store.list()).items.length,3);
  }finally{await store.destroy();await cleanup(root);}
});

test('combined batch count is checked before writing new media or changing the index',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'deepscord-sticker-pack-'));let store=await storage.createStickerStore({directory:root,validate:codec.validate});
  try{
    const signal=new AbortController().signal,original=await store.add(input(first,'Shared reference'),signal);await store.destroy();
    const aliases=Array.from({length:299},(_,index)=>({...original,id:'personal-'+createHash('sha256').update('reference-'+index).digest('hex')}));
    await fs.writeFile(path.join(root,'index.json'),JSON.stringify({version:1,items:aliases,preferences:{columns:6,sort:'frequency'}}));store=await storage.createStickerStore({directory:root,validate:codec.validate});
    await assert.rejects(store.addBatch([input(second,'Item 300'),input(third,'Item 301')],signal),/300/);assert.equal((await store.list()).items.length,299);assert.equal((await fs.readdir(root)).filter(name=>name.endsWith('.avif')).length,1);
    const batch=await store.addBatch([input(second,'Item 300'),input(second,'Duplicate 300')],signal);assert.equal(batch.addedIds.length,1);assert.equal((await store.list()).items.length,300);
    await store.removeBatch(aliases.map(entry=>entry.id));assert.equal((await store.list()).items.length,1);assert.equal((await fs.readdir(root)).filter(name=>name.endsWith('.avif')).length,1);
  }finally{await store.destroy();await cleanup(root);}
});

test('canceling a running real AVIF decode settles and leaves the serial store usable',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'deepscord-sticker-pack-')),store=await storage.createStickerStore({directory:root,validate:codec.validate});
  try{
    const controller=new AbortController(),operation=store.addBatch([input(first,'First'),input(second,'Second')],controller.signal);
    queueMicrotask(()=>controller.abort());await assert.rejects(operation,{name:'AbortError'});
    assert.equal((await store.list()).items.length,0);assert.deepEqual(await fs.readdir(root),['index.json']);
    const imported=await store.addBatch([input(third,'After cancellation')],new AbortController().signal);assert.equal(imported.addedIds.length,1);assert.equal((await store.list()).items.length,1);
  }finally{await store.destroy();await cleanup(root);}
});
