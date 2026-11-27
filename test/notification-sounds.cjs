// @ts-check
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
/** @param {number} seconds @returns {Buffer} */
function wave(seconds){const rate=16000,length=Math.round(seconds*rate),bytes=Buffer.alloc(44+length*2);bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(length*2,40);for(let index=0;index<length;index++)bytes.writeInt16LE(Math.round(Math.sin(index*2*Math.PI*440/rate)*4000),44+index*2);return bytes;}
/** @returns {Promise<void>} */
async function electronMain(){
  const {app,BrowserWindow}=require('electron');
  const output=process.env.NOTIFICATION_TEST_OUTPUT,origin=process.env.NOTIFICATION_TEST_ORIGIN;
  assert.ok(typeof output==='string'&&typeof origin==='string');app.setPath('userData',path.join(output,'profile'));app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');await app.whenReady();
  const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});window.webContents.setAudioMuted(true);window.webContents.debugger.attach('1.3');
  /** @param {string} expression @returns {Promise<object|string|boolean|null>} */
  const run=expression=>{return window.webContents.executeJavaScript(expression,true);};
  /** @param {string} filename @returns {Promise<object|string|boolean|null>} */
  async function choose(filename){
    const opened=new Promise(resolve=>window.webContents.debugger.once('message',(_event,method,params)=>{assert.equal(method,'Page.fileChooserOpened');resolve(params);}));
    await run("window.choice=sounds.choose('join').then(value=>({value}),error=>({error:error.message}));void 0");
    const params=await opened;await window.webContents.debugger.sendCommand('DOM.setFileInputFiles',{files:[filename],backendNodeId:params.backendNodeId});return run('window.choice');
  }
  async function load(){await window.loadURL(String(origin));await run("import('/notification-sounds.js').then(module=>{window.errors=[];window.sounds=module.createNotificationSounds({reportError:error=>errors.push(error.message)});})");}
  try{
    await load();await window.webContents.debugger.sendCommand('Page.enable');await window.webContents.debugger.sendCommand('Page.setInterceptFileChooserDialog',{enabled:true});
    assert.equal(await run("sounds.play('join',{volume:0.2,outputDeviceId:'default'})"),false);
    assert.deepEqual(await choose(path.join(String(output),'join.wav')),{value:'join.wav'});
    assert.equal(await run("sounds.play('join',{volume:0.2,outputDeviceId:'default'})"),true);
    assert.equal(await run("sounds.play('join',{volume:0.8,outputDeviceId:'default'})"),true);
    assert.deepEqual(await run("Promise.all([sounds.play('join',{volume:0.2,outputDeviceId:'default'}),sounds.play('join',{volume:0.2,outputDeviceId:'default'})])"),[true,true]);
    await run('sounds.destroy()');await load();
    assert.equal(await run("sounds.play('join',{volume:0.2,outputDeviceId:'default'})"),true);
    const overlong=await choose(path.join(String(output),'long.wav'));assert.ok(typeof overlong==='object'&&overlong!==null&&'error' in overlong);assert.match(String(overlong.error),/10 秒/);
    assert.equal(await run("sounds.play('join',{volume:0.2,outputDeviceId:'default'})"),true);
    await run("sounds.reset('join')");assert.equal(await run("sounds.play('join',{volume:0.2,outputDeviceId:'default'})"),false);
    await run('sounds.destroy()');await load();assert.equal(await run("sounds.play('join',{volume:0.2,outputDeviceId:'default'})"),false);
    assert.deepEqual(await run('errors'),[]);await run('sounds.destroy()');fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:true,electron:process.versions.electron,realPicker:true,realDecode:true,realPlaybackPromise:true,indexedDbPersistence:true,hardwareAudibilityVerified:false}));
  }finally{window.destroy();}app.exit(0);
}
/** @returns {Promise<void>} */
async function parentMain(){
  const output=fs.mkdtempSync(path.join(root,'.qa-tools','notification-sounds-'));fs.writeFileSync(path.join(String(output),'join.wav'),wave(0.2));fs.writeFileSync(path.join(String(output),'long.wav'),wave(11));
  const {createNotificationSoundStore}=require('../desktop/notification-sounds.cjs');const directory=path.join(output,'native-store'),record={name:'join.wav',data:wave(0.2).toString('base64')};
  let store=createNotificationSoundStore(directory);assert.equal(store.read('join'),null);store.save('join',record);store=createNotificationSoundStore(directory);assert.deepEqual(store.read('join'),record);assert.equal(store.read('leave'),null);store.reset('join');assert.equal(store.read('join'),null);
  const server=http.createServer((request,response)=>{if(request.url==='/notification-sounds.js'){response.writeHead(200,{'content-type':'text/javascript'});response.end(fs.readFileSync(path.join(root,'public/js/notification-sounds.js')));}else{response.writeHead(200,{'content-type':'text/html'});response.end('<!doctype html><title>Local notification integration</title>');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(undefined)));const address=server.address();assert.ok(address&&typeof address!=='string');
  /** @type {NodeJS.ProcessEnv} */
  const environment={...process.env,NOTIFICATION_TEST_ORIGIN:'http://127.0.0.1:'+address.port,NOTIFICATION_TEST_OUTPUT:output};delete environment.ELECTRON_RUN_AS_NODE;
  const child=spawn(path.join(root,'node_modules/electron/dist/electron.exe'),[__filename],{env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',data=>{log+=String(data);});child.stderr.on('data',data=>{log+=String(data);});
  try{const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('Notification audio integration exceeded 60 seconds'));},60000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);resolve(code);});});assert.equal(code,0,log);console.log(JSON.stringify({event:'notification-sounds-passed',output}));}finally{fs.writeFileSync(path.join(output,'electron.log'),log);server.closeAllConnections();await new Promise(resolve=>server.close(()=>resolve(undefined)));}
}
if(process.versions.electron)electronMain().catch(error=>{console.error(error);require('electron').app.exit(1);});else parentMain().catch(error=>{console.error(error);process.exitCode=1;});
