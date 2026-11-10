// @ts-check
'use strict';
const {parseMediaMetadata}=require('../public/js/chat-protocol.js');
const {mapContentAsset}=require('../public/js/content-protocol.js');
/** @typedef {import('../public/js/chat-protocol.js').MediaMetadata} MediaMetadata */
/** @typedef {import('../public/js/chat-protocol.js').ServerEmoji} ServerEmoji */
/** @typedef {import('./steam-state.cjs').HistoryMessage} HistoryMessage */

/** @param {import('./server-governance.cjs').GovernanceState} policy @returns {{asset:MediaMetadata}[]} */
function policyMedia(policy) {
  return [...(policy.emojis ?? []), ...(policy.customization ?? []).flatMap(scope=>scope.interactions.flatMap(entry=>entry.thumbnail ? [{asset:entry.thumbnail}] : []))];
}
/** @param {readonly {asset:MediaMetadata}[]} emojis @param {Readonly<Record<string,readonly HistoryMessage[]>>} messages */
function collectChatAssets(emojis,messages){return collectContentAssets(emojis,messages,null);}
/** @param {readonly {asset:MediaMetadata}[]} emojis @param {Readonly<Record<string,readonly HistoryMessage[]>>} messages @param {import('../public/js/content-protocol.js').ContentPolicy|null} content */
function collectContentAssets(emojis,messages,content){
  /** @type {Map<string,MediaMetadata>} */const assets=new Map();
  /** @type {Set<string>} */const catalog=new Set(),history=new Set();
  /** @param {MediaMetadata} value @param {Set<string>} references */
  function add(value,references){
    const asset=parseMediaMetadata(mapContentAsset(content,value)),previous=assets.get(asset.sha256);
    if(previous && JSON.stringify(previous)!==JSON.stringify(asset))throw new TypeError('Conflicting metadata for the same media hash');
    assets.set(asset.sha256,asset);references.add(asset.sha256);
    if(assets.size>4096)throw new RangeError('Room history and library exceed 4096 distinct media assets');
  }
  for(const emoji of emojis)add(emoji.asset,catalog);
  for(const entries of Object.values(messages))for(const message of entries){
    if(message.attachment)add(message.attachment,history);
    for(const reaction of message.reactions ?? [])if(reaction.kind==='server')add(reaction.asset,history);
  }
  // Opaque history can still reference every file in the signed migration map.
  for(const item of content?.assets ?? [])add(item.asset,history);
  return{assets:[...assets.values()],catalog:[...catalog],history:[...history]};
}

/** @param {import('./steam-state.cjs').RoomStore} store @returns {void} */
function assertChatBudget(store){
  if(Buffer.byteLength(JSON.stringify(store),'utf8')>3*1024*1024)throw new RangeError('Room history and permissions reached the 3 MiB synchronization limit; remove old messages or library items before adding more');
}
module.exports={collectChatAssets,collectContentAssets,assertChatBudget,policyMedia};
