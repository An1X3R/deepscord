// @ts-check
'use strict';
const {BrowserWindow,ipcMain,session}=require('electron');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {randomUUID}=require('node:crypto');
/** @typedef {{title:string,message:string,details:{label:string,value:string}[],acceptLabel:string}} ConsentDetails */
/** @typedef {{window:Electron.BrowserWindow,details:ConsentDetails,finish:(accepted:boolean)=>void}} PendingConsent */
/** @param {{getWindow:()=>Electron.BrowserWindow|null,timeoutMs:number}} options */
function createDesktopConsent(options){
  const filename=path.join(__dirname,'desktop-consent.html'),url=pathToFileURL(filename).href;
  const allowed=new Set(['desktop-consent.html','desktop-consent.css','desktop-consent.js'].map(name=>pathToFileURL(path.join(__dirname,name)).href));
  /** @type {PendingConsent|null} */let pending=null;
  let destroyed=false;
  /** @param {Electron.IpcMainInvokeEvent} event @returns {PendingConsent} */
  function owner(event){const current=pending;if(!current || event.sender!==current.window.webContents || event.senderFrame!==current.window.webContents.mainFrame || event.senderFrame.url!==url)throw new Error('Desktop consent is restricted to its local confirmation window');return current;}
  ipcMain.handle('desktop-consent:read',event=>owner(event).details);
  ipcMain.handle('desktop-consent:respond',(event,value)=>{const current=owner(event);if(value!=='accept' && value!=='deny')throw new TypeError('Consent response must be accept or deny');current.finish(value==='accept');});
  /** @param {ConsentDetails} details @param {AbortSignal} signal @returns {Promise<boolean>} */
  function confirm(details,signal){
    if(destroyed)return Promise.reject(new Error('Desktop confirmation service has closed'));
    signal.throwIfAborted();
    if(pending)return Promise.reject(new Error('Another desktop confirmation is already open'));
    if(!details.title || details.title.length>100 || !details.message || details.message.length>1000 || !details.acceptLabel || details.acceptLabel.length>50 || details.details.length>12 || details.details.some(row=>!row.label || row.label.length>80 || !row.value || row.value.length>8192))throw new TypeError('Desktop confirmation exceeds its display limits');
    const parent=options.getWindow();
    if(!parent || parent.isDestroyed())return Promise.reject(new Error('Desktop confirmation requires an active application window'));
    const ownerWindow=parent;
    const privateSession=session.fromPartition('consent-'+randomUUID());
    privateSession.setPermissionCheckHandler(()=>false);privateSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    privateSession.webRequest.onBeforeRequest({urls:['<all_urls>']},(request,callback)=>callback({cancel:!allowed.has(request.url)}));
    const child=new BrowserWindow({parent,modal:true,width:620,height:600,minWidth:520,minHeight:450,show:false,resizable:true,autoHideMenuBar:true,title:'Deepscord · 本机确认',backgroundColor:'#15191b',webPreferences:{preload:path.join(__dirname,'desktop-consent-preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,session:privateSession}});
    child.webContents.setWindowOpenHandler(()=>({action:'deny'}));child.webContents.on('will-navigate',event=>event.preventDefault());
    return new Promise((resolve,reject)=>{
      let settled=false;
      /** @returns {void} */function cleanup(){clearTimeout(timer);signal.removeEventListener('abort',cancel);ownerWindow.webContents.removeListener('did-start-navigation',navigate);ownerWindow.removeListener('closed',cancel);if(pending?.window===child)pending=null;if(!child.isDestroyed())child.destroy();}
      /** @param {boolean} accepted @returns {void} */function finish(accepted){if(settled)return;settled=true;cleanup();resolve(accepted);}
      /** @returns {void} */function cancel(){finish(false);}
      /** @param {Electron.Event} event @param {string} address @param {boolean} inPlace @param {boolean} mainFrame @returns {void} */function navigate(event,address,inPlace,mainFrame){if(mainFrame&&!inPlace)cancel();}
      const timer=setTimeout(()=>{if(settled)return;settled=true;cleanup();reject(new Error('Desktop confirmation expired without a user decision'));},options.timeoutMs);
      pending={window:child,details:structuredClone(details),finish};
      signal.addEventListener('abort',cancel,{once:true});parent.webContents.on('did-start-navigation',navigate);parent.once('closed',cancel);child.once('closed',cancel);
      child.once('ready-to-show',()=>{if(!child.isDestroyed())child.show();});
      child.loadFile(filename).catch(error=>{if(settled)return;settled=true;cleanup();reject(error);});
    });
  }
  /** @returns {void} */function destroy(){if(destroyed)return;destroyed=true;pending?.finish(false);ipcMain.removeHandler('desktop-consent:read');ipcMain.removeHandler('desktop-consent:respond');}
  return{confirm,destroy};
}
module.exports={createDesktopConsent};
