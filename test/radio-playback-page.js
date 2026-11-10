// @ts-check
import {createRadioPlayer} from '../public/js/radio-player.js';
import {createRadioClient} from '../public/js/radio-client.js';
/** @type {import('../public/js/radio-player.js').RadioMetadata[]} */ const metadata = [];
/** @type {string[]} */ const errors = [];
/** @type {string[]} */ const states = [];
const player = createRadioPlayer({metadataBridge:null,onMetadata:value=>metadata.push(value),onError:error=>errors.push(error.message),onState:state=>states.push(state)});
/** @param {string} url @returns {Promise<object>} */
async function play(url) {
  const count = errors.length;
  await player.setStation({url,name:'Playback verification'});
  const media = document.querySelector('audio');
  if (!media || media.readyState < 2 || media.paused) throw new Error('Real media did not decode and start playback: '+JSON.stringify({url,readyState:media?.readyState,paused:media?.paused,states,errors}));
  await new Promise(resolve=>setTimeout(resolve,350));
  if(media.currentTime < 0.1 || media.paused)throw new Error('Radio playback clock did not advance: '+JSON.stringify({url,currentTime:media.currentTime,errors}));
  await player.setOutput({volume:25,deviceId:'default',deafened:true});
  if (!media.muted || media.volume !== 0.25) throw new Error('Radio did not follow output gain and deafen');
  await player.setOutput({volume:75,deviceId:'default',deafened:false});
  if (media.muted || Number(media.volume) !== 0.75) throw new Error('Radio output did not resume');
  const result = {url,readyState:media.readyState,paused:media.paused,currentTime:media.currentTime,states:[...states],metadata:[...metadata],errors:errors.slice(count)};
  await player.setStation(null);
  if (document.querySelector('audio')) throw new Error('Radio left an audio element after stopping');
  return result;
}
/** @param {string} url @returns {Promise<{localVolume:number,masterVolume:number,mediaVolume:number,deafenVerified:boolean}>} */
async function localVolume(url) {
  const markup=await (await fetch('/public/index.html')).text();
  const parsed=new DOMParser().parseFromString(markup,'text/html'),strip=parsed.getElementById('radioStrip');
  if(!strip)throw new Error('Production radio strip is missing');
  const mountedStrip=document.importNode(strip,true);
  document.body.append(mountedStrip);
  let volume=10,masterVolume=100,deafened=false;
  const client=createRadioClient({
    getListeningChannel:()=>'radio-volume-test',
    getContext:()=>({name:'Radio',radio:{creatorKey:'test',stations:[{id:'test',name:'Volume verification',url}],stationId:'test'},canEdit:false,privilegedOnline:false,joined:true,selfKey:null,vote:null}),
    getOutput:()=>({volume:masterVolume,deviceId:'default',deafened}),getVolume:()=>volume,saveVolume:value=>{volume=value;},
    send:()=>{throw new Error('Local volume must not send shared radio commands');},modal:()=>{throw new Error('Unexpected radio modal');},metadataBridge:null,
    reportError:error=>{errors.push(error.message);},notify:()=>{throw new Error('Unexpected radio notification');},
  });
  /** @param {()=>boolean} ready @returns {Promise<void>} */
  async function waitFor(ready) {
    const deadline=performance.now()+10000;
    while(!ready()){if(performance.now()>deadline)throw new Error('Local radio volume verification timed out: '+JSON.stringify(errors));await new Promise(resolve=>setTimeout(resolve,20));}
  }
  try {
    client.refresh();
    await waitFor(()=>{const media=document.querySelector('audio');return Boolean(media && media.readyState>=2 && !media.paused);});
    const media=document.querySelector('audio'),slider=document.getElementById('radioVolume'),value=document.getElementById('radioVolumeValue');
    if(!media || !(slider instanceof HTMLInputElement) || !(value instanceof HTMLOutputElement))throw new Error('Real radio controls or media missing');
    if(media.volume!==0.1 || slider.value!=='10' || value.value!=='10%')throw new Error('Radio must begin at its independent 10% level');
    slider.value='18';slider.dispatchEvent(new Event('input',{bubbles:true}));
    await waitFor(()=>media.volume===0.18);
    if(volume!==18 || masterVolume!==100)throw new Error('Radio slider changed the master output level');
    masterVolume=50;client.refreshOutput();await waitFor(()=>media.volume===0.09);
    deafened=true;client.refreshOutput();await waitFor(()=>media.muted);
    deafened=false;client.refreshOutput();await waitFor(()=>!media.muted);
    masterVolume=0;client.refreshOutput();await waitFor(()=>media.volume===0);
    masterVolume=100;client.refreshOutput();await waitFor(()=>media.volume===0.18);
    slider.value='0';slider.dispatchEvent(new Event('input',{bubbles:true}));await waitFor(()=>media.volume===0);
    slider.value='100';slider.dispatchEvent(new Event('input',{bubbles:true}));await waitFor(()=>media.volume===1);
    return {localVolume:volume,masterVolume,mediaVolume:media.volume,deafenVerified:true};
  } finally {client.dispose();mountedStrip.remove();}
}
Object.assign(window,{radioPlaybackTest:{play,localVolume,close:()=>player.dispose()}});
