// @ts-check
import {mediaObject} from './chat-protocol.js';

/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {{version:1,preset:'industrial'|'constructivist',motion:'full'|'reduced',navigation:'rail'|'index',memberPanel:'expanded'|'compact'}} InterfaceProfile */
/** @type {Readonly<Record<'industrial'|'constructivist',Readonly<InterfaceProfile>>>} */
export const INTERFACE_PRESETS = Object.freeze({
  industrial:Object.freeze({version:1,preset:'industrial',motion:'reduced',navigation:'rail',memberPanel:'expanded'}),
  constructivist:Object.freeze({version:1,preset:'constructivist',motion:'full',navigation:'index',memberPanel:'compact'}),
});

/** @param {JsonValue|undefined} value @returns {InterfaceProfile} */
export function parseInterfaceProfile(value) {
  const row=mediaObject(value,'Local interface profile');
  if(row.version!==1)throw new TypeError('Local interface profile requires version 1');
  if(row.preset!=='industrial' && row.preset!=='constructivist')throw new TypeError('Interface preset must be industrial or constructivist');
  if(row.motion!=='full' && row.motion!=='reduced')throw new TypeError('Interface motion must be full or reduced');
  if(row.navigation!=='rail' && row.navigation!=='index')throw new TypeError('Interface navigation must be rail or index');
  if(row.memberPanel!=='expanded' && row.memberPanel!=='compact')throw new TypeError('Interface member panel must be expanded or compact');
  return {version:1,preset:row.preset,motion:row.motion,navigation:row.navigation,memberPanel:row.memberPanel};
}

/** @param {InterfaceProfile} value @returns {void} */
export function applyInterfaceProfile(value) {
  const profile=parseInterfaceProfile(value),root=document.documentElement;
  if(root.dataset.interfacePreset===profile.preset && root.dataset.interfaceMotion===profile.motion && root.dataset.interfaceNavigation===profile.navigation && root.dataset.interfaceMembers===profile.memberPanel)return;
  root.dataset.interfacePreset=profile.preset;
  root.dataset.interfaceMotion=profile.motion;
  root.dataset.interfaceNavigation=profile.navigation;
  root.dataset.interfaceMembers=profile.memberPanel;
  document.dispatchEvent(new Event('interface-profile-change'));
}

