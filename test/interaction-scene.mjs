import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import governance from '../lib/server-governance.cjs';
import { customInteractions } from '../public/js/customization-protocol.js';
import { parseCustomInteraction } from '../public/js/customization-protocol.js';
import { parseInteractionScene, scenePose } from '../public/js/interaction-scene.js';
import { SCENE_EXAMPLES } from '../public/js/interaction-scene-examples.js';
import { interactionRevision } from '../public/js/interaction-catalog.js';

test('Scenes validate, strip extras and retain legacy signed shape and limits',async()=>{
  const legacy={id:'legacy',name:'Legacy',thumbnail:null,model:'poop',trajectory:'linear',sound:'none',durationMs:650};
  const parsed=parseCustomInteraction(legacy);
  assert(!Object.hasOwn(parsed,'scene'));
  assert.equal(await interactionRevision(parsed),await interactionRevision(legacy));
  assert.throws(()=>parseCustomInteraction({...legacy,durationMs:2500}),RangeError);
  for(const example of SCENE_EXAMPLES)assert.deepEqual(parseCustomInteraction(example),example);
  const scene=SCENE_EXAMPLES[0].scene;
  assert(scene);
  assert.deepEqual(parseInteractionScene({...scene,extra:'discard'}),scene);
  assert.equal(parseCustomInteraction({...SCENE_EXAMPLES[0],durationMs:4000}).durationMs,4000);
  assert.throws(()=>parseCustomInteraction({...SCENE_EXAMPLES[0],durationMs:4001}),RangeError);
  assert.throws(()=>parseInteractionScene({...scene,actors:Array(9).fill(scene.actors[0])}),RangeError);
  for(const value of [NaN,Infinity,-1,1.1])assert.throws(()=>parseInteractionScene({...scene,actors:[{...scene.actors[0],keyframes:scene.actors[0].keyframes.map((frame,index)=>index===1?{...frame,at:value}:frame)}]}),RangeError);
  assert.throws(()=>parseInteractionScene({...scene,actors:[{...scene.actors[0],keyframes:[scene.actors[0].keyframes[0],scene.actors[0].keyframes[0]]}]}),RangeError);
  assert.throws(()=>parseInteractionScene({...scene,actors:[{...scene.actors[0],keyframes:Array(13).fill(scene.actors[0].keyframes[0])}]}),RangeError);
  assert.throws(()=>parseInteractionScene({...scene,actors:[{...scene.actors[0],keyframes:scene.actors[0].keyframes.map(frame=>({...frame,scale:5}))}]}),RangeError);
});

test('Anchors interpolate reverse paths and follow moving cards without mutation',()=>{
  const fist=SCENE_EXAMPLES[0].scene.actors[0],dollar=SCENE_EXAMPLES[1].scene.actors[0];
  const before=JSON.stringify(SCENE_EXAMPLES),sender={x:20,y:30},target={x:600,y:80};
  assert.equal(scenePose(fist,0,sender,target).x,624);
  assert.equal(scenePose(fist,0.5,sender,{x:700,y:80}).x,700);
  assert.equal(scenePose(dollar,0,sender,target).x,600);
  assert.equal(scenePose(dollar,0.72,sender,target).x,20);
  assert(Math.abs(scenePose(dollar,0.46,sender,target).x-310)<1e-8);
  assert.equal(scenePose(dollar,1,sender,target).opacity,0);
  assert.equal(JSON.stringify(SCENE_EXAMPLES),before);
});

test('Signed scene state roundtrips and rejects modified keyframes',()=>{
  const pair=generateKeyPairSync('ed25519');
  const key=pair.publicKey.export({format:'der',type:'spki'}).toString('base64');
  const descriptor={version:1,roomId:randomUUID(),creatorKey:key};
  let journal=governance.createGovernance(descriptor);
  for(const definition of SCENE_EXAMPLES){
    const command={type:'putInteraction',domainId:null,interaction:definition};
    const payload=governance.governancePayload(journal,key,command);
    const event={revision:journal.events.length+1,previousDigest:journal.digest,actorKey:key,command,signature:sign(null,Buffer.from(payload),pair.privateKey).toString('base64')};
    journal=governance.appendGovernance(journal,event);
  }
  const restored=governance.parseGovernance(JSON.parse(JSON.stringify(journal)),descriptor);
  const state=governance.governanceState(restored);
  assert.deepEqual(customInteractions(state,null),SCENE_EXAMPLES);
  const clone=customInteractions(state,null);
  clone[0].scene.actors[0].keyframes[0].x=400;
  assert.deepEqual(customInteractions(state,null),SCENE_EXAMPLES);
  const tampered=JSON.parse(JSON.stringify(journal));
  tampered.events[0].command.interaction.scene.actors[0].keyframes[0].x+=1;
  assert.throws(()=>governance.parseGovernance(tampered,descriptor));
});
