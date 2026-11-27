// @ts-check
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';

const memberKey=generateKeyPairSync('ed25519').publicKey.export({format:'der',type:'spki'}).toString('base64');
const moduleUrl=new URL('../public/js/chat-unread.js',import.meta.url).href;
const setup=`import assert from 'node:assert/strict';
import {createChatUnreadStore,CHAT_UNREAD_KEY,CHAT_UNREAD_LIMITS,parseChatUnread} from ${JSON.stringify(moduleUrl)};
const key=${JSON.stringify(memberKey)}, self={memberKey:key,userId:'self'}, store=createChatUnreadStore({storage:localStorage});
const message=(id,ts,text)=>({id,ts,text,userId:'other',system:false,authorKey:null});
const mention=id=>message(id,Number(id.replace(/\\D/g,''))||1,'<@'+key+'>');
`;

/** @param {(run:(source:string)=>void)=>void} action @returns {void} */
function withStorage(action){
  const directory=mkdtempSync(join(tmpdir(),'deepscord-unread-'));
  try{action(source=>{execFileSync(process.execPath,['--experimental-webstorage','--disable-warning=ExperimentalWarning','--localstorage-file='+join(directory,'local-storage'),'--input-type=module','-e',setup+source],{stdio:'pipe'});});}
  finally{assert.equal(join(directory,'..'),tmpdir());rmSync(directory,{recursive:true,force:true});}
}

test('first history and empty history bootstrap without false unread, including a live/history race',()=>withStorage(run=>run(`
store.history('room','text',[mention('old1')],self);
assert.deepEqual(store.state('room','text'),{unread:false,mentions:0,muted:false});
store.history('room','empty',[],self);
store.observe('room','empty',mention('live10'),self);
store.history('room','empty',[mention('old1'),mention('live10')],self);
assert.equal(store.state('room','empty').mentions,1);
store.history('room','muted',[],self);store.setMuted('room','muted',true);
store.history('room','muted',[mention('old1')],self);
assert.equal(store.state('room','muted').mentions,0);
`)));

test('persistent-key mentions, duplicates, self sends, system messages and reaction updates',()=>withStorage(run=>run(`
store.history('room','text',[message('base',0,'base')],self);
assert.equal(store.observe('room','text',mention('m1'),self).fresh,true);
assert.equal(store.observe('room','text',mention('m1'),self).fresh,false);
store.history('room','text',[{...mention('m1'),reactions:[{emoji:'x'}]}],self);
store.observe('room','text',message('m2',2,'@self <@someone>'),self);
store.observe('room','text',{...mention('m3'),authorKey:key,userId:'previous-session'},self);
store.observe('room','text',{...mention('m4'),userId:'self'},self);
store.observe('room','text',{...mention('m5'),system:true},self);
assert.deepEqual(store.state('room','text'),{unread:true,mentions:1,muted:false});
store.remove('room','text','m1');assert.equal(store.state('room','text').mentions,0);
store.markRead('room','text');assert.equal(store.state('room','text').unread,false);
`)));

test('restart persists watermark, pending mentions and channel mute without storing message text',()=>withStorage(run=>{
  run(`store.history('room','text',[message('base',0,'base')],self);store.observe('room','text',mention('m1'),self);store.setMuted('room','text',true);assert.equal(localStorage.getItem(CHAT_UNREAD_KEY).includes('<@'),false);`);
  run(`assert.deepEqual(store.state('room','text'),{unread:false,mentions:1,muted:true});store.history('room','text',[mention('m1'),mention('m2')],self);assert.equal(store.state('room','text').mentions,2);store.markRead('room','text');`);
  run(`store.history('room','text',[mention('m1'),mention('m2'),mention('m3')],self);assert.equal(store.state('room','text').mentions,1);store.setMuted('room','text',false);assert.equal(store.state('room','text').unread,true);assert.equal(store.snapshot().entries[0].read.id,'m2');`);
}));

