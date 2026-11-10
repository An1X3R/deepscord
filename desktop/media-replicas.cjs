// @ts-check
'use strict';
const {randomBytes}=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');
/** @type {typeof import('../public/js/chat-protocol.js')} */
const {parseMediaMetadata,parseMediaKind,mediaHash,mediaObject,mediaInteger}=require('./app-server/public/js/chat-protocol.js');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../public/js/chat-protocol.js').MediaMetadata} MediaMetadata */
/** @typedef {{sha256:string,copies:number,status:'synced'|'waiting'|'unavailable'}} MediaReplicaStatus */
/** @typedef {{roomId:string,assets:MediaMetadata[],members:string[],ownerId:string}} ReplicaUpdate */
/** @typedef {{selfId:string,storage:{execute:(input:JsonValue)=>Promise<JsonValue>,references:(hashes:string[])=>Promise<void>},send:(peer:string,session:string,payload:Buffer)=>Promise<void>,onStatus:(status:MediaReplicaStatus[])=>void,reportError:(error:Error)=>void}} ReplicaOptions */
/** @typedef {{peer:string,kind:'read',length:number,resolve:(bytes:Buffer)=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>,abort:()=>void,signal:AbortSignal}|{peer:string,kind:'inventory',resolve:()=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}} Pending */
/** @typedef {{peer:string,pages:number,parts:Map<number,string[]>,timer:ReturnType<typeof setTimeout>}} InventoryAssembly */

/** @param {string} value @returns {string} */
function member(value) {if(typeof value!=='string'||!/^\d{1,20}$/.test(value))throw new TypeError('Media replica member must be a Steam user ID');return value;}
/** @returns {Error} */
function shutdown() {return new DOMException('Media replicas are shutting down','AbortError');}
/** @param {string} value @returns {string} */
function sessionId(value) {if(typeof value!=='string'||!/^[a-f0-9]{32}$/.test(value))throw new TypeError('Media session must contain 16 random bytes');return value;}
/** @param {MediaMetadata} left @param {MediaMetadata} right @returns {boolean} */
function sameAsset(left,right) {return JSON.stringify(left)===JSON.stringify(right);}

