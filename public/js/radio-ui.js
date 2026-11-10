// @ts-check
import {parseRadioStation,currentRadioStation} from './radio-protocol.js';
/** @typedef {import('./radio-protocol.js').RadioConfig} RadioConfig */
/** @typedef {import('./radio-protocol.js').RadioVote} RadioVote */
/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {{name:string,radio:RadioConfig,canEdit:boolean,privilegedOnline:boolean,joined:boolean,selfKey:string|null,vote:RadioVote|null}} RadioContext */
/** @typedef {{close:()=>void}} ModalView */
/** @typedef {{title:string,body:HTMLElement,width:number,footer:HTMLElement[],onClose:()=>void}} ModalOptions */
/** @typedef {{channelId:string,getContext:()=>RadioContext|null,request:(frame:Record<string,JsonValue>)=>Promise<void>,modal:(options:ModalOptions)=>ModalView}} RadioPanelOptions */

export const RADIO_PRESETS=Object.freeze([
  {id:'datafruits',name:'Datafruits',url:'https://streampusher-relay.club/datafruits.mp3'},
  {id:'teodor',name:'Teodor Radio',url:'https://radiorecord.hostingradio.ru/teo96.aacp'},
  {id:'synthwave',name:'Record Synthwave',url:'https://radiorecord.hostingradio.ru/synth96.aacp'},
]);
/** @param {string} id @param {string} label @returns {HTMLButtonElement} */
function button(id,label) {const node=document.createElement('button');node.id=id;node.type='button';node.className='btn small';node.textContent=label;return node;}
/** @param {string} id @param {string} label @param {number} length @returns {HTMLInputElement} */
function input(id,label,length) {const node=document.createElement('input');node.id=id;node.className='input';node.placeholder=label;node.setAttribute('aria-label',label);node.maxLength=length;return node;}
/** @param {string} value @param {string} label @returns {HTMLOptionElement} */
function option(value,label) {const node=document.createElement('option');node.value=value;node.textContent=label;return node;}
/** @returns {{element:HTMLElement,read:()=>{stations:import('./radio-protocol.js').RadioStation[],stationId:string}}} */
export function createRadioFields() {
  const element=document.createElement('div');element.id='createRadioFields';element.className='field';
  const presets=document.createElement('select');presets.id='createRadioPreset';presets.className='input';presets.setAttribute('aria-label','选择电台');
  presets.append(option('custom','自定义电台'),...RADIO_PRESETS.map(entry=>option(entry.id,entry.name)));
  const name=input('createRadioName','电台名称',80),url=input('createRadioUrl','HTTP / HTTPS 音频或 HLS 链接',2048);
  presets.addEventListener('change',()=>{const station=RADIO_PRESETS.find(entry=>entry.id===presets.value);name.value=station?.name ?? '';url.value=station?.url ?? '';});
  element.append(presets,name,url);
  return {element,read:()=>{
    const station=parseRadioStation({id:presets.value==='custom'?crypto.randomUUID():presets.value,name:name.value.trim(),url:url.value.trim()});
    const stations=RADIO_PRESETS.some(entry=>entry.id===station.id)?RADIO_PRESETS.map(entry=>entry.id===station.id?station:{...entry}):[station];
    return {stations,stationId:station.id};
  }};
}
/** @param {RadioPanelOptions} options @returns {{close:()=>void,refresh:()=>void}} */
export function openRadioPanel(options) {
  const body=document.createElement('div');body.id='radioPanel';body.className='field radio-panel';
  const status=document.createElement('p');status.id='radioPanelStatus';status.className='edit-hint';
  const error=document.createElement('p');error.id='radioPanelError';error.className='governance-error';error.setAttribute('role','alert');error.hidden=true;
  const stations=document.createElement('select');stations.id='radioStationSelect';stations.className='input';stations.setAttribute('aria-label','已保存电台');
  const name=input('radioStationName','电台名称',80),url=input('radioStationUrl','电台音频或 HLS 链接',2048);
  const switchStation=button('radioSwitchBtn','切换电台'),save=button('radioSaveBtn','保存到列表'),add=button('radioNewBtn','新增电台'),remove=button('radioRemoveBtn','删除电台'),approve=button('radioApproveBtn','赞成换台');
  const controls=document.createElement('div');controls.className='radio-controls';controls.append(switchStation,save,add,remove,approve);
  body.append(status,stations,name,url,controls,error);
  const close=button('radioCloseBtn','关闭');let closed=false,busy=false,signature='';
  const view=options.modal({title:'电台列表',body,width:560,footer:[close],onClose:()=>{closed=true;}});
  close.addEventListener('click',()=>view.close());
  /** @returns {RadioContext} */
  function context() {const value=options.getContext();if(!value)throw new Error('服务器连接或电台频道已经改变');return value;}
  /** @returns {void} */
  function fillSelection() {const current=context(),station=current.radio.stations.find(entry=>entry.id===stations.value);name.value=station?.name ?? '';url.value=station?.url ?? '';}
  /** @returns {void} */
  function refresh() {
    if(closed)return;
    const current=options.getContext();if(!current){view.close();return;}
    const next=JSON.stringify(current.radio.stations);
    if(signature!==next) {
      const selected=signature?stations.value:current.radio.stationId;
      stations.replaceChildren(option('','新增电台'),...current.radio.stations.map(entry=>option(entry.id,entry.name)));
      stations.value=current.radio.stations.some(entry=>entry.id===selected)?selected:'';
      signature=next;fillSelection();
    }
    const vote=current.vote;
    status.textContent=vote?`换台投票：${vote.station.name} · ${vote.votedKeys.length}/${vote.eligibleKeys.length} 人赞成 · 需 ${Math.floor(vote.eligibleKeys.length/2)+1} 票`:`正在收听 ${currentRadioStation(current.radio).name}。${current.canEdit?'可管理列表和直接换台。':current.privilegedOnline?'创建者或管理人员在线，请由他们换台。':'加入本频道后，可发起 60 秒换台投票，过半赞成生效。'}`;
    switchStation.textContent=current.canEdit?'切换电台':'发起换台投票';
    switchStation.disabled=busy || Boolean(vote) || (!current.canEdit && (!current.joined || current.privilegedOnline));
    save.hidden=!current.canEdit;remove.hidden=!current.canEdit;
    save.disabled=busy;remove.disabled=busy || !stations.value || current.radio.stations.length<=1 || stations.value===current.radio.stationId;
    name.readOnly=!current.canEdit && Boolean(stations.value);url.readOnly=name.readOnly;
    approve.hidden=!vote;approve.disabled=busy || !vote || !current.selfKey || !vote.eligibleKeys.includes(current.selfKey) || vote.votedKeys.includes(current.selfKey);
    add.disabled=busy || current.radio.stations.length>=24;
  }
  /** @param {()=>Promise<void>} action @returns {void} */
  function run(action) {if(busy)return;busy=true;error.hidden=true;refresh();void action().catch(failure=>{if(!closed){error.textContent=failure instanceof Error?failure.message:String(failure);error.hidden=false;}}).finally(()=>{busy=false;refresh();});}
  /** @returns {import('./radio-protocol.js').RadioStation} */
  function edited() {return parseRadioStation({id:stations.value || crypto.randomUUID(),name:name.value.trim(),url:url.value.trim()});}
  /** @param {RadioConfig} radio @returns {Promise<void>} */
  function change(radio) {return options.request({t:'radioChange',channelId:options.channelId,radio});}
  stations.addEventListener('change',()=>{fillSelection();refresh();});
  add.addEventListener('click',()=>{stations.value='';fillSelection();refresh();name.focus();});
  switchStation.addEventListener('click',()=>run(async()=>{
    const current=context(),station=edited();
    if(current.canEdit)await change({...current.radio,stations:[...current.radio.stations.filter(entry=>entry.id!==station.id),station],stationId:station.id});
    else await options.request({t:'radioPropose',channelId:options.channelId,station});
  }));
  save.addEventListener('click',()=>run(async()=>{const current=context(),station=edited();if(!current.canEdit)throw new Error('当前没有管理电台的权限');await change({...current.radio,stations:[...current.radio.stations.filter(entry=>entry.id!==station.id),station]});}));
  remove.addEventListener('click',()=>run(async()=>{const current=context();if(!current.canEdit)throw new Error('当前没有管理电台的权限');await change({...current.radio,stations:current.radio.stations.filter(entry=>entry.id!==stations.value)});}));
  approve.addEventListener('click',()=>run(async()=>{const vote=context().vote;if(!vote)throw new Error('投票已经结束');await options.request({t:'radioApprove',channelId:options.channelId,voteId:vote.id});}));
  refresh();return {close:()=>view.close(),refresh};
}
