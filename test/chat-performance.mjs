// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connectPage, waitForPort } from './cdp.mjs';
import { identityPayload, parseIdentityChallenge } from '../lib/server-identity.cjs';
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{[key:string]:JsonValue}} JsonObject */
/** @typedef {{added:number,removed:number,mutations:number,latencyMs:number,retained:boolean}} Sample */
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const variant=process.env.CHAT_BENCHMARK_VARIANT;
assert(variant==='baseline' || variant==='optimized','CHAT_BENCHMARK_VARIANT must be baseline or optimized');
const release=path.join(root,'dist','server-domains-roles-20261105','Deepscord-win32-x64');
const desktop=variant==='baseline' ? path.join(release,'resources','app') : path.join(root,'desktop');
const backend=variant==='baseline' ? path.join(desktop,'app-server') : root;
const output=path.join(root,'output','playwright','performance');fs.mkdirSync(output,{recursive:true});
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-chat-performance-'));
const runtime=path.join(root,'.qa-tools','chat-performance-runtime');
if(!fs.existsSync(runtime))fs.cpSync(release,runtime,{recursive:true,filter:entry=>entry!==path.join(release,'resources','app') && !entry.startsWith(path.join(release,'resources','app')+path.sep)});
const entry=path.join(runtime,'resources','app');fs.mkdirSync(entry,{recursive:true});
fs.writeFileSync(path.join(entry,'package.json'),JSON.stringify({name:'deepscord-chat-performance',version:'1.0.0',main:'main.cjs'}));
fs.writeFileSync(path.join(entry,'main.cjs'),`const {app}=require('electron');app.on('browser-window-created',(_event,window)=>window.hide());require(${JSON.stringify(path.join(desktop,'main.js'))});`);
/** @returns {Promise<number>} */
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(undefined)));const address=server.address();assert(address && typeof address!=='string');await new Promise(resolve=>server.close(()=>resolve(undefined)));return address.port;}
const port=await freePort(),debug=await freePort(),base='http://127.0.0.1:'+port;
const serverData=path.join(temporary,'server'),clientData=path.join(temporary,'client');fs.mkdirSync(serverData);fs.mkdirSync(clientData);
const channels=Array.from({length:11},(_,index)=>({id:'bench-'+index,name:'Chat '+index,type:'text',userLimit:0}));
const now=Date.now();
const messages=Object.fromEntries(channels.map((channel,index)=>[channel.id,Array.from({length:index<5 ? 50 : index<10 ? 200 : 4},(_,row)=>({id:'seed-'+index+'-'+row,userId:index===10 && row===1 ? 'writer-b' : 'writer-a',name:'Seed author',color:'#87d8ce',text:index===10 && row===0 ? '<script>window.chatEscaped=false</script> **bold** https://example.test/a' : 'History '+row+' '+'.'.repeat(130),ts:index===10 ? now-86400000*(row===3 ? 1 : 2)+(row===3 ? 0 : row*1000) : now-100000+row,system:false,bot:false}))]));
fs.writeFileSync(path.join(serverData,'store.json'),JSON.stringify({version:1,servers:[{id:'srv-main',name:'Performance',icon:'P',color:'#87d8ce',channels}],messages}));
fs.writeFileSync(path.join(clientData,'desktop-settings.json'),JSON.stringify({muteShortcut:'Control+Alt+Shift+F23',overlay:{enabled:false,locked:true,x:24,y:80,width:280,height:300,scale:1}}));
fs.writeFileSync(path.join(clientData,'config.json'),JSON.stringify({serverUrl:base,autoConnect:true,trustedHosts:[]}));
const environment={...process.env,PORT:String(port),HTTPS_PORTS:'0',HTTP_HOST:'127.0.0.1',ECHO_DATA_DIR:serverData,ECHO_NETWORK_MODE:'server',ECHO_MEDIA_POLICY:'direct',ECHO_PASSWORD:''};
const server=spawn(process.execPath,[path.join(backend,'server.js')],{cwd:backend,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
let serverLog='';server.stdout.on('data',chunk=>{serverLog+=String(chunk);});server.stderr.on('data',chunk=>{serverLog+=String(chunk);});
/** @type {import('node:child_process').ChildProcess|null} */let client=null;
/** @type {Awaited<ReturnType<typeof connectPage>>|null} */let page=null;
/** @type {WebSocket|null} */let writer=null;
/** @type {WebSocket|null} */let visitor=null;
/** @type {JsonObject[]} */const inbox=[];
/** @param {(frame:JsonObject)=>boolean} predicate @param {string} label @returns {Promise<JsonObject>} */
async function waitFrame(predicate,label){const deadline=Date.now()+10000;while(Date.now()<deadline){const frame=inbox.find(predicate);if(frame)return frame;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Missing real server frame: '+label);}
try {
  console.log('Starting '+variant+' real server');
  const deadline=Date.now()+10000;let healthy=false;while(!healthy && Date.now()<deadline){try{healthy=(await fetch(base+'/api/health')).ok;}catch(error){if(!(error instanceof TypeError))throw error;}if(!healthy)await new Promise(resolve=>setTimeout(resolve,50));}assert(healthy,serverLog);
  const env={...process.env,DEEPSCORD_USER_DATA:clientData};delete env.ELECTRON_RUN_AS_NODE;
  client=spawn(path.join(runtime,'Deepscord.exe'),[`--remote-debugging-port=${debug}`],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  client.stderr?.on('data',chunk=>console.error(String(chunk)));
  console.log('Electron launched '+debug);
  await waitForPort(debug,20000);
  const workspace=await connectPage(debug,new URL('file:///'+desktop.replaceAll('\\','/')+'/workspace.html').href);
  await workspace.waitFor("document.getElementById('workspaceLoading')?.hidden===true",{timeout:10000,interval:50,label:'native workspace'});
  await workspace.eval('window.deepscord.openConnectionPanel("join")');
  const connection=await connectPage(debug,new URL('file:///'+desktop.replaceAll('\\','/')+'/connections.html').href);
  await connection.waitFor("!document.getElementById('connectionBody').hidden",{timeout:5000,interval:50,label:'join panel'});
  await connection.eval("document.getElementById('serverMethodBtn').click();document.getElementById('serverUrl').value="+JSON.stringify(base)+";document.getElementById('serverConnectBtn').click()");connection.close();workspace.close();
  page=await connectPage(debug,base+'/');const ui=page;
  await ui.waitFor("!!document.getElementById('welcomeNameInput')",{timeout:10000,interval:50,label:'real welcome'});
  await ui.eval("document.getElementById('welcomeNameInput').value='Performance reader';document.getElementById('welcomeEnterBtn').click()");
  await ui.waitFor("window.echo?.getState().roomReady && !document.querySelector('.modal-backdrop')",{timeout:10000,interval:50,label:'real room'});
  const keys=generateKeyPairSync('ed25519'),memberKey=keys.publicKey.export({format:'der',type:'spki'}).toString('base64');
  writer=new WebSocket(base.replace('http','ws')+'/ws');const peer=writer;
  peer.addEventListener('message',event=>{/** @type {JsonValue} */const frame=JSON.parse(String(event.data));assert(frame && typeof frame==='object' && !Array.isArray(frame));inbox.push(frame);if(frame.t==='identityChallenge'){const challenge=parseIdentityChallenge(frame);peer.send(JSON.stringify({t:'identityProof',nonce:challenge.nonce,memberKey,signature:sign(null,Buffer.from(identityPayload(challenge)),keys.privateKey).toString('base64')}));}});
  await new Promise(resolve=>peer.addEventListener('open',()=>resolve(undefined),{once:true}));peer.send(JSON.stringify({t:'hello',name:'Benchmark writer',color:'#87d8ce',resumable:false}));
  await waitFrame(frame=>frame.t==='serverState' && frame.selfKey===memberKey,'signed writer identity');
  peer.send(JSON.stringify({t:'claimOwner',token:fs.readFileSync(path.join(serverData,'owner-claim.txt'),'utf8').trim()}));
  await waitFrame(frame=>{const policy=frame.policy;return frame.t==='serverState' && !!policy && typeof policy==='object' && !Array.isArray(policy) && policy.ownerKey===memberKey;},'writer owner claim');
  /** @type {{url:string,transferSize:number,encodedBodySize:number,decodedBodySize:number}[]} */
  const resources=await ui.eval("performance.getEntriesByType('resource').filter(entry=>entry.initiatorType==='script').map(entry=>({url:entry.name,transferSize:entry.transferSize,encodedBodySize:entry.encodedBodySize,decodedBodySize:entry.decodedBodySize}))");
  const livekitResources=resources.filter(resource=>resource.url.includes('/vendor/livekit-client.js'));
  if(variant==='optimized')assert.equal(livekitResources.length,0,'Direct chat must not request LiveKit vendor');
  else assert.equal(livekitResources.length,1,'Immutable baseline must eagerly load LiveKit vendor');
  await ui.eval(`window.chatBench={};window.chatBench.start=(lastText)=>{const root=document.getElementById('messages');const first=root.querySelector('[data-msg-id]');let added=0,removed=0,mutations=0;const start=performance.now();const rows=node=>node.nodeType===1 ? Number(node.matches('.msg'))+node.querySelectorAll('.msg').length : 0;window.chatBench.completion=new Promise(resolve=>{const observer=new MutationObserver(records=>{for(const record of records){mutations++;for(const node of record.addedNodes)added+=rows(node);for(const node of record.removedNodes)removed+=rows(node);}if(root.textContent.includes(lastText)){observer.disconnect();resolve({added,removed,mutations,latencyMs:performance.now()-start,retained:first===root.querySelector('[data-msg-id]')});}});observer.observe(root,{childList:true,subtree:true});});};`);
  /** @type {{small:Sample[],window:Sample[]}} */const results={small:[],window:[]};
  for(let index=0;index<10;index++){
    const channelId='bench-'+index,count=index<5 ? 50 : 100,last='Burst '+index+' '+(count-1);
    await ui.eval('window.echo.actions.selectChannel('+JSON.stringify(channelId)+')');
    await ui.eval("document.getElementById('messages').scrollTop=document.getElementById('messages').scrollHeight");
    await ui.eval('window.chatBench.start('+JSON.stringify(last)+')');
    for(let item=0;item<count;item++)peer.send(JSON.stringify({t:'chat',channelId,text:'Burst '+index+' '+item}));
    /** @type {Sample} */ const sample=await ui.eval('window.chatBench.completion');
    results[index<5 ? 'small' : 'window'].push(sample);
    assert.equal(await ui.eval("document.getElementById('messages').querySelectorAll('.msg').length"),index<5 ? 100 : 200);
    assert.equal(await ui.eval('window.echo.getState().messageCounts['+JSON.stringify(channelId)+']'),index<5 ? 100 : 300);
    assert(await ui.eval("(()=>{const el=document.getElementById('messages');return el.scrollHeight-el.scrollTop-el.clientHeight<120})()"));
    console.log(variant+' sample '+index+' '+JSON.stringify(sample));
  }
  await ui.eval("window.echo.actions.selectChannel('bench-0');document.getElementById('messages').scrollTop=350;window.chatBench.anchor=[...document.querySelectorAll('#messages [data-msg-id]')].find(row=>row.getBoundingClientRect().top>=document.getElementById('messages').getBoundingClientRect().top);window.chatBench.anchorTop=window.chatBench.anchor.getBoundingClientRect().top");
  await ui.eval("window.chatBench.start('anchor append')");peer.send(JSON.stringify({t:'chat',channelId:'bench-0',text:'anchor append'}));await ui.eval('window.chatBench.completion');
  const scroll=await ui.eval("({same:window.chatBench.anchor.isConnected,delta:window.chatBench.anchor.isConnected ? window.chatBench.anchor.getBoundingClientRect().top-window.chatBench.anchorTop : null,scrollTop:document.getElementById('messages').scrollTop})");
  if(variant==='optimized'){assert(scroll.same);assert(Math.abs(scroll.delta)<2);assert(results.small.every(sample=>sample.removed===0 && sample.retained));assert(results.window.every(sample=>sample.removed===100));}
  await ui.eval("window.echo.actions.selectChannel('bench-5');document.getElementById('messages').scrollTop=600;window.chatBench.windowAnchor=[...document.querySelectorAll('#messages [data-msg-id]')].find(row=>row.getBoundingClientRect().top>=document.getElementById('messages').getBoundingClientRect().top);window.chatBench.windowAnchorTop=window.chatBench.windowAnchor.getBoundingClientRect().top;window.chatBench.start('rollover anchor append')");
  peer.send(JSON.stringify({t:'chat',channelId:'bench-5',text:'rollover anchor append'}));await ui.eval('window.chatBench.completion');
  const rolloverScroll=await ui.eval("({same:window.chatBench.windowAnchor.isConnected,delta:window.chatBench.windowAnchor.isConnected ? window.chatBench.windowAnchor.getBoundingClientRect().top-window.chatBench.windowAnchorTop : null})");
  if(variant==='optimized'){assert(rolloverScroll.same);assert(Math.abs(rolloverScroll.delta)<2);}
  await ui.eval("window.echo.actions.selectChannel('bench-10');window.chatBench.edge=document.querySelector('#messages [data-msg-id]')");
  const formatted=await ui.eval("(async()=>{const {renderText}=await import('/js/util.js');return{actual:document.querySelector('#messages .msg-text').innerHTML,expected:renderText("+JSON.stringify(messages['bench-10'][0].text)+")}})()");assert.equal(formatted.actual,formatted.expected);
  assert.equal(await ui.eval("document.querySelectorAll('#messages .day-divider').length"),2);
  peer.send(JSON.stringify({t:'deleteMessage',channelId:'bench-10',messageId:'seed-10-1'}));
  await ui.waitFor("!document.querySelector('#messages [data-msg-id=\"seed-10-1\"]')",{timeout:5000,interval:10,label:'actual moderation deletion'});
  assert.equal(await ui.eval("document.querySelectorAll('#messages .day-divider').length"),2);
  assert.equal(await ui.eval("!!document.querySelector('#messages [data-msg-id=\"seed-10-2\"] .msg-gutter')"),true);
  if(variant==='optimized')assert.equal(await ui.eval("window.chatBench.edge===document.querySelector('#messages [data-msg-id]')"),true);
  visitor=new WebSocket(base.replace('http','ws')+'/ws');await new Promise(resolve=>visitor?.addEventListener('open',()=>resolve(undefined),{once:true}));visitor.send(JSON.stringify({t:'hello',name:'Unrelated visitor',color:'#87d8ce'}));
  await ui.waitFor("window.echo.getState().users.some(user=>user.name==='Unrelated visitor')",{timeout:5000,interval:50,label:'real unrelated presence'});
  await ui.eval('new Promise(resolve=>setTimeout(resolve,100))');
  const unrelatedRetained=await ui.eval("window.chatBench.edge===document.querySelector('#messages [data-msg-id]')");if(variant==='optimized')assert(unrelatedRetained);
  peer.send(JSON.stringify({t:'deleteChannel',channelId:'bench-1'}));
  await ui.waitFor("!window.echo.getState().servers.some(domain=>domain.channels.some(channel=>channel.id==='bench-1'))",{timeout:5000,interval:20,label:'real inactive channel deletion'});
  const deletedHistoryPruned=await ui.eval("!Object.hasOwn(window.echo.getState().messageCounts,'bench-1')");
  if(variant==='optimized')assert(deletedHistoryPruned,'Deleted channel history must be released');
  /** @param {number[]} values @returns {number} */const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const medians=Object.fromEntries(Object.entries(results).map(([name,samples])=>[name,Object.fromEntries(['added','removed','mutations','latencyMs'].map(key=>[key,median(samples.map(sample=>sample[/** @type {'added'|'removed'|'mutations'|'latencyMs'} */(key)]))]))]));
  fs.writeFileSync(path.join(output,'chat-'+variant+'.json'),JSON.stringify({variant,backend,desktop,resources,livekitResources,results,medians,scroll,rolloverScroll,deletedHistoryPruned,unrelatedRetained,checks:['200 UI / 300 storage','bottom autoscroll','reading anchor including 200-window rollover','deleted channel cache released','day/group after moderation deletion','escaped text and links unchanged','unrelated presence'],serverLog},null,2));console.log('MEDIANS '+JSON.stringify(medians));
}finally{visitor?.close();writer?.close();if(page){await page.send('Runtime.evaluate',{expression:'window.deepscord.quit()'}).catch(error=>console.warn('Quit response closed',{message:error.message}));page.close();}if(client && client.exitCode===null)client.kill();server.kill();}
