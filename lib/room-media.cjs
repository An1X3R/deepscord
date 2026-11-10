// @ts-check
'use strict';

const {parseMediaRequest,parseMediaMetadata,checkMediaKind,mediaId,mediaHash}=require('../public/js/chat-protocol.js');
const {MediaBudgetBusyError}=require('./media-store.cjs');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../public/js/chat-protocol.js').MediaMetadata} MediaMetadata */
/** @typedef {import('../public/js/chat-protocol.js').MediaKind} MediaKind */
/** @typedef {ReturnType<typeof import('./media-store.cjs').openMediaStore>} Storage */
/** @typedef {{id:string,memberKey:string|null}} MediaActor */
/** @typedef {{uploadId:string,kind:MediaKind,domainId:string|null,expiresAt:number}} BoundUpload */
/** @typedef {{memberKey:string,upload:BoundUpload|null,finishing:boolean,grants:Map<string,number>}} ActorState */
/** @typedef {{startedAt:number,chunks:number}} RateWindow */
/** @typedef {'permission-denied'|'media-unavailable'|'media-rate-limited'|'media-busy'|'media-limit-exceeded'|'media-storage-failed'|'media-invalid'} MediaErrorCode */

const MAX_ACTORS=256,MAX_FINISHED=32,FINISHED_TTL_MS=300000,CHUNKS_PER_SECOND=16,MAX_REFERENCES=8192;

class MediaError extends Error {
  /** @param {MediaErrorCode} code @param {string} message @param {number|null} retryAfterMs @param {Error|null} cause */
  constructor(code,message,retryAfterMs,cause) { super(message,cause?{cause}:{});this.name='MediaError';this.code=code;this.retryAfterMs=retryAfterMs; }
}

