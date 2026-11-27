// @ts-check
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {pipeline}=require('node:stream/promises');
/** @typedef {{filename:string,mime:string,size:number,mtimeMs:number,ctimeMs:number,ino:number,dev:number}} Asset */
const SMALL_BYTES=64*1024;
const CACHE_BYTES=1536*1024;
/** @type {Readonly<Record<string,string>>} */
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.avif':'image/avif','.ico':'image/x-icon','.woff2':'font/woff2','.wav':'audio/wav','.mp3':'audio/mpeg','.wasm':'application/wasm'};

/** @param {string} directory */
function createStaticAssets(directory){
  if(!path.isAbsolute(directory))throw new TypeError('Packaged assets require an absolute directory');
  /** @type {Map<string,Asset>} */const assets=new Map();
  /** @type {Map<string,{ino:number,dev:number}>} */const directories=new Map();
  /** @type {Map<string,Buffer>} */const cache=new Map();
  /** @type {Map<import('node:http').ServerResponse,AbortController>} */const active=new Map();
  let cacheBytes=0,closed=false;
  /** @param {string} current @returns {void} */
  function index(current){
    const stat=fs.lstatSync(current);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new TypeError('Packaged assets require regular directories: '+current);
    directories.set(current,{ino:stat.ino,dev:stat.dev});
    for(const entry of fs.readdirSync(current,{withFileTypes:true})){
      const filename=path.join(current,entry.name);
      if(entry.isDirectory())index(filename);
      else if(entry.isFile()){
        const item=fs.lstatSync(filename);
        if(!item.isFile()||item.isSymbolicLink())throw new TypeError('Packaged asset is not a regular file: '+filename);
        assets.set('/'+path.relative(directory,filename).split(path.sep).join('/'),{filename,mime:MIME[path.extname(filename)]||'application/octet-stream',size:item.size,mtimeMs:item.mtimeMs,ctimeMs:item.ctimeMs,ino:item.ino,dev:item.dev});
      }else throw new TypeError('Packaged room assets must contain only regular files and directories');
    }
  }
  index(directory);
  if(!assets.has('/index.html'))throw new Error('Packaged room interface is missing index.html');

  /** @param {Asset} asset @param {fs.Stats} stat @returns {void} */
  function validateFile(asset,stat){
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==asset.size||stat.mtimeMs!==asset.mtimeMs||stat.ctimeMs!==asset.ctimeMs||stat.ino!==asset.ino||stat.dev!==asset.dev)
      throw new Error('Packaged asset changed after room startup: '+asset.filename);
  }
  /** @param {Asset} asset @returns {Promise<void>} */
  async function validatePath(asset){
    let current=path.dirname(asset.filename);
    for(;;){
      const expected=directories.get(current),stat=await fs.promises.lstat(current);
      if(!expected||!stat.isDirectory()||stat.isSymbolicLink()||stat.ino!==expected.ino||stat.dev!==expected.dev)
        throw new Error('Packaged asset directory changed after room startup: '+current);
      if(current===directory)break;
      current=path.dirname(current);
    }
    validateFile(asset,await fs.promises.lstat(asset.filename));
  }
  /** @param {string} key @param {Buffer} data @returns {void} */
  function remember(key,data){
    const previous=cache.get(key);
    if(previous){cacheBytes-=previous.length;cache.delete(key);}
    while(cacheBytes+data.length>CACHE_BYTES){
      const oldest=cache.entries().next().value;
      if(!oldest)throw new Error('Static cache accounting is inconsistent');
      cache.delete(oldest[0]);cacheBytes-=oldest[1].length;
    }
    cache.set(key,data);cacheBytes+=data.length;
  }
  /** @param {import('node:http').ServerResponse} response @param {string} pathname @param {string} method @returns {Promise<void>} */
  async function serve(response,pathname,method){
    const asset=assets.get(pathname==='/'?'/index.html':pathname);
    if(!asset){response.writeHead(404);response.end();return;}
    if(closed||active.size>=32){response.writeHead(503);response.end();return;}
    const cancellation=new AbortController();active.set(response,cancellation);
    const abort=()=>cancellation.abort();response.once('close',abort);
    /** @type {import('node:fs/promises').FileHandle|null} */let file=null;
    try{
      await validatePath(asset);
      if(cancellation.signal.aborted) return;
      if(method==='HEAD'){
        response.writeHead(200,{'Content-Type':asset.mime,'Content-Length':asset.size});response.end();return;
      }
      file=await fs.promises.open(asset.filename,'r');
      validateFile(asset,await file.stat());
      await validatePath(asset);
      if(cancellation.signal.aborted) return;
      if(asset.size<=SMALL_BYTES){
        let data=cache.get(pathname);
        if(!data){
          data=await file.readFile();
          validateFile(asset,await file.stat());
          if(data.length!==asset.size)throw new Error('Packaged asset length changed during reading');
        }
        if(cancellation.signal.aborted) return;
        remember(pathname,data);
        response.writeHead(200,{'Content-Type':asset.mime,'Content-Length':asset.size});response.end(data);
      }else{
        response.writeHead(200,{'Content-Type':asset.mime,'Content-Length':asset.size});
        await pipeline(file.createReadStream({autoClose:false,highWaterMark:64*1024}),response,{signal:cancellation.signal});
      }
    }catch(error){
      if(!cancellation.signal.aborted){
        console.error('room_asset_response_failed',{pathname,message:error instanceof Error?error.message:String(error)});
        if(!response.headersSent){response.writeHead(500);response.end('Packaged room asset is unavailable');}else response.destroy();
      }
    }finally{
      response.removeListener('close',abort);active.delete(response);
      if(file)await file.close();
    }
  }
  /** @returns {void} */
  function close(){closed=true;cache.clear();cacheBytes=0;for(const [response,cancellation] of active){cancellation.abort();response.destroy();}}
  /** @returns {{indexedFiles:number,cachedFiles:number,cachedBytes:number,activeRequests:number}} */
  function usage(){return {indexedFiles:assets.size,cachedFiles:cache.size,cachedBytes:cacheBytes,activeRequests:active.size};}
  return {serve,close,usage};
}
module.exports={createStaticAssets};
