// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import steamState from '../lib/steam-state.cjs';
import replica from '../lib/room-replica.cjs';
import {parseRadioConfig,parseRadioState} from '../public/js/radio-protocol.js';
import {object,string,delay,identity,launch,stop,send,receive,connect,authenticate,journal,change,structure,join,cleanup} from './server-ws-helpers.mjs';
/** @typedef {import('./server-ws-helpers.mjs').Backend} Backend */
/** @typedef {import('./server-ws-helpers.mjs').Client} Client */
/** @typedef {import('./server-ws-helpers.mjs').Message} Message */
/** @typedef {import('../public/js/radio-protocol.js').RadioConfig} RadioConfig */
/** @typedef {import('../public/js/radio-protocol.js').RadioStation} RadioStation */
/** @typedef {import('../public/js/radio-protocol.js').RadioVote} RadioVote */
/** @typedef {import('../lib/steam-state.cjs').RoomServer} RoomServer */

/** @param {Client} client @param {Message} action @returns {Promise<Message>} */
async function radioAction(client,action) {
  const requestId=randomUUID(),cursor=send(client,{...action,requestId});
  const result=await receive(client,cursor,message=>message.t==='radioResult' && message.requestId===requestId,'radio acknowledgement '+string(action.t));
  assert.equal(client.socket.readyState,WebSocket.OPEN,'Radio responses must preserve the active connection');
  return result;
}
/** @param {Client} client @param {string} channelId @param {RadioStation} station @returns {Promise<RadioVote>} */
async function propose(client,channelId,station) {
  const cursor=client.messages.length;
  assert.equal((await radioAction(client,{t:'radioPropose',channelId,station})).ok,true);
  const state=parseRadioState(await receive(client,cursor,message=>message.t==='radioState' && message.channelId===channelId && message.vote!==null,'live radio ballot'));
  assert(state.vote); assert.equal(new Set(state.vote.eligibleKeys).size,state.vote.eligibleKeys.length);
  return state.vote;
}
/** @param {Client} client @param {number} cursor @param {string} channelId @param {RegExp} reason @returns {Promise<void>} */
async function cancelled(client,cursor,channelId,reason) {
  const state=parseRadioState(await receive(client,cursor,message=>message.t==='radioState' && message.channelId===channelId && message.vote===null,'ballot cancellation'));
  assert.match(state.reason ?? '',reason);
}
/** @param {RoomServer[]} servers @param {string} channelId @returns {RadioConfig} */
function configuration(servers,channelId) {
  const channel=servers.flatMap(domain=>domain.channels).find(channel=>channel.id===channelId);
  assert(channel && channel.type==='radio'); return channel.radio;
}
/** @param {Client} client @param {number} cursor @returns {Promise<RoomServer[]>} */
async function updatedServers(client,cursor) {
  const frame=await receive(client,cursor,message=>message.t==='servers','radio configuration update');
  return steamState.parseSteamStore({version:1,servers:frame.servers,messages:{}}).servers;
}
/** @param {Client} client @returns {Promise<void>} */
async function disconnect(client) { client.socket.close(); await client.closed; }

