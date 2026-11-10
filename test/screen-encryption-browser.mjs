// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes,createHash} from 'node:crypto';
import {AccessToken,RoomServiceClient,TrackSource} from 'livekit-server-sdk';
import livekitConfigModule from '../deploy/livekit-config.cjs';
import {connectPage,waitForPort} from './cdp.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
assert.equal(process.argv.length,4,'Usage: node test/screen-encryption-browser.mjs --electron ABSOLUTE_EXECUTABLE');
assert.equal(process.argv[2],'--electron');
const executable=fs.realpathSync(process.argv[3]);
const data=fs.mkdtempSync(path.join(root,'.qa-tools/screen-encryption-browser-'));
/** @returns {Promise<number>} */
async function freePort(){const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const address=socket.address();assert(address&&typeof address==='object');socket.close();await once(socket,'close');return address.port;}
const signalingPort=await freePort(),udpPort=await freePort(),tcpPort=await freePort();
assert.equal(new Set([signalingPort,udpPort,tcpPort]).size,3);
const apiKey='screen_encryption_'+randomBytes(8).toString('hex'),apiSecret=randomBytes(48).toString('hex');
const internalUrl='http://127.0.0.1:'+signalingPort;
const livekitBinary=path.join(root,'.qa-tools/livekit-1.13.11/livekit-server.exe');
const pin=JSON.parse(fs.readFileSync(path.join(root,'deploy/livekit-pin.json'),'utf8'));
assert.equal(createHash('sha256').update(fs.readFileSync(livekitBinary)).digest('hex'),pin.executableSha256);
const privateConfig=path.join(data,'livekit-private.yaml');
fs.writeFileSync(privateConfig,livekitConfigModule.liveKitConfig({ECHO_SCREEN_MODE:'sfu',LIVEKIT_INTERNAL_URL:internalUrl,ECHO_SCREEN_SFU_URL:'ws://127.0.0.1:'+signalingPort+'/screen-sfu',LIVEKIT_API_KEY:apiKey,LIVEKIT_API_SECRET:apiSecret,LIVEKIT_NODE_IP:'127.0.0.1',LIVEKIT_UDP_PORT:String(udpPort),LIVEKIT_TCP_PORT:String(tcpPort)}));
const sfuLog=fs.openSync(path.join(data,'livekit.log'),'a');
const sfu=spawn(livekitBinary,['--config',privateConfig],{windowsHide:true,stdio:['ignore',sfuLog,sfuLog]});fs.closeSync(sfuLog);
const sfuApi=new RoomServiceClient(internalUrl,apiKey,apiSecret,{requestTimeout:5,failover:false});
const runtime=path.join(data,'runtime'),original=path.dirname(executable);
/** @param {string} source @param {string} destination @returns {void} */
function stageRuntime(source,destination) {
  fs.mkdirSync(destination,{recursive:true});
  for(const entry of fs.readdirSync(source,{withFileTypes:true})) {
    const filename=path.join(source,entry.name),target=path.join(destination,entry.name);
    if(path.relative(original,filename)==='resources'+path.sep+'app')continue;
    assert(!entry.isSymbolicLink(),'Test runtime refuses symbolic links');
    if(entry.isDirectory())stageRuntime(filename,target);else fs.linkSync(filename,target);
  }
}
stageRuntime(original,runtime);
const testApp=path.join(runtime,'resources/app');fs.mkdirSync(testApp,{recursive:true});
fs.writeFileSync(path.join(testApp,'package.json'),JSON.stringify({name:'deepscord-screen-encryption-test',version:'1.0.0',main:'main.cjs'}));
fs.writeFileSync(path.join(testApp,'main.cjs'),'require('+JSON.stringify(path.join(root,'test/screen-encryption-browser-main.cjs'))+');\n');
const helperToken=randomBytes(32).toString('hex');
const helper=spawn(path.join(root,'desktop/native/bin/screen-relay.exe'),['--listen','127.0.0.1:0'],{env:{...process.env,SCREEN_RELAY_TOKEN:helperToken},windowsHide:true,stdio:['pipe','pipe','pipe']});
let helperDiagnostics='';helper.stderr.on('data',chunk=>{helperDiagnostics=(helperDiagnostics+chunk.toString()).slice(-8192);});
const helperPort=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{helper.kill();reject(new Error('Native screen relay startup timed out'));},5000);
  let output='';
  helper.stdout.on('data',chunk=>{output+=chunk.toString();if(!output.includes('\n'))return;clearTimeout(timer);const record=JSON.parse(output.trim());assert.equal(record.event,'ready');assert.equal(record.pid,helper.pid);resolve(record.port);});
  helper.once('error',error=>{clearTimeout(timer);reject(error);});
});
const server=http.createServer((request,response)=>{
  const url=new URL(request.url||'/','http://localhost'),requested=url.pathname;
  if(requested==='/sfu-credential') {
    const identity=url.searchParams.get('identity');assert(identity==='sfu-source'||identity==='sfu-viewer');
    const token=new AccessToken(apiKey,apiSecret,{identity,ttl:'5m'});token.addGrant({roomJoin:true,room:'encrypted-screen-test',canPublish:identity==='sfu-source',canSubscribe:identity==='sfu-viewer',canPublishData:false,canPublishSources:identity==='sfu-source'?[TrackSource.SCREEN_SHARE]:[]});
    token.toJwt().then(jwt=>{response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({channelId:'sfu-test-channel',sourceUserId:'sfu-source',identity,publisherIdentity:'sfu-source',url:'ws://'+request.headers.host+'/screen-sfu',token:jwt,expiresAt:Date.now()+300000}));},error=>{response.writeHead(500);response.end(String(error));});return;
  }
  if(requested==='/sfu-release') {
    const identity=url.searchParams.get('identity');assert(identity==='sfu-source'||identity==='sfu-viewer');
    (async()=>{const rooms=await sfuApi.listRooms(['encrypted-screen-test']);if(rooms.length){const members=await sfuApi.listParticipants('encrypted-screen-test');if(members.some(member=>member.identity===identity))await sfuApi.removeParticipant('encrypted-screen-test',identity);}response.writeHead(200);response.end('{}');})().catch(error=>{response.writeHead(500);response.end(String(error));});return;
  }
  if(requested.startsWith('/screen-sfu/')) {
    const upstream=http.request({hostname:'127.0.0.1',port:signalingPort,path:requested.slice('/screen-sfu'.length)+url.search,method:request.method,headers:request.headers},remote=>{response.writeHead(remote.statusCode||500,remote.headers);remote.pipe(response);});upstream.on('error',error=>{response.writeHead(502);response.end(error.message);});request.pipe(upstream);return;
  }
  if(requested.startsWith('/native/')) {
    const upstream=http.request({hostname:'127.0.0.1',port:helperPort,path:requested.slice('/native'.length)+url.search,method:request.method,headers:{authorization:'Bearer '+helperToken,'content-type':'application/json'}},remote=>{response.writeHead(remote.statusCode||500,{'content-type':'application/json'});remote.pipe(response);});
    upstream.on('error',error=>{response.writeHead(502);response.end(JSON.stringify({error:error.message}));});request.pipe(upstream);return;
  }
  if(requested==='/') {response.setHeader('Content-Type','text/html');response.end('<!doctype html><html><body><div id="codec-test">SCREEN_ENCRYPTION codec integration</div></body></html>');return;}
  const filename=path.resolve(root,'.'+requested),relative=path.relative(root,filename);
  if(relative.startsWith('..')||path.isAbsolute(relative)||!fs.existsSync(filename)||!fs.statSync(filename).isFile()) {response.writeHead(404);response.end('Not found');return;}
  const types=new Map([['.js','text/javascript'],['.mjs','text/javascript'],['.wasm','application/wasm'],['.avif','image/avif'],['.png','image/png'],['.webp','image/webp'],['.gif','image/gif'],['.jpg','image/jpeg'],['.bmp','image/bmp']]);
  response.setHeader('Content-Type',types.get(path.extname(filename))||'application/octet-stream');
  response.end(fs.readFileSync(filename));
});
server.on('upgrade',(request,socket,head)=>{
  const url=new URL(request.url||'/','http://localhost');assert(url.pathname.startsWith('/screen-sfu/'));
  const upstream=http.request({hostname:'127.0.0.1',port:signalingPort,path:url.pathname.slice('/screen-sfu'.length)+url.search,method:request.method,headers:request.headers});
  upstream.on('upgrade',(reply,remote,remaining)=>{let headers='HTTP/1.1 '+reply.statusCode+' '+reply.statusMessage+'\r\n';for(let index=0;index<reply.rawHeaders.length;index+=2)headers+=reply.rawHeaders[index]+': '+reply.rawHeaders[index+1]+'\r\n';socket.write(headers+'\r\n');if(remaining.length)socket.write(remaining);if(head.length)remote.write(head);socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());socket.once('close',()=>remote.destroy());remote.once('close',()=>socket.destroy());remote.pipe(socket);socket.pipe(remote);});
  upstream.on('response',reply=>{reply.resume();socket.destroy();});upstream.on('error',()=>socket.destroy());socket.once('close',()=>upstream.destroy());upstream.end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address==='object');
