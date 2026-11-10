// @ts-check
'use strict';
/** @typedef {{voice:import('./desktop-schema.cjs').VoiceOverlay,settings:import('./desktop-schema.cjs').OverlaySettings}} OverlayState */
/** @type {Window & typeof globalThis & {voiceOverlay:{finishAdjustment:()=>Promise<void>,resize:(bounds:{width:number,height:number})=>Promise<void>,onState:(callback:(state:OverlayState)=>void)=>()=>void}}} */
const overlayGlobal = /** @type {typeof overlayGlobal} */ (window);
/** @param {string} id @returns {HTMLElement} */
function element(id) {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing overlay element: ${id}`);
  return result;
}
overlayGlobal.voiceOverlay.onState((state) => {
  document.body.className = state.settings.locked ? 'locked' : 'unlocked';
  document.documentElement.style.fontSize = `${state.settings.scale * 16}px`;
  element('overlay').style.zoom = String(state.settings.scale);
  element('edit-hint').hidden = state.settings.locked;
  element('resize-grip').hidden = state.settings.locked;
  const rows = state.voice.members.map((member) => {
    const row = document.createElement('li');
    row.dataset.memberId = member.id;
    row.className = member.speaking && !member.muted ? 'speaking' : '';
    const avatar = member.avatar ? document.createElement('img') : document.createElement('span');
    avatar.className = 'avatar';
    if (avatar instanceof HTMLImageElement && member.avatar) { avatar.src = member.avatar; avatar.alt = ''; }
    else { avatar.textContent = member.name.slice(0, 1); avatar.style.borderBottom = `2px solid ${member.color}`; }
    const name = document.createElement('span');
    name.className = 'name'; name.textContent = member.name;
    const status = document.createElement('span');
    status.className = 'signal'; status.textContent = member.muted ? '静音' : member.speaking ? '发言' : '在线';
    row.append(avatar, name, status);
    return row;
  });
  element('members').replaceChildren(...rows);
});

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
