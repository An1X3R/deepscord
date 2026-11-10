// @ts-check
import {createRadioPlayer} from './radio-player.js';
import {openRadioPanel} from './radio-ui.js';
import {parseRadioState,currentRadioStation} from './radio-protocol.js';
import {mediaObject,mediaId} from './chat-protocol.js';
/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {{getListeningChannel:()=>string|null,getContext:(id:string)=>import('./radio-ui.js').RadioContext|null,getOutput:()=>import('./radio-player.js').RadioOutput,getVolume:()=>number,saveVolume:(volume:number)=>void,send:(frame:Record<string,JsonValue>)=>boolean,modal:(options:import('./radio-ui.js').ModalOptions)=>{close:()=>void},metadataBridge:import('./radio-player.js').RadioMetadataBridge|null,reportError:(error:Error)=>void,notify:(message:string)=>void}} RadioClientOptions */

/** @param {RadioClientOptions} options */
export function createRadioClient(options) {
  /** @type {Map<string,import('./radio-protocol.js').RadioVote>} */const votes=new Map();
  /** @type {Map<string,{resolve:()=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}>} */const requests=new Map();
  /** @type {ReturnType<typeof openRadioPanel>|null} */let panel=null;
  let stationKey='',playbackState='idle',metadata={stationName:'',trackTitle:/** @type {string|null} */(null)};
  /** @type {HTMLElement|null} */let strip=null;
  /** @type {HTMLElement|null} */let track=null;
  /** @type {HTMLElement|null} */let viewport=null;
  /** @type {HTMLButtonElement|null} */let manage=null;
  /** @type {HTMLButtonElement|null} */let retry=null;
  /** @type {HTMLInputElement|null} */let volumeControl=null;
  /** @type {HTMLOutputElement|null} */let volumeValue=null;
  let initialized=false;
  /** @type {WeakSet<Error>} */const reported=new WeakSet();
  /** @param {Error} error @returns {void} */
  function report(error) {if(reported.has(error))return;reported.add(error);options.reportError(error);}
  const observer=new ResizeObserver(()=>measure());
  const player=createRadioPlayer({metadataBridge:options.metadataBridge,onMetadata:value=>{metadata=value;render();},onState:value=>{playbackState=value;render();},onError:report});
  /** @returns {void} */
  function initialize() {
    if(initialized)return;
    strip=document.getElementById('radioStrip');track=document.getElementById('radioTrack');viewport=document.getElementById('radioTrackViewport');
    const button=document.getElementById('radioManageBtn'),retryButton=document.getElementById('radioRetryBtn');
    if(!strip || !track || !viewport || !(button instanceof HTMLButtonElement) || !(retryButton instanceof HTMLButtonElement))throw new Error('Radio information strip is missing required controls');
    const slider=document.getElementById('radioVolume'),value=document.getElementById('radioVolumeValue');
    if(!(slider instanceof HTMLInputElement) || !(value instanceof HTMLOutputElement))throw new Error('Radio volume controls are missing');
    volumeControl=slider;volumeValue=value;
    slider.addEventListener('input',()=>{options.saveVolume(Number(slider.value));refreshOutput();});
    manage=button;retry=retryButton;
    manage.addEventListener('click',()=>{const channelId=options.getListeningChannel();if(channelId)open(channelId);});
    retry.addEventListener('click',()=>{stationKey='';refresh();});
    observer.observe(viewport);initialized=true;
  }
  /** @returns {void} */
  function measure() {
    if(!track || !viewport)return;
    const distance=Math.max(0,track.scrollWidth-viewport.clientWidth);
    track.style.setProperty('--radio-scroll',`-${distance}px`);track.style.setProperty('--radio-duration',`${Math.max(8,distance/25)}s`);
    track.classList.toggle('scrolling',distance>0);
  }
  /** @returns {void} */
  function render() {
    if(!initialized || !strip || !track || !manage || !retry)return;
    const channelId=options.getListeningChannel(),context=channelId?options.getContext(channelId):null;
    strip.hidden=!context;
    if(!context)return;
    const name=metadata.stationName || currentRadioStation(context.radio).name;
    const label=metadata.trackTitle?`${name} — ${metadata.trackTitle}`:`目前正在收听 ${name}`;
    const next=playbackState==='loading'?`正在连接 ${name}…`:playbackState==='error'?`${name} · 连接失败`:label;
    if(track.textContent!==next){track.textContent=next;track.title=next;measure();}
    manage.textContent=votes.has(channelId ?? '')?'换台投票':'电台列表';retry.hidden=playbackState!=='error';
  }
  /** @returns {void} */
  function refreshOutput() {
    const volume=options.getVolume();
    if(!Number.isFinite(volume) || volume<0 || volume>100)throw new RangeError('Radio volume must be between 0 and 100');
    if(volumeControl)volumeControl.value=String(volume);
    if(volumeValue)volumeValue.value=`${volume}%`;
    const output=options.getOutput();
    void player.setOutput({...output,volume:output.volume*volume/100}).catch(report);
  }
  /** @returns {void} */
  function refresh() {
    initialize();
    const channelId=options.getListeningChannel(),context=channelId?options.getContext(channelId):null;
    refreshOutput();
    const station=context?currentRadioStation(context.radio):null,key=station?JSON.stringify([channelId,station.url,station.name]):'';
    if(key!==stationKey) {stationKey=key;metadata={stationName:station?.name ?? '',trackTitle:null};void player.setStation(station).catch(report);}
    render();panel?.refresh();
  }
  /** @param {Record<string,JsonValue>} frame @returns {Promise<void>} */
  function request(frame) {
    if(requests.size>=16)return Promise.reject(new Error('电台操作过于频繁，请等待当前操作完成'));
    const requestId=crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{requests.delete(requestId);reject(new Error('电台操作确认超时，请检查房间连接'));},10000);
      requests.set(requestId,{resolve,reject,timer});
      if(!options.send({...frame,requestId})){clearTimeout(timer);requests.delete(requestId);reject(new Error('房间连接中断，电台操作没有发出'));}
    });
  }
  /** @param {string} channelId @returns {void} */
  function open(channelId) {
    panel?.close();
    panel=openRadioPanel({channelId,getContext:()=>{const context=options.getContext(channelId);return context?{...context,vote:votes.get(channelId) ?? null}:null;},request,modal:options.modal});
  }
  /** @param {JsonValue} input @returns {boolean} */
  function receive(input) {
    const row=mediaObject(input,'Radio event');
    if(row.t==='radioState') {const state=parseRadioState(row);if(state.vote)votes.set(state.channelId,state.vote);else votes.delete(state.channelId);if(state.reason && state.channelId===options.getListeningChannel())options.notify(state.reason);render();panel?.refresh();return true;}
    if(row.t!=='radioResult')return false;
    const requestId=mediaId(row.requestId,'Radio request ID'),pending=requests.get(requestId);
    if(!pending)return true;
    if(typeof row.ok!=='boolean' || !row.ok && typeof row.error!=='string')throw new TypeError('Invalid radio operation response');
    clearTimeout(pending.timer);requests.delete(requestId);
    if(row.ok)pending.resolve();else pending.reject(new Error(String(row.error)));
    return true;
  }
  /** @returns {void} */
  function disconnect() {
    for(const pending of requests.values()){clearTimeout(pending.timer);pending.reject(new DOMException('服务器连接已变化','AbortError'));}requests.clear();votes.clear();panel?.close();panel=null;
    stationKey='';void player.setStation(null).catch(options.reportError);render();
  }
  /** @returns {void} */
  function dispose() {disconnect();observer.disconnect();void player.dispose().catch(options.reportError);}
  return {refresh,refreshOutput,open,receive,disconnect,dispose};
}
