// @ts-check
import {createAvifCodec} from './app-server/public/js/avif-codec.js';
import {createPersonalLibrary} from './app-server/public/js/media-library.js';
import {createStickerPanel} from './app-server/public/js/sticker-panel.js';
/** @typedef {import('../public/js/sticker-panel.js').StickerItem} StickerItem */
/** @typedef {import('../public/js/sticker-panel.js').MediaLease} MediaLease */
/** @typedef {import('../public/js/media-library.js').PersonalStickerApi & {context:()=>Promise<{mode:'choose',appearance:{preset:'industrial'|'constructivist',colors:Record<string,string>},revision:number,requestId:number}|{mode:'save',name:string,data:string}>,present:(requestId:number)=>Promise<void>,onResume:(callback:()=>void)=>(()=>void),onSuspend:(callback:()=>void)=>(()=>void),cancel:()=>Promise<void>,confirm:(id:string|null)=>Promise<void>,switchTab:(tab:'server'|'unicode')=>Promise<void>}} PickerApi */
/** @type {Window & {stickerPicker?:PickerApi}} */const pickerWindow=window;
/** @returns {PickerApi} */
function pickerApi(){const value=pickerWindow.stickerPicker;if(!value)throw new Error('Trusted picker preload is unavailable');return value;}
const api=pickerApi();
/** @template {HTMLElement} T @param {string} id @param {{new():T}} kind @returns {T} */
function node(id,kind){const value=document.getElementById(id);if(!(value instanceof kind))throw new TypeError('Missing picker control: '+id);return value;}
const status=node('status',HTMLElement),confirm=node('confirm',HTMLButtonElement),codec=createAvifCodec();
/** @type {Awaited<ReturnType<typeof createPersonalLibrary>>|null} */let library=null;
/** @type {ReturnType<typeof createStickerPanel>|null} */let panel=null;
let closing=false,busy=false,revision=-1,activation=0;
/** @type {Map<string,Blob>} */const posters=new Map();let posterBytes=0;
/** @param {Blob} blob @returns {MediaLease} */
function posterLease(blob){const url=URL.createObjectURL(blob);return {url,release:()=>URL.revokeObjectURL(url)};}
/** @param {Error} error @returns {void} */
function report(error){status.textContent=error.message;status.hidden=false;status.setAttribute('role','alert');}
/** @param {()=>Promise<void>} operation @returns {Promise<void>} */
async function perform(operation){if(busy)return;busy=true;confirm.disabled=true;try{await operation();}catch(error){report(error instanceof Error?error:new Error(String(error)));}finally{busy=false;confirm.disabled=false;}}
/** @returns {Promise<void>} */
async function cancel(){if(closing)return;closing=true;try{await api.cancel();}catch(error){closing=false;report(error instanceof Error?error:new Error(String(error)));}}
/** @returns {Awaited<ReturnType<typeof createPersonalLibrary>>} */
function personalLibrary(){if(!library)throw new Error('Picker library is unavailable');return library;}
/** @param {StickerItem} item @returns {void} */
function requirePersonal(item){if(item.kind!=='personal')throw new TypeError('Trusted private picker only accepts personal stickers');}
/** @param {StickerItem} item @param {AbortSignal} signal @param {'thumbnail'|'animate'} intent @returns {Promise<MediaLease>} */
async function loadMedia(item,signal,intent){
  requirePersonal(item);signal.throwIfAborted();
  const cached=intent==='thumbnail'?posters.get(item.sha256):undefined;
  if(cached){posters.delete(item.sha256);posters.set(item.sha256,cached);return posterLease(cached);}
  const source=await personalLibrary().load(item,signal);
  if(!item.animated||intent==='animate'){if(signal.aborted){source.release();signal.throwIfAborted();}return source;}
  try{const response=await fetch(source.url,{signal});if(!response.ok)throw new Error('Cannot read local sticker preview: HTTP '+response.status);const poster=await codec.poster(await response.blob(),signal);signal.throwIfAborted();const previous=posters.get(item.sha256);posterBytes-=previous?.size??0;posters.delete(item.sha256);posters.set(item.sha256,poster);posterBytes+=poster.size;
    while(posterBytes>8*1024*1024||posters.size>64){const oldest=posters.keys().next().value;if(oldest===undefined)break;posterBytes-=posters.get(oldest)?.size??0;posters.delete(oldest);}return posterLease(poster);}finally{source.release();}
}
/** @param {readonly File[]} files @param {{kind:'personal'|'server',domainId:string|null}} target @param {AbortSignal} signal @returns {Promise<void>} */
async function importFiles(files,target,signal){
  if(target.kind!=='personal'||target.domainId!==null)throw new TypeError('Trusted private picker cannot import server stickers');
  const local=personalLibrary();for(const file of files){signal.throwIfAborted();if(file.size>32*1024*1024)throw new RangeError('图片不得超过 32 MiB');const prepared=await codec.prepare(file,file.name,'personal',signal);await local.add(prepared.blob,file.name.slice(0,80),signal);}
}
/** @param {'personal'|'server'|'unicode'} tab @returns {void} */
function switchTab(tab){if(tab==='personal')return;void perform(()=>api.switchTab(tab));}
/** @param {Awaited<ReturnType<PickerApi['context']>>} context @returns {Promise<void>} */
async function activate(context){
  if(context.mode!=='choose')throw new TypeError('Only the personal collection can resume');
  const turn=++activation;closing=false;document.body.dataset.active='false';
  const preset=context.appearance.preset;if(preset!=='industrial'&&preset!=='constructivist')throw new TypeError('Unsupported private picker appearance');document.documentElement.dataset.interfacePreset=preset;
  for(const [key,value] of Object.entries(context.appearance.colors)){if(!CSS.supports('color',value))throw new TypeError('Unsupported private picker theme color: '+key);document.documentElement.style.setProperty(key,value,'important');}
  document.body.dataset.mode='choose';node('picker-host',HTMLElement).hidden=false;
  if(!library)library=await createPersonalLibrary({validate:(blob,signal)=>codec.inspect(blob,'personal',signal)});
  else if(revision!==context.revision)await library.refresh();
  if(turn!==activation)return;
  revision=context.revision;
  const retained=new Set(library.list().map(item=>item.sha256));for(const [key,blob] of posters){if(!retained.has(key)){posterBytes-=blob.size;posters.delete(key);}}
  if(!panel)panel=createStickerPanel({
    id:'personalStickerPicker',anchor:node('picker-anchor',HTMLElement),host:node('picker-host',HTMLElement),
    selection:{kind:'composer',sendSticker:async(item,signal)=>{requirePersonal(item);signal.throwIfAborted();await api.confirm(item.id);},insertUnicode:()=>{throw new TypeError('Unicode selection must be returned to the room panel');}},
    preferences:library.getPreferences(),getCatalog:()=>({personal:personalLibrary().list(),server:[],domains:[],activeDomainId:null,canManageServer:false}),
    loadMedia,importFiles,
    favorite:async()=>{throw new TypeError('Trusted private picker cannot access server stickers');},
    remove:async(item,signal)=>{requirePersonal(item);signal.throwIfAborted();await personalLibrary().remove(item.id);const old=posters.get(item.sha256);if(old){posterBytes-=old.size;posters.delete(item.sha256);}},
    pin:async(item,active,signal)=>{requirePersonal(item);signal.throwIfAborted();if(item.pinned!==active)await personalLibrary().pin(item.id);},
    recordUse:async()=>{},savePreferences:preferences=>personalLibrary().setPreferences(preferences),reportError:report,onTabRequest:switchTab,onDismiss:()=>void cancel(),
  });
  panel.open();await api.present(context.requestId);
  if(turn===activation){document.body.dataset.active='true';document.body.dataset.ready='true';}
}
/** @returns {Promise<void>} */
async function resume(){try{await activate(await api.context());}catch(error){report(error instanceof Error?error:new Error(String(error)));}}
const removeResume=api.onResume(()=>void resume());
const removeSuspend=api.onSuspend(()=>{activation+=1;panel?.suspend();document.body.dataset.active='false';});
const context=await api.context();
node('cancel',HTMLButtonElement).addEventListener('click',()=>void cancel());
if(context.mode==='save'){
  node('save-view',HTMLElement).hidden=false;node('preview-name',HTMLElement).textContent=context.name;node('preview-image',HTMLImageElement).src='data:image/avif;base64,'+context.data;confirm.disabled=false;
  confirm.addEventListener('click',()=>void perform(()=>api.confirm(null)));document.body.dataset.ready='true';
}else{
  try{await activate(context);}catch(error){report(new Error('无法打开本机私人表情库：'+(error instanceof Error?error.message:String(error))));node('failure-cancel',HTMLButtonElement).hidden=false;await api.present(context.requestId);}
}
node('failure-cancel',HTMLButtonElement).addEventListener('click',()=>void cancel());
window.addEventListener('beforeunload',()=>{closing=true;activation+=1;removeResume();removeSuspend();panel?.destroy();library?.destroy();codec.destroy();posters.clear();posterBytes=0;});
