// @ts-check
import { createPokeMarker, getVideoContentRect } from './poke-visual.js';

/** @typedef {import('./screen-poke.js').PokeState} PokeState */
/** @typedef {import('./screen-poke.js').PokeHit} PokeHit */
/** @typedef {{enabled:boolean,volume:number}} PokeAudioState */
/** @typedef {{getState:()=>PokeState,request:(id:string)=>void,respond:(id:string,requestId:string,approved:boolean)=>void,revoke:(id:string)=>void,revokeAll:()=>void,hit:(id:string,nx:number,ny:number,boom:boolean)=>void,getName:(id:string)=>string,getAudio:()=>PokeAudioState,setAudio:(state:PokeAudioState)=>void}} PokeCallbacks */
/** @typedef {{shell:HTMLDivElement,video:HTMLVideoElement,local:boolean}} PokeView */

/** @param {string} label @param {string} testId @returns {HTMLButtonElement} */
function control(label, testId) {
  const node = document.createElement('button'); node.type = 'button'; node.className = 'btn ghost small';
  node.textContent = label; node.dataset.testid = testId;
  return node;
}

/** @param {PokeCallbacks} callbacks @param {HTMLElement} toolbar */
export function createPokeUI(callbacks, toolbar) {
  const panel = document.createElement('div'); panel.className = 'poke-permissions'; panel.dataset.testid = 'poke-permissions';
  panel.setAttribute('aria-label', '屏幕指点权限');
  const requests = document.createElement('div'); requests.className = 'poke-requests'; requests.dataset.testid = 'poke-requests'; requests.setAttribute('aria-live', 'polite'); requests.setAttribute('aria-label', '待处理的屏幕指点申请'); requests.hidden = true;
  document.body.append(requests);
  /** @type {Map<string,{row:HTMLDivElement,name:HTMLElement,approve:HTMLButtonElement}>} */
  const requestCards = new Map();
  const nativeRequests = typeof (/** @type {Window & {deepscord?:{updateScreenPokeRequests?:(input:object)=>Promise<void>}}} */ (window).deepscord?.updateScreenPokeRequests) === 'function';
  const grants = document.createElement('div'); grants.className = 'poke-grants';
  const revokeAll = control('全部收回', 'poke-revoke-all'); revokeAll.addEventListener('click', callbacks.revokeAll);
  const receive = control('', 'poke-audio-toggle');
  const audioLabel = document.createElement('label'); audioLabel.className = 'poke-audio-volume';
  const audioText = document.createElement('span');
  const volume = document.createElement('input'); volume.type = 'range'; volume.min = '0'; volume.max = '100'; volume.step = '1';
  volume.dataset.testid = 'poke-audio-volume'; volume.setAttribute('aria-label', '接收指点音效音量');
  receive.addEventListener('click', () => { const audio = callbacks.getAudio(); callbacks.setAudio({ enabled: !audio.enabled, volume: audio.volume }); reconcile(); });
  volume.addEventListener('input', () => { callbacks.setAudio({ enabled: callbacks.getAudio().enabled, volume: Number(volume.value) }); reconcile(); });
  audioLabel.append(audioText, volume); panel.append(receive, audioLabel, grants, revokeAll); toolbar.append(panel);
  /** @type {Map<string,{view:PokeView,controls:HTMLSpanElement,request:HTMLButtonElement,mode:HTMLButtonElement,sound:HTMLButtonElement,layer:HTMLDivElement,active:boolean,boom:boolean,expanded:boolean,sessionId:string|null,markers:Map<string,{node:HTMLDivElement,timer:ReturnType<typeof setTimeout>}>,click:(event:MouseEvent)=>void}>} */
  const views = new Map();
  let permissionSignature = '';

  /** @param {string} id @param {PokeView} view @param {HTMLElement} controls */
  function attach(id, view, controls) {
    const group = document.createElement('span'); group.className = 'poke-controls'; group.hidden = true;
    const request = control('申请指点', 'poke-request');
    const mode = control('指点模式', 'poke-mode-toggle'); mode.setAttribute('aria-pressed', 'false');
    const sound = control('发送音效: 开', 'poke-sound-toggle'); sound.setAttribute('aria-pressed', 'true');
    sound.title = '这次指点是否附带音效；每个接收者可自行静音';
    group.append(request, mode, sound); controls.append(group);
    const layer = document.createElement('div'); layer.className = 'poke-overlay-layer'; layer.setAttribute('aria-hidden', 'true'); view.shell.append(layer);
    /** @param {MouseEvent} event */
    function click(event) {
      const current = views.get(id);
      if (!current?.active || !view.shell.classList.contains('media-expanded') || view.local) return;
      const peer = callbacks.getState().peers.find(item => item.userId === id);
      if (peer?.status !== 'approved' || !peer.supported) return;
      const rect = getVideoContentRect(view.video); if (!rect) return;
      const nx = (event.clientX - rect.left) / rect.width; const ny = (event.clientY - rect.top) / rect.height;
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
      event.preventDefault(); callbacks.hit(id, nx, ny, current.boom);
    }
    const entry = { view, controls: group, request, mode, sound, layer, active: false, boom: true, expanded: false, sessionId: /** @type {string|null} */ (null), markers: /** @type {Map<string,{node:HTMLDivElement,timer:ReturnType<typeof setTimeout>}>} */ (new Map()), click };
    views.set(id, entry); view.video.addEventListener('click', click);
    request.addEventListener('click', () => { callbacks.request(id); reconcile(); });
    mode.addEventListener('click', () => { entry.active = !entry.active; reconcile(); });
    sound.addEventListener('click', () => { entry.boom = !entry.boom; reconcile(); });
    reconcile();
  }

  /** @param {string} id */
  function clear(id) {
    const entry = views.get(id); if (!entry) return;
    for (const marker of entry.markers.values()) { clearTimeout(marker.timer); marker.node.remove(); }
    entry.markers.clear();
  }

  function reconcile() {
    if (panel.parentElement !== toolbar) toolbar.append(panel);
    if (!requests.isConnected) document.body.append(requests);
    const state = callbacks.getState(); const audio = callbacks.getAudio();
    receive.textContent = `接收指点音效: ${audio.enabled ? '开' : '关'}`; receive.setAttribute('aria-pressed', String(audio.enabled));
    volume.value = String(audio.volume); volume.disabled = !audio.enabled; audioText.textContent = `音量 ${audio.volume}%`;
    const signature = JSON.stringify({ sessionId: state.sessionId, requests: state.requests, authorized: state.authorized, names: [...state.requests, ...state.authorized].map(item => callbacks.getName(item.userId)) });
    if (signature !== permissionSignature) {
      permissionSignature = signature; grants.replaceChildren();
      const currentRequests = new Set(state.requests.map(item => `${state.sessionId}:${item.requestId}`));
      for (const [key, card] of requestCards) if (!currentRequests.has(key)) { card.row.remove(); requestCards.delete(key); }
      for (const item of state.requests) {
        const key = `${state.sessionId}:${item.requestId}`;
        let card = requestCards.get(key);
        if (!card) {
          const row = document.createElement('div'); row.className = 'poke-permission-row'; row.dataset.userId = item.userId; row.dataset.testid = 'poke-request-toast'; row.setAttribute('role', 'group'); row.setAttribute('aria-label', '屏幕指点申请');
          const heading = document.createElement('div'); heading.className = 'poke-request-heading'; heading.textContent = '👆 屏幕指点申请';
          const name = document.createElement('strong'); name.className = 'poke-request-name';
          const description = document.createElement('p'); description.textContent = '希望在你的共享画面上指点';
          const actions = document.createElement('div'); actions.className = 'poke-request-actions';
          const approve = control('接受', 'poke-approve');
          const reject = control('拒绝', 'poke-reject');
          approve.addEventListener('click', () => { callbacks.respond(item.userId, item.requestId, true); reconcile(); });
          reject.addEventListener('click', () => { callbacks.respond(item.userId, item.requestId, false); reconcile(); });
          actions.append(reject, approve); row.append(heading, name, description, actions); requests.append(row);
          card = { row, name, approve }; requestCards.set(key, card);
        }
        card.name.textContent = callbacks.getName(item.userId);
        const approve = card.approve; approve.disabled = state.authorized.length >= 3;
        approve.title = approve.disabled ? '最多同时允许 3 人指点，请先收回已有权限' : '允许对方在共享画面上指点';
      }
      for (const item of state.authorized) {
        const revoke = control(`收回 ${callbacks.getName(item.userId)} 的指点权限`, 'poke-revoke'); revoke.dataset.userId = item.userId;
        revoke.addEventListener('click', () => { callbacks.revoke(item.userId); reconcile(); }); grants.append(revoke);
      }
    }
    requests.hidden = nativeRequests || !state.requests.length; grants.hidden = !state.authorized.length;
    revokeAll.hidden = !state.authorized.length; revokeAll.textContent = `全部收回 (${state.authorized.length}/3)`;
    for (const [id, entry] of views) {
      const peer = state.peers.find(item => item.userId === id);
      const sessionId = entry.view.local ? state.sessionId : peer?.sessionId ?? null;
      const expanded = entry.view.shell.classList.contains('media-expanded');
      if (entry.sessionId !== sessionId || entry.expanded !== expanded || entry.view.shell.hidden || entry.view.video.hidden) clear(id);
      if (entry.sessionId !== sessionId) entry.active = false;
      entry.sessionId = sessionId;
      entry.expanded = expanded;
      const visible = !entry.view.local && expanded && !entry.view.shell.hidden;
      if (!visible || peer?.status !== 'approved' || !peer.supported) entry.active = false;
      entry.controls.hidden = !visible;
      entry.request.hidden = peer?.status === 'approved';
      entry.request.disabled = !peer?.supported || !peer.sessionId || peer.status === 'pending';
      entry.request.textContent = !peer?.supported ? '对方暂不支持指点' : peer.status === 'pending' ? '等待同意…' : '申请指点';
      entry.mode.hidden = peer?.status !== 'approved'; entry.sound.hidden = peer?.status !== 'approved';
      entry.mode.textContent = entry.active ? '退出指点' : '指点模式'; entry.mode.setAttribute('aria-pressed', String(entry.active));
      entry.mode.classList.toggle('active', entry.active); entry.view.shell.classList.toggle('poke-mode-active', entry.active);
      entry.sound.textContent = `发送音效: ${entry.boom ? '开' : '关'}`; entry.sound.setAttribute('aria-pressed', String(entry.boom));
    }
  }

  /** @param {PokeHit} hit */
  function show(hit) {
    const entry = views.get(hit.targetUserId);
    if (!entry || entry.view.shell.hidden || entry.view.video.hidden || !entry.view.video.srcObject || entry.sessionId !== hit.sessionId) return;
    const rect = getVideoContentRect(entry.view.video); if (!rect) return;
    const box = entry.layer.getBoundingClientRect();
    const previous = entry.markers.get(hit.fromUserId);
    if (previous) { clearTimeout(previous.timer); previous.node.remove(); }
    if (!previous && entry.markers.size >= 3) return;
    const node = createPokeMarker(hit, callbacks.getName(hit.fromUserId));
    node.style.left = `${rect.left - box.left + hit.nx * rect.width}px`; node.style.top = `${rect.top - box.top + hit.ny * rect.height}px`;
    entry.layer.append(node);
    const timer = setTimeout(() => { node.remove(); entry.markers.delete(hit.fromUserId); }, 1600);
    entry.markers.set(hit.fromUserId, { node, timer });
  }

  /** @param {string} id */
  function remove(id) {
    const entry = views.get(id); if (!entry) return;
    clear(id); entry.view.video.removeEventListener('click', entry.click); entry.controls.remove(); entry.layer.remove(); views.delete(id);
  }
  function destroy() { for (const id of views.keys()) remove(id); panel.remove(); requests.remove(); requests.replaceChildren(); requestCards.clear(); permissionSignature = ''; }
  return { attach, reconcile, show, clear, remove, destroy };
}
