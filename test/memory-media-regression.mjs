// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{pid:number,parentPid:number,name:string,privateCommittedBytes:number,workingSetBytes:number}} ProcessSample */
/** @typedef {{stage:string,index:number,at:string,privateCommittedBytes:number,processCount:number,processes:ProcessSample[]}} MemorySample */
/** @typedef {{round:number,stage:string,privateCommittedMiBMedian:number,privateCommittedMiBMin:number,privateCommittedMiBMax:number,processCountMedian:number,samples:MemorySample[]}} StageResult */
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=process.env.ELECTRON_TEST_BINARY;assert(source,'ELECTRON_TEST_BINARY must identify a real Electron runtime');const binary=fs.realpathSync(source);
const target=process.env.DEEPSCORD_MEMORY_APP;assert(target,'DEEPSCORD_MEMORY_APP must identify the packaged resources/app directory');const production=fs.realpathSync(target);
const rounds=Number(process.env.DEEPSCORD_MEMORY_MEDIA_ROUNDS ?? '1');assert(Number.isInteger(rounds) && rounds>=1 && rounds<=3,'DEEPSCORD_MEMORY_MEDIA_ROUNDS must be between one and three');
const directory=fs.mkdtempSync(path.join(root,'.qa-tools','memory-media-regression-')),runtime=path.join(directory,'runtime'),sourceDirectory=path.dirname(path.resolve(source)),originalApp=path.join(sourceDirectory,'resources','app');
const output=path.resolve(process.env.DEEPSCORD_MEMORY_MEDIA_OUTPUT ?? directory);fs.mkdirSync(output,{recursive:true});
const runFile=promisify(execFile);
/** @param {number} milliseconds @returns {Promise<void>} */function delay(milliseconds){return new Promise(resolve=>setTimeout(resolve,milliseconds));}
/** @param {number[]} values @returns {number} */function median(values){assert(values.length>0);const ordered=[...values].sort((left,right)=>left-right),index=Math.floor(ordered.length/2);return ordered.length%2===0?(ordered[index-1]+ordered[index])/2:ordered[index];}
/** @param {JsonValue} value @returns {ProcessSample} */
function parseProcess(value){
  assert(value && typeof value==='object' && !Array.isArray(value));
  const {pid,parentPid,name,privateCommittedBytes,workingSetBytes}=value;
  assert(typeof pid==='number' && Number.isSafeInteger(pid) && pid>0);assert(typeof parentPid==='number' && Number.isSafeInteger(parentPid) && parentPid>=0);assert(typeof name==='string');assert(typeof privateCommittedBytes==='number' && Number.isSafeInteger(privateCommittedBytes) && privateCommittedBytes>=0);assert(typeof workingSetBytes==='number' && Number.isSafeInteger(workingSetBytes) && workingSetBytes>=0);
  return{pid,parentPid,name,privateCommittedBytes,workingSetBytes};
}
const files=['capture-ipc.cjs','preload.js','app-server/public/js/peer-link.js','app-server/public/js/microphone-graph.js','app-server/public/js/desktop-capture.js'];
const sourceHashes=Object.fromEntries(files.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(production,file))).digest('hex')]));
fs.cpSync(sourceDirectory,runtime,{recursive:true,filter:entry=>entry!==originalApp && !entry.startsWith(originalApp+path.sep) && entry!==path.join(sourceDirectory,'resources','app.asar')});
const entry=path.join(runtime,'resources','app');fs.mkdirSync(entry,{recursive:true});fs.writeFileSync(path.join(entry,'package.json'),JSON.stringify({name:'memory-media-regression',version:'1.0.0',main:'main.cjs'}));fs.writeFileSync(path.join(entry,'main.cjs'),'require('+JSON.stringify(path.join(root,'test/memory-media-regression-main.cjs'))+');');
/** @type {StageResult[]} */const results=[];
/** @param {number} round @returns {Promise<void>} */
async function run(round){
  const data=path.join(directory,'round-'+round);fs.mkdirSync(data);
  /** @type {import('node:child_process').ChildProcess[]} */const children=[];
  try{
    const tone=spawn(path.join(root,'.qa-tools/process-capture/tone.exe'),['431'],{windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(tone);await once(tone.stdout,'data');
    const visual=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'desktop/capture-window-test.ps1')],{windowsHide:false,stdio:['ignore','pipe','pipe']});children.push(visual);await once(visual.stdout,'data');
    /** @type {NodeJS.ProcessEnv} */const environment={...process.env,DEEPSCORD_MEMORY_APP:production,DEEPSCORD_MEMORY_MEDIA_DATA:data,DEEPSCORD_MEMORY_MEDIA_TONE_PID:String(tone.pid)};delete environment.ELECTRON_RUN_AS_NODE;
    const child=spawn(path.join(runtime,path.basename(binary)),[],{cwd:root,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);assert(child.pid);const rootPid=child.pid;
    let outputLog='';child.stdout?.on('data',chunk=>{outputLog+=String(chunk);});child.stderr?.on('data',chunk=>{outputLog+=String(chunk);});
    const exited=once(child,'exit');const timer=setTimeout(()=>child.kill(),90000);
    try{
      for(const stage of ['voice-only','voice-with-window-share']){
        const request=path.join(data,'stage-'+stage+'.json'),response=path.join(data,'samples-'+stage+'.json'),deadline=Date.now()+40000;
        while(!fs.existsSync(request)){assert(child.exitCode===null && child.signalCode===null,outputLog);assert(Date.now()<deadline,'Timed out awaiting stable media stage '+stage);await delay(100);}
        /** @type {JsonValue} */const rawRequest=JSON.parse(fs.readFileSync(request,'utf8'));assert(rawRequest && typeof rawRequest==='object' && !Array.isArray(rawRequest));assert.equal(rawRequest.pid,rootPid);assert.equal(rawRequest.stage,stage);
        /** @type {MemorySample[]} */const samples=[];
        for(let index=0;index<3;index++){
          if(index>0)await delay(1000);
          const {stdout}=await runFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'test/memory-lifecycle-processes.ps1'),'-RootPid',String(rootPid)],{windowsHide:true,timeout:15000});
          /** @type {JsonValue} */const raw=JSON.parse(stdout.trim());assert(Array.isArray(raw));const processes=raw.map(parseProcess);assert(processes.some(row=>row.pid===rootPid));
          const sample={stage,index,at:new Date().toISOString(),privateCommittedBytes:processes.reduce((sum,row)=>sum+row.privateCommittedBytes,0),processCount:processes.length,processes};samples.push(sample);
          console.log(JSON.stringify({round,stage,index,privateCommittedMiB:sample.privateCommittedBytes/1048576,processes:sample.processCount}));
        }
        const commits=samples.map(sample=>sample.privateCommittedBytes/1048576),result={round,stage,privateCommittedMiBMedian:median(commits),privateCommittedMiBMin:Math.min(...commits),privateCommittedMiBMax:Math.max(...commits),processCountMedian:median(samples.map(sample=>sample.processCount)),samples};results.push(result);fs.writeFileSync(response,JSON.stringify(result,null,2));fs.writeFileSync(path.join(output,'round-'+round+'-'+stage+'.json'),JSON.stringify(result,null,2));
      }
      const [code]=await exited;assert.equal(code,0,outputLog);
      /** @type {JsonValue} */const report=JSON.parse(fs.readFileSync(path.join(data,'report.json'),'utf8'));assert(report && typeof report==='object' && !Array.isArray(report));assert.equal(report.passed,true);assert.equal(report.productionApp,production);fs.writeFileSync(path.join(output,'round-'+round+'-media-regression.json'),JSON.stringify(report,null,2));
    }finally{clearTimeout(timer);fs.writeFileSync(path.join(output,'round-'+round+'-native.log'),outputLog);}
  }finally{for(const child of children)if(child.exitCode===null && child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}}
}
for(let round=1;round<=rounds;round++)await run(round);
const summary=['voice-only','voice-with-window-share'].map(stage=>{const observations=results.filter(result=>result.stage===stage),commits=observations.map(result=>result.privateCommittedMiBMedian);return{stage,rounds:observations.length,privateCommittedMiBMedian:median(commits),privateCommittedMiBMin:Math.min(...commits),privateCommittedMiBMax:Math.max(...commits),processCountMedian:median(observations.map(result=>result.processCountMedian))};});
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:true,scope:'Isolated local production media components, not the full room UI or a real microphone. Both local peers are included. Source tone/window and the PowerShell sampler are outside the measured Electron root PID tree.',definition:'Private committed bytes summed only over the test Electron root PID tree; not RSS. Each stage waits 1.5 seconds then takes three samples. Summary is the median and range of per-round stage medians. All raw process samples are retained.',productionApp:production,electronRuntime:sourceDirectory,sourceHashes,rounds,summary,results},null,2));console.log('ARTIFACTS '+output);
