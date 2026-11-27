// @ts-check
import {parseContentMessage} from './content-protocol.js';
/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {'server'|'personal'|'image'} MediaKind */
/** @typedef {{sha256:string,bytes:number,width:number,height:number,animated:boolean,frames:number,durationMs:number,encrypted?:true,mediaKind?:MediaKind}} MediaMetadata */
/** @typedef {MediaMetadata & {kind:'sticker'|'image',name:string}} Attachment */
/** @typedef {{id:string,domainId:string|null,name:string,asset:MediaMetadata,addedBy:string,ts:number}} ServerEmoji */
/** @typedef {{kind:'unicode',emoji:string}|{kind:'server',emojiId:string}} ReactionSelection */
/** @typedef {{key:string,kind:'unicode',emoji:string,userIds:string[]}|{key:string,kind:'server',emojiId:string,name:string,asset:MediaMetadata,userIds:string[]}} Reaction */
/** @typedef {{id:string,userId:string,name:string,color:string,text:string,replyToId?:string,ts:number,system:boolean,bot:boolean,attachment?:Attachment,reactions?:Reaction[],reactionRevision?:number,clientRequestId?:string,authorId?:string,sealed?:import('./content-protocol.js').SealedMessage,sealedReactions?:{requestId:string,sealed:import('./content-protocol.js').SealedMessage}[]}} ChatMessage */
/** @typedef {{requestId:string,op:'begin',kind:MediaKind,sha256:string,bytes:number,domainId:string|null,encrypted?:true}|{requestId:string,op:'write',uploadId:string,offset:number,data:string}|{requestId:string,op:'finish'|'cancel',uploadId:string}|{requestId:string,op:'info',sha256:string}|{requestId:string,op:'read',sha256:string,offset:number,length:number}} MediaRequest */

export const UNICODE_EMOJIS=Object.freeze(['😀','😃','😄','😁','😆','😅','😂','🤣','😊','🙂','😉','😍','🥰','😘','😎','🤔','🤨','😐','😑','🙄','😴','😭','😢','😤','😡','🤯','😱','🥺','😳','🤗','🫡','🤝','👍','👎','👏','🙌','🙏','💪','❤️','💔','🔥','✨','🎉','🎊','💯','✅','❌','❓','👀','💤','🎵','🎮','🍀','☕','🍻','🚀','0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟']);
export const MEDIA_LIMITS=Object.freeze({server:{dimension:240,bytes:96*1024,target:160},personal:{dimension:360,bytes:160*1024,target:320},image:{dimension:1920,bytes:1536*1024,target:1920}});
export const MEDIA_CHUNK_BYTES=16*1024;
export const MEDIA_ENCRYPTION_OVERHEAD=794;
export const MAX_MEDIA_FRAMES=180;
export const MAX_MEDIA_DURATION_MS=10000;
export const MAX_MEDIA_DECODED_PIXELS=24*1024*1024;

