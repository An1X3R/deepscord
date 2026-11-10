// @ts-check
'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
/** @type {typeof import('../public/js/chat-protocol.js')} */
const {parseMediaMetadata,checkMediaKind}=require('./app-server/public/js/chat-protocol.js');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../public/js/sticker-panel.js').StickerItem} StickerItem */
/** @typedef {import('../public/js/sticker-panel.js').StickerPreferences} StickerPreferences */
/** @typedef {{sha256:string,bytes:number,width:number,height:number,animated:boolean,frames:number,durationMs:number}} MediaMetadata */
/** @typedef {{width:number,height:number,animated:boolean,frames:number,durationMs:number}} MediaValidation */
/** @typedef {{version:1,items:StickerItem[],preferences:StickerPreferences}} StickerIndex */
/** @typedef {{directory:string,validate:(data:Buffer,kind:'personal',signal:AbortSignal)=>Promise<MediaValidation>}} StickerStoreOptions */
/** @typedef {{name:string,data:string}} StickerImport */
const MAX_ITEMS=300,MAX_BYTES=160*1024,MAX_TOTAL_BYTES=48*1024*1024;
/** @param {JsonValue|undefined} value @param {string} label @returns {{[key:string]:JsonValue}} */
function object(value,label){if(!value || typeof value!=='object' || Array.isArray(value))throw new TypeError(label+' must be an object');return value;}
/** @param {JsonValue|undefined} value @param {string} label @param {number} maximum @returns {string} */
function text(value,label,maximum){if(typeof value!=='string' || !value.length || value.length>maximum)throw new TypeError(label+' must be a nonempty string of at most '+maximum+' characters');return value;}
/** @param {JsonValue|undefined} value @param {string} label @returns {number} */
function integer(value,label){if(typeof value!=='number' || !Number.isSafeInteger(value) || value<0)throw new TypeError(label+' must be a nonnegative safe integer');return value;}
/** @param {JsonValue|undefined} value @returns {string} */
function hash(value){const result=text(value,'Sticker SHA256',64);if(!/^[a-f0-9]{64}$/.test(result))throw new TypeError('Sticker SHA256 must be 64 lowercase hexadecimal characters');return result;}
/** @param {JsonValue} value @returns {StickerPreferences} */
function preferences(value){const row=object(value,'Sticker preferences');if(row.columns!==4 && row.columns!==5 && row.columns!==6 && row.columns!==8)throw new TypeError('Sticker columns must be 4, 5, 6 or 8');if(row.sort!=='frequency' && row.sort!=='recent' && row.sort!=='added')throw new TypeError('Unsupported sticker sort order');return {columns:row.columns,sort:row.sort};}
/** @param {JsonValue} value @returns {MediaMetadata} */
function metadata(value){return checkMediaKind(parseMediaMetadata(value),'personal');}
/** @param {JsonValue} value @returns {StickerItem} */
function item(value){const row=object(value,'Personal sticker');const media=metadata(value);if(row.kind!=='personal' || row.domainId!==null || typeof row.pinned!=='boolean')throw new TypeError('Personal sticker ownership or pin state is invalid');const id=text(row.id,'Personal sticker ID',80);if(!/^personal-[a-f0-9]{64}$/.test(id))throw new TypeError('Invalid personal sticker ID');return {...media,id,kind:'personal',domainId:null,name:text(row.name,'Sticker name',80),addedAt:integer(row.addedAt,'Sticker added time'),useCount:integer(row.useCount,'Sticker use count'),lastUsedAt:integer(row.lastUsedAt,'Sticker last use time'),pinned:row.pinned};}
/** @param {JsonValue} value @returns {StickerIndex} */
function parseIndex(value){const row=object(value,'Sticker index');if(row.version!==1 || !Array.isArray(row.items) || row.items.length>MAX_ITEMS)throw new TypeError('Sticker index version or item count is invalid');const items=row.items.map(item);if(new Set(items.map(entry=>entry.id)).size!==items.length)throw new TypeError('Sticker index contains duplicate IDs');const sizes=new Map(items.map(entry=>[entry.sha256,entry.bytes]));if([...sizes.values()].reduce((sum,bytes)=>sum+bytes,0)>MAX_TOTAL_BYTES)throw new RangeError('Personal sticker library exceeds 48 MiB');return {version:1,items,preferences:preferences(row.preferences ?? null)};}
/** @param {JsonValue} value @returns {{name:string,data:Buffer}} */
function parseAddition(value){const row=object(value,'Sticker import');if(row.path!==undefined || row.directory!==undefined || row.filename!==undefined)throw new TypeError('Sticker imports do not accept filesystem paths');const name=text(row.name,'Sticker name',80).trim();if(!name)throw new TypeError('Sticker name cannot be blank');const encoded=text(row.data,'Sticker base64 data',Math.ceil(MAX_BYTES/3)*4);if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw new TypeError('Sticker data must be canonical base64');const data=Buffer.from(encoded,'base64');if(data.length<1 || data.length>MAX_BYTES || data.toString('base64')!==encoded)throw new RangeError('Personal sticker AVIF must contain at most 160 KiB');return {name,data};}
/** @param {MediaMetadata} expected @param {MediaMetadata} actual @returns {void} */
function assertMedia(expected,actual){if(expected.sha256!==actual.sha256 || expected.bytes!==actual.bytes || expected.width!==actual.width || expected.height!==actual.height || expected.animated!==actual.animated || expected.frames!==actual.frames || expected.durationMs!==actual.durationMs)throw new TypeError('Personal sticker index differs from its actual AVIF file: '+expected.sha256);}

