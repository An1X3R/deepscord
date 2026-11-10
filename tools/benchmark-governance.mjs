// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash,createPrivateKey,createPublicKey,sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import currentGovernance from '../lib/server-governance.cjs';
import currentStore from '../lib/governance-store.cjs';
import currentWorkspace from '../desktop/workspace-store.cjs';
import currentSteam from '../lib/steam-state.cjs';
import replica from '../lib/room-replica.cjs';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../lib/server-governance.cjs').GovernanceJournal} Journal */
/** @typedef {import('../lib/server-governance.cjs').GovernanceCommand} Command */
/** @typedef {import('../lib/server-governance.cjs').GovernanceEvent} GovernanceEvent */
/** @typedef {import('../lib/room-replica.cjs').RoomDescriptor} Descriptor */
/** @typedef {Pick<typeof currentGovernance,'createGovernance'|'parseGovernance'|'governanceState'|'governancePayload'|'appendGovernance'>} GovernanceApi */
/** @typedef {{label:string,governance:GovernanceApi,store:typeof currentStore,workspace:typeof currentWorkspace,steam:Pick<typeof currentSteam,'parseSteamCheckpoint'>,verifier:typeof currentGovernance.createGovernanceVerifier|null,reader:typeof currentSteam.createSteamStateReader|null}} Modules */
/** @typedef {{events:number,bytes:number,parseMs:number,stateMs:number,payloadMs:number,appendMs:number,sameRestoreMs:number,sameWorkspaceSaveMs:number,sameRoomCommitMs:number,sameWorkspaceSaveWrote:boolean,sameRoomCommitWrote:boolean,cachedVerifyMs:number|null,cachedStateMs:number|null,cachedAppendMs:number|null,checkpointMs:number,cachedCheckpointMs:number|null}} Measurement */

const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
const baselineRoot=path.join(root,'dist','server-domains-roles-20261105','Deepscord-win32-x64','resources','app');
if(!fs.existsSync(path.join(baselineRoot,'app-server','lib','server-governance.cjs')))throw new Error('The unchanged release governance baseline is missing: ' + baselineRoot);
/** @type {Modules[]} */
const modules=[
  {label:'release-baseline',governance:require(path.join(baselineRoot,'app-server','lib','server-governance.cjs')),store:require(path.join(baselineRoot,'app-server','lib','governance-store.cjs')),workspace:require(path.join(baselineRoot,'workspace-store.cjs')),steam:require(path.join(baselineRoot,'app-server','lib','steam-state.cjs')),verifier:null,reader:null},
  {label:'current',governance:currentGovernance,store:currentStore,workspace:currentWorkspace,steam:currentSteam,verifier:currentGovernance.createGovernanceVerifier,reader:currentSteam.createSteamStateReader},
];
// This fixed key is public test material, never a deployment credential.
const privateKey=createPrivateKey({key:Buffer.from('302e020100300506032b657004220420'+'9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60','hex'),format:'der',type:'pkcs8'});
const creatorKey=createPublicKey(privateKey).export({format:'der',type:'spki'}).toString('base64');
/** @type {Descriptor} */
const descriptor={version:1,roomId:'12345678-1234-4234-8234-123456789abc',creatorKey};

