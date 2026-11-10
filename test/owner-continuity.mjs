// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createWorkspaceStore} from '../desktop/workspace-store.cjs';
import {createRoomDocument} from '../lib/room-replica.cjs';
import {parseSteamRoomSeed} from '../lib/steam-state.cjs';
import {createGovernance,appendGovernance} from '../lib/server-governance.cjs';
import {object,launch,stop,send,receive,connect,journal,structure,cleanup} from './server-ws-helpers.mjs';

/** @typedef {ReturnType<typeof createWorkspaceStore>} Workspace */
/** @typedef {import('./server-ws-helpers.mjs').Backend} Backend */
/** @typedef {import('./server-ws-helpers.mjs').Client} Client */
/** @typedef {import('./server-ws-helpers.mjs').Message} Message */
/** @typedef {import('../desktop/workspace-store.cjs').RoomSeed} RoomSeed */

/** @param {Workspace} workspace @returns {string} */
function entry(workspace) {
  return workspace.saveConnection({mode:'server',role:'guest',address:'http://127.0.0.1:8080',invite:'',hostAddress:'',hostPort:0,appId:0,stunUrls:[]},null);
}

/** @param {string} directory @param {RoomSeed} input @returns {Promise<Backend>} */
function reopen(directory,input) {
  const seed=parseSteamRoomSeed(input);
  fs.mkdirSync(directory,{recursive:true});
  const documentPath=path.join(directory,'seed.json');
  fs.writeFileSync(documentPath,JSON.stringify(seed.document));
  /** @type {NodeJS.ProcessEnv} */
  const environment={ECHO_ROOM_ID:seed.roomId,ECHO_ROOM_CREATOR_KEY:seed.creatorKey,ECHO_ROOM_SEED_PATH:documentPath};
  if(seed.governance) {
    const governancePath=path.join(directory,'governance-seed.json');
    fs.writeFileSync(governancePath,JSON.stringify(seed.governance));
    environment.ECHO_GOVERNANCE_SEED_PATH=governancePath;
  }
  return launch(directory,environment);
}

/** @param {Client} client @param {Workspace} workspace @param {string} entryId @returns {Promise<Message>} */
async function authenticateWorkspace(client,workspace,entryId) {
  const proof=workspace.signServerIdentity(entryId,client.challenge);
  const cursor=send(client,proof);
  const state=await receive(client,cursor,message=>message.t==='serverState' && message.selfKey===proof.memberKey,'persisted workspace identity');
  workspace.saveServerGovernance(entryId,object(state.journal));
  return state;
}

/** @param {Message} state @returns {string} */
function role(state) {
  assert(Array.isArray(state.capabilities));
  const capability=object(state.capabilities.find(value=>object(value).domainId==='srv-main'));
  assert.equal(typeof capability.role,'string');
  return /** @type {string} */ (capability.role);
}

/** @param {{client:Client,workspace:Workspace,entryId:string}[]} members @returns {Promise<void>} */
async function settle(members) {
  const last=members[members.length-1];assert(last);
  const offer=last.client.messages.slice().reverse().find(message=>message.t==='roomSyncOffer');assert(offer);
  const cursor=last.client.messages.length;
  for(const member of members)send(member.client,member.workspace.vote(member.entryId,offer));
  const committed=await receive(last.client,cursor,message=>message.t==='roomSyncCommit','normal workspace replica agreement');
  for(const member of members)member.workspace.commit(member.entryId,object(committed.document));
}

/** @param {Client} client @param {Workspace} workspace @param {string} entryId @returns {void} */
function saveStructure(client,workspace,entryId) {
  const committed=client.messages.slice().reverse().find(message=>message.t==='roomSyncCommit' && message.reason==='structure-change');assert(committed);
  workspace.commit(entryId,object(committed.document));
}

