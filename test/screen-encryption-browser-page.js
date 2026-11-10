// @ts-check
import {createScreenEncryption,createScreenSfuEncryption} from '../public/js/screen-encryption.js';

/** @param {boolean} condition @param {string} message @returns {asserts condition} */
function verify(condition,message) {if(!condition)throw new Error(message);}
/** @param {()=>boolean} condition @param {string} label @returns {Promise<void>} */
async function until(condition,label) {
  const deadline=Date.now()+15000;
  while(!condition()) {if(Date.now()>deadline)throw new Error('Timed out: '+label);await new Promise(resolve=>setTimeout(resolve,30));}
}
/** @returns {Promise<{framesDecoded:number,width:number,height:number,keyRetained:boolean,sfuKeyBits:number}>} */
export async function run() {
  const key=crypto.getRandomValues(new Uint8Array(32)), original=new Uint8Array(key);
  /** @type {Error[]} */ const errors=[];
  const senderCrypto=await createScreenEncryption({key,keyId:'integration-epoch',identity:'sender',onError:error=>errors.push(error)});
  const receiverCrypto=await createScreenEncryption({key,keyId:'integration-epoch',identity:'receiver',onError:error=>errors.push(error)});
  const configuration=/** @type {RTCConfiguration & {encodedInsertableStreams:boolean}} */({iceServers:[],encodedInsertableStreams:true});
  const sending=new RTCPeerConnection(configuration),receiving=new RTCPeerConnection(configuration);
  const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
  const context=canvas.getContext('2d');verify(context!==null,'Canvas context missing');
  const stream=canvas.captureStream(15),track=stream.getVideoTracks()[0];
  const video=document.createElement('video');video.muted=true;video.autoplay=true;document.body.append(video);
  let frame=0;
  const drawing=setInterval(()=>{context.fillStyle='#f02020';context.fillRect(0,0,320,180);context.fillStyle='#2040f0';context.fillRect((frame++*5)%280,60,40,40);},50);
  try {
    const outgoing=sending.addTransceiver(track,{direction:'sendonly'});
    const codecs=RTCRtpSender.getCapabilities('video')?.codecs.filter(codec=>codec.mimeType.toLowerCase()==='video/vp8');verify(!!codecs?.length,'VP8 unavailable');
    outgoing.setCodecPreferences(codecs);
    await senderCrypto.bindSender(outgoing.sender,'out-video');
    await sending.setLocalDescription(await sending.createOffer());
    await until(()=>sending.iceGatheringState==='complete','sender ICE gathering');
    verify(sending.localDescription!==null,'Missing sender SDP');
    await receiving.setRemoteDescription(sending.localDescription);
    const incoming=receiving.getTransceivers()[0];
    incoming.setCodecPreferences(codecs);
    await receiverCrypto.bindReceiver(incoming.receiver,'in-video');
    video.srcObject=new MediaStream([incoming.receiver.track]);
    await receiving.setLocalDescription(await receiving.createAnswer());
    await until(()=>receiving.iceGatheringState==='complete','receiver ICE gathering');
    verify(receiving.localDescription!==null,'Missing receiver SDP');
    await sending.setRemoteDescription(receiving.localDescription);
    void video.play();
    try { await until(()=>video.readyState>=2&&video.videoWidth===320&&video.getVideoPlaybackQuality().totalVideoFrames>=5,'decrypted video decode'); }
    catch(error) {
      /** @type {object[]} */const reports=[];
      (await sending.getStats()).forEach(report=>{if(report.type==='outbound-rtp')reports.push({direction:'send',framesEncoded:report.framesEncoded,packetsSent:report.packetsSent});});
      (await receiving.getStats()).forEach(report=>{if(report.type==='inbound-rtp')reports.push({direction:'receive',framesDecoded:report.framesDecoded,framesReceived:report.framesReceived,packetsReceived:report.packetsReceived});});
      throw new Error(String(error)+' errors='+errors.map(item=>item.message).join(';')+' stats='+JSON.stringify(reports));
    }
    const sample=document.createElement('canvas');sample.width=320;sample.height=180;
    const sampleContext=sample.getContext('2d');verify(sampleContext!==null,'Sample context missing');sampleContext.drawImage(video,0,0);
    const pixel=sampleContext.getImageData(10,10,1,1).data;verify(pixel[0]>180&&pixel[1]<90&&pixel[2]<90,'Decoded video pixel does not match canvas');
    let framesDecoded=0;
    (await receiving.getStats()).forEach(report=>{if(report.type==='inbound-rtp'&&report.kind==='video')framesDecoded=report.framesDecoded;});
    verify(framesDecoded>0,'Receiver decoded no encrypted frames');
    verify(errors.length===0,'Encryption worker errors: '+errors.map(error=>error.message).join('; '));
    const sfu=await createScreenSfuEncryption({key,keyId:'integration-epoch',identity:'sfu',onError:error=>errors.push(error)});
    const sfuKeyBits=sfu.e2ee.keyProvider.getOptions().keySize;sfu.destroy();
    senderCrypto.destroy();receiverCrypto.destroy();
    const keyRetained=key.every((byte,index)=>byte===original[index]);verify(keyRetained,'Adapter mutated caller key');
    return {framesDecoded,width:video.videoWidth,height:video.videoHeight,keyRetained,sfuKeyBits};
  } finally {
    clearInterval(drawing);sending.close();receiving.close();senderCrypto.destroy();receiverCrypto.destroy();track.stop();video.remove();
  }
}