/** @param {JsonValue} value @returns {string} */
function hash(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
/** @param {number} count @returns {Journal} */
function chain(count){
  let journal=currentGovernance.createGovernance(descriptor);
  for(let index=0;index<count;index++){
    /** @type {Command} */const command={type:'renameServer',name:'Name-'+index};
    const payload=JSON.stringify(['deepscord-governance-v1',1,descriptor.roomId,creatorKey,index+1,journal.digest,creatorKey,command]);
    /** @type {GovernanceEvent} */const event={revision:index+1,previousDigest:journal.digest,actorKey:creatorKey,command,signature:sign(null,Buffer.from(payload),privateKey).toString('base64')};
    journal={...journal,events:[...journal.events,event],digest:hash(['deepscord-governance-event-v1',descriptor.roomId,creatorKey,event])};
  }
  return currentGovernance.parseGovernance(journal,descriptor);
}
/** @param {()=>void} operation @returns {number} */
function median(operation){
  operation();
  const samples=Array.from({length:5},()=>{const started=performance.now();operation();return performance.now()-started;}).sort((a,b)=>a-b);
  return Number(samples[2].toFixed(3));
}
/** @param {string} filename @param {()=>void} operation @returns {{milliseconds:number,wrote:boolean}} */
function diskMeasurement(filename,operation){
  const historical=new Date('2000-01-01T00:00:00Z');fs.utimesSync(filename,historical,historical);
  const before=fs.statSync(filename,{bigint:true}).mtimeNs;
  const milliseconds=median(operation);
  return {milliseconds,wrote:fs.statSync(filename,{bigint:true}).mtimeNs!==before};
}
/** @param {Modules} implementation @param {Journal} journal @param {string} directory @returns {Measurement} */
function measure(implementation,journal,directory){
  fs.mkdirSync(directory,{recursive:true});
  /** @type {Command} */const command={type:'renameServer',name:'Next'};
  const payload=implementation.governance.governancePayload(journal,creatorKey,command);
  /** @type {GovernanceEvent} */const event={revision:journal.events.length+1,previousDigest:journal.digest,actorKey:creatorKey,command,signature:sign(null,Buffer.from(payload),privateKey).toString('base64')};
  const store=implementation.store.openGovernanceStore({dataDir:directory,descriptor,seed:journal,authority:false,signAuthority:message=>sign(null,Buffer.from(message),privateKey).toString('base64')});
  const workspaceDirectory=path.join(directory,'workspace'),workspace=implementation.workspace.createWorkspaceStore(workspaceDirectory);
  const entry=workspace.saveConnection({mode:'server',role:'guest',address:'http://127.0.0.1:1234',invite:'',hostAddress:'',hostPort:0,appId:0,stunUrls:[]},null);
  const document=replica.createRoomDocument(descriptor,1,[{id:'srv-main',name:'Domain',icon:'D',color:'#123456',channels:[{id:'ch-chat',name:'Chat',type:'text',userLimit:0}]}]);
  const checkpoint={version:1,lobbyId:'109775244000000001',ownerId:'76561198000000001',epoch:'1'.repeat(32),sequence:1,stunUrls:[],store:{version:1,servers:document.servers,messages:{},governance:journal},users:[],roomDocument:document};
  workspace.commit(entry,document);workspace.saveServerGovernance(entry,journal);
  const filename=path.join(workspaceDirectory,'workspace.json');
  const save=diskMeasurement(filename,()=>workspace.saveServerGovernance(entry,journal));
  const commit=diskMeasurement(filename,()=>workspace.commit(entry,document));
  const verifier=implementation.verifier ? implementation.verifier({maxEntries:4,maxBytes:8*1024*1024}) : null;
  if(verifier)verifier.verify(journal,descriptor);
  const reader=implementation.reader ? implementation.reader({maxEntries:4,maxBytes:8*1024*1024}) : null;
  if(reader)reader.parseCheckpoint(checkpoint);
  return {
    events:journal.events.length,bytes:Buffer.byteLength(JSON.stringify(journal)),
    parseMs:median(()=>{implementation.governance.parseGovernance(journal,descriptor);}),
    stateMs:median(()=>{implementation.governance.governanceState(journal);}),
    payloadMs:median(()=>{implementation.governance.governancePayload(journal,creatorKey,command);}),
    appendMs:median(()=>{implementation.governance.appendGovernance(journal,event);}),
    sameRestoreMs:median(()=>{store.restore(journal);}),sameWorkspaceSaveMs:save.milliseconds,sameRoomCommitMs:commit.milliseconds,
    sameWorkspaceSaveWrote:save.wrote,sameRoomCommitWrote:commit.wrote,
    cachedVerifyMs:verifier ? median(()=>{verifier.verify(journal,descriptor);}) : null,
    cachedStateMs:verifier ? median(()=>{verifier.state(journal);}) : null,
    cachedAppendMs:verifier ? median(()=>{verifier.append(journal,event);}) : null,
    checkpointMs:median(()=>{implementation.steam.parseSteamCheckpoint(checkpoint);}),
    cachedCheckpointMs:reader ? median(()=>{reader.parseCheckpoint({...checkpoint,sequence:2});}) : null,
  };
}
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-governance-benchmark-'));
/** @type {{implementation:string,measurement:Measurement}[]} */const results=[];
try{
  for(const count of [10,100,500]){
    const journal=chain(count);
    for(const implementation of modules){
      const measurement=measure(implementation,journal,path.join(temporary,implementation.label,String(count)));
      results.push({implementation:implementation.label,measurement});
      console.log(JSON.stringify({implementation:implementation.label,...measurement}));
    }
  }
  const output=path.join(root,'.qa-tools','results','governance-performance');fs.mkdirSync(output,{recursive:true});
  const filename=path.join(output,new Date().toISOString().replace(/[:.]/g,'-')+'.json');
  fs.writeFileSync(filename,JSON.stringify({node:process.version,samples:5,statistic:'median',baselineRoot,results},null,2));
  console.log(JSON.stringify({event:'governance_benchmark_finished',report:filename}));
}finally{
  if(path.dirname(temporary)!==os.tmpdir() || !path.basename(temporary).startsWith('deepscord-governance-benchmark-'))throw new Error('Benchmark cleanup target differs from its owned temporary directory');
  fs.rmSync(temporary,{recursive:true,force:true});
}
