// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,randomBytes,sign,createHash} from 'node:crypto';
import {contentPolicyPayload,parseContentPolicy} from '../public/js/content-protocol.js';
import {parseChatMessage,parseMediaMetadata} from '../public/js/chat-protocol.js';
import {generateContentKey,reactionRequestId,sealMessage,openMessage,sealFile,contentDigest,openFile} from '../lib/content-crypto.cjs';
import {parseSteamStore} from '../lib/steam-state.cjs';
import {governanceRevision,governanceCheckpointPayload} from '../lib/server-governance.cjs';
import {object,string,identity,until,launch,stop,send,receive,connect,connectHello,authenticate,journal,change,cleanup} from './server-ws-helpers.mjs';
/** @typedef {import('./server-ws-helpers.mjs').Client} Client */
/** @typedef {import('./server-ws-helpers.mjs').Backend} Backend */
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{[key:string]:JsonValue}} Message */
/** @param {Client} client @param {string} type @param {Message} payload @returns {Promise<Message>} */
async function request(client,type,payload){
  const requestId=randomUUID(),cursor=send(client,{t:type,...payload,requestId});
  const frame=await receive(client,cursor,message=>message.t===(type==='contentRequest'?'contentResult':type==='chat'?'chatResult':'mediaResult')&&message.requestId===requestId,'normal '+type+' '+payload.op);
  assert.equal(frame.ok,true,JSON.stringify(frame));return object(frame.result);
}
/** @param {Client} client @param {Buffer} bytes @param {true|null} encrypted @returns {Promise<import('../public/js/chat-protocol.js').MediaMetadata>} */
async function upload(client,bytes,encrypted){
  const begun=await request(client,'mediaRequest',{op:'begin',kind:'server',domainId:null,sha256:contentDigest(bytes),bytes:bytes.length,...(encrypted?{encrypted}: {})});
  if(begun.asset)return parseMediaMetadata(begun.asset);
  const uploadId=string(begun.uploadId);
  for(let offset=0;offset<bytes.length;offset+=16384)await request(client,'mediaRequest',{op:'write',uploadId,offset,data:bytes.subarray(offset,offset+16384).toString('base64')});
  return parseMediaMetadata((await request(client,'mediaRequest',{op:'finish',uploadId})).asset ?? null);
}

