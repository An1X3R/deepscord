// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createChatUnreadStore} from '../desktop/chat-unread-store.cjs';
import {CHAT_UNREAD_LIMITS} from '../public/js/chat-unread.js';
/** @typedef {import('../public/js/chat-unread.js').UnreadDocument} UnreadDocument */
/** @param {number} timestamp @returns {UnreadDocument} */
function snapshot(timestamp){return {version:1,entries:[{roomId:'room-a',channelId:'text',read:{id:'old',ts:1},latest:{id:'new',ts:timestamp},floor:null,muted:true,pending:[{id:'new',ts:timestamp,mention:true}]}]};}
/** @returns {string} */
function directory(){return fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-unread-disk-'));}
/** @param {string} target @returns {void} */
function cleanup(target){assert.equal(path.dirname(target),os.tmpdir());assert(path.basename(target).startsWith('deepscord-unread-disk-'));fs.rmSync(target,{recursive:true,force:true});}

test('native unread storage keeps only schema fields across an actual process restart and isolates profiles',async()=>{
  const a=directory(),b=directory();
  try{
    const store=createChatUnreadStore(a);assert.deepEqual(store.read(),{version:1,entries:[]});
    const expected=snapshot(2);
    await store.save({...expected,password:'discard',entries:expected.entries.map(entry=>({...entry,text:'never persist plaintext',memberKey:'discard',pending:entry.pending.map(item=>({...item,text:'secret mention'}))}))});
    assert.deepEqual(store.read(),expected);
    const raw=fs.readFileSync(path.join(a,'chat-unread.json'),'utf8');assert(!raw.includes('plaintext'));assert(!raw.includes('password'));assert(!raw.includes('secret'));assert(!raw.includes('memberKey'));
    const module=path.resolve('desktop/chat-unread-store.cjs');
    const source=`const {createChatUnreadStore}=require(${JSON.stringify(module)}); process.stdout.write(JSON.stringify(createChatUnreadStore(${JSON.stringify(a)}).read()));`;
    assert.deepEqual(JSON.parse(execFileSync(process.execPath,['-e',source],{encoding:'utf8'})),expected);
    assert.deepEqual(createChatUnreadStore(b).read(),{version:1,entries:[]});
    const second=snapshot(3);second.entries[0].roomId='room-b';await store.save({version:1,entries:[...expected.entries,...second.entries]});
    assert.equal(store.read().entries.length,2);assert.equal(store.read().entries[0].pending[0].ts,2);assert.equal(store.read().entries[1].pending[0].ts,3);
  }finally{cleanup(a);cleanup(b);}
});

test('native unread storage rejects corrupt, oversized and invalid documents without changing prior data',async()=>{
  const target=directory();
  try{
    const store=createChatUnreadStore(target),filename=path.join(target,'chat-unread.json'),expected=snapshot(2);await store.save(expected);
    assert.throws(()=>store.save({...expected,entries:[...expected.entries,...expected.entries]}),/duplicate/);
    assert.throws(()=>store.save({...expected,padding:'x'.repeat(8*1024*1024)}),/8 MiB/);
    const tooMany={...expected,entries:Array.from({length:CHAT_UNREAD_LIMITS.total+1},()=>expected.entries[0])};assert.throws(()=>store.save(tooMany),/128/);
    assert.deepEqual(store.read(),expected);
    fs.writeFileSync(filename,'{corrupt');assert.throws(()=>createChatUnreadStore(target).read(),SyntaxError);
    fs.writeFileSync(filename,JSON.stringify({...expected,entries:[{...expected.entries[0],muted:'yes'}]}));assert.throws(()=>createChatUnreadStore(target).read(),/muted/);
    fs.truncateSync(filename,CHAT_UNREAD_LIMITS.bytes+1);assert.throws(()=>createChatUnreadStore(target).read(),/regular file/);
    fs.unlinkSync(filename);fs.mkdirSync(filename);assert.throws(()=>createChatUnreadStore(target).read(),/regular file/);
  }finally{cleanup(target);}
});

test('concurrent native save calls serialize complete snapshots without leftover temporary files',async()=>{
  const target=directory();
  try{
    const store=createChatUnreadStore(target);
    const pending=Array.from({length:40},(_,index)=>store.save(snapshot(index+2)));
    assert(pending.every(operation=>operation===pending[0]),'A burst shares one durability completion');
    await store.close();
    await Promise.all(pending);
    assert.deepEqual(store.read(),snapshot(41));
    assert.deepEqual(createChatUnreadStore(target).read(),snapshot(41));
    assert.throws(()=>store.save(snapshot(42)),/closing/);
    assert.deepEqual(fs.readdirSync(target),['chat-unread.json']);
  }finally{cleanup(target);}
});

test('a real Windows file sharing lock makes failed atomic replacement preserve the previous unread file',{timeout:15000},async()=>{
  assert.equal(process.platform,'win32');
  const target=directory(),filename=path.join(target,'chat-unread.json'),store=createChatUnreadStore(target),expected=snapshot(2);await store.save(expected);
  const script="$ErrorActionPreference='Stop'; $file=[IO.File]::Open($env:DEEPSCORD_UNREAD_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { [Console]::WriteLine('READY'); [Console]::In.ReadLine() | Out-Null } finally { $file.Dispose() }";
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:'pipe',env:{...process.env,DEEPSCORD_UNREAD_LOCK_FILE:filename}});
  const timer=setTimeout(()=>child.kill(),10000);
  try{
    await new Promise((resolve,reject)=>{
      let output='';child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('READY'))resolve(undefined);});
      child.once('error',reject);child.once('exit',code=>reject(new Error(`Unread lock probe exited before acquiring its lock: ${code}`)));
    });
    await assert.rejects(store.save(snapshot(3)),/EPERM|EACCES|EBUSY/);
    assert.deepEqual(store.read(),expected);
    assert.deepEqual(fs.readdirSync(target),['chat-unread.json']);
  }finally{
    clearTimeout(timer);
    if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.stdin.end();await exited;}
    cleanup(target);
  }
});
