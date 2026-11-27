// @ts-check
'use strict';
/** @typedef {{voice:import('./desktop-schema.cjs').VoiceOverlay,settings:import('./desktop-schema.cjs').OverlaySettings}} OverlayState */
/** @type {Window & typeof globalThis & {voiceOverlay:{onDelta:(callback:(state:import('./desktop-schema.cjs').VoiceOverlayDelta)=>void)=>()=>void,finishAdjustment:()=>Promise<void>,resize:(bounds:{width:number,height:number})=>Promise<void>,onState:(callback:(state:OverlayState)=>void)=>()=>void}}} */
const overlayGlobal = /** @type {typeof overlayGlobal} */ (window);
/** @param {string} id @returns {HTMLElement} */
function element(id) {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing overlay element: ${id}`);
  return result;
}
/** @type {import('./desktop-schema.cjs').OverlaySettings|null} */
let settings = null;
/** @type {Map<string,{row:HTMLLIElement,avatar:HTMLElement,label:Text,badge:HTMLElement,status:HTMLElement,profile:import('./desktop-schema.cjs').OverlayMember}>} */
const memberRows = new Map();

/** @param {import('./desktop-schema.cjs').VoiceOverlayDelta} voice @returns {void} */
function updateActivity(voice) {
  if (!settings) throw new Error('Overlay activity arrived before its snapshot');
  element('radio-title').hidden = !settings.showRadio || !voice.radioTitle;
  element('radio-title').textContent = voice.radioTitle || '';
  for (const member of voice.members) {
    const view = memberRows.get(member.id);
    if (!view) throw new Error('Overlay activity has no matching member');
    view.row.classList.toggle('speaking',member.speaking && !member.muted);
    const label = member.muted ? '静音' : member.speaking ? '发言' : '在线';
    if (view.status.textContent !== label) view.status.textContent = label;
    view.badge.hidden = !settings.showScreen || !member.screen;
  }
}

overlayGlobal.voiceOverlay.onState((state) => {
  settings = state.settings;
  document.body.className = settings.locked ? 'locked' : 'unlocked';
  document.documentElement.style.fontSize = String(settings.scale * 16) + 'px';
  element('overlay').style.zoom = String(settings.scale);
  element('edit-hint').hidden = settings.locked;
  element('resize-grip').hidden = settings.locked;
  const ids = new Set(state.voice.members.map(member=>member.id));
  for (const [id,view] of memberRows) if (!ids.has(id)) { view.row.remove(); memberRows.delete(id); }
  const list = element('members');
  state.voice.members.forEach((member,index) => {
    let view = memberRows.get(member.id);
    if (!view) {
      const row = document.createElement('li'); row.dataset.memberId = member.id;
      const avatar = document.createElement('span');
      const name = document.createElement('span'); name.className = 'name';
      const label = document.createTextNode(member.name);
      const badge = document.createElement('small'); badge.className = 'screen-badge'; badge.textContent = '投屏中';
      const status = document.createElement('span'); status.className = 'signal';
      name.append(label,badge); row.append(avatar,name,status);
      view = {row,avatar,label,badge,status,profile:{...member,avatar:null}};
      memberRows.set(member.id,view);
    }
    if (view.profile.avatar !== member.avatar || !view.avatar.classList.contains('avatar')) {
      const avatar = member.avatar ? document.createElement('img') : document.createElement('span');
      avatar.className = 'avatar';
      if (avatar instanceof HTMLImageElement && member.avatar) { avatar.src = member.avatar; avatar.alt = ''; }
      view.avatar.replaceWith(avatar); view.avatar = avatar;
    }
    if (!member.avatar) { view.avatar.textContent = member.name.slice(0,1); view.avatar.style.borderBottom = '2px solid '+member.color; }
    if (view.label.data !== member.name) view.label.data = member.name;
    view.profile = member;
    if (list.children[index] !== view.row) list.insertBefore(view.row,list.children[index] || null);
  });
  updateActivity({...state.voice,radioTitle:state.voice.radioTitle ?? null,members:state.voice.members.map(member=>({...member,screen:member.screen === true}))});
});
overlayGlobal.voiceOverlay.onDelta(updateActivity);

/** @param {Error} error @returns {void} */
function reportAdjustmentError(error) { element('adjustment-status').textContent = error.message; }
element('finish-adjustment').addEventListener('click', () => { void overlayGlobal.voiceOverlay.finishAdjustment().catch(reportAdjustmentError); });
/** @type {{x:number,y:number,width:number,height:number}|null} */
let resizeOrigin = null;
const grip = element('resize-grip');
grip.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  resizeOrigin = { x:event.screenX,y:event.screenY,width:window.innerWidth,height:window.innerHeight };
  grip.setPointerCapture(event.pointerId);
});
grip.addEventListener('pointermove', (event) => {
  if (!resizeOrigin) return;
  const bounds = { width:Math.max(180,Math.min(1200,Math.round(resizeOrigin.width + event.screenX - resizeOrigin.x))),height:Math.max(90,Math.min(1600,Math.round(resizeOrigin.height + event.screenY - resizeOrigin.y))) };
  void overlayGlobal.voiceOverlay.resize(bounds).catch(reportAdjustmentError);
});
grip.addEventListener('pointerup', () => { resizeOrigin = null; });
grip.addEventListener('lostpointercapture', () => { resizeOrigin = null; });
