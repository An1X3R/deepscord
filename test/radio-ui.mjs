// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {connectPage,waitForPort} from './cdp.mjs';

/** @typedef {Awaited<ReturnType<typeof connectPage>>} Page */
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
const root=fileURLToPath(new URL('../',import.meta.url));
const packageDirectory=path.resolve(root,process.env.DEEPSCORD_RADIO_UI_PACKAGE || 'dist/radio-roles-20261108-05/Deepscord-win32-x64');
const bundledApp=path.join(packageDirectory,'resources','app');
const protectedFiles=['Deepscord.exe','resources/app/main.js','resources/app/client-preferences.cjs','resources/app/preload.js',...['index.html','radio.css','js/app.js','js/radio-client.js','js/radio-player.js','js/radio-ui.js','js/settings.js'].map(name=>'resources/app/app-server/public/'+name)];
/** @returns {Record<string,string>} */
function packageHashes(){return Object.fromEntries(protectedFiles.map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(packageDirectory,name))).digest('hex')]));}
const initialPackageHashes=packageHashes();
const output=fs.mkdtempSync(path.join(root,'.qa-tools','radio-ui-'));
/** @type {import('node:child_process').ChildProcess[]} */ const children=[];
/** @type {{page:Page,debug:number,child:import('node:child_process').ChildProcess}[]} */ const clients=[];
/** @type {string[]} */ const checks=[];
/** @type {string[]} */ const errors=[];
/** @type {string[]} */ const headerLeaks=[];
/** @type {{id:string,title:string}[]} */ const remoteStations=[];
/** @type {Record<string,string>} */ const logs={};
/** @param {number} ms @returns {Promise<void>} */
function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
/** @param {string} label @param {boolean} result @returns {void} */
function check(label,result){assert(result,label);checks.push(label);}
/** @returns {Promise<number>} */
async function freePort(){const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address==='object');server.close();await once(server,'close');return address.port;}
/** @param {string} name @param {string} binary @param {string[]} args @param {string} cwd @param {NodeJS.ProcessEnv} env */
function launch(name,binary,args,cwd,env){const child=spawn(binary,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);logs[name]='';child.stdout?.on('data',part=>{logs[name]+=String(part);});child.stderr?.on('data',part=>{logs[name]+=String(part);});return child;}
/** @param {import('node:child_process').ChildProcess} child @returns {Promise<void>} */
async function stop(child){
  if(child.exitCode!==null||child.signalCode!==null)return;
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Owned radio UI client failed to exit')),10000);
    child.once('exit',()=>{clearTimeout(timer);resolve(undefined);});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    assert(child.kill());
  });
}
/** @param {Page} page @param {string} expression @param {string} label @returns {Promise<void>} */
async function wait(page,expression,label){await page.waitFor(expression,{timeout:15000,interval:50,label});}
/** @param {Page} page @param {string} id @returns {Promise<void>} */
async function click(page,id){await page.eval(`document.getElementById(${JSON.stringify(id)}).click()`,{awaitPromise:true,userGesture:true});}
/** @param {Page} page @param {string} id @param {string} value @returns {Promise<void>} */
async function fill(page,id,value){await page.eval(`(()=>{const input=document.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`);}
/** @param {number} debug @returns {Promise<Page>} */
async function roomPage(debug){const deadline=Date.now()+15000;while(Date.now()<deadline){const targets=await fetch(`http://127.0.0.1:${debug}/json/list`).then(r=>r.json());const target=targets.find(/** @param {{url:string,type:string}} row */row=>row.type==='page'&&row.url.startsWith('http://127.0.0.1:'));if(target)return connectPage(debug,target.url);await delay(50);}throw new Error('Actual room page did not appear');}
/** @param {{page:Page,debug:number}} client @param {string} channelId @returns {Promise<void>} */
async function join(client,channelId){
  await client.page.eval(`void window.echo.actions.enterChannel(${JSON.stringify(channelId)})`,{awaitPromise:false,userGesture:true});
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){
    if(await client.page.eval('window.echo.getVoiceStats()?.micReady===true'))break;
    const targets=await fetch(`http://127.0.0.1:${client.debug}/json/list`).then(r=>r.json());
    const target=targets.find(/** @param {{url:string}} row */row=>row.url.endsWith('/desktop-consent.html'));
    if(target){const consent=await connectPage(client.debug,target.url);await wait(consent,"!!document.getElementById('consentAccept')&&!document.getElementById('consentAccept').disabled",'actual microphone consent');await click(consent,'consentAccept');consent.close();break;}
    await delay(50);
  }
  await wait(client.page,`window.echo.getState().voiceChannelId===${JSON.stringify(channelId)}&&window.echo.getVoiceStats().micReady`,'real microphone joins radio');
}

