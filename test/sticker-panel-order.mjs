// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { sortStickers, UNICODE_EMOJIS } from '../public/js/sticker-panel.js';
import {parseReactionSelection,parseReactions} from '../public/js/chat-protocol.js';
import reactions from '../lib/message-reactions.cjs';
/** @typedef {import('../public/js/sticker-panel.js').StickerItem} StickerItem */
/** @param {string} id @param {number} useCount @param {number} lastUsedAt @param {number} addedAt @param {boolean} pinned @returns {StickerItem} */
function item(id,useCount,lastUsedAt,addedAt,pinned){return {id,kind:'personal',name:id,sha256:'a'.repeat(64),domainId:null,width:160,height:160,animated:false,frames:1,durationMs:0,bytes:100,addedAt,useCount,lastUsedAt,pinned};}

test('sticker sorting preserves pinned priority, stable ties and caller-owned order',()=>{
  const items=[item('old-frequent',10,10,10,false),item('recent',2,100,20,false),item('added',1,20,100,false),item('pinned',0,0,0,true)];
  const original=items.map(row=>row.id);
  assert.deepEqual(sortStickers(items,'frequency').map(row=>row.id),['pinned','old-frequent','recent','added']);
  assert.deepEqual(sortStickers(items,'recent').map(row=>row.id),['pinned','recent','added','old-frequent']);
  assert.deepEqual(sortStickers(items,'added').map(row=>row.id),['pinned','added','recent','old-frequent']);
  assert.deepEqual(items.map(row=>row.id),original);
  assert.deepEqual(sortStickers([item('b',1,1,1,false),item('a',1,1,1,false)],'frequency').map(row=>row.id),['a','b']);
});

test('reaction Unicode choices form one immutable finite allowlist',()=>{
  assert(Object.isFrozen(UNICODE_EMOJIS));assert.equal(new Set(UNICODE_EMOJIS).size,UNICODE_EMOJIS.length);
  assert(UNICODE_EMOJIS.includes('👍'));assert(UNICODE_EMOJIS.includes('❤️'));
  assert(UNICODE_EMOJIS.every(emoji=>emoji.length>0 && emoji.length<=8));
});

test('numeric keycaps round-trip through the picker catalog and both reaction reducers',()=>{
  const message={id:'numeric-message',userId:'author',name:'Author',color:'#ffffff',text:'Count votes',ts:1,system:false,bot:false};
  for(const emoji of ['0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟']){
    assert(UNICODE_EMOJIS.includes(emoji));
    const selection=parseReactionSelection({kind:'unicode',emoji});
    const request={memberKey:'persistent-voter',selection,active:true};
    for(const reduce of [reactions.setMessageReaction,reactions.applyEncryptedReaction]){
      const added=reduce(message,request,[]);
      assert.deepEqual(parseReactions(added.reactions ?? []),[{key:'u:'+emoji,kind:'unicode',emoji,userIds:[reactions.reactionActor(request.memberKey)]}]);
      assert.deepEqual(reduce(added,{...request,active:false},[]).reactions,[]);
    }
  }
});
