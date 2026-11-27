// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createStaticAssets} from '../desktop/static-assets.cjs';

test('real HTTP static assets preserve byte identity, bounded caching, HEAD, replacement checks and close cleanup',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-static-assets-'));
  fs.writeFileSync(path.join(directory,'index.html'),'<html>local</html>');
  const large=Buffer.alloc(2*1024*1024,93);fs.writeFileSync(path.join(directory,'large.wasm'),large);
  for(let index=0;index<32;index++)fs.writeFileSync(path.join(directory,index+'.js'),Buffer.alloc(65536,index));
  const assets=createStaticAssets(directory);
  const server=http.createServer((request,response)=>{void assets.serve(response,request.url||'/',request.method||'GET');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(undefined)));
  const address=server.address();assert(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
  try{
    assert.equal(assets.usage().cachedBytes,0);
    const head=await fetch(origin+'/large.wasm',{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(large.length));assert.equal((await head.arrayBuffer()).byteLength,0);
    assert.equal(assets.usage().cachedBytes,0);
    assert.deepEqual(Buffer.from(await (await fetch(origin+'/large.wasm')).arrayBuffer()),large);
    assert.equal(assets.usage().cachedBytes,0);
    for(let index=0;index<32;index++)assert.deepEqual(Buffer.from(await (await fetch(origin+'/'+index+'.js')).arrayBuffer()),Buffer.alloc(65536,index));
    assert.equal(assets.usage().cachedBytes,1536*1024);assert.equal(assets.usage().cachedFiles,24);
    assert.equal((await fetch(origin+'/missing.js')).status,404);
    fs.writeFileSync(path.join(directory,'31.js'),'changed');assert.equal((await fetch(origin+'/31.js')).status,500);
    fs.mkdirSync(path.join(directory,'replacement'));fs.symlinkSync(path.join(directory,'replacement'),path.join(directory,'linked'),'junction');
    assert.throws(()=>createStaticAssets(directory),/regular|link/);
    const streaming=await fetch(origin+'/large.wasm');assert(streaming.body);await streaming.body.cancel();
    assets.close();
    const deadline=Date.now()+2000;
    while(assets.usage().activeRequests>0&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(assets.usage().activeRequests,0);
    assert.equal(assets.usage().cachedBytes,0);assert.equal((await fetch(origin+'/')).status,503);
  }finally{
    assets.close();server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve(undefined)));
    assert.equal(path.dirname(directory),os.tmpdir());assert(path.basename(directory).startsWith('deepscord-static-assets-'));fs.rmSync(directory,{recursive:true,force:true});
  }
});
