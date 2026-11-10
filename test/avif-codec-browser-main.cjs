// @ts-check
'use strict';
const {app,BrowserWindow}=require('electron');
const target=process.env.DEEPSCORD_AVIF_TEST_URL;
if(!target)throw new Error('DEEPSCORD_AVIF_TEST_URL is required');
app.whenReady().then(()=>{
  const window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});
  return window.loadURL(target);
}).catch(error=>{console.error(error);app.exit(1);});
app.on('window-all-closed',()=>app.quit());