/** @param {ReplicaOptions} options */
function createMediaReplicas(options) {
  const selfId=member(options.selfId),controller=new AbortController();
  /** @type {Map<string,MediaMetadata>} */ let assets=new Map();
  /** @type {Set<string>} */ let members=new Set();
  /** @type {Set<string>} */ let local=new Set();
  /** @type {Map<string,Set<string>>} */ const holders=new Map();
  /** @type {Map<string,Pending>} */ const pending=new Map();
  /** @type {Map<string,InventoryAssembly>} */ const assemblies=new Map();
  /** @type {Set<Promise<void>>} */ const tasks=new Set();
  /** @type {Map<string,Promise<void>>} */ const ensures=new Map(),discoveries=new Map();
  /** @type {Set<string>} */ const uploads=new Set(),backgroundFailures=new Set();
  /** @type {Map<string,number[]>} */ const reads=new Map(),inventoryReads=new Map();
  /** @type {Map<string,number>} */ const nextRead=new Map();
  /** @type {{resolve:()=>void,reject:(error:Error)=>void}[]} */ const slots=[];
  let roomId='',ownerId='',closed=false,activeEnsures=0,background=false,backgroundDirty=false,updateKey='',statusKey='';
  /** @type {Promise<void>} */ let updateWork=Promise.resolve();
  /** @type {Promise<void>|null} */ let closing=null;

  /** @template T @param {Promise<T>} promise @returns {Promise<T>} */
  function track(promise) {const settled=promise.then(()=>{},()=>{});tasks.add(settled);void settled.then(()=>tasks.delete(settled));return promise;}
  /** @returns {void} */
  function open() {if(closed)throw shutdown();}
  /** @param {string} hash @returns {MediaMetadata} */
  function referenced(hash) {open();const asset=assets.get(mediaHash(hash));if(!asset)throw new RangeError('Media is not referenced by the current authoritative room manifest: '+hash);return asset;}
  /** @param {string} peer @returns {void} */
  function online(peer) {open();if(peer===selfId||!members.has(member(peer)))throw new TypeError('Media peer is not an online member of this room: '+peer);}
  /** @param {string} peer @param {string} session @param {JsonValue} value @returns {Promise<void>} */
  async function send(peer,session,value) {online(peer);const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>24576)throw new RangeError('Media wire payload exceeds 24 KiB');await options.send(peer,session,bytes);open();}
  /** @returns {void} */
  function status() {
    const rows=[...assets.keys()].sort().map(sha256=>{
      const copies=Number(local.has(sha256))+[...holders].filter(([peer,values])=>members.has(peer)&&values.has(sha256)).length;
      return {sha256,copies,status:/** @type {'synced'|'waiting'|'unavailable'} */(copies>=2?'synced':copies===1?'waiting':'unavailable')};
    });
    const key=JSON.stringify(rows);if(key!==statusKey){statusKey=key;options.onStatus(rows);}
  }
  /** @returns {Promise<void>} */
  async function scan() {
    const result=mediaObject(await options.storage.execute({op:'inventory'}),'Media inventory');open();
    if(!Array.isArray(result.assets)||result.assets.length>4096)throw new RangeError('Media inventory exceeds 4096 assets');
    const next=new Set();
    for(const value of result.assets) {const actual=parseMediaMetadata(value),expected=assets.get(actual.sha256);if(expected){if(!sameAsset(actual,expected))throw new TypeError('Durable media metadata disagrees with its room manifest: '+actual.sha256);next.add(actual.sha256);}}
    local=next;status();
  }
  /** @param {string} peer @param {string} session @returns {Promise<void>} */
  async function announce(peer,session) {
    const hashes=[...local].filter(hash=>assets.has(hash)).sort(),pages=Math.max(1,Math.ceil(hashes.length/256));
    for(let page=0;page<pages;page++)await send(peer,session,{t:'inventory',page,pages,hashes:hashes.slice(page*256,(page+1)*256)});
  }
  /** @returns {Promise<void>} */
  async function broadcast() {for(const peer of members)if(peer!==selfId)await announce(peer,randomBytes(16).toString('hex'));}
  /** @param {string} session @param {Error} error @returns {void} */
  function rejectPending(session,error) {const entry=pending.get(session);if(!entry)return;pending.delete(session);clearTimeout(entry.timer);if(entry.kind==='read')entry.signal.removeEventListener('abort',entry.abort);entry.reject(error);}
  /** @param {string} peer @returns {Promise<void>} */
  async function inventoryRequest(peer) {
    online(peer);if(pending.size>=16)throw new RangeError('Media replica already has 16 pending wire requests');
    const session=randomBytes(16).toString('hex');
    /** @type {Promise<void>} */const reply=new Promise((resolve,reject)=>{pending.set(session,{peer,kind:'inventory',resolve,reject,timer:setTimeout(()=>rejectPending(session,new Error('Media inventory timed out from '+peer)),2500)});});
    await Promise.all([reply,send(peer,session,{t:'inventory-request'}).catch(error=>{rejectPending(session,error instanceof Error?error:new Error(String(error)));throw error;})]);
  }
  /** @param {string} peer @returns {Promise<void>} */
  function discover(peer) {
    const existing=discoveries.get(peer);if(existing)return existing;
    const work=track((async()=>{
      for(let attempt=1;attempt<=3;attempt++) {
        try {await inventoryRequest(peer);return;}
        catch(error) {if(closed||!members.has(peer))throw shutdown();console.warn('media_inventory_retry',{roomId,peer,attempt,message:error instanceof Error?error.message:String(error)});if(attempt===3)throw error;await delay(attempt*100,undefined,{signal:controller.signal});}
      }
    })());
    discoveries.set(peer,work);work.then(()=>discoveries.delete(peer),()=>discoveries.delete(peer));return work;
  }
  /** @param {string[]} peers @returns {Promise<void>} */
  async function discoverPeers(peers) {
    for(let index=0;index<peers.length;index+=8)await Promise.all(peers.slice(index,index+8).map(peer=>discover(peer).catch(error=>{if(!closed&&members.has(peer))options.reportError(error instanceof Error?error:new Error(String(error)));})));
  }
  /** @param {Map<string,number[]>} counters @param {string} peer @param {number} maximum @returns {void} */
  function rate(counters,peer,maximum) {const now=Date.now(),recent=(counters.get(peer)||[]).filter(time=>now-time<1000);if(recent.length>=maximum)throw new RangeError('Media peer exceeded its per-second request limit: '+peer);counters.set(peer,[...recent,now]);}
  /** @param {string} peer @param {string} hash @param {number} offset @param {number} length @param {AbortSignal} signal @returns {Promise<Buffer>} */
  async function read(peer,hash,offset,length,signal) {
    online(peer);signal.throwIfAborted();const start=Math.max(Date.now(),nextRead.get(peer)||0);nextRead.set(peer,start+65);
    await delay(Math.max(0,start-Date.now()),undefined,{signal});online(peer);signal.throwIfAborted();
    if(pending.size>=16)throw new RangeError('Media replica already has 16 pending wire requests');
    const session=randomBytes(16).toString('hex');
    /** @type {Promise<Buffer>} */const reply=new Promise((resolve,reject)=>{
      const abort=()=>rejectPending(session,shutdown());
      pending.set(session,{peer,kind:'read',length,resolve,reject,signal,abort,timer:setTimeout(()=>rejectPending(session,new Error('Media chunk timed out from '+peer+' at '+offset)),15000)});signal.addEventListener('abort',abort,{once:true});
    });
    const [bytes]=await Promise.all([reply,send(peer,session,{t:'request',sha256:hash,offset,length}).catch(error=>{rejectPending(session,error instanceof Error?error:new Error(String(error)));throw error;})]);return bytes;
  }
  /** @returns {Promise<void>} */
  async function acquire() {open();if(activeEnsures<2){activeEnsures++;return;}const waiting=/** @type {Promise<void>} */(new Promise((resolve,reject)=>slots.push({resolve,reject})));await waiting;if(closed){release();throw shutdown();}}
  /** @returns {void} */
  function release() {const slot=slots.shift();if(slot)slot.resolve();else activeEnsures--;}
  /** @param {string} uploadId @returns {Promise<void>} */
  async function cancel(uploadId) {uploads.delete(uploadId);try{await options.storage.execute({op:'cancel',uploadId});}catch(error){if(!closed)throw error;}}
  /** @param {MediaMetadata} asset @returns {Promise<void>} */
  async function transfer(asset) {
    await acquire();
    const timeout=AbortSignal.timeout(60000),signal=AbortSignal.any([controller.signal,timeout]);
    try {
      referenced(asset.sha256);if(local.has(asset.sha256))return;
      const candidates=[...holders].filter(([peer,values])=>members.has(peer)&&values.has(asset.sha256)).map(([peer])=>peer).sort();
      if(!candidates.length){status();throw new Error('No online durable copy is available for media '+asset.sha256);}
      /** @type {Error[]} */const failures=[];
      for(const peer of candidates) {
        let uploadId='';
        try {
          const begun=mediaObject(await options.storage.execute({op:'begin',kind:asset.encrypted===true?parseMediaKind(asset.mediaKind):'image',sha256:asset.sha256,bytes:asset.bytes,domainId:null,...(asset.encrypted===true?{encrypted:true}:{})}),'Replica upload');referenced(asset.sha256);
          if(begun.asset!==undefined) {if(!sameAsset(parseMediaMetadata(begun.asset),asset))throw new TypeError('Existing replica metadata disagrees with its manifest');}
          else {
            if(typeof begun.uploadId!=='string'||!begun.uploadId.length||begun.uploadId.length>80)throw new TypeError('Replica upload did not return an ID');uploadId=begun.uploadId;uploads.add(uploadId);
            for(let offset=0;offset<asset.bytes;offset+=16384) {
              referenced(asset.sha256);signal.throwIfAborted();const bytes=await read(peer,asset.sha256,offset,Math.min(16384,asset.bytes-offset),signal);
              const written=mediaObject(await options.storage.execute({op:'write',uploadId,offset,data:bytes.toString('base64')}),'Replica chunk receipt');
              if(written.receivedBytes!==offset+bytes.length)throw new TypeError('Replica storage acknowledged the wrong byte offset');
            }
            const finished=mediaObject(await options.storage.execute({op:'finish',uploadId}),'Finished replica');uploads.delete(uploadId);uploadId='';
            if(finished.asset===undefined||!sameAsset(parseMediaMetadata(finished.asset),asset))throw new TypeError('Decoded replica metadata disagrees with the authoritative manifest');
          }
          referenced(asset.sha256);await scan();if(!local.has(asset.sha256))throw new Error('Finished replica is absent from verified durable inventory');await broadcast();return;
        } catch(error) {
          if(uploadId)await cancel(uploadId);
          if(closed)throw shutdown();if(!assets.has(asset.sha256))throw new Error('Media reference was removed during replication');
          const failure=error instanceof Error?error:new Error(String(error));failures.push(failure);holders.get(peer)?.delete(asset.sha256);status();
          console.warn('media_replica_source_failed',{roomId,peer,sha256:asset.sha256,message:failure.message});
        }
      }
      throw new Error('Every online media copy failed for '+asset.sha256+': '+failures.map(error=>error.message).join('; '));
    } finally {release();}
  }
  /** @param {string} hash @returns {Promise<void>} */
  function ensure(hash) {
    let asset;try{asset=referenced(hash);}catch(error){return Promise.reject(error);}
    if(local.has(hash))return Promise.resolve();const existing=ensures.get(hash);if(existing)return existing;
    if(ensures.size>=16)return Promise.reject(new RangeError('Media replica already has 16 queued assets'));
    const work=track(transfer(asset));ensures.set(hash,work);work.then(()=>ensures.delete(hash),()=>ensures.delete(hash));return work;
  }
  /** @param {string} hash @returns {boolean} */
  function designated(hash) {const guests=[...members].filter(peer=>peer!==ownerId).sort();return selfId===ownerId||guests.length>0&&guests[Number.parseInt(hash.slice(0,8),16)%guests.length]===selfId;}
  /** @returns {void} */
  function backgroundWork() {
    if(closed)return;if(background){backgroundDirty=true;return;}background=true;backgroundDirty=false;
    const work=track((async()=>{
      for(const hash of assets.keys())if(!local.has(hash)&&designated(hash)&&!backgroundFailures.has(hash)&&[...holders].some(([peer,values])=>members.has(peer)&&values.has(hash))) {
        try{await ensure(hash);}catch(error){if(!closed){backgroundFailures.add(hash);options.reportError(error instanceof Error?error:new Error(String(error)));}}
      }
    })());work.then(()=>{background=false;if(backgroundDirty)backgroundWork();},error=>{background=false;if(!closed)options.reportError(error instanceof Error?error:new Error(String(error)));});
  }
  /** @param {ReplicaUpdate} input @returns {Promise<void>} */
  function update(input) {
    open();if(!input||typeof input.roomId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.roomId))return Promise.reject(new TypeError('Media replica room must be a UUID'));
    if(roomId&&roomId!==input.roomId)return Promise.reject(new TypeError('Close the media replica before switching rooms'));
    if(!Array.isArray(input.assets)||input.assets.length>4096||!Array.isArray(input.members)||input.members.length>256)return Promise.reject(new RangeError('Media replica manifest exceeds 4096 assets or 256 members'));
    const parsed=input.assets.map(parseMediaMetadata).sort((a,b)=>a.sha256.localeCompare(b.sha256)),onlineMembers=[...new Set(input.members.map(member))].sort(),nextOwner=member(input.ownerId);
    if(new Set(parsed.map(asset=>asset.sha256)).size!==parsed.length||!onlineMembers.includes(selfId)||!onlineMembers.includes(nextOwner))return Promise.reject(new TypeError('Media manifest hashes must be unique and online membership must include self and owner'));
    const key=JSON.stringify([input.roomId,parsed,onlineMembers,nextOwner]);if(key===updateKey)return updateWork;
    updateWork=track(updateWork.catch(error=>{if(closed)throw shutdown();console.warn('media_replica_update_retry',{roomId,message:error instanceof Error?error.message:String(error)});}).then(async()=>{
      open();const previousMembers=members,changed=JSON.stringify([...assets.values()])!==JSON.stringify(parsed),first=!roomId;
      for(const asset of parsed){const existing=assets.get(asset.sha256);if(existing&&!sameAsset(existing,asset))throw new TypeError('Content-addressed media metadata is immutable: '+asset.sha256);}
      roomId=input.roomId;ownerId=nextOwner;members=new Set(onlineMembers);assets=new Map(parsed.map(asset=>[asset.sha256,asset]));backgroundFailures.clear();
      for(const peer of holders.keys())if(!members.has(peer))holders.delete(peer);
      for(const [identity,assembly]of assemblies)if(!members.has(assembly.peer)){clearTimeout(assembly.timer);assemblies.delete(identity);}
      for(const peer of reads.keys())if(!members.has(peer)){reads.delete(peer);inventoryReads.delete(peer);nextRead.delete(peer);}
      for(const [session,entry]of pending)if(!members.has(entry.peer))rejectPending(session,new Error('Media peer left the room: '+entry.peer));
      for(const values of holders.values())for(const hash of values)if(!assets.has(hash))values.delete(hash);
      local=new Set([...local].filter(hash=>assets.has(hash)));
      if(changed||first||!updateKey){await options.storage.references([...assets.keys()]);open();await scan();await broadcast();}
      else for(const peer of members)if(peer!==selfId&&!previousMembers.has(peer))await announce(peer,randomBytes(16).toString('hex'));
      status();const peers=[...members].filter(peer=>peer!==selfId&&(changed||first||!updateKey||!previousMembers.has(peer)));
      void track(discoverPeers(peers));backgroundWork();updateKey=key;
    }).catch(error=>{updateKey='';throw closed?shutdown():error;}));return updateWork;
  }
  /** @param {string} peer @param {string} session @param {Buffer} payload @returns {Promise<void>} */
  function receive(peer,session,payload) {return track((async()=>{
    online(peer);sessionId(session);if(!roomId)throw new Error('Media replica inventory is not ready');if(!Buffer.isBuffer(payload)||!payload.length||payload.length>24576)throw new RangeError('Media wire payload must contain at most 24 KiB');
    const row=mediaObject(JSON.parse(payload.toString('utf8')),'Media wire message');
    if(row.t==='inventory-request'){rate(inventoryReads,peer,2);await announce(peer,session);return;}
    if(row.t==='inventory') {
      const page=mediaInteger(row.page,'Inventory page',0,15),pages=mediaInteger(row.pages,'Inventory pages',1,16);
      if(page>=pages||!Array.isArray(row.hashes)||row.hashes.length>256)throw new RangeError('Media inventory page exceeds its limits');
      const hashes=row.hashes.map(mediaHash);if(new Set(hashes).size!==hashes.length||hashes.some(hash=>!assets.has(hash)))throw new TypeError('Peer inventory contains unreferenced or duplicate media');
      const identity=peer+':'+session;let assembly=assemblies.get(identity);
      if(!assembly){if(assemblies.size>=16)throw new RangeError('Media inventory already has 16 incomplete exchanges');assembly={peer,pages,parts:new Map(),timer:setTimeout(()=>{assemblies.delete(identity);},15000)};assemblies.set(identity,assembly);}
      if(assembly.pages!==pages||assembly.parts.has(page))throw new TypeError('Media inventory page is inconsistent or repeated');assembly.parts.set(page,hashes);
      if(assembly.parts.size===pages){const values=[...assembly.parts.values()].flat();if(new Set(values).size!==values.length)throw new TypeError('Media inventory repeats a hash across pages');clearTimeout(assembly.timer);assemblies.delete(identity);const previous=holders.get(peer);holders.set(peer,new Set(values));for(const hash of values)if(!previous?.has(hash))backgroundFailures.delete(hash);const entry=pending.get(session);if(entry){if(entry.peer!==peer||entry.kind!=='inventory')throw new TypeError('Media inventory response does not match its request');pending.delete(session);clearTimeout(entry.timer);entry.resolve();}status();backgroundWork();}
      return;
    }
    if(row.t==='result') {
      const entry=pending.get(session);if(!entry||entry.peer!==peer||entry.kind!=='read')throw new TypeError('Media result does not match its requesting peer and session');
      try {
        if(typeof row.ok!=='boolean')throw new TypeError('Media result must declare a boolean ok field');
        if(row.ok===false){rejectPending(session,new Error(typeof row.message==='string'?row.message.slice(0,500):'Remote media read failed'));return;}
        if(typeof row.data!=='string'||row.data.length>21848)throw new RangeError('Media chunk exceeds 16 KiB');const bytes=Buffer.from(row.data,'base64');
        if(bytes.length!==entry.length||bytes.toString('base64')!==row.data)throw new TypeError('Media chunk length or base64 encoding is invalid');pending.delete(session);clearTimeout(entry.timer);entry.signal.removeEventListener('abort',entry.abort);entry.resolve(bytes);return;
      }catch(error){rejectPending(session,error instanceof Error?error:new TypeError(String(error)));throw error;}
    }
    if(row.t==='request') {
      let hash='';
      try {hash=mediaHash(row.sha256);const asset=referenced(hash),offset=mediaInteger(row.offset,'Media offset',0,asset.bytes-1),length=mediaInteger(row.length,'Media read length',1,16384);
        rate(reads,peer,16);if(offset+length>asset.bytes||!local.has(hash))throw new RangeError('Media read is outside the verified local asset');
        const result=mediaObject(await options.storage.execute({op:'read',sha256:hash,offset,length}),'Local media read');if(typeof result.data!=='string'||Buffer.from(result.data,'base64').length!==length||Buffer.from(result.data,'base64').toString('base64')!==result.data)throw new TypeError('Local media read returned invalid bytes');await send(peer,session,{t:'result',ok:true,data:result.data});}
      catch(error){if(closed)throw shutdown();options.reportError(error instanceof Error?error:new Error(String(error)));await send(peer,session,{t:'result',ok:false,message:'Verified media chunk is unavailable or the request exceeds room limits'});}
      return;
    }
    throw new TypeError('Unsupported media replica wire message');
  })().catch(error=>{throw closed?shutdown():error;}));}
  /** @returns {Promise<void>} */
  function close() {
    if(closing)return closing;closed=true;controller.abort();
    for(const [session]of pending)rejectPending(session,shutdown());for(const assembly of assemblies.values())clearTimeout(assembly.timer);assemblies.clear();
    for(const slot of slots.splice(0))slot.reject(shutdown());
    const cancellations=[...uploads].map(uploadId=>cancel(uploadId));
    closing=(async()=>{await Promise.allSettled(cancellations);while(tasks.size)await Promise.allSettled([...tasks]);holders.clear();local.clear();ensures.clear();discoveries.clear();})();return closing;
  }
  return {update,receive,ensure,close};
}
module.exports={createMediaReplicas};
