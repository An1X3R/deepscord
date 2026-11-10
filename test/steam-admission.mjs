// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {MessageChannel} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
import admission from '../desktop/steam-admission.cjs';
import wire from '../desktop/steam-wire.cjs';
import continuity from '../desktop/steam-continuity.cjs';
const host='76561198000000001',guest='76561198000000002',third='76561198000000003';
const invitation={appId:480,lobbyId:'109775244000000001',token:randomBytes(32).toString('base64url')};

test('actual HMAC proofs tolerate Steam establishment delay within the bounded room connection budget',()=>{
  let now=0;
  /** @type {Buffer[]} */const challenges=[];
  /** @type {Buffer[]} */const responses=[];
  const clock=()=>now;
  const receiver=admission.createSteamAdmission(invitation,host,(_peer,packet)=>challenges.push(packet),()=>{},clock);
  const sender=admission.createSteamAdmission(invitation,guest,(_peer,packet)=>responses.push(packet),()=>{},clock);
  receiver.update([host,guest]);sender.update([host,guest]);
  sender.receive(host,challenges[0]);
  const proof=responses[responses.length-1];
  now=20000;receiver.tick();receiver.receive(guest,proof);
  assert.equal(receiver.authorized(guest),true,'a genuine proof arriving after the former ten-second limit must succeed');
  receiver.remove(guest);receiver.update([host,guest]);
  sender.receive(host,challenges[challenges.length-1]);
  const expired=responses[responses.length-1];
  now=50001;
  assert.throws(()=>receiver.receive(guest,expired),/Stale/);
  assert.equal(receiver.authorized(guest),false);
  const before=challenges.length;receiver.tick();
  assert.equal(challenges.length,before,'expired membership challenges stop retrying');
});

test('proof binds native endpoints, lobby and fresh membership nonce; raw invitation never leaves the connector',()=>{
  /** @type {Buffer[]} */const outgoing=[];
  /** @type {Buffer[]} */const replies=[];
  const a=admission.createSteamAdmission(invitation,host,(_peer,packet)=>outgoing.push(packet),()=>{},Date.now);
  const b=admission.createSteamAdmission(invitation,guest,(_peer,packet)=>replies.push(packet),()=>{},Date.now);
  a.update([host,guest]);b.update([host,guest]);
  assert.equal(a.authorized(guest),false);
  for(const kind of ['replica','media','bulk','open','data']){
    const packet=wire.encodeMessage(invitation,'0'.repeat(32),/** @type {import('../desktop/steam-wire.cjs').SteamMessageKind} */(kind),Buffer.from('confidential payload'))[0];
    assert.throws(()=>a.sendAuthorized(guest,packet),/has not proved/);
    assert.throws(()=>a.requireAuthorized(guest),/has not proved/);
  }
  assert.equal(outgoing.length,1);
  b.receive(host,outgoing[0]);
  const proof=replies[1];
  assert.throws(()=>a.receive(third,proof),/sender/);
  const another=admission.createSteamAdmission({...invitation,lobbyId:'109775244000000002'},host,()=>{},()=>{},Date.now);
  another.update([host,guest]);assert.throws(()=>another.receive(guest,proof),/proof failed/);
  const wrong=admission.createSteamAdmission({...invitation,token:randomBytes(32).toString('base64url')},host,()=>{},()=>{},Date.now);
  wrong.update([host,guest]);assert.throws(()=>wrong.receive(guest,proof),/proof failed/);
  a.receive(guest,proof);assert.equal(a.authorized(guest),true);
  a.remove(guest);a.update([host,guest]);
  assert.equal(a.authorized(guest),false);
  assert.throws(()=>a.receive(guest,proof),/Stale/);
  assert.equal(a.authorized(guest),false);
  assert.throws(()=>a.sendAuthorized(guest,Buffer.from('queued media from old membership')),/has not proved/);
  b.receive(host,outgoing[outgoing.length-1]);
  a.receive(guest,replies[replies.length-1]);
  assert.equal(a.authorized(guest),true,'a one-sided native membership revocation can complete a fresh handshake');
  assert(outgoing.concat(replies).every(packet=>!packet.includes(invitation.token)));
  assert.throws(()=>a.receive(guest,Buffer.alloc(513)),/size/);
  assert.throws(()=>a.update(Array.from({length:11},(_,index)=>String(index))),/ten/);
});

