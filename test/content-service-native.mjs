// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {mediaObject} from '../public/js/chat-protocol.js';
const root=fileURLToPath(new URL('..',import.meta.url));
/** @param {string} location @returns {void} */
function directory(location){const stat=fs.lstatSync(location);assert.equal(stat.isSymbolicLink(),false);assert.equal(stat.isDirectory(),true);}

test('actual Electron content service uses two DPAPI vaults, signed workspaces, AVIF decoding and contextBridge typed arrays',{timeout:90000},async()=>{
  assert.equal(process.platform,'win32');
  const source=path.join(root,'.qa-tools','screen-diagnostics-runtime'),sourceApp=path.join(source,'resources','app'),sourceAsar=path.join(source,'resources','app.asar');
  directory(root);directory(path.join(root,'.qa-tools'));directory(source);
  const runtime=fs.mkdtempSync(path.join(root,'.qa-tools','content-service-native-')),data=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-content-service-native-'));
  /** @type {import('node:child_process').ChildProcess|null} */let child=null;
  try{
    fs.cpSync(source,runtime,{recursive:true,filter:entry=>{if(entry===sourceApp||entry.startsWith(sourceApp+path.sep)||entry===sourceAsar)return false;assert.equal(fs.lstatSync(entry).isSymbolicLink(),false);return true;}});
    const entry=path.join(runtime,'resources','app');fs.mkdirSync(entry,{recursive:true});
    fs.writeFileSync(path.join(entry,'package.json'),JSON.stringify({name:'deepscord-content-service-native',version:'1.0.0',main:'main.cjs'}));
    fs.writeFileSync(path.join(entry,'main.cjs'),'require('+JSON.stringify(path.join(root,'test','content-service-native-main.cjs'))+');');
    /** @type {NodeJS.ProcessEnv} */const env={...process.env,CONTENT_SERVICE_NATIVE_DIRECTORY:data};delete env.ELECTRON_RUN_AS_NODE;
    child=spawn(path.join(runtime,'Deepscord.exe'),[],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    /** @type {Buffer[]} */const output=[];child.stdout?.on('data',chunk=>output.push(Buffer.from(chunk)));child.stderr?.on('data',chunk=>output.push(Buffer.from(chunk)));
    const timer=setTimeout(()=>child?.kill(),60000);
    try{const [code,signal]=await once(child,'exit');assert.equal(signal,null);assert.equal(code,0,Buffer.concat(output).toString('utf8').slice(-12000));}finally{clearTimeout(timer);}
    const report=mediaObject(JSON.parse(fs.readFileSync(path.join(data,'report.json'),'utf8')),'Native content service report');
    for(const field of ['asyncProtection','credentials','fullHistory','bidirectionalChat','bidirectionalMedia','codecValidated','bridgeTypedArray','restored'])assert.equal(report[field],true,field);
    assert.equal(report.identities,2);assert.equal(report.vaults,2);console.log(JSON.stringify({event:'content_service_native_verified',...report}));
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
    assert.equal(path.dirname(data),os.tmpdir());assert(path.basename(data).startsWith('deepscord-content-service-native-'));directory(data);fs.rmSync(data,{recursive:true,force:true});
    assert.equal(path.dirname(runtime),path.join(root,'.qa-tools'));assert(path.basename(runtime).startsWith('content-service-native-'));directory(runtime);fs.rmSync(runtime,{recursive:true,force:true});
  }
});
