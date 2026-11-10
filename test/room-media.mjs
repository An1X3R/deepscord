// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import media from '../lib/media-store.cjs';
import roomMedia from '../lib/room-media.cjs';
import codec from '../lib/avif-codec.cjs';
import governance from '../lib/server-governance.cjs';
import {mediaObject,parseMediaMetadata} from '../public/js/chat-protocol.js';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../public/js/chat-protocol.js').MediaMetadata} MediaMetadata */
/** @typedef {import('../lib/room-media.cjs').MediaActor} MediaActor */
/** @typedef {import('../lib/server-governance.cjs').GovernanceCommand} GovernanceCommand */
/** @typedef {{key:string,privateKey:import('node:crypto').KeyObject}} Identity */
/** @typedef {{root:string,owner:Identity,visitor:Identity,replacement:Identity,service:ReturnType<typeof roomMedia.createRoomMedia>,storage:ReturnType<typeof media.openMediaStore>,change:(command:GovernanceCommand)=>void,publish:(references:string[])=>void,close:()=>void}} Fixture */
const bytes=fs.readFileSync(new URL('avif-codec-fixtures/transparent-animation.avif',import.meta.url)),hash=createHash('sha256').update(bytes).digest('hex');

/** @returns {Identity} */function identity(){const pair=generateKeyPairSync('ed25519');return {key:pair.publicKey.export({format:'der',type:'spki'}).toString('base64'),privateKey:pair.privateKey};}
/** @param {Identity} person @returns {MediaActor} */function actor(person){return {id:randomUUID(),memberKey:person.key};}
/** @returns {Fixture} */function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-room-media-')),owner=identity(),visitor=identity(),replacement=identity(),roomId=randomUUID();
  let journal=governance.createGovernance({version:1,roomId,creatorKey:owner.key}),policy=governance.governanceState(journal);
  /** @type {string[]} */let references=[];
  const storage=media.openMediaStore({rootDir:root,roomId,validate:codec.validate,limits:{rootBytes:512*1024*1024,roomBytes:256*1024*1024,stagingBytes:8*1024*1024,concurrentUploads:4,uploadTtlMs:60000,unpublishedTtlMs:300000}});
  const service=roomMedia.createRoomMedia({storage,getReferences:()=>[...references],canManage:key=>key===policy.ownerKey || policy.serverAdmins?.includes(key)===true});
  /** @param {GovernanceCommand} command @returns {void} */function change(command){const event={revision:journal.events.length+1,previousDigest:journal.digest,actorKey:owner.key,command,signature:sign(null,Buffer.from(governance.governancePayload(journal,owner.key,command)),owner.privateKey).toString('base64')};journal=governance.appendGovernance(journal,event);policy=governance.governanceState(journal);}
  /** @param {string[]} next @returns {void} */function publish(next){references=[...next];storage.replaceReferences({catalog:[],history:[...next],backupPins:[]});}
  /** @returns {void} */function close(){storage.close();assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('deepscord-room-media-'));fs.rmSync(root,{recursive:true,force:true});}
  return {root,owner,visitor,replacement,service,storage,change,publish,close};
}
/** @param {Fixture} context @param {MediaActor} sender @param {'server'|'personal'|'image'} kind @param {string|null} domainId @returns {Promise<string>} */async function begin(context,sender,kind,domainId){
  const response=mediaObject(await context.service.execute(sender,{requestId:randomUUID(),op:'begin',kind,sha256:hash,bytes:bytes.length,domainId}),'Begin result');assert.equal(typeof response.uploadId,'string');return /** @type {string} */(response.uploadId);
}
/** @param {Fixture} context @param {MediaActor} sender @param {string} uploadId @returns {Promise<void>} */async function write(context,sender,uploadId){for(let offset=0;offset<bytes.length;offset+=16384)await context.service.execute(sender,{requestId:randomUUID(),op:'write',uploadId,offset,data:bytes.subarray(offset,offset+16384).toString('base64')});}
/** @param {Fixture} context @param {MediaActor} sender @param {string} uploadId @returns {Promise<MediaMetadata>} */async function finish(context,sender,uploadId){const result=mediaObject(await context.service.execute(sender,{requestId:randomUUID(),op:'finish',uploadId}),'Finish result');assert(result.asset);return parseMediaMetadata(result.asset);}
/** @param {MediaActor} sender @param {Fixture} context @returns {Promise<JsonValue>} */function info(sender,context){return context.service.execute(sender,{requestId:randomUUID(),op:'info',sha256:hash});}
/** @param {string} code @returns {(error:Error)=>boolean} */function errorCode(code){return error=>error instanceof roomMedia.MediaError && error.code===code;}

