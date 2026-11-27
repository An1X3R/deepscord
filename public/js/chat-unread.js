// @ts-check
import {mediaObject,mediaId,mediaInteger} from './chat-protocol.js';
/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {{id:string,ts:number}} Cursor */
/** @typedef {Cursor & {mention:boolean}} Pending */
/** @typedef {{roomId:string,channelId:string,read:Cursor|null,latest:Cursor|null,floor:Cursor|null,muted:boolean,pending:Pending[]}} Entry */
/** @typedef {{version:1,entries:Entry[]}} UnreadDocument */
/** @typedef {Pick<import('./chat-protocol.js').ChatMessage,'id'|'ts'|'text'|'userId'|'system'> & {authorKey?:string|null}} UnreadMessage */
/** @typedef {{memberKey:string|null,userId:string|null}} SelfIdentity */
/** @typedef {{unread:boolean,mentions:number,muted:boolean}} UnreadState */

export const CHAT_UNREAD_KEY='deepscord.chat-unread.v1';
export const CHAT_UNREAD_LIMITS=Object.freeze({rooms:12,channels:64,total:128,pending:512,bytes:2*1024*1024});

/** @param {Cursor} left @param {Cursor} right @returns {number} */
function compare(left,right){return left.ts-right.ts || (left.id<right.id?-1:left.id>right.id?1:0);}
/** @param {Cursor|null} left @param {Cursor|null} right @returns {Cursor|null} */
function latest(left,right){return !left?right:!right?left:compare(left,right)>=0?left:right;}
/** @param {JsonValue|undefined} value @returns {Cursor|null} */
function parseCursor(value){if(value===null)return null;const row=mediaObject(value,'Unread cursor');return {id:mediaId(row.id,'Unread message ID'),ts:mediaInteger(row.ts,'Unread timestamp',0,Number.MAX_SAFE_INTEGER)};}
/** @param {JsonValue} value @returns {UnreadDocument} */
export function parseChatUnread(value){
  const document=mediaObject(value,'Unread storage');
  if(document.version!==1 || !Array.isArray(document.entries) || document.entries.length>CHAT_UNREAD_LIMITS.total)throw new TypeError('Unread storage requires version 1 and at most 128 channels');
  /** @type {Map<string,number>} */const rooms=new Map();
  /** @type {Set<string>} */const keys=new Set();
  const entries=document.entries.map(input=>{
    const row=mediaObject(input,'Unread channel'),roomId=mediaId(row.roomId,'Unread room ID'),channelId=mediaId(row.channelId,'Unread channel ID'),key=JSON.stringify([roomId,channelId]);
    if(keys.has(key))throw new TypeError('Unread storage contains a duplicate room/channel');keys.add(key);
    rooms.set(roomId,(rooms.get(roomId)??0)+1);
    if(rooms.size>CHAT_UNREAD_LIMITS.rooms || (rooms.get(roomId)??0)>CHAT_UNREAD_LIMITS.channels)throw new RangeError('Unread storage exceeds room/channel limits');
    if(typeof row.muted!=='boolean' || !Array.isArray(row.pending) || row.pending.length>CHAT_UNREAD_LIMITS.pending)throw new TypeError('Unread channel requires muted state and at most 512 pending messages');
    const read=parseCursor(row.read),newest=parseCursor(row.latest),floor=parseCursor(row.floor);
    /** @type {Set<string>} */const ids=new Set();
    if(read && (!newest || compare(read,newest)>0) || floor && (!newest || compare(floor,newest)>0))throw new TypeError('Unread cursors exceed the latest observed message');
    const pending=row.pending.map(value=>{const item=mediaObject(value,'Unread pending message'),cursor=parseCursor(value);if(!cursor || typeof item.mention!=='boolean' || ids.has(cursor.id))throw new TypeError('Unread pending message requires a unique ID and mention state');ids.add(cursor.id);if(read && compare(cursor,read)<=0 || floor && compare(cursor,floor)<=0 || !newest || compare(cursor,newest)>0)throw new TypeError('Unread pending message lies outside its tracked cursor range');return {...cursor,mention:item.mention};});
    return {roomId,channelId,read,latest:newest,floor,muted:row.muted,pending:pending.sort(compare)};
  });
  const result={version:/** @type {const} */(1),entries};
  if(JSON.stringify(result).length>CHAT_UNREAD_LIMITS.bytes)throw new RangeError('Unread storage exceeds its 2 MiB file budget');
  return result;
}

