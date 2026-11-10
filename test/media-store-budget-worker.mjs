// @ts-check
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import media from '../lib/media-store.cjs';
import codec from '../lib/avif-codec.cjs';
import {mediaObject,mediaText,mediaInteger} from '../public/js/chat-protocol.js';
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
const row=mediaObject(JSON.parse(process.argv[2]),'Budget worker configuration'),rootDir=mediaText(row.rootDir,'Media root',1024),roomId=mediaText(row.roomId,'Room ID',80),rootBytes=mediaInteger(row.rootBytes,'Root bytes',1,1024*1024*1024),source=mediaText(row.source,'Source path',1024);
const bytes=fs.readFileSync(source),sha256=createHash('sha256').update(bytes).digest('hex');
/** @param {JsonValue} value @returns {void} */function send(value){if(!process.send)throw new TypeError('Budget worker requires IPC');process.send(value);}
/** @param {number} milliseconds @returns {Promise<void>} */function delay(milliseconds){return new Promise(resolve=>setTimeout(resolve,milliseconds));}
/** @template T @param {()=>T} task @returns {Promise<T>} */async function retryBusy(task){
  for(let attempt=0;attempt<20;attempt++){try{return task();}catch(error){if(!(error instanceof media.MediaBudgetBusyError) || attempt===19)throw error;console.warn('media_budget_test_busy_retry',{attempt,retryAfterMs:error.retryAfterMs});await delay(error.retryAfterMs);}}
  throw new RangeError('Budget worker retry attempts were exhausted');
}
const store=await retryBusy(()=>media.openMediaStore({rootDir,roomId,validate:codec.validate,limits:{rootBytes,roomBytes:1024*1024,stagingBytes:1024*1024,concurrentUploads:4,uploadTtlMs:60000,unpublishedTtlMs:300000}}));
let uploadId='';send({type:'ready',pid:process.pid});
process.on('message',/** @param {JsonValue} input */ input=>{
  const command=mediaObject(input,'Budget worker command');
  void execute(command).catch(error=>send({type:'failed',name:error instanceof Error?error.name:'non-error',message:error instanceof Error?error.message:String(error)}));
});
/** @param {{[key:string]:JsonValue}} command @returns {Promise<void>} */async function execute(command){
  if(command.op==='reserve'){const result=await retryBusy(()=>store.beginUpload({kind:'server',totalBytes:bytes.length,expectedSha256:sha256}));uploadId=result.uploadId;send({type:'reserved',uploadId});return;}
  if(command.op==='write'){for(let offset=0;offset<bytes.length;offset+=16384)store.writeChunk(uploadId,offset,bytes.subarray(offset,offset+16384));send({type:'written',bytes:bytes.length});return;}
  if(command.op==='finish'){const asset=await store.finishUpload(uploadId);send({type:'finished',asset});return;}
  throw new TypeError('Unsupported budget worker operation');
}
