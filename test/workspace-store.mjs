// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,randomBytes,verify} from 'node:crypto';
import {test} from 'node:test';
import {createWorkspaceStore,parseWorkspace} from '../desktop/workspace-store.cjs';
import {createRoomDocument,verifyRoomVote} from '../lib/room-replica.cjs';
import {steamInvite} from '../desktop/steam-wire.cjs';
import {createGovernance,appendGovernance} from '../lib/server-governance.cjs';
import {identityPayload} from '../lib/server-identity.cjs';

test('workspace signs pinned identity and caches append-only authorized governance across restart',() => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-governance-'));
  try {
    const workspace=createWorkspaceStore(directory);
    const entryId=workspace.saveConnection({mode:'server',role:'guest',address:'http://127.0.0.1:8080/',invite:'',hostAddress:'',hostPort:0,appId:0,stunUrls:[]},null);
    const seed=workspace.seed(null);
    const descriptor={version:/** @type {const} */ (1),roomId:seed.roomId,creatorKey:seed.creatorKey};
    const challenge={roomId:seed.roomId,creatorKey:seed.creatorKey,nonce:randomBytes(32).toString('hex'),userId:'user_1'};
    const proof=workspace.signServerIdentity(entryId,challenge);
    assert.equal(proof.memberKey,seed.creatorKey);
    assert.equal(verify(null,Buffer.from(identityPayload(challenge)),{key:Buffer.from(proof.memberKey,'base64'),format:'der',type:'spki'},Buffer.from(proof.signature,'base64')),true);
    assert.throws(()=>workspace.signServerIdentity(entryId,{...challenge,roomId:randomUUID()}),/pinned/);
    const initial=createGovernance(descriptor);
    workspace.saveServerGovernance(entryId,initial);
    const change=workspace.signGovernanceChange(entryId,{journal:initial,command:{type:'renameServer',name:'Connection server'}});
    const renamed=appendGovernance(initial,change.event);
    const fork=appendGovernance(initial,workspace.signGovernanceChange(entryId,{journal:initial,command:{type:'renameServer',name:'Fork'}}).event);
    workspace.saveServerGovernance(entryId,renamed);
    workspace.saveServerGovernance(entryId,renamed);
    assert.throws(()=>workspace.saveServerGovernance(entryId,initial),/rollback|fork/);
    assert.throws(()=>workspace.saveServerGovernance(entryId,fork),/rollback|fork/);
    assert.throws(()=>workspace.signGovernanceChange(entryId,{journal:initial,command:{type:'renameServer',name:'Stale'}}),/changed/);
    workspace.commit(entryId,createRoomDocument(descriptor,0,[]));
    assert.equal(workspace.list()[0].name,'Connection server');
    const restored=createWorkspaceStore(directory);
    assert.equal(restored.seed(entryId).governance?.digest,renamed.digest);
    assert.equal(restored.signServerIdentity(entryId,challenge).governance?.digest,renamed.digest);
    const outsider=createWorkspaceStore(path.join(directory,'outsider'));
    const outsiderId=outsider.saveConnection(workspace.get(entryId).connection,null);
    outsider.signServerIdentity(outsiderId,challenge);
    outsider.saveServerGovernance(outsiderId,renamed);
    assert.throws(()=>outsider.signGovernanceChange(outsiderId,{journal:renamed,command:{type:'renameServer',name:'Unauthorized'}}),/owner|permission|authorized/i);
  } finally { assert.equal(path.dirname(directory),os.tmpdir());fs.rmSync(directory,{recursive:true,force:true}); }
});

