// @ts-check
'use strict';
const {BrowserWindow,session}=require('electron');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
/** @param {Electron.BrowserWindow} parent */
function createStickerPicker(parent){
  const page=pathToFileURL(path.join(__dirname,'sticker-picker.html')).href;
  const isolated=session.fromPartition('sticker-picker-'+require('node:crypto').randomUUID());
  const allowed=[page,...['sticker-picker.js','sticker-picker.css','app-server/public/app.css','app-server/public/interface.css'].map(name=>pathToFileURL(path.join(__dirname,name)).href)];
  const roots=['./app-server/public/js/','./app-server/public/vendor/avif/'].map(name=>pathToFileURL(path.join(__dirname,name)).href);
  isolated.webRequest.onBeforeRequest((request,done)=>done({cancel:!allowed.includes(request.url)&&!roots.some(root=>request.url.startsWith(root))}));
  isolated.setPermissionRequestHandler((_contents,_permission,respond)=>respond(false));
  isolated.setPermissionCheckHandler(()=>false);
  const window=new BrowserWindow({parent,modal:true,width:760,height:650,minWidth:540,minHeight:420,show:false,backgroundColor:'#151b1e',autoHideMenuBar:true,webPreferences:{session:isolated,preload:path.join(__dirname,'sticker-picker-preload.js'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,devTools:false}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  /** @param {Electron.IpcMainInvokeEvent} event @returns {void} */
  function assertCaller(event){if(window.isDestroyed()||event.sender!==window.webContents||!event.senderFrame||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==page)throw new Error('Personal library access requires the trusted local picker main frame');}
  const ready=window.loadURL(page).then(()=>{if(!window.isDestroyed())window.show();});
  return {window,assertCaller,ready};
}
module.exports={createStickerPicker};
