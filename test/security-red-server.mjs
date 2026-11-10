// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {parseMediaMetadata} from '../public/js/chat-protocol.js';
import {object,string,identity,until,launch,stop,send,receive,connectHello,proof,authenticate,denied,cleanup} from './server-ws-helpers.mjs';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{[key:string]:JsonValue}} Message */
/** @typedef {import('./server-ws-helpers.mjs').Client} Client */
/** @typedef {import('./server-ws-helpers.mjs').Backend} Backend */
/** @typedef {import('../public/js/chat-protocol.js').MediaMetadata} MediaMetadata */
const password='red-server-fixture-'+randomUUID();
const animation=fs.readFileSync(new URL('avif-codec-fixtures/transparent-animation.avif',import.meta.url));

/** @param {Buffer} bytes @returns {string} */
function hash(bytes){return createHash('sha256').update(bytes).digest('hex');}
/** @param {Backend} backend @param {string} name @returns {Promise<Client>} */
function connect(backend,name){return connectHello(backend,{t:'hello',name,color:'#123456',password,resumable:false});}
/** @param {Client} client @param {Message} payload @returns {Promise<Message>} */
async function media(client,payload){
  const requestId=randomUUID(),cursor=send(client,{t:'mediaRequest',...payload,requestId});
  return receive(client,cursor,message=>message.t==='mediaResult' && message.requestId===requestId,'bounded adversarial media reply');
}
/** @param {Message} reply @returns {Message} */
function success(reply){assert.equal(reply.ok,true,JSON.stringify(reply));return object(reply.result);}
/** @param {Message} reply @param {string} code @returns {void} */
function rejected(reply,code){assert.equal(reply.ok,false,JSON.stringify(reply));assert.equal(reply.code,code,JSON.stringify(reply));}
/** @param {Client} client @param {Buffer} bytes @returns {Promise<MediaMetadata>} */
async function upload(client,bytes){
  assert(bytes.length<=16384,'Keep fixture below one chunk');
  const begun=success(await media(client,{op:'begin',kind:'personal',sha256:hash(bytes),bytes:bytes.length,domainId:null}));
  assert.equal(begun.asset,undefined,'Private fixture must require real transfer');
  const uploadId=string(begun.uploadId);
  success(await media(client,{op:'write',uploadId,offset:0,data:bytes.toString('base64')}));
  return parseMediaMetadata(success(await media(client,{op:'finish',uploadId})).asset ?? null);
}