test('owner migrates real loopback history and referenced media in place, then new members and restart retain encrypted history',{timeout:45000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-roles-content-'));
  /** @type {Backend|null} */let backend=null;
  try{
    backend=await launch(directory,{});
    const ownerIdentity=identity(),owner=await connectHello(backend,{t:'hello',name:'Encryption owner',color:'#123456',password:'',resumable:false,contentVersion:1});
    await authenticate(owner,ownerIdentity);
    const cursor=send(owner,{t:'claimOwner',token:fs.readFileSync(path.join(directory,'owner-claim.txt'),'utf8').trim()});
    let governance=journal(await receive(owner,cursor,message=>message.t==='serverState'&&object(message.policy).ownerKey===ownerIdentity.key,'normal owner claim'));
    const bytes=fs.readFileSync(new URL('avif-codec-fixtures/transparent-animation.avif',import.meta.url));
    const asset=await upload(owner,bytes,null);
    governance=await change(owner,ownerIdentity,governance,{type:'putEmoji',domainId:null,emojiId:'history-emoji',name:'Original emoji',asset,ts:Date.now()});
    const sent=parseChatMessage((await request(owner,'chat',{channelId:'ch-chat',text:'Persistent secret text',attachment:{...asset,kind:'sticker',name:'Original sticker'}})).message ?? null);
    const reactionCursor=send(owner,{t:'setReaction',requestId:randomUUID(),channelId:'ch-chat',messageId:sent.id,selection:{kind:'server',emojiId:'history-emoji'},active:true});
    await receive(owner,reactionCursor,message=>message.t==='reactionResult'&&message.ok===true,'normal historical reaction');
    const key=generateContentKey(),roomId=owner.challenge.roomId;
    const begin=await request(owner,'contentRequest',{op:'begin',keyId:key.id});
    const migrationId=string(begin.migrationId),count=Number(begin.count);
    assert.equal(count,3);assert(Array.isArray(begin.assets));assert.equal(begin.assets.length,1);
    const cipher=sealFile({version:1,roomId,keyId:key.id,nonce:randomBytes(12).toString('base64url'),kind:'server',bytes:bytes.length,width:asset.width,height:asset.height,frames:asset.frames,animated:asset.animated,durationMs:asset.durationMs},key.key,bytes);
    const encrypted=await upload(owner,cipher,true);
    /** @type {Map<string,import('../public/js/chat-protocol.js').ChatMessage>} */const originals=new Map();
    for(let index=0;index<count;index++){
      const entry=await request(owner,'contentRequest',{op:'read',migrationId,index});
      const message=parseChatMessage(entry.message ?? null),channelId=string(entry.channelId);
      originals.set(message.id,message);
      const sealed=sealMessage({context:{roomId,channelId,requestId:'migration-'+createHash('sha256').update(message.id).digest('hex')},keyId:key.id,key:key.key,nonce:randomBytes(12),memberKey:ownerIdentity.key,sign:payload=>sign(null,payload,ownerIdentity.privateKey)},message);
      await request(owner,'contentRequest',{op:'replace',migrationId,channelId,messageId:message.id,sealed,...(message.attachment?{attachment:{...encrypted,kind:message.attachment.kind,name:'encrypted.avif'}}:{})});
    }
    const unsigned={version:/** @type {const} */(1),roomId,keyId:key.id,keyHash:contentDigest(key.key),ownerKey:ownerIdentity.key,governanceRevision:governance.events.length,assets:[{source:asset.sha256,asset:encrypted}]};
    const policy=parseContentPolicy({...unsigned,signature:sign(null,Buffer.from(contentPolicyPayload(unsigned)),ownerIdentity.privateKey).toString('base64url')});
    await request(owner,'contentRequest',{op:'commit',migrationId,policy});
    const raw=fs.readFileSync(path.join(directory,'store.json'),'utf8');
    assert(!raw.includes('Persistent secret text'));
    const store=parseSteamStore(JSON.parse(raw));assert.deepEqual(store.content,policy);
    const recovery=fs.readFileSync(path.join(directory,'store.json.backup'),'utf8');
    assert(!recovery.includes('Persistent secret text'));
    assert.deepEqual(parseSteamStore(JSON.parse(recovery)).content,policy);
    for(const message of store.messages['ch-chat']){
      assert(message.sealed&&message.clientRequestId);
      assert.equal(message.text,'');assert.equal(message.reactions,undefined);
      assert.deepEqual(openMessage({roomId,channelId:'ch-chat',requestId:message.clientRequestId},message.sealed,key.key),originals.get(message.id));
    }
    const objectDirectory=path.join(directory,'media',roomId,'objects');
    assert(!fs.readdirSync(objectDirectory).some(file=>file.startsWith(asset.sha256)));
    assert(fs.readdirSync(objectDirectory).some(file=>file.startsWith(encrypted.sha256)));
    assert.deepEqual(openFile(roomId,key.key,cipher).bytes,bytes);
    const newcomerIdentity=identity(),newcomer=await connectHello(backend,{t:'hello',name:'New authorized member',color:'#123456',password:'',resumable:false,contentVersion:1});
    await authenticate(newcomer,newcomerIdentity);
    const welcome=newcomer.messages.find(message=>message.t==='welcome');assert(welcome);assert.deepEqual(welcome.content,policy);
    assert.equal(object(welcome.messages)['ch-chat'] instanceof Array,true);
    const requestId=randomUUID(),sealed=sealMessage({context:{roomId,channelId:'ch-chat',requestId},keyId:key.id,key:key.key,nonce:randomBytes(12),memberKey:newcomerIdentity.key,sign:payload=>sign(null,payload,newcomerIdentity.privateKey)},{text:'New encrypted content'});
    const chatCursor=send(newcomer,{t:'chat',channelId:'ch-chat',requestId,text:'',sealed});
    const acknowledged=await receive(newcomer,chatCursor,message=>message.t==='chatResult'&&message.requestId===requestId,'new member encrypted chat');assert.equal(acknowledged.ok,true,JSON.stringify(acknowledged));
    const target=parseChatMessage(object(acknowledged.result).message ?? null),reactionId=randomUUID(),reactionSealed=sealMessage({context:{roomId,channelId:'ch-chat',requestId:reactionRequestId(target.id,reactionId)},keyId:key.id,key:key.key,nonce:randomBytes(12),memberKey:newcomerIdentity.key,sign:payload=>sign(null,payload,newcomerIdentity.privateKey)},{selection:{kind:'unicode',emoji:'👍'},active:true});
    const reactionFrame={t:'setReaction',channelId:'ch-chat',messageId:target.id,requestId:reactionId,sealed:reactionSealed};
    for(let attempt=0;attempt<2;attempt++){const cursor=send(newcomer,reactionFrame),reply=await receive(newcomer,cursor,message=>message.t==='reactionResult'&&message.requestId===reactionId,'encrypted reaction accepted without disconnect');assert.equal(reply.ok,true,JSON.stringify(reply));const updated=parseChatMessage(object(reply.result).message ?? null);assert.equal(updated.sealedReactions?.length,1);assert.equal(updated.reactions,undefined);assert.deepEqual(openMessage({roomId,channelId:'ch-chat',requestId:reactionRequestId(updated.id,reactionId)},updated.sealedReactions[0].sealed,key.key),{selection:{kind:'unicode',emoji:'👍'},active:true});}
    const freshCipher=sealFile({version:1,roomId,keyId:key.id,nonce:randomBytes(12).toString('base64url'),kind:'server',bytes:bytes.length,width:48,height:48,animated:true,frames:2,durationMs:200},key.key,bytes),freshAsset=await upload(owner,freshCipher,true);
    governance=await change(owner,ownerIdentity,governance,{type:'putEmoji',domainId:null,emojiId:'new-encrypted-emoji',name:'New encrypted emoji',asset:freshAsset,ts:Date.now()});
    const mediaReactionId=randomUUID(),mediaReaction=sealMessage({context:{roomId,channelId:'ch-chat',requestId:reactionRequestId(target.id,mediaReactionId)},keyId:key.id,key:key.key,nonce:randomBytes(12),memberKey:newcomerIdentity.key,sign:payload=>sign(null,payload,newcomerIdentity.privateKey)},{selection:{kind:'server',emojiId:'new-encrypted-emoji'},active:true,emoji:{id:'new-encrypted-emoji',domainId:null,name:'New encrypted emoji',asset:freshAsset,addedBy:ownerIdentity.key,ts:Date.now()}});
    const mediaReactionCursor=send(newcomer,{t:'setReaction',channelId:'ch-chat',messageId:target.id,requestId:mediaReactionId,sealed:mediaReaction});await receive(newcomer,mediaReactionCursor,message=>message.t==='reactionResult'&&message.requestId===mediaReactionId&&message.ok===true,'encrypted custom emoji reaction');
    governance=await change(owner,ownerIdentity,governance,{type:'deleteEmoji',domainId:null,emojiId:'new-encrypted-emoji'});
    assert.deepEqual(parseMediaMetadata((await request(newcomer,'mediaRequest',{op:'info',sha256:freshAsset.sha256})).asset ?? null),freshAsset);
    governance=await change(owner,ownerIdentity,governance,{type:'transferOwner',memberKey:newcomerIdentity.key});
    const compactCursor=send(newcomer,{t:'governanceChange',requestId:randomUUID(),expectedDigest:governance.digest,checkpointSignature:sign(null,Buffer.from(governanceCheckpointPayload(governance)),newcomerIdentity.privateKey).toString('base64')});
    governance=journal(await receive(newcomer,compactCursor,message=>message.t==='serverState'&&object(message.journal).checkpoint!==undefined,'owner-approved checkpoint preserves encrypted history'));
    await until(()=>{const persisted=parseSteamStore(JSON.parse(fs.readFileSync(path.join(directory,'store.json'),'utf8')));return persisted.messages['ch-chat'].some(message=>message.id===target.id&&message.sealedReactions?.length===2);},()=>null,'encrypted reaction persisted before process termination');
    await stop(backend);backend=null;
    backend=await launch(directory,{});
    const restored=await connectHello(backend,{t:'hello',name:'Restored member',color:'#123456',password:'',resumable:false,contentVersion:1});
    await authenticate(restored,newcomerIdentity);
    const restoredWelcome=restored.messages.find(message=>message.t==='welcome');assert(restoredWelcome);assert.deepEqual(restoredWelcome.content,policy);
    const restoredMessages=object(restoredWelcome.messages)['ch-chat'];assert(Array.isArray(restoredMessages));const restoredTarget=restoredMessages.map(parseChatMessage).find(message=>message.id===target.id);assert.equal(restoredTarget?.sealedReactions?.length,2);
    assert.deepEqual(parseMediaMetadata((await request(restored,'mediaRequest',{op:'info',sha256:freshAsset.sha256})).asset ?? null),freshAsset);
    assert.equal(governanceRevision(journal(restored.messages.find(message=>message.t==='serverState'&&message.selfKey===newcomerIdentity.key) ?? {})),governanceRevision(governance));
    assert.equal(fs.readdirSync(path.join(directory,'governance-archive')).length,1);
  }finally{if(backend)await stop(backend);cleanup(directory);}
});