test('an ordinary member reopens a legacy room and the original owner regains management after signed rejoin and disk restart',{timeout:25000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-roles-owner-continuity-'));
  /** @type {Backend|null} */ let backend=null;
  try {
    const ownerDirectory=path.join(directory,'owner'),guestDirectory=path.join(directory,'guest');
    const owner=createWorkspaceStore(ownerDirectory),guest=createWorkspaceStore(guestDirectory);
    const ownerEntry=entry(owner),guestEntry=entry(guest),seed=owner.seed(null);
    const descriptor={version:/** @type {const} */(1),roomId:seed.roomId,creatorKey:seed.creatorKey};
    const document=createRoomDocument(descriptor,7,[{id:'srv-main',name:'Preserved domain',icon:'D',color:'#123456',channels:[{id:'ch-chat',name:'Chat',type:'text',userLimit:0}]}]);
    owner.commit(ownerEntry,document);guest.commit(guestEntry,document);
    assert.equal(guest.seed(guestEntry).governance,undefined);
    const guestRestored=createWorkspaceStore(guestDirectory),reopened=guestRestored.seed(guestEntry);
    assert.equal(reopened.roomId,seed.roomId);assert.equal(reopened.creatorKey,seed.creatorKey);
    assert.notEqual(guestRestored.seed(null).creatorKey,seed.creatorKey);
    const backendDirectory=path.join(directory,'backend');
    backend=await reopen(backendDirectory,reopened);
    const host=await connect(backend,'Member hosting reopened room');
    const hostState=await authenticateWorkspace(host,guestRestored,guestEntry);
    assert.equal(role(hostState),'member');assert.equal(object(hostState.policy).ownerKey,seed.creatorKey);
    assert.equal(hostState.ownerClaimAvailable,false);
    assert.equal(fs.existsSync(path.join(backendDirectory,'owner-claim.txt')),false);
    const returningOwner=createWorkspaceStore(ownerDirectory);
    const joined=await connect(backend,'Original owner');
    const owned=await authenticateWorkspace(joined,returningOwner,ownerEntry);
    assert.equal(role(owned),'server-owner');assert.equal(owned.selfKey,seed.creatorKey);
    await settle([{client:host,workspace:guestRestored,entryId:guestEntry},{client:joined,workspace:returningOwner,entryId:ownerEntry}]);
    const servers=await structure(joined,{t:'createChannel',serverId:'srv-main',type:'text',name:'Owner after rejoin'});
    assert(servers[0].channels.some(channel=>channel.name==='Owner after rejoin'));
    saveStructure(joined,returningOwner,ownerEntry);
    await stop(backend);backend=await launch(backendDirectory,{});
    const restarted=await connect(backend,'Original owner after backend restart');
    const ownerRestarted=createWorkspaceStore(ownerDirectory);
    const restartState=await authenticateWorkspace(restarted,ownerRestarted,ownerEntry);
    assert.equal(object(restartState.server).id,seed.roomId);assert.equal(role(restartState),'server-owner');
    await settle([{client:restarted,workspace:ownerRestarted,entryId:ownerEntry}]);
    await structure(restarted,{t:'createChannel',serverId:'srv-main',type:'text',name:'Owner after restart'});
    assert.equal(createWorkspaceStore(guestDirectory).get(guestEntry).document?.roomId,seed.roomId);
  } catch(error) {
    if(backend)console.error(JSON.stringify({event:'owner_continuity_failure',output:backend.output()}));
    throw error;
  } finally {if(backend)await stop(backend);cleanup(directory);}
});

