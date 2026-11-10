// @ts-check
import {ScreenLink} from '../public/js/screen-link.js';
import {VoiceEngine} from '../public/js/voice.js';
import {ScreenRelay} from '../public/js/screen-relay.js';

/** @param {boolean} condition @param {string} message @returns {asserts condition} */
function verify(condition,message){if(!condition)throw new Error(message);}
/** @param {()=>boolean} condition @param {string} label @returns {Promise<void>} */
async function until(condition,label){const deadline=Date.now()+15000;while(!condition()){if(Date.now()>deadline)throw new Error('Timed out: '+label);await new Promise(resolve=>setTimeout(resolve,30));}}
/** @param {ScreenLink} link @returns {Promise<string>} */
async function description(link){await until(()=>link.pc.iceGatheringState==='complete','local ICE');const sdp=link.pc.localDescription?.sdp;verify(!!sdp,'Missing local SDP');return sdp;}
/** @param {'POST'|'GET'|'DELETE'} method @param {string} endpoint @param {object|null} body @returns {Promise<import('../public/js/network-protocol.js').JsonValue>} */
async function nativeRequest(method,endpoint,body){const response=await fetch('/native'+endpoint,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(!response.ok)throw new Error('Native relay HTTP '+response.status+': '+await response.text());return response.json();}
/** @param {ScreenLink} link @param {string} id @param {'publish'|'subscribe'} role @returns {Promise<void>} */
async function negotiateNative(link,id,role){
  const negotiationId=crypto.randomUUID();
  const result=/** @type {{sdp:{type:'answer',sdp:string}}} */(await nativeRequest('POST','/session',{id,negotiationId,role,source:'encrypted-source',sdp:{type:'offer',sdp:await description(link)},network:{iceServers:[],policy:'all'},admission:{streamBps:2000000,subscriberBudgetBps:role==='subscribe'?2400000:0,sourceBudgetBps:20000000,locality:'remote'}}));
  await link.acceptAnswer(result.sdp.sdp);
  let cursor=0,complete=false;
  const deadline=Date.now()+15000;
  while(!complete){
    if(Date.now()>deadline)throw new Error('Native relay ICE gathering timed out');
    const batch=/** @type {{next:number,complete:boolean,candidates:import('../public/js/screen-ice.js').ScreenIceCandidate[]}} */(await nativeRequest('GET','/session/'+id+'/ice?after='+cursor+'&negotiationId='+negotiationId,null));
    for(const candidate of batch.candidates)await link.addIce(candidate);
    cursor=batch.next;complete=batch.complete;
    if(!complete)await new Promise(resolve=>setTimeout(resolve,30));
  }
}
/** @returns {Promise<{plainFrames:number,directFrames:number,nativePlainFrames:number,nativeFrames:number,keyRotation:boolean}>} */
export async function run(){
  const key=crypto.getRandomValues(new Uint8Array(32)),contentEncryption={key,keyId:'screen-link-epoch'};
  const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
  const context=canvas.getContext('2d');verify(context!==null,'Missing canvas context');
  const stream=canvas.captureStream(15);
  const timer=setInterval(()=>{context.fillStyle='#e02020';context.fillRect(0,0,320,180);context.fillStyle='#3020e0';context.fillRect(Date.now()%250,70,30,30);},50);
  /** @type {Error[]} */const errors=[];
  const video=document.createElement('video');video.muted=true;video.autoplay=true;document.body.append(video);
  /** @type {ScreenLink[]} */const links=[];
  /** @param {import('../public/js/screen-link.js').ScreenContentEncryption|null} encryption @returns {ScreenLink} */function link(encryption){const value=new ScreenLink({network:{iceServers:[],iceTransportPolicy:'all'},contentEncryption:encryption,onStream:stream=>{video.srcObject=stream;void video.play();},onIce:()=>{},onFault:error=>errors.push(error)});links.push(value);return value;}
  /** @param {ScreenLink} receiving @returns {Promise<number>} */async function decoded(receiving){
    await until(()=>errors.length>0||video.getVideoPlaybackQuality().totalVideoFrames>=5,'encrypted ScreenLink video');
    verify(errors.length===0,'Encrypted ScreenLink errors: '+errors.map(error=>error.message).join(';'));
    verify(video.videoWidth===320&&video.videoHeight===180,'ScreenLink decoded dimensions differ');
    const pixels=document.createElement('canvas');pixels.width=320;pixels.height=180;const sample=pixels.getContext('2d');verify(sample!==null,'Missing sample context');sample.drawImage(video,0,0);const pixel=sample.getImageData(10,10,1,1).data;verify(pixel[0]>150&&pixel[1]<90&&pixel[2]<90,'Encrypted ScreenLink decoded pixel mismatch');
    const stats=await receiving.stats();verify(stats.framesDecoded>=5,'ScreenLink decoded fewer than five frames');return stats.framesDecoded;
  }
  try{
    const plainSender=link(null),plainReceiver=link(null);
    await plainSender.sendOffer(stream,2000000,15,'motion');await plainReceiver.answer(await description(plainSender));await plainSender.acceptAnswer(await description(plainReceiver));
    const plainFrames=await decoded(plainReceiver);plainSender.close();plainReceiver.close();video.srcObject=null;
    const directSender=link(contentEncryption),directReceiver=link(contentEncryption);
    await directSender.sendOffer(stream,2000000,15,'motion');await directReceiver.answer(await description(directSender));await directSender.acceptAnswer(await description(directReceiver));
    const directFrames=await decoded(directReceiver);directSender.close();directReceiver.close();video.srcObject=null;
    await nativeRequest('POST','/budget',{sourceBudgetBps:20000000});
    const plainPublisher=link(null);await plainPublisher.sendOffer(stream,2000000,15,'motion');await negotiateNative(plainPublisher,'plain-publisher','publish');
    const plainSubscriber=link(null);await plainSubscriber.receiveOffer();await negotiateNative(plainSubscriber,'plain-subscriber','subscribe');
    const nativePlainFrames=await decoded(plainSubscriber);
    await nativeRequest('DELETE','/session/plain-publisher',null);await nativeRequest('DELETE','/session/plain-subscriber',null);
    plainPublisher.close();plainSubscriber.close();video.srcObject=null;
    const publisher=link(contentEncryption);await publisher.sendOffer(stream,2000000,15,'motion');await negotiateNative(publisher,'encrypted-publisher','publish');
    const subscriber=link(contentEncryption);await subscriber.receiveOffer();await negotiateNative(subscriber,'encrypted-subscriber','subscribe');
    const nativeFrames=await decoded(subscriber);
    await nativeRequest('DELETE','/session/encrypted-publisher',null);
    const engine=new VoiceEngine({selfId:'epoch-owner',config:{networkMode:'direct',mediaPolicy:'direct',iceServers:[],iceTransportPolicy:'all',iceExpiresAt:null},getSettings:()=>({inputDeviceId:'default',echoCancellation:true,noiseSuppression:true,autoGainControl:true,micVolume:100,outVolume:100,mode:'vad',vadThreshold:-50,monitor:false,outputDeviceId:'default'}),sendSignal:()=>{},onEvent:()=>{}});
    await engine.setContentEncryption(contentEncryption);const owned=engine.contentEncryption;verify(owned!==null&&owned.key!==key,'Engine must own its room key copy');
    verify(engine.screenTransport instanceof ScreenRelay,'Expected direct screen transport');
    const edge=engine.screenTransport.createEdge({kind:'plan',version:2,sourceId:'epoch-owner',shareId:'epoch-share',epoch:1,bitrateBps:2000000,wireBps:2400000,routes:[]},'epoch-edge','epoch-peer','direct','epoch-negotiation',{iceServers:[],iceTransportPolicy:'all'});
    await edge.link.sendOffer(stream,2000000,15,'motion');
    await engine.setContentEncryption({key:crypto.getRandomValues(new Uint8Array(32)),keyId:'next-epoch'});
    verify(edge.link.closed&&owned.key.every(byte=>byte===0),'Key rotation must close old screen edges and clear the owned key');
    await engine.setContentEncryption(null);verify(engine.contentEncryption===null&&key.some(byte=>byte!==0),'Plain room selection must retain caller key ownership');engine.leave();
    publisher.close();subscriber.close();video.srcObject=null;
    return {plainFrames,directFrames,nativePlainFrames,nativeFrames,keyRotation:true};
  }finally{clearInterval(timer);for(const connection of links)connection.close();for(const track of stream.getTracks())track.stop();video.remove();}
}