const aacFile=path.resolve(root,process.env.RADIO_UI_AAC_FIXTURE || '.qa-tools/radio-fixture.aac');
assert(fs.existsSync(aacFile),'Provide RADIO_UI_AAC_FIXTURE with a real bounded AAC ADTS recording');
const capture=fs.readFileSync(aacFile);
/** @type {Buffer[]} */ const frames=[];
for(let offset=0;offset+7<capture.length;){
  if(capture[offset]!==255 || (capture[offset+1]&246)!==240){offset+=1;continue;}
  const length=((capture[offset+3]&3)<<11)|(capture[offset+4]<<3)|(capture[offset+5]>>5);
  if(length<7 || offset+length>capture.length){offset+=1;continue;}
  frames.push(capture.subarray(offset,offset+length));offset+=length;
}
assert(frames.length>10,'AAC fixture must contain complete real ADTS frames');
const sound=Buffer.concat(frames);
let activeStreams=0;
const fixture=http.createServer((request,response)=>{
  for(const header of ['cookie','authorization','proxy-authorization','referer'])if(request.headers[header]!==undefined)headerLeaks.push(header+':'+request.url);
  response.setHeader('Set-Cookie','radio-ui-private=must-not-leak; Path=/; SameSite=Lax');
  if(request.url==='/live.m3u8'){response.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl','Access-Control-Allow-Origin':'*'});response.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:6,\n/segment.aac\n#EXT-X-ENDLIST\n');return;}
  if(request.url==='/segment.aac'){response.writeHead(200,{'Content-Type':'audio/aac','Access-Control-Allow-Origin':'*'});response.end(sound);return;}
  if(!['/one.aac','/two.aac'].includes(request.url || '')){response.writeHead(404);response.end();return;}
  activeStreams+=1;
  const metadata=request.headers['icy-metadata']==='1';
  let offset=0,untilMetadata=8192,sent=0;
  const text=Buffer.from("StreamTitle='Radio UI integration song - this deliberately long real ICY track title verifies the persistent scrolling information strip while a different text channel is selected';");
  const block=Buffer.alloc(Math.ceil(text.length/16)*16);text.copy(block);
  const total=sound.length*100;
  response.writeHead(200,{'Content-Type':'audio/aac','Access-Control-Allow-Origin':'*','icy-name':request.url==='/one.aac'?'Local One':'Local Two',...(metadata?{'icy-metaint':'8192'}:{})});response.flushHeaders();
  const timer=setInterval(()=>{
    let remaining=Math.min(6000,total-sent);
    while(remaining>0){const size=Math.min(remaining,sound.length-offset,metadata?untilMetadata:remaining);response.write(sound.subarray(offset,offset+size));offset=(offset+size)%sound.length;remaining-=size;sent+=size;if(metadata){untilMetadata-=size;if(untilMetadata===0){response.write(Buffer.concat([Buffer.from([block.length/16]),block]));untilMetadata=8192;}}}
    if(sent===total){clearInterval(timer);response.end();}
  },100);
  response.on('close',()=>{clearInterval(timer);activeStreams-=1;});
});
fixture.listen(0,'127.0.0.1');await once(fixture,'listening');
const fixtureAddress=fixture.address();assert(fixtureAddress&&typeof fixtureAddress==='object');
const streamBase=`http://127.0.0.1:${fixtureAddress.port}`;
const port=await freePort(),origin=`http://127.0.0.1:${port}/`;
let passed=false;
try{
  launch('server',process.execPath,[path.join(bundledApp,'app-server/server.js')],path.join(bundledApp,'app-server'),{...process.env,PORT:String(port),HTTP_HOST:'127.0.0.1',HTTPS_PORTS:'0',ECHO_DATA_DIR:path.join(output,'server-data'),ECHO_MEDIA_POLICY:'direct',ECHO_NETWORK_MODE:'server',ECHO_PASSWORD:''});
  const deadline=Date.now()+12000;let ready=false;
  while(Date.now()<deadline){try{ready=(await fetch(origin+'api/health')).ok;}catch(error){if(!(error instanceof TypeError))throw error;}if(ready)break;await delay(100);}assert(ready,logs.server);
  for(const index of [0,1]){
    const debug=await freePort(),profile=path.join(output,'profile-'+index);fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile,'config.json'),JSON.stringify({autoConnect:false}));
    fs.writeFileSync(path.join(profile,'desktop-settings.json'),JSON.stringify({muteShortcut:`Control+Alt+Shift+F${index+22}`,overlay:{enabled:false,locked:true,x:24,y:80,width:280,height:300,scale:1}}));
    /** @type {NodeJS.ProcessEnv} */const env={...process.env,DEEPSCORD_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
    const child=launch('client-'+index,path.join(packageDirectory,'Deepscord.exe'),[`--remote-debugging-port=${debug}`,'--mute-audio','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'],packageDirectory,env);
    await waitForPort(debug,20000);
    const workspace=await connectPage(debug,pathToFileURL(path.join(bundledApp,'workspace.html')).href);
    await wait(workspace,"!!document.getElementById('savedRoomList')&&!!window.deepscord?.connect",'desktop workspace bridge ready');
    await workspace.eval(`void window.deepscord.connect(${JSON.stringify(origin)})`,{awaitPromise:false,userGesture:true});workspace.close();
    const page=await roomPage(debug);clients.push({page,debug,child});
    await page.send('Runtime.enable',{});page.on('Runtime.exceptionThrown',/** @param {JsonValue} event */event=>errors.push(JSON.stringify(event)));
    page.on('Runtime.consoleAPICalled',/** @param {JsonValue} event */event=>{logs['console-'+index]=(logs['console-'+index] || '')+JSON.stringify(event)+'\n';});
    await page.send('Network.enable',{});page.on('Network.loadingFailed',/** @param {JsonValue} event */event=>{logs['network-'+index]=(logs['network-'+index] || '')+JSON.stringify(event)+'\n';});
    page.on('Network.requestWillBeSent',/** @param {JsonValue} event */event=>{if(event&&typeof event==='object'&&!Array.isArray(event)&&event.type==='Media')logs['media-'+index]=(logs['media-'+index] || '')+JSON.stringify(event)+'\n';});
    await page.send('Emulation.setFocusEmulationEnabled',{enabled:true});
    await wait(page,"!!document.getElementById('welcomeNameInput')",'actual welcome form');
    await fill(page,'welcomeNameInput','Radio UI '+index);await click(page,'welcomeEnterBtn');
    await wait(page,'window.echo?.getState().roomReady===true&&!!window.echo.getState().selfKey','authenticated room identity');
  }
  const actor=clients[0].page,target=clients[1].page;
  const claim=fs.readFileSync(path.join(output,'server-data/owner-claim.txt'),'utf8').trim();
  await click(actor,'serverMenuBtn');await click(actor,'serverGovernanceMenuBtn');await wait(actor,"!!document.getElementById('ownerClaimToken')",'owner claim');await fill(actor,'ownerClaimToken',claim);await click(actor,'claimOwnerBtn');await wait(actor,'window.echo.getState().selfKey===window.echo.getState().ownerKey','real owner claim');await wait(actor,"!document.getElementById('ownerClaimToken')",'owner panel closes');
  await click(actor,'serverMenuBtn');await click(actor,'createRadioMenuBtn');await wait(actor,"!!document.getElementById('createRadioPreset')",'radio create form');
  check('custom-radio-option-label',await actor.eval("document.getElementById('createRadioPreset').querySelector('option[value=custom]').textContent==='自定义电台'"));
  check('three-real-presets-in-create-form',await actor.eval("['datafruits','teodor','synthwave'].every(value=>[...document.getElementById('createRadioPreset').options].some(option=>option.value===value))"));
  await fill(actor,'createChannelName','Preset radio');await fill(actor,'createRadioPreset','datafruits');await click(actor,'createChannelSubmit');
  await wait(actor,"!document.getElementById('createChannelSubmit')",'preset creation dialog finishes closing');
  await wait(actor,"window.echo.getState().servers.flatMap(server=>server.channels).some(channel=>channel.type==='radio'&&channel.name==='Preset radio'&&channel.radio.stations.length===3)",'saved three-preset channel');checks.push('preset-creation-persists-three-stations');
  await click(actor,'serverMenuBtn');await click(actor,'createRadioMenuBtn');await wait(actor,"!!document.getElementById('createRadioPreset')",'manual create form');await fill(actor,'createRadioPreset','custom');await fill(actor,'createChannelName','Local radio');await fill(actor,'createRadioName','Local saved one');await fill(actor,'createRadioUrl',streamBase+'/one.aac');await click(actor,'createChannelSubmit');
  await wait(actor,"!document.getElementById('createChannelSubmit')",'manual creation dialog finishes closing');
  await wait(actor,"window.echo.getState().servers.flatMap(server=>server.channels).some(channel=>channel.name==='Local radio'&&channel.type==='radio')",'manual station saved');
  const channelId=await actor.eval("window.echo.getState().servers.flatMap(server=>server.channels).find(channel=>channel.name==='Local radio').id");assert.equal(typeof channelId,'string');
  for(const client of clients){await join(client,channelId);await wait(client.page,"!!document.querySelector('audio[aria-hidden=true]')&&!document.querySelector('audio[aria-hidden=true]').paused&&document.getElementById('radioTrack').textContent.includes('integration song')",'actual radio audio plus ICY title');}
  for(const client of clients)check('local-radio-default10-'+clients.indexOf(client),await client.page.eval("window.echo.getState().settings.radioVolume===10&&window.echo.getState().settings.outVolume===100&&document.getElementById('radioVolume').value==='10'&&document.getElementById('radioVolumeValue').value==='10%'&&document.querySelector('audio[aria-hidden=true]').volume===0.1"));
  await target.eval("(()=>{const slider=document.getElementById('radioVolume');slider.value='18';slider.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await wait(target,"document.querySelector('audio[aria-hidden=true]').volume===0.18&&window.echo.getState().settings.radioVolume===18",'radio slider updates actual audio');
  check('radio-volume-local-only',await actor.eval("window.echo.getState().settings.radioVolume===10&&document.querySelector('audio[aria-hidden=true]').volume===0.1")&&await target.eval("window.echo.getState().settings.outVolume===100"));
  const preferenceFile=path.join(output,'profile-1','client-preferences.json');
  const preferenceDeadline=Date.now()+5000;
  while(Date.now()<preferenceDeadline){if(fs.existsSync(preferenceFile)&&JSON.parse(fs.readFileSync(preferenceFile,'utf8')).settings.radioVolume===18)break;await delay(50);}
  check('native-radio-volume-disk-save',JSON.parse(fs.readFileSync(preferenceFile,'utf8')).settings.radioVolume===18);
  check('radio-volume-controls-fit-strip',await actor.eval("(()=>{const strip=document.getElementById('radioStrip').getBoundingClientRect(),slider=document.getElementById('radioVolume').getBoundingClientRect(),manage=document.getElementById('radioManageBtn').getBoundingClientRect();return slider.width>0&&slider.left>=strip.left&&slider.right<=manage.left&&manage.right<=strip.right;})()"));
  check('radio-retry-control-visually-hidden-during-playback',await actor.eval("document.getElementById('radioRetryBtn').getClientRects().length===0"));
  for(const client of clients)await wait(client.page,"Object.values(window.echo.getVoiceStats().peers).some(peer=>peer.pcState==='connected')",'actual peer voice connection alongside radio');
  check('simultaneous-real-microphone-peer-and-radio-playback',await target.eval("window.echo.getVoiceStats().micReady&&window.echo.getVoiceStats().accompaniment===false&&!document.getElementById('radioStrip').hidden"));
  await target.eval('window.echo.actions.toggleDeafen()');await wait(target,"window.echo.getVoiceStats().deafened&&document.querySelector('audio[aria-hidden=true]').muted",'app deafen silences radio');
  await target.eval('window.echo.actions.toggleDeafen()');await wait(target,"!window.echo.getVoiceStats().deafened&&!document.querySelector('audio[aria-hidden=true]').muted",'app undeafen restores radio');checks.push('application-deafen-controls-local-radio');
  const textId=await actor.eval("window.echo.getState().servers.flatMap(server=>server.channels).find(channel=>channel.type==='text').id");assert.equal(typeof textId,'string');await actor.eval(`window.echo.actions.selectChannel(${JSON.stringify(textId)})`);
  check('radio-strip-persists-in-text-channel',await actor.eval(`window.echo.getState().activeChannelId===${JSON.stringify(textId)}&&!document.getElementById('radioStrip').hidden&&document.getElementById('radioTrack').classList.contains('scrolling')`));
  await click(actor,'radioManageBtn');await wait(actor,"!!document.getElementById('radioPanel')",'owner station panel');check('owner-can-edit-stations',await actor.eval("!document.getElementById('radioSaveBtn').hidden&&!document.getElementById('radioSwitchBtn').disabled"));
  await click(actor,'radioNewBtn');await fill(actor,'radioStationName','Local saved two');await fill(actor,'radioStationUrl',streamBase+'/two.aac');await click(actor,'radioSaveBtn');
  await wait(actor,`window.echo.getState().servers.flatMap(server=>server.channels).find(channel=>channel.id===${JSON.stringify(channelId)}).radio.stations.length===2`,'second station saved');
  await wait(actor,"!document.getElementById('radioSaveBtn').disabled",'station save acknowledged');
  const secondId=await actor.eval(`window.echo.getState().servers.flatMap(server=>server.channels).find(channel=>channel.id===${JSON.stringify(channelId)}).radio.stations.find(station=>station.name==='Local saved two').id`);assert.equal(typeof secondId,'string');
  await fill(actor,'radioStationSelect',secondId);await fill(actor,'radioStationName','Local edited two');await click(actor,'radioSaveBtn');await wait(actor,"[...document.getElementById('radioStationSelect').options].some(option=>option.textContent==='Local edited two')",'saved station name edited');
  await wait(actor,"!document.getElementById('radioSwitchBtn').disabled",'station edit acknowledged');
  await fill(actor,'radioStationSelect',secondId);await click(actor,'radioSwitchBtn');
  for(const client of clients)await wait(client.page,"document.getElementById('radioTrack').textContent.includes('Local Two')&&!document.querySelector('audio[aria-hidden=true]').paused",'saved station switch reaches listeners');
  check('station-switch-replicates-while-viewing-text',await actor.eval(`window.echo.getState().activeChannelId===${JSON.stringify(textId)}&&!document.getElementById('radioStrip').hidden`));
  await wait(actor,"!document.getElementById('radioSaveBtn').disabled",'switch acknowledged before HLS edit');
  await click(actor,'radioNewBtn');await fill(actor,'radioStationName','Local HLS');await fill(actor,'radioStationUrl',streamBase+'/live.m3u8');await click(actor,'radioSwitchBtn');
  for(const client of clients)await wait(client.page,"document.querySelector('audio[aria-hidden=true]')?.src.startsWith('blob:')&&!document.querySelector('audio[aria-hidden=true]').paused&&document.querySelector('audio[aria-hidden=true]').currentTime>0.1",'packaged HLS manifest and segment playback');checks.push('packaged-session-allows-authorized-hls-manifest-and-audio');
  await wait(actor,"!document.getElementById('radioSwitchBtn').disabled",'HLS switch acknowledged');await fill(actor,'radioStationSelect',secondId);await click(actor,'radioSwitchBtn');
  for(const client of clients)await wait(client.page,"document.getElementById('radioTrack').textContent.includes('Local Two')&&document.getElementById('radioTrack').textContent.includes('integration song')&&!document.querySelector('audio[aria-hidden=true]').paused",'return from HLS to ICY station');
  if(process.env.RADIO_UI_REMOTE==='1'){
    await click(actor,'radioCloseBtn');await wait(actor,"!document.getElementById('radioPanel')",'local panel closes before remote check');
    const presetId=await actor.eval("window.echo.getState().servers.flatMap(server=>server.channels).find(channel=>channel.name==='Preset radio').id");assert.equal(typeof presetId,'string');
    await join(clients[0],presetId);await click(actor,'radioManageBtn');await wait(actor,"!!document.getElementById('radioPanel')",'actual preset station panel');
    for(const id of ['datafruits','teodor','synthwave']){
      await wait(actor,"!document.getElementById('radioSwitchBtn').disabled",'remote station switch ready');await fill(actor,'radioStationSelect',id);await click(actor,'radioSwitchBtn');
      const remoteDeadline=Date.now()+40000;let ready=false;
      while(Date.now()<remoteDeadline){
        ready=await actor.eval(`(()=>{const channel=window.echo.getState().servers.flatMap(server=>server.channels).find(channel=>channel.id===${JSON.stringify(presetId)});const station=channel.radio.stations.find(entry=>entry.id===${JSON.stringify(id)});const audio=document.querySelector('audio[aria-hidden=true]');return channel.radio.stationId===${JSON.stringify(id)}&&audio?.src===station.url&&!audio.paused&&audio.currentTime>0.1&&document.getElementById('radioTrack').textContent.includes(' — ');})()`);
        if(ready)break;
        const failure=await actor.eval("!document.getElementById('radioRetryBtn').hidden?document.getElementById('radioTrack').textContent:null");if(failure)throw new Error('Real remote radio playback failed: '+failure);
        await delay(100);
      }
      assert(ready,'Real remote radio playback and metadata deadline: '+id);
      const title=await actor.eval("document.getElementById('radioTrack').textContent");assert.equal(typeof title,'string');remoteStations.push({id,title});checks.push('actual-packaged-remote-radio-'+id);
    }
    await click(actor,'radioCloseBtn');await wait(actor,"!document.getElementById('radioPanel')",'remote panel closes');await actor.screenshot(path.join(output,'actual-remote-station.png'));
    await join(clients[0],channelId);await actor.eval(`window.echo.actions.selectChannel(${JSON.stringify(textId)})`);await wait(actor,"document.getElementById('radioTrack').textContent.includes('integration song')",'return to local radio after remote verification');await click(actor,'radioManageBtn');await wait(actor,"!!document.getElementById('radioPanel')",'owner station panel restored');
    await actor.eval("Promise.all(document.getElementById('modalRoot').getAnimations({subtree:true}).map(animation=>animation.finished)).then(()=>true)");
  }
  await actor.screenshot(path.join(output,'owner-stations-dialog.png'));
  await click(actor,'radioCloseBtn');await wait(actor,"!document.getElementById('radioPanel')",'owner station dialog fully closes');await actor.screenshot(path.join(output,'owner-radio-in-text.png'));
  const ownerId=await actor.eval('window.echo.getState().selfId'),memberId=await target.eval('window.echo.getState().selfId');assert.equal(typeof ownerId,'string');assert.equal(typeof memberId,'string');
  for(const [page,id,label,visible]of [[target,ownerId,'member-cannot-edit-owner',false],[target,memberId,'member-cannot-edit-self',false],[actor,memberId,'owner-can-edit-member',true]]){
    assert(typeof id==='string'&&typeof label==='string'&&typeof visible==='boolean'&&typeof page==='object');
    await page.eval(`document.querySelector(${JSON.stringify('.member[data-user-id="'+id+'"]')}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:1000,clientY:200}))`);
    check(label,await page.eval(`Boolean(document.getElementById('assignMemberPermissionsMenuBtn'))===${visible}`));await page.eval('document.body.click()');
  }
  await click(target,'radioManageBtn');await wait(target,"!!document.getElementById('radioPanel')",'member station panel');check('ordinary-member-cannot-edit-or-propose-while-owner-online',await target.eval("document.getElementById('radioSaveBtn').hidden&&document.getElementById('radioSaveBtn').getClientRects().length===0&&document.getElementById('radioSwitchBtn').disabled"));await target.eval("Promise.all(document.getElementById('modalRoot').getAnimations({subtree:true}).map(animation=>animation.finished)).then(()=>true)");await target.screenshot(path.join(output,'member-stations-dialog.png'));await click(target,'radioCloseBtn');await wait(target,"!document.getElementById('radioPanel')",'member station dialog fully closes');
  await actor.eval('window.echo.actions.leaveVoice()');await wait(actor,"document.getElementById('radioStrip').hidden&&!document.querySelector('audio[aria-hidden=true]')",'owner radio leave disposes player');checks.push('leaving-radio-clears-player-and-strip');
  await stop(clients[0].child);actor.close();
  await click(target,'radioManageBtn');await wait(target,"!document.getElementById('radioSwitchBtn').disabled",'member can propose after privileged user disconnects');check('ordinary-member-can-propose-when-privileged-offline',await target.eval("document.getElementById('radioSaveBtn').hidden&&!document.getElementById('radioSwitchBtn').disabled"));await click(target,'radioCloseBtn');await wait(target,"!document.getElementById('radioPanel')",'offline proposal panel fully closes');await target.screenshot(path.join(output,'member-radio.png'));
  await target.eval('window.echo.actions.leaveVoice()');await wait(target,"document.getElementById('radioStrip').hidden&&!document.querySelector('audio[aria-hidden=true]')&&!window.echo.getVoiceStats().micReady",'all listening resources released');
  const cleanupDeadline=Date.now()+3000;while(activeStreams&&Date.now()<cleanupDeadline)await delay(50);check('radio-network-streams-closed-after-leave',activeStreams===0);check('radio-requests-never-forward-auth-cookie-or-referrer',headerLeaks.length===0);check('no-renderer-exceptions',errors.length===0);
  await stop(clients[1].child);target.close();
  const restartDebug=await freePort();
  /** @type {NodeJS.ProcessEnv} */const restartEnv={...process.env,DEEPSCORD_USER_DATA:path.join(output,'profile-1')};delete restartEnv.ELECTRON_RUN_AS_NODE;
  const restartedChild=launch('client-restarted',path.join(packageDirectory,'Deepscord.exe'),[`--remote-debugging-port=${restartDebug}`,'--mute-audio','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'],packageDirectory,restartEnv);
  await waitForPort(restartDebug,20000);
  const restartedPage=await roomPage(restartDebug);clients.push({page:restartedPage,debug:restartDebug,child:restartedChild});
  await wait(restartedPage,'window.echo?.getState().roomReady===true','restarted room restores identity');
  check('native-radio-volume-persists-after-restart',await restartedPage.eval('window.echo.getState().settings.radioVolume===18&&window.echo.getState().settings.outVolume===100'));
  await join(clients[2],channelId);
  await wait(restartedPage,"document.querySelector('audio[aria-hidden=true]')?.volume===0.18&&document.querySelector('audio[aria-hidden=true]').readyState>=2&&document.querySelector('audio[aria-hidden=true]').currentTime>0.1&&!document.querySelector('audio[aria-hidden=true]').paused&&document.getElementById('radioVolume').value==='18'&&document.getElementById('radioTrack').textContent.includes('integration song')",'restarted radio playback uses persisted18percent');
  checks.push('persisted-radio-volume-controls-real-playback-after-restart');
  await restartedPage.screenshot(path.join(output,'restarted-radio-volume.png'));
  await restartedPage.eval('window.echo.actions.leaveVoice()');await wait(restartedPage,"!document.querySelector('audio[aria-hidden=true]')",'restarted radio cleanup');
  assert.deepEqual(packageHashes(),initialPackageHashes,'Packaged executable and production radio sources must remain immutable');checks.push('packaged-production-files-unchanged');passed=true;
}catch(error){
  for(const [index,client]of clients.entries()){if(client.child.exitCode!==null||client.child.signalCode!==null)continue;try{await client.page.screenshot(path.join(output,'failure-'+index+'.png'));fs.writeFileSync(path.join(output,'failure-'+index+'.json'),JSON.stringify(await client.page.eval('({state:window.echo?.getState(),voice:window.echo?.getVoiceStats(),radio:document.getElementById("radioTrack")?.textContent,toasts:[...document.querySelectorAll(".toast")].map(node=>node.textContent)})'),null,2));}catch(diagnostic){console.error('radio_ui_diagnostic_failed',{index,error:String(diagnostic)});}}
  throw error;
}finally{
  for(const client of clients)client.page.close();for(const child of children.reverse())await stop(child);fixture.closeAllConnections();fixture.close();await once(fixture,'close');fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed,packageDirectory,checks,errors,headerLeaks,remoteStations,logs,realMicrophone:true,fakeDevices:false,hardwareAudibilityVerified:false},null,2));console.log(JSON.stringify({passed,output,checks}));
}