test('a legitimate transfer carried by a returning workspace restores the current owner and survives another member reopening',{timeout:25000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-roles-owner-transfer-'));
  /** @type {Backend|null} */ let backend=null;
  try {
    const creatorDirectory=path.join(directory,'creator'),successorDirectory=path.join(directory,'successor'),hostDirectory=path.join(directory,'host');
    const creator=createWorkspaceStore(creatorDirectory),successor=createWorkspaceStore(successorDirectory),host=createWorkspaceStore(hostDirectory);
    const creatorEntry=entry(creator),successorEntry=entry(successor),hostEntry=entry(host),seed=creator.seed(null);
    const descriptor={version:/** @type {const} */(1),roomId:seed.roomId,creatorKey:seed.creatorKey};
    const document=createRoomDocument(descriptor,4,[{id:'srv-main',name:'Transferred domain',icon:'D',color:'#123456',channels:[{id:'ch-chat',name:'Chat',type:'text',userLimit:0}]}]);
    for(const [workspace,entryId] of /** @type {[Workspace,string][]} */ ([[creator,creatorEntry],[successor,successorEntry],[host,hostEntry]]))workspace.commit(entryId,document);
    const initial=createGovernance(descriptor),successorKey=successor.seed(null).creatorKey;
    creator.saveServerGovernance(creatorEntry,initial);
    const transfer=creator.signGovernanceChange(creatorEntry,{journal:initial,command:{type:'transferOwner',memberKey:successorKey}});
    const transferred=appendGovernance(initial,transfer.event);
    creator.saveServerGovernance(creatorEntry,transferred);successor.saveServerGovernance(successorEntry,transferred);
    const backendDirectory=path.join(directory,'backend');
    backend=await reopen(backendDirectory,createWorkspaceStore(hostDirectory).seed(hostEntry));
    const hostClient=await connect(backend,'Ordinary cold-start host');
    await authenticateWorkspace(hostClient,host,hostEntry);
    const creatorClient=await connect(backend,'Returning creator with transfer journal');
    const restored=await authenticateWorkspace(creatorClient,createWorkspaceStore(creatorDirectory),creatorEntry);
    assert.equal(role(restored),'member');assert.equal(object(restored.policy).ownerKey,successorKey);
    assert.equal(journal(restored).digest,transferred.digest);
    const successorClient=await connect(backend,'Returning current owner');
    const successorRestored=createWorkspaceStore(successorDirectory);
    const owned=await authenticateWorkspace(successorClient,successorRestored,successorEntry);
    assert.equal(role(owned),'server-owner');
    await settle([{client:hostClient,workspace:host,entryId:hostEntry},{client:creatorClient,workspace:creator,entryId:creatorEntry},{client:successorClient,workspace:successorRestored,entryId:successorEntry}]);
    await structure(successorClient,{t:'createChannel',serverId:'srv-main',type:'text',name:'Successor management'});
    host.saveServerGovernance(hostEntry,object(owned.journal));
    await stop(backend);backend=await launch(backendDirectory,{});
    const creatorRestart=await connect(backend,'Creator after disk restart');
    assert.equal(role(await authenticateWorkspace(creatorRestart,createWorkspaceStore(creatorDirectory),creatorEntry)),'member');
    const ownerRestart=await connect(backend,'Current owner after disk restart');
    assert.equal(role(await authenticateWorkspace(ownerRestart,createWorkspaceStore(successorDirectory),successorEntry)),'server-owner');
    await stop(backend);backend=await reopen(path.join(directory,'another-host-backend'),createWorkspaceStore(hostDirectory).seed(hostEntry));
    const creatorReopened=await connect(backend,'Creator on another reopened host');
    const seeded=await receive(creatorReopened,0,message=>message.t==='serverState','governance seed applied before returning identity');
    assert.equal(object(seeded.policy).ownerKey,successorKey);assert.equal(journal(seeded).digest,transferred.digest);
    const state=await authenticateWorkspace(creatorReopened,createWorkspaceStore(creatorDirectory),creatorEntry);
    assert.equal(role(state),'member');assert.equal(object(state.policy).ownerKey,successorKey);
    assert.equal(journal(state).digest,transferred.digest);
  } catch(error) {
    if(backend)console.error(JSON.stringify({event:'owner_transfer_continuity_failure',output:backend.output()}));
    throw error;
  } finally {if(backend)await stop(backend);cleanup(directory);}
});
