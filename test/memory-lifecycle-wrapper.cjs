// @ts-check
'use strict';
const {app,BrowserWindow,WebContentsView}=require('electron');
const http=require('node:http');
const path=require('node:path');
const target=process.env.DEEPSCORD_MEMORY_APP;
const port=Number(process.env.DEEPSCORD_MEMORY_CONTROL_PORT);
if(!target || !Number.isInteger(port) || port<1) throw new TypeError('Memory benchmark requires an app directory and control port');
app.setName('Deepscord');
/** @type {typeof import('../desktop/poke-request.cjs')} */const poke=require(path.join(target,'poke-request.cjs'));
/** @returns {Electron.WebContentsView} */
function privateView(){
  const room=BrowserWindow.getAllWindows().find(window=>/^https?:/.test(window.webContents.getURL()));
  if(!room) throw new Error('Private view control requires the actual room owner');
  const view=room.contentView.children.find(child=>child instanceof WebContentsView&&child.webContents.getURL().endsWith('/sticker-picker.html'));
  if(!(view instanceof WebContentsView)) throw new Error('Private WebContentsView is missing');
  return view;
}
const service=http.createServer(async (request,response)=>{
  if(request.url==='/hide') {for(const window of BrowserWindow.getAllWindows()) window.hide();privateView().webContents.setBackgroundThrottling(true);}
  else if(request.url==='/show') {const window=BrowserWindow.getAllWindows().find(item=>/^https?:/.test(item.webContents.getURL()));if(!window) throw new Error('Room benchmark window missing');window.show();window.focus();}
  else if(request.url==='/release-room') for(const window of BrowserWindow.getAllWindows()) {if(/^https?:/.test(window.webContents.getURL())) window.destroy();}
  else if(request.url==='/popup-show' || request.url==='/popup-clear') {
    const room=BrowserWindow.getAllWindows().find(window=>/^https?:/.test(window.webContents.getURL()));
    if(!room) throw new Error('Controlled popup input requires the actual room owner');
    const requests=request.url==='/popup-show'?[{userId:'benchmark_component_input',requestId:'benchmark_request_1',name:'Controlled memory benchmark'}]:[];
    const state=poke.parseRequestState({sessionId:'benchmark_component_session',requests,canApprove:false});
    await poke.updatePokeRequests(room.webContents,state,null);
  }
  else if(request.url==='/diagnostic-unthrottle-private') {
    if(process.env.DEEPSCORD_MEMORY_DIAGNOSTIC!=='native-visibility') throw new Error('Private view throttling override is disabled outside explicit diagnostic runs');
    privateView().webContents.setBackgroundThrottling(false);
  }
  else if(request.url==='/private-foreground') privateView().webContents.setBackgroundThrottling(false);
  else if(request.url==='/private-background') privateView().webContents.setBackgroundThrottling(true);
  else if(request.url!=='/metrics') {response.writeHead(404);response.end();return;}
  response.setHeader('content-type','application/json');
  response.end(JSON.stringify({pid:process.pid,userData:app.getPath('userData'),electron:process.versions.electron,metrics:app.getAppMetrics(),windows:BrowserWindow.getAllWindows().map(window=>({id:window.id,url:window.webContents.getURL(),visible:window.isVisible(),focused:window.isFocused(),minimized:window.isMinimized(),contentsFocused:window.webContents.isFocused(),backgroundThrottling:window.webContents.getBackgroundThrottling(),childViews:window.contentView.children.map(view=>({constructor:view.constructor.name,visible:view.getVisible(),bounds:view.getBounds(),contents:view instanceof WebContentsView?{url:view.webContents.getURL(),focused:view.webContents.isFocused(),backgroundThrottling:view.webContents.getBackgroundThrottling()}:null}))}))}));
});
app.whenReady().then(()=>service.listen(port,'127.0.0.1'));
app.on('will-quit',()=>service.close());
require(path.join(target,'main.js'));
