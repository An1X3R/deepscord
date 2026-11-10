// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import codec from '../lib/avif-codec.cjs';
import governance from '../lib/server-governance.cjs';
import replica from '../lib/room-replica.cjs';
import {parseMediaMetadata,parseChatMessage} from '../public/js/chat-protocol.js';
import {object,string,identity,until,launch,stop,send,receive,connect,authenticate,journal,signedEvent,change,cleanup} from './server-ws-helpers.mjs';
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../public/js/chat-protocol.js').MediaMetadata} MediaMetadata */
/** @typedef {import('../lib/server-governance.cjs').GovernanceJournal} Journal */
/** @typedef {import('../lib/server-governance.cjs').GovernanceCommand} Command */
/** @typedef {import('./server-ws-helpers.mjs').Identity} Identity */
/** @typedef {import('./server-ws-helpers.mjs').Client} Client */
/** @typedef {import('./server-ws-helpers.mjs').Backend} Backend */
/** @typedef {{[key:string]:JsonValue}} Message */
const animation=fs.readFileSync(new URL('avif-codec-fixtures/transparent-animation.avif',import.meta.url));
/** @param {Buffer} bytes @returns {string} */function hash(bytes){return createHash('sha256').update(bytes).digest('hex');}
/** @param {Client} client @param {string} type @param {Message} payload @param {string} requestId @returns {Promise<Message>} */async function request(client,type,payload,requestId){
  const replies={mediaRequest:'mediaResult',chat:'chatResult',setReaction:'reactionResult',governanceChange:'governanceResult'};
  if(type!=='mediaRequest' && type!=='chat' && type!=='setReaction' && type!=='governanceChange')throw new TypeError('Unsupported acknowledged integration request');
  const cursor=send(client,{t:type,...payload,requestId});return receive(client,cursor,message=>message.t===replies[type] && message.requestId===requestId,'actual '+type+' acknowledgement');
}
/** @param {Message} response @returns {Message} */function success(response){assert.equal(response.ok,true,JSON.stringify(response));return object(response.result);}
/** @param {Client} client @param {Buffer} bytes @param {'server'|'personal'|'image'} kind @param {string|null} domainId @returns {Promise<MediaMetadata>} */async function upload(client,bytes,kind,domainId){
  const begun=success(await request(client,'mediaRequest',{op:'begin',kind,sha256:hash(bytes),bytes:bytes.length,domainId},randomUUID()));if(begun.asset!==undefined)return parseMediaMetadata(begun.asset);
  const uploadId=string(begun.uploadId);assert.equal(begun.chunkBytes,16384);
  for(let offset=0;offset<bytes.length;offset+=16384)success(await request(client,'mediaRequest',{op:'write',uploadId,offset,data:bytes.subarray(offset,offset+16384).toString('base64')},randomUUID()));
  return parseMediaMetadata(success(await request(client,'mediaRequest',{op:'finish',uploadId},randomUUID())).asset ?? null);
}
/** @param {Client} client @param {Identity} actor @param {Journal} current @param {Command} command @returns {Promise<Journal>} */async function catalogChange(client,actor,current,command){
  const response=success(await request(client,'governanceChange',{event:signedEvent(current,actor,command)},randomUUID())),digest=string(response.digest);
  return journal(await receive(client,0,message=>message.t==='serverState' && object(message.journal).digest===digest,'catalog governance broadcast'));
}
/** @param {Client} client @param {string} sha256 @returns {Promise<Message>} */function info(client,sha256){return request(client,'mediaRequest',{op:'info',sha256},randomUUID());}
/** @param {Message} response @param {string} code @returns {void} */function rejected(response,code){assert.equal(response.ok,false,JSON.stringify(response));assert.equal(response.code,code,JSON.stringify(response));}

