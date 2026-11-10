// @ts-check
'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {parentPort,workerData}=require('node:worker_threads');
/** @typedef {import('./avif-codec.cjs').CodecRequest} CodecRequest */
/** @typedef {import('./avif-codec.cjs').CodecReply} CodecReply */
/** @typedef {import('../public/vendor/avif/codec.mjs').RgbaFrame} RgbaFrame */

/** @param {CodecRequest} request @returns {Promise<CodecReply>} */
async function execute(request) {
  const root=path.join(__dirname,'../public/vendor/avif');
  const {createCodec,parseLimits}=await import(pathToFileURL(path.join(root,'codec.mjs')).href);
  const limits=parseLimits(request.limits);
  const codec=await createCodec(await fs.readFile(path.join(root,'module.wasm')));
  if(request.operation==='encode') return {ok:true,encoded:codec.encode(request.input,request.options,limits)};
  if(request.operation==='validate') return {ok:true,metadata:codec.inspect(request.bytes,limits,null)};
  if(request.operation==='decode') {
    /** @type {RgbaFrame[]} */ const frames=[];
    const metadata=codec.inspect(request.bytes,limits,/** @param {RgbaFrame} frame */ frame=>{frames.push(frame);});
    return {ok:true,decoded:{metadata,frames}};
  }
  throw new TypeError('Unsupported AVIF worker operation');
}

const port=parentPort;
if(!port) throw new Error('AVIF codec must run inside its dedicated worker');
execute(/** @type {CodecRequest} */ (workerData)).then(reply=>port.postMessage(reply),error=>{
  const failure=error instanceof Error?error:new Error(String(error));
  /** @type {CodecReply} */ const reply={ok:false,name:failure.name,message:failure.message};
  port.postMessage(reply);
});
