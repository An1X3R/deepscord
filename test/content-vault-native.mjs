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
function requireLocalDirectory(location){assert.equal(fs.lstatSync(location).isSymbolicLink(),false);assert.equal(fs.statSync(location).isDirectory(),true);}
/** @param {string} binary @param {string} directory @param {number} generation @returns {Promise<void>} */
async function launch(binary,directory,generation){
  /** @type {NodeJS.ProcessEnv} */const env={...process.env,CONTENT_VAULT_TEST_DIRECTORY:directory,CONTENT_VAULT_TEST_GENERATION:String(generation)};
  delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(binary,[],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  /** @type {Buffer[]} */const output=[];
  child.stdout.on('data',chunk=>output.push(Buffer.from(chunk)));child.stderr.on('data',chunk=>output.push(Buffer.from(chunk)));
  const timeout=setTimeout(()=>child.kill(),45000);
  try{
    const [code,signal]=await once(child,'exit');
    const log=Buffer.concat(output).toString('utf8');fs.writeFileSync(path.join(directory,'generation-'+generation+'.log'),log);
    assert.equal(signal,null,'Native vault process must exit normally');assert.equal(code,0,'Native vault generation '+generation+' failed: '+log.slice(-12000));
    const report=mediaObject(JSON.parse(fs.readFileSync(path.join(directory,'generation-'+generation+'.json'),'utf8')),'Native generation report');
    assert.equal(report.generation,generation);assert.equal(report.asyncProtection,true);assert.equal(report.persistedKeyConcealed,true);assert.equal(report.clonedKeyDecrypts,true);
  }finally{clearTimeout(timeout);if(child.exitCode===null && child.signalCode===null)child.kill();}
}

test('actual Electron Windows DPAPI vault survives three process generations and imports the same room key',{timeout:180000},async()=>{
  assert.equal(process.platform,'win32');
  const source=path.join(root,'.qa-tools','screen-diagnostics-runtime'),sourceBinary=path.join(source,'Deepscord.exe');
  requireLocalDirectory(root);requireLocalDirectory(path.join(root,'.qa-tools'));requireLocalDirectory(source);assert.equal(fs.lstatSync(sourceBinary).isFile(),true);
  const runtime=fs.mkdtempSync(path.join(root,'.qa-tools','content-vault-native-')),directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-content-vault-native-'));
  try{
    const sourceApp=path.join(source,'resources','app'),sourceAsar=path.join(source,'resources','app.asar');
    fs.cpSync(source,runtime,{recursive:true,filter:entry=>{if(entry===sourceApp || entry.startsWith(sourceApp+path.sep) || entry===sourceAsar)return false;assert.equal(fs.lstatSync(entry).isSymbolicLink(),false,'Native runtime copy must not follow links');return true;}});
    const entry=path.join(runtime,'resources','app');fs.mkdirSync(entry,{recursive:true});
    fs.writeFileSync(path.join(entry,'package.json'),JSON.stringify({name:'deepscord-content-vault-native',version:'1.0.0',main:'main.cjs'}));
    fs.writeFileSync(path.join(entry,'main.cjs'),'require('+JSON.stringify(path.join(root,'test','content-vault-native-main.cjs'))+');');
    for(const generation of [1,2,3])await launch(path.join(runtime,'Deepscord.exe'),directory,generation);
    const final=mediaObject(JSON.parse(fs.readFileSync(path.join(directory,'generation-3.json'),'utf8')),'Native final report');
    assert.deepEqual(final.nonceCounters,[0,1,1024,2048]);assert.deepEqual(final.cloneNonceCounters,[0,1024,2048]);
    console.log(JSON.stringify({event:'content_vault_native_verified',electron:final.electron,generations:3,nonceCounters:final.nonceCounters,cloneNonceCounters:final.cloneNonceCounters,dpapiFiles:2}));
  }finally{
    assert.equal(path.dirname(directory),os.tmpdir());assert(path.basename(directory).startsWith('deepscord-content-vault-native-'));requireLocalDirectory(directory);fs.rmSync(directory,{recursive:true,force:true});
    assert.equal(path.dirname(runtime),path.join(root,'.qa-tools'));assert(path.basename(runtime).startsWith('content-vault-native-'));requireLocalDirectory(runtime);fs.rmSync(runtime,{recursive:true,force:true});
  }
});