/** A room connector accepts only actor identities already proved by the transport. @param {{storage:Storage,getReferences:()=>string[],canManage:(memberKey:string)=>boolean,getMigrationOwnerKey?:()=>string|null}} options */
function createRoomMedia(options) {
  const storage=options.storage,getReferences=options.getReferences,canManage=options.canManage;
  /** @type {Map<string,ActorState>} */const actors=new Map();
  /** @type {Map<string,RateWindow>} */const rates=new Map();
  /** @type {Map<string,RateWindow>} */const readRates=new Map();

  /** @param {ActorState} state @returns {{maximum:number,ttlMs:number}} */function grantPolicy(state) {
    return options.getMigrationOwnerKey?.()===state.memberKey?{maximum:4096,ttlMs:1800000}:{maximum:MAX_FINISHED,ttlMs:FINISHED_TTL_MS};
  }
  /** @param {ActorState} state @returns {void} */function expireGrants(state) {
    const now=Date.now();for(const [hash,expiresAt] of state.grants)if(expiresAt<=now)state.grants.delete(hash);
    if(state.upload && !storage.hasUpload(state.upload.uploadId))state.upload=null;
  }
  /** @returns {void} */function sweep() {
    const now=Date.now();
    for(const [id,state] of actors) { expireGrants(state);if(!state.upload && !state.finishing && !state.grants.size)actors.delete(id); }
    for(const [key,window] of rates)if(now-window.startedAt>=1000)rates.delete(key);
    for(const [key,window] of readRates)if(now-window.startedAt>=1000)readRates.delete(key);
  }
  /** @param {MediaActor} actor @returns {{id:string,key:string,state:ActorState}} */function actorState(actor) {
    const id=mediaId(actor.id,'Media actor ID'),key=actor.memberKey;
    if(typeof key!=='string' || !key || key.length>256)throw new MediaError('permission-denied','Media requires a proved persistent member identity',null,null);
    sweep();let state=actors.get(id);
    if(state && state.memberKey!==key)throw new MediaError('permission-denied','Media actor identity changed during this connection',null,null);
    if(!state) {
      if(actors.size>=MAX_ACTORS)throw new MediaError('media-limit-exceeded','Media actor authorization capacity is full',null,null);
      state={memberKey:key,upload:null,finishing:false,grants:new Map()};actors.set(id,state);
    }
    return {id,key,state};
  }
  /** @returns {Set<string>} */function publicReferences() {
    const values=getReferences();if(!Array.isArray(values) || values.length>MAX_REFERENCES)throw new RangeError('Room media references exceed their bounded inventory');
    return new Set(values.map(mediaHash));
  }
  /** @param {ActorState} state @param {string} hash @returns {void} */function requireReadable(state,hash) {
    if(!publicReferences().has(hash) && !state.grants.has(hash))throw new MediaError('permission-denied','This media is not published in the room or owned by this connection',null,null);
  }
  /** @param {string} key @param {MediaKind} kind @param {string|null} domainId @returns {void} */function requirePurpose(key,kind,domainId) {
    if(kind==='server') {
      if(domainId!==null || !canManage(key))throw new MediaError('permission-denied','Server media requires the server owner or a server administrator and a null domain',null,null);
    } else if(domainId!==null)throw new MediaError('media-invalid','Personal and image uploads must use a null domain',null,null);
  }
  /** @template T @param {string} operation @param {()=>T} task @returns {T} */function accessStorage(operation,task) {
    try { return task(); }
    catch(error) {
      if(error instanceof MediaBudgetBusyError)throw new MediaError('media-busy','Media cache budget is busy; retry after the specified delay',error.retryAfterMs,error);
      if(error instanceof Error)throw new MediaError('media-storage-failed','Media '+operation+' failed; storage integrity, capacity or content validation was rejected',null,error);
      throw new TypeError('Media storage raised a non-error failure',{cause:error});
    }
  }
  /** @param {ActorState} state @returns {void} */function cancelBound(state) {
    const bound=state.upload;state.upload=null;
    if(bound && storage.hasUpload(bound.uploadId))accessStorage('cancellation',()=>storage.cancelUpload(bound.uploadId));
  }
  /** @param {ActorState} state @param {string} uploadId @returns {BoundUpload} */function boundUpload(state,uploadId) {
    const bound=state.upload;
    if(!bound || bound.uploadId!==uploadId)throw new MediaError('permission-denied','This upload does not belong to the current connection',null,null);
    return bound;
  }
  /** @param {Map<string,RateWindow>} windows @param {string} key @param {string} operation @returns {void} */function countTransfer(windows,key,operation) {
    const now=Date.now();let window=windows.get(key);
    if(!window) {
      if(windows.size>=MAX_ACTORS)throw new MediaError('media-rate-limited','Media transfer rate capacity is full',1000,null);
      window={startedAt:now,chunks:0};windows.set(key,window);
    }
    if(window.chunks>=CHUNKS_PER_SECOND)throw new MediaError('media-rate-limited','Media permits at most 16 '+operation+' chunks per second',Math.max(1,1000-(now-window.startedAt)),null);
    window.chunks+=1;
  }
  /** @param {ActorState} state @param {string} hash @returns {MediaMetadata} */function readableAsset(state,hash) {
    requireReadable(state,hash);const asset=accessStorage('metadata lookup',()=>storage.metadata(hash));
    if(!asset)throw new MediaError('media-unavailable','Authorized media is temporarily unavailable on this server',null,null);
    return parseMediaMetadata(asset);
  }
  /** @param {MediaActor} actor @param {JsonValue} descriptor @returns {MediaMetadata} */function authorizeAttachment(actor,descriptor) {
    const {state}=actorState(actor),provided=parseMediaMetadata(descriptor),actual=readableAsset(state,provided.sha256);
    if(JSON.stringify(provided)!==JSON.stringify(actual))throw new MediaError('media-invalid','Attachment metadata does not match the verified stored media',null,null);
    return actual;
  }
  /** @param {MediaActor} actor @param {JsonValue} input @returns {Promise<JsonValue>} */async function execute(actor,input) {
    const request=parseMediaRequest(input),{id,key,state}=actorState(actor);
    if(request.op==='begin') {
      requirePurpose(key,request.kind,request.domainId);
      const refs=publicReferences();
      if(state.grants.has(request.sha256) || refs.has(request.sha256)) {
        const asset=accessStorage('metadata lookup',()=>storage.metadata(request.sha256));
        if(asset) {
          if(asset.bytes!==request.bytes || asset.encrypted!==request.encrypted || asset.encrypted===true && asset.mediaKind!==request.kind)throw new MediaError('media-invalid','Declared upload bytes do not match the verified content',null,null);
          return {asset:checkMediaKind(asset,request.kind)};
        }
      }
      if(state.upload || state.finishing)throw new MediaError('media-busy','This connection already has an active media upload',null,null);
      if(state.grants.size>=grantPolicy(state).maximum && !state.grants.has(request.sha256))throw new MediaError('media-limit-exceeded','This connection has reached its unpublished media asset limit',null,null);
      const opened=accessStorage('upload creation',()=>storage.beginUpload({kind:request.kind,totalBytes:request.bytes,expectedSha256:request.sha256,...(request.encrypted===true?{encrypted:/** @type {const} */(true)}:{})}));
      state.upload={uploadId:opened.uploadId,expiresAt:opened.expiresAt,kind:request.kind,domainId:request.domainId};return opened;
    }
    if(request.op==='write') {
      boundUpload(state,request.uploadId);if(state.finishing)throw new MediaError('media-busy','This upload is already being validated',null,null);
      countTransfer(rates,key,'upload');const bytes=Buffer.from(request.data,'base64');
      if(bytes.length>16384 || bytes.toString('base64')!==request.data) { cancelBound(state);throw new MediaError('media-invalid','Media chunks must be canonical base64 for at most 16384 bytes',null,null); }
      try { return accessStorage('chunk write',()=>storage.writeChunk(request.uploadId,request.offset,bytes)); }
      catch(error) { if(!storage.hasUpload(request.uploadId))state.upload=null;throw error; }
    }
    if(request.op==='cancel') { boundUpload(state,request.uploadId);cancelBound(state);return {cancelled:true}; }
    if(request.op==='finish') {
      const bound=boundUpload(state,request.uploadId);if(state.finishing)throw new MediaError('media-busy','This upload is already being validated',null,null);
      try { requirePurpose(key,bound.kind,bound.domainId); } catch(error) { cancelBound(state);throw error; }
      state.finishing=true;
      try {
        /** @type {MediaMetadata} */let asset;
        try { asset=await storage.finishUpload(request.uploadId); }
        catch(error) { if(error instanceof MediaBudgetBusyError)throw new MediaError('media-busy','Media cache budget is busy; retry after the specified delay',error.retryAfterMs,error);if(error instanceof Error)throw new MediaError('media-storage-failed','Media upload could not be committed after full content validation',null,error);throw new TypeError('Media decoder raised a non-error failure',{cause:error}); }
        if(actors.get(id)!==state || state.upload!==bound)throw new MediaError('permission-denied','Media upload connection ended before completion',null,null);
        requirePurpose(key,bound.kind,bound.domainId);expireGrants(state);
        if(state.grants.size>=grantPolicy(state).maximum && !state.grants.has(asset.sha256))throw new MediaError('media-limit-exceeded','This connection has reached its unpublished media asset limit',null,null);
        state.grants.set(asset.sha256,Date.now()+grantPolicy(state).ttlMs);return {asset};
      } finally { state.finishing=false;if(state.upload===bound && !storage.hasUpload(bound.uploadId))state.upload=null; }
    }
    if(request.op==='info')return {asset:readableAsset(state,request.sha256)};
    if(request.op==='read') {
      readableAsset(state,request.sha256);
      countTransfer(readRates,key,'download');
      const bytes=accessStorage('range read',()=>storage.readRange(request.sha256,request.offset,request.length));return {sha256:request.sha256,offset:request.offset,data:bytes.toString('base64')};
    }
    throw new TypeError('Unsupported media operation');
  }
  /** @param {string} id @returns {void} */function dropActor(id) {
    const state=actors.get(mediaId(id,'Media actor ID'));if(!state)return;actors.delete(id);cancelBound(state);state.grants.clear();
  }
  return {execute,dropActor,authorizeAttachment};
}

module.exports={createRoomMedia,MediaError};
