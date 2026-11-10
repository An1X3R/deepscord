// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createPrivateKey,randomUUID,sign} from 'node:crypto';
import {test} from 'node:test';
import {createRoomDocument,parseRoomDocument,roomVotePayload,verifyRoomVote,openRoomReplica} from '../lib/room-replica.cjs';
import {createWorkspaceStore} from '../desktop/workspace-store.cjs';

const creatorKey='MCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=';
const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,7)]),format:'der',type:'pkcs8'});
const descriptor={version:/** @type {const} */(1),roomId:'11111111-1111-4111-8111-111111111111',creatorKey};
/** @type {import('../lib/steam-state.cjs').RoomServer[]} */
const servers=[{id:'main',name:'Saved room',icon:'D',color:'#56cfc3',channels:[{id:'voice',name:'Voice',type:'voice',userLimit:8},{id:'text',name:'Text',type:'text',userLimit:0}]}];
/** @type {import('../lib/steam-state.cjs').RoomServer[]} */
const radioServers=[{...servers[0],channels:[...servers[0].channels,{id:'radio',name:'Radio',type:'radio',userLimit:10,radio:{creatorKey,stations:[{id:'one',name:'Station',url:'https://example.com/live.mp3'}],stationId:'one'}}]}];
// These digests were produced by the shipped customization and radio release packages.
const original={...descriptor,revision:7,servers,digest:'50a66a317186439d4a953773b5bcaea864c26fe846f97ef8833ba104271656c6'};
const previewPlain={...original,digest:'a378031c90738edc3be7bff85c5b6e3f89c523877938470052b4924c6559a25a'};
const previewRadio={...original,servers:radioServers,digest:'ecc8f65a690ce34c3d373b8afaa4a9b3c5df3bcc00e7297fa66fd00811629c25'};

test('persisted release digests remain verifiable without weakening structure validation',()=>{
  assert.equal(createRoomDocument(descriptor,7,servers).digest,original.digest);
  for(const document of [original,previewPlain,previewRadio]){
    assert.deepEqual(parseRoomDocument(document,descriptor),document);
    const reordered={...document,servers:document.servers.map(server=>({...server,channels:server.channels.map(channel=>({userLimit:channel.userLimit,id:channel.id,name:channel.name,type:channel.type,...(channel.type==='radio' ? {radio:channel.radio} : {})}))}))};
    assert.deepEqual(parseRoomDocument(reordered,descriptor),document);
    assert.throws(()=>parseRoomDocument({...document,servers:document.servers.map(server=>({...server,name:'Changed'}))},descriptor),/digest/);
    assert.throws(()=>parseRoomDocument({...document,digest:'0'.repeat(64)},descriptor),/digest/);
    const roundId=randomUUID();
    const signature=sign(null,Buffer.from(roomVotePayload(roundId,creatorKey,document,false)),privateKey).toString('base64');
    assert.equal(verifyRoomVote({roundId,memberKey:creatorKey,document,signature,fresh:false},descriptor,roundId).document.digest,document.digest);
  }
});

test('workspace and standalone room restart preserve old and radio-preview snapshots',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-replica-compat-'));
  try{
    const workspace=createWorkspaceStore(directory);
    const entryId=workspace.saveConnection({mode:'server',role:'guest',address:'http://127.0.0.1:8080/',invite:'',hostAddress:'',hostPort:0,appId:0,stunUrls:[]},null);
    const filename=path.join(directory,'workspace.json');
    /** @type {import('../desktop/workspace-store.cjs').Workspace} */
    const empty=JSON.parse(fs.readFileSync(filename,'utf8'));
    for(const document of [original,previewPlain,previewRadio]){
      const saved={...empty,entries:empty.entries.map(entry=>({...entry,roomId:descriptor.roomId,creatorKey,document,conflicts:[original,previewPlain,previewRadio]}))};
      fs.writeFileSync(filename,JSON.stringify(saved));
      const before=fs.readFileSync(filename);
      const restored=createWorkspaceStore(directory);
      assert.deepEqual(restored.get(entryId).document,document);
      assert.equal(restored.get(entryId).conflicts.length,3);
      assert.deepEqual(fs.readFileSync(filename),before);
      const roomDirectory=path.join(directory,document.digest);
      fs.mkdirSync(roomDirectory);
      fs.writeFileSync(path.join(roomDirectory,'room-identity.json'),JSON.stringify({...descriptor,document,authorityPrivateKey:null}));
      const room=openRoomReplica({dataDir:roomDirectory,environment:{},servers:[]});
      assert.deepEqual(room.getDocument(),document);
      const next=createRoomDocument(descriptor,8,document.servers);
      room.persist(next);
      assert.deepEqual(openRoomReplica({dataDir:roomDirectory,environment:{},servers:[]}).getDocument(),next);
    }
  }finally{
    assert.equal(path.dirname(directory),os.tmpdir());
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