test('real radio channels persist saved stations and enforce online roles, live listeners, majority ballots and expiry',{timeout:110000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-roles-radio-'));
  /** @type {Backend|null} */let backend=null;
  try {
    backend=await launch(directory,{});
    const creator=identity(),administrator=identity(),listeners=Array.from({length:4},identity);
    const owner=await connect(backend,'Radio creator'); await authenticate(owner,creator);
    const claimToken=fs.readFileSync(path.join(directory,'owner-claim.txt'),'utf8').trim();
    const claimCursor=send(owner,{t:'claimOwner',token:claimToken});
    let current=journal(await receive(owner,claimCursor,message=>message.t==='serverState' && object(message.policy).ownerKey===creator.key,'radio creator claims local server'));
    const admin=await connect(backend,'Radio domain administrator'); await authenticate(admin,administrator);
    current=await change(owner,creator,current,{type:'setDomainAdmin',domainId:'srv-main',memberKey:administrator.key,enabled:true});
    const stations=[{id:'station-one',name:'Night programme',url:'https://radio.example.test/night?quality=high'},{id:'station-two',name:'Morning programme',url:'http://audio.example.test:8080/morning.aac'}];
    const initial=parseRadioConfig({creatorKey:creator.key,stations,stationId:stations[0].id});
    let servers=await structure(owner,{t:'createChannel',serverId:'srv-main',type:'radio',name:'Shared radio',radio:initial});
    const channel=servers.flatMap(domain=>domain.channels).find(channel=>channel.name==='Shared radio'); assert(channel && channel.type==='radio');
    const channelId=channel.id;
    assert.deepEqual(configuration(servers,channelId),initial);
    const firstServers=servers;
    const peers=[];
    for(let index=0;index<listeners.length;index+=1) {const client=await connect(backend,'Radio listener '+index);await authenticate(client,listeners[index]);peers.push(client);}
    await join(peers[0],channelId); await join(peers[1],channelId); await join(peers[2],channelId); await join(peers[3],'ch-lobby');
    const isolatedCursor=send(peers[2],{t:'joinVoice',channelId,muted:false,deafened:false});
    const isolated=await receive(peers[2],isolatedCursor,message=>message.t==='voicePeers','radio voice peers');
    assert(Array.isArray(isolated.peers));
    assert.deepEqual(isolated.peers.map(peer=>object(peer).id).sort(),[peers[0].userId,peers[1].userId].sort());
    const voiceCursor=send(peers[3],{t:'joinVoice',channelId:'ch-lobby',muted:false,deafened:false});
    assert.deepEqual((await receive(peers[3],voiceCursor,message=>message.t==='voicePeers','separate normal voice peers')).peers,[]);
    const deniedChange=await radioAction(peers[0],{t:'radioChange',channelId,radio:{...initial,stationId:stations[1].id}});
    assert.equal(deniedChange.ok,false); assert.match(string(deniedChange.error),/创建者|管理权限/);
    assert.equal((await radioAction(peers[0],{t:'radioPropose',channelId,station:stations[1]})).ok,false,'Online creator blocks listener votes even outside the radio channel');
    await disconnect(owner);
    const adminBlock=await radioAction(peers[0],{t:'radioPropose',channelId,station:stations[1]});
    assert.equal(adminBlock.ok,false); assert.match(string(adminBlock.error),/在线/);
    await disconnect(admin);
    let vote=await propose(peers[0],channelId,stations[1]);
    assert.equal(vote.eligibleKeys.length,3); assert.deepEqual(vote.votedKeys,[listeners[0].key]);
    assert(vote.expiresAt-Date.now()<=60000 && vote.expiresAt-Date.now()>58000);
    const duplicate=await radioAction(peers[0],{t:'radioApprove',channelId,voteId:vote.id});
    assert.equal(duplicate.ok,false); assert.match(string(duplicate.error),/已经投过/);
    const majorityCursor=peers[0].messages.length;
    assert.equal((await radioAction(peers[1],{t:'radioApprove',channelId,voteId:vote.id})).ok,true);
    servers=await updatedServers(peers[0],majorityCursor);
    assert.equal(configuration(servers,channelId).stationId,stations[1].id);
    const stale=await radioAction(peers[2],{t:'radioApprove',channelId,voteId:vote.id}); assert.equal(stale.ok,false); assert.match(string(stale.error),/已结束/);
    await join(peers[3],channelId);
    vote=await propose(peers[0],channelId,stations[0]); assert.equal(vote.eligibleKeys.length,4);
    const halfCursor=peers[0].messages.length;
    assert.equal((await radioAction(peers[1],{t:'radioApprove',channelId,voteId:vote.id})).ok,true);
    const half=parseRadioState(await receive(peers[0],halfCursor,message=>message.t==='radioState' && message.vote!==null && object(message.vote).id===vote.id,'exactly half remains pending'));
    assert.equal(half.vote?.votedKeys.length,2); assert(!peers[0].messages.slice(halfCursor).some(message=>message.t==='servers'));
    const settleCursor=peers[0].messages.length;
    assert.equal((await radioAction(peers[2],{t:'radioApprove',channelId,voteId:vote.id})).ok,true);
    servers=await updatedServers(peers[0],settleCursor);assert.equal(configuration(servers,channelId).stationId,stations[0].id);
    vote=await propose(peers[0],channelId,stations[1]);
    const memberCursor=peers[0].messages.length; await join(peers[3],'ch-lobby');
    await cancelled(peers[0],memberCursor,channelId,/听众发生变化/);
    assert.equal((await radioAction(peers[1],{t:'radioApprove',channelId,voteId:vote.id})).ok,false);
    vote=await propose(peers[0],channelId,stations[1]);
    const onlineCursor=peers[0].messages.length;
    const returnedAdmin=await connect(backend,'Administrator online elsewhere'); await authenticate(returnedAdmin,administrator);
    await cancelled(peers[0],onlineCursor,channelId,/已上线/);
    assert.equal((await radioAction(peers[1],{t:'radioApprove',channelId,voteId:vote.id})).ok,false);
    const addedStation={id:'station-three',name:'Saved late programme',url:'https://radio.example.test/late.opus?token=public'};
    const changed=parseRadioConfig({...initial,stations:[...stations,addedStation],stationId:addedStation.id});
    const editCursor=peers[0].messages.length;
    assert.equal((await radioAction(returnedAdmin,{t:'radioChange',channelId,radio:changed})).ok,true);
    servers=await updatedServers(peers[0],editCursor);assert.deepEqual(configuration(servers,channelId),changed);
    await disconnect(returnedAdmin);
    vote=await propose(peers[0],channelId,stations[0]);
    const expiryCursor=peers[0].messages.length;
    console.log(JSON.stringify({event:'radio_real_expiry_wait',expiresAt:vote.expiresAt,listeners:vote.eligibleKeys.length}));
    while(Date.now()<vote.expiresAt+1200) {const failure=peers[0].failure();if(failure)throw failure;await delay(Math.min(1000,vote.expiresAt+1200-Date.now()));}
    await cancelled(peers[0],expiryCursor,channelId,/60 秒/);
    const expired=await radioAction(peers[1],{t:'radioApprove',channelId,voteId:vote.id});assert.equal(expired.ok,false);assert.match(string(expired.error),/已结束/);
    const stored=steamState.parseSteamStore(JSON.parse(fs.readFileSync(path.join(directory,'store.json'),'utf8')));
    assert.deepEqual(configuration(stored.servers,channelId),changed);
    const room=object(JSON.parse(fs.readFileSync(path.join(directory,'room-identity.json'),'utf8'))),anchor=replica.parseRoomDescriptor(room),document=replica.parseRoomDocument(object(room.document),anchor);
    assert.deepEqual(configuration(document.servers,channelId),changed);
    const steamListener={id:steamState.stableSteamUserId('76561198000000002'),name:'Radio listener 0',color:'#123456',profileId:null,avatar:null,muted:false,deafened:false,serverMuted:false,voiceChannelId:channelId,signalConnected:true,memberKey:listeners[0].key};
    const checkpoint=steamState.parseSteamCheckpoint({version:1,lobbyId:'123456789',ownerId:'76561198000000001',epoch:'a'.repeat(32),sequence:1,stunUrls:[],store:stored,users:[steamListener],roomDocument:document});
    assert.deepEqual(configuration(checkpoint.store.servers,channelId),changed);assert.deepEqual(checkpoint.roomDocument,document);
    assert.deepEqual(checkpoint.users,[steamListener],'Steam checkpoint must preserve radio listeners and their verified member metadata');
    assert.deepEqual(stored.servers.find(server=>server.id==='srv-main')?.color,firstServers.find(server=>server.id==='srv-main')?.color);
    await stop(backend); backend=await launch(directory,{});
    const restored=await connect(backend,'Radio after local restart');
    const restoredServers=await receive(restored,0,message=>message.t==='welcome','restored room greeting');
    const parsedRestored=steamState.parseSteamStore({version:1,servers:restoredServers.servers,messages:{}});
    assert.deepEqual(configuration(parsedRestored.servers,channelId),changed);
    assert.equal(restored.socket.readyState,WebSocket.OPEN);
    console.log('Actual radio integration passed: canonical channel creation, separate voice peers, creator/admin online rules, distinct listener votes, strict majority, membership/authority cancellation, real 60-second expiry, stale responses, saved stations, room document/checkpoint schemas and restart persistence.');
  } catch(error) {if(backend)console.error(JSON.stringify({event:'radio_integration_failure',output:backend.output()}));throw error;}
  finally {if(backend)await stop(backend);cleanup(directory);}
});
