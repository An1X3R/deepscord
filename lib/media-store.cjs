// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash,randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {'server'|'personal'|'image'} MediaKind */
/** @typedef {{width:number,height:number,animated:boolean,frames:number,durationMs:number,encrypted?:true,mediaKind?:MediaKind}} MediaValidation */
/** @typedef {{sha256:string,bytes:number,width:number,height:number,animated:boolean,frames:number,durationMs:number,encrypted?:true,mediaKind?:MediaKind}} MediaAsset */
/** @typedef {{catalog:string[],history:string[],backupPins:string[]}} MediaReferences */
/** @typedef {{rootBytes:number,roomBytes:number,stagingBytes:number,concurrentUploads:number,uploadTtlMs:number,unpublishedTtlMs:number}} MediaLimits */
/** @typedef {(bytes:Buffer,kind:MediaKind,signal:AbortSignal)=>Promise<MediaValidation>} ValidateMedia */
/** @typedef {{asset:MediaAsset,uploadedAt:number}} StoredAsset */
/** @typedef {{version:1,roomId:string,assets:StoredAsset[],references:MediaReferences}} MediaIndex */
/** @typedef {{id:string,kind:MediaKind,totalBytes:number,expectedSha256:string,receivedBytes:number,filename:string,expiresAt:number,controller:AbortController,timer:ReturnType<typeof setTimeout>,validating:boolean,encrypted?:true}} Upload */
/** @typedef {{pid:number,roomId:string,roomLockId:string,uploadId:string,totalBytes:number,encrypted?:true}} Reservation */

const CHUNK_BYTES = 16 * 1024;
const ENCRYPTION_OVERHEAD = require('./content-crypto.cjs').MAX_HEADER_BYTES+26;
const MAX_ASSETS = 4096;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
/** @type {Readonly<Record<MediaKind,{pixels:number,bytes:number}>>} */
const KIND_LIMITS = { server:{pixels:240,bytes:96*1024},personal:{pixels:360,bytes:160*1024},image:{pixels:1920,bytes:1536*1024} };

/** @param {JsonValue|undefined} value @param {string} field @returns {{[key:string]:JsonValue}} */
function object(value,field) { if(!value || typeof value!=='object' || Array.isArray(value))throw new TypeError(field+' must be an object');return value; }
/** @param {JsonValue|undefined} value @param {string} field @param {number} minimum @param {number} maximum @returns {number} */
function integer(value,field,minimum,maximum) { if(typeof value!=='number' || !Number.isSafeInteger(value) || value<minimum || value>maximum)throw new RangeError(field+' must be an integer from '+minimum+' to '+maximum);return value; }
/** @param {JsonValue|undefined} value @returns {string} */
function sha256(value) { if(typeof value!=='string' || !/^[a-f0-9]{64}$/.test(value))throw new TypeError('Media SHA256 must be 64 lowercase hexadecimal characters');return value; }
/** @param {JsonValue|undefined} value @returns {MediaKind} */
function kind(value) { if(value!=='server' && value!=='personal' && value!=='image')throw new TypeError('Media kind must be server, personal or image');return value; }
/** @param {Buffer} bytes @returns {string} */
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
/** @param {JsonValue} value @param {MediaKind} mediaKind @returns {MediaValidation} */
function validation(value,mediaKind) {
  const row=object(value,'Validated media'),limit=KIND_LIMITS[mediaKind];
  const width=integer(row.width,'Media width',1,limit.pixels),height=integer(row.height,'Media height',1,limit.pixels),frames=integer(row.frames,'Media frames',1,180);
  if(typeof row.animated!=='boolean' || row.animated!==(frames>1))throw new TypeError('Media animation flag must match its decoded frame count');
  if(typeof row.durationMs!=='number' || !Number.isFinite(row.durationMs) || row.durationMs<0 || row.durationMs>10000)throw new RangeError('Decoded media duration must be finite and within 0..10000 milliseconds');
  if(width*height*frames>24*1024*1024)throw new RangeError('Decoded media exceeds the 25165824-pixel output budget');
  if(row.encrypted!==undefined && row.encrypted!==true)throw new TypeError('Media encrypted discriminator must be true when present');
  return {width,height,animated:row.animated,frames,durationMs:row.durationMs,...(row.encrypted===true ? {encrypted:/** @type {const} */(true),mediaKind:kind(row.mediaKind)} : {})};
}
/** @param {JsonValue} value @returns {MediaAsset} */
function parseAsset(value) {
  const row=object(value,'Media asset');
  return {sha256:sha256(row.sha256),bytes:integer(row.bytes,'Media bytes',1,KIND_LIMITS.image.bytes+(row.encrypted===true?ENCRYPTION_OVERHEAD:0)),...validation(row,'image')};
}
/** @param {JsonValue|undefined} value @param {string} field @returns {string[]} */
function hashes(value,field) {
  if(!Array.isArray(value) || value.length>MAX_ASSETS)throw new RangeError(field+' must be an array with at most 4096 hashes');
  const result=value.map(sha256);
  if(new Set(result).size!==result.length)throw new TypeError(field+' contains duplicate hashes');
  return [...result].sort();
}
/** @param {JsonValue} value @returns {MediaReferences} */
function parseReferences(value) { const row=object(value,'Media references');return {catalog:hashes(row.catalog,'Catalog references'),history:hashes(row.history,'History references'),backupPins:hashes(row.backupPins,'Backup pins')}; }
/** @param {MediaReferences} references @returns {Set<string>} */
function referenced(references) { return new Set([...references.catalog,...references.history,...references.backupPins]); }
/** @param {string} location @param {number} maximumBytes @param {string} label @returns {JsonValue} */
function readJsonFile(location,maximumBytes,label) {
  const stat=fs.lstatSync(location);
  if(!stat.isFile() || stat.size>maximumBytes)throw new RangeError(label+' must be a regular file of at most '+maximumBytes+' bytes: '+location);
  try { return JSON.parse(fs.readFileSync(location,'utf8')); }
  catch(error) { if(error instanceof SyntaxError)throw new SyntaxError(label+' contains invalid JSON: '+location,{cause:error});throw error; }
}

