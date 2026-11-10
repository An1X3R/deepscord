// @ts-check
import {createPersonalLibrary} from '../public/js/media-library.js';
import {createStickerPanel} from '../public/js/sticker-panel.js';
/** @typedef {import('../public/js/media-library.js').MediaValidation} MediaValidation */
/** @typedef {import('../public/js/sticker-panel.js').StickerItem} StickerItem */
/** @typedef {import('../public/js/sticker-panel.js').MediaLease} MediaLease */
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {Awaited<ReturnType<typeof createPersonalLibrary>>} PersonalLibrary */
/** @typedef {{runPersistence:()=>Promise<JsonValue>,runValidationCache:()=>Promise<JsonValue>,seedPanel:()=>Promise<JsonValue>,cancelNextPanelRead:()=>void,metrics:()=>{active:number,maxActive:number,leases:number,aborted:number},firstId:()=>string,library:()=>PersonalLibrary,destroy:()=>void}} LibraryTest */
/** @type {Window & typeof globalThis & {personalLibraryTest:LibraryTest}} */const globals=/** @type {typeof globals} */(window);
/** @param {boolean} condition @param {string} message @returns {asserts condition} */
function check(condition,message){if(!condition)throw new Error(message);}
let validationCalls=0;
/** @param {Blob} blob @param {AbortSignal} signal @returns {Promise<MediaValidation>} */
async function validate(blob,signal){validationCalls+=1;const response=await fetch('/validate',{method:'POST',body:blob,signal});if(!response.ok)throw new TypeError('Real AVIF validation failed: '+response.status+' '+await response.text());return response.json();}
/** @param {string} name @returns {Promise<Blob>} */
async function fixture(name){const response=await fetch('/fixture/'+name);check(response.ok,'Real AVIF fixture is unavailable: '+name);return new Blob([await response.arrayBuffer()],{type:'image/avif'});}
/** @template T @param {IDBRequest<T>} operation @returns {Promise<T>} */
function request(operation){return new Promise((resolve,reject)=>{operation.onsuccess=()=>resolve(operation.result);operation.onerror=()=>reject(operation.error);});}
/** @param {IDBTransaction} transaction @returns {Promise<void>} */
function completion(transaction){return new Promise((resolve,reject)=>{transaction.oncomplete=()=>resolve();transaction.onabort=()=>reject(transaction.error);transaction.onerror=()=>reject(transaction.error);});}
/** @returns {Promise<IDBDatabase>} */
function database(){return request(indexedDB.open('deepscord-personal-stickers-v1',1));}
/** @returns {Promise<number>} */
async function blobCount(){const db=await database();try{const transaction=db.transaction('blobs','readonly'),done=completion(transaction),count=await request(transaction.objectStore('blobs').count());await done;return count;}finally{db.close();}}
/** @param {()=>Promise<void>} operation @returns {Promise<string>} */
async function rejected(operation){try{await operation();}catch(error){check(error instanceof Error,'Expected a typed rejection');return error.name;}throw new Error('Expected operation to reject');}

