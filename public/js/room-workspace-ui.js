// @ts-check
import {parseRadioConfig} from './radio-protocol.js';

/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {{[key:string]:JsonValue}} JsonObject */
/** @typedef {{ok:true}|{ok:false,error:string}} WorkspaceActionResult */
/** @typedef {{openConnectionPanel:(intent:'choose'|'create'|'join'|'workspace')=>Promise<WorkspaceActionResult>}} WorkspaceNavigationApi */
/** @typedef {import('../../lib/steam-state.cjs').RoomChannel} ConflictChannel */
/** @typedef {{id:string,name:string,icon:string,color:string,channels:ConflictChannel[]}} ConflictServer */
/** @typedef {{version:1,roomId:string,creatorKey:string,revision:number,servers:ConflictServer[],digest:string}} RoomConflictDocument */
/** @typedef {{roundId:string,candidates:RoomConflictDocument[],reason?:'creator-missing'|'no-majority'}} RoomConflict */
/** @typedef {{close:()=>void}} RoomConflictView */

/** @type {WeakMap<HTMLElement,()=>void>} */ const navigationInstallations = new WeakMap();

/** @param {string} tag @param {string} className @param {string} text @returns {HTMLElement} */
function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/** @param {Error} error @returns {void} */
function navigationError(error) {
  document.getElementById('workspaceNavigationError')?.remove();
  const panel = element('div', 'workspace-navigation-error', error.message);
  panel.id = 'workspaceNavigationError'; panel.setAttribute('role', 'alert');
  const close = element('button', '', '关闭');
  close.setAttribute('type', 'button');
  close.addEventListener('click', () => panel.remove());
  panel.append(close); document.body.append(panel);
}

/** @param {WorkspaceNavigationApi} desktopApi @returns {()=>void} */
export function installWorkspaceNavigation(desktopApi) {
  const railElement = document.getElementById('serverRail');
  const addElement = document.getElementById('addServerBtn');
  const brandElement = railElement?.querySelector('.rail-brand');
  if (!railElement || !(addElement instanceof HTMLButtonElement) || !(brandElement instanceof HTMLElement)) throw new Error('Workspace navigation requires the room rail, add button, and brand');
  const rail = railElement;
  const add = addElement;
  const brand = brandElement;
  navigationInstallations.get(rail)?.();
  const events = new AbortController();
  let pending = false;
  let disposed = false;
  const oldRole = brand.getAttribute('role');
  const oldTabIndex = brand.getAttribute('tabindex');
  const oldLabel = brand.getAttribute('aria-label');
  brand.setAttribute('role', 'button'); brand.tabIndex = 0;
  brand.setAttribute('aria-label', '切换或添加服务器');
  brand.title = '切换或添加服务器';
  add.title = '添加域'; add.setAttribute('aria-label', '添加域');
  rail.classList.add('workspace-navigation');
  const tip = element('div', 'workspace-rail-tooltip', '');
  tip.id = 'workspaceRailTooltip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true;
  document.body.append(tip);

  /** @param {'choose'|'workspace'} intent @returns {Promise<void>} */
  async function open(intent) {
    if (pending) return;
    pending = true; brand.setAttribute('aria-busy', 'true');
    try {
      const result = await desktopApi.openConnectionPanel(intent);
      if (!result || result.ok !== true) throw new Error(result && result.ok === false ? result.error : '连接面板没有返回有效结果');
    } catch (error) { if (!disposed) navigationError(error instanceof Error ? error : new Error(String(error))); }
    finally { pending = false; if (!disposed) brand.removeAttribute('aria-busy'); }
  }

  /** @returns {void} */
  function hideTooltip() { tip.hidden = true; }

  /** @param {Event} event @returns {void} */
  function showTooltip(event) {
    const target = event.target instanceof Element ? event.target.closest('.rail-item') : null;
    if (!(target instanceof HTMLElement) || !rail.contains(target)) { hideTooltip(); return; }
    const label = target.querySelector('.rail-tip')?.textContent || target.getAttribute('aria-label') || target.getAttribute('title');
    if (!label) return;
    tip.textContent = label; tip.hidden = false;
    const rect = target.getBoundingClientRect();
    const bounds = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(rect.right + 12, innerWidth - bounds.width - 8))}px`;
    tip.style.top = `${Math.max(8, Math.min(rect.top + (rect.height - bounds.height) / 2, innerHeight - bounds.height - 8))}px`;
  }

  brand.addEventListener('click', () => { void open('workspace'); }, { signal: events.signal });
  brand.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault(); void open('workspace');
  }, { signal: events.signal });
  rail.addEventListener('pointerover', showTooltip, { signal: events.signal });
  rail.addEventListener('focusin', showTooltip, { signal: events.signal });
  rail.addEventListener('pointerleave', hideTooltip, { signal: events.signal });
  rail.addEventListener('focusout', hideTooltip, { signal: events.signal });
  rail.addEventListener('scroll', hideTooltip, { signal: events.signal, capture: true });
  window.addEventListener('resize', hideTooltip, { signal: events.signal });

  /** @returns {void} */
  function cleanup() {
    disposed = true;
    events.abort(); tip.remove(); rail.classList.remove('workspace-navigation');
    if (oldRole === null) brand.removeAttribute('role'); else brand.setAttribute('role', oldRole);
    if (oldTabIndex === null) brand.removeAttribute('tabindex'); else brand.setAttribute('tabindex', oldTabIndex);
    if (oldLabel === null) brand.removeAttribute('aria-label'); else brand.setAttribute('aria-label', oldLabel);
    navigationInstallations.delete(rail);
  }
  navigationInstallations.set(rail, cleanup);
  return cleanup;
}

/** @param {JsonValue} value @param {string} label @returns {JsonObject} */
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

/** @param {JsonValue} value @param {string} label @param {number} maximum @returns {string} */
function text(value, label, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new TypeError(`${label} must be a nonempty string of at most ${maximum} characters`);
  return value;
}

/** @param {JsonValue} value @param {string} label @returns {number} */
function integer(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative safe integer`);
  return value;
}