class MediaBudgetBusyError extends Error {
  /** @param {string} rootDir */constructor(rootDir) { super('Media root budget is busy: '+rootDir);this.name='MediaBudgetBusyError';this.code='media-busy';this.retryAfterMs=25; }
}
/** @param {number} pid @returns {boolean} */function processAlive(pid) {
  try { process.kill(pid,0);return true; } catch(error) { if(error instanceof Error && 'code' in error && error.code==='ESRCH')return false;throw error; }
}
/** @param {string} location @returns {void} */function requireDirectory(location) {
  const stat=fs.lstatSync(location);if(stat.isSymbolicLink() || !stat.isDirectory())throw new TypeError('Media storage directory must not be a link or reparse target: '+location);
}
/** @param {string} rootDir @returns {void} */function prepareRoot(rootDir) {
  const absolute=path.resolve(rootDir),anchor=path.parse(absolute).root;let current=anchor;requireDirectory(anchor);
  for(const component of absolute.slice(anchor.length).split(path.sep).filter(Boolean)) {
    current=path.join(current,component);
    if(!fs.existsSync(current)) { try { fs.mkdirSync(current); } catch(error) { if(!(error instanceof Error && 'code' in error && error.code==='EEXIST'))throw error; } }
    requireDirectory(current);
  }
}
/** @template T @param {string} rootDir @param {number} rootBytes @param {()=>T} task @returns {T} */function withRootLock(rootDir,rootBytes,task) {
  const location=path.join(rootDir,'.budget.sqlite');
  for(const file of [location,location+'-journal'])if(fs.existsSync(file)) {const stat=fs.lstatSync(file);if(!stat.isFile() || stat.size>1024*1024)throw new TypeError('Media root database must be a bounded regular file: '+file);}
  const database=new DatabaseSync(location,{open:false,readOnly:false,enableForeignKeyConstraints:true,enableDoubleQuotedStringLiterals:false,allowExtension:false});let begun=false,opened=false;
  try {
    database.open();opened=true;
    database.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');begun=true;
    database.exec('CREATE TABLE IF NOT EXISTS media_budget(id INTEGER PRIMARY KEY CHECK(id=1),root_bytes INTEGER NOT NULL CHECK(root_bytes>0)) STRICT;');
    const row=database.prepare('SELECT root_bytes FROM media_budget WHERE id=1').get();
    if(!row)database.prepare('INSERT INTO media_budget(id,root_bytes) VALUES(1,?)').run(rootBytes);
    else if(row.root_bytes!==rootBytes)throw new RangeError('All connectors sharing a media root must use the same explicit rootBytes budget');
    const result=task();database.exec('COMMIT;');begun=false;return result;
  } catch(error) {
    if(begun)database.exec('ROLLBACK;');
    if(error instanceof Error && 'errcode' in error && (error.errcode===5 || error.errcode===6))throw new MediaBudgetBusyError(rootDir);
    throw error;
  } finally { if(opened)database.close(); }
}
/** @param {string} rootDir @returns {number} */function rootUsage(rootDir) {
  /** @type {Map<string,{pid:number,id:string}|null>} */const owners=new Map();
  /** @type {Map<string,number>} */const staged=new Map();
  let total=0,rooms=0;
  for(const entry of fs.readdirSync(rootDir,{withFileTypes:true})) {
    if(entry.name==='.budget.sqlite' || entry.name==='.budget.sqlite-journal') {if(!entry.isFile())throw new TypeError('Media root database must not be a link');const stat=fs.lstatSync(path.join(rootDir,entry.name));if(!stat.isFile() || stat.size>1024*1024)throw new TypeError('Media root database is not a bounded regular file');continue;}
    if(entry.name==='.reservations') { if(!entry.isDirectory())throw new TypeError('Media reservation directory must not be a link');continue; }
    if(!UUID.test(entry.name) || !entry.isDirectory() || ++rooms>4096)throw new TypeError('Unexpected or excessive media root entry: '+path.join(rootDir,entry.name));
    const room=path.join(rootDir,entry.name);requireDirectory(room);owners.set(entry.name,null);
    for(const item of fs.readdirSync(room,{withFileTypes:true})) {
      const location=path.join(room,item.name);
      if(item.name==='objects' || item.name==='staging') {
        if(!item.isDirectory())throw new TypeError('Media object/staging directory must not be a link: '+location);requireDirectory(location);
        const children=fs.readdirSync(location,{withFileTypes:true});if(children.length>(item.name==='objects'?MAX_ASSETS:16))throw new RangeError('Media room contains excessive object/staging entries: '+location);
        for(const child of children) {
          const childPath=path.join(location,child.name),valid=item.name==='objects'?/^[a-f0-9]{64}\.avif$/.test(child.name):UUID.test(child.name.slice(0,-7)) && child.name.endsWith('.upload');
          if(!child.isFile() || !valid)throw new TypeError('Unexpected media file or link: '+childPath);
          let stat;
          try { stat=fs.lstatSync(childPath); }
          catch(error) { if(item.name==='staging' && error instanceof Error && 'code' in error && error.code==='ENOENT') {console.warn('media_budget_concurrent_release',{roomId:entry.name,uploadId:child.name.slice(0,-7)});continue;}throw error; }
          if(!stat.isFile() || stat.size<0 || stat.size>KIND_LIMITS.image.bytes+ENCRYPTION_OVERHEAD)throw new TypeError('Media file has an invalid type or size: '+childPath);
          total+=stat.size;if(item.name==='staging')staged.set(entry.name+'/'+child.name.slice(0,-7),stat.size);
        }
      } else {
        if(!item.isFile() || !['store.lock','index.json','index.json.pending'].includes(item.name))throw new TypeError('Unexpected media room entry or link: '+location);
        try {
          const stat=fs.lstatSync(location);if(!stat.isFile() || stat.size>(item.name==='store.lock'?1024:MAX_INDEX_BYTES))throw new TypeError('Media room metadata has an invalid type or size: '+location);
          if(item.name==='store.lock') {const lock=object(readJsonFile(location,1024,'Media store lock'),'Media store lock');if(typeof lock.id!=='string' || !UUID.test(lock.id))throw new TypeError('Media store lock has an invalid owner identity');owners.set(entry.name,{pid:integer(lock.pid,'Media store process ID',1,2147483647),id:lock.id});}
        } catch(error) {if(error instanceof Error && 'code' in error && error.code==='ENOENT') {console.warn('media_budget_metadata_released',{roomId:entry.name,entry:item.name});continue;}throw error;}
      }
    }
  }
  const reservations=path.join(rootDir,'.reservations');requireDirectory(reservations);
  const records=fs.readdirSync(reservations,{withFileTypes:true});if(records.length>65536)throw new RangeError('Media root has excessive upload reservations');
  for(const entry of records) {
    if(!entry.isFile() || !entry.name.endsWith('.json') || !UUID.test(entry.name.slice(0,-5)))throw new TypeError('Unexpected media reservation entry or link: '+entry.name);
    const location=path.join(reservations,entry.name),row=object(readJsonFile(location,1024,'Media reservation'),'Media reservation');
    if(typeof row.roomId!=='string' || !UUID.test(row.roomId) || typeof row.roomLockId!=='string' || !UUID.test(row.roomLockId) || row.uploadId!==entry.name.slice(0,-5))throw new TypeError('Media reservation has an invalid room or upload identity');
    const pid=integer(row.pid,'Media reservation process ID',1,2147483647),bytes=integer(row.totalBytes,'Reserved media bytes',1,KIND_LIMITS.image.bytes+(row.encrypted===true?ENCRYPTION_OVERHEAD:0)),key=row.roomId+'/'+row.uploadId,actual=staged.get(key),owner=owners.get(row.roomId);
    const alive=processAlive(pid);
    if(actual===undefined || !alive) {fs.unlinkSync(location);if(!alive)console.warn('media_stale_reservation_removed',{roomId:row.roomId,uploadId:row.uploadId,pid,roomLockId:row.roomLockId,currentRoomLockId:owner?owner.id:null});continue;}
    if(!owner || owner.pid!==pid || owner.id!==row.roomLockId)throw new TypeError('Live media reservation does not match its room lock owner: '+location);
    if(actual>bytes)throw new RangeError('Media staging file exceeds its durable byte reservation: '+location);
    total+=bytes-actual;
  }
  return total;
}

