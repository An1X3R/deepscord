// @ts-check
'use strict';
const codec=require('./avif-codec.cjs');
const {inspectSealedFile}=require('./content-crypto.cjs');
/** @typedef {import('../public/js/chat-protocol.js').MediaKind} MediaKind */
/** @typedef {import('./media-store.cjs').MediaValidation} MediaValidation */
/** @typedef {{bytes:Buffer,kind:MediaKind,signal:AbortSignal,controller:AbortController,resolve:(value:MediaValidation)=>void,reject:(error:Error)=>void,abort:()=>void}} ValidationTask */

/** Serialize expensive decoding at an explicit storage boundary. @param {{maxPending:number}} options */
function createMediaValidator(options){
  if(!Number.isSafeInteger(options.maxPending) || options.maxPending<1 || options.maxPending>8)throw new RangeError('Media validation queue must contain 1..8 tasks');
  /** @type {ValidationTask[]} */const waiting=[];
  /** @type {ValidationTask|null} */let active=null;
  let closed=false;
  /** @returns {void} */
  function pump(){
    if(active || closed)return;
    const task=waiting.shift();if(!task)return;
    active=task;
    codec.validate(task.bytes,task.kind,task.controller.signal).then(metadata=>task.resolve({width:metadata.width,height:metadata.height,animated:metadata.animated,frames:metadata.frames,durationMs:metadata.durationMs}),error=>task.reject(error instanceof Error ? error : new Error(String(error)))).finally(()=>{task.signal.removeEventListener('abort',task.abort);active=null;pump();});
  }
  /** @param {Buffer} bytes @param {MediaKind} kind @param {AbortSignal} signal @returns {Promise<MediaValidation>} */
  function validate(bytes,kind,signal){
    if(closed)return Promise.reject(new Error('Media validator is closed'));
    if(signal.aborted)return Promise.reject(new DOMException('Media validation was cancelled','AbortError'));
    if(waiting.length+Number(active!==null)>=options.maxPending)return Promise.reject(new RangeError('Media validation is busy; try again after the current upload completes'));
    return new Promise((resolve,reject)=>{
      const controller=new AbortController();
      /** @type {ValidationTask} */const task={bytes,kind,signal,controller,resolve,reject,abort:()=>{
        controller.abort();
        const index=waiting.indexOf(task);
        if(index!==-1){waiting.splice(index,1);signal.removeEventListener('abort',task.abort);reject(new DOMException('Queued media validation was cancelled','AbortError'));}
      }};
      waiting.push(task);signal.addEventListener('abort',task.abort,{once:true});
      if(signal.aborted)task.abort();else pump();
    });
  }
  /** @returns {void} */
  function close(){closed=true;active?.controller.abort();for(const task of waiting.splice(0)){task.signal.removeEventListener('abort',task.abort);task.reject(new Error('Media validator closed before validation'));}}
  return{validate,close,stats:()=>({active:Number(active!==null),queued:waiting.length})};
}
/** Inspect routing metadata without obtaining a room key or decoding content. @param {{roomId:string}} options */
function createEncryptedMediaValidator(options){
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(options.roomId))throw new TypeError('Encrypted media validator requires a canonical room UUID');
  let closed=false;
  /** @param {Buffer} bytes @param {MediaKind} kind @param {AbortSignal} signal @returns {Promise<MediaValidation>} */
  async function validate(bytes,kind,signal){
    if(closed)throw new Error('Encrypted media validator is closed');
    if(signal.aborted)throw new DOMException('Encrypted media validation was cancelled','AbortError');
    const {header}=inspectSealedFile(bytes);
    if(header.roomId!==options.roomId || header.kind!==kind)throw new TypeError('Encrypted media envelope must match its upload room and kind');
    return {width:header.width,height:header.height,animated:header.animated,frames:header.frames,durationMs:header.durationMs,encrypted:true,mediaKind:header.kind};
  }
  /** @returns {void} */function close(){closed=true;}
  return {validate,close,stats:()=>({active:0,queued:0})};
}
module.exports={createMediaValidator,createEncryptedMediaValidator};