/** @param {JsonValue|undefined} value @param {string} label @returns {{[key:string]:JsonValue}} */
export function mediaObject(value,label){if(!value || typeof value!=='object' || Array.isArray(value))throw new TypeError(label+' must be an object');return value;}
/** @param {JsonValue|undefined} value @param {string} label @param {number} maximum @returns {string} */
export function mediaText(value,label,maximum){if(typeof value!=='string' || !value.trim() || value.length>maximum || /[\u0000-\u001f\u007f]/.test(value))throw new TypeError(label+' must contain 1-'+maximum+' printable characters');return value;}
/** @param {JsonValue|undefined} value @param {string} label @returns {string} */
export function mediaId(value,label){const result=mediaText(value,label,80);if(!/^[A-Za-z0-9_-]+$/.test(result) || ['__proto__','prototype','constructor'].includes(result))throw new TypeError(label+' must be a safe identifier');return result;}
/** @param {JsonValue|undefined} value @returns {string} */
export function mediaHash(value){if(typeof value!=='string' || !/^[a-f0-9]{64}$/.test(value))throw new TypeError('Media SHA256 must contain 64 lowercase hexadecimal characters');return value;}
/** @param {JsonValue|undefined} value @param {string} label @param {number} minimum @param {number} maximum @returns {number} */
export function mediaInteger(value,label,minimum,maximum){if(typeof value!=='number' || !Number.isSafeInteger(value) || value<minimum || value>maximum)throw new RangeError(label+' must be an integer in '+minimum+'..'+maximum);return value;}
/** @param {JsonValue|undefined} value @returns {MediaKind} */
export function parseMediaKind(value){if(value!=='server' && value!=='personal' && value!=='image')throw new TypeError('Unsupported media kind');return value;}
/** @param {JsonValue} value @returns {MediaMetadata} */
export function parseMediaMetadata(value){
  const row=mediaObject(value,'Media metadata');
  if(row.encrypted!==undefined && row.encrypted!==true)throw new TypeError('Media encrypted discriminator must be true when present');
  const width=mediaInteger(row.width,'Media width',1,1920),height=mediaInteger(row.height,'Media height',1,1920),frames=mediaInteger(row.frames,'Media frames',1,MAX_MEDIA_FRAMES);
  if(typeof row.animated!=='boolean' || row.animated!==(frames>1))throw new TypeError('Media animation flag must match its frame count');
  if(typeof row.durationMs!=='number' || !Number.isFinite(row.durationMs) || row.durationMs<0 || row.durationMs>MAX_MEDIA_DURATION_MS || frames>1 && row.durationMs<=0)throw new RangeError('Media duration exceeds its permitted range');
  if(width*height*frames>MAX_MEDIA_DECODED_PIXELS)throw new RangeError('Media decoded pixel budget exceeded');
  return{sha256:mediaHash(row.sha256),bytes:mediaInteger(row.bytes,'Media bytes',1,MEDIA_LIMITS.image.bytes+(row.encrypted===true?MEDIA_ENCRYPTION_OVERHEAD:0)),width,height,frames,animated:row.animated,durationMs:row.durationMs,...(row.encrypted===true?{encrypted:/** @type {const} */(true),mediaKind:parseMediaKind(row.mediaKind)}:{})};
}
/** @param {MediaMetadata} metadata @param {MediaKind} kind @returns {MediaMetadata} */
export function checkMediaKind(metadata,kind){const asset=parseMediaMetadata(metadata),limit=MEDIA_LIMITS[kind];if(asset.width>limit.dimension || asset.height>limit.dimension || asset.bytes>limit.bytes+(asset.encrypted===true?MEDIA_ENCRYPTION_OVERHEAD:0))throw new RangeError(kind+' media exceeds '+limit.dimension+' pixels or '+limit.bytes+' bytes');return asset;}
/** @param {JsonValue} value @returns {Attachment} */
export function parseAttachment(value){const row=mediaObject(value,'Attachment');if(row.kind!=='sticker' && row.kind!=='image')throw new TypeError('Unsupported attachment kind');const asset=checkMediaKind(parseMediaMetadata(row),row.kind==='sticker' ? 'personal' : 'image');return{...asset,kind:row.kind,name:mediaText(row.name,'Attachment name',80)};}
/** @param {JsonValue} value @returns {ServerEmoji} */
export function parseServerEmoji(value){const row=mediaObject(value,'Server emoji');if(row.asset===undefined)throw new TypeError('Server emoji requires an asset');return{id:mediaId(row.id,'Emoji ID'),domainId:row.domainId===null ? null : mediaId(row.domainId,'Emoji domain'),name:mediaText(row.name,'Emoji name',40),asset:checkMediaKind(parseMediaMetadata(row.asset),'server'),addedBy:mediaText(row.addedBy,'Emoji author',128),ts:mediaInteger(row.ts,'Emoji creation time',0,Number.MAX_SAFE_INTEGER)};}
/** @param {JsonValue} value @returns {ReactionSelection} */
export function parseReactionSelection(value){const row=mediaObject(value,'Reaction');if(row.kind==='unicode' && typeof row.emoji==='string' && UNICODE_EMOJIS.includes(row.emoji))return{kind:'unicode',emoji:row.emoji};if(row.kind==='server')return{kind:'server',emojiId:mediaId(row.emojiId,'Reaction emoji')};throw new TypeError('Reaction must be an approved Unicode emoji or a server emoji');}
/** @param {JsonValue} value @returns {Reaction[]} */
export function parseReactions(value){
  if(!Array.isArray(value) || value.length>272)throw new RangeError('Decrypted reaction history permits at most 272 choices');
  const keys=new Set();
  return value.map(input=>{
    const row=mediaObject(input,'Reaction'),selection=parseReactionSelection(row);
    const key=selection.kind==='unicode' ? 'u:'+selection.emoji : 'e:'+selection.emojiId;
    if(row.key!==key || keys.has(key))throw new TypeError('Reaction keys must be canonical and unique');keys.add(key);
    if(!Array.isArray(row.userIds) || !row.userIds.length || row.userIds.length>512)throw new RangeError('Reaction membership must contain 1..512 identities');
    const userIds=row.userIds.map(value=>{if(typeof value!=='string' || !/^m_[a-f0-9]{64}$/.test(value))throw new TypeError('Reaction actor must be a persistent verified member');return value;});
    if(new Set(userIds).size!==userIds.length)throw new TypeError('Reaction membership must be unique');
    if(selection.kind==='unicode')return{key,...selection,userIds};
    if(row.asset===undefined)throw new TypeError('Server reaction lacks its immutable asset');
    return{key,...selection,name:mediaText(row.name,'Reaction name',40),asset:checkMediaKind(parseMediaMetadata(row.asset),'server'),userIds};
  });
}
/** @param {JsonValue} value @returns {{requestId:string,sealed:import('./content-protocol.js').SealedMessage}[]} */
export function parseSealedReactions(value){if(!Array.isArray(value)||value.length>256)throw new RangeError('Encrypted reactions permit at most 256 updates per message');const seen=new Set();return value.map(input=>{const row=mediaObject(input,'Encrypted reaction'),requestId=mediaId(row.requestId,'Reaction request');if(seen.has(requestId)||row.sealed===undefined)throw new TypeError('Encrypted reactions require unique requests and sealed content');seen.add(requestId);const sealed=parseContentMessage(row.sealed);if(sealed.data.length>4096)throw new RangeError('Encrypted reaction exceeds its payload budget');return {requestId,sealed};});}
/** @param {JsonValue} value @returns {ChatMessage} */
export function parseChatMessage(value){
  const row=mediaObject(value,'Chat message');
  if(typeof row.text!=='string' || row.text.length>2000 || row.text.includes('\u0000'))throw new TypeError('Chat text must contain at most 2000 characters');
  if(row.system!==undefined && typeof row.system!=='boolean' || row.bot!==undefined && typeof row.bot!=='boolean')throw new TypeError('Chat message flags must be boolean');
  const attachment=row.attachment===undefined ? null : parseAttachment(row.attachment);
  const sealed=row.sealed===undefined ? null : parseContentMessage(row.sealed);
  if(row.sealedReactions!==undefined&&!sealed)throw new TypeError('Encrypted reaction history requires an encrypted message');
  if(!row.text.trim() && !attachment && !sealed)throw new TypeError('Chat message requires text or an attachment');
  if(sealed && (row.replyToId!==undefined || row.text!=='' || row.clientRequestId===undefined || row.authorId===undefined || row.reactions!==undefined || row.reactionRevision!==undefined || attachment && attachment.encrypted!==true))throw new TypeError('Encrypted chat requires a bound request and contains no plaintext message or reactions');
  if(attachment && row.system && !sealed)throw new TypeError('System messages cannot carry attachments');
  if(typeof row.color!=='string' || !/^#[a-fA-F0-9]{6}$/.test(row.color))throw new TypeError('Chat author color must be a hexadecimal RGB color');
  if((row.clientRequestId===undefined)!==(row.authorId===undefined))throw new TypeError('Idempotent chat requires both a request and persistent author');
  if(row.authorId!==undefined && (typeof row.authorId!=='string' || !/^m_[a-f0-9]{64}$/.test(row.authorId)))throw new TypeError('Chat author identity is invalid');
  return{id:mediaId(row.id,'Message ID'),userId:mediaId(row.userId,'Author ID'),name:mediaText(row.name,'Author name',80),color:row.color,text:row.text,...(row.replyToId===undefined?{}:{replyToId:mediaId(row.replyToId,'Reply message ID')}),ts:mediaInteger(row.ts,'Message timestamp',0,Number.MAX_SAFE_INTEGER),system:row.system===true,bot:row.bot===true,...(attachment ? {attachment} : {}),...(sealed ? {sealed} : {}),...(row.sealedReactions===undefined?{}:{sealedReactions:parseSealedReactions(row.sealedReactions)}),...(row.reactions===undefined ? {} : {reactions:parseReactions(row.reactions)}),...(row.reactionRevision===undefined ? {} : {reactionRevision:mediaInteger(row.reactionRevision,'Reaction revision',0,Number.MAX_SAFE_INTEGER)}),...(row.authorId===undefined ? {} : {authorId:row.authorId,clientRequestId:mediaId(row.clientRequestId,'Chat request ID')})};
}
/** @param {JsonValue} value @returns {MediaRequest} */
export function parseMediaRequest(value){
  const row=mediaObject(value,'Media request');
  const requestId=mediaId(row.requestId,'Media request ID');
  if(row.op==='begin' && row.encrypted!==undefined && row.encrypted!==true)throw new TypeError('Upload encrypted discriminator must be true when present');
  if(row.op==='begin')return{requestId,op:row.op,kind:parseMediaKind(row.kind),sha256:mediaHash(row.sha256),bytes:mediaInteger(row.bytes,'Upload bytes',1,MEDIA_LIMITS[parseMediaKind(row.kind)].bytes+(row.encrypted===true?MEDIA_ENCRYPTION_OVERHEAD:0)),...(row.encrypted===true?{encrypted:/** @type {const} */(true)}:{}),domainId:row.domainId===null ? null : mediaId(row.domainId,'Upload domain')};
  if(row.op==='finish' || row.op==='cancel')return{requestId,op:row.op,uploadId:mediaId(row.uploadId,'Upload ID')};
  if(row.op==='info')return{requestId,op:row.op,sha256:mediaHash(row.sha256)};
  if(row.op==='read')return{requestId,op:row.op,sha256:mediaHash(row.sha256),offset:mediaInteger(row.offset,'Media offset',0,MEDIA_LIMITS.image.bytes+MEDIA_ENCRYPTION_OVERHEAD),length:mediaInteger(row.length,'Media range',1,MEDIA_CHUNK_BYTES)};
  if(row.op==='write'){
    if(typeof row.data!=='string' || row.data.length>21848 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.data) || !row.data)throw new TypeError('Media chunk must be bounded canonical base64');
    return{requestId,op:row.op,uploadId:mediaId(row.uploadId,'Upload ID'),offset:mediaInteger(row.offset,'Upload offset',0,MEDIA_LIMITS.image.bytes+MEDIA_ENCRYPTION_OVERHEAD),data:row.data};
  }
  throw new TypeError('Unsupported media operation');
}
