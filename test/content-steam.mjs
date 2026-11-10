// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {generateKeyPairSync,randomBytes,randomUUID,sign,createHash} from 'node:crypto';
import {cleanClientCommand} from '../desktop/steam-commands.cjs';
import {parsePeerSignal} from '../public/js/network-protocol.js';
import {parseContentPolicy,contentPolicyPayload} from '../public/js/content-protocol.js';
import {generateContentKey,sealMessage,sealFile,inspectSealedFile,contentDigest} from '../lib/content-crypto.cjs';
import {createGovernance} from '../lib/server-governance.cjs';
import {createRoomDocument} from '../lib/room-replica.cjs';
import {parseSteamCheckpoint} from '../lib/steam-state.cjs';
import {collectContentAssets} from '../lib/chat-assets.cjs';
import {reactionActor} from '../lib/message-reactions.cjs';
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @param {JsonValue} command @returns {JsonValue} */
function transport(command){return JSON.parse(cleanClientCommand(JSON.stringify(command),parsePeerSignal));}

test('Steam command transport preserves normal encrypted chat and each history migration operation',()=>{
  const pair=generateKeyPairSync('ed25519'),memberKey=pair.publicKey.export({format:'der',type:'spki'}).toString('base64');
  const roomId=randomUUID(),key=generateContentKey(),requestId=randomUUID(),migrationId=randomUUID();
  const sealed=sealMessage({context:{roomId,channelId:'ch-text',requestId},keyId:key.id,key:key.key,nonce:randomBytes(12),memberKey,sign:bytes=>sign(null,bytes,pair.privateKey)},{text:'Private Steam chat'});
  const plain=fs.readFileSync(new URL('avif-codec-fixtures/transparent-animation.avif',import.meta.url));
  const bytes=sealFile({version:1,roomId,keyId:key.id,nonce:randomBytes(12).toString('base64url'),kind:'personal',bytes:plain.length,width:48,height:48,frames:2,animated:true,durationMs:200},key.key,plain);
  const header=inspectSealedFile(bytes).header;
  const asset={sha256:contentDigest(bytes),bytes:bytes.length,width:header.width,height:header.height,frames:header.frames,animated:header.animated,durationMs:header.durationMs,encrypted:/** @type {const} */(true),mediaKind:header.kind};
  const attachment={...asset,kind:/** @type {const} */('sticker'),name:'encrypted.avif'};
  const hello={t:'hello',name:'Member',color:'#123456',password:'',contentVersion:1};
  assert.deepEqual(transport(hello),hello);
  const plainHello={t:'hello',name:'Member',color:'#123456',password:''};
  assert.deepEqual(transport(plainHello),plainHello);
  const chat={t:'chat',channelId:'ch-text',requestId,text:'',sealed,attachment};
  assert.deepEqual(transport(chat),chat);
  const plainChat={t:'chat',channelId:'ch-text',text:'Plain room remains compatible'};
  assert.deepEqual(transport(plainChat),plainChat);
  const unsigned={version:/** @type {const} */(1),roomId,keyId:key.id,keyHash:contentDigest(key.key),ownerKey:memberKey,governanceRevision:0,assets:[{source:contentDigest(plain),asset}]};
  const policy=parseContentPolicy({...unsigned,signature:sign(null,Buffer.from(contentPolicyPayload(unsigned)),pair.privateKey).toString('base64url')});
  const historySealed=sealMessage({context:{roomId,channelId:'ch-text',requestId:'migration-'+createHash('sha256').update('original').digest('hex')},keyId:key.id,key:key.key,nonce:randomBytes(12),memberKey,sign:bytes=>sign(null,bytes,pair.privateKey)},{text:'Original history'});
  /** @type {JsonValue[]} */const commands=[
    {t:'contentRequest',requestId,op:'begin',keyId:key.id},
    {t:'contentRequest',requestId,op:'read',migrationId,index:0},
    {t:'contentRequest',requestId,op:'replace',migrationId,channelId:'ch-text',messageId:'original',sealed:historySealed,attachment},
    {t:'contentRequest',requestId,op:'commit',migrationId,policy},
    {t:'contentRequest',requestId,op:'cancel',migrationId},
  ];
  commands.push({t:'setReaction',requestId,channelId:'ch-text',messageId:'original',sealed},{t:'setReaction',requestId,channelId:'ch-text',messageId:'original',selection:{kind:'unicode',emoji:'👍'},active:true});
  for(const command of commands)assert.deepEqual(transport(command),command);
});

test('Steam checkpoints retain signed content policy and encrypted history-only media references',()=>{
  const pair=generateKeyPairSync('ed25519'),memberKey=pair.publicKey.export({format:'der',type:'spki'}).toString('base64');
  const roomId=randomUUID(),key=generateContentKey(),requestId='migration-'+createHash('sha256').update('original').digest('hex'),descriptor={version:/** @type {const} */(1),roomId,creatorKey:memberKey};
  const governance=createGovernance(descriptor);
  const sealed=sealMessage({context:{roomId,channelId:'ch-text',requestId},keyId:key.id,key:key.key,nonce:randomBytes(12),memberKey,sign:bytes=>sign(null,bytes,pair.privateKey)},{text:'Old history',reactions:[]});
  const plain=fs.readFileSync(new URL('avif-codec-fixtures/transparent-animation.avif',import.meta.url));
  const bytes=sealFile({version:1,roomId,keyId:key.id,nonce:randomBytes(12).toString('base64url'),kind:'image',bytes:plain.length,width:48,height:48,frames:2,animated:true,durationMs:200},key.key,plain);
  const asset={sha256:contentDigest(bytes),bytes:bytes.length,width:48,height:48,frames:2,animated:true,durationMs:200,encrypted:/** @type {const} */(true),mediaKind:/** @type {const} */('image')};
  const unsigned={version:/** @type {const} */(1),roomId,keyId:key.id,keyHash:contentDigest(key.key),ownerKey:memberKey,governanceRevision:0,assets:[{source:contentDigest(plain),asset}]};
  const content=parseContentPolicy({...unsigned,signature:sign(null,Buffer.from(contentPolicyPayload(unsigned)),pair.privateKey).toString('base64url')});
  const servers=[{id:'srv-main',name:'Room',icon:'D',color:'#123456',channels:[{id:'ch-text',name:'Text',type:/** @type {const} */('text'),userLimit:0}]}];
  const message={id:'original',userId:'user-original',name:'Original author',color:'#123456',text:'',ts:1,system:false,bot:false,clientRequestId:requestId,authorId:reactionActor(memberKey),sealed};
  const checkpoint=parseSteamCheckpoint({version:1,lobbyId:'109775241012345678',ownerId:'76561198000000001',epoch:'a'.repeat(32),sequence:1,stunUrls:[],store:{version:1,servers,messages:{'ch-text':[message]},governance,content},users:[],roomDocument:createRoomDocument(descriptor,0,servers)});
  assert.deepEqual(checkpoint.store.content,content);
  assert.deepEqual(checkpoint.store.messages['ch-text'],[message]);
  const manifest=collectContentAssets([],checkpoint.store.messages,checkpoint.store.content ?? null);
  assert.deepEqual(manifest.assets,[asset]);assert.deepEqual(manifest.history,[asset.sha256]);assert.deepEqual(manifest.catalog,[]);
});