/** @param {string} roomId @param {string} channelId @returns {Entry} */
function emptyEntry(roomId,channelId){mediaId(roomId,'Unread room ID');mediaId(channelId,'Unread channel ID');return {roomId,channelId,read:null,latest:null,floor:null,muted:false,pending:[]};}
/** @param {UnreadDocument} document @param {string} roomId @param {string} channelId @returns {Entry|null} */
function findEntry(document,roomId,channelId){return document.entries.find(entry=>entry.roomId===roomId && entry.channelId===channelId)??null;}
/** @param {UnreadDocument} document @param {Entry} entry @returns {UnreadDocument} */
function replaceEntry(document,entry){
  const others=document.entries.filter(item=>item.roomId!==entry.roomId || item.channelId!==entry.channelId);
  const sameRoom=others.filter(item=>item.roomId===entry.roomId).slice(-(CHAT_UNREAD_LIMITS.channels-1));
  const otherRooms=others.filter(item=>item.roomId!==entry.roomId);
  const roomOrder=[...new Set(otherRooms.map(item=>item.roomId))].slice(-(CHAT_UNREAD_LIMITS.rooms-1));
  let entries=[...otherRooms.filter(item=>roomOrder.includes(item.roomId)),...sameRoom,entry].slice(-CHAT_UNREAD_LIMITS.total);
  while(JSON.stringify({version:1,entries}).length>CHAT_UNREAD_LIMITS.bytes)entries=entries.slice(1);
  return {version:1,entries};
}
/** @param {Entry} entry @param {UnreadMessage} message @param {SelfIdentity} self @returns {{entry:Entry,fresh:boolean,mention:boolean}} */
function observeEntry(entry,message,self){
  const cursor={id:mediaId(message.id,'Unread message ID'),ts:mediaInteger(message.ts,'Unread timestamp',0,Number.MAX_SAFE_INTEGER)};
  const duplicate=entry.pending.some(item=>item.id===cursor.id);
  const ignored=duplicate || Boolean(entry.read && compare(cursor,entry.read)<=0) || Boolean(entry.floor && compare(cursor,entry.floor)<=0);
  const isSelf=Boolean(self.memberKey && message.authorKey===self.memberKey || self.userId && message.userId===self.userId);
  const mention=Boolean(self.memberKey && [...message.text.matchAll(/<@(MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=)>/g)].some(match=>match[1]===self.memberKey));
  if(ignored || isSelf || message.system)return {entry:{...entry,latest:latest(entry.latest,cursor)},fresh:false,mention:false};
  const candidates=[...entry.pending,{...cursor,mention}].sort(compare),removed=candidates.slice(0,Math.max(0,candidates.length-CHAT_UNREAD_LIMITS.pending));
  const floor=removed.reduce((value,item)=>latest(value,item),entry.floor);
  return {entry:{...entry,latest:latest(entry.latest,cursor),floor,pending:candidates.slice(-CHAT_UNREAD_LIMITS.pending)},fresh:true,mention};
}

/** @param {{storage:Pick<Storage,'getItem'|'setItem'>}} options */
export function createChatUnreadStore({storage}){
  const saved=storage.getItem(CHAT_UNREAD_KEY);
  /** @type {UnreadDocument} */let document=saved===null?{version:1,entries:[]}:parseChatUnread(JSON.parse(saved));
  /** @param {Entry} entry @returns {void} */
  function save(entry){const existing=findEntry(document,entry.roomId,entry.channelId);if(existing && JSON.stringify(existing)===JSON.stringify(entry))return;const next=replaceEntry(document,entry);storage.setItem(CHAT_UNREAD_KEY,JSON.stringify(next));document=next;}
  /** @param {string} roomId @param {string} channelId @returns {UnreadState} */
  function state(roomId,channelId){const entry=findEntry(document,roomId,channelId);return {unread:Boolean(entry && !entry.muted && entry.pending.length),mentions:entry?.pending.filter(item=>item.mention).length??0,muted:entry?.muted??false};}
  /** @param {string} roomId @param {string} channelId @param {UnreadMessage} message @param {SelfIdentity} self */
  function observe(roomId,channelId,message,self){const entry=findEntry(document,roomId,channelId)??emptyEntry(roomId,channelId),result=observeEntry(entry,message,self);save(result.entry);return {fresh:result.fresh,mention:result.mention,muted:result.entry.muted};}
  /** @param {string} roomId @param {string} channelId @param {readonly UnreadMessage[]} messages @param {SelfIdentity} self @returns {void} */
  function history(roomId,channelId,messages,self){
    const entry=findEntry(document,roomId,channelId)??emptyEntry(roomId,channelId);
    if(entry.read===null && entry.latest===null){const cursor=messages.reduce((value,message)=>latest(value,{id:mediaId(message.id,'Unread message ID'),ts:mediaInteger(message.ts,'Unread timestamp',0,Number.MAX_SAFE_INTEGER)}),/** @type {Cursor|null} */(null));save({...entry,read:cursor,latest:cursor});return;}
    // A first live message can precede the initial history response.
    const boundary=entry.read===null?entry.pending[0]??entry.latest:null;
    const relevant=boundary?messages.filter(message=>compare(message,boundary)>=0):messages;
    save(relevant.reduce((value,message)=>observeEntry(value,message,self).entry,entry));
  }
  /** @param {string} roomId @param {string} channelId @returns {void} */
  function markRead(roomId,channelId){const entry=findEntry(document,roomId,channelId);if(!entry)return;save({...entry,read:latest(entry.read,entry.latest),pending:[]});}
  /** @param {string} roomId @param {string} channelId @param {boolean} muted @returns {void} */
  function setMuted(roomId,channelId,muted){if(typeof muted!=='boolean')throw new TypeError('Unread mute state must be boolean');const entry=findEntry(document,roomId,channelId)??emptyEntry(roomId,channelId);save({...entry,muted});}
  /** @param {string} roomId @param {string} channelId @param {string} messageId @returns {void} */
  function remove(roomId,channelId,messageId){const entry=findEntry(document,roomId,channelId);if(entry)save({...entry,pending:entry.pending.filter(item=>item.id!==messageId)});}
  /** @returns {UnreadDocument} */
  function snapshot(){return parseChatUnread(JSON.parse(JSON.stringify(document)));}
  return {history,observe,markRead,setMuted,remove,state,snapshot};
}