/** @param {JsonValue} value @returns {ConflictChannel} */
function parseChannel(value) {
  const row = object(value, 'Conflict channel');
  if (row.type !== 'voice' && row.type !== 'text' && row.type !== 'radio') throw new TypeError('Conflict channel type must be voice, text or radio');
  const base={id:text(row.id,'Channel ID',80),name:text(row.name,'Channel name',20),userLimit:integer(row.userLimit,'Channel limit')};
  return row.type==='radio' ? {...base,type:'radio',radio:parseRadioConfig(row.radio)} : {...base,type:row.type};
}

/** @param {JsonValue} value @returns {ConflictServer} */
function parseServer(value) {
  const row = object(value, 'Conflict server');
  if (!Array.isArray(row.channels) || row.channels.length > 40) throw new TypeError('Conflict server must contain at most 40 channels');
  return { id: text(row.id, 'Server ID', 80), name: text(row.name, 'Server name', 20), icon: text(row.icon, 'Server icon', 16), color: text(row.color, 'Server color', 32), channels: row.channels.map(parseChannel) };
}

/** @param {JsonValue} value @returns {RoomConflictDocument} */
function parseCandidate(value) {
  const row = object(value, 'Conflict candidate');
  if (row.version !== 1) throw new TypeError('Conflict document version must be 1');
  if (!Array.isArray(row.servers) || row.servers.length > 12) throw new TypeError('Conflict candidate must contain at most 12 servers');
  const digest = text(row.digest, 'Candidate digest', 64);
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new TypeError('Conflict candidate digest must be a lowercase SHA256 value');
  return { version: 1, roomId: text(row.roomId, 'Room ID', 80), creatorKey: text(row.creatorKey, 'Creator key', 1024), revision: integer(row.revision, 'Revision'), servers: row.servers.map(parseServer), digest };
}

/** @param {RoomConflict} value @returns {RoomConflict} */
function parseConflict(value) {
  const row = object(value, 'Room conflict');
  if (!Array.isArray(row.candidates) || row.candidates.length < 1 || row.candidates.length > 24) throw new TypeError('Room conflict must contain 1–24 candidates');
  const candidates = row.candidates.map(parseCandidate);
  if (new Set(candidates.map(candidate => candidate.digest)).size !== candidates.length) throw new TypeError('Room conflict contains duplicate candidate digests');
  if (new Set(candidates.map(candidate => candidate.roomId)).size !== 1) throw new TypeError('Room conflict candidates must belong to the same room');
  if (row.reason !== undefined && row.reason !== 'creator-missing' && row.reason !== 'no-majority') throw new TypeError('Room conflict reason is not supported');
  return { roundId: text(row.roundId, 'Conflict round ID', 256), candidates, ...(row.reason === undefined ? {} : { reason: row.reason }) };
}

