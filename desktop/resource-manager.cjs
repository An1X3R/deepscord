// @ts-check
'use strict';
const {BrowserWindow,ipcMain,dialog,shell}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {extractResourceArchive}=require('./resource-archive.cjs');
const {resourcePackId}=require('./app-server/public/js/resource-pack.js');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{id:string,name:string}} CurrentServer */
/** @typedef {{root:string,store:ReturnType<typeof import('./resource-pack-store.cjs').createResourcePackStore>,getParent:()=>Electron.BrowserWindow|null,getCurrentServer:()=>CurrentServer|null}} ManagerOptions */

/** @param {string} directory @returns {void} */
function realDirectory(directory){const parent=path.dirname(directory);if(parent!==directory)realDirectory(parent);const info=fs.lstatSync(directory,{throwIfNoEntry:false});if(info&&(info.isSymbolicLink()||!info.isDirectory()))throw new TypeError('Resource directory must be a real directory: '+directory);}
/** @param {string} root @param {string} directory @returns {void} */
function removeImport(root,directory){
  const parent=path.join(root,'.imports'),resolved=path.resolve(directory);
  if(path.dirname(resolved)!==parent||!path.basename(resolved).startsWith('install-'))throw new TypeError('Import cleanup path is outside its owned directory: '+resolved);
  realDirectory(resolved);fs.rmSync(resolved,{recursive:true});
}
/** @param {ManagerOptions} options */
function createResourceManager(options){
  const root=path.resolve(options.root),url=pathToFileURL(path.join(__dirname,'resource-manager.html')).href;
  /** @type {Electron.BrowserWindow|null} */let window=null;
  /** @type {Promise<void>|null} */let opening=null;
  /** @type {Set<Promise<void>>} */const pending=new Set();
  const lifetime=new AbortController();let modifying=false;
  /** @param {Electron.IpcMainInvokeEvent} event @returns {void} */
  function assertSender(event){if(!window||window.isDestroyed()||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==url)throw new Error('Resource management requires its local desktop window');lifetime.signal.throwIfAborted();}
  /** @template T @param {()=>Promise<T>} operation @returns {Promise<T>} */
  function track(operation){const result=operation(),settled=result.then(()=>{},()=>{});pending.add(settled);void settled.then(()=>pending.delete(settled));return result;}
  /** @template T @param {()=>Promise<T>} operation @returns {Promise<T>} */
  async function change(operation){if(modifying)throw new Error('Another resource installation or removal is still running');modifying=true;try{return await operation();}finally{modifying=false;}}
  /** @returns {Promise<import('./resource-manager.js').ResourceState>} */
  async function state(){const inventory=await options.store.list();return {root,currentServer:options.getCurrentServer(),...inventory};}
  /** @returns {Electron.BrowserWindow} */
  function owner(){if(!window||window.isDestroyed())throw new Error('Resource management window is closed');return window;}
  /** @param {CurrentServer|null} selected @returns {void} */
  function sameServer(selected){if(selected?.id!==options.getCurrentServer()?.id)throw new Error('当前服务器已切换，请重新选择资源包');}
  /** @param {string} directory @param {CurrentServer|null} server @returns {Promise<void>} */
  async function install(directory,server){sameServer(server);await options.store.install(directory,null,lifetime.signal);}
  /** @returns {Promise<import('./resource-manager.js').ResourceState|null>} */
  async function installDirectory(){
    const server=options.getCurrentServer(),selection=await dialog.showOpenDialog(owner(),{title:'安装资源包文件夹',properties:['openDirectory']});
    if(selection.canceled)return null;if(selection.filePaths.length!==1)throw new Error('请选择一个包含 pack.json 的资源包文件夹');
    await install(selection.filePaths[0],server);return state();
  }
  /** @returns {Promise<import('./resource-manager.js').ResourceState|null>} */
  async function installArchive(){
    const server=options.getCurrentServer(),selection=await dialog.showOpenDialog(owner(),{title:'安装资源 ZIP 包',properties:['openFile'],filters:[{name:'Deepscord 资源包',extensions:['zip']}]});
    if(selection.canceled)return null;if(selection.filePaths.length!==1)throw new Error('请选择一个资源 ZIP 包');
    sameServer(server);const parent=path.join(root,'.imports');realDirectory(parent);fs.mkdirSync(parent,{recursive:true});
    const staging=path.join(parent,'install-'+randomUUID());fs.mkdirSync(staging);
    /** @type {Error|null} */let failure=null;
    try{await extractResourceArchive({archive:selection.filePaths[0],destination:staging,signal:lifetime.signal});await install(staging,server);}
    catch(error){failure=error instanceof Error?error:new Error(String(error));throw error;}
    finally{try{removeImport(root,staging);}catch(cleanup){if(failure)throw new AggregateError([failure,cleanup],'Resource installation failed and its temporary directory could not be removed');throw cleanup;}}
    return state();
  }
  /** @param {string} directory @returns {Promise<void>} */
  async function openDirectory(directory){realDirectory(directory);const error=await shell.openPath(directory);if(error)throw new Error('Cannot open resource directory '+directory+': '+error);}
  /** @param {JsonValue|undefined} input @returns {string} */
  function id(input){return resourcePackId(input);}
  /** @type {Record<string,(input:JsonValue|undefined)=>Promise<object|void|null>>} */
  const handlers={
    state:()=>state(),
    'install-archive':()=>change(installArchive),
    'install-directory':()=>change(installDirectory),
    remove:input=>change(async()=>{await options.store.remove(id(input));return state();}),
    'bind-server':input=>change(async()=>{const server=options.getCurrentServer();if(!server)throw new Error('请先连接要使用互动表情的服务器');await options.store.bindServer(id(input),server.id);return state();}),
    'open-root':()=>openDirectory(root),
    'open-pack':async input=>openDirectory(await options.store.packDirectory(id(input))),
  };
  for(const [name,handler] of Object.entries(handlers))ipcMain.handle('resource-manager:'+name,(event,input)=>{assertSender(event);return track(()=>handler(input));});
  /** @returns {Promise<void>} */
  async function open(){
    lifetime.signal.throwIfAborted();if(opening)return opening;
    if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();return;}
    const parent=options.getParent(),created=new BrowserWindow({width:940,height:780,minWidth:700,minHeight:480,show:false,backgroundColor:'#111619',...(parent?{parent}:{}),webPreferences:{preload:path.join(__dirname,'resource-manager-preload.js'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
    window=created;created.setMenu(null);created.webContents.setWindowOpenHandler(()=>({action:'deny'}));created.webContents.on('will-navigate',event=>event.preventDefault());
    created.once('closed',()=>{if(window===created)window=null;});
    opening=created.loadURL(url).then(()=>{if(!created.isDestroyed())created.show();}).catch(error=>{if(!created.isDestroyed())created.destroy();throw error;}).finally(()=>{opening=null;});
    return opening;
  }
  /** @returns {Promise<void>} */
  async function destroy(){lifetime.abort(new Error('Application is closing'));if(window&&!window.isDestroyed())window.destroy();await Promise.all([...pending]);for(const name of Object.keys(handlers))ipcMain.removeHandler('resource-manager:'+name);}
  return {open,destroy};
}
module.exports={createResourceManager};
