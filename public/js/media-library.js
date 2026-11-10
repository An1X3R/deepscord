// @ts-check
/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('./sticker-panel.js').StickerItem} StickerItem */
/** @typedef {import('./sticker-panel.js').StickerPreferences} StickerPreferences */
/** @typedef {import('./sticker-panel.js').MediaLease} MediaLease */
/** @typedef {{sha256:string,bytes:number,width:number,height:number,animated:boolean,frames:number,durationMs:number}} MediaMetadata */
/** @typedef {{width:number,height:number,animated:boolean,frames:number,durationMs:number}} MediaValidation */
/** @typedef {{validate:(blob:Blob,signal:AbortSignal)=>Promise<MediaValidation>}} PersonalLibraryOptions */
/** @typedef {{listPersonalStickers:()=>Promise<JsonValue>,addPersonalSticker:(input:{name:string,data:string})=>Promise<JsonValue>,removePersonalSticker:(id:string)=>Promise<JsonValue>,pinPersonalSticker:(id:string)=>Promise<JsonValue>,recordPersonalStickerUse:(id:string)=>Promise<JsonValue>,setStickerPreferences:(preferences:StickerPreferences)=>Promise<JsonValue>,readPersonalSticker:(sha256:string)=>Promise<string>}} PersonalStickerApi */
/** @typedef {{items:StickerItem[],preferences:StickerPreferences}} PersonalSnapshot */
const MAX_ITEMS=300,MAX_BYTES=160*1024,MAX_TOTAL_BYTES=48*1024*1024;
/** @param {JsonValue|undefined} value @param {string} label @returns {{[key:string]:JsonValue}} */
function object(value,label){if(!value || typeof value!=='object' || Array.isArray(value))throw new TypeError(label+' must be an object');return value;}
/** @param {JsonValue|undefined} value @param {string} label @param {number} maximum @returns {string} */
function text(value,label,maximum){if(typeof value!=='string' || !value.length || value.length>maximum)throw new TypeError(label+' must be a nonempty string of at most '+maximum+' characters');return value;}
/** @param {JsonValue|undefined} value @param {string} label @returns {number} */
function integer(value,label){if(typeof value!=='number' || !Number.isSafeInteger(value) || value<0)throw new TypeError(label+' must be a nonnegative safe integer');return value;}
/** @param {JsonValue} value @returns {StickerPreferences} */
function parsePreferences(value){const row=object(value,'Sticker preferences');if(row.columns!==4 && row.columns!==5 && row.columns!==6 && row.columns!==8)throw new TypeError('Unsupported sticker column count');if(row.sort!=='frequency' && row.sort!=='recent' && row.sort!=='added')throw new TypeError('Unsupported sticker sort order');return {columns:row.columns,sort:row.sort};}
/** @param {JsonValue} value @returns {StickerItem} */
function parseItem(value){const row=object(value,'Personal sticker');const sha256=text(row.sha256,'Sticker SHA256',64),id=text(row.id,'Sticker ID',80);if(!/^[a-f0-9]{64}$/.test(sha256) || !/^personal-[a-f0-9]{64}$/.test(id) || row.kind!=='personal' || row.domainId!==null)throw new TypeError('Personal sticker identity is invalid');const width=integer(row.width,'Sticker width'),height=integer(row.height,'Sticker height'),bytes=integer(row.bytes,'Sticker bytes'),frames=integer(row.frames,'Sticker frame count');if(width<1 || width>360 || height<1 || height>360 || bytes<1 || bytes>MAX_BYTES || frames<1 || typeof row.animated!=='boolean' || row.animated!==(frames>1) || typeof row.durationMs!=='number' || !Number.isFinite(row.durationMs) || row.durationMs<0 || typeof row.pinned!=='boolean')throw new RangeError('Personal sticker metadata exceeds supported limits');return {id,sha256,kind:'personal',domainId:null,name:text(row.name,'Sticker name',80),width,height,bytes,frames,animated:row.animated,durationMs:row.durationMs,addedAt:integer(row.addedAt,'Sticker added time'),useCount:integer(row.useCount,'Sticker use count'),lastUsedAt:integer(row.lastUsedAt,'Sticker last use time'),pinned:row.pinned};}
/** @param {JsonValue} value @returns {PersonalSnapshot} */
function parseSnapshot(value){const row=object(value,'Personal sticker library');if(!Array.isArray(row.items) || row.items.length>MAX_ITEMS)throw new RangeError('Personal sticker library must contain at most 300 items');const items=row.items.map(parseItem);if(new Set(items.map(item=>item.id)).size!==items.length)throw new TypeError('Personal sticker library contains duplicate IDs');const sizes=new Map(items.map(item=>[item.sha256,item.bytes]));if([...sizes.values()].reduce((sum,bytes)=>sum+bytes,0)>MAX_TOTAL_BYTES)throw new RangeError('Personal sticker library exceeds 48 MiB');return {items,preferences:parsePreferences(row.preferences ?? null)};}
/** @template T @param {IDBRequest<T>} operation @returns {Promise<T>} */
function request(operation){return new Promise((resolve,reject)=>{operation.onsuccess=()=>resolve(operation.result);operation.onerror=()=>reject(operation.error ?? new DOMException('IndexedDB request failed','UnknownError'));});}
/** @param {IDBTransaction} transaction @returns {Promise<void>} */
function completed(transaction){return new Promise((resolve,reject)=>{transaction.oncomplete=()=>resolve();transaction.onabort=()=>reject(transaction.error ?? new DOMException('Personal sticker transaction aborted','AbortError'));transaction.onerror=()=>reject(transaction.error ?? new DOMException('Personal sticker transaction failed','UnknownError'));});}
/** @returns {Promise<IDBDatabase>} */
function openDatabase(){return new Promise((resolve,reject)=>{let blocked=false;const operation=indexedDB.open('deepscord-personal-stickers-v1',1);operation.onupgradeneeded=()=>{const db=operation.result;db.createObjectStore('items',{keyPath:'id'});db.createObjectStore('blobs',{keyPath:'sha256'});db.createObjectStore('settings');};operation.onerror=()=>reject(operation.error ?? new DOMException('Cannot open personal sticker database','UnknownError'));operation.onblocked=()=>{blocked=true;reject(new DOMException('Personal sticker database upgrade is blocked by another window','InvalidStateError'));};operation.onsuccess=()=>{if(blocked){operation.result.close();return;}resolve(operation.result);};});}
/** @param {Blob} blob @returns {Promise<string>} */
async function base64(blob){const data=new Uint8Array(await blob.arrayBuffer());let binary='';for(let offset=0;offset<data.length;offset+=8192)binary+=String.fromCharCode(...data.subarray(offset,offset+8192));return btoa(binary);}
/** @param {string} encoded @returns {Blob} */
function decodeBase64(encoded){if(typeof encoded!=='string' || !encoded.length || encoded.length>Math.ceil(MAX_BYTES/3)*4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw new TypeError('Personal sticker data must be bounded canonical base64');const binary=atob(encoded);if(btoa(binary)!==encoded)throw new TypeError('Personal sticker data is not canonical base64');return new Blob([Uint8Array.from(binary,character=>character.charCodeAt(0))],{type:'image/avif'});}

/** @param {PersonalLibraryOptions} options */
export async function createPersonalLibrary(options){
  /** @type {Window & typeof globalThis & {stickerPicker?:Partial<PersonalStickerApi>}} */const globals=/** @type {typeof globals} */(window);
  const candidate=globals.stickerPicker;
  const names=['listPersonalStickers','addPersonalSticker','removePersonalSticker','pinPersonalSticker','recordPersonalStickerUse','setStickerPreferences','readPersonalSticker'];
  const supplied=candidate ? names.filter(name=>typeof candidate[/** @type {keyof PersonalStickerApi} */(name)]==='function').length : 0;
  if(supplied>0 && supplied!==names.length)throw new TypeError('Desktop personal sticker APIs are incomplete; update the desktop client');
  const native=supplied===names.length ? /** @type {PersonalStickerApi} */(candidate) : null;
  const database=native ? null : await openDatabase();
  /** @type {PersonalSnapshot} */let snapshot={items:[],preferences:{columns:6,sort:'frequency'}};
  let destroyed=false;
  /** @type {Promise<void>} */let pending=Promise.resolve();
  /** @type {Set<()=>void>} */const releases=new Set();
  /** @type {Set<AbortController>} */const controllers=new Set();
  /** @type {Map<string,MediaMetadata>} */const validated=new Map();
  /** @template T @param {()=>Promise<T>} operation @returns {Promise<T>} */
  function serial(operation){if(destroyed)return Promise.reject(new Error('Personal sticker library has been destroyed'));const result=pending.then(()=>{if(destroyed)throw new Error('Personal sticker library has been destroyed');return operation();});pending=result.then(()=>{},()=>{});return result;}
  /** @template T @param {AbortSignal} signal @param {(signal:AbortSignal)=>Promise<T>} operation @returns {Promise<T>} */
  async function withSignal(signal,operation){
    if(destroyed)throw new Error('Personal sticker library has been destroyed');
    const controller=new AbortController();controllers.add(controller);const cancel=()=>controller.abort(signal.reason);signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
    try{controller.signal.throwIfAborted();return await operation(controller.signal);}
    finally{signal.removeEventListener('abort',cancel);controllers.delete(controller);}
  }
  /** @returns {Promise<void>} */
  async function refresh(){
    if(native){const next=parseSnapshot(await native.listPersonalStickers());if(destroyed)throw new Error('Personal sticker library was destroyed while refreshing');snapshot=next;return;}
    if(!database)throw new Error('Personal sticker database is unavailable');
    const transaction=database.transaction(['items','settings'],'readonly'),done=completed(transaction);
    /** @type {IDBRequest<JsonValue[]>} */const items=transaction.objectStore('items').getAll();
    /** @type {IDBRequest<JsonValue|undefined>} */const preferences=transaction.objectStore('settings').get('preferences');
    const [storedItems,storedPreferences]=await Promise.all([request(items),request(preferences)]);await done;
    if(destroyed)throw new Error('Personal sticker library was destroyed while refreshing');snapshot=parseSnapshot({items:storedItems,preferences:storedPreferences ?? {columns:6,sort:'frequency'}});
  }
  /** @param {Blob} blob @param {AbortSignal} signal @returns {Promise<MediaMetadata>} */
  async function validate(blob,signal){
    signal.throwIfAborted();if(!(blob instanceof Blob) || blob.type!=='image/avif' || blob.size<1 || blob.size>MAX_BYTES)throw new RangeError('Personal stickers require pure AVIF within 160 KiB');
    const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
    signal.throwIfAborted();const cached=validated.get(digest);
    if(cached){validated.delete(digest);validated.set(digest,cached);return {...cached};}
    const media=await options.validate(blob,signal);signal.throwIfAborted();
    const checked=parseItem({...media,sha256:digest,bytes:blob.size,id:'personal-'+digest,kind:'personal',domainId:null,name:'validated',addedAt:0,useCount:0,lastUsedAt:0,pinned:false});
    signal.throwIfAborted();
    const result={sha256:checked.sha256,bytes:checked.bytes,width:checked.width,height:checked.height,animated:checked.animated,frames:checked.frames,durationMs:checked.durationMs};validated.set(digest,result);
    while(validated.size>MAX_ITEMS){const oldest=validated.keys().next().value;if(oldest===undefined)break;validated.delete(oldest);}
    return {...result};
  }
  /** @param {string} id @returns {StickerItem} */
  function find(id){if(typeof id!=='string' || !/^personal-[a-f0-9]{64}$/.test(id))throw new TypeError('Invalid personal sticker ID');const item=snapshot.items.find(item=>item.id===id);if(!item)throw new RangeError('Personal sticker no longer exists: '+id);return item;}
  /** @param {Blob} blob @param {string} name @param {AbortSignal} signal @returns {Promise<StickerItem>} */
  function add(blob,name,signal){return withSignal(signal,activeSignal=>serial(async()=>{
    const signal=activeSignal;
    const cleanName=text(name,'Sticker name',80).trim();if(!cleanName)throw new TypeError('Sticker name cannot be blank');const media=await validate(blob,signal);signal.throwIfAborted();
    if(native){const data=await base64(blob);signal.throwIfAborted();const item=parseItem(await native.addPersonalSticker({name:cleanName,data}));await refresh();signal.throwIfAborted();return item;}
    if(!database)throw new Error('Personal sticker database is unavailable');
    const transaction=database.transaction(['items','blobs'],'readwrite'),done=completed(transaction);
    /** @type {IDBRequest<JsonValue[]>} */const query=transaction.objectStore('items').getAll();
    let result;
    try{
      const items=(await request(query)).map(parseItem),existing=items.find(item=>item.sha256===media.sha256);signal.throwIfAborted();
      if(existing)result=existing;
      else{
        const unique=new Map(items.map(item=>[item.sha256,item.bytes]));if(items.length>=MAX_ITEMS || [...unique.values()].reduce((sum,bytes)=>sum+bytes,0)+media.bytes>MAX_TOTAL_BYTES)throw new RangeError('Personal sticker library reached its 300 item or 48 MiB limit');
        result={...media,id:'personal-'+media.sha256,kind:/** @type {'personal'} */('personal'),domainId:null,name:cleanName,addedAt:Date.now(),useCount:0,lastUsedAt:0,pinned:false};
        transaction.objectStore('blobs').put({sha256:media.sha256,blob});transaction.objectStore('items').put(result);
      }
    }catch(error){transaction.abort();await done.catch(()=>{});throw error;}
    await done;await refresh();signal.throwIfAborted();return {...result};
  }));}
  /** @param {string} id @returns {Promise<void>} */
  function remove(id){return serial(async()=>{
    find(id);if(native){await native.removePersonalSticker(id);await refresh();return;}if(!database)throw new Error('Personal sticker database is unavailable');
    const transaction=database.transaction(['items','blobs'],'readwrite'),done=completed(transaction);
    /** @type {IDBRequest<JsonValue[]>} */const query=transaction.objectStore('items').getAll();
    try{const items=(await request(query)).map(parseItem),item=items.find(item=>item.id===id);if(!item)throw new RangeError('Personal sticker no longer exists: '+id);transaction.objectStore('items').delete(id);if(!items.some(entry=>entry.id!==id && entry.sha256===item.sha256))transaction.objectStore('blobs').delete(item.sha256);}
    catch(error){transaction.abort();await done.catch(()=>{});throw error;}await done;await refresh();
  });}
  /** @param {string} id @param {(item:StickerItem)=>StickerItem} update @returns {Promise<StickerItem>} */
  async function updateItem(id,update){
    if(!database)throw new Error('Personal sticker database is unavailable');const transaction=database.transaction('items','readwrite'),done=completed(transaction);
    /** @type {IDBRequest<JsonValue|undefined>} */const query=transaction.objectStore('items').get(id);let next;
    try{next=update(parseItem((await request(query)) ?? null));transaction.objectStore('items').put(next);}catch(error){transaction.abort();await done.catch(()=>{});throw error;}await done;await refresh();return {...next};
  }
  /** @param {string} id @returns {Promise<StickerItem>} */
  function pin(id){return serial(async()=>{find(id);if(native){await native.pinPersonalSticker(id);await refresh();return {...find(id)};}return updateItem(id,item=>({...item,pinned:!item.pinned}));});}
  /** @param {string} id @returns {Promise<StickerItem>} */
  function recordUse(id){return serial(async()=>{const original=find(id);if(original.useCount===Number.MAX_SAFE_INTEGER)throw new RangeError('Personal sticker use count is exhausted');if(native){await native.recordPersonalStickerUse(id);await refresh();return {...find(id)};}return updateItem(id,item=>{if(item.useCount===Number.MAX_SAFE_INTEGER)throw new RangeError('Personal sticker use count is exhausted');return {...item,useCount:item.useCount+1,lastUsedAt:Date.now()};});});}
  /** @param {StickerPreferences} value @returns {Promise<void>} */
  function setPreferences(value){return serial(async()=>{const parsed=parsePreferences(value);if(native)await native.setStickerPreferences(parsed);else{if(!database)throw new Error('Personal sticker database is unavailable');const transaction=database.transaction('settings','readwrite'),done=completed(transaction);transaction.objectStore('settings').put(parsed,'preferences');await done;}await refresh();});}
  /** @param {StickerItem} item @param {AbortSignal} signal @returns {Promise<MediaLease>} */
  function load(item,signal){return withSignal(signal,async activeSignal=>{
      const owned=find(item.id);if(owned.sha256!==item.sha256)throw new TypeError('Personal sticker identity changed before loading');
      activeSignal.throwIfAborted();let blob;
      if(native)blob=decodeBase64(await native.readPersonalSticker(owned.sha256));
      else{if(!database)throw new Error('Personal sticker database is unavailable');const transaction=database.transaction('blobs','readonly'),done=completed(transaction);
        /** @type {IDBRequest<{sha256:string,blob:Blob}|undefined>} */const query=transaction.objectStore('blobs').get(owned.sha256);const row=await request(query);await done;if(!row || row.sha256!==owned.sha256 || !(row.blob instanceof Blob))throw new TypeError('Personal sticker AVIF data is missing');blob=row.blob;}
      const media=await validate(blob,activeSignal);if(media.sha256!==owned.sha256 || media.bytes!==owned.bytes || media.width!==owned.width || media.height!==owned.height || media.animated!==owned.animated || media.frames!==owned.frames || media.durationMs!==owned.durationMs)throw new TypeError('Stored personal sticker metadata differs from its actual AVIF bytes');activeSignal.throwIfAborted();
      const url=URL.createObjectURL(blob);let released=false;
      /** @returns {void} */function release(){if(released)return;released=true;URL.revokeObjectURL(url);releases.delete(release);}
      releases.add(release);return {url,release};
  });}
  /** @returns {StickerItem[]} */function list(){if(destroyed)throw new Error('Personal sticker library has been destroyed');return snapshot.items.map(item=>({...item}));}
  /** @returns {StickerPreferences} */function getPreferences(){if(destroyed)throw new Error('Personal sticker library has been destroyed');return {...snapshot.preferences};}
  /** @returns {void} */function destroy(){if(destroyed)return;destroyed=true;for(const controller of controllers)controller.abort();controllers.clear();validated.clear();for(const release of [...releases])release();database?.close();snapshot={items:[],preferences:{columns:6,sort:'frequency'}};}
  try{await refresh();}catch(error){database?.close();throw error;}return {list,add,remove,pin,recordUse,setPreferences,getPreferences,load,refresh:()=>serial(refresh),destroy};
}