test('bounded local red-team probes against actual password-protected server',{timeout:55000},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-roles-red-server-'));
  /** @type {Backend|null} */let backend=null;
  try{
    backend=await launch(directory,{HTTP_HOST:'127.0.0.1',HTTPS_HOST:'127.0.0.1',HTTPS_PORTS:'0',ECHO_PASSWORD:password,ECHO_SCREEN_MODE:'peer-relay',STUN_URLS:'',TURN_URLS:''});
    const server=backend;
    await t.test('pre-hello batch cannot execute commands or disclose room state',async()=>{
      const socket=new WebSocket(server.origin.replace('http:','ws:')+'/ws');
      /** @type {Message[]} */const frames=[];
      /** @type {Error|null} */let failure=null;
      socket.addEventListener('message',event=>{
        try{assert.equal(typeof event.data,'string');assert(frames.length<30);frames.push(object(JSON.parse(event.data)));}
        catch(error){failure=error instanceof Error ? error : new TypeError('Invalid unauthenticated reply');}
      });
      socket.addEventListener('error',()=>{failure=new Error('Pre-hello socket failed');});
      const closed=new Promise(/** @param {(value:void)=>void} resolve */resolve=>socket.addEventListener('close',()=>resolve(),{once:true}));
      try{
        await until(()=>socket.readyState===WebSocket.OPEN,()=>failure,'pre-hello connection');
        const commands=[{t:'createServer',name:'Unauthenticated domain'},{t:'createChannel',serverId:'srv-main',type:'text',name:'Unauthorized'},{t:'chat',channelId:'ch-chat',text:'Unauthenticated write'},{t:'mediaRequest',requestId:randomUUID(),op:'info',sha256:hash(animation)}];
        for(const command of commands)socket.send(JSON.stringify(command));
        socket.send(JSON.stringify({t:'hello',name:'Wrong password',password:'deliberately-wrong',resumable:false}));
        await until(()=>frames.some(frame=>frame.t==='authFailed'),()=>failure,'wrong password response');
        assert.equal(frames.filter(frame=>frame.t==='error').length,commands.length);
        assert(!frames.some(frame=>['welcome','serverState','message','servers','mediaResult'].includes(string(frame.t))));
      }finally{socket.close();await closed;}
      const observer=await connect(server,'Post-attack observer');
      const welcome=observer.messages.find(frame=>frame.t==='welcome');assert(welcome);
      assert(!JSON.stringify(welcome.servers).includes('Unauthenticated'));
      assert(!JSON.stringify(welcome.messages).includes('Unauthenticated write'));
    });

    await t.test('identity proof is bound to connection nonce and user, not a public key claim',async()=>{
      const victimKey=identity(),attackerKey=identity();
      const victim=await connect(server,'Nonce victim');
      const captured=proof(victim,victimKey);
      await authenticate(victim,victimKey);
      const replay=await connect(server,'Cross-session replay');
      const mismatch=await denied(replay,captured);
      assert.match(string(mismatch.message),/another connection challenge/);
      await denied(replay,{t:'createServer',name:'Replay escalation'});
      const rewritten=await connect(server,'Rewritten nonce replay');
      const signature=await denied(rewritten,{...captured,nonce:rewritten.challenge.nonce});
      assert.match(string(signature.message),/invalid for this server and connection/);
      await denied(rewritten,{t:'claimOwner',token:fs.readFileSync(path.join(directory,'owner-claim.txt'),'utf8').trim()});
      const duplicate=await connect(server,'Duplicate proved key');
      const duplicateReply=await denied(duplicate,proof(duplicate,victimKey));
      assert.match(string(duplicateReply.message),/另一个连接/);
      const attacker=await connect(server,'Honest ordinary key');await authenticate(attacker,attackerKey);
      await denied(attacker,{t:'createChannel',serverId:'srv-night',type:'text',name:'Cross-domain escalation'});
    });

    await t.test('private AVIF hash and stolen upload ID do not grant read, finish or cancel authority',async()=>{
      const uploader=await connect(server,'Private AVIF uploader');await authenticate(uploader,identity());
      const intruder=await connect(server,'Hash-only intruder');await authenticate(intruder,identity());
      const asset=await upload(uploader,animation);
      const diskFile=path.join(directory,'media',uploader.challenge.roomId,'objects',asset.sha256+'.avif');
      assert.deepEqual(fs.readFileSync(diskFile),animation);
      rejected(await media(intruder,{op:'info',sha256:asset.sha256}),'permission-denied');
      rejected(await media(intruder,{op:'read',sha256:asset.sha256,offset:0,length:1}),'permission-denied');
      const pending=success(await media(intruder,{op:'begin',kind:'personal',sha256:asset.sha256,bytes:asset.bytes,domainId:null}));
      assert.equal(pending.asset,undefined,'Knowing a private SHA must not deduplicate into a grant');
      const stolen=string(pending.uploadId);
      for(const op of ['finish','cancel'])rejected(await media(uploader,{op,uploadId:stolen}),'permission-denied');
      rejected(await media(uploader,{op:'write',uploadId:stolen,offset:0,data:'AA=='}),'permission-denied');
      rejected(await media(intruder,{op:'finish',uploadId:stolen}),'media-storage-failed');
      rejected(await media(intruder,{op:'info',sha256:asset.sha256}),'permission-denied');
      rejected(await media(intruder,{op:'info',sha256:'../owner-claim.txt'}),'media-invalid');
      rejected(await media(uploader,{op:'read',sha256:asset.sha256,offset:asset.bytes,length:1}),'media-storage-failed');
      const readable=success(await media(uploader,{op:'read',sha256:asset.sha256,offset:0,length:asset.bytes}));
      assert.deepEqual(Buffer.from(string(readable.data),'base64'),animation);
    });

    await t.test('real AVIF parser rejects hash-correct non-image bytes and releases upload slot',async()=>{
      const client=await connect(server,'Malformed AVIF uploader');await authenticate(client,identity());
      const invalid=Buffer.from('not an AVIF: bounded local fixture');
      const begin=success(await media(client,{op:'begin',kind:'personal',sha256:hash(invalid),bytes:invalid.length,domainId:null})),uploadId=string(begin.uploadId);
      success(await media(client,{op:'write',uploadId,offset:0,data:invalid.toString('base64')}));
      rejected(await media(client,{op:'finish',uploadId}),'media-storage-failed');
      assert.equal(fs.existsSync(path.join(directory,'media',client.challenge.roomId,'objects',hash(invalid)+'.avif')),false);
      rejected(await media(client,{op:'info',sha256:hash(invalid)}),'permission-denied');
      assert.equal((await upload(client,animation)).sha256,hash(animation));
    });

    await t.test('encoded traversal cannot disclose server source or temporary data',async()=>{
      for(const suffix of ['/%2e%2e%5cserver.js','/%2e%2e%5clib%5cserver-identity.cjs','/%2e%2e%5cdata%5csession.key','/%00server.js','/media/'+hash(animation)+'.avif']){
        const response=await fetch(server.origin+suffix,{signal:AbortSignal.timeout(3000)});
        assert([400,403,404].includes(response.status),JSON.stringify({suffix,status:response.status}));
        const body=await response.text();assert(body.length<1024,'Rejection must not contain source or private media');
      }
    });

    await t.test('chat rejects writes addressed to a voice channel',async()=>{
      const client=await connect(server,'Voice channel writer');await authenticate(client,identity());
      const requestId=randomUUID(),cursor=send(client,{t:'chat',channelId:'ch-lobby',text:'Voice channel must not accept text-history injection',requestId});
      const reply=await receive(client,cursor,message=>message.t==='chatResult' && message.requestId===requestId,'voice-channel write decision');
      t.diagnostic(JSON.stringify({probe:'voice-channel-chat',channelId:'ch-lobby',ok:reply.ok,result:reply.result ?? null}));
      assert.equal(reply.ok,false,'A voice channel accepted and persisted ordinary text history');
    });
    assert.equal(server.child.exitCode,null,'Bounded probes must leave actual server alive');
  }finally{if(backend)await stop(backend);cleanup(directory);}
});