test('actual server protects private media, signed server catalogs and idempotent history across reconnect and restart',{timeout:45000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-roles-chat-media-'));
  /** @type {Backend|null} */let backend=null;
  try{
    backend=await launch(directory,{});const ownerKey=identity(),domainKey=identity(),adminKey=identity(),memberKey=identity();
    const owner=await connect(backend,'Media owner');await authenticate(owner,ownerKey);
    const claimCursor=send(owner,{t:'claimOwner',token:fs.readFileSync(path.join(directory,'owner-claim.txt'),'utf8').trim()});
    let current=journal(await receive(owner,claimCursor,message=>message.t==='serverState' && object(message.policy).ownerKey===ownerKey.key,'media owner claim'));
    const domain=await connect(backend,'Domain curator');await authenticate(domain,domainKey);
    const admin=await connect(backend,'Domain admin');await authenticate(admin,adminKey);
    const member=await connect(backend,'Member uploader');await authenticate(member,memberKey);
    current=await change(owner,ownerKey,current,{type:'setDomainOwner',domainId:'srv-main',memberKey:domainKey.key});
    current=await change(domain,domainKey,current,{type:'setDomainAdmin',domainId:'srv-main',memberKey:adminKey.key,enabled:true});
    for(const [client,domainId] of [[member,'srv-main'],[admin,'srv-main'],[domain,'srv-night']])rejected(await request(/** @type {Client} */(client),'mediaRequest',{op:'begin',kind:'server',sha256:hash(animation),bytes:animation.length,domainId:/** @type {string} */(domainId)},randomUUID()),'permission-denied');
    current=await change(owner,ownerKey,current,{type:'setServerAdmin',memberKey:adminKey.key,enabled:true});
    current=await change(owner,ownerKey,current,{type:'migrateServerCatalog'});
    rejected(await request(domain,'mediaRequest',{op:'begin',kind:'server',sha256:hash(animation),bytes:animation.length,domainId:null},randomUUID()),'permission-denied');
    const publicAsset=await upload(admin,animation,'server',null);assert.equal(publicAsset.animated,true);assert.equal(publicAsset.frames,2);
    rejected(await info(member,publicAsset.sha256),'permission-denied');rejected(await info(owner,publicAsset.sha256),'permission-denied');
    const attachment={...publicAsset,kind:'sticker',name:'Animated sticker'};
    rejected(await request(member,'chat',{channelId:'ch-chat',text:'Private hash must fail',attachment},randomUUID()),'permission-denied');
    const command={type:/** @type {const} */('putEmoji'),domainId:null,emojiId:'animated-server',name:'Animated server emoji',asset:publicAsset,ts:Date.now()};
    const tampered=signedEvent(current,adminKey,command);tampered.signature=Buffer.alloc(64).toString('base64');assert.equal((await request(domain,'governanceChange',{event:tampered},randomUUID())).ok,false);
    current=await catalogChange(admin,adminKey,current,command);
    for(const [client,key,domainId] of [[admin,adminKey,'srv-main'],[member,memberKey,'srv-main'],[domain,domainKey,'srv-night']]){
      const event=signedEvent(current,/** @type {Identity} */(key),{...command,domainId:/** @type {string} */(domainId),emojiId:'forbidden-emoji'});
      assert.equal((await request(/** @type {Client} */(client),'governanceChange',{event},randomUUID())).ok,false);
    }
    assert.deepEqual(parseMediaMetadata(success(await info(member,publicAsset.sha256)).asset ?? null),publicAsset);
    const read=success(await request(member,'mediaRequest',{op:'read',sha256:publicAsset.sha256,offset:0,length:animation.length},randomUUID()));assert.deepEqual(Buffer.from(string(read.data),'base64'),animation);
    assert.deepEqual(parseMediaMetadata(success(await request(member,'mediaRequest',{op:'begin',kind:'personal',sha256:publicAsset.sha256,bytes:publicAsset.bytes,domainId:null},randomUUID())).asset ?? null),publicAsset);
    const chatId=randomUUID(),chatPayload={channelId:'ch-chat',text:'Persistent transparent attachment',attachment};
    const sent=parseChatMessage(success(await request(member,'chat',chatPayload,chatId)).message ?? null);
    assert.equal(parseChatMessage(success(await request(member,'chat',chatPayload,chatId)).message ?? null).id,sent.id);
    const reaction={channelId:'ch-chat',messageId:sent.id,selection:{kind:'server',emojiId:'animated-server'},active:true},reactionId=randomUUID();
    const reacted=parseChatMessage(success(await request(member,'setReaction',reaction,reactionId)).message ?? null),repeated=parseChatMessage(success(await request(member,'setReaction',reaction,reactionId)).message ?? null);
    assert.deepEqual(repeated.reactions,reacted.reactions);assert.equal(repeated.reactionRevision,reacted.reactionRevision);
    const twice=parseChatMessage(success(await request(admin,'setReaction',reaction,randomUUID())).message ?? null);assert.equal(twice.reactions?.[0].userIds.length,2);
    current=await catalogChange(admin,adminKey,current,{type:'deleteEmoji',domainId:null,emojiId:'animated-server'});
    assert.equal((governance.governanceState(current).emojis ?? []).length,0);success(await info(member,publicAsset.sha256));
    const privateBytes=await codec.encode({width:8,height:8,timescale:1000,repetitionCount:0,frames:[{rgba:Uint8Array.from({length:256},(_,index)=>(index*29)%256),durationTicks:1000}]},{quality:100,speed:10},{maxBytes:160*1024,maxDimension:360,maxFrames:180,maxDecodedPixels:24*1024*1024,maxDurationMs:10000,timeoutMs:30000},new AbortController().signal);
    const privateAsset=await upload(member,privateBytes,'personal',null);success(await info(member,privateAsset.sha256));rejected(await info(admin,privateAsset.sha256),'permission-denied');
    const invalidDescriptor={...privateAsset,kind:'sticker',name:'Wrong dimensions',width:privateAsset.width+1};rejected(await request(member,'chat',{channelId:'ch-chat',text:'',attachment:invalidDescriptor},randomUUID()),'media-invalid');
    const mediaFile=path.join(directory,'media',member.challenge.roomId,'objects',privateAsset.sha256+'.avif');assert.equal(fs.existsSync(mediaFile),true);
    const departure=owner.messages.length;member.socket.close();await member.closed;await receive(owner,departure,message=>message.t==='userLeft' && message.id===member.userId,'uploader disconnect');
    const reconnected=await connect(backend,'Reconnected uploader');await authenticate(reconnected,memberKey);rejected(await info(reconnected,privateAsset.sha256),'permission-denied');success(await info(reconnected,publicAsset.sha256));
    await until(()=>{
      const persisted=path.join(directory,'store.json');if(!fs.existsSync(persisted))return false;
      const history=object(object(JSON.parse(fs.readFileSync(persisted,'utf8'))).messages)['ch-chat'];return Array.isArray(history) && history.some(value=>{const row=object(value);return row.id===sent.id && Array.isArray(row.reactions) && object(row.reactions[0]).kind==='server' && /** @type {JsonValue[]} */(object(row.reactions[0]).userIds).length===2;});
    },backend.failure,'real persisted attachment/reaction history');
    const digest=current.digest;await stop(backend);backend=await launch(directory,{});
    const restored=await connect(backend,'Restarted uploader'),restoredState=await authenticate(restored,memberKey);assert.equal(journal(restoredState).digest,digest);
    const welcome=restored.messages.find(message=>message.t==='welcome');assert(welcome);const history=object(welcome.messages)['ch-chat'];assert(Array.isArray(history));
    const restoredMessage=parseChatMessage(history.find(value=>object(value).id===sent.id) ?? null);assert.deepEqual(restoredMessage.attachment,attachment);assert.equal(restoredMessage.reactions?.[0].userIds.length,2);
    assert.equal(restoredMessage.reactions?.[0].kind,'server');success(await info(restored,publicAsset.sha256));rejected(await info(restored,privateAsset.sha256),'permission-denied');assert.equal(fs.existsSync(mediaFile),true);
    assert.equal(parseChatMessage(success(await request(restored,'chat',chatPayload,chatId)).message ?? null).id,sent.id,'Persistent author identity deduplicates retries after restart');
    const restoredDomain=await connect(backend,'Restarted administrator');const roleState=await authenticate(restoredDomain,adminKey);assert.equal(governance.domainRole(journal(roleState),adminKey.key,'srv-main'),'server-admin');
    current=await catalogChange(restoredDomain,adminKey,current,{...command,emojiId:'restored-emoji',ts:Date.now()});assert.equal((governance.governanceState(current).emojis ?? []).length,1);
  }catch(error){if(backend)console.error(JSON.stringify({event:'chat_media_server_failure',output:backend.output()}));throw error;}
  finally{if(backend)await stop(backend);cleanup(directory);}
});

