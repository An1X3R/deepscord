// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {connectPage,waitForPort} from './cdp.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
assert.equal(process.argv.length,4,'Usage: node test/avif-codec-browser.mjs --electron ABSOLUTE_EXECUTABLE');
assert.equal(process.argv[2],'--electron');
const executable=fs.realpathSync(process.argv[3]);
const data=fs.mkdtempSync(path.join(root,'.qa-tools/avif-codec-browser-'));
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
fs.writeFileSync(path.join(testApp,'package.json'),JSON.stringify({name:'deepscord-avif-codec-test',version:'1.0.0',main:'main.cjs'}));
fs.writeFileSync(path.join(testApp,'main.cjs'),'require('+JSON.stringify(path.join(root,'test/avif-codec-browser-main.cjs'))+');\n');
const server=http.createServer((request,response)=>{
  const requested=new URL(request.url||'/','http://localhost').pathname;
  if(requested==='/') {response.setHeader('Content-Type','text/html');response.end('<!doctype html><html><body><div id="codec-test">AVIF codec integration</div></body></html>');return;}
  const filename=path.resolve(root,'.'+requested),relative=path.relative(root,filename);
  if(relative.startsWith('..')||path.isAbsolute(relative)||!fs.existsSync(filename)||!fs.statSync(filename).isFile()) {response.writeHead(404);response.end('Not found');return;}
  const types=new Map([['.js','text/javascript'],['.mjs','text/javascript'],['.wasm','application/wasm'],['.avif','image/avif'],['.png','image/png'],['.webp','image/webp'],['.gif','image/gif'],['.jpg','image/jpeg'],['.bmp','image/bmp']]);
  response.setHeader('Content-Type',types.get(path.extname(filename))||'application/octet-stream');
  response.end(fs.readFileSync(filename));
});
server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address==='object');
const reserve=net.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const reserved=reserve.address();assert(reserved&&typeof reserved==='object');reserve.close();await once(reserve,'close');
const origin='http://127.0.0.1:'+address.port;
const environment={...process.env,DEEPSCORD_AVIF_TEST_URL:origin};delete environment.ELECTRON_RUN_AS_NODE;
const child=spawn(path.join(runtime,path.basename(executable)),['--user-data-dir='+path.join(data,'profile'),'--remote-debugging-port='+reserved.port],{env:environment,windowsHide:true,stdio:'ignore'});
/** @type {Awaited<ReturnType<typeof connectPage>>|null} */ let page=null;
try {
  await waitForPort(reserved.port,15000);page=await connectPage(reserved.port,origin);
  await page.waitFor('document.readyState === "complete" && location.origin === '+JSON.stringify(origin),{timeout:10000,interval:50,label:'AVIF browser page'});
  const result=await page.eval('(async()=> (await import('+JSON.stringify(origin+'/test/avif-codec-browser-page.js')+')).run())()',{awaitPromise:true,userGesture:true});
  console.log(JSON.stringify(result));
  fs.mkdirSync(path.join(root,'.qa-tools/results'),{recursive:true});fs.writeFileSync(path.join(root,'.qa-tools/results/avif-codec-browser.json'),JSON.stringify(result,null,2)+'\n');
} finally {
  page?.close();
  if(child.exitCode===null&&child.pid) {
    const stopped=spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,encoding:'utf8'});
    if(stopped.error)throw stopped.error;
    if(stopped.status!==0)throw new Error('Could not stop owned AVIF Electron test process '+child.pid+': '+stopped.stderr);
  }
  server.close();await once(server,'close');
}