test('workspace persists identity, verified votes, conflict copies and reconnect identity pins',() => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-workspace-'));
  try {
    const workspace=createWorkspaceStore(directory);
    /** @type {import('../desktop/workspace-store.cjs').Connection} */
    const connection={mode:'steam',role:'host',address:'',invite:steamInvite({appId:480,lobbyId:'76561198000000000',token:randomBytes(32).toString('base64url')}),hostAddress:'',hostPort:0,appId:480,stunUrls:[]};
    const entryId=workspace.saveConnection(connection,null);
    const seed=workspace.seed(null);
    /** @type {import('../lib/room-replica.cjs').RoomDescriptor} */
    const descriptor={version:1,roomId:seed.roomId,creatorKey:seed.creatorKey};
    /** @type {import('../lib/steam-state.cjs').RoomServer[]} */
    const servers=[{id:'main',name:'Original',icon:'D',color:'#56cfc3',channels:[{id:'voice',name:'Voice',type:'voice',userLimit:0}]}];
    const initial=createRoomDocument(descriptor,0,servers);
    const roundId=randomUUID();
    const initialVote=workspace.vote(entryId,{roundId,document:initial});
    assert.equal(initialVote.fresh,true);
    assert.equal(verifyRoomVote(initialVote,descriptor,roundId).memberKey,descriptor.creatorKey);
    const otherIdentity=createWorkspaceStore(path.join(directory,'other')).seed(null);
    const impersonated=createRoomDocument({...descriptor,creatorKey:otherIdentity.creatorKey},0,servers);
    assert.throws(()=>createWorkspaceStore(directory).vote(entryId,{roundId:randomUUID(),document:impersonated}),/创建者/);
    assert.throws(()=>workspace.preserveConflict(entryId,[initial,impersonated]),/创建者/);
    workspace.commit(entryId,initial);
    const restarted=createWorkspaceStore(directory);
    const restoredVote=restarted.vote(entryId,{roundId:randomUUID(),document:initial});
    assert.equal(restoredVote.fresh,false);
    assert.equal(restoredVote.memberKey,initialVote.memberKey);
    assert.deepEqual(restarted.seed(entryId).document,initial);
    const changed=createRoomDocument(descriptor,1,[{...servers[0],name:'Changed'}]);
    restarted.preserveConflict(entryId,[initial,changed]);
    assert.equal(restarted.get(entryId).conflicts.length,2);
    restarted.commit(entryId,changed);
    assert.equal(restarted.get(entryId).conflicts.length,2);
    const committed=restarted.get(entryId).document;assert(committed);
    assert.equal(committed.digest,changed.digest);
    const other=createRoomDocument({...descriptor,roomId:randomUUID()},0,servers);
    assert.throws(()=>restarted.commit(entryId,other),/ID/);
    const afterRejected=restarted.get(entryId).document;assert(afterRejected);
    assert.equal(afterRejected.digest,changed.digest);
    const metadata=restarted.list()[0];
    assert.equal('connection' in metadata,false);
    assert.equal('privateKey' in metadata,false);
    assert.equal('invite' in metadata,false);
    restarted.remove(entryId);
    assert.equal(createWorkspaceStore(directory).list().length,0);
    const filename=path.join(directory,'workspace.json');
    fs.writeFileSync(filename,'{broken');
    assert.throws(()=>createWorkspaceStore(directory),SyntaxError);
  } finally { assert.equal(path.dirname(directory),os.tmpdir());fs.rmSync(directory,{recursive:true,force:true}); }
});

test('folding actual persisted connections preserves every divergent document and conflict copy',() => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-workspace-fold-'));
  try {
    const workspace=createWorkspaceStore(directory);
    /** @type {import('../desktop/workspace-store.cjs').Connection} */
    const connection={mode:'steam',role:'guest',address:'',invite:steamInvite({appId:480,lobbyId:'76561198000000000',token:randomBytes(32).toString('base64url')}),hostAddress:'',hostPort:0,appId:480,stunUrls:[]};
    const firstId=workspace.saveConnection(connection,null);
    const secondId=workspace.saveConnection({...connection,invite:steamInvite({appId:480,lobbyId:'76561198000000001',token:randomBytes(32).toString('base64url')})},null);
    const seed=workspace.seed(null);
    /** @type {import('../lib/room-replica.cjs').RoomDescriptor} */
    const descriptor={version:1,roomId:seed.roomId,creatorKey:seed.creatorKey};
    /** @type {import('../lib/steam-state.cjs').RoomServer[]} */
    const servers=[{id:'main',name:'Original',icon:'D',color:'#56cfc3',channels:[{id:'voice',name:'Voice',type:'voice',userLimit:0}]}];
    const first=createRoomDocument(descriptor,3,servers);
    const second=createRoomDocument(descriptor,8,[{...servers[0],name:'Second'}]);
    const firstConflict=createRoomDocument(descriptor,1,[{...servers[0],name:'First conflict'}]);
    const secondConflict=createRoomDocument(descriptor,2,[{...servers[0],name:'Second conflict'}]);
    const filename=path.join(directory,'workspace.json');
    const disk=parseWorkspace(JSON.parse(fs.readFileSync(filename,'utf8')));
    const divergent={...disk,entries:disk.entries.map(entry=>({...entry,roomId:descriptor.roomId,creatorKey:descriptor.creatorKey,updatedAt:entry.id===firstId?10:20,document:entry.id===firstId?first:second,conflicts:[entry.id===firstId?firstConflict:secondConflict]}))};
    fs.writeFileSync(filename,JSON.stringify(divergent));
    const restored=createWorkspaceStore(directory);
    const vote=restored.vote(firstId,{roundId:randomUUID(),document:second});
    assert.equal(vote.fresh,false);
    assert.equal(vote.document.digest,first.digest);
    const expected=[first,second,firstConflict,secondConflict].map(document=>document.digest).sort();
    assert.deepEqual(restored.get(firstId).conflicts.map(document=>document.digest).sort(),expected);
    assert.equal(restored.list().length,1);
    assert(!restored.list().some(entry=>entry.id===secondId));
    assert.deepEqual(createWorkspaceStore(directory).get(firstId).conflicts.map(document=>document.digest).sort(),expected);
    const overflowCopies=Array.from({length:24},(_,index)=>createRoomDocument(descriptor,index,[{...servers[0],name:'Overflow '+index}]));
    fs.writeFileSync(filename,JSON.stringify({...divergent,entries:divergent.entries.map(entry=>({...entry,conflicts:entry.id===firstId?overflowCopies:[]}))}));
    const before=fs.readFileSync(filename,'utf8');
    const oversized=createWorkspaceStore(directory);
    assert.throws(()=>oversized.vote(firstId,{roundId:randomUUID(),document:second}),/24/);
    assert.equal(fs.readFileSync(filename,'utf8'),before);
    assert.equal(createWorkspaceStore(directory).list().length,2);
  } finally {assert.equal(path.dirname(directory),os.tmpdir());assert(path.basename(directory).startsWith('deepscord-workspace-fold-'));fs.rmSync(directory,{recursive:true,force:true});}
});

