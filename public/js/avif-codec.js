// @ts-check
import {parseMediaKind,parseMediaMetadata,checkMediaKind} from './chat-protocol.js';
/** @typedef {import('./chat-protocol.js').MediaKind} MediaKind */
/** @typedef {import('./chat-protocol.js').MediaMetadata} MediaMetadata */
/** @typedef {{blob:Blob,metadata:MediaMetadata}} PreparedMedia */
/** @typedef {{operation:'prepare',file:Blob,name:string,kind:MediaKind}|{operation:'inspect',file:Blob,kind:MediaKind}|{operation:'poster',file:Blob}} CodecTask */
/** @typedef {{ok:true,blob:Blob,metadata:MediaMetadata}|{ok:true,metadata:MediaMetadata}|{ok:true,poster:Blob}|{ok:false,name:string,message:string}} CodecReply */
/** @typedef {{task:CodecTask,signal:AbortSignal,resolve:(reply:CodecReply)=>void,reject:(error:Error)=>void,abort:()=>void,done:boolean}} QueuedTask */

/** @returns {{prepare:(file:Blob,name:string,kind:MediaKind,signal:AbortSignal)=>Promise<PreparedMedia>,inspect:(blob:Blob,kind:MediaKind,signal:AbortSignal)=>Promise<MediaMetadata>,poster:(blob:Blob,signal:AbortSignal)=>Promise<Blob>,destroy:()=>void,stats:()=>{active:number,queued:number,completed:number,cancelled:number,failed:number}}} */
export function createAvifCodec() {
  /** @type {QueuedTask[]} */ let queue=[];
  /** @type {{entry:QueuedTask,worker:Worker,timer:ReturnType<typeof setTimeout>}|null} */ let active=null;
  let destroyed=false,completed=0,cancelled=0,failed=0;

  /** @param {QueuedTask} entry @param {Error|null} error @param {CodecReply|null} reply @returns {void} */
  function finish(entry,error,reply) {
    if(entry.done)return;entry.done=true;
    entry.signal.removeEventListener('abort',entry.abort);
    if(active?.entry===entry) {clearTimeout(active.timer);active.worker.terminate();active=null;}
    else queue=queue.filter(candidate=>candidate!==entry);
    if(error) {if(error.name==='AbortError')cancelled++;else failed++;entry.reject(error);}
    else if(reply) {completed++;entry.resolve(reply);}
    else {failed++;entry.reject(new Error('AVIF worker returned no result'));}
    start();
  }

  /** @returns {void} */
  function start() {
    if(active||destroyed) return;
    const entry=queue.shift();if(!entry)return;
    if(entry.signal.aborted) {finish(entry,new DOMException('Image conversion was cancelled','AbortError'),null);return;}
    let worker;
    try {worker=new Worker(new URL('./avif-codec-worker.js',import.meta.url),{type:'module'});}
    catch(error) {finish(entry,error instanceof Error?error:new Error(String(error)),null);return;}
    const timer=setTimeout(()=>finish(entry,new RangeError('Image processing exceeded 60 seconds'),null),60000);
    active={entry,worker,timer};
    worker.onmessage=/** @param {MessageEvent<CodecReply>} event */ event=>{
      const reply=event.data;
      if(!reply||typeof reply!=='object'||typeof reply.ok!=='boolean') {finish(entry,new TypeError('Image worker returned an invalid response'),null);return;}
      if(!reply.ok) {finish(entry,reply.name==='RangeError'?new RangeError(reply.message):new TypeError(reply.message),null);return;}
      finish(entry,null,reply);
    };
    worker.onerror=event=>{event.preventDefault();finish(entry,new Error('Image worker failed: '+event.message),null);};
    worker.onmessageerror=()=>finish(entry,new TypeError('Image worker result could not be decoded'),null);
    try {worker.postMessage(entry.task);}
    catch(error) {finish(entry,error instanceof Error?error:new Error(String(error)),null);}
  }

  /** @param {CodecTask} task @param {AbortSignal} signal @returns {Promise<CodecReply>} */
  function submit(task,signal) {
    if(destroyed)return Promise.reject(new Error('Image codec has been destroyed'));
    if(!(signal instanceof AbortSignal))return Promise.reject(new TypeError('Image codec requires an explicit AbortSignal'));
    if(!(task.file instanceof Blob)||!task.file.size||task.file.size>32*1024*1024)return Promise.reject(new RangeError('Image source must contain 1 byte through 32 MiB'));
    if(signal.aborted)return Promise.reject(new DOMException('Image processing was cancelled','AbortError'));
    if(active&&queue.length>=4)return Promise.reject(new RangeError('Image queue is full; wait for the current conversion'));
    return new Promise((resolve,reject)=>{
      /** @type {QueuedTask} */ const entry={task,signal,resolve,reject,done:false,abort:()=>finish(entry,new DOMException('Image processing was cancelled','AbortError'),null)};
      queue.push(entry);signal.addEventListener('abort',entry.abort,{once:true});start();
    });
  }

  return {
    async prepare(file,name,kind,signal) {
      if(typeof name!=='string'||!name.trim()||name.length>255||/[\u0000-\u001f\u007f]/.test(name))throw new TypeError('Image filename must contain 1 through 255 printable characters');
      const result=await submit({operation:'prepare',file,name,kind:parseMediaKind(kind)},signal);
      if(!result.ok||!('blob'in result)||!(result.blob instanceof Blob)||result.blob.type!=='image/avif')throw new TypeError('Image preparation did not return pure AVIF');
      const metadata=checkMediaKind(parseMediaMetadata(result.metadata),kind);
      if(result.blob.size!==metadata.bytes)throw new TypeError('Prepared image bytes disagree with metadata');
      return {blob:result.blob,metadata};
    },
    async inspect(file,kind,signal) {
      const result=await submit({operation:'inspect',file,kind:parseMediaKind(kind)},signal);
      if(!result.ok||!('metadata'in result))throw new TypeError('Image inspection did not return metadata');
      return checkMediaKind(parseMediaMetadata(result.metadata),kind);
    },
    async poster(file,signal) {
      const result=await submit({operation:'poster',file},signal);
      if(!result.ok||!('poster'in result)||!(result.poster instanceof Blob)||!['image/png','image/webp'].includes(result.poster.type))throw new TypeError('Image poster did not return PNG or WebP');
      return result.poster;
    },
    destroy() {
      if(destroyed)return;destroyed=true;
      const entries=[...(active?[active.entry]:[]),...queue];queue=[];
      for(const entry of entries)finish(entry,new DOMException('Image codec was closed','AbortError'),null);
    },
    stats:()=>({active:active?1:0,queued:queue.length,completed,cancelled,failed}),
  };
}
