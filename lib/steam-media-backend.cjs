// @ts-check
'use strict';
const {randomUUID,timingSafeEqual}=require('node:crypto');
const {parseMediaRequest,parseMediaMetadata,mediaObject,mediaHash,mediaId}=require('../public/js/chat-protocol.js');
const {MediaBudgetBusyError}=require('./media-store.cjs');
const {MediaError}=require('./room-media.cjs');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../public/js/chat-protocol.js').MediaMetadata} MediaMetadata */
/** @typedef {ReturnType<typeof import('./media-store.cjs').openMediaStore>} Storage */
/** @typedef {{promise:Promise<void>,resolve:()=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}} Pending */

/** @param {{key:Buffer,storage:Storage,manifest:()=>MediaMetadata[],send:(message:JsonValue)=>void}} options */
function createSteamMediaBackend(options){
  if(!Buffer.isBuffer(options.key) || options.key.length!==32)throw new TypeError('Steam media backend requires a 32-byte private key');
  const key=Buffer.from(options.key);
  /** @type {Map<string,Pending>} */const pending=new Map();
  /** @type {Map<string,string>} */const uploads=new Map();
  let closed=false,inflight=0;
  /** @param {string} hash @returns {MediaMetadata} */
  function referenced(hash){const sha256=mediaHash(hash),assets=options.manifest();if(!Array.isArray(assets) || assets.length>4096)throw new RangeError('Steam media manifest exceeds 4096 assets');const asset=assets.find(item=>item.sha256===sha256);if(!asset)throw new MediaError('permission-denied','Media is not referenced by the current room',null,null);return parseMediaMetadata(asset);}
  /** @param {MediaMetadata} expected @returns {MediaMetadata|null} */
  function present(expected){const found=options.storage.metadata(expected.sha256);if(!found)return null;const asset=parseMediaMetadata(found);if(JSON.stringify(asset)!==JSON.stringify(expected))throw new MediaError('media-invalid','Published metadata conflicts with the verified stored AVIF',null,null);return asset;}
  /** @param {string} uploadId @returns {MediaMetadata} */
  function owned(uploadId){const hash=uploads.get(uploadId);if(!hash)throw new MediaError('permission-denied','Backup upload does not belong to this bridge',null,null);try{return referenced(hash);}catch(error){uploads.delete(uploadId);if(options.storage.hasUpload(uploadId))options.storage.cancelUpload(uploadId);throw error;}}
  /** @param {string} hash @returns {Promise<void>} */
  function ensure(hash){
    if(closed)return Promise.reject(new Error('Steam media backend is closed'));
    if(present(referenced(hash)))return Promise.resolve();
    const previous=pending.get(hash);if(previous)return previous.promise;
    if(pending.size>=4)return Promise.reject(new RangeError('Four Steam media recoveries are already active'));
    /** @type {()=>void} */let resolve=()=>{};
    /** @type {(error:Error)=>void} */let reject=()=>{};
    /** @type {Promise<void>} */const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const timer=setTimeout(()=>{pending.delete(hash);reject(new Error('Media copies did not respond within 30 seconds'));},30000);
    pending.set(hash,{promise,resolve,reject,timer});
    try{options.send({t:'steam-media-needed',sha256:hash});}
    catch(error){pending.delete(hash);clearTimeout(timer);reject(error instanceof Error?error:new TypeError('Steam media recovery send failed without an Error',{cause:error}));}
    return promise;
  }
  /** @param {JsonValue} input @returns {void} */
  function receive(input){
    if(closed)return;
    const row=mediaObject(input,'Steam media response');
    const hash=mediaHash(row.sha256),entry=pending.get(hash);if(!entry)return;
    pending.delete(hash);clearTimeout(entry.timer);
    try{if(row.ok===true && present(referenced(hash)))entry.resolve();else entry.reject(new Error(typeof row.message==='string' ? row.message.slice(0,500) : 'All saved copies are currently unavailable'));}
    catch(error){entry.reject(error instanceof Error?error:new TypeError('Steam media recovery failed without an Error',{cause:error}));}
  }
  /** @param {JsonValue} value @returns {Promise<JsonValue>} */
  async function execute(value){
    if(closed)throw new MediaError('media-unavailable','Steam media backend is closed',null,null);
    for(const id of uploads.keys())if(!options.storage.hasUpload(id))uploads.delete(id);
    const row=mediaObject(value,'Steam media bridge command');
    if(row.op==='inventory'){const assets=options.manifest();if(!Array.isArray(assets) || assets.length>4096)throw new RangeError('Steam media manifest exceeds 4096 assets');return {assets:assets.flatMap(value=>{const asset=present(parseMediaMetadata(value));return asset?[asset]:[];})};}
    const request=parseMediaRequest({...row,requestId:randomUUID()});
    if(request.op==='begin'){
      const asset=referenced(request.sha256);
      if(request.bytes!==asset.bytes || request.encrypted!==asset.encrypted || request.kind!==(asset.encrypted===true?asset.mediaKind:'image') || request.domainId!==null)throw new TypeError('Backup upload does not match the published asset');
      const cached=present(asset);if(cached)return{asset:cached};
      if(uploads.size>=2)throw new RangeError('Two backup uploads are already active');
      const result=options.storage.beginUpload({kind:request.kind,expectedSha256:asset.sha256,totalBytes:asset.bytes,...(asset.encrypted===true?{encrypted:/** @type {const} */(true)}:{})});uploads.set(result.uploadId,asset.sha256);return result;
    }
    if(request.op==='write' || request.op==='finish' || request.op==='cancel'){
      if(!uploads.has(request.uploadId))throw new MediaError('permission-denied','Backup upload does not belong to this bridge',null,null);
      if(request.op==='cancel'){uploads.delete(request.uploadId);if(options.storage.hasUpload(request.uploadId))options.storage.cancelUpload(request.uploadId);return{cancelled:true};}
      owned(request.uploadId);
      if(request.op==='write'){
        const data=Buffer.from(request.data,'base64');if(data.toString('base64')!==request.data){uploads.delete(request.uploadId);if(options.storage.hasUpload(request.uploadId))options.storage.cancelUpload(request.uploadId);throw new TypeError('Backup chunk is not canonical base64');}
        try{return options.storage.writeChunk(request.uploadId,request.offset,data);}finally{if(!options.storage.hasUpload(request.uploadId))uploads.delete(request.uploadId);}
      }
      try{
        const asset=await options.storage.finishUpload(request.uploadId);
        present(referenced(asset.sha256));
        return{asset};
      }finally{if(!options.storage.hasUpload(request.uploadId))uploads.delete(request.uploadId);}
    }
    if(request.op!=='info' && request.op!=='read')throw new TypeError('Unsupported backup operation');
    const expected=referenced(request.sha256),asset=present(expected);
    if(!asset)throw new MediaError('media-unavailable','Referenced media is not stored on this member',null,null);
    if(request.op==='info')return{asset};
    return{sha256:asset.sha256,offset:request.offset,data:options.storage.readRange(asset.sha256,request.offset,request.length).toString('base64')};
  }
  /** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response @returns {Promise<void>} */
  async function handle(request,response){
    const token=request.headers['x-deepscord-media-key'];
    if(request.method!=='POST' || request.socket.remoteAddress!=='127.0.0.1' || typeof token!=='string' || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token,'hex'),key)){
      response.writeHead(403,{'Connection':'close'});response.end();return;
    }
    if(inflight>=8){response.writeHead(503,{'Content-Type':'application/json','Connection':'close'});response.end(JSON.stringify({ok:false,code:'media-busy',message:'Steam media bridge already has eight pending requests',retryAfterMs:50}));return;}
    inflight+=1;
    /** @type {string|null} */let activeUploadId=null;
    const deadline=setTimeout(()=>request.destroy(new Error('Steam media HTTP request exceeded 30 seconds')),30000);deadline.unref();
    const abandoned=()=>{if(response.writableEnded || !activeUploadId || !uploads.has(activeUploadId))return;uploads.delete(activeUploadId);if(options.storage.hasUpload(activeUploadId))options.storage.cancelUpload(activeUploadId);};
    response.once('close',abandoned);
    try{
      const declared=request.headers['content-length'];if(typeof declared==='string' && (!/^\d+$/.test(declared) || Number(declared)>24576))throw new RangeError('Media bridge request exceeds 24 KiB');
      const chunks=[];let length=0;
      for await(const chunk of request){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);length+=bytes.length;if(length>24576)throw new RangeError('Media bridge request exceeds 24 KiB');chunks.push(bytes);}
      /** @type {JsonValue} */const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const command=mediaObject(input,'Steam media HTTP command');if(command.uploadId!==undefined)activeUploadId=mediaId(command.uploadId,'Backup upload ID');
      const result=await execute(input);
      if(command.op==='begin'){const opened=mediaObject(result,'Backup upload result');if(opened.uploadId!==undefined)activeUploadId=mediaId(opened.uploadId,'Backup upload ID');}
      response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify({ok:true,result}));
    }catch(error){
      if(!(error instanceof Error))throw new TypeError('Media bridge failed without an Error',{cause:error});
      const failure=error instanceof MediaError?error:error instanceof MediaBudgetBusyError?new MediaError('media-busy','Media cache budget is busy; retry after the specified delay',error.retryAfterMs,error):new MediaError(error instanceof RangeError?'media-limit-exceeded':error instanceof TypeError || error instanceof SyntaxError?'media-invalid':'media-storage-failed','Steam media request was rejected by its manifest, content or storage boundary',null,error);
      console.warn('steam_media_bridge_rejected',{code:failure.code,message:failure.message,cause:error.message});
      if(response.destroyed)return;
      response.writeHead(failure.code==='permission-denied'?403:failure.code==='media-busy' || failure.code==='media-unavailable'?503:400,{'Content-Type':'application/json','Connection':'close'});response.end(JSON.stringify({ok:false,message:failure.message,code:failure.code,retryAfterMs:failure.retryAfterMs}));
    }finally{clearTimeout(deadline);inflight-=1;}
  }
  function close(){closed=true;for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error('Steam media backend closed'));}pending.clear();for(const id of uploads.keys()){if(options.storage.hasUpload(id))options.storage.cancelUpload(id);}uploads.clear();}
  return{ensure,receive,handle,close};
}
module.exports={createSteamMediaBackend};
