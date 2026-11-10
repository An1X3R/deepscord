// @ts-check
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const root = path.resolve(__dirname,'..');
/** @returns {Promise<void>} */
async function runNative() {
  const {app,BrowserWindow} = require('electron');
  app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
  app.setPath('userData',path.join(root,'.qa-tools','radio-player-profile'));
  await app.whenReady();
  const sound = fs.readFileSync(path.join(root,'public','assets','interactions','bomb-1.mp3'));
  /** @type {Buffer|null} */ let aac = null;
  if (process.env.RADIO_REMOTE_TEST === '1') {
    const response = await fetch('https://radiorecord.hostingradio.ru/synth96.aacp',{signal:AbortSignal.timeout(15000)});
    if(!response.ok || !response.body)throw new Error('Cannot acquire real bounded AAC HLS fixture; status='+response.status);
    const reader=response.body.getReader();
    /** @type {Uint8Array[]} */ const chunks=[];let size=0;
    try {while(size<65536){const part=await reader.read();if(part.done)throw new Error('AAC fixture source ended early');chunks.push(part.value);size+=part.value.length;}}
    finally {await reader.cancel();}
    aac=Buffer.concat(chunks);
  }
  let hlsRequests = 0;
  const fixture = http.createServer((request,response)=>{
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname === '/live.m3u8') {response.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl','Access-Control-Allow-Origin':'*'});response.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:6,\n/audio.aac\n#EXT-X-ENDLIST\n');return;}
    if (url.pathname === '/audio.aac' && aac) {response.writeHead(200,{'Content-Type':'audio/aac','Access-Control-Allow-Origin':'*'});response.end(aac);return;}
    if (url.pathname === '/audio.mp3') {response.writeHead(200,{'Content-Type':'audio/mpeg','Access-Control-Allow-Origin':'*'});response.end(sound);return;}
    const files = new Map([
      ['/test/radio-playback-page.html','text/html'],['/test/radio-playback-page.js','text/javascript'],
      ['/public/js/radio-player.js','text/javascript'],['/public/vendor/hls/hls.mjs','text/javascript'],
      ['/public/index.html','text/html'],
    ]);
    for(const name of ['radio-client','radio-ui','radio-protocol','chat-protocol','content-protocol','network-protocol'])files.set('/public/js/'+name+'.js','text/javascript');
    const type=files.get(url.pathname);
    if (!type) {response.writeHead(404);response.end();return;}
    if (url.pathname === '/public/vendor/hls/hls.mjs') hlsRequests += 1;
    response.writeHead(200,{'Content-Type':type});response.end(fs.readFileSync(path.join(root,url.pathname)));
  });
  fixture.listen(0,'127.0.0.1');await once(fixture,'listening');
  const endpoint=fixture.address();if(!endpoint || typeof endpoint==='string')throw new Error('Fixture did not bind TCP');
  const base='http://127.0.0.1:'+endpoint.port;
  const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  win.webContents.setAudioMuted(true);
  try {
    await win.loadURL(base+'/test/radio-playback-page.html');
    /** @type {object[]} */ const report=[];
    const urls=[base+'/audio.mp3'];
    if (process.env.RADIO_REMOTE_TEST === '1') urls.push(base+'/live.m3u8','https://streampusher-relay.club/datafruits.mp3','https://radiorecord.hostingradio.ru/teo96.aacp','https://radiorecord.hostingradio.ru/synth96.aacp');
    for(const url of urls) {
      report.push(await win.webContents.executeJavaScript('radioPlaybackTest.play('+JSON.stringify(url)+')',true));
      if(url===base+'/audio.mp3' && hlsRequests!==0)throw new Error('Direct audio eagerly loaded the HLS parser');
    }
    const localVolume=await win.webContents.executeJavaScript('radioPlaybackTest.localVolume('+JSON.stringify(base+'/audio.mp3')+')',true);
    report.push({localVolume});
    await win.webContents.executeJavaScript('radioPlaybackTest.close()',true);
    const filename=path.join(root,'.qa-tools',process.env.RADIO_REMOTE_TEST === '1' ? 'radio-playback-remote-report.json' : 'radio-playback-report.json');
    fs.writeFileSync(filename,JSON.stringify({electron:process.versions.electron,report,hardwareAudibilityVerified:false},null,2));
    console.log(JSON.stringify({passed:true,filename,report}));
  } finally {win.destroy();fixture.closeAllConnections();fixture.close();}
  app.exit(0);
}
/** @returns {Promise<void>} */
async function runParent() {
  const source=path.join(root,'node_modules','electron','dist');
  const runtime=path.join(root,'.qa-tools','radio-player-runtime');
  const marker=path.join(runtime,'.radio-player-owner');
  if (!fs.existsSync(runtime)) {
    fs.cpSync(source,runtime,{recursive:true,filter:filename=>filename!==path.join(source,'resources','default_app.asar')});
    fs.writeFileSync(marker,__filename,{flag:'wx'});
  } else if(fs.readFileSync(marker,'utf8')!==__filename)throw new Error('Radio test runtime ownership mismatch');
  const entry=path.join(runtime,'resources','app');fs.mkdirSync(entry,{recursive:true});
  fs.writeFileSync(path.join(entry,'package.json'),JSON.stringify({name:'radio-playback-test',version:'1.0.0',main:'main.cjs'}));
  fs.writeFileSync(path.join(entry,'main.cjs'),'require('+JSON.stringify(__filename)+');');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(path.join(runtime,'electron.exe'),[],{env,windowsHide:true,stdio:'inherit'});
  const timer=setTimeout(()=>child.kill(),120000);
  try {const [code]=await once(child,'exit');if(code!==0)throw new Error('Radio playback test exited with code '+code);}
  finally {clearTimeout(timer);}
}
if(process.versions.electron)runNative().catch(error=>{console.error(error);require('electron').app.exit(1);});
else runParent().catch(error=>{console.error(error);process.exitCode=1;});