test('validated identical workspace updates preserve file timestamps and invalid histories never write',() => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-workspace-idempotent-'));
  try {
    const workspace=createWorkspaceStore(directory);
    /** @type {import('../desktop/workspace-store.cjs').Connection} */
    const connection={mode:'server',role:'guest',address:'http://127.0.0.1:1234',invite:'',hostAddress:'',hostPort:0,appId:0,stunUrls:[]};
    const entryId=workspace.saveConnection(connection,null),seed=workspace.seed(null);
    const descriptor={version:/** @type {const} */(1),roomId:seed.roomId,creatorKey:seed.creatorKey};
    const document=createRoomDocument(descriptor,0,[]),initial=createGovernance(descriptor);
    workspace.commit(entryId,document);workspace.saveServerGovernance(entryId,initial);
    const first=appendGovernance(initial,workspace.signGovernanceChange(entryId,{journal:initial,command:{type:'renameServer',name:'One'}}).event);
    const fork=appendGovernance(initial,workspace.signGovernanceChange(entryId,{journal:initial,command:{type:'renameServer',name:'Fork'}}).event);
    workspace.saveServerGovernance(entryId,first);
    const filename=path.join(directory,'workspace.json');
    fs.utimesSync(filename,new Date('2000-01-01T00:00:00Z'),new Date('2000-01-01T00:00:00Z'));
    const before=fs.readFileSync(filename,'utf8'),modified=fs.statSync(filename).mtimeMs,updatedAt=workspace.get(entryId).updatedAt;
    workspace.saveConnection(connection,entryId);workspace.saveConnection(connection,null);
    workspace.saveServerGovernance(entryId,first);workspace.commit(entryId,document);workspace.commit(entryId,document);
    assert.equal(fs.statSync(filename).mtimeMs,modified);assert.equal(workspace.get(entryId).updatedAt,updatedAt);
    assert.throws(()=>workspace.saveServerGovernance(entryId,fork),/rollback|fork/);
    assert.throws(()=>workspace.saveServerGovernance(entryId,{...first,events:[]}),/digest/);
    assert.throws(()=>workspace.commit(entryId,{...document,digest:'0'.repeat(64)}),/digest/);
    assert.throws(()=>workspace.saveConnection({...connection,hostPort:-1},entryId),/host port/);
    assert.equal(fs.statSync(filename).mtimeMs,modified);assert.equal(fs.readFileSync(filename,'utf8'),before);
    const stale=workspace.get(entryId);stale.name='External mutation';
    assert.equal(workspace.get(entryId).name,'One');
    const changed=createRoomDocument(descriptor,1,[]);workspace.commit(entryId,changed);
    assert.notEqual(fs.readFileSync(filename,'utf8'),before);
    assert.equal(createWorkspaceStore(directory).get(entryId).document?.revision,1);
  } finally {assert.equal(path.dirname(directory),os.tmpdir());fs.rmSync(directory,{recursive:true,force:true});}
});

