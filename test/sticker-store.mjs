// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import storage from '../desktop/sticker-store.cjs';
import codec from '../lib/avif-codec.cjs';

const {createStickerStore}=storage;
const limits={maxBytes:160*1024,maxDimension:360,maxFrames:180,maxDecodedPixels:24*1024*1024,maxDurationMs:10000,timeoutMs:30000};
/** @param {number} seed @returns {Promise<Buffer>} */
async function image(seed){const rgba=new Uint8Array(8*8*4);for(let index=0;index<rgba.length;index++)rgba[index]=(index*seed+seed)%256;return codec.encode({width:8,height:8,timescale:1000,repetitionCount:0,frames:[{rgba,durationTicks:1000}]},{quality:80,speed:10},limits,new AbortController().signal);}
/** @param {Buffer} data @param {string} name @returns {{name:string,data:string}} */
function addition(data,name){return {name,data:data.toString('base64')};}
/** @returns {Promise<string>} */
function directory(){return fs.mkdtemp(path.join(os.tmpdir(),'deepscord-sticker-store-'));}
/** @param {string} directory @returns {Promise<void>} */
async function cleanup(directory){assert.equal(path.dirname(directory),os.tmpdir());assert(path.basename(directory).startsWith('deepscord-sticker-store-'));await fs.rm(directory,{recursive:true,force:true});}

const first=await image(7),second=await image(19);

test('personal AVIF files deduplicate, serialize writes, persist preferences and survive reopening',async()=>{
  const root=await directory();let store=await createStickerStore({directory:root,validate:codec.validate});
  try{
    const signal=new AbortController().signal;
    const items=await Promise.all([store.add(addition(first,'Transparent sticker'),signal),store.add(addition(first,'Same bytes'),signal)]);
    assert.equal(items[0].id,items[1].id);assert.equal((await store.list()).items.length,1);
    assert.equal(items[0].sha256,createHash('sha256').update(first).digest('hex'));
    assert.deepEqual(Buffer.from(await store.read(items[0].sha256,signal),'base64'),first);
    await Promise.all(Array.from({length:24},()=>store.recordUse(items[0].id)));
    await store.pin(items[0].id);await store.setPreferences({columns:8,sort:'recent'});
    const before=await store.list();assert.equal(before.items[0].useCount,24);assert.equal(before.items[0].pinned,true);
    before.items[0].name='Changed caller snapshot';assert.notEqual((await store.list()).items[0].name,before.items[0].name);
    await store.destroy();store=await createStickerStore({directory:root,validate:codec.validate});
    const reopened=await store.list();assert.equal(reopened.items[0].useCount,24);assert.equal(reopened.items[0].pinned,true);assert.deepEqual(reopened.preferences,{columns:8,sort:'recent'});
    assert.equal((await fs.readdir(root)).filter(name=>name.endsWith('.avif')).length,1);
    await store.remove(items[0].id);assert.equal((await store.list()).items.length,0);assert.equal((await fs.readdir(root)).filter(name=>name.endsWith('.avif')).length,0);
  }finally{await store.destroy();await cleanup(root);}
});

test('personal imports reject actual invalid AVIF, path injection, oversized input and canceled work',async()=>{
  const root=await directory(),store=await createStickerStore({directory:root,validate:codec.validate});
  try{
    const signal=new AbortController().signal;
    await assert.rejects(store.add({...addition(first,'Path injection'),path:'../outside.avif'},signal),/filesystem paths/);
    await assert.rejects(store.add(addition(Buffer.alloc(160*1024+1),'Oversized'),signal),/160 KiB|base64/);
    await assert.rejects(store.add(addition(Buffer.from('This is not an AVIF image'),'Invalid image'),signal));
    const canceled=new AbortController();canceled.abort();await assert.rejects(store.add(addition(first,'Canceled'),canceled.signal),{name:'AbortError'});
    await assert.rejects(store.setPreferences({columns:7,sort:'recent'}),/columns/);
    assert.equal((await store.list()).items.length,0);
    const item=await store.add({...addition(first,'Filtered extras'),irrelevant:'discarded'},signal);
    assert.equal('irrelevant' in item,false);assert.equal((await fs.readdir(root)).some(name=>name.includes('.pending-')),false);
  }finally{await store.destroy();await assert.rejects(store.list(),/closed/);await cleanup(root);}
});

test('replacing a stored file with another valid AVIF fails hash checks on read, dedup and reopening',async()=>{
  const root=await directory(),store=await createStickerStore({directory:root,validate:codec.validate});
  try{
    const signal=new AbortController().signal,item=await store.add(addition(first,'Original'),signal);
    await fs.writeFile(path.join(root,item.sha256+'.avif'),second);
    await assert.rejects(store.read(item.sha256,signal),/differs/);
    await assert.rejects(store.add(addition(first,'Duplicate'),signal),/differs/);
    await store.destroy();await assert.rejects(createStickerStore({directory:root,validate:codec.validate}),/differs/);
  }finally{await store.destroy();await cleanup(root);}
});

test('the 300 item cap and final-reference file removal are enforced against persisted indices',async()=>{
  const root=await directory();let store=await createStickerStore({directory:root,validate:codec.validate});
  try{
    const signal=new AbortController().signal,item=await store.add(addition(first,'Shared content'),signal);await store.destroy();
    const aliases=Array.from({length:300},(_,index)=>({...item,id:'personal-'+createHash('sha256').update('reference-'+index).digest('hex')}));
    await fs.writeFile(path.join(root,'index.json'),JSON.stringify({version:1,items:aliases,preferences:{columns:4,sort:'added'}}));
    store=await createStickerStore({directory:root,validate:codec.validate});
    await assert.rejects(store.add(addition(second,'Item 301'),signal),/300/);
    await store.remove(aliases[0].id);assert.equal((await fs.stat(path.join(root,item.sha256+'.avif'))).isFile(),true);
    await Promise.all(aliases.slice(1).map(entry=>store.remove(entry.id)));
    await assert.rejects(fs.stat(path.join(root,item.sha256+'.avif')),{code:'ENOENT'});
    assert.equal((await store.list()).items.length,0);
  }finally{await store.destroy();await cleanup(root);}
});

test('opening a saved library defers decoding and repeated reads verify hashes while reusing bounded metadata',async()=>{
  const root=await directory();let store=await createStickerStore({directory:root,validate:codec.validate});
  let decodes=0;
  /** @type {import('../desktop/sticker-store.cjs').StickerStoreOptions['validate']} */
  const measured=async(bytes,kind,signal)=>{decodes+=1;return codec.validate(bytes,kind,signal);};
  try{
    const signal=new AbortController().signal,one=await store.add(addition(first,'One'),signal),two=await store.add(addition(second,'Two'),signal);
    await store.destroy();store=await createStickerStore({directory:root,validate:measured});
    assert.equal((await store.list()).items.length,2);assert.equal(decodes,0,'Opening the index must not decode offscreen AVIFs');
    for(let index=0;index<20;index++)assert.deepEqual(Buffer.from(await store.read(one.sha256,signal),'base64'),first);
    assert.equal(decodes,1,'Identical verified content only needs one full decode per connector');
    await store.read(two.sha256,signal);assert.equal(decodes,2);
    await fs.writeFile(path.join(root,one.sha256+'.avif'),second);
    await assert.rejects(store.read(one.sha256,signal),/differs/);assert.equal(decodes,2,'Cached metadata never replaces the current file hash check');
  }finally{await store.destroy();await cleanup(root);}
});