const reserve=net.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const reserved=reserve.address();assert(reserved&&typeof reserved==='object');reserve.close();await once(reserve,'close');
const origin='http://127.0.0.1:'+address.port;
/** @type {NodeJS.ProcessEnv} */const environment={...process.env,DEEPSCORD_SCREEN_ENCRYPTION_TEST_URL:origin};delete environment.ELECTRON_RUN_AS_NODE;
const child=spawn(path.join(runtime,path.basename(executable)),['--user-data-dir='+path.join(data,'profile'),'--remote-debugging-port='+reserved.port],{env:environment,windowsHide:true,stdio:'ignore'});
/** @type {Awaited<ReturnType<typeof connectPage>>|null} */ let page=null;
try {
  const readyDeadline=Date.now()+10000;
  for(;;){try{await sfuApi.listRooms();break;}catch(error){if(Date.now()>readyDeadline)throw error;await new Promise(resolve=>setTimeout(resolve,100));}}
  await waitForPort(reserved.port,15000);page=await connectPage(reserved.port,origin);
  await page.waitFor('document.readyState === "complete" && location.origin === '+JSON.stringify(origin),{timeout:10000,interval:50,label:'SCREEN_ENCRYPTION browser page'});
  const result=await page.eval('(async()=> {try{const adapter=await (await import('+JSON.stringify(origin+'/test/screen-encryption-browser-page.js')+')).run();const links=await (await import('+JSON.stringify(origin+'/test/screen-encryption-links-page.js')+')).run();const sfu=await (await import('+JSON.stringify(origin+'/test/screen-encryption-sfu-page.js')+')).run();return {adapter,links,sfu};}catch(error){return {error:String(error)};}})()',{awaitPromise:true,userGesture:true});
  console.log(JSON.stringify(result));
  assert(!result.error,result.error);
  fs.mkdirSync(path.join(root,'.qa-tools/results'),{recursive:true});fs.writeFileSync(path.join(root,'.qa-tools/results/screen-encryption-browser.json'),JSON.stringify(result,null,2)+'\n');
} finally {
  page?.close();
  if(child.exitCode===null&&child.pid) {
    const stopped=spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,encoding:'utf8'});
    if(stopped.error)throw stopped.error;
    if(stopped.status!==0)throw new Error('Could not stop owned SCREEN_ENCRYPTION Electron test process '+child.pid+': '+stopped.stderr);
  }
  server.closeAllConnections();server.close();await once(server,'close');
  const exited=once(helper,'close');helper.stdin.end();await exited;
  fs.writeFileSync(path.join(data,'native-diagnostics.log'),helperDiagnostics);
  if(sfu.exitCode===null){const exited=once(sfu,'exit');sfu.kill();await exited;}
  fs.rmSync(privateConfig);
}
