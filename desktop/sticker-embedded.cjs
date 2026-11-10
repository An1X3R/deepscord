// @ts-check
'use strict';
const {WebContentsView,session}=require('electron');
const {parseThemeColors}=require('./app-server/public/js/theme-colors.js');
const {randomUUID}=require('node:crypto');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
/** @typedef {{bounds:{x:number,y:number,width:number,height:number},preset:'industrial'|'constructivist',colors:Record<string,string>}} PickerPresentation */
/** @param {import('../public/js/network-protocol.js').JsonValue} input @returns {PickerPresentation} */
function parsePresentation(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('Personal sticker panel requires bounds and a preset');
  const bounds=input.bounds;
  if(!bounds||typeof bounds!=='object'||Array.isArray(bounds))throw new TypeError('Personal sticker panel bounds are missing');
  const coordinates=bounds;
  /** @param {string} key @returns {number} */
  function coordinate(key){const value=coordinates[key];if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>16384)throw new RangeError('Invalid personal sticker panel coordinate: '+key);return value;}
  if(input.preset!=='industrial'&&input.preset!=='constructivist')throw new TypeError('Invalid personal sticker panel preset');
  const rect={x:coordinate('x'),y:coordinate('y'),width:coordinate('width'),height:coordinate('height')};
  if(rect.width<100||rect.height<100)throw new RangeError('Personal sticker panel must be at least 100 pixels wide and high');
  return {bounds:rect,preset:input.preset,colors:parseThemeColors(input.colors??{})};
}
/** @param {Electron.BrowserWindow} parent @param {PickerPresentation} presentation */
function createEmbeddedStickerPicker(parent,presentation){
  const page=pathToFileURL(path.join(__dirname,'sticker-picker.html')).href;
  const isolated=session.fromPartition('sticker-inline-'+randomUUID());
  const allowed=['sticker-picker.html','sticker-picker.js','sticker-picker.css','app-server/public/app.css','app-server/public/interface.css'].map(name=>pathToFileURL(path.join(__dirname,name)).href);
  const roots=['app-server/public/js/','app-server/public/vendor/avif/'].map(name=>pathToFileURL(path.join(__dirname,name)).href);
  isolated.webRequest.onBeforeRequest((request,done)=>done({cancel:!allowed.includes(request.url)&&!roots.some(root=>request.url.startsWith(root))}));
  isolated.setPermissionRequestHandler((_contents,_permission,respond)=>respond(false));isolated.setPermissionCheckHandler(()=>false);
  const view=new WebContentsView({webPreferences:{session:isolated,preload:path.join(__dirname,'sticker-picker-preload.js'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,devTools:false,backgroundThrottling:false}});
  const contents=view.webContents;let initialized=false;
  /** @param {PickerPresentation} appearance @returns {void} */
  function prepare(appearance){
    const scale=parent.webContents.getZoomFactor(),extent=parent.getContentBounds(),bounds=appearance.bounds;
    const rectangle={x:Math.round(bounds.x*scale),y:Math.round(bounds.y*scale),width:Math.round(bounds.width*scale),height:Math.round(bounds.height*scale)};
    if(rectangle.x+rectangle.width>extent.width+1||rectangle.y+rectangle.height>extent.height+1)throw new RangeError('Personal sticker panel exceeds the client content bounds');
    contents.setBackgroundThrottling(false);view.setBounds(rectangle);
  }
  contents.setWindowOpenHandler(()=>({action:'deny'}));contents.on('will-navigate',event=>event.preventDefault());contents.on('will-attach-webview',event=>event.preventDefault());
  /** @returns {void} */
  function destroy(){if(contents.isDestroyed())return;if(!parent.isDestroyed())parent.contentView.removeChildView(view);contents.close();}
  parent.once('closed',destroy);contents.once('render-process-gone',destroy);
  contents.once('destroyed',()=>{parent.removeListener('closed',destroy);});
  /** @param {Electron.IpcMainInvokeEvent} event @returns {void} */
  function assertCaller(event){if(contents.isDestroyed()||event.sender!==contents||!event.senderFrame||event.senderFrame!==contents.mainFrame||event.senderFrame.url!==page)throw new Error('Personal library access requires the trusted embedded picker');}
  view.setVisible(false);parent.contentView.addChildView(view);try{prepare(presentation);}catch(error){destroy();throw error;}
  view.setBackgroundColor(presentation.preset==='constructivist'?'#e7e1d4':'#101319');
  const ready=contents.loadURL(page);
  /** @returns {void} */
  function present(){if(contents.isDestroyed())throw new Error('Personal sticker picker was closed before presentation');initialized=true;view.setVisible(true);contents.focus();}
  /** @returns {void} */
  function suspend(){if(contents.isDestroyed())return;view.setVisible(false);contents.send('stickers:suspend');contents.setBackgroundThrottling(true);}
  /** @returns {void} */
  function resume(){if(contents.isDestroyed())throw new Error('Personal sticker picker is unavailable');contents.send('stickers:resume');}
  return {window:{isDestroyed:()=>contents.isDestroyed(),destroy,once:/** @param {string} event @param {()=>void} listener */(event,listener)=>{if(event!=='closed')throw new TypeError('Unsupported embedded picker lifecycle event');contents.once('destroyed',listener);}},assertCaller,ready,present,prepare,suspend,resume,isReady:()=>initialized};
}
module.exports={parsePresentation,createEmbeddedStickerPicker};
