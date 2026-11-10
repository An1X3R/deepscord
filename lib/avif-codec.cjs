// @ts-check
'use strict';

const path=require('node:path');
const {Worker}=require('node:worker_threads');
/** @typedef {import('../public/vendor/avif/codec.mjs').CodecLimits} CodecLimits */
/** @typedef {import('../public/vendor/avif/codec.mjs').EncodeInput} EncodeInput */
/** @typedef {import('../public/vendor/avif/codec.mjs').EncodeOptions} EncodeOptions */
/** @typedef {import('../public/vendor/avif/codec.mjs').AvifMetadata} AvifMetadata */
/** @typedef {import('../public/vendor/avif/codec.mjs').RgbaFrame} RgbaFrame */
/** @typedef {'server'|'personal'|'image'} MediaKind */
/** @typedef {{metadata:AvifMetadata,frames:RgbaFrame[]}} DecodedAvif */
/** @typedef {{operation:'validate'|'decode',bytes:Uint8Array,limits:CodecLimits}|{operation:'encode',input:EncodeInput,options:EncodeOptions,limits:CodecLimits}} CodecRequest */
/** @typedef {{ok:true,metadata:AvifMetadata}|{ok:true,encoded:Uint8Array}|{ok:true,decoded:DecodedAvif}|{ok:false,name:string,message:string}} CodecReply */

/** @param {MediaKind} kind @returns {CodecLimits} */
function limitsForKind(kind) {
  const common={maxFrames:180,maxDecodedPixels:24*1024*1024,maxDurationMs:10000,timeoutMs:30000};
  if(kind==='server') return {...common,maxBytes:96*1024,maxDimension:240};
  if(kind==='personal') return {...common,maxBytes:160*1024,maxDimension:360};
  if(kind==='image') return {...common,maxBytes:1536*1024,maxDimension:1920};
  throw new TypeError('AVIF media kind must be server, personal or image');
}

/** @param {CodecRequest} request @param {AbortSignal} signal @returns {Promise<CodecReply>} */
function run(request,signal) {
  if(!(signal instanceof AbortSignal)) return Promise.reject(new TypeError('AVIF codec requires an explicit AbortSignal'));
  if(signal.aborted) return Promise.reject(new DOMException('AVIF codec was cancelled before it started','AbortError'));
  const timeout=request.limits.timeoutMs;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>60000) return Promise.reject(new RangeError('AVIF worker timeout must be from 1 through 60000 milliseconds'));
  return new Promise((resolve,reject)=>{
    const worker=new Worker(path.join(__dirname,'avif-codec-worker.cjs'),{workerData:request,resourceLimits:{maxOldGenerationSizeMb:256,stackSizeMb:4}});
    let settled=false;
    /** @param {Error|null} error @param {CodecReply|null} reply @returns {Promise<void>} */
    async function settle(error,reply) {
      if(settled) return;
      settled=true;
      clearTimeout(timer);
      signal.removeEventListener('abort',abort);
      try { await worker.terminate(); }
      catch(terminationError) { reject(terminationError);return; }
      if(error) reject(error);
      else if(reply) resolve(reply);
      else reject(new Error('AVIF worker returned no result'));
    }
    const abort=()=>{void settle(new DOMException('AVIF codec was cancelled','AbortError'),null);};
    const timer=setTimeout(()=>{void settle(new RangeError('AVIF '+request.operation+' exceeded '+timeout+' milliseconds'),null);},timeout);
    signal.addEventListener('abort',abort,{once:true});
    worker.on('message',/** @param {CodecReply} reply */ reply=>{
      if(!reply||typeof reply!=='object'||typeof reply.ok!=='boolean') {void settle(new TypeError('AVIF worker returned an invalid response'),null);return;}
      if(!reply.ok) {
        const error=reply.name==='RangeError'?new RangeError(reply.message):new TypeError(reply.message);
        void settle(error,null);
      } else void settle(null,reply);
    });
    worker.on('error',error=>{void settle(error instanceof Error?error:new Error(String(error)),null);});
    worker.on('exit',code=>{if(!settled) void settle(new Error('AVIF worker exited before completing with code '+code),null);});
    if(signal.aborted) abort();
  });
}

/** @param {Uint8Array} bytes @param {MediaKind} kind @param {AbortSignal} signal @returns {Promise<AvifMetadata>} */
async function validate(bytes,kind,signal) {
  const limits=limitsForKind(kind);
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.byteLength>limits.maxBytes) throw new RangeError('AVIF input exceeds the '+kind+' byte limit');
  const result=await run({operation:'validate',bytes,limits},signal);
  if(!result.ok||!('metadata' in result)) throw new TypeError('AVIF validation worker returned an unexpected result');
  return result.metadata;
}

/** @param {EncodeInput} input @param {EncodeOptions} options @param {CodecLimits} limits @param {AbortSignal} signal @returns {Promise<Buffer>} */
async function encode(input,options,limits,signal) {
  const result=await run({operation:'encode',input,options,limits},signal);
  if(!result.ok||!('encoded' in result)||!(result.encoded instanceof Uint8Array)) throw new TypeError('AVIF encoding worker returned an unexpected result');
  return Buffer.from(result.encoded);
}

/** @param {Uint8Array} bytes @param {CodecLimits} limits @param {AbortSignal} signal @returns {Promise<DecodedAvif>} */
async function decode(bytes,limits,signal) {
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.byteLength>limits.maxBytes) throw new RangeError('AVIF decode input exceeds its byte limit');
  const result=await run({operation:'decode',bytes,limits},signal);
  if(!result.ok||!('decoded' in result)) throw new TypeError('AVIF decoding worker returned an unexpected result');
  return result.decoded;
}

module.exports={validate,encode,decode,limitsForKind};