/** Open a room-scoped binary connector after external authentication. @param {{rootDir:string,roomId:string,validate:ValidateMedia,validateEncrypted?:ValidateMedia,limits:MediaLimits}} options */
function openMediaStore(options) {
  if(!path.isAbsolute(options.rootDir))throw new TypeError('Media rootDir must be an absolute persistent data path');
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(options.roomId))throw new TypeError('Media roomId must be a canonical lowercase UUID');
  if(typeof options.validate!=='function')throw new TypeError('Media validation requires a decoder callback');
  const limits={
    rootBytes:integer(options.limits.rootBytes,'Root media budget',1,64*1024*1024*1024),
    roomBytes:integer(options.limits.roomBytes,'Room media budget',1,16*1024*1024*1024),
    stagingBytes:integer(options.limits.stagingBytes,'Staging media budget',1,64*1024*1024),
    concurrentUploads:integer(options.limits.concurrentUploads,'Concurrent uploads',1,16),
    uploadTtlMs:integer(options.limits.uploadTtlMs,'Upload lifetime',1,3600000),
    unpublishedTtlMs:integer(options.limits.unpublishedTtlMs,'Unpublished media lifetime',0,30*24*3600000),
  };
  const roomId=options.roomId,validate=options.validate,directory=path.join(options.rootDir,roomId),objects=path.join(directory,'objects'),staging=path.join(directory,'staging'),indexPath=path.join(directory,'index.json'),lockPath=path.join(directory,'store.lock');
  prepareRoot(options.rootDir);const lockId=randomUUID(),reservations=path.join(options.rootDir,'.reservations');let acquired=false;
  /** @type {MediaIndex} */let index={version:1,roomId,assets:[],references:{catalog:[],history:[],backupPins:[]}};
  /** @type {Map<string,Upload>} */const uploads=new Map();
  let validations=0,closed=false;
  /** @returns {void} */function requireOpen() { if(closed)throw new TypeError('Media store is closed'); }
  /** @param {string} value @returns {string} */function filename(value) { return path.join(objects,sha256(value)+'.avif'); }
  /** @param {string} value @returns {void} */function verifyFile(value) {
    const stored=index.assets.find(entry=>entry.asset.sha256===value);if(!stored)throw new TypeError('Media asset is not present: '+value);
    const location=filename(value),stat=fs.lstatSync(location);
    if(!stat.isFile() || stat.size!==stored.asset.bytes || hash(fs.readFileSync(location))!==value)throw new TypeError('Indexed media file failed its size/SHA256 integrity check: '+location);
  }
  /** @param {MediaIndex} next @returns {void} */function persist(next) {
    const serialized=JSON.stringify(next);if(Buffer.byteLength(serialized)>MAX_INDEX_BYTES)throw new RangeError('Media index exceeds its 4 MiB budget');
    const pending=indexPath+'.pending';
    try { fs.writeFileSync(pending,serialized,{flag:'wx',mode:0o600,flush:true});fs.renameSync(pending,indexPath); }
    catch(error) { if(fs.existsSync(pending))fs.unlinkSync(pending);throw error; }
    index=next;
  }
  /** @returns {{sha256:string,bytes:number}[]} */function objectFiles() {
    return fs.readdirSync(objects,{withFileTypes:true}).map(entry=>{
      if(!entry.isFile() || !/^[a-f0-9]{64}\.avif$/.test(entry.name))throw new TypeError('Unexpected media object entry: '+path.join(objects,entry.name));
      return {sha256:entry.name.slice(0,64),bytes:fs.statSync(path.join(objects,entry.name)).size};
    });
  }
  /** @returns {void} */function cleanupOrphans() {
    const keep=referenced(index.references);
    for(const entry of objectFiles())if(!index.assets.some(stored=>stored.asset.sha256===entry.sha256)) {
      if(keep.has(entry.sha256))console.warn('media_referenced_orphan_retained',{roomId,sha256:entry.sha256,bytes:entry.bytes});
      else { fs.unlinkSync(filename(entry.sha256));console.warn('media_orphan_removed',{roomId,sha256:entry.sha256,bytes:entry.bytes}); }
    }
  }
  try { withRootLock(options.rootDir,limits.rootBytes,()=>{
    for(const location of [reservations,directory,objects,staging]) {if(!fs.existsSync(location))fs.mkdirSync(location);requireDirectory(location);}
    if(fs.existsSync(lockPath)) {
      const old=object(readJsonFile(lockPath,1024,'Media store lock'),'Media store lock'),pid=integer(old.pid,'Media store process ID',1,2147483647);
      if(processAlive(pid))throw new TypeError('Media store is already open in process '+pid+': '+directory);
      fs.unlinkSync(lockPath);console.warn('media_stale_lock_removed',{roomId,pid,previousRoomLockId:old.id});
    }
    fs.writeFileSync(lockPath,JSON.stringify({pid:process.pid,id:lockId}),{flag:'wx',mode:0o600,flush:true});acquired=true;
    if(fs.existsSync(indexPath+'.pending')) { fs.unlinkSync(indexPath+'.pending');console.warn('media_pending_index_removed',{roomId}); }
    if(fs.existsSync(indexPath)) {
      const row=object(readJsonFile(indexPath,MAX_INDEX_BYTES,'Media index'),'Media index');
      if(row.version!==1 || row.roomId!==roomId || !Array.isArray(row.assets) || row.assets.length>MAX_ASSETS)throw new TypeError('Media index has an invalid version, room identity or asset count');
      const assets=row.assets.map(value=>{const entry=object(value,'Stored media');if(entry.asset===undefined)throw new TypeError('Stored media asset is required');return {asset:parseAsset(entry.asset),uploadedAt:integer(entry.uploadedAt,'Media upload timestamp',0,Number.MAX_SAFE_INTEGER)};});
      if(new Set(assets.map(entry=>entry.asset.sha256)).size!==assets.length)throw new TypeError('Media index contains duplicate assets');
      if(row.references===undefined)throw new TypeError('Media references are required');
      index={version:1,roomId,assets,references:parseReferences(row.references)};
      for(const entry of assets)verifyFile(entry.asset.sha256);
      if(index.references.backupPins.some(value=>!assets.some(entry=>entry.asset.sha256===value)))throw new TypeError('A promised media backup pin is missing its indexed file');
    }
    // Interrupted uploads are never resumed; only indexed objects can be advertised.
    for(const entry of fs.readdirSync(staging,{withFileTypes:true})) {
      if(!entry.isFile() || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.upload$/.test(entry.name))throw new TypeError('Unexpected media staging entry: '+path.join(staging,entry.name));
      const bytes=fs.statSync(path.join(staging,entry.name)).size;fs.unlinkSync(path.join(staging,entry.name));console.warn('media_interrupted_upload_removed',{roomId,uploadId:entry.name.slice(0,-7),bytes});
    }
    cleanupOrphans();
    if(objectFiles().reduce((total,entry)=>total+entry.bytes,0)>limits.roomBytes)throw new RangeError('Existing room media exceeds its configured disk budget');
    if(rootUsage(options.rootDir)>limits.rootBytes)throw new RangeError('Existing media root exceeds its configured disk budget');
    if(!fs.existsSync(indexPath))persist(index);
  }); } catch(error) { if(acquired)fs.unlinkSync(lockPath);throw error; }
  /** @param {Upload} upload @returns {void} */function release(upload) {
    clearTimeout(upload.timer);uploads.delete(upload.id);
    if(fs.existsSync(upload.filename))fs.unlinkSync(upload.filename);
  }
  /** @param {string} uploadId @returns {Upload} */function requireUpload(uploadId) {
    requireOpen();const upload=uploads.get(uploadId);if(!upload)throw new TypeError('Media upload is unknown, expired or cancelled: '+uploadId);return upload;
  }
  /** @param {string} uploadId @returns {void} */function cancelUpload(uploadId) {
    const upload=requireUpload(uploadId);upload.controller.abort(new Error('Media upload was cancelled'));release(upload);
  }
  /** @param {string} uploadId @returns {boolean} */function hasUpload(uploadId) { requireOpen();return uploads.has(uploadId); }
  /** @param {{kind:MediaKind,totalBytes:number,expectedSha256:string,encrypted?:true}} input @returns {{uploadId:string,expiresAt:number,chunkBytes:number}} */function beginUpload(input) {
    requireOpen();
    if(input.encrypted!==undefined && input.encrypted!==true)throw new TypeError('Media encrypted discriminator must be true when present');
    if(input.encrypted===true && typeof options.validateEncrypted!=='function')throw new TypeError('Encrypted media requires an envelope validator callback');
    const mediaKind=kind(input.kind),totalBytes=integer(input.totalBytes,'Upload bytes',1,KIND_LIMITS[mediaKind].bytes+(input.encrypted===true?ENCRYPTION_OVERHEAD:0)),expectedSha256=sha256(input.expectedSha256);
    const writing=[...uploads.values()].filter(upload=>!upload.validating);
    if(writing.length+validations>=limits.concurrentUploads)throw new RangeError('Media upload concurrency budget is full');
    if([...uploads.values()].reduce((total,upload)=>total+upload.totalBytes,0)+totalBytes>limits.stagingBytes)throw new RangeError('Media staging byte budget is full');
    const files=objectFiles(),existing=files.some(entry=>entry.sha256===expectedSha256 && entry.bytes===totalBytes);
    const reserved=[...uploads.values()].filter(upload=>!files.some(entry=>entry.sha256===upload.expectedSha256 && entry.bytes===upload.totalBytes)).reduce((total,upload)=>total+upload.totalBytes,0);
    if(files.reduce((total,entry)=>total+entry.bytes,0)+reserved+(existing?0:totalBytes)>limits.roomBytes)throw new RangeError('Room media disk budget is full; referenced or pinned files cannot be evicted');
    const assetHashes=new Set([...index.assets.map(entry=>entry.asset.sha256),...[...uploads.values()].map(upload=>upload.expectedSha256)]);
    if(!assetHashes.has(expectedSha256) && assetHashes.size>=MAX_ASSETS)throw new RangeError('Room media asset count limit is full');
    const id=randomUUID(),location=path.join(staging,id+'.upload'),controller=new AbortController(),expiresAt=Date.now()+limits.uploadTtlMs;
    try { withRootLock(options.rootDir,limits.rootBytes,()=>{
      if(rootUsage(options.rootDir)+totalBytes>limits.rootBytes)throw new RangeError('Root media disk budget is full, including active upload reservations');
      /** @type {Reservation} */const reservation={pid:process.pid,roomId,roomLockId:lockId,uploadId:id,totalBytes,...(input.encrypted===true?{encrypted:/** @type {const} */(true)}:{})};
      fs.writeFileSync(path.join(reservations,id+'.json'),JSON.stringify(reservation),{flag:'wx',mode:0o600,flush:true});
      fs.writeFileSync(location,Buffer.alloc(0),{flag:'wx',mode:0o600});
    }); } catch(error) {if(fs.existsSync(location))fs.unlinkSync(location);throw error;}
    const timer=setTimeout(()=>{const upload=uploads.get(id);if(!upload)return;controller.abort(new Error('Media upload exceeded its lifetime'));release(upload);console.warn('media_upload_expired',{roomId,uploadId:id,receivedBytes:upload.receivedBytes,totalBytes});},limits.uploadTtlMs);timer.unref();
    uploads.set(id,{id,kind:mediaKind,totalBytes,expectedSha256,receivedBytes:0,filename:location,expiresAt,controller,timer,validating:false,...(input.encrypted===true?{encrypted:/** @type {const} */(true)}:{})});
    return {uploadId:id,expiresAt,chunkBytes:CHUNK_BYTES};
  }
  /** @param {string} uploadId @param {number} offset @param {Buffer} bytes @returns {{receivedBytes:number}} */function writeChunk(uploadId,offset,bytes) {
    const upload=requireUpload(uploadId);
    try {
      if(upload.validating)throw new TypeError('Media upload is already being validated');
      if(!Buffer.isBuffer(bytes) || bytes.length<1 || bytes.length>CHUNK_BYTES)throw new RangeError('Media chunks must contain 1..16384 bytes');
      if(offset!==upload.receivedBytes || offset+bytes.length>upload.totalBytes)throw new RangeError('Media upload offset or declared total does not match this chunk');
      fs.appendFileSync(upload.filename,bytes);upload.receivedBytes+=bytes.length;return {receivedBytes:upload.receivedBytes};
    } catch(error) { upload.controller.abort(error);release(upload);throw error; }
  }
  /** @param {string} uploadId @returns {Promise<MediaAsset>} */async function finishUpload(uploadId) {
    const upload=requireUpload(uploadId);
    if(upload.validating)throw new TypeError('Media upload is already being validated');
    if(upload.receivedBytes!==upload.totalBytes) { release(upload);throw new RangeError('Media upload is incomplete: '+upload.receivedBytes+'/'+upload.totalBytes); }
    upload.validating=true;
    /** @type {()=>void} */let removeAbort=()=>{};let releaseOnExit=true;
    try {
      const bytes=fs.readFileSync(upload.filename);
      if(bytes.length!==upload.totalBytes || hash(bytes)!==upload.expectedSha256)throw new TypeError('Media upload SHA256 does not match its declared bytes');
      const validator=upload.encrypted===true?options.validateEncrypted:validate;
      if(!validator)throw new TypeError('Encrypted media requires an envelope validator callback');
      validations+=1;
      const task=Promise.resolve().then(()=>validator(bytes,upload.kind,upload.controller.signal));
      task.then(()=>{validations-=1;},()=>{validations-=1;});
      const aborted=new Promise(/** @param {(value:never)=>void} resolve @param {(reason:Error)=>void} reject */ (resolve,reject)=>{
        const abort=()=>reject(new Error('Media validation was cancelled or expired'));
        upload.controller.signal.addEventListener('abort',abort,{once:true});removeAbort=()=>upload.controller.signal.removeEventListener('abort',abort);
        if(upload.controller.signal.aborted)abort();
      });
      const decoded=validation(await Promise.race([task,aborted]),upload.kind);
      if(decoded.encrypted!==upload.encrypted)throw new TypeError('Media validation must preserve the upload encryption discriminator');
      if(upload.controller.signal.aborted || closed || !uploads.has(upload.id))throw new TypeError('Media upload ended before validation could publish it');
      if(hash(bytes)!==upload.expectedSha256)throw new TypeError('Media decoder modified its input bytes');
      const asset={sha256:upload.expectedSha256,bytes:bytes.length,...decoded},old=index.assets.find(entry=>entry.asset.sha256===asset.sha256);
      if(old && JSON.stringify(old.asset)!==JSON.stringify(asset))throw new TypeError('Decoded media metadata differs from its existing indexed content');
      withRootLock(options.rootDir,limits.rootBytes,()=>{
        if(rootUsage(options.rootDir)>limits.rootBytes)throw new RangeError('Media root exceeds its budget before upload publication');
        const destination=filename(asset.sha256);
        if(fs.existsSync(destination)) {
          const stat=fs.lstatSync(destination);
          if(!stat.isFile() || stat.size!==asset.bytes || hash(fs.readFileSync(destination))!==asset.sha256)throw new TypeError('Existing media object has conflicting bytes or SHA256: '+destination);
        }
        else {
          const descriptor=fs.openSync(upload.filename,'r+');try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
          fs.renameSync(upload.filename,destination);
        }
        // A failed index commit leaves a nonpresent orphan for bounded restart/GC recovery.
        persist({...index,assets:[...index.assets.filter(entry=>entry.asset.sha256!==asset.sha256),{asset,uploadedAt:Date.now()}].sort((a,b)=>a.asset.sha256.localeCompare(b.asset.sha256))});
        if(fs.existsSync(upload.filename))fs.unlinkSync(upload.filename);fs.unlinkSync(path.join(reservations,upload.id+'.json'));
      });
      return structuredClone(asset);
    } catch(error) { if(error instanceof MediaBudgetBusyError) {upload.validating=false;releaseOnExit=false;}else upload.controller.abort(error);throw error; }
    finally { removeAbort();if(releaseOnExit)release(upload); }
  }
  /** @param {string} value @returns {MediaAsset|null} */function metadata(value) { requireOpen();const identifier=sha256(value),result=index.assets.find(entry=>entry.asset.sha256===identifier);return result?structuredClone(result.asset):null; }
  /** @returns {MediaAsset[]} */function inventory() { requireOpen();return index.assets.map(entry=>structuredClone(entry.asset)); }
  /** @param {string} value @param {number} offset @param {number} length @returns {Buffer} */function readRange(value,offset,length) {
    requireOpen();const asset=metadata(value);if(!asset)throw new TypeError('Media file is not present: '+value);
    integer(offset,'Media range offset',0,asset.bytes);integer(length,'Media range length',1,CHUNK_BYTES);
    if(offset+length>asset.bytes)throw new RangeError('Media read range exceeds the actual file size');
    const descriptor=fs.openSync(filename(value),'r'),output=Buffer.alloc(length);
    try { if(fs.fstatSync(descriptor).size!==asset.bytes || fs.readSync(descriptor,output,0,length,offset)!==length)throw new TypeError('Media file changed or could not satisfy its read range');return output; }
    finally { fs.closeSync(descriptor); }
  }
  /** @param {MediaReferences} value @returns {void} */function replaceReferences(value) {
    requireOpen();const references=parseReferences(value);
    for(const pinned of references.backupPins)verifyFile(pinned);
    if(JSON.stringify(references)!==JSON.stringify(index.references))persist({...index,references});
  }
  /** @returns {{removedHashes:string[],freedBytes:number}} */function collectGarbage() {
    requireOpen();return withRootLock(options.rootDir,limits.rootBytes,()=>{
    rootUsage(options.rootDir);const keep=referenced(index.references),now=Date.now(),removed=index.assets.filter(entry=>!keep.has(entry.asset.sha256) && now-entry.uploadedAt>=limits.unpublishedTtlMs);
    // Unpublish first so a crash during unlink leaves recoverable, nonpresent orphans.
    if(removed.length)persist({...index,assets:index.assets.filter(entry=>!removed.includes(entry))});
    let freedBytes=0;
    for(const entry of removed) { fs.unlinkSync(filename(entry.asset.sha256));freedBytes+=entry.asset.bytes; }
    cleanupOrphans();return {removedHashes:removed.map(entry=>entry.asset.sha256),freedBytes};});
  }
  /** Remove selected legacy objects only after their references have been committed. @param {string[]} values @returns {{removedHashes:string[],freedBytes:number}} */function purgeUnreferenced(values) {
    requireOpen();const selected=new Set(hashes(values,'Legacy media purge hashes'));
    return withRootLock(options.rootDir,limits.rootBytes,()=>{
      rootUsage(options.rootDir);const keep=referenced(index.references),removed=index.assets.filter(entry=>selected.has(entry.asset.sha256) && !entry.asset.encrypted && !keep.has(entry.asset.sha256));
      if(removed.length)persist({...index,assets:index.assets.filter(entry=>!removed.includes(entry))});
      let freedBytes=0;
      for(const entry of removed){fs.unlinkSync(filename(entry.asset.sha256));freedBytes+=entry.asset.bytes;}
      return {removedHashes:removed.map(entry=>entry.asset.sha256),freedBytes};
    });
  }
  /** @returns {{roomBytes:number,stagingBytes:number,activeUploads:number,validations:number}} */function stats() { requireOpen();return {roomBytes:objectFiles().reduce((total,entry)=>total+entry.bytes,0),stagingBytes:[...uploads.values()].reduce((total,upload)=>total+upload.totalBytes,0),activeUploads:uploads.size,validations}; }
  /** @returns {MediaReferences} */function references() { requireOpen();return structuredClone(index.references); }
  /** @returns {void} */function close() {
    requireOpen();for(const upload of [...uploads.values()])cancelUpload(upload.id);closed=true;
    const lock=object(readJsonFile(lockPath,1024,'Media store lock'),'Media store lock');if(lock.id!==lockId)throw new TypeError('Media store lock ownership changed unexpectedly');fs.unlinkSync(lockPath);
  }
  return {beginUpload,writeChunk,finishUpload,cancelUpload,hasUpload,metadata,inventory,readRange,replaceReferences,collectGarbage,purgeUnreferenced,stats,references,close};
}

module.exports={openMediaStore,MediaBudgetBusyError};
