// @ts-check
'use strict';
const {setTimeout:delay}=require('node:timers/promises');
const {randomUUID}=require('node:crypto');
/** @type {typeof import('../lib/media-store.cjs')} */const {openMediaStore}=require('./app-server/lib/media-store.cjs');
/** @type {typeof import('../lib/media-validator.cjs')} */const {createMediaValidator,createEncryptedMediaValidator}=require('./app-server/lib/media-validator.cjs');
/** @type {typeof import('../public/js/chat-protocol.js')} */const {parseMediaRequest,parseMediaMetadata,mediaObject,mediaHash,mediaId,mediaInteger}=require('./app-server/public/js/chat-protocol.js');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{origin:string,key:Buffer}} Backend */
/** @typedef {import('../public/js/chat-protocol.js').MediaRequest} MediaRequest */
/** @typedef {{sha256:string,bytes:number,expiresAt:number,kind:import('../public/js/chat-protocol.js').MediaKind,encrypted?:true}} BoundUpload */

/** @param {{rootDir:string,roomId:string,backend:Backend|null}} options */
function createSteamMediaStorage(options){
  if(options.backend===undefined)throw new TypeError('Steam media storage requires an explicit backend or null');
  if(options.backend){const address=new URL(options.backend.origin);if(address.protocol!=='http:' || address.hostname!=='127.0.0.1' || address.origin!==options.backend.origin || !Buffer.isBuffer(options.backend.key) || options.backend.key.length!==32)throw new TypeError('Steam media backend requires a loopback HTTP origin and 32-byte private key');}
  const backend=options.backend?{origin:options.backend.origin,key:Buffer.from(options.backend.key)}:null;
  const validator=options.backend===null ? createMediaValidator({maxPending:4}) : null;
  const encryptedValidator=validator?createEncryptedMediaValidator({roomId:options.roomId}):null;
  const store=validator && encryptedValidator ? openMediaStore({rootDir:options.rootDir,roomId:options.roomId,validate:validator.validate,validateEncrypted:encryptedValidator.validate,limits:{rootBytes:512*1024*1024,roomBytes:256*1024*1024,stagingBytes:8*1024*1024,concurrentUploads:4,uploadTtlMs:60000,unpublishedTtlMs:300000}}) : null;
  const controller=new AbortController();
  /** @type {Set<string>} */let referencesSet=new Set();
  /** @type {Map<string,BoundUpload>} */const uploads=new Map();
  /** @type {Set<Promise<JsonValue>>} */const tasks=new Set();
  let closed=false,lastGcAt=0,referencesInitialized=false;
  /** @type {Promise<void>|null} */let closing=null;
  /** @param {JsonValue} input @param {AbortSignal} signal @returns {Promise<JsonValue>} */
  async function remote(input,signal){
    if(!backend)throw new Error('Steam media backend is not configured');
    const response=await fetch(backend.origin+'/api/steam-media',{method:'POST',headers:{'Content-Type':'application/json','x-deepscord-media-key':backend.key.toString('hex')},body:JSON.stringify(input),signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});
    if(!response.body)throw new Error('Media backend response has no body');
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>2*1024*1024)throw new RangeError('Media backend response exceeds 2 MiB');chunks.push(Buffer.from(part.value));}}
    finally{await reader.cancel();reader.releaseLock();}
    const row=mediaObject(JSON.parse(Buffer.concat(chunks).toString('utf8')),'Media backend response');
    if(!response.ok || row.ok!==true)throw Object.assign(new Error(typeof row.message==='string' ? row.message.slice(0,500) : 'Media backend rejected the request with status '+response.status),{code:typeof row.code==='string' ? row.code : 'media-storage-failed',retryAfterMs:row.retryAfterMs===null || row.retryAfterMs===undefined?null:mediaInteger(row.retryAfterMs,'Backend retry delay',1,60000)});
    if(row.result===undefined)throw new TypeError('Media backend result is missing');return row.result;
  }
  /** @param {JsonValue} input @returns {Promise<JsonValue>} */
  async function local(input){
    if(!store)throw new Error('Local replica storage is not open');
    const row=mediaObject(input,'Replica storage request');
    if(row.op==='inventory')return{assets:store.inventory().filter(asset=>referencesSet.has(asset.sha256))};
    const request=parseMediaRequest({...row,requestId:randomUUID()});
    if(request.op==='begin'){
      if(!referencesSet.has(request.sha256) || request.encrypted!==true && request.kind!=='image' || request.domainId!==null)throw new TypeError('Replica upload is not referenced by this room');
      const asset=store.metadata(request.sha256);if(asset){if(asset.bytes!==request.bytes || asset.encrypted!==request.encrypted || asset.encrypted===true && asset.mediaKind!==request.kind)throw new TypeError('Replica upload byte count conflicts with its stored content');return{asset};}
      return store.beginUpload({kind:request.kind,expectedSha256:request.sha256,totalBytes:request.bytes,...(request.encrypted===true?{encrypted:/** @type {const} */(true)}:{})});
    }
    if(request.op==='write' || request.op==='finish' || request.op==='cancel'){
      if(!uploads.has(request.uploadId))throw new TypeError('Replica upload is not owned by this connector');
      if(request.op==='write'){
        const bytes=Buffer.from(request.data,'base64');if(bytes.toString('base64')!==request.data){uploads.delete(request.uploadId);if(store.hasUpload(request.uploadId))store.cancelUpload(request.uploadId);throw new TypeError('Replica chunk is not canonical base64');}
        try{return store.writeChunk(request.uploadId,request.offset,bytes);}finally{if(!store.hasUpload(request.uploadId))uploads.delete(request.uploadId);}
      }
      if(request.op==='cancel'){uploads.delete(request.uploadId);if(store.hasUpload(request.uploadId))store.cancelUpload(request.uploadId);return{cancelled:true};}
      try{const asset=await store.finishUpload(request.uploadId);return{asset};}finally{if(!store.hasUpload(request.uploadId))uploads.delete(request.uploadId);}
    }
    if(request.op!=='info' && request.op!=='read')throw new TypeError('Unknown replica operation');
    if(!referencesSet.has(request.sha256))throw new TypeError('Media is not referenced by this room');
    const asset=store.metadata(request.sha256);if(!asset)throw new Error('No durable copy exists on this member');
    if(request.op==='info')return{asset};
    return{sha256:asset.sha256,offset:request.offset,data:store.readRange(asset.sha256,request.offset,request.length).toString('base64')};
  }
  /** @param {JsonValue} input @returns {Promise<JsonValue>} */
  async function run(input){
    for(let attempt=1;attempt<=3;attempt++){
      try{return backend ? await remote(input,controller.signal) : await local(input);}
      catch(error){
        if(!(error instanceof Error) || !('code' in error) || error.code!=='media-busy' || attempt===3 || controller.signal.aborted)throw error;
        console.warn('steam_media_storage_retry',{roomId:options.roomId,attempt,message:error.message});await delay(attempt*50,undefined,{signal:controller.signal});
      }
    }
    throw new Error('Replica storage retry loop exhausted');
  }
  /** @param {JsonValue} input @returns {Promise<JsonValue>} */
  async function transfer(input){
    const row=mediaObject(input,'Replica storage operation');
    for(const [id,bound] of uploads)if(bound.expiresAt<=Date.now() || store && !store.hasUpload(id))uploads.delete(id);
    if(row.op==='inventory'){
      const result=mediaObject(await run({op:'inventory'}),'Replica inventory');if(!Array.isArray(result.assets) || result.assets.length>4096)throw new RangeError('Replica inventory exceeds 4096 assets');
      return{assets:result.assets.map(parseMediaMetadata).filter(asset=>referencesSet.has(asset.sha256))};
    }
    const request=parseMediaRequest({...row,requestId:randomUUID()});
    if(request.op==='begin'){
      if(!referencesSet.has(request.sha256) || request.encrypted!==true && request.kind!=='image' || request.domainId!==null)throw new TypeError('Replica upload is not referenced by this room');
      if(uploads.size>=4)throw new RangeError('Four replica uploads are already active');
    }else if(request.op==='info' || request.op==='read'){
      if(!referencesSet.has(request.sha256))throw new TypeError('Replica media is not referenced by this room');
    }else{
      const bound=uploads.get(request.uploadId);if(!bound)throw new TypeError('Replica upload is not owned by this connector');
      if(request.op!=='cancel' && !referencesSet.has(bound.sha256))throw new TypeError('Replica upload is no longer referenced by this room');
    }
    const completion=request.op==='finish'?uploads.get(request.uploadId):null;
    /** @type {JsonValue} */let raw;
    try{raw=await run(request);}
    catch(error){if(!closed && (request.op==='write' || request.op==='finish') && !(error instanceof Error && 'code' in error && error.code==='media-busy'))uploads.delete(request.uploadId);throw error;}
    const result=mediaObject(raw,'Replica operation result');
    if(request.op==='begin' && result.asset===undefined){
      const uploadId=mediaId(result.uploadId,'Replica upload ID'),expiresAt=mediaInteger(result.expiresAt,'Replica upload expiration',1,Number.MAX_SAFE_INTEGER);
      if(result.chunkBytes!==16384 || expiresAt<=Date.now() || expiresAt>Date.now()+3600000)throw new TypeError('Replica upload has invalid chunk or expiration bounds');
      uploads.set(uploadId,{sha256:request.sha256,bytes:request.bytes,expiresAt,kind:request.kind,...(request.encrypted===true?{encrypted:/** @type {const} */(true)}:{})});return{uploadId,expiresAt,chunkBytes:16384};
    }
    if(request.op==='write'){const bound=uploads.get(request.uploadId);if(!bound)throw new TypeError('Replica upload disappeared before write acknowledgement');const receivedBytes=mediaInteger(result.receivedBytes,'Replica received bytes',request.offset,bound.bytes);if(receivedBytes!==request.offset+Buffer.from(request.data,'base64').length)throw new TypeError('Replica write acknowledgement has a conflicting offset');return{receivedBytes};}
    if(request.op==='cancel'){if(result.cancelled!==true)throw new TypeError('Replica cancellation was not acknowledged');uploads.delete(request.uploadId);return{cancelled:true};}
    if(request.op==='read'){
      if(!referencesSet.has(request.sha256))throw new TypeError('Replica read is no longer referenced by this room');
      if(result.sha256!==request.sha256 || result.offset!==request.offset || typeof result.data!=='string' || result.data.length>21848)throw new TypeError('Replica read range does not match its request');
      const bytes=Buffer.from(result.data,'base64');if(bytes.length!==request.length || bytes.toString('base64')!==result.data)throw new TypeError('Replica read bytes are not canonical or complete');return{sha256:request.sha256,offset:request.offset,data:result.data};
    }
    if(result.asset===undefined)throw new TypeError('Replica operation did not return verified metadata');
    const asset=parseMediaMetadata(result.asset),bound=completion;
    const expected=request.op==='begin' || request.op==='info'?request.sha256:bound?.sha256,expectedBytes=request.op==='begin'?request.bytes:bound?.bytes;
    if(asset.sha256!==expected || expectedBytes!==undefined && asset.bytes!==expectedBytes || request.op==='begin' && (asset.encrypted!==request.encrypted || asset.encrypted===true && asset.mediaKind!==request.kind) || request.op==='finish' && (asset.encrypted!==bound?.encrypted || asset.encrypted===true && asset.mediaKind!==bound?.kind))throw new TypeError('Replica metadata conflicts with the requested content');
    if(!referencesSet.has(asset.sha256))throw new TypeError('Replica metadata is no longer referenced by this room');
    if(request.op==='finish')uploads.delete(request.uploadId);return{asset};
  }
  /** @param {JsonValue} input @returns {Promise<JsonValue>} */
  function execute(input){
    if(closed)return Promise.reject(new Error('Steam media storage is closed'));
    if(tasks.size>=8)return Promise.reject(new RangeError('Steam media storage already has eight pending operations'));
    const task=transfer(input);tasks.add(task);task.then(()=>tasks.delete(task),()=>tasks.delete(task));return task;
  }
  /** @param {string[]} hashes @returns {Promise<void>} */
  async function references(hashes){
    if(closed)throw new Error('Steam media storage is closed');
    if(hashes.length>4096)throw new RangeError('Replica manifest exceeds 4096 assets');
    const next=new Set(hashes.map(mediaHash)),changed=!referencesInitialized || next.size!==referencesSet.size || [...next].some(hash=>!referencesSet.has(hash));
    if(store && changed)store.replaceReferences({catalog:[],history:[...next],backupPins:[]});referencesSet=next;referencesInitialized=true;
    if(store && (changed || Date.now()-lastGcAt>=60000)){
      for(let attempt=1;attempt<=3;attempt++)try{store.collectGarbage();lastGcAt=Date.now();break;}catch(error){if(!(error instanceof Error) || !('code' in error) || error.code!=='media-busy' || attempt===3)throw error;console.warn('steam_media_gc_retry',{roomId:options.roomId,attempt,message:error.message});await delay(attempt*50,undefined,{signal:controller.signal});}
    }
  }
  /** @returns {Promise<void>} */
  function close(){
    if(closing)return closing;closed=true;controller.abort();validator?.close();encryptedValidator?.close();
    if(store)for(const id of uploads.keys())if(store.hasUpload(id))store.cancelUpload(id);
    closing=(async()=>{
      const settled=await Promise.allSettled([...tasks]);
      for(const result of settled)if(result.status==='rejected')console.warn('steam_media_close_operation_rejected',{roomId:options.roomId,message:result.reason instanceof Error?result.reason.message:String(result.reason)});
      const deadline=AbortSignal.timeout(30000);while(validator && (validator.stats().active || validator.stats().queued))await delay(10,undefined,{signal:deadline});
      /** @type {Error[]} */const failures=[];
      if(backend)for(const [uploadId,bound] of uploads)if(bound.expiresAt>Date.now())try{await remote({op:'cancel',uploadId},AbortSignal.timeout(2000));}catch(error){const failure=error instanceof Error?error:new TypeError('Replica cancellation failed without an Error',{cause:error});console.warn('steam_media_close_cancel_failed',{roomId:options.roomId,uploadId,message:failure.message});failures.push(failure);}
      uploads.clear();store?.close();if(failures.length)throw new AggregateError(failures,'Steam media close could not cancel remote staging uploads');
    })();return closing;
  }
  return{execute,references,close};
}
module.exports={createSteamMediaStorage};