test('real stored media stays private until referenced, with exact descriptor checks and authorized deduplication',async()=>{
  const context=fixture(),owner=actor(context.owner),visitor=actor(context.visitor);
  try{
    const uploadId=await begin(context,owner,'server',null);await write(context,owner,uploadId);const asset=await finish(context,owner,uploadId);
    await assert.rejects(info(visitor,context),errorCode('permission-denied'));
    const hidden=await begin(context,visitor,'personal',null);await context.service.execute(visitor,{requestId:randomUUID(),op:'cancel',uploadId:hidden});
    assert.deepEqual(context.service.authorizeAttachment(owner,asset),asset);assert.throws(()=>context.service.authorizeAttachment(owner,{...asset,width:asset.width+1}),errorCode('media-invalid'));
    assert.throws(()=>context.service.authorizeAttachment(visitor,asset),errorCode('permission-denied'));
    context.publish([hash]);assert.deepEqual(await info(visitor,context),{asset});assert.deepEqual(context.service.authorizeAttachment(visitor,asset),asset);
    const result=mediaObject(await context.service.execute(visitor,{requestId:randomUUID(),op:'read',sha256:hash,offset:0,length:Math.min(16384,bytes.length)}),'Read result');assert.equal(typeof result.data,'string');assert.deepEqual(Buffer.from(/** @type {string} */(result.data),'base64'),bytes.subarray(0,16384));
    assert.deepEqual(await context.service.execute(visitor,{requestId:randomUUID(),op:'begin',kind:'personal',sha256:hash,bytes:bytes.length,domainId:null}),{asset});
    await assert.rejects(context.service.execute(visitor,{requestId:randomUUID(),op:'begin',kind:'personal',sha256:hash,bytes:bytes.length+1,domainId:null}),errorCode('media-invalid'));
    await assert.rejects(begin(context,visitor,'server','srv-main'),errorCode('permission-denied'));
    context.publish([]);await assert.rejects(info(visitor,context),errorCode('permission-denied'));assert.deepEqual(await info(owner,context),{asset});
    context.service.dropActor(owner.id);await assert.rejects(info(owner,context),errorCode('permission-denied'));
    context.publish(['0'.repeat(64)]);await assert.rejects(context.service.execute(visitor,{requestId:randomUUID(),op:'info',sha256:'0'.repeat(64)}),errorCode('media-unavailable'));
    await assert.rejects(info({id:randomUUID(),memberKey:null},context),errorCode('permission-denied'));
  }finally{context.close();}
});

test('uploads bind to the proved actor, enforce one active stream, canonical chunks and disconnect cancellation',async()=>{
  const context=fixture(),owner=actor(context.owner),visitor=actor(context.visitor);
  try{
    const uploadId=await begin(context,visitor,'personal',null);await assert.rejects(begin(context,visitor,'image',null),errorCode('media-busy'));
    for(const op of ['finish','cancel'])await assert.rejects(context.service.execute(owner,{requestId:randomUUID(),op,uploadId}),errorCode('permission-denied'));
    await assert.rejects(context.service.execute(owner,{requestId:randomUUID(),op:'write',uploadId,offset:0,data:'AA=='}),errorCode('permission-denied'));
    await assert.rejects(context.service.execute(visitor,{requestId:randomUUID(),op:'write',uploadId,offset:0,data:'AB=='}),errorCode('media-invalid'));assert.equal(context.storage.hasUpload(uploadId),false);
    const replacement=await begin(context,visitor,'personal',null);context.service.dropActor(visitor.id);assert.equal(context.storage.hasUpload(replacement),false);assert.equal(context.storage.stats().stagingBytes,0);
    const active=await begin(context,visitor,'personal',null);await write(context,visitor,active);const pending=context.service.execute(visitor,{requestId:randomUUID(),op:'finish',uploadId:active});context.service.dropActor(visitor.id);
    await assert.rejects(pending);assert.equal(context.storage.metadata(hash),null);
  }finally{context.close();}
});

