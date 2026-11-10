// @ts-check
'use strict';
const {ipcMain}=require('electron');
const {createStickerStore}=require('./sticker-store.cjs');
const {createStickerPicker}=require('./sticker-picker.cjs');
const {parsePresentation,createEmbeddedStickerPicker}=require('./sticker-embedded.cjs');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('./sticker-store.cjs').MediaValidation} MediaValidation */
/** @typedef {{directory:string,assertOwner:(event:Electron.IpcMainInvokeEvent)=>void,getWindow:()=>Electron.BrowserWindow|null,validator:{validate:(data:Buffer,kind:'personal',signal:AbortSignal)=>Promise<MediaValidation>,close:()=>void}}} StickerIpcOptions */
/** @typedef {{picker:ReturnType<typeof createStickerPicker>|ReturnType<typeof createEmbeddedStickerPicker>,appearance:{preset:'industrial'|'constructivist',colors:Record<string,string>},event:Electron.IpcMainInvokeEvent,signal:AbortSignal,cancel:()=>void,finish:(result:JsonValue)=>void,input:{name:string,data:string}|null,busy:boolean,requestId:number,didPresent:()=>void}} PickerRequest */
/** @param {StickerIpcOptions} options */
function registerPersonalStickerIpc(options){
  /** @type {Promise<Awaited<ReturnType<typeof createStickerStore>>>|null} */let storePromise=null;
  /** @type {PickerRequest|null} */let active=null;
  /** @type {string[]} */const channels=[];
  let closed=false,revision=0,requestId=0;
  /** @type {{parent:Electron.BrowserWindow,picker:ReturnType<typeof createEmbeddedStickerPicker>}|null} */let retained=null;
  /** @returns {Promise<Awaited<ReturnType<typeof createStickerStore>>>} */
  function store(){if(closed)throw new Error('Personal sticker IPC is closed');if(!storePromise)storePromise=createStickerStore({directory:options.directory,validate:options.validator.validate});return storePromise;}
  /** @param {Electron.IpcMainInvokeEvent} event @returns {PickerRequest} */
  function trusted(event){const state=active;if(!state||closed)throw new Error('No trusted personal sticker picker is active');state.picker.assertCaller(event);options.assertOwner(state.event);state.signal.throwIfAborted();return state;}
  /** @param {string} channel @param {(event:Electron.IpcMainInvokeEvent,value:JsonValue)=>Promise<JsonValue|void>} handler */
  function register(channel,handler){ipcMain.handle(channel,handler);channels.push(channel);}
  /** @param {JsonValue} value @returns {string} */
  function identifier(value){if(typeof value!=='string')throw new TypeError('Personal sticker identifier must be a string');return value;}
  /** @template T @param {Electron.IpcMainInvokeEvent} event @param {(storage:Awaited<ReturnType<typeof createStickerStore>>,signal:AbortSignal)=>Promise<T>} operation @returns {Promise<T>} */
  async function raw(event,operation){const state=trusted(event);if(state.input)throw new Error('Save confirmation cannot browse or modify the existing personal library');const storage=await store();if(trusted(event)!==state)throw new Error('Personal sticker request changed while opening storage');const result=await operation(storage,state.signal);if(trusted(event)!==state)throw new Error('Personal sticker request changed during storage operation');return result;}
  /** @param {Electron.IpcMainInvokeEvent} event @param {{name:string,data:string}|null} input @param {import('./sticker-embedded.cjs').PickerPresentation|null} presentation @returns {Promise<JsonValue>} */
  function request(event,input,presentation){
    options.assertOwner(event);if(closed)throw new Error('Personal sticker IPC is closed');if(active)throw new Error('A personal sticker picker is already open');const parent=options.getWindow();if(!parent||parent.isDestroyed())throw new Error('Personal sticker owner window is unavailable');
    if(retained&&(retained.parent!==parent||retained.picker.window.isDestroyed())){retained.picker.window.destroy();retained=null;}
    const reused=!!(presentation&&retained);
    const picker=presentation?(retained?.picker??createEmbeddedStickerPicker(parent,presentation)):createStickerPicker(parent),controller=new AbortController();
    if(presentation&&'prepare' in picker){picker.prepare(presentation);retained={parent,picker};}
    if(!reused)picker.window.once('closed',()=>{if(active?.picker===picker)active.cancel();});
    return new Promise((resolve,reject)=>{
      const cancel=()=>finish(input ? false : null);
      /** @param {JsonValue} result */
      function finish(result){if(dispose())resolve(result);}
      /** @returns {boolean} */
      function dispose(){if(active!==state)return false;active=null;clearTimeout(timer);controller.abort();event.sender.removeListener('destroyed',cancel);event.sender.removeListener('did-start-navigation',navigate);event.sender.removeListener('render-process-gone',cancel);parent?.removeListener('resize',cancel);parent?.removeListener('hide',cancel);parent?.removeListener('minimize',cancel);if(!picker.window.isDestroyed()){if('suspend' in picker&&picker.isReady())picker.suspend();else{picker.window.destroy();if(retained?.picker===picker)retained=null;}}if(parent&&!parent.isDestroyed()&&parent.isVisible()&&!parent.isMinimized())parent.webContents.focus();return true;}
      /** @param {Error} error */
      function fail(error){if(dispose()){picker.window.destroy();if(retained?.picker===picker)retained=null;reject(error);}}
      /** @param {Electron.Event} _event @param {string} _url @param {boolean} _inPlace @param {boolean} mainFrame */
      const navigate=(_event,_url,_inPlace,mainFrame)=>{if(mainFrame)cancel();};
      const state={picker,appearance:{preset:presentation?.preset??/** @type {const} */('industrial'),colors:presentation?.colors??{}},event,signal:controller.signal,cancel,finish,input,busy:false,requestId:++requestId,didPresent:()=>clearTimeout(timer)};active=state;
      const timeoutMs=input?120000:15000;const timer=setTimeout(()=>fail(new Error('Personal sticker picker did not become ready within '+timeoutMs+' ms')),timeoutMs);event.sender.once('destroyed',cancel);event.sender.on('did-start-navigation',navigate);event.sender.on('render-process-gone',cancel);parent.on('resize',cancel);parent.on('hide',cancel);parent.on('minimize',cancel);if(reused&&'resume' in picker)picker.resume();void picker.ready.catch(error=>{if(controller.signal.aborted)return;fail(new Error('Cannot load trusted personal sticker picker: '+(error instanceof Error?error.message:String(error)),{cause:error}));});
    });
  }
  register('stickers:choose',(event,value)=>request(event,null,parsePresentation(value)));
  register('stickers:switch-tab',async(event,value)=>{const state=trusted(event);if(state.input||value!=='server'&&value!=='unicode')throw new TypeError('Invalid personal sticker destination tab');state.finish({tab:value});});
  register('stickers:cancel-request',async event=>{options.assertOwner(event);if(active&&active.event.sender===event.sender&&active.event.senderFrame===event.senderFrame)active.cancel();});
  register('stickers:save',async(event,value)=>{options.assertOwner(event);if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.name!=='string'||!value.name.trim()||value.name.length>80||typeof value.data!=='string'||!value.data.length||value.data.length>Math.ceil(160*1024/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data))throw new TypeError('Save confirmation requires a name and bounded AVIF base64');return request(event,{name:value.name,data:value.data},null);});
  register('stickers:context',/** @returns {Promise<JsonValue>} */async event=>{const state=trusted(event);if(state.input)return {mode:'save',...state.input};return {mode:'choose',appearance:state.appearance,revision,requestId:state.requestId};});
  register('stickers:present',async(event,value)=>{const state=trusted(event);if(state.input||!('present' in state.picker))throw new Error('Only the embedded personal collection can announce presentation readiness');if(value!==state.requestId)throw new Error('Personal sticker presentation belongs to an expired request');state.picker.present();state.didPresent();});
  register('stickers:cancel',async event=>{trusted(event).cancel();});
  register('stickers:confirm',async(event,value)=>{const state=trusted(event);if(state.busy)throw new Error('Sticker selection is already being confirmed');state.busy=true;try{const storage=await store();trusted(event);if(state.input){await storage.add(state.input,state.signal);revision+=1;trusted(event);state.finish(true);}else{const id=identifier(value),snapshot=await storage.list(),item=snapshot.items.find(item=>item.id===id);if(!item)throw new RangeError('Selected personal sticker no longer exists');const data=await storage.read(item.sha256,state.signal);trusted(event);await storage.recordUse(id);revision+=1;trusted(event);state.finish({item,data});}}finally{state.busy=false;}});
  /** @template T @param {Electron.IpcMainInvokeEvent} event @param {(storage:Awaited<ReturnType<typeof createStickerStore>>,signal:AbortSignal)=>Promise<T>} operation @returns {Promise<T>} */
  function mutate(event,operation){return raw(event,async(storage,signal)=>{const result=await operation(storage,signal);revision+=1;return result;});}
  register('stickers:list',event=>raw(event,storage=>storage.list()));
  register('stickers:add',(event,value)=>mutate(event,(storage,signal)=>storage.add(value,signal)));
  register('stickers:remove',(event,value)=>mutate(event,storage=>storage.remove(identifier(value))));
  register('stickers:pin',(event,value)=>mutate(event,storage=>storage.pin(identifier(value))));
  register('stickers:use',(event,value)=>mutate(event,storage=>storage.recordUse(identifier(value))));
  register('stickers:preferences',(event,value)=>mutate(event,storage=>storage.setPreferences(value)));
  register('stickers:read',(event,value)=>raw(event,(storage,signal)=>storage.read(identifier(value),signal)));
  /** @returns {void} */
  function invalidateManagedPicker(){active?.cancel();if(retained){if(!retained.picker.window.isDestroyed())retained.picker.window.destroy();retained=null;}}
  /** @param {import('./sticker-store.cjs').StickerImport[]} inputs @param {AbortSignal} signal @returns {Promise<{items:import('./sticker-store.cjs').StickerItem[],addedIds:string[]}>} */
  async function importPack(inputs,signal){
    signal.throwIfAborted();invalidateManagedPicker();const storage=await store(),result=await storage.addBatch(inputs,signal);
    if(result.addedIds.length){revision+=1;invalidateManagedPicker();}return result;
  }
  /** @param {string[]} ids @returns {Promise<void>} */
  async function removePackItems(ids){
    invalidateManagedPicker();const storage=await store(),before=await storage.list();
    try{await storage.removeBatch(ids);}
    finally{if(!closed){const after=await storage.list(),remaining=new Set(after.items.map(entry=>entry.id));if(before.items.some(entry=>!remaining.has(entry.id))){revision+=1;invalidateManagedPicker();}}}
  }
  /** @returns {Promise<{items:import('./sticker-store.cjs').StickerItem[],preferences:import('./sticker-store.cjs').StickerPreferences}>} */
  async function listForResourceManager(){return (await store()).list();}
  /** @returns {Promise<void>} */
  async function destroy(){if(closed)return;active?.cancel();retained?.picker.window.destroy();retained=null;closed=true;for(const channel of channels)ipcMain.removeHandler(channel);try{if(storePromise){const storage=await storePromise;await storage.destroy();}}finally{options.validator.close();}}
  return {destroy,cancel:()=>active?.cancel(),importPack,removePackItems,listForResourceManager};
}
module.exports={registerPersonalStickerIpc};