test('actual restored signed catalog reports authorized but uncached AVIF as temporarily unavailable',{timeout:15000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-roles-chat-media-'));/** @type {Backend|null} */let backend=null;
  try{
    const creator=identity(),member=identity(),anchor={version:/** @type {const} */(1),roomId:randomUUID(),creatorKey:creator.key};
    const metadata=parseMediaMetadata({sha256:hash(animation),...await codec.validate(animation,'server',new AbortController().signal)});
    const initial=governance.createGovernance(anchor),seed=governance.appendGovernance(initial,signedEvent(initial,creator,{type:'putEmoji',domainId:null,emojiId:'remote-only',name:'Remote backup',asset:metadata,ts:Date.now()}));
    const document=replica.createRoomDocument(anchor,0,[{id:'srv-main',name:'Restored domain',icon:'R',color:'#123456',channels:[{id:'ch-chat',name:'Chat',type:'text',userLimit:0}]}]);
    const roomSeed=path.join(directory,'room.json'),aclSeed=path.join(directory,'governance.json');fs.writeFileSync(roomSeed,JSON.stringify(document));fs.writeFileSync(aclSeed,JSON.stringify(seed));
    backend=await launch(path.join(directory,'backend'),{ECHO_ROOM_ID:anchor.roomId,ECHO_ROOM_CREATOR_KEY:anchor.creatorKey,ECHO_ROOM_SEED_PATH:roomSeed,ECHO_GOVERNANCE_SEED_PATH:aclSeed});
    const client=await connect(backend,'Remote cache reader');await authenticate(client,member);const result=await info(client,metadata.sha256);rejected(result,'media-unavailable');assert.equal(string(result.message).includes(directory),false);
    rejected(await info(client,'0'.repeat(64)),'permission-denied');
  }catch(error){if(backend)console.error(JSON.stringify({event:'chat_media_uncached_failure',output:backend.output()}));throw error;}
  finally{if(backend)await stop(backend);cleanup(directory);}
});