let library=await createPersonalLibrary({validate});
/** @type {ReturnType<typeof createStickerPanel>|null} */let panel=null;
/** @type {StickerItem|null} */let firstItem=null;
const media={active:0,maxActive:0,leases:0,aborted:0};
let cancelNextPanelRead=false;
/** @param {StickerItem} item @param {AbortSignal} signal @returns {Promise<MediaLease>} */
async function loadMedia(item,signal){
  media.active+=1;media.maxActive=Math.max(media.maxActive,media.active);
  try{const loading=library.load(item,signal);if(cancelNextPanelRead){cancelNextPanelRead=false;const tab=document.getElementById('stickerPanelTabunicode');check(tab instanceof HTMLButtonElement,'Missing Unicode tab');tab.click();}const lease=await loading;media.leases+=1;let released=false;return {url:lease.url,release:()=>{if(released)return;released=true;lease.release();media.leases-=1;}};}
  catch(error){if(signal.aborted)media.aborted+=1;throw error;}finally{media.active-=1;}
}
/** @returns {Promise<JsonValue>} */
async function runPersistence(){
  const signal=new AbortController().signal,first=await fixture('first'),second=await fixture('second');
  const added=await Promise.all([library.add(first,'First AVIF',signal),library.add(first,'Duplicate AVIF',signal),library.add(second,'Second AVIF',signal)]);
  check(added[0].id===added[1].id,'Duplicate AVIF must share one personal item');check(library.list().length===2,'IDB imports must serialize without losing independent items');check(await blobCount()===2,'IDB must store each content hash once');
  await Promise.all(Array.from({length:16},()=>library.recordUse(added[0].id)));await library.pin(added[0].id);await library.setPreferences({columns:8,sort:'recent'});
  library.destroy();library=await createPersonalLibrary({validate});const restored=library.list().find(item=>item.id===added[0].id);
  check(!!restored && restored.useCount===16 && restored.pinned,'IDB usage and pin state must survive reopening');check(library.getPreferences().columns===8 && library.getPreferences().sort==='recent','IDB preferences must survive reopening');
  const lease=await library.load(added[0],signal);check((await fetch(lease.url)).ok,'A live lease must expose real AVIF bytes');lease.release();lease.release();await rejected(async()=>{await fetch(lease.url);});
  const owned=await library.load(added[0],signal);library.destroy();await rejected(async()=>{await fetch(owned.url);});owned.release();library=await createPersonalLibrary({validate});
  const alias={...added[0],id:'personal-'+'a'.repeat(64)};
  const db=await database();try{const transaction=db.transaction('items','readwrite'),done=completion(transaction);transaction.objectStore('items').put(alias);await done;}finally{db.close();}
  library.destroy();library=await createPersonalLibrary({validate});check(library.list().length===3,'Persisted references must be parsed on reopening');
  await library.remove(added[0].id);check(await blobCount()===2,'Removing a nonfinal reference must preserve its AVIF');const aliasLease=await library.load(alias,signal);aliasLease.release();await library.remove(alias.id);check(await blobCount()===1,'Removing the final reference must remove its AVIF');
  const canceled=new AbortController();canceled.abort();check(await rejected(async()=>{await library.add(first,'Canceled AVIF',canceled.signal);})==='AbortError','Canceled imports must reject before changing IDB');
  check(library.list().length===1,'Canceled imports must leave the previous library intact');
  const pending=library.load(added[2],signal);library.destroy();check(await rejected(async()=>{await pending;})==='AbortError','Destroy must cancel pending media reads');
  library=await createPersonalLibrary({validate});await library.remove(added[2].id);check(library.list().length===0 && await blobCount()===0,'Final deletion must leave no content objects');
  return {persistent:true,deduplicated:true,transactions:true,leasesReleased:true,finalReferenceRemoved:true,canceled:true};
}
/** @param {StickerItem} item @param {Blob} blob @returns {Promise<void>} */
async function storeContent(item,blob){const db=await database();try{const transaction=db.transaction(['items','blobs'],'readwrite'),done=completion(transaction);transaction.objectStore('items').put(item);transaction.objectStore('blobs').put({sha256:item.sha256,blob});await done;}finally{db.close();}}
/** @returns {Promise<JsonValue>} */
async function runValidationCache(){
  const signal=new AbortController().signal,first=await fixture('first'),second=await fixture('second'),item=await library.add(first,'Cache verification AVIF',signal);
  library.destroy();library=await createPersonalLibrary({validate});const baseline=validationCalls;
  for(let index=0;index<20;index++){const lease=await library.load(item,signal);check((await fetch(lease.url)).ok,'Repeated cache reads must retain usable AVIF bytes');lease.release();}
  check(validationCalls-baseline===1,'Identical current bytes must need only one complete AVIF validation');
  await storeContent({...item,width:item.width+1},first);await library.refresh();
  check(await rejected(async()=>{await library.load(item,signal);})==='TypeError','Cached validation must still match current index metadata');
  check(validationCalls-baseline===1,'Index changes must not require decoding identical current bytes');
  await storeContent(item,second);await library.refresh();
  check(await rejected(async()=>{await library.load(item,signal);})==='TypeError','Current bytes must be hashed before trusting cached metadata');
  check(validationCalls-baseline===2,'A different actual AVIF must be validated independently');
  await storeContent(item,first);await library.refresh();const restored=await library.load(item,signal);restored.release();
  check(validationCalls-baseline===2,'Restoring verified bytes must reuse their validation metadata');
  library.destroy();library=await createPersonalLibrary({validate});const reopened=await library.load(item,signal);reopened.release();
  check(validationCalls-baseline===3,'Destroy must discard all validation metadata');await library.remove(item.id);
  return {repeatedLoads:20,completeValidations:1,currentBytesVerified:true,indexMetadataVerified:true,destroyClearsCache:true};
}
/** @returns {Promise<JsonValue>} */
async function seedPanel(){
  const signal=new AbortController().signal;
  const items=await Promise.all(['first','second','third'].map(async name=>library.add(await fixture(name),name+' AVIF',signal)));firstItem=items[0];
  const anchor=document.getElementById('emojiPanelBtn');check(anchor instanceof HTMLButtonElement,'Missing stable sticker anchor');
  panel=createStickerPanel({id:'stickerPanel',anchor,host:document.body,selection:{kind:'composer',sendSticker:async()=>{throw new Error('This storage test has no connected room');},insertUnicode:()=>{throw new Error('This storage test has no message composer');}},preferences:library.getPreferences(),getCatalog:()=>({personal:library.list(),server:[],domains:[],activeDomainId:null}),loadMedia,importFiles:async(files,_target,operationSignal)=>{for(const file of files)await library.add(file,file.name,operationSignal);},favorite:async()=>{throw new Error('This storage test has no server catalog');},remove:async(item)=>{await library.remove(item.id);},pin:async(item,active)=>{if(library.list().find(row=>row.id===item.id)?.pinned!==active)await library.pin(item.id);},recordUse:async item=>{await library.recordUse(item.id);},savePreferences:preferences=>library.setPreferences(preferences),reportError:error=>{document.getElementById('libraryTestStatus')?.setAttribute('data-error',error.message);}});
  anchor.addEventListener('click',()=>panel?.toggle());
  return {count:items.length,ids:items.map(item=>item.id)};
}
globals.personalLibraryTest={runPersistence,runValidationCache,seedPanel,cancelNextPanelRead:()=>{cancelNextPanelRead=true;},metrics:()=>({...media}),firstId:()=>{check(!!firstItem,'Panel fixtures are not ready');return firstItem.id;},library:()=>library,destroy:()=>{panel?.destroy();library.destroy();}};
document.getElementById('libraryTestStatus')?.replaceChildren(document.createTextNode('Real AVIF + IndexedDB ready'));
