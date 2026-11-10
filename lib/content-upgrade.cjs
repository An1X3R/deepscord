// @ts-check
'use strict';
const {randomUUID,createPublicKey,createHash,verify}=require('node:crypto');
const {governanceRevision,ownerProofs}=require('../public/js/governance-checkpoint.js');
const {parseContentPolicy,contentPolicyPayload,contentKeyId}=require('../public/js/content-protocol.js');
const {parseAttachment,parseMediaMetadata}=require('../public/js/chat-protocol.js');
const {parseSealedMessage,verifySealedMessage}=require('./content-crypto.cjs');
const {reactionActor}=require('./message-reactions.cjs');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../public/js/content-protocol.js').ContentPolicy} ContentPolicy */
/** @typedef {import('./steam-state.cjs').RoomStore} RoomStore */
/** @typedef {import('./steam-state.cjs').HistoryMessage} HistoryMessage */
/** @typedef {import('../public/js/chat-protocol.js').MediaMetadata} MediaMetadata */
/** @typedef {{channelId:string,message:HistoryMessage}} Entry */
/** @typedef {{id:string,ownerId:string,ownerKey:string,keyId:string,snapshot:RoomStore,entries:Entry[],assets:MediaMetadata[],replacements:Map<string,HistoryMessage>}} Migration */

/** @param {JsonValue} value @param {string} roomId @returns {ContentPolicy} */
function verifyContentPolicy(value,roomId){
  const policy=parseContentPolicy(value);
  if(policy.roomId!==roomId)throw new TypeError('Encryption policy belongs to another room');
  const key=createPublicKey({key:Buffer.from(policy.ownerKey,'base64'),type:'spki',format:'der'});
  if(!verify(null,Buffer.from(contentPolicyPayload(policy)),key,Buffer.from(policy.signature,'base64url')))throw new TypeError('Room encryption policy signature is invalid');
  return policy;
}
/** @param {ContentPolicy} policy @param {import('./server-governance.cjs').GovernanceJournal} journal @returns {void} */
function verifyContentOwner(policy,journal){
  if(policy.roomId!==journal.roomId||policy.governanceRevision>governanceRevision(journal))throw new TypeError('Encryption policy activation revision is absent from its governance journal');
  const owner=ownerProofs(journal).filter(event=>event.revision<=policy.governanceRevision).reduce((key,event)=>event.command.type==='transferOwner'?event.command.memberKey:key,journal.creatorKey);
  if(owner!==policy.ownerKey)throw new TypeError('Encryption policy was not signed by its activation owner');
}

