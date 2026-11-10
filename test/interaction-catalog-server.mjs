// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import governance from '../lib/server-governance.cjs';
import {customInteractions} from '../public/js/customization-protocol.js';
import {identity,launch,stop,connect,authenticate,send,receive,object,journal,change,signedEvent} from './server-ws-helpers.mjs';

test('actual server persists unified server catalog edits and permanent deletions across restart',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-catalog-server-'));
  let backend=await launch(directory,{});
  try {
    const actor=identity(),client=await connect(backend,'Owner');await authenticate(client,actor);
    const cursor=send(client,{t:'claimOwner',token:fs.readFileSync(path.join(directory,'owner-claim.txt'),'utf8').trim()});
    let current=journal(await receive(client,cursor,message=>message.t==='serverState' && object(message.policy).ownerKey===actor.key,'claim owner'));
    current=await change(client,actor,current,{type:'putInteraction',domainId:null,interaction:{id:'existing',name:'Existing',thumbnail:null,model:'bomb',trajectory:'linear',sound:'none',durationMs:700}});
    const before=current.events.length;
    current=await change(client,actor,current,{type:'migrateServerCatalog'});
    assert.equal(current.events.length,before+1);
    const policy=governance.governanceState(current),entries=customInteractions(policy,null);
    assert.equal(entries.length,5);assert.equal(policy.interactionCatalogVersion,2);
    const fist=entries.find(entry=>entry.id==='playful-fist');assert(fist);
    current=await change(client,actor,current,{type:'putInteraction',domainId:null,interaction:{...fist,name:'Edited global fist'}});
    current=await change(client,actor,current,{type:'deleteInteraction',domainId:null,interactionId:'default-poop'});
    const saved=JSON.stringify(current);
    await stop(backend);backend=await launch(directory,{});
    const rejoined=await connect(backend,'Owner rejoined');
    const snapshot=await authenticate(rejoined,actor),restored=journal(snapshot),restoredPolicy=governance.governanceState(restored);
    assert.equal(JSON.stringify(restored),saved);
    assert.equal(restoredPolicy.interactionCatalogVersion,2);
    assert.equal(customInteractions(restoredPolicy,null).find(entry=>entry.id===fist.id)?.name,'Edited global fist');
    assert.equal(customInteractions(restoredPolicy,'srv-main').find(entry=>entry.id===fist.id)?.name,'Edited global fist');
    assert.equal(customInteractions(restoredPolicy,null).some(entry=>entry.id==='default-poop'),false);
    assert.equal(customInteractions(restoredPolicy,'srv-main').some(entry=>entry.id==='default-poop'),false);
    const requestId=randomUUID(),retry=send(rejoined,{t:'governanceChange',event:signedEvent(restored,actor,{type:'migrateServerCatalog'}),requestId});
    const rejected=await receive(rejoined,retry,message=>message.t==='governanceResult' && message.requestId===requestId,'reject repeated initialization');
    assert.equal(rejected.ok,false);
    assert.equal(fs.readFileSync(path.join(directory,'server-governance.json'),'utf8').includes('default-poop'),true,'Deleted event history must remain signed');
    const final=governance.parseGovernance(JSON.parse(fs.readFileSync(path.join(directory,'server-governance.json'),'utf8')),{version:1,roomId:restored.roomId,creatorKey:restored.creatorKey});
    assert.equal(final.digest,restored.digest);
  } finally {
    await stop(backend);assert.equal(path.dirname(directory),os.tmpdir());assert(path.basename(directory).startsWith('deepscord-catalog-server-'));fs.rmSync(directory,{recursive:true,force:true});
  }
});


test('actual server migrates signed legacy domain catalogs with collisions and rejects former domain managers across restart',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-catalog-server-'));
  let backend=await launch(directory,{});
  try {
    const owner=identity(),admin=identity(),local=identity(),client=await connect(backend,'Legacy owner');await authenticate(client,owner);
    const claim=send(client,{t:'claimOwner',token:fs.readFileSync(path.join(directory,'owner-claim.txt'),'utf8').trim()});
    let current=journal(await receive(client,claim,message=>message.t==='serverState' && object(message.policy).ownerKey===owner.key,'legacy owner claim'));
    current=await change(client,owner,current,{type:'setServerAdmin',memberKey:admin.key,enabled:true});
    current=await change(client,owner,current,{type:'setDomainOwner',domainId:'srv-main',memberKey:local.key});
    await stop(backend);
    const interaction={id:'collision',name:'Global definition',thumbnail:null,model:/** @type {const} */('bomb'),trajectory:/** @type {const} */('linear'),sound:/** @type {const} */('none'),durationMs:700};
    for(const command of [
      {type:/** @type {const} */('putInteraction'),domainId:null,interaction},
      {type:/** @type {const} */('putInteraction'),domainId:'srv-main',interaction:{...interaction,name:'Domain definition'}},
    ]){
      const actor=command.domainId===null ? owner : local;
      const event=signedEvent(current,actor,governance.parseGovernanceCommand(command));
      const digest=createHash('sha256').update(JSON.stringify(['deepscord-governance-event-v1',current.roomId,current.creatorKey,event])).digest('hex');
      current=governance.parseGovernance({...current,events:[...current.events,event],digest},current);
    }
    fs.writeFileSync(path.join(directory,'server-governance.json'),JSON.stringify(current));
    const history=JSON.stringify(current.events);
    backend=await launch(directory,{});
    const adminClient=await connect(backend,'Migrating server admin'),snapshot=await authenticate(adminClient,admin);
    assert.deepEqual(journal(snapshot),current);
    current=await change(adminClient,admin,current,{type:'migrateServerCatalog'});
    assert.equal(JSON.stringify(current.events.slice(0,-1)),history);
    const entries=customInteractions(governance.governanceState(current),'srv-night');
    assert.equal(entries.length,6);
    assert.equal(entries.find(entry=>entry.name==='Domain definition')?.id,'collision-migrated-1');
    const localClient=await connect(backend,'Former catalog manager');await authenticate(localClient,local);
    const requestId=randomUUID(),cursor=send(localClient,{t:'governanceChange',event:signedEvent(current,local,{type:'deleteInteraction',domainId:null,interactionId:'collision-migrated-1'}),requestId});
    const denied=await receive(localClient,cursor,message=>message.t==='governanceResult' && message.requestId===requestId,'reject domain manager catalog deletion');
    assert.equal(denied.ok,false);
    current=await change(adminClient,admin,current,{type:'deleteInteraction',domainId:null,interactionId:'collision-migrated-1'});
    const saved=JSON.stringify(current);
    await stop(backend);backend=await launch(directory,{});
    const reader=await connect(backend,'Restored server admin'),restored=journal(await authenticate(reader,admin));
    assert.equal(JSON.stringify(restored),saved);
    assert.equal(customInteractions(governance.governanceState(restored),'srv-night').some(entry=>entry.name==='Domain definition'),false);
  } finally {
    await stop(backend);assert.equal(path.dirname(directory),os.tmpdir());assert(path.basename(directory).startsWith('deepscord-catalog-server-'));fs.rmSync(directory,{recursive:true,force:true});
  }
});