/** @param {StickerStoreOptions} options */
async function createStickerStore(options){
  if(typeof options.directory!=='string' || !path.isAbsolute(options.directory))throw new TypeError('Personal sticker directory must be an absolute data path');
  if(typeof options.validate!=='function')throw new TypeError('Personal sticker storage requires an AVIF decoder');
  await fs.mkdir(options.directory,{recursive:true});const directory=await fs.realpath(options.directory),indexPath=path.join(directory,'index.json');
  /** @type {StickerIndex} */let state={version:1,items:[],preferences:{columns:6,sort:'frequency'}};
  let disposed=false;
  /** @type {Map<string,MediaMetadata>} */const validated=new Map();
  /** @type {Promise<void>} */let pending=Promise.resolve();
  /** @template T @param {()=>Promise<T>} operation @returns {Promise<T>} */
  function serial(operation){if(disposed)return Promise.reject(new Error('Personal sticker store is closed'));const result=pending.then(()=>{if(disposed)throw new Error('Personal sticker store is closed');return operation();});pending=result.then(()=>{},()=>{});return result;}
  /** @param {string} filename @returns {Promise<Buffer>} */
  async function readFile(filename){const stat=await fs.lstat(filename);if(!stat.isFile() || stat.isSymbolicLink() || stat.size>MAX_BYTES)throw new TypeError('Personal sticker file must be a regular AVIF file within 160 KiB: '+filename);return fs.readFile(filename);}
  /** @param {string} filename @param {Buffer|string} data @returns {Promise<void>} */
  async function atomic(filename,data){const temporary=filename+'.pending-'+randomUUID();let completed=false;try{const file=await fs.open(temporary,'wx',0o600);try{await file.writeFile(data);await file.sync();}finally{await file.close();}await fs.rename(temporary,filename);completed=true;}finally{if(!completed)await fs.rm(temporary,{force:true});}}
  /** @param {Buffer} data @param {AbortSignal} signal @returns {Promise<MediaMetadata>} */
  async function validate(data,signal){
    signal.throwIfAborted();const sha256=createHash('sha256').update(data).digest('hex'),cached=validated.get(sha256);
    if(cached){validated.delete(sha256);validated.set(sha256,cached);return {...cached};}
    const decoded=await options.validate(data,'personal',signal);signal.throwIfAborted();const result=metadata({...decoded,sha256,bytes:data.length});validated.set(sha256,result);
    while(validated.size>MAX_ITEMS){const oldest=validated.keys().next().value;if(oldest===undefined)break;validated.delete(oldest);}
    return result;
  }
  /** @param {StickerIndex} next @returns {Promise<void>} */
  async function persist(next){await atomic(indexPath,JSON.stringify(next));state=next;}
  try{const stat=await fs.lstat(indexPath);if(!stat.isFile() || stat.isSymbolicLink() || stat.size>2*1024*1024)throw new TypeError('Personal sticker index must be a regular file within 2 MiB');state=parseIndex(JSON.parse(await fs.readFile(indexPath,'utf8')));}
  catch(error){if(!(error && typeof error==='object' && 'code' in error && error.code==='ENOENT'))throw error;await persist(state);}
  // Check durable bytes at startup; decode only when an item is actually requested.
  for(const sha256 of new Set(state.items.map(entry=>entry.sha256))){
    const entries=state.items.filter(entry=>entry.sha256===sha256),expected=entries[0],bytes=await readFile(path.join(directory,sha256+'.avif'));
    if(bytes.length!==expected.bytes || createHash('sha256').update(bytes).digest('hex')!==sha256)throw new TypeError('Personal sticker index differs from its actual AVIF file: '+sha256);
    for(const entry of entries)assertMedia(entry,expected);
  }
  /** @returns {Promise<void>} */
  async function cleanOrphans(){
    const referenced=new Set(state.items.map(entry=>entry.sha256));
    for(const entry of await fs.readdir(directory,{withFileTypes:true})){
      const temporary=/^(?:index\.json|[a-f0-9]{64}\.avif)\.pending-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(entry.name);
      if(!temporary && (!/^[a-f0-9]{64}\.avif$/.test(entry.name) || referenced.has(entry.name.slice(0,64))))continue;
      if(!entry.isFile() || entry.isSymbolicLink())throw new TypeError('Unexpected nonregular sticker data file: '+entry.name);
      await fs.unlink(path.join(directory,entry.name));
    }
  }
  await cleanOrphans();
  /** @param {string} id @returns {StickerItem} */
  function find(id){if(typeof id!=='string' || !/^personal-[a-f0-9]{64}$/.test(id))throw new TypeError('Invalid personal sticker ID');const entry=state.items.find(entry=>entry.id===id);if(!entry)throw new RangeError('Personal sticker does not exist: '+id);return entry;}
  /** @returns {Promise<{items:StickerItem[],preferences:StickerPreferences}>} */
  function list(){return serial(async()=>({items:state.items.map(entry=>({...entry})),preferences:{...state.preferences}}));}
  /** @param {JsonValue[]} values @param {AbortSignal} signal @returns {Promise<{items:StickerItem[],addedIds:string[]}>} */
  async function importItems(values,signal){
    signal.throwIfAborted();if(!Array.isArray(values)||values.length>MAX_ITEMS)throw new RangeError('Personal sticker batch is limited to 300 inputs');
    const parsed=values.map(parseAddition);
    /** @type {Map<string,{entry:StickerItem,data:Buffer}>} */const additions=new Map();
    /** @type {StickerItem[]} */const items=[];
    /** @type {Set<string>} */const verified=new Set();
    for(const input of parsed){
      const media=await validate(input.data,signal),existing=state.items.find(entry=>entry.sha256===media.sha256);
      if(existing){if(!verified.has(media.sha256)){assertMedia(existing,await validate(await readFile(path.join(directory,media.sha256+'.avif')),signal));verified.add(media.sha256);}items.push({...existing});continue;}
      let addition=additions.get(media.sha256);
      if(!addition){const entry={...media,id:'personal-'+media.sha256,kind:/** @type {'personal'} */('personal'),domainId:null,name:input.name,addedAt:Date.now(),useCount:0,lastUsedAt:0,pinned:false};addition={entry,data:input.data};additions.set(media.sha256,addition);}
      items.push({...addition.entry});
    }
    if(state.items.length+additions.size>MAX_ITEMS)throw new RangeError('Personal sticker library is limited to 300 items');
    const sizes=new Map(state.items.map(entry=>[entry.sha256,entry.bytes]));for(const [sha256,addition] of additions)sizes.set(sha256,addition.entry.bytes);
    if([...sizes.values()].reduce((sum,bytes)=>sum+bytes,0)>MAX_TOTAL_BYTES)throw new RangeError('Personal sticker library is limited to 48 MiB');
    signal.throwIfAborted();if(!additions.size)return {items,addedIds:[]};
    await cleanOrphans();
    /** @type {string[]} */const written=[];
    try{
      for(const [sha256,addition] of additions){signal.throwIfAborted();const filename=path.join(directory,sha256+'.avif');await atomic(filename,addition.data);written.push(filename);}
      signal.throwIfAborted();const added=[...additions.values()].map(addition=>addition.entry);await persist({...state,items:[...state.items,...added]});
      return {items,addedIds:added.map(entry=>entry.id)};
    }catch(error){
      const cleanup=await Promise.allSettled(written.map(filename=>fs.rm(filename,{force:true}))),failures=cleanup.filter(result=>result.status==='rejected');
      if(failures.length)throw new AggregateError([error,...failures.map(result=>result.reason)],'Personal sticker batch failed and could not remove all uncommitted media');throw error;
    }
  }
  /** @param {StickerImport[]} inputs @param {AbortSignal} signal @returns {Promise<{items:StickerItem[],addedIds:string[]}>} */
  function addBatch(inputs,signal){return serial(()=>importItems(inputs,signal));}
  /** @param {JsonValue} value @param {AbortSignal} signal @returns {Promise<StickerItem>} */
  function add(value,signal){return serial(async()=>{const result=await importItems([value],signal);return result.items[0];});}
  /** @param {string[]} ids @returns {Promise<void>} */
  function removeBatch(ids){return serial(async()=>{
    if(!Array.isArray(ids)||ids.length>MAX_ITEMS)throw new RangeError('Personal sticker removal batch is limited to 300 IDs');
    for(const id of ids)if(typeof id!=='string'||!/^personal-[a-f0-9]{64}$/.test(id))throw new TypeError('Invalid personal sticker ID');
    const removed=new Set(ids),items=state.items.filter(entry=>!removed.has(entry.id));if(items.length===state.items.length)return;
    const retained=new Set(items.map(entry=>entry.sha256)),unreferenced=new Set(state.items.filter(entry=>removed.has(entry.id)&&!retained.has(entry.sha256)).map(entry=>entry.sha256));
    await persist({...state,items});for(const sha256 of unreferenced)await fs.unlink(path.join(directory,sha256+'.avif'));
  });}
  /** @param {string} id @returns {Promise<void>} */
  function remove(id){return serial(async()=>{const entry=find(id),items=state.items.filter(item=>item.id!==id);await persist({...state,items});if(!items.some(item=>item.sha256===entry.sha256))await fs.unlink(path.join(directory,entry.sha256+'.avif'));});}
  /** @param {string} id @returns {Promise<StickerItem>} */
  function pin(id){return serial(async()=>{const entry=find(id),next={...entry,pinned:!entry.pinned};await persist({...state,items:state.items.map(item=>item.id===id ? next : item)});return {...next};});}
  /** @param {string} id @returns {Promise<StickerItem>} */
  function recordUse(id){return serial(async()=>{const entry=find(id);if(entry.useCount===Number.MAX_SAFE_INTEGER)throw new RangeError('Personal sticker use count is exhausted');const next={...entry,useCount:entry.useCount+1,lastUsedAt:Date.now()};await persist({...state,items:state.items.map(item=>item.id===id ? next : item)});return {...next};});}
  /** @param {JsonValue} value @returns {Promise<StickerPreferences>} */
  function setPreferences(value){return serial(async()=>{const parsed=preferences(value);await persist({...state,preferences:parsed});return {...parsed};});}
  /** @param {string} sha256 @param {AbortSignal} signal @returns {Promise<string>} */
  function read(sha256,signal){return serial(async()=>{const digest=hash(sha256),entry=state.items.find(item=>item.sha256===digest);if(!entry)throw new RangeError('Personal sticker hash is not in this library');const bytes=await readFile(path.join(directory,digest+'.avif'));assertMedia(entry,await validate(bytes,signal));return bytes.toString('base64');});}
  /** @returns {Promise<void>} */
  async function destroy(){disposed=true;await pending;validated.clear();}
  return {list,add,addBatch,remove,removeBatch,pin,recordUse,setPreferences,read,destroy};
}
module.exports={createStickerStore};