test('actual MessageChannel transport admits guest before checkpoint, fans out backups and recovers after host departure',async()=>{
  const ids=[host,guest,third];
  /** @type {Map<string,ReturnType<typeof admission.createSteamAdmission>>} */const peers=new Map();
  /** @type {Map<string,import('node:worker_threads').MessagePort>} */const ports=new Map();
  /** @type {Map<string,Buffer[]>} */const sent=new Map(ids.map(id=>[id,[]]));
  /** @type {{peer:string,sender:string,message:import('../desktop/steam-continuity.cjs').ReplicaMessage}[]} */const received=[];
  /** @type {Error[]} */const failures=[];
  let owner=host;
  /** @type {import('../lib/steam-state.cjs').SteamCheckpoint} */
  const saved={version:1,lobbyId:invitation.lobbyId,ownerId:host,epoch:'a'.repeat(32),sequence:1,stunUrls:[],store:{version:1,servers:[],messages:{}},users:[]};
  /** @param {string} from @param {string} to @param {Buffer} packet */
  function transport(from,to,packet){const port=ports.get(from+':'+to);assert(port);sent.get(from)?.push(packet);port.postMessage(packet);}
  /** @param {string} from @param {string} to @param {import('../desktop/steam-continuity.cjs').ReplicaMessage} message */
  function disclose(from,to,message){const connector=peers.get(from);assert(connector);if(!connector.authorized(to))return;for(const packet of wire.encodeMessage(invitation,continuity.REPLICA_SESSION,'replica',continuity.encodeReplica(message)))connector.sendAuthorized(to,packet);}
  for(const id of ids)peers.set(id,admission.createSteamAdmission(invitation,id,(to,packet)=>transport(id,to,packet),to=>{if(id===owner)disclose(id,to,{t:'checkpoint',checkpoint:saved});},Date.now));
  for(let index=0;index<ids.length;index++)for(const right of ids.slice(index+1)){
    const left=ids[index],channel=new MessageChannel();
    ports.set(left+':'+right,channel.port1);ports.set(right+':'+left,channel.port2);
    for(const [recipient,sender,port] of [[left,right,channel.port1],[right,left,channel.port2]]){
      assert(typeof recipient==='string' && typeof sender==='string' && typeof port!=='string');
      port.on('message',data=>{
        const packet=Buffer.from(data),connector=peers.get(recipient);assert(connector);
        try{
          if(connector.isPacket(packet)){connector.receive(sender,packet);return;}
          connector.requireAuthorized(sender);
          const frame=wire.decodePacket(invitation,packet);
          const message=continuity.decodeReplica(frame.data);
          received.push({peer:recipient,sender,message});
          if(message.t==='recover')disclose(recipient,sender,{t:'recovered',requestId:message.requestId,checkpoint:saved});
        }catch(error){assert(error instanceof Error);failures.push(error);}
      });
    }
  }
  try{
    for(const id of ids)disclose(host,id,{t:'checkpoint',checkpoint:saved});
    assert.equal(sent.get(host)?.length,0);
    for(const connector of peers.values())connector.update(ids);
    const deadline=Date.now()+3000;
    while(received.filter(item=>item.message.t==='checkpoint').length<2 && Date.now()<deadline)await delay(10);
    assert.deepEqual(failures,[]);
    assert.equal(received.filter(item=>item.message.t==='checkpoint').length,2);
    assert([...peers].every(([id,connector])=>ids.every(other=>id===other || connector.authorized(other))));
    owner=guest;
    peers.get(guest)?.update([guest,third]);peers.get(third)?.update([guest,third]);
    assert.equal(peers.get(guest)?.authorized(host),false);
    disclose(guest,third,{t:'recover',epoch:saved.epoch,ownerId:host,requestId:'b'.repeat(32)});
    while(!received.some(item=>item.peer===guest && item.message.t==='recovered') && Date.now()<deadline)await delay(10);
    assert(received.some(item=>item.peer===guest && item.sender===third && item.message.t==='recovered'));
    assert.deepEqual(failures,[]);
  }finally{for(const port of ports.values())port.close();}
});