/** @param {InterfaceProfile} initial @returns {()=>void} */
export function initInterfaceProfile(initial) {
  const root=document.documentElement,sidebar=document.querySelector('.sidebar'),topbar=document.querySelector('.topbar-left');
  const channelNode=document.getElementById('channelScroll'),titleNode=document.getElementById('topbarName');
  if(!(sidebar instanceof HTMLElement) || !(topbar instanceof HTMLElement) || !channelNode || !titleNode)throw new Error('Interface runtime requires sidebar, topbar, channelScroll and topbarName');
  const channels=channelNode,title=titleNode;
  if(document.getElementById('interfaceChannelIndex'))throw new Error('Interface runtime is already initialized');
  sidebar.id='interfaceChannelSidebar';
  const button=document.createElement('button');
  button.id='interfaceChannelIndex';button.type='button';button.className='interface-index-button';
  button.dataset.testid='interface-channel-index';button.textContent='频道目录';
  button.setAttribute('aria-controls',sidebar.id);button.setAttribute('aria-expanded','false');
  topbar.prepend(button);
  const signalController=new AbortController(),signal=signalController.signal;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)'),narrow=matchMedia('(max-width: 720px)');
  /** @type {Set<Animation>} */
  const animations=new Set();
  let lastChannel='';
  /** @returns {boolean} */
  function usesDisclosure(){return root.dataset.interfaceNavigation==='index' || narrow.matches;}
  /** @returns {void} */
  function stopMotion(){for(const animation of animations)animation.cancel();animations.clear();}
  /** @returns {void} */
  function animateHeader(){
    stopMotion();
    if(document.hidden || reduced.matches || root.dataset.interfaceMotion==='reduced' || root.dataset.interfacePreset!=='constructivist')return;
    const animation=title.animate([
      {transform:'translateX(4px) scale(0.97)',opacity:1,offset:0},
      {transform:'translateX(6px) scale(0.95)',opacity:1,offset:.14},
      {transform:'translateX(-14px) scale(1.06)',opacity:.72,offset:.18},
      {transform:'translateX(2px) scale(1.01)',opacity:1,offset:.76},
      {transform:'translateX(0) scale(1)',opacity:1,offset:1},
    ],{duration:280,easing:'cubic-bezier(.08,.98,.2,1)',fill:'none'});
    animations.add(animation);
    animation.onfinish=()=>animations.delete(animation);
  }
  /** @returns {void} */
  function closeIndex(){root.dataset.interfaceIndexOpen='false';button.setAttribute('aria-expanded','false');}
  /** @returns {void} */
  function openIndex(){
    root.dataset.interfaceIndexOpen='true';button.setAttribute('aria-expanded','true');
    const active=channels.querySelector('.channel.active') ?? channels.querySelector('.channel');
    if(active instanceof HTMLElement)active.focus();
    stopMotion();
    if(!reduced.matches && root.dataset.interfaceMotion==='full' && root.dataset.interfacePreset==='constructivist'){
      const animation=channels.animate([
        {transform:'translateX(4px)',opacity:.85,offset:0},
        {transform:'translateX(-18px)',opacity:.38,offset:.15},
        {transform:'translateX(0)',opacity:1,offset:1},
      ],{duration:240,easing:'steps(8,end)',fill:'none'});
      animations.add(animation);animation.onfinish=()=>animations.delete(animation);
    }
  }
  /** @returns {void} */
  function syncProfile(){
    stopMotion();closeIndex();button.hidden=!usesDisclosure();
    root.dataset.interfaceReduced=String(reduced.matches || root.dataset.interfaceMotion==='reduced');
    animateHeader();
  }
  button.addEventListener('click',()=>{if(button.getAttribute('aria-expanded')==='true')closeIndex();else openIndex();},{signal});
  document.addEventListener('pointerdown',event=>{
    if(event.target instanceof Node && !sidebar.contains(event.target) && !button.contains(event.target))closeIndex();
  },{signal});
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape' && button.getAttribute('aria-expanded')==='true'){closeIndex();button.focus();event.preventDefault();}
  },{signal});
  channels.addEventListener('keydown',event=>{
    if(!(event instanceof KeyboardEvent) || !['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    const rows=Array.from(channels.querySelectorAll('button.channel')).filter((row)=>row instanceof HTMLElement);
    const index=rows.findIndex(row=>row===document.activeElement);
    if(index<0 || rows.length===0)return;
    const next=event.key==='Home'?0:event.key==='End'?rows.length-1:(index+(event.key==='ArrowDown'?1:-1)+rows.length)%rows.length;
    rows[next].focus();event.preventDefault();
  },{signal});
  channels.addEventListener('click',event=>{
    const row=event.target instanceof Element?event.target.closest('[data-channel-id]'):null;
    if(row instanceof HTMLElement && row.dataset.channelType==='text' && usesDisclosure()){closeIndex();button.focus();}
  },{signal});
  const observer=new MutationObserver(()=>{
    const active=channels.querySelector('.channel.active');
    const id=active instanceof HTMLElement?active.dataset.channelId ?? '':'';
    if(id!==lastChannel){lastChannel=id;animateHeader();}
  });
  observer.observe(channels,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  document.addEventListener('interface-profile-change',syncProfile,{signal});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){stopMotion();closeIndex();}},{signal});
  window.addEventListener('pagehide',stopMotion,{signal});
  reduced.addEventListener('change',syncProfile,{signal});narrow.addEventListener('change',syncProfile,{signal});
  applyInterfaceProfile(initial);syncProfile();
  return ()=>{signalController.abort();observer.disconnect();stopMotion();closeIndex();button.remove();};
}