/** @param {RoomConflict} value @param {(digest:string)=>Promise<void>|void} onChoose @returns {RoomConflictView} */
export function showRoomConflict(value, onChoose) {
  const conflict = parseConflict(value);
  const root = document.getElementById('modalRoot');
  if (!root) throw new Error('Room conflict selection requires modalRoot');
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'modal room-conflict-dialog'; dialog.id = 'roomConflictDialog';
  dialog.setAttribute('aria-labelledby', 'roomConflictTitle');
  dialog.setAttribute('aria-describedby', 'roomConflictDescription');
  const header = element('header', 'modal-head', '');
  const title = element('h2', '', '频道布局出现不同版本'); title.id = 'roomConflictTitle';
  const closeButton = element('button', 'icon-btn modal-close', '×'); closeButton.setAttribute('aria-label', '暂不选择');
  header.append(title, closeButton);
  const body = element('div', 'modal-body', '');
  const explanation = conflict.reason === 'creator-missing' ? '创建者尚未提供本轮有效的频道副本，请等待创建者核对；只有创建者能在此状态下确认布局。可暂不选择，保留本机记录。' : conflict.candidates.length === 1 ? '本轮只有这一份候选，但仍需要明确确认后才能使用。请检查域与频道名称；暂不选择会保留本机记录。' : '比较各版本的域与频道名称，再选择要使用的布局。青色标记表示该频道与其他候选存在差异；没有版本会被自动选中。';
  const description = element('p', 'room-conflict-description', explanation);
  description.id = 'roomConflictDescription';
  const candidates = element('div', 'room-conflict-candidates', '');
  const errorPanel = element('p', 'room-conflict-error', ''); errorPanel.setAttribute('role', 'alert'); errorPanel.hidden = true;
  /** @type {HTMLButtonElement[]} */ const buttons = [];
  let pending = false;
  let closed = false;

  /** @returns {void} */
  function close() {
    if (closed) return;
    closed = true; dialog.close(); dialog.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
  }

  for (const [index, candidate] of conflict.candidates.entries()) {
    const card = element('section', 'room-conflict-candidate', '');
    card.dataset.digest = candidate.digest;
    card.append(element('h3', '', `版本 ${index + 1}`), element('p', 'room-conflict-meta', `修订 ${candidate.revision} · ${candidate.digest.slice(0, 12)}`));
    for (const server of candidate.servers) {
      const section = element('div', 'room-conflict-server', '');
      section.append(element('h4', '', server.name));
      const channels = element('ul', 'room-conflict-channels', '');
      for (const channel of server.channels) {
        const differs = conflict.candidates.some(other => {
          const otherServer = other.servers.find(item => item.id === server.id);
          const otherChannel = otherServer?.channels.find(item => item.id === channel.id);
          return !otherServer || otherServer.name !== server.name || !otherChannel || otherChannel.name !== channel.name || otherChannel.type !== channel.type || otherChannel.userLimit !== channel.userLimit || channel.type==='radio' && otherChannel.type==='radio' && JSON.stringify(otherChannel.radio)!==JSON.stringify(channel.radio);
        });
        const label = `${channel.type === 'radio' ? '电台 ·' : channel.type === 'voice' ? '语音 ·' : '#'} ${channel.name}${channel.type !== 'text' && channel.userLimit ? ` · 上限 ${channel.userLimit} 人` : ''}`;
        channels.append(element('li', differs ? 'different' : '', label));
      }
      if (!server.channels.length) channels.append(element('li', '', '没有频道'));
      section.append(channels); card.append(section);
    }
    if (!candidate.servers.length) card.append(element('p', 'room-conflict-note', '此版本没有域或频道。'));
    const button = document.createElement('button');
    button.className = 'btn primary'; button.textContent = `使用版本 ${index + 1}`;
    button.id = `chooseRoomConflict${index + 1}`; button.dataset.digest = candidate.digest;
    buttons.push(button);
    button.addEventListener('click', async () => {
      if (pending || closed) return;
      pending = true; errorPanel.hidden = true; closeButton.setAttribute('disabled', '');
      for (const item of buttons) item.disabled = true;
      dialog.setAttribute('aria-busy', 'true');
      try { await onChoose(candidate.digest); close(); }
      catch (error) {
        if (!closed) { errorPanel.hidden = false; errorPanel.textContent = error instanceof Error ? error.message : String(error); }
      } finally {
        pending = false;
        closeButton.removeAttribute('disabled');
        for (const item of buttons) item.disabled = false;
        dialog.setAttribute('aria-busy', 'false');
      }
    });
    card.append(button); candidates.append(card);
  }
  body.append(description, candidates, errorPanel);
  dialog.append(header, body); root.append(dialog);
  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!pending) close(); });
  dialog.showModal(); closeButton.focus();
  return { close };
}
