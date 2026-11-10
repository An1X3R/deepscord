// @ts-check
'use strict';
const {createHash}=require('node:crypto');
const {parseReactions,parseReactionSelection,parseSealedReactions}=require('../public/js/chat-protocol.js');
/** @typedef {import('../public/js/chat-protocol.js').ChatMessage} ChatMessage */
/** @typedef {import('../public/js/chat-protocol.js').ServerEmoji} ServerEmoji */
/** @typedef {import('../public/js/chat-protocol.js').Reaction} Reaction */
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */

/** @param {string} memberKey @returns {string} */
function reactionActor(memberKey){if(typeof memberKey!=='string' || !memberKey.length)throw new TypeError('Reaction requires a verified persistent identity');return'm_'+createHash('sha256').update(memberKey).digest('hex');}
/** @typedef {{memberKey:string,selection:JsonValue,active:boolean}} ReactionRequest */
/** @typedef {{choices:number,members:number}} ReactionLimits */
/** @param {ChatMessage} message @param {ReactionRequest} request @param {readonly ServerEmoji[]} catalog @param {ReactionLimits} limits @returns {ChatMessage} */
function reduceMessageReaction(message,request,catalog,limits){
  if(message.system)throw new TypeError('System messages do not support reactions');
  if(typeof request.active!=='boolean')throw new TypeError('Reaction requires an explicit target state');
  const selection=parseReactionSelection(request.selection),actor=reactionActor(request.memberKey);
  const key=selection.kind==='unicode'?'u:'+selection.emoji:'e:'+selection.emojiId;
  const reactions=parseReactions(message.reactions ?? []),existing=reactions.find(entry=>entry.key===key);
  if(Boolean(existing?.userIds.includes(actor))===request.active)return message;
  const others=reactions.filter(entry=>entry.key!==key);
  if(!request.active){
    const userIds=existing?.userIds.filter(id=>id!==actor) ?? [];
    return{...message,reactions:others.concat(existing && userIds.length ? [{...existing,userIds}] : []),reactionRevision:(message.reactionRevision ?? 0)+1};
  }
  if(!existing && others.length>=limits.choices)throw new RangeError('This message reached its reaction choice limit of '+limits.choices);
  if(existing && existing.userIds.length>=limits.members)throw new RangeError('This reaction reached its member limit of '+limits.members);
  /** @type {Reaction} */let next;
  if(selection.kind==='unicode')next={key,...selection,userIds:[...(existing?.userIds ?? []),actor]};
  else{
    const emoji=catalog.find(item=>item.id===selection.emojiId);
    if(!emoji)throw new TypeError('This emoji has been removed from the server library');
    next={key,...selection,name:emoji.name,asset:emoji.asset,userIds:[...(existing?.userIds ?? []),actor]};
  }
  return{...message,reactions:others.concat(next),reactionRevision:(message.reactionRevision ?? 0)+1};
}
/** @param {ChatMessage} message @param {ReactionRequest} request @param {readonly ServerEmoji[]} catalog @returns {ChatMessage} */
function setMessageReaction(message,request,catalog){return reduceMessageReaction(message,request,catalog,{choices:16,members:256});}
/** Include the migrated base plus every update in the bounded encrypted journal.
 * @param {ChatMessage} message @param {ReactionRequest} request @param {readonly ServerEmoji[]} catalog @returns {ChatMessage} */
function applyEncryptedReaction(message,request,catalog){return reduceMessageReaction(message,request,catalog,{choices:272,members:512});}
/** @param {ChatMessage} message @param {{requestId:string,sealed:import('../public/js/content-protocol.js').SealedMessage}} event @returns {ChatMessage} */
function appendSealedReaction(message,event){if(message.system||!message.sealed)throw new TypeError('Encrypted reactions require an encrypted user message');const events=message.sealedReactions ?? [],existing=events.find(item=>item.requestId===event.requestId);if(existing){if(JSON.stringify(existing)!==JSON.stringify(event))throw new TypeError('Reaction request ID was reused with different ciphertext');return message;}return {...message,sealedReactions:parseSealedReactions([...events,event])};}
module.exports={reactionActor,setMessageReaction,applyEncryptedReaction,appendSealedReaction};
