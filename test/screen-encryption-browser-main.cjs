// @ts-check
'use strict';
const {app,BrowserWindow}=require('electron');
const target=process.env.DEEPSCORD_SCREEN_ENCRYPTION_TEST_URL;
if(!target)throw new Error('DEEPSCORD_SCREEN_ENCRYPTION_TEST_URL is required');
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.commandLine.appendSwitch('disable-features','WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
app.whenReady().then(()=>{
  const window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  return window.loadURL(target);
}).catch(error=>{console.error(error);app.exit(1);});
app.on('window-all-closed',()=>app.quit());
