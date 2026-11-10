// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {object,identity,launch,stop,send,receive,connect,authenticate,join,chat,cleanup} from './server-ws-helpers.mjs';

test('live voice moderation retains verified identity across reconnect and text routing stays separate', {timeout:25000}, async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-roles-'));
  const backend=await launch(directory,{});
  try{
    const ownerIdentity=identity(),memberIdentity=identity();
    const owner=await connect(backend,'Owner');await authenticate(owner,ownerIdentity);
    const claim=send(owner,{t:'claimOwner',token:fs.readFileSync(path.join(directory,'owner-claim.txt'),'utf8').trim()});
    await receive(owner,claim,message=>message.t==='serverState' && object(message.policy).ownerKey===ownerIdentity.key,'claim server ownership');
    const member=await connect(backend,'Member');await authenticate(member,memberIdentity);
    await join(owner,'ch-lobby');await join(member,'ch-lobby');
    const mute=send(owner,{t:'setVoiceMute',userId:member.userId,muted:true});
    const muted=await receive(owner,mute,message=>message.t==='userUpdated' && object(message.user).id===member.userId && object(message.user).serverMuted===true,'authoritative management mute');
    assert.equal(object(muted.user).muted,false);
    const mic=send(member,{t:'micState',muted:true});
    await receive(member,mic,message=>message.t==='userUpdated' && object(message.user).id===member.userId,'personal mute');
    const unmute=send(member,{t:'micState',muted:false});
    const stillMuted=await receive(member,unmute,message=>message.t==='userUpdated' && object(message.user).id===member.userId,'personal unmute retains management mute');
    assert.equal(object(stillMuted.user).serverMuted,true);
    await join(member,'ch-night-voice');
    const night=send(member,{t:'joinVoice',channelId:'ch-night-voice'});
    assert.equal((await receive(member,night,message=>message.t==='voicePeers','other domain mute state')).serverMuted,false);
    await join(member,'ch-lobby');
    const returnCursor=send(member,{t:'joinVoice',channelId:'ch-lobby'});
    assert.equal((await receive(member,returnCursor,message=>message.t==='voicePeers','same domain mute state')).serverMuted,true);
    const leftCursor=owner.messages.length;
    member.socket.close();await member.closed;
    await receive(owner,leftCursor,message=>message.t==='userLeft' && message.id===member.userId,'member disconnect');
    const reconnected=await connect(backend,'Member again');await authenticate(reconnected,memberIdentity);
    assert.notEqual(reconnected.userId,member.userId);
    const rejoin=send(reconnected,{t:'joinVoice',channelId:'ch-lobby',muted:false,deafened:false});
    assert.equal((await receive(reconnected,rejoin,message=>message.t==='voicePeers','verified identity rejoin')).serverMuted,true);
    const targetClearCursor=reconnected.messages.length,clear=send(owner,{t:'setVoiceMute',userId:reconnected.userId,muted:false});
    await receive(reconnected,targetClearCursor,message=>message.t==='userUpdated' && object(message.user).id===reconnected.userId && object(message.user).serverMuted===false,'authoritative management unmute');
    await receive(owner,clear,message=>message.t==='userUpdated' && object(message.user).id===reconnected.userId && object(message.user).serverMuted===false,'owner sees unmute');
    const textId=await chat(reconnected,'ch-chat','Text remains in text channels');assert(textId.length>0);
    const deniedText=send(reconnected,{t:'chat',channelId:'ch-lobby',text:'No voice chat',requestId:'voice-text-rejection'});
    const rejected=await receive(reconnected,deniedText,message=>message.t==='chatResult' && message.requestId==='voice-text-rejection','voice text rejection');
    assert.equal(rejected.ok,false);assert.equal(reconnected.socket.readyState,WebSocket.OPEN);
    await chat(reconnected,'ch-chat','Connection remains healthy');
  }catch(error){console.error(backend.output());throw error;}
  finally{await stop(backend);cleanup(directory);}
});