test('real signed server permissions reject domain owners and revoke uploads before or during real decoder validation',async()=>{
  const context=fixture(),visitor=actor(context.visitor);
  try{
    context.change({type:'setDomainOwner',domainId:'srv-main',memberKey:context.visitor.key});
    await assert.rejects(begin(context,visitor,'server','srv-night'),errorCode('permission-denied'));
    await assert.rejects(begin(context,visitor,'server',null),errorCode('permission-denied'));
    context.change({type:'setServerAdmin',memberKey:context.visitor.key,enabled:true});
    const first=await begin(context,visitor,'server',null);await write(context,visitor,first);context.change({type:'setServerAdmin',memberKey:context.visitor.key,enabled:false});
    await assert.rejects(finish(context,visitor,first),errorCode('permission-denied'));assert.equal(context.storage.hasUpload(first),false);
    context.change({type:'setServerAdmin',memberKey:context.visitor.key,enabled:true});
    const second=await begin(context,visitor,'server',null);await write(context,visitor,second);const pending=finish(context,visitor,second);
    context.change({type:'setServerAdmin',memberKey:context.visitor.key,enabled:false});await assert.rejects(pending,errorCode('permission-denied'));
    await assert.rejects(info(visitor,context),errorCode('permission-denied'));assert(context.storage.metadata(hash),'Committed unpublished content remains eligible for later GC without granting actor access');
  }finally{context.close();}
});

test('per-member chunk rate is bounded across connections and returns an explicit retry delay',async()=>{
  const context=fixture(),visitor=actor(context.visitor),sameMember=actor(context.visitor);
  try{
    const uploadId=await begin(context,visitor,'personal',null),other=await begin(context,sameMember,'personal',null);
    for(let offset=0;offset<16;offset++)await context.service.execute(visitor,{requestId:randomUUID(),op:'write',uploadId,offset,data:bytes.subarray(offset,offset+1).toString('base64')});
    await assert.rejects(context.service.execute(sameMember,{requestId:randomUUID(),op:'write',uploadId:other,offset:0,data:bytes.subarray(0,1).toString('base64')}),error=>error instanceof roomMedia.MediaError && error.code==='media-rate-limited' && typeof error.retryAfterMs==='number' && error.retryAfterMs>0 && error.retryAfterMs<=1000);
    assert.equal(context.storage.hasUpload(uploadId),true);assert.equal(context.storage.hasUpload(other),true);
    context.service.dropActor(visitor.id);context.service.dropActor(sameMember.id);assert.equal(context.storage.stats().activeUploads,0);
  }finally{context.close();}
});

test('a real SQLite root lock returns bounded busy errors and preserves a validated upload for explicit retry',async()=>{
  const context=fixture(),visitor=actor(context.visitor),database=new DatabaseSync(path.join(context.root,'.budget.sqlite'),{open:true,readOnly:false,enableForeignKeyConstraints:true,enableDoubleQuotedStringLiterals:false,allowExtension:false});let locked=false;
  try{
    const uploadId=await begin(context,visitor,'personal',null);await write(context,visitor,uploadId);
    database.exec('BEGIN IMMEDIATE;');locked=true;
    await assert.rejects(finish(context,visitor,uploadId),error=>error instanceof roomMedia.MediaError && error.code==='media-busy' && error.retryAfterMs===25 && !error.message.includes(context.root));
    assert.equal(context.storage.hasUpload(uploadId),true);assert.equal(context.storage.metadata(hash),null);
    database.exec('ROLLBACK;');locked=false;const asset=await finish(context,visitor,uploadId);assert.deepEqual(context.service.authorizeAttachment(visitor,asset),asset);
  }finally{if(locked)database.exec('ROLLBACK;');database.close();context.close();}
});

test('download and upload rate windows stay independent for the same proved member',async()=>{
  const context=fixture(),visitor=actor(context.visitor);
  try{
    const uploadId=await begin(context,visitor,'personal',null);await write(context,visitor,uploadId);await finish(context,visitor,uploadId);
    for(let index=0;index<16;index++)await context.service.execute(visitor,{requestId:randomUUID(),op:'read',sha256:hash,offset:0,length:1});
    await assert.rejects(context.service.execute(visitor,{requestId:randomUUID(),op:'read',sha256:hash,offset:0,length:1}),errorCode('media-rate-limited'));
    const altered=Buffer.from(bytes);altered[altered.length-1]^=1;const otherHash=createHash('sha256').update(altered).digest('hex');
    const opened=mediaObject(await context.service.execute(visitor,{requestId:randomUUID(),op:'begin',kind:'personal',sha256:otherHash,bytes:altered.length,domainId:null}),'Begin result'),otherId=opened.uploadId;assert.equal(typeof otherId,'string');
    await context.service.execute(visitor,{requestId:randomUUID(),op:'write',uploadId:otherId ?? null,offset:0,data:altered.subarray(0,1).toString('base64')});context.service.dropActor(visitor.id);
  }finally{context.close();}
});
