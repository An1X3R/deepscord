// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseChatMessage} from '../public/js/chat-protocol.js';
import {parseSteamCheckpoint} from '../lib/steam-state.cjs';
import {cleanClientCommand} from '../desktop/steam-commands.cjs';
import {parsePeerSignal} from '../public/js/network-protocol.js';
import {identity,launch,stop,connect,authenticate,send,receive,object,until,cleanup} from './server-ws-helpers.mjs';
/** @typedef {import('./server-ws-helpers.mjs').Client} Client */
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @param {Client} client @param {{[key:string]:JsonValue}} payload */
async function chat(client,payload){const requestId=randomUUID(),cursor=send(client,{t:'chat',channelId:'ch-chat',...payload,requestId});return receive(client,cursor,message=>message.t==='chatResult'&&message.requestId===requestId,'reply acknowledgement');}

test('plain reply survives actual server broadcast, durable restart and Steam handoff serialization',{timeout:30000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-roles-chat-reply-'));
  /** @type {import('./server-ws-helpers.mjs').Backend|null} */let backend=null;
  try{
    backend=await launch(directory,{});
    const actor=identity(),client=await connect(backend,'Reply author');await authenticate(client,actor);
    const original=await chat(client,{text:'Original message'});assert.equal(original.ok,true);
    const originalMessage=parseChatMessage(object(original.result).message ?? null);
    const reply=await chat(client,{text:'Quoted response',replyToId:originalMessage.id});assert.equal(reply.ok,true);
    const message=parseChatMessage(object(reply.result).message ?? null);assert.equal(message.replyToId,originalMessage.id);
    assert(client.messages.some(frame=>frame.t==='message'&&object(frame.message).id===message.id&&object(frame.message).replyToId===originalMessage.id));
    for(const replyToId of ['', '../invalid', '__proto__', 'x'.repeat(81), 17, null]){
      assert.throws(()=>parseChatMessage({...message,replyToId}),/Reply message ID/);
      assert.throws(()=>cleanClientCommand(JSON.stringify({t:'chat',channelId:'ch-chat',text:'Invalid reply',replyToId}),parsePeerSignal),/Reply message ID/);
      assert.equal((await chat(client,{text:'Invalid reply',replyToId})).ok,false);
    }
    const wire={t:'chat',channelId:'ch-chat',text:'Quoted response',replyToId:originalMessage.id};
    assert.deepEqual(JSON.parse(cleanClientCommand(JSON.stringify(wire),parsePeerSignal)),wire);
    await until(()=>fs.existsSync(path.join(directory,'store.json'))&&object(object(JSON.parse(fs.readFileSync(path.join(directory,'store.json'),'utf8'))).messages)['ch-chat'] instanceof Array&&/** @type {JsonValue[]} */(object(object(JSON.parse(fs.readFileSync(path.join(directory,'store.json'),'utf8'))).messages)['ch-chat']).some(value=>object(value).id===message.id),backend.failure,'reply persisted');
    const store=JSON.parse(fs.readFileSync(path.join(directory,'store.json'),'utf8'));
    const handoff={version:1,lobbyId:'109775241012345678',ownerId:'76561198000000001',epoch:'a'.repeat(32),sequence:1,stunUrls:[],store,users:[]};
    const checkpoint=parseSteamCheckpoint(handoff);
    assert.equal(checkpoint.store.messages['ch-chat'].find(row=>row.id===message.id)?.replyToId,originalMessage.id);
    assert.deepEqual(parseSteamCheckpoint(JSON.parse(JSON.stringify(checkpoint))),checkpoint);
    await stop(backend);backend=await launch(directory,{});
    const restored=await connect(backend,'Restored author');await authenticate(restored,actor);
    const welcome=restored.messages.find(frame=>frame.t==='welcome');assert(welcome);
    const history=object(welcome.messages)['ch-chat'];assert(Array.isArray(history));
    assert.equal(history.map(parseChatMessage).find(row=>row.id===message.id)?.replyToId,originalMessage.id);
    assert.equal(history.map(parseChatMessage).find(row=>row.id===originalMessage.id)?.replyToId,undefined);
  }finally{if(backend)await stop(backend);cleanup(directory);}
});
