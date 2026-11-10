// @ts-check
import {parseMediaRequest,parseMediaMetadata,mediaObject,mediaId,mediaInteger,MEDIA_CHUNK_BYTES} from './chat-protocol.js';
/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {{[key:string]:JsonValue}} JsonObject */
/** @typedef {import('./chat-protocol.js').MediaMetadata} MediaMetadata */
/** @typedef {import('./chat-protocol.js').MediaKind} MediaKind */
/** @typedef {{send:(frame:JsonObject)=>boolean,isReady:()=>boolean}} ClientOptions */
/** @typedef {{reply:string,resolve:(result:JsonValue)=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>,signal:AbortSignal,abort:()=>void}} PendingRequest */
/** @typedef {Error & {code:string,retryAfterMs:number,activated?:true}} ResponseError */
/** @param {number} milliseconds @param {AbortSignal} signal @returns {Promise<void>} */
function delay(milliseconds,signal){signal.throwIfAborted();return new Promise((resolve,reject)=>{const cancel=()=>{clearTimeout(timer);reject(new DOMException('Media request was cancelled','AbortError'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},milliseconds);signal.addEventListener('abort',cancel,{once:true});});}
/** @param {Uint8Array} bytes @returns {string} */
function base64(bytes){let encoded='';for(let offset=0;offset<bytes.length;offset+=8192)encoded+=String.fromCharCode(...bytes.subarray(offset,offset+8192));return btoa(encoded);}
/** @param {JsonValue|undefined} value @param {number} length @returns {Uint8Array<ArrayBuffer>} */
function binary(value,length){if(typeof value!=='string' || value.length>Math.ceil(MEDIA_CHUNK_BYTES/3)*4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw new TypeError('Media range must contain bounded canonical base64');const bytes=Uint8Array.from(atob(value),character=>character.charCodeAt(0));if(bytes.length!==length || base64(bytes)!==value)throw new TypeError('Media range bytes do not match the requested size');return bytes;}
/** @param {Blob} blob @returns {Promise<string>} */
async function hash(blob){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(byte=>byte.toString(16).padStart(2,'0')).join('');}

/** @param {ClientOptions} options */
export function createChatMediaClient(options){
  /** @type {Map<string,PendingRequest>} */const pending=new Map();
  /** @type {Map<string,{blob:Blob,kind:'original'|'poster'}>} */const cache=new Map();
  let cacheBytes=0,posterBytes=0,generation=0,nextChunkAt=0,downloads=0,queuedDownloads=0;
  /** @param {string} key @returns {Blob|null} */
  function cached(key){const entry=cache.get(key);if(!entry)return null;cache.delete(key);cache.set(key,entry);return entry.blob;}
  /** @param {string} key @param {Blob} blob @param {'original'|'poster'} kind @returns {void} */
  function remember(key,blob,kind){
    if(blob.size>8*1024*1024)return;
    const previous=cache.get(key);if(previous){cacheBytes-=previous.blob.size;if(previous.kind==='poster')posterBytes-=previous.blob.size;}cache.delete(key);cache.set(key,{blob,kind});cacheBytes+=blob.size;if(kind==='poster')posterBytes+=blob.size;
    while(cacheBytes>8*1024*1024){const oldest=cache.keys().next().value;if(oldest===undefined)break;const entry=cache.get(oldest);if(!entry)throw new Error('Media cache entry disappeared during eviction');cacheBytes-=entry.blob.size;if(entry.kind==='poster')posterBytes-=entry.blob.size;cache.delete(oldest);}
  }
  /** @param {string} sha256 @returns {Blob|null} */
  function getPoster(sha256){return cached('poster:'+sha256);}
  /** @param {string} sha256 @param {Blob} blob @returns {void} */
  function cachePoster(sha256,blob){remember('poster:'+sha256,blob,'poster');}
  /** @type {Promise<void>} */let pacing=Promise.resolve();
  /** @type {Set<()=>void>} */const downloadWaiters=new Set();
  /** @param {string} id @returns {PendingRequest|null} */
  function take(id){const entry=pending.get(id);if(!entry)return null;pending.delete(id);clearTimeout(entry.timer);entry.signal.removeEventListener('abort',entry.abort);return entry;}
  /** @param {JsonObject} frame @param {AbortSignal} signal @returns {Promise<JsonValue>} */
  function attempt(frame,signal){
    signal.throwIfAborted();if(!options.isReady())return Promise.reject(new Error('房间连接尚未就绪'));if(pending.size>=32)return Promise.reject(new RangeError('Too many outstanding chat/media requests'));
    const id=mediaId(frame.requestId,'Client request ID'),replies={mediaRequest:'mediaResult',chat:'chatResult',setReaction:'reactionResult',governanceChange:'governanceResult',contentRequest:'contentResult'},type=frame.t;
    if(type!=='mediaRequest' && type!=='chat' && type!=='setReaction' && type!=='governanceChange' && type!=='contentRequest')throw new TypeError('Unsupported acknowledged client request');
    return new Promise((resolve,reject)=>{
      const abort=()=>take(id)?.reject(new DOMException('Chat/media request was cancelled','AbortError')),timer=setTimeout(()=>take(id)?.reject(new Error('服务器确认超时：'+type+' / '+id)),90000);
      if(pending.has(id)){clearTimeout(timer);reject(new TypeError('Client request ID is already in flight'));return;}
      pending.set(id,{reply:replies[type],resolve,reject,timer,signal,abort});signal.addEventListener('abort',abort,{once:true});if(!options.send(frame))take(id)?.reject(new Error('房间连接中断，操作尚未确认'));
    });
  }
  /** @param {JsonObject} frame @param {AbortSignal} signal @returns {Promise<JsonValue>} */
  async function call(frame,signal){
    const requestId=typeof frame.requestId==='string' ? mediaId(frame.requestId,'Client request ID') : crypto.randomUUID(),request={...frame,requestId};
    for(let index=0;index<3;index++){
      try{return await attempt(request,signal);}catch(error){
        if(!(error instanceof Error) || !('code' in error) || (error.code!=='media-busy' && error.code!=='media-rate-limited') || index===2)throw error;
        const failure=/** @type {ResponseError} */(error),wait=Math.max(250,failure.retryAfterMs);console.warn('chat_media_request_retry',{requestId,operation:frame.t,attempt:index+1,code:failure.code,retryAfterMs:wait});await delay(wait,signal);
      }
    }throw new Error('Chat/media request retries ended without a result');
  }
  /** @param {JsonValue} input @returns {boolean} */
  function receive(input){
    const value=mediaObject(input,'Server event');if(value.t!=='mediaResult' && value.t!=='chatResult' && value.t!=='reactionResult' && value.t!=='governanceResult' && value.t!=='contentResult')return false;
    const id=mediaId(value.requestId,'Acknowledged request ID'),entry=take(id);if(!entry)return true;
    if(value.t!==entry.reply){entry.reject(new TypeError('Server acknowledgement type does not match its request'));return true;}
    if(value.ok===true){if(value.result===undefined)entry.reject(new TypeError('Server acknowledgement has no result'));else entry.resolve(value.result);return true;}
    if(value.ok!==false || typeof value.code!=='string' || typeof value.message!=='string'){entry.reject(new TypeError('Server rejected request without a typed error'));return true;}
    try{const retryAfterMs=value.retryAfterMs===null || value.retryAfterMs===undefined ? 250 : mediaInteger(value.retryAfterMs,'Retry delay',0,60000);entry.reject(Object.assign(new Error(value.message),{code:value.code,retryAfterMs,...(value.t==='contentResult'&&value.activated===true?{activated:/** @type {const} */(true)}:{})}));}catch(error){entry.reject(error instanceof Error ? error : new Error(String(error)));}return true;
  }
  /** @param {JsonObject} input @param {AbortSignal} signal @returns {Promise<JsonValue>} */
  function media(input,signal){const request=parseMediaRequest({...input,requestId:crypto.randomUUID()});return call({t:'mediaRequest',...request},signal);}
  /** @param {AbortSignal} signal @returns {Promise<void>} */
  function pace(signal){const task=pacing.then(async()=>{signal.throwIfAborted();await delay(Math.max(0,nextChunkAt-performance.now()),signal);nextChunkAt=performance.now()+70;});pacing=task.then(()=>{},()=>{});return task;}
  /** @param {Blob} blob @param {MediaMetadata} asset @param {MediaKind} kind @param {string|null} domainId @param {AbortSignal} signal @returns {Promise<MediaMetadata>} */
  async function upload(blob,asset,kind,domainId,signal){
    if(blob.size!==asset.bytes || await hash(blob)!==asset.sha256)throw new TypeError('Upload bytes disagree with their AVIF metadata');signal.throwIfAborted();
    const begun=mediaObject(await media({op:'begin',kind,sha256:asset.sha256,bytes:asset.bytes,domainId,...(asset.encrypted?{encrypted:true}:{})},signal),'Upload acknowledgement');if(begun.asset!==undefined)return parseMediaMetadata(begun.asset);
    const uploadId=mediaId(begun.uploadId,'Upload ID');if(begun.chunkBytes!==MEDIA_CHUNK_BYTES)throw new TypeError('Server upload chunk size differs from the shared protocol');let finished=false;
    try{
      for(let offset=0;offset<blob.size;offset+=MEDIA_CHUNK_BYTES){await pace(signal);const bytes=new Uint8Array(await blob.slice(offset,offset+MEDIA_CHUNK_BYTES).arrayBuffer()),written=mediaObject(await media({op:'write',uploadId,offset,data:base64(bytes)},signal),'Chunk acknowledgement');if(written.receivedBytes!==offset+bytes.length)throw new TypeError('Server upload offset differs from the acknowledged chunk');}
      const result=mediaObject(await media({op:'finish',uploadId},signal),'Completed upload');if(result.asset===undefined)throw new TypeError('Completed media upload has no verified asset');const stored=parseMediaMetadata(result.asset);if(stored.sha256!==asset.sha256)throw new TypeError('Completed media upload has a conflicting SHA256');finished=true;return stored;
    }finally{if(!finished && options.isReady()){try{await media({op:'cancel',uploadId},new AbortController().signal);}catch(error){console.warn('chat_media_upload_cancel_failed',{uploadId,error:String(error)});}}}
  }
  /** @param {AbortSignal} signal @returns {Promise<void>} */
  async function acquireDownload(signal){
    if(queuedDownloads>=16)throw new RangeError('Media download queue is full');queuedDownloads+=1;
    try{while(downloads>=2){signal.throwIfAborted();await new Promise((resolve,reject)=>{const wake=()=>{signal.removeEventListener('abort',abort);downloadWaiters.delete(wake);resolve(undefined);},abort=()=>{downloadWaiters.delete(wake);reject(new DOMException('Media download was cancelled','AbortError'));};downloadWaiters.add(wake);signal.addEventListener('abort',abort,{once:true});});}signal.throwIfAborted();downloads+=1;}finally{queuedDownloads-=1;}
  }
  /** @param {MediaMetadata} asset @param {AbortSignal} signal @returns {Promise<Blob>} */
  async function download(asset,signal){
    signal.throwIfAborted();const existing=cached(asset.sha256);if(existing)return existing;
    const version=generation;await acquireDownload(signal);
    try{
      signal.throwIfAborted();if(version!==generation)throw new DOMException('Room changed during media download','AbortError');const queued=cached(asset.sha256);if(queued)return queued;
      const parts=[];for(let offset=0;offset<asset.bytes;offset+=MEDIA_CHUNK_BYTES){await pace(signal);const length=Math.min(MEDIA_CHUNK_BYTES,asset.bytes-offset),result=mediaObject(await media({op:'read',sha256:asset.sha256,offset,length},signal),'Media range');if(result.sha256!==asset.sha256 || result.offset!==offset)throw new TypeError('Media range belongs to a different asset or offset');parts.push(binary(result.data,length));}
      const blob=new Blob(parts,{type:asset.encrypted?'application/octet-stream':'image/avif'});if(blob.size!==asset.bytes || await hash(blob)!==asset.sha256)throw new TypeError('Downloaded media failed its actual size/SHA256 validation');signal.throwIfAborted();if(version!==generation)throw new DOMException('Room changed during media download','AbortError');
      remember(asset.sha256,blob,'original');return blob;
    }finally{downloads-=1;for(const wake of [...downloadWaiters])wake();}
  }
  /** @returns {void} */
  function reset(){generation+=1;for(const id of [...pending.keys()])take(id)?.reject(new DOMException('服务器连接已变化，操作未确认','AbortError'));cache.clear();cacheBytes=0;posterBytes=0;nextChunkAt=0;}
  return {call,receive,upload,download,getPoster,cachePoster,reset,stats:()=>({requests:pending.size,downloads,queuedDownloads,cacheBytes:cacheBytes-posterBytes,posters:posterBytes,mediaCacheBytes:cacheBytes})};
}
