// @ts-check
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRoomDocument, parseRoomDocument, parseRoomDescriptor, roomVotePayload, openRoomReplica } = require('../lib/room-replica.cjs');
const { createGovernance, appendGovernance, governancePayload, parseGovernance } = require('../lib/server-governance.cjs');
const { parseIdentityChallenge, identityPayload } = require('../lib/server-identity.cjs');
/** @typedef {import('../lib/room-replica.cjs').RoomDocument} RoomDocument */
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{[key:string]:JsonValue}} JsonObject */
/** @typedef {{socket:WebSocket,messages:JsonObject[]}} Client */
/** @typedef {{publicKey:string,privateKey:crypto.KeyObject}} Member */
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.qa-tools/results/room-sync', new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'));
fs.mkdirSync(output, { recursive:true });
/** @type {string[]} */ const checks = [];
/** @type {Client[]} */ const clients = [];
/** @type {import('node:child_process').ChildProcess|null} */ let child = null;
let serverLog = '';
/** @param {JsonValue|undefined} value @returns {JsonObject} */
function object(value) { assert(value && typeof value === 'object' && !Array.isArray(value), 'Actual wire message must be an object'); return value; }
/** @param {number} ms @returns {Promise<void>} */
function delay(ms) { return new Promise(resolve=>setTimeout(resolve, ms)); }
/** @param {string} label @returns {void} */
function check(label) { checks.push(label); console.log(JSON.stringify({ event:'room_sync_check', label })); }
/** @returns {Member} */
function member() { const pair = crypto.generateKeyPairSync('ed25519'); return { publicKey:pair.publicKey.export({ format:'der', type:'spki' }).toString('base64'), privateKey:pair.privateKey }; }
/** @returns {Promise<number>} */
async function port() { const socket = net.createServer(); await new Promise((resolve,reject)=>{ socket.once('error',reject); socket.listen(0,'127.0.0.1',()=>resolve(undefined)); }); const address = socket.address(); assert(address && typeof address !== 'string'); await new Promise((resolve,reject)=>socket.close(error=>error?reject(error):resolve(undefined))); return address.port; }
/** @param {Client} client @param {(message:JsonObject)=>boolean} predicate @param {string} label @returns {Promise<JsonObject>} */
async function receive(client, predicate, label) { const deadline = Date.now()+7000; while (Date.now()<deadline) { const index = client.messages.findIndex(predicate); if (index !== -1) { const message=client.messages[index]; client.messages.splice(0,index+1); return message; } await delay(15); } throw new Error('Actual WebSocket timed out: '+label+'; received='+JSON.stringify(client.messages)); }
/** @param {number} listen @param {string} directory @param {NodeJS.ProcessEnv} configured @returns {Promise<void>} */
async function start(listen, directory, configured) {
  /** @type {NodeJS.ProcessEnv} */ const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(ECHO_|STUN_URLS$|TURN_|HTTPS_|HTTP_|PORT$)/.test(key)) delete env[key];
  Object.assign(env, { PORT:String(listen), HTTP_HOST:'127.0.0.1', HTTPS_PORTS:'0', ECHO_DATA_DIR:directory, ECHO_PASSWORD:'', ECHO_NETWORK_MODE:'server', ECHO_MEDIA_POLICY:'direct', ECHO_SCREEN_MODE:'peer-relay' }, configured);
  child = spawn(process.execPath, [path.join(root,'server.js')], { cwd:root, env, windowsHide:true, stdio:['ignore','pipe','pipe'] });
  child.stdout?.on('data', chunk=>{ serverLog=(serverLog+String(chunk)).slice(-256*1024); }); child.stderr?.on('data', chunk=>{ serverLog=(serverLog+String(chunk)).slice(-256*1024); });
  const deadline=Date.now()+7000;
  while (Date.now()<deadline) { if (child.exitCode !== null) throw new Error('Actual room server exited during startup: '+serverLog); try { if ((await fetch('http://127.0.0.1:'+listen+'/api/health')).ok) return; } catch (error) { if (!(error instanceof TypeError)) throw error; } await delay(30); }
  throw new Error('Actual room server did not become ready: '+serverLog);
}
/** @returns {Promise<void>} */
async function stop() {
  for (const client of clients.splice(0)) client.socket.close();
  const running=child; child=null; if (!running || running.exitCode !== null) return;
  await new Promise((resolve,reject)=>{ const timer=setTimeout(()=>{ running.kill(); reject(new Error('Owned room server did not exit')); },5000); running.once('exit',()=>{ clearTimeout(timer); resolve(undefined); }); running.once('error',reject); running.kill(); });
}
/** @param {number} listen @returns {Promise<Client>} */
async function connect(listen) {
  const socket=new WebSocket('ws://127.0.0.1:'+listen+'/ws');
  const client={ socket,messages:/** @type {JsonObject[]} */ ([]) };
  socket.addEventListener('message', event=>{ assert.equal(typeof event.data,'string'); client.messages.push(object(JSON.parse(event.data))); });
  await new Promise((resolve,reject)=>{ socket.addEventListener('open',()=>resolve(undefined),{once:true}); socket.addEventListener('error',reject,{once:true}); });
  socket.send(JSON.stringify({t:'hello',name:'Replica integration',resumable:false})); clients.push(client);
  await receive(client,message=>message.t==='welcome','authenticated welcome'); return client;
}
/** @param {Client[]} members @returns {Promise<JsonObject>} */
async function round(members) { const offer=await receive(members[members.length-1],message=>message.t==='roomSyncOffer','new collection round'); for (const client of members.slice(0,-1)) await receive(client,message=>message.t==='roomSyncOffer'&&message.roundId===offer.roundId,'same collection nonce'); return offer; }
/** @param {Client} client @param {Member} identity @param {JsonObject} offer @param {RoomDocument} document @param {boolean} fresh @returns {void} */
function vote(client, identity, offer, document, fresh) { assert.equal(typeof offer.roundId,'string'); const roundId=/** @type {string} */(offer.roundId); const signature=crypto.sign(null,Buffer.from(roomVotePayload(roundId,identity.publicKey,document,fresh)),identity.privateKey).toString('base64'); client.socket.send(JSON.stringify({t:'roomSyncVote',roundId,memberKey:identity.publicKey,document,signature,fresh})); }
/** @param {Client} client @param {string} reason @returns {Promise<RoomDocument>} */
async function commit(client, reason) { const message=await receive(client,message=>message.t==='roomSyncCommit'&&message.reason===reason,'document commit '+reason); return parseRoomDocument(/** @type {JsonValue} */(message.document),descriptor); }
const identities=Array.from({length:7},()=>member());
const descriptor={version:/** @type {const} */(1),roomId:crypto.randomUUID(),creatorKey:identities[0].publicKey};
const servers=[{id:'server',name:'Seed',icon:'S',color:'#123456',channels:[{id:'voice',name:'Voice',type:/** @type {const} */('voice'),userLimit:0},{id:'text',name:'Text',type:/** @type {const} */('text'),userLimit:0}]}];
const first=createRoomDocument(descriptor,0,servers);
const left=createRoomDocument(descriptor,4,[{...servers[0],channels:servers[0].channels.map(channel=>channel.id==='text'?{...channel,name:'Left'}:channel)}]);
const right=createRoomDocument(descriptor,9,[{...servers[0],channels:servers[0].channels.map(channel=>channel.id==='text'?{...channel,name:'Right'}:channel)}]);
const directory=path.join(output,'client-created'),seedPath=path.join(output,'seed.json'); fs.writeFileSync(seedPath,JSON.stringify(first));
let governanceSeed=createGovernance(descriptor);
for (const identity of identities.slice(1)) {
  const command={type:/** @type {const} */('setDomainAdmin'),domainId:'server',memberKey:identity.publicKey,enabled:true};
  const signature=crypto.sign(null,Buffer.from(governancePayload(governanceSeed,identities[0].publicKey,command)),identities[0].privateKey).toString('base64');
  governanceSeed=appendGovernance(governanceSeed,{revision:governanceSeed.events.length+1,previousDigest:governanceSeed.digest,actorKey:identities[0].publicKey,command,signature});
}
const governanceSeedPath=path.join(output,'governance-seed.json');fs.writeFileSync(governanceSeedPath,JSON.stringify(governanceSeed));
const configured={ECHO_ROOM_ID:descriptor.roomId,ECHO_ROOM_CREATOR_KEY:descriptor.creatorKey,ECHO_ROOM_SEED_PATH:seedPath,ECHO_GOVERNANCE_SEED_PATH:governanceSeedPath};
/** @returns {Promise<void>} */
async function main() {
  const listen=await port(); await start(listen,directory,configured);
  for (let index=0;index<5;index+=1) await connect(listen);
  let offer=await round(clients);
  vote(clients[0],identities[0],offer,right,false);
  for (let index=1;index<5;index+=1) vote(clients[index],identities[index],offer,left,false);
  await delay(150); assert(!clients[0].messages.some(message=>message.t==='roomSyncCommit'),'Creator result must still wait for the complete collection interval');
  let current=await commit(clients[0],'creator'); assert.equal(current.digest,right.digest); assert.equal(current.revision,10);
  check('A real signed creator vote overrides four conflicting authorized administrator channel snapshots after the full collection interval');
  await connect(listen); offer=await round(clients);
  for(let index=1;index<6;index+=1) vote(clients[index],identities[index],offer,left,false);
  let conflict=await receive(clients[0],message=>message.t==='roomSyncConflict'&&message.roundId===offer.roundId,'known creator missing');
  assert.equal(conflict.reason,'creator-missing');
  clients[1].socket.send(JSON.stringify({t:'roomSyncChoose',roundId:offer.roundId,digest:left.digest}));
  const blockedChoice=await receive(clients[1],message=>message.t==='error'&&message.code==='room-sync-rejected','noncreator cannot override an online creator');
  assert.match(String(blockedChoice.message),/only that creator/);
  clients[0].socket.send(JSON.stringify({t:'roomSyncChoose',roundId:offer.roundId,digest:left.digest})); current=await commit(clients[0],'explicit-choice');
  check('A previously verified online creator prevents majority fallback and other members cannot choose on its behalf');
  const creator=clients.shift(); assert(creator); creator.socket.close();
  offer=await receive(clients[0],message=>message.t==='roomSyncOffer'&&message.roundId!==offer.roundId,'round after creator disconnect');
  for(let index=0;index<5;index+=1) vote(clients[index],identities[index+1],offer,index<3?left:right,false);
  current=await commit(clients[0],'majority'); assert.equal(current.digest,left.digest);
  check('Three distinct verified keys out of five current authenticated connections form a strict majority');
  const departed=clients.pop(); assert(departed); departed.socket.close();
  offer=await receive(clients[0],message=>message.t==='roomSyncOffer'&&message.roundId!==offer.roundId,'four-member round');
  for(let index=0;index<4;index+=1) vote(clients[index],identities[index+1],offer,index<2?left:right,false);
  conflict=await receive(clients[0],message=>message.t==='roomSyncConflict'&&message.roundId===offer.roundId,'two versus two conflict');
  assert.equal(conflict.reason,'no-majority'); assert.deepEqual(parseRoomDocument(/** @type {JsonValue} */(object(JSON.parse(fs.readFileSync(path.join(directory,'room-identity.json'),'utf8'))).document),descriptor),current);
  clients[0].socket.send(JSON.stringify({t:'roomSyncChoose',roundId:offer.roundId,digest:'f'.repeat(64)}));
  await receive(clients[0],message=>message.t==='error'&&message.code==='room-sync-rejected','invalid candidate rejected');
  clients[0].socket.send(JSON.stringify({t:'roomSyncChoose',roundId:offer.roundId,digest:right.digest})); current=await commit(clients[0],'explicit-choice'); assert.equal(current.digest,right.digest);
  check('A two-versus-two tie retains the existing document until a current member explicitly selects a valid candidate');
  const duplicate=await connect(listen); offer=await round(clients);
  assert.equal(typeof offer.roundId,'string');
  duplicate.socket.send(JSON.stringify({t:'roomSyncVote',roundId:offer.roundId,memberKey:identities[6].publicKey,document:current,signature:crypto.randomBytes(64).toString('base64'),fresh:false}));
  await receive(duplicate,message=>message.t==='error'&&message.code==='room-sync-rejected','actual invalid Ed25519 signature rejected');
  vote(clients[0],identities[1],offer,current,false); vote(duplicate,identities[1],offer,current,false);
  await receive(duplicate,message=>message.t==='error'&&message.code==='room-sync-rejected','same member key on second connection rejected');
  vote(duplicate,identities[6],offer,current,false);
  for(let index=1;index<4;index+=1) vote(clients[index],identities[index+1],offer,current,false);
  current=await commit(clients[0],'majority');
  check('Real invalid signatures and duplicate public-key identities are rejected without consuming the connection vote');
  await connect(listen); offer=await round(clients);
  const liveKeys=[identities[1],identities[2],identities[3],identities[4],identities[6],member()];
  for(let index=0;index<clients.length;index+=1) vote(clients[index],liveKeys[index],offer,current,true);
  conflict=await receive(clients[0],message=>message.t==='roomSyncConflict'&&message.roundId===offer.roundId,'fresh-only ballots excluded');
  assert.equal(conflict.existingVotes,0);
  clients[0].socket.send(JSON.stringify({t:'roomSyncChoose',roundId:offer.roundId,digest:current.digest})); current=await commit(clients[0],'explicit-choice');
  check('Fresh-only signatures are evidence of presence and never masquerade as an existing replica majority');
  const beforeRestart=current; await stop(); await start(listen,directory,configured); const restarted=await connect(listen);
  const restoredState=await receive(restarted,message=>message.t==='serverState','persisted signed governance after client-owned restart');
  const restoredGovernance=parseGovernance(/** @type {JsonValue} */(restoredState.journal),descriptor);
  assert.equal(restoredGovernance.digest,governanceSeed.digest);assert.deepEqual(restoredGovernance,governanceSeed);
  offer=await round(clients);
  const restored=parseRoomDocument(/** @type {JsonValue} */(offer.document),descriptor); assert.deepEqual(restored,beforeRestart);
  vote(restarted,identities[0],offer,restored,true); current=await commit(restarted,'creator'); assert.equal(current.digest,beforeRestart.digest);
  check('Actual client-owned process restart preserves the signed governance seed, room identity and committed channels; creator fresh is authoritative');
  await stop();
  const independent=path.join(output,'independent'); await start(listen,independent,{}); const visitor=await connect(listen);
  const challenge=parseIdentityChallenge(await receive(visitor,message=>message.t==='identityChallenge','standalone ownership identity challenge'));
  const authorityCommit=await receive(visitor,message=>message.t==='roomSyncCommit'&&message.reason==='authority','immediate nonvoting independent authority');
  const authorityDescriptor=parseRoomDescriptor(/** @type {JsonValue} */(authorityCommit.document)); const authorityDocument=parseRoomDocument(/** @type {JsonValue} */(authorityCommit.document),authorityDescriptor);
  assert(!visitor.messages.some(message=>message.t==='roomSyncOffer'),'Independent authority must never require client replica voting');
  visitor.socket.send(JSON.stringify({t:'createChannel',serverId:'srv-main',name:'Persisted',type:'text'}));
  await receive(visitor,message=>message.t==='error'&&message.code==='permission-denied'&&message.action==='createChannel','legacy unverified client cannot perform CRUD');
  const authorityOwner=member();
  visitor.socket.send(JSON.stringify({t:'identityProof',nonce:challenge.nonce,memberKey:authorityOwner.publicKey,signature:crypto.sign(null,Buffer.from(identityPayload(challenge)),authorityOwner.privateKey).toString('base64')}));
  await receive(visitor,message=>message.t==='serverState'&&message.selfKey===authorityOwner.publicKey,'standalone owner proof');
  const token=fs.readFileSync(path.join(independent,'owner-claim.txt'),'utf8').trim();
  visitor.socket.send(JSON.stringify({t:'claimOwner',token}));
  await receive(visitor,message=>message.t==='serverState'&&object(message.policy).ownerKey===authorityOwner.publicKey,'standalone owner exact token claim');
  const claimedAuthority=await receive(visitor,message=>message.t==='roomSyncCommit'&&message.reason==='authority','owner claim authority refresh');
  const claimedAuthorityDocument=parseRoomDocument(/** @type {JsonValue} */(claimedAuthority.document),authorityDescriptor);
  assert.equal(claimedAuthorityDocument.revision,authorityDocument.revision+1);
  visitor.socket.send(JSON.stringify({t:'createChannel',serverId:'srv-main',name:'Persisted',type:'text'}));
  const updated=await receive(visitor,message=>message.t==='roomSyncCommit'&&message.reason==='structure-change','CRUD durable commit'); const changed=parseRoomDocument(/** @type {JsonValue} */(updated.document),authorityDescriptor);
  assert.equal(changed.revision,claimedAuthorityDocument.revision+1); assert(changed.servers.flatMap(server=>server.channels).some(channel=>channel.name==='Persisted'));
  check('A standalone authority rejects unverified legacy CRUD and permits its proven, locally claimed owner without client replica voting');
  await stop();
  const broken=path.join(output,'broken'); fs.mkdirSync(broken); fs.writeFileSync(path.join(broken,'room-identity.json'),'{invalid');
  assert.throws(()=>openRoomReplica({dataDir:broken,environment:{},servers}),/Invalid room identity JSON/);
  check('Malformed real on-disk identity fails with an explicit file diagnosis instead of silently creating another room');
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({status:'passed',checks,descriptor,document:current},null,2));
}
main().catch(error=>{ fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({status:'failed',checks,failure:error instanceof Error?{message:error.message,stack:error.stack}:String(error)},null,2)); process.exitCode=1; }).finally(async()=>{ await stop(); fs.writeFileSync(path.join(output,'server.log'),serverLog); console.log(JSON.stringify({event:'room_sync_finished',output})); });