test('channel and room namespaces stay isolated; mute retains mention count',()=>withStorage(run=>run(`
store.history('room','text',[],self);store.observe('room','text',mention('m1'),self);
store.setMuted('room','text',true);
assert.equal(store.state('room','text').unread,false);assert.equal(store.state('room','text').mentions,1);
assert.equal(store.state('room2','text').mentions,0);assert.equal(store.state('room','text2').mentions,0);
store.setMuted('room','text',false);assert.equal(store.state('room','text').unread,true);
const snapshot=store.snapshot();snapshot.entries[0].pending.length=0;assert.equal(store.state('room','text').mentions,1);
`)));

test('read timestamp and ID handle equal timestamps and out-of-order arrival',()=>withStorage(run=>run(`
store.history('room','text',[message('a',1,'old')],self);
store.observe('room','text',message('c',1,'new'),self);
store.observe('room','text',message('b',1,'new'),self);
assert.equal(store.snapshot().entries[0].pending.length,2);
store.markRead('room','text');assert.deepEqual(store.snapshot().entries[0].read,{id:'c',ts:1});
assert.equal(store.observe('room','text',message('b',1,'replay'),self).fresh,false);
assert.equal(store.observe('room','text',message('d',1,'new'),self).fresh,true);
`)));

test('bounded pending window preserves count across shorter history and rejects evicted replay',()=>withStorage(run=>run(`
store.history('room','text',[message('base',0,'base')],self);
for(let index=1;index<=CHAT_UNREAD_LIMITS.pending+20;index++)store.observe('room','text',mention('m'+index),self);
assert.equal(store.state('room','text').mentions,CHAT_UNREAD_LIMITS.pending);
store.history('room','text',[mention('m532')],self);
assert.equal(store.state('room','text').mentions,CHAT_UNREAD_LIMITS.pending);
assert.equal(store.observe('room','text',mention('m1'),self).fresh,false);
store.markRead('room','text');assert.equal(store.snapshot().entries[0].read.ts,532);
`)));

test('storage evicts oldest rooms and channels at all configured bounds',()=>withStorage(run=>run(`
for(let index=0;index<CHAT_UNREAD_LIMITS.channels+1;index++)store.setMuted('room','c'+index,true);
assert.equal(store.snapshot().entries.length,CHAT_UNREAD_LIMITS.channels);
assert.equal(store.state('room','c0').muted,false);
for(let index=0;index<CHAT_UNREAD_LIMITS.rooms+1;index++)store.setMuted('r'+index,'text',true);
assert.equal(new Set(store.snapshot().entries.map(item=>item.roomId)).size,CHAT_UNREAD_LIMITS.rooms);
for(let room=0;room<4;room++)for(let channel=0;channel<CHAT_UNREAD_LIMITS.channels;channel++)store.setMuted('last'+room,'c'+channel,true);
assert.equal(store.snapshot().entries.length,CHAT_UNREAD_LIMITS.total);
`)));

test('local schema strips unrelated fields and rejects corrupt records without erasing storage',()=>withStorage(run=>run(`
store.setMuted('room','text',true);
const saved=JSON.parse(localStorage.getItem(CHAT_UNREAD_KEY));saved.extra='discard';saved.entries[0].extra='discard';
assert.equal('extra' in parseChatUnread(saved),false);assert.equal('extra' in parseChatUnread(saved).entries[0],false);
saved.entries[0].muted='yes';const corrupt=JSON.stringify(saved);localStorage.setItem(CHAT_UNREAD_KEY,corrupt);
assert.throws(()=>createChatUnreadStore({storage:localStorage}),/muted/);
assert.equal(localStorage.getItem(CHAT_UNREAD_KEY),corrupt);
`)));

test('render and duplicate delivery no-ops do not rewrite real local storage',()=>withStorage(run=>run(`
store.markRead('untracked','channel');assert.equal(localStorage.getItem(CHAT_UNREAD_KEY),null);
store.history('room','text',[message('base',0,'base')],self);
store.observe('room','text',mention('m1'),self);store.markRead('room','text');
localStorage.removeItem(CHAT_UNREAD_KEY);
store.markRead('room','text');store.history('room','text',[mention('m1')],self);store.observe('room','text',mention('m1'),self);
assert.equal(localStorage.getItem(CHAT_UNREAD_KEY),null);
`)));
