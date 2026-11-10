// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {once} from 'node:events';
import {randomUUID,createHash,randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import replicas from '../desktop/media-replicas.cjs';
import storageModule from '../desktop/steam-media-storage.cjs';
import codec from '../lib/avif-codec.cjs';
import {mediaObject,parseMediaMetadata} from '../public/js/chat-protocol.js';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../public/js/chat-protocol.js').MediaMetadata} MediaMetadata */
/** @typedef {import('../desktop/media-replicas.cjs').MediaReplicaStatus} MediaReplicaStatus */
/** @typedef {ReturnType<typeof replicas.createMediaReplicas>} Replicas */
/** @typedef {ReturnType<typeof storageModule.createSteamMediaStorage>} Storage */
/** @typedef {{peer:string,session:string,payload:Buffer}} Envelope */
/** @typedef {{id:string,origin:string,server:http.Server,replica:Replicas,storage:Storage,errors:Error[],statuses:MediaReplicaStatus[][],operations:Map<string,number>,wires:Envelope[],openUploads:Set<string>,maxUploads:()=>number,hold:()=>void,resume:()=>void,drain:()=>Promise<void>,close:()=>Promise<void>}} Peer */
const encodeLimits={maxBytes:1536*1024,maxDimension:1920,maxFrames:180,maxDecodedPixels:24*1024*1024,maxDurationMs:10000,timeoutMs:30000};
const root=fs.mkdtempSync(path.resolve('.qa-tools','steam-media-replicas-'));

/** @param {number} seed @returns {Promise<Buffer>} */
function fixture(seed){
  const rgba=new Uint8Array(128*128*4);let value=seed;
  for(let index=0;index<rgba.length;index++){value=(Math.imul(value,1664525)+1013904223)>>>0;rgba[index]=value>>>24;}
  return codec.encode({width:128,height:128,timescale:1000,repetitionCount:-1,frames:[{rgba,durationTicks:127},{rgba:rgba.slice().reverse(),durationTicks:211}]},{quality:100,speed:10},encodeLimits,new AbortController().signal);
}
/** @param {()=>boolean|Promise<boolean>} predicate @param {string} message @returns {Promise<void>} */
async function until(predicate,message){const deadline=Date.now()+15000;while(!await predicate()){if(Date.now()>deadline)throw new Error(message);await delay(20);}}
/** @param {Storage} storage @returns {Promise<MediaMetadata[]>} */
async function inventory(storage){const row=mediaObject(await storage.execute({op:'inventory'}),'Test inventory');assert(Array.isArray(row.assets));return row.assets.map(parseMediaMetadata);}
/** @param {Storage} storage @param {Buffer} bytes @returns {Promise<MediaMetadata>} */
async function upload(storage,bytes){
  const sha256=createHash('sha256').update(bytes).digest('hex'),begun=mediaObject(await storage.execute({op:'begin',kind:'image',sha256,bytes:bytes.length,domainId:null}),'Test upload');
  if(begun.asset!==undefined)return parseMediaMetadata(begun.asset);
  assert.equal(typeof begun.uploadId,'string');const uploadId=/** @type {string} */(begun.uploadId);
  for(let offset=0;offset<bytes.length;offset+=16384)await storage.execute({op:'write',uploadId,offset,data:bytes.subarray(offset,offset+16384).toString('base64')});
  const finished=mediaObject(await storage.execute({op:'finish',uploadId}),'Test finish');assert(finished.asset!==undefined);return parseMediaMetadata(finished.asset);
}
/** @param {string} id @param {string} roomId @param {Map<string,Peer>} peers @returns {Promise<Peer>} */
async function createPeer(id,roomId,peers){
  const storage=storageModule.createSteamMediaStorage({rootDir:path.join(root,id),roomId,backend:null});
  /** @type {Error[]} */const errors=[];
  /** @type {MediaReplicaStatus[][]} */const statuses=[];
  /** @type {Envelope[]} */const wires=[];
  /** @type {Set<Promise<void>>} */const tasks=new Set();
  /** @type {Envelope[]} */const held=[];
  /** @type {Map<string,number>} */const operations=new Map();
  /** @type {Set<string>} */const openUploads=new Set();
  let maxUploads=0,holding=false;
  /** @param {Envelope} envelope @returns {void} */
  function deliver(envelope){const work=replica.receive(envelope.peer,envelope.session,envelope.payload).catch(error=>{if(error instanceof Error&&error.name!=='AbortError')errors.push(error);});tasks.add(work);void work.then(()=>tasks.delete(work));}
  const server=http.createServer(async(request,response)=>{
    try{
      assert.equal(request.method,'POST');assert.equal(request.url,'/wire');
      const peer=request.headers['x-media-peer'],session=request.headers['x-media-session'];assert.equal(typeof peer,'string');assert.equal(typeof session,'string');
      /** @type {Buffer[]} */const chunks=[];let length=0;
      for await(const chunk of request){length+=chunk.length;if(length>24576)throw new RangeError('Test wire exceeds production bounds');chunks.push(chunk);}
      const envelope={peer:/** @type {string} */(peer),session:/** @type {string} */(session),payload:Buffer.concat(chunks)};wires.push(envelope);
      if(holding)held.push(envelope);else deliver(envelope);response.writeHead(204);response.end();
    }catch(error){errors.push(error instanceof Error?error:new Error(String(error)));response.writeHead(400);response.end();}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address==='object');const origin='http://127.0.0.1:'+address.port;
  const replica=replicas.createMediaReplicas({selfId:id,storage:{
    references:storage.references,
    execute:async input=>{const row=mediaObject(input,'Measured storage');assert.equal(typeof row.op,'string');const op=/** @type {string} */(row.op);operations.set(op,(operations.get(op)||0)+1);const result=await storage.execute(input);
      if(op==='begin'){const started=mediaObject(result,'Measured upload');if(typeof started.uploadId==='string'){openUploads.add(started.uploadId);maxUploads=Math.max(maxUploads,openUploads.size);}}
      if((op==='finish'||op==='cancel')&&typeof row.uploadId==='string')openUploads.delete(row.uploadId);return result;}
  },send:async(peer,session,payload)=>{const target=peers.get(peer);if(!target)throw new Error('Loopback peer is offline: '+peer);const response=await fetch(target.origin+'/wire',{method:'POST',headers:{'x-media-peer':id,'x-media-session':session},body:Uint8Array.from(payload).buffer,signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error('Loopback media wire rejected '+response.status);},onStatus:rows=>statuses.push(rows),reportError:error=>errors.push(error)});
  /** @type {Peer} */const peer={id,origin,server,replica,storage,errors,statuses,operations,wires,openUploads,maxUploads:()=>maxUploads,hold:()=>{holding=true;},resume:()=>{holding=false;for(const envelope of held.splice(0))deliver(envelope);},drain:async()=>{while(tasks.size)await Promise.all([...tasks]);},close:async()=>{const closing=replica.close();await storage.close();await closing;await peer.drain();server.closeAllConnections();await /** @type {Promise<void>} */(new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())));}};
  peers.set(id,peer);return peer;
}

test('three real HTTP peers preserve verified AVIF copies, recover the initial inventory race and restore a migrating host',async()=>{
  const roomId=randomUUID(),peers=new Map(),a=await createPeer('101',roomId,peers),b=await createPeer('202',roomId,peers),c=await createPeer('303',roomId,peers);
  /** @type {Peer[]} */const live=[a,b,c];
  try{
    const bytes=await fixture(37),hash=createHash('sha256').update(bytes).digest('hex');assert(bytes.length>32768);await a.storage.references([hash]);const asset=await upload(a.storage,bytes);assert.equal(asset.frames,2);assert.equal(asset.durationMs,338);
    const input={roomId,assets:[asset],members:['101','202','303'],ownerId:'101'};
    await a.replica.update(input);await a.drain();assert(b.errors.some(error=>/online member|not ready/.test(error.message)),'The first inventory must actually encounter the pre-checkpoint receiver');
    await Promise.all([b.replica.update(input),c.replica.update(input)]);
    const backup=[b,c][Number.parseInt(hash.slice(0,8),16)%2],other=backup===b?c:b;
    await until(async()=>(await inventory(backup.storage)).some(value=>value.sha256===hash),'Designated backup never received the real AVIF');
    await until(()=>a.statuses.at(-1)?.[0]?.copies===2,'Durable backup was not acknowledged');
    assert.deepEqual(await inventory(other.storage),[],'The other guest must not prefetch every asset');
    assert(backup.wires.some(wire=>JSON.parse(wire.payload.toString()).t==='inventory'),'Backup discovery must use real inventory replies');
    const scans=backup.operations.get('inventory'),wireCount=backup.wires.length;for(let count=0;count<5;count++)await backup.replica.update(input);await delay(80);assert.equal(backup.operations.get('inventory'),scans);assert.equal(backup.wires.length,wireCount);
    await a.close();live.splice(live.indexOf(a),1);peers.delete(a.id);
    const migrated={...input,members:['202','303'],ownerId:other.id};await Promise.all([b.replica.update(migrated),c.replica.update(migrated)]);
    await until(async()=>(await inventory(other.storage)).some(value=>value.sha256===hash),'The new host did not restore from the remaining online holder');
    await until(()=>other.statuses.at(-1)?.[0]?.copies===2,'Migrated durable copies did not reach synced');
    const chunks=[];for(let offset=0;offset<bytes.length;offset+=16384){const row=mediaObject(await other.storage.execute({op:'read',sha256:hash,offset,length:Math.min(16384,bytes.length-offset)}),'Restored bytes');assert.equal(typeof row.data,'string');chunks.push(Buffer.from(/** @type {string} */(row.data),'base64'));}assert.deepEqual(Buffer.concat(chunks),bytes);
    const retainedId=other.id;await other.close();live.splice(live.indexOf(other),1);peers.delete(retainedId);const reopened=await createPeer(retainedId,roomId,peers);live.push(reopened);await reopened.replica.update(migrated);assert.deepEqual(await inventory(reopened.storage),[asset]);
    const unavailable={...migrated,assets:[{...asset,sha256:'f'.repeat(64)}]};await Promise.all(live.map(peer=>peer.replica.update(unavailable)));
    await assert.rejects(reopened.replica.ensure('f'.repeat(64)),/No online durable copy/);assert.equal(reopened.statuses.at(-1)?.[0]?.status,'unavailable');
    await assert.rejects(reopened.replica.receive('999',randomBytes(16).toString('hex'),Buffer.from('{"t":"inventory-request"}')),/online member/);
    assert(live.every(peer=>peer.maxUploads()<=2));
  }finally{await Promise.all(live.map(peer=>peer.close()));}
});

test('failed real HTTP update can retry, queued downloads keep two slots, and shutdown cancels staged uploads promptly',async()=>{
  const roomId=randomUUID(),peers=new Map(),a=await createPeer('401',roomId,peers),b=await createPeer('402',roomId,peers),c=await createPeer('403',roomId,peers),live=[a,b,c];
  try{
    const files=await Promise.all([fixture(41),fixture(43),fixture(47),fixture(53)]),hashes=files.map(bytes=>createHash('sha256').update(bytes).digest('hex'));await a.storage.references(hashes);const assets=[];for(const bytes of files)assets.push(await upload(a.storage,bytes));
    const input={roomId,assets,members:['401','402','403'],ownerId:'401'};
    peers.delete(c.id);await assert.rejects(a.replica.update(input),/offline/);peers.set(c.id,c);await a.replica.update(input);await Promise.all([b.replica.update(input),c.replica.update(input)]);
    await until(()=>b.statuses.at(-1)?.every(row=>row.copies>=1)===true,'The retried update never discovered its inventory');
    a.hold();const work=assets.map(asset=>b.replica.ensure(asset.sha256));
    await until(()=>b.openUploads.size===2,'Two real staged uploads were not opened');assert.equal(b.maxUploads(),2);
    const started=Date.now(),closing=b.replica.close();await b.storage.close();await closing;const settled=await Promise.allSettled(work);assert(settled.some(result=>result.status==='rejected'&&result.reason instanceof Error&&result.reason.name==='AbortError'));assert(Date.now()-started<3000,'Shutdown waited for the 15 second wire timeout');assert.equal(b.openUploads.size,0);
    a.resume();await b.close();live.splice(live.indexOf(b),1);peers.delete(b.id);
    await c.replica.update({...input,members:['401','403']});
    const session=randomBytes(16).toString('hex'),before=Date.now();await a.replica.receive(c.id,session,Buffer.from(JSON.stringify({t:'request',sha256:assets[0].sha256,offset:-1,length:16384})));await until(()=>c.wires.some(wire=>wire.session===session),'Invalid request did not return a result');const reply=c.wires.find(wire=>wire.session===session);assert(reply);const result=JSON.parse(reply.payload.toString());assert.equal(result.t,'result');assert.equal(result.ok,false);assert(Date.now()-before<1000);assert(!result.message.includes(root));
  }finally{await Promise.all(live.map(peer=>peer.close()));}
});

test('inventory handshake retries an unready real receiver at most three times and succeeds after its checkpoint arrives',async()=>{
  const roomId=randomUUID(),peers=new Map(),a=await createPeer('501',roomId,peers),b=await createPeer('502',roomId,peers);
  const input={roomId,assets:[],members:['501','502'],ownerId:'501'};
  try{
    await a.replica.update(input);
    await until(()=>b.wires.filter(wire=>JSON.parse(wire.payload.toString()).t==='inventory-request').length===2,'The second inventory handshake was never retried');
    await b.drain();await b.replica.update(input);
    await until(()=>b.wires.filter(wire=>JSON.parse(wire.payload.toString()).t==='inventory-request').length===3,'The third bounded handshake was never sent');
    await until(()=>{const request=b.wires.filter(wire=>JSON.parse(wire.payload.toString()).t==='inventory-request').at(-1);return a.wires.some(wire=>wire.session===request?.session&&JSON.parse(wire.payload.toString()).t==='inventory');},'The initialized receiver did not answer the retry');
    await delay(150);assert.equal(b.wires.filter(wire=>JSON.parse(wire.payload.toString()).t==='inventory-request').length,3);assert.deepEqual(a.errors,[]);
  }finally{await Promise.all([a.close(),b.close()]);}
});