/** @param {string} roomId */
function createContentUpgrade(roomId){
  /** @type {Migration|null} */let migration=null;
  /** @param {string} ownerId @param {string} id @returns {Migration} */
  function current(ownerId,id){if(!migration||migration.id!==id||migration.ownerId!==ownerId)throw new TypeError('History migration is not owned by this connection');return migration;}
  /** @param {{ownerId:string,ownerKey:string,keyId:JsonValue,store:RoomStore,assets:MediaMetadata[]}} options */
  function begin(options){
    if(migration)throw new TypeError('History encryption migration is already running');
    if(options.store.content)throw new TypeError('Room history encryption is already enabled');
    const snapshot=structuredClone(options.store),entries=Object.entries(snapshot.messages).flatMap(([channelId,messages])=>messages.map(message=>({channelId,message})));
    if(options.assets.length>4096||entries.length>144000)throw new RangeError('History migration exceeds its bounded inventory');
    migration={id:randomUUID(),ownerId:options.ownerId,ownerKey:options.ownerKey,keyId:contentKeyId(options.keyId),snapshot,entries,assets:structuredClone(options.assets),replacements:new Map()};
    return {migrationId:migration.id,count:entries.length,assets:migration.assets};
  }
  /** @param {string} ownerId @param {string} id @param {number} index @returns {Entry} */
  function read(ownerId,id,index){const session=current(ownerId,id);if(!Number.isSafeInteger(index)||index<0||index>=session.entries.length)throw new RangeError('History migration index is outside its snapshot');return structuredClone(session.entries[index]);}
  /** @param {string} ownerId @param {{migrationId:string,channelId:string,messageId:string,sealed:JsonValue,attachment?:JsonValue}} input */
  function replace(ownerId,input){
    const session=current(ownerId,input.migrationId),entry=session.entries.find(item=>item.channelId===input.channelId&&item.message.id===input.messageId);
    if(!entry)throw new TypeError('History migration message is absent from its snapshot');
    const requestId='migration-'+createHash('sha256').update(entry.message.id).digest('hex'),sealed=parseSealedMessage(input.sealed);
    if(sealed.memberKey!==session.ownerKey||sealed.keyId!==session.keyId)throw new TypeError('History replacement must use the migration owner and selected encryption key');
    verifySealedMessage({roomId,channelId:entry.channelId,requestId},sealed);
    const attachment=input.attachment===undefined ? null : parseAttachment(input.attachment);
    if(Boolean(entry.message.attachment)!==Boolean(attachment)||attachment&&attachment.encrypted!==true)throw new TypeError('History attachment must be replaced by encrypted media');
    const {attachment:oldAttachment,reactions:oldReactions,reactionRevision:oldRevision,...original}=entry.message;
    const message={...original,text:'',sealed,clientRequestId:requestId,authorId:reactionActor(session.ownerKey),...(attachment?{attachment:{...attachment,name:'encrypted.avif'}}:{})};
    session.replacements.set(entry.message.id,message);
    return {replaced:session.replacements.size,count:session.entries.length};
  }
  /** @param {string} ownerId @param {string} id @param {JsonValue} value @param {string} ownerKey @param {(asset:MediaMetadata)=>void} requireStored @returns {RoomStore} */
  function prepare(ownerId,id,value,ownerKey,requireStored){
    const session=current(ownerId,id),policy=verifyContentPolicy(value,roomId);
    if(ownerKey!==session.ownerKey||policy.ownerKey!==ownerKey||policy.keyId!==session.keyId||!session.snapshot.governance||policy.governanceRevision!==governanceRevision(session.snapshot.governance))throw new TypeError('History commit requires the current owner, governance revision and selected encryption key');
    if(session.replacements.size!==session.entries.length)throw new TypeError('Every history message must be encrypted before activation');
    const mapped=new Map(policy.assets.map(item=>[item.source,item.asset]));
    if(mapped.size!==session.assets.length)throw new TypeError('Encrypted history asset mapping must exactly cover the original inventory');
    for(const asset of session.assets){const replacement=mapped.get(asset.sha256);if(!replacement)throw new TypeError('History asset has no encrypted replacement: '+asset.sha256);requireStored(replacement);}
    /** @type {Record<string,HistoryMessage[]>} */const messages={};
    for(const [channelId,entries] of Object.entries(session.snapshot.messages))messages[channelId]=entries.map(original=>{
      const replacement=session.replacements.get(original.id);if(!replacement)throw new TypeError('Encrypted history replacement is missing');
      if(original.attachment&&replacement.attachment&&JSON.stringify(mapped.get(original.attachment.sha256))!==JSON.stringify(parseMediaMetadata(replacement.attachment)))throw new TypeError('Encrypted attachment differs from its signed history mapping');
      return replacement;
    });
    return {...session.snapshot,messages,content:policy};
  }
  /** @param {string} ownerId @param {string} id @returns {void} */
  function cancel(ownerId,id){current(ownerId,id);migration=null;}
  /** @param {string} ownerId @returns {boolean} */
  function drop(ownerId){if(migration?.ownerId!==ownerId)return false;migration=null;return true;}
  return{begin,read,replace,prepare,cancel,drop,active:()=>migration!==null,ownerId:()=>migration?.ownerId??null,ownerKey:()=>migration?.ownerKey??null,keyId:()=>migration?.keyId??null};
}
module.exports={verifyContentPolicy,verifyContentOwner,createContentUpgrade};
