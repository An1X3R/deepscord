// @ts-check
import {ScreenSfu} from '../public/js/screen-sfu.js';

/** @param {boolean} condition @param {string} message @returns {asserts condition} */
function verify(condition,message){if(!condition)throw new Error(message);}
/** @returns {Promise<{plain:{decodedFrames:number,encryptedPublication:boolean,elapsedMs:number},encrypted:{decodedFrames:number,encryptedPublication:boolean,elapsedMs:number}}>} */
export async function run(){return {plain:await exercise(null),encrypted:await exercise({key:crypto.getRandomValues(new Uint8Array(32)),keyId:'sfu-positive-epoch'})};}
/** @param {import('../public/js/screen-link.js').ScreenContentEncryption|null} content */
async function exercise(content){
  /** @type {Error[]} */const errors=[];
  const video=document.createElement('video');video.autoplay=true;video.muted=true;document.body.append(video);
  /** @param {string} selfId @returns {ScreenSfu} */
  function adapter(selfId){return new ScreenSfu({selfId,getContentEncryption:()=>content,getBitrateBps:()=>2000000,getFrameRate:()=>15,getContentMode:()=>'motion',requestToken:async()=>{const response=await fetch('/sfu-credential?identity='+selfId);verify(response.ok,'SFU credential HTTP '+response.status);return response.json();},releaseToken:async()=>{const response=await fetch('/sfu-release?identity='+selfId);verify(response.ok,'SFU release HTTP '+response.status);},onStream:(_id,stream)=>{if(selfId==='sfu-viewer'){video.srcObject=stream;if(stream)void video.play();}},onSourceEnded:()=>{},onError:error=>errors.push(error)});}
  const source=adapter('sfu-source'),viewer=adapter('sfu-viewer');
  const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const context=canvas.getContext('2d');verify(context!==null,'SFU canvas context missing');
  const timer=setInterval(()=>{context.fillStyle='#e02020';context.fillRect(0,0,320,180);context.fillStyle='#3020e0';context.fillRect(Date.now()%250,70,30,30);},50);
  const stream=canvas.captureStream(15);
  try{
    await source.join('sfu-test-channel');await viewer.join('sfu-test-channel');
    await source.publish(stream);const started=performance.now();await viewer.watch('sfu-source');
    const deadline=Date.now()+15000;
    while(video.getVideoPlaybackQuality().totalVideoFrames<5&&errors.length===0){if(Date.now()>deadline)throw new Error('Encrypted SFU video decode timed out');await new Promise(resolve=>setTimeout(resolve,30));}
    verify(errors.length===0,'Encrypted SFU error: '+errors.map(error=>error.message).join(';'));
    verify(video.videoWidth===320&&video.videoHeight===180,'Encrypted SFU video dimensions differ');
    const sample=document.createElement('canvas');sample.width=320;sample.height=180;const pixels=sample.getContext('2d');verify(pixels!==null,'SFU sample context missing');pixels.drawImage(video,0,0);const pixel=pixels.getImageData(10,10,1,1).data;verify(pixel[0]>150&&pixel[1]<90&&pixel[2]<90,'Encrypted SFU video pixel mismatch');
    const publication=[...(source.publisher?.room.localParticipant.videoTrackPublications.values()||[])][0];verify(!!publication,'Missing SFU screen publication');verify(publication.isEncrypted===(content!==null),'SFU encryption advertisement differs');
    const elapsedMs=performance.now()-started;
    return {elapsedMs,decodedFrames:video.getVideoPlaybackQuality().totalVideoFrames,encryptedPublication:publication.isEncrypted};
  }finally{await viewer.leave();await source.leave();clearInterval(timer);for(const track of stream.getTracks())track.stop();video.remove();}
}
