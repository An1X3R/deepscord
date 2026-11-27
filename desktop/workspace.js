// @ts-check
import {loadLocalInterface} from './local-interface.js';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{[key:string]:JsonValue}} JsonObject */
/** @typedef {{id:string,name:string,type:'voice'|'text'|'radio',userLimit:number}} SavedChannel */
/** @typedef {{id:string,name:string,channels:SavedChannel[]}} SavedServer */
/** @typedef {{id:string,roomId:string|null,name:string,mode:'steam'|'direct'|'server',role:'host'|'guest',updatedAt:number,servers:SavedServer[],conflicts:number}} SavedEntry */
/** @typedef {{entries:SavedEntry[],activeEntryId:string|null}} WorkspaceSnapshot */
/** @typedef {{ok:true}|{ok:false,error:string,cancelled?:true}} MutationResult */
/** @typedef {{getWorkspace:()=>Promise<JsonValue>,openConnectionPanel:(intent:'choose'|'create'|'join'|'workspace')=>Promise<MutationResult>,selectSavedRoom:(entryId:string)=>Promise<MutationResult>,reopenSavedRoom:(entryId:string)=>Promise<MutationResult>,removeSavedRoom:(entryId:string)=>Promise<MutationResult>}} WorkspaceApi */

/** @param {string} id @returns {HTMLElement} */
function requiredElement(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Workspace element is missing: ${id}`);
  return node;
}

/** @param {JsonValue} value @param {string} label @returns {JsonObject} */
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

/** @param {JsonValue} value @param {string} label @returns {string} */
function text(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) throw new TypeError(`${label} must be a nonempty string of at most 1024 characters`);
  return value;
}

/** @param {JsonValue} value @param {string} label @returns {number} */
function integer(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative safe integer`);
  return value;
}

/** @param {JsonValue} value @returns {SavedChannel} */
function parseChannel(value) {
  const row = record(value, 'Saved channel');
  if (row.type !== 'voice' && row.type !== 'text' && row.type !== 'radio') throw new TypeError('Saved channel type must be voice, text or radio');
  return { id: text(row.id, 'Channel ID'), name: text(row.name, 'Channel name'), type: row.type, userLimit: integer(row.userLimit, 'Channel limit') };
}

/** @param {JsonValue} value @returns {SavedServer} */
function parseServer(value) {
  const row = record(value, 'Saved server');
  if (!Array.isArray(row.channels) || row.channels.length > 1024) throw new TypeError('Saved server channels must be an array of at most 1024 entries');
  return { id: text(row.id, 'Server ID'), name: text(row.name, 'Server name'), channels: row.channels.map(parseChannel) };
}

/** @param {JsonValue} value @returns {SavedEntry} */
function parseEntry(value) {
  const row = record(value, 'Saved room');
  if (row.mode !== 'steam' && row.mode !== 'direct' && row.mode !== 'server') throw new TypeError('Saved room mode must be steam, direct, or server');
  if (row.role !== 'host' && row.role !== 'guest') throw new TypeError('Saved room role must be host or guest');
  if (!Array.isArray(row.servers) || row.servers.length > 1024) throw new TypeError('Saved room servers must be an array of at most 1024 entries');
  return { id: text(row.id, 'Entry ID'), roomId: row.roomId === null ? null : text(row.roomId, 'Room ID'), name: text(row.name, 'Room name'), mode: row.mode, role: row.role, updatedAt: integer(row.updatedAt, 'Update timestamp'), servers: row.servers.map(parseServer), conflicts: integer(row.conflicts, 'Conflict count') };
}

/** @param {JsonValue} value @returns {WorkspaceSnapshot} */
function parseWorkspace(value) {
  const row = record(value, 'Workspace');
  if (!Array.isArray(row.entries) || row.entries.length > 1024) throw new TypeError('Workspace entries must be an array of at most 1024 records');
  const entries = row.entries.map(parseEntry);
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new TypeError('Workspace contains duplicate entry IDs');
  const activeEntryId = row.activeEntryId === null ? null : text(row.activeEntryId, 'Active entry ID');
  if (activeEntryId !== null && !entries.some(entry => entry.id === activeEntryId)) throw new TypeError('Active workspace entry is missing from saved records');
  return { entries, activeEntryId };
}

/** @param {SavedEntry['mode']} mode @returns {string} */
function modeName(mode) { return { steam: 'Steam', direct: '独立直连', server: '自建服务' }[mode]; }

/** @param {string} tag @param {string} className @param {string} content @returns {HTMLElement} */
function node(tag, className, content) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = content;
  return element;
}

/** @param {JsonValue} value @returns {'success'|'cancelled'} */
function parseActionOutcome(value) {
  const row = record(value, 'Workspace operation');
  if (row.ok === true) return 'success';
  if (row.ok !== false || typeof row.error !== 'string' || !row.error) throw new TypeError('桌面操作没有返回有效结果');
  if (row.cancelled === true) return 'cancelled';
  if (row.cancelled !== undefined && row.cancelled !== false) throw new TypeError('桌面操作返回了无效的取消状态');
  throw new Error(row.error);
}

/** @param {WorkspaceApi} api @returns {Promise<void>} */
async function startWorkspace(api) {
  await loadLocalInterface(/** @type {WorkspaceApi & import('./local-interface.js').LocalInterfaceApi} */ (api));
  /** @type {WorkspaceSnapshot} */ let snapshot = { entries: [], activeEntryId: null };
  /** @type {string|null} */ let selectedId = null;
  let busy = false;
  const errorPanel = requiredElement('workspaceError');
  const status = requiredElement('workspaceStatus');

  /** @param {JsonValue} result @returns {boolean} */
  function completed(result) {
    if (parseActionOutcome(result) === 'success') return true;
    errorPanel.hidden = true;
    status.textContent = '已取消切换，当前房间保持连接。';
    return false;
  }

  /** @param {Error|string} error @returns {void} */
  function showError(error) {
    errorPanel.textContent = error instanceof Error ? error.message : error;
    errorPanel.hidden = false;
    status.textContent = '操作失败，请检查上方说明。';
  }

  /** @returns {SavedEntry|null} */
  function selectedEntry() { return snapshot.entries.find(entry => entry.id === selectedId) || null; }

  /** @returns {void} */
  function renderDetail() {
    const entry = selectedEntry();
    requiredElement('workspaceEmpty').hidden = snapshot.entries.length > 0;
    requiredElement('savedRoomDetail').hidden = !entry;
    if (!entry) return;
    requiredElement('workspaceBreadcrumb').textContent = entry.name;
    requiredElement('savedRoomTitle').textContent = entry.name;
    requiredElement('savedRoomMode').textContent = `${modeName(entry.mode)} · ${entry.role === 'host' ? '本机创建' : '已加入'}`;
    requiredElement('savedRoomUpdated').textContent = `上次保存 ${new Date(entry.updatedAt).toLocaleString('zh-CN')} · 不代表房间当前在线`;
    const canReopen = entry.mode === 'steam' ? entry.roomId !== null && entry.servers.length > 0 : entry.mode === 'direct' && entry.role === 'host';
    requiredElement('reopenSavedRoomBtn').hidden = !canReopen;
    const conflict = requiredElement('savedRoomConflicts');
    conflict.hidden = entry.conflicts === 0;
    conflict.textContent = `有 ${entry.conflicts} 份频道布局需要确认；进入房间后手动选择。`;
    const outline = requiredElement('savedChannelOutline');
    outline.replaceChildren();
    if (!entry.servers.length) outline.append(node('p', 'subtle', '此记录尚未保存频道布局，连接成功后会更新。'));
    for (const server of entry.servers) {
      const section = node('section', 'outline-server', '');
      section.append(node('h3', '', server.name));
      if (!server.channels.length) section.append(node('p', 'subtle', '未保存频道。'));
      for (const channel of server.channels) {
        const row = node('div', 'outline-channel', '');
        row.append(node('span', 'outline-channel-symbol', channel.type === 'radio' ? '♫' : channel.type === 'voice' ? '◖' : '#'), node('span', '', channel.name));
        if (channel.type !== 'text') row.append(node('span', 'outline-channel-limit', channel.userLimit ? `上限 ${channel.userLimit} 人` : '不限人数'));
        section.append(row);
      }
      outline.append(section);
    }
  }

  /** @returns {void} */
  function renderList() {
    const rail = requiredElement('savedRoomRail');
    const list = requiredElement('savedRoomList');
    rail.replaceChildren(); list.replaceChildren();
    requiredElement('savedRoomCount').textContent = String(snapshot.entries.length);
    for (const entry of snapshot.entries) {
      const active = entry.id === selectedId;
      const icon = node('button', `saved-room-icon${active ? ' active' : ''}`, Array.from(entry.name).slice(0, 2).join(''));
      icon.dataset.entryId = entry.id;
      icon.setAttribute('aria-label', `连接 ${entry.name}`);
      icon.setAttribute('title', `${entry.name} · ${modeName(entry.mode)}`);
      icon.addEventListener('click', () => { void connectEntry(entry.id); });
      rail.append(icon);
      const row = node('div', `saved-room-row${active ? ' active' : ''}`, '');
      const button = node('button', 'saved-room-select', '');
      button.dataset.entryId = entry.id;
      button.append(node('strong', '', entry.name), node('span', '', `${modeName(entry.mode)} · ${entry.servers.reduce((count, server) => count + server.channels.length, 0)} 个已存频道`));
      button.setAttribute('aria-label', `连接 ${entry.name}`);
      button.addEventListener('click', () => { void connectEntry(entry.id); });
      const preview = node('button', 'saved-room-preview', '查看');
      preview.setAttribute('aria-label', `查看 ${entry.name} 的离线频道`);
      preview.addEventListener('click', () => { selectedId = entry.id; render(); });
      row.append(button, preview); list.append(row);
    }
    if (!snapshot.entries.length) list.append(node('p', 'subtle', '还没有保存的服务器。'));
  }

  /** @returns {void} */
  function render() { renderList(); renderDetail(); }

  /** @returns {Promise<void>} */
  async function reload() {
    snapshot = parseWorkspace(await api.getWorkspace());
    if (!snapshot.entries.some(entry => entry.id === selectedId)) selectedId = snapshot.activeEntryId || snapshot.entries[0]?.id || null;
    render();
    requiredElement('workspaceLoading').hidden = true;
  }

  /** @param {()=>Promise<void>} operation @returns {Promise<void>} */
  async function perform(operation) {
    if (busy) return;
    busy = true;
    errorPanel.hidden = true;
    document.body.setAttribute('aria-busy', 'true');
    for (const button of document.querySelectorAll('button')) button.disabled = true;
    try { await operation(); }
    catch (error) { showError(error instanceof Error ? error : String(error)); }
    finally {
      busy = false;
      document.body.setAttribute('aria-busy', 'false');
      for (const button of document.querySelectorAll('button')) button.disabled = false;
      requiredElement('workspaceLoading').hidden = true;
    }
  }

  /** @param {string} entryId @returns {Promise<void>} */
  async function connectEntry(entryId) {
    await perform(async () => {
      selectedId = entryId; render();
      status.textContent = '正在连接所选服务器…';
      if (!completed(await api.selectSavedRoom(entryId))) return;
      status.textContent = '已发起连接。';
    });
  }

  /** @param {'choose'|'create'|'join'} intent @returns {void} */
  function openPanel(intent) { void perform(async () => { if (!completed(await api.openConnectionPanel(intent))) return; status.textContent = '连接面板已打开。'; }); }

  requiredElement('workspaceAddBtn').addEventListener('click', () => openPanel('choose'));
  requiredElement('emptyCreateBtn').addEventListener('click', () => openPanel('create'));
  requiredElement('emptyJoinBtn').addEventListener('click', () => openPanel('join'));
  requiredElement('workspaceHomeBtn').addEventListener('click', () => { void perform(reload); });
  requiredElement('refreshWorkspaceBtn').addEventListener('click', () => { void perform(async () => { await reload(); status.textContent = '本地记录已刷新。'; }); });
  requiredElement('connectSavedRoomBtn').addEventListener('click', () => { const entry = selectedEntry(); if (entry) void connectEntry(entry.id); });
  requiredElement('reopenSavedRoomBtn').addEventListener('click', () => {
    const entry = selectedEntry();
    if (!entry || !window.confirm(`用「${entry.name}」已保存的频道布局重新开房？这会创建新房间，需要重新发送邀请。`)) return;
    void perform(async () => { if (!completed(await api.reopenSavedRoom(entry.id))) return; status.textContent = '新房间已创建，请使用新的邀请。'; await reload(); });
  });
  requiredElement('removeSavedRoomBtn').addEventListener('click', () => {
    const entry = selectedEntry();
    if (!entry || !window.confirm(`移除「${entry.name}」的本地记录和离线频道？此操作不会删除远端服务器。`)) return;
    void perform(async () => { if (!completed(await api.removeSavedRoom(entry.id))) return; await reload(); status.textContent = '本地记录已移除。'; });
  });
  await perform(reload);
  const startupError=new URLSearchParams(window.location.search).get('error');
  if(startupError) showError(startupError);
  window.addEventListener('focus', () => {
    if (busy) return;
    const currentError=errorPanel.hidden ? '' : errorPanel.textContent;
    void perform(async () => { await reload();if(currentError) showError(currentError); });
  });
}

const desktopApi = /** @type {Window & {deepscord?:WorkspaceApi}} */ (window).deepscord;
if (!desktopApi) {
  document.documentElement.dataset.localInterface='ready';
  requiredElement('workspaceLoading').hidden = true;
  requiredElement('workspaceError').hidden = false;
  requiredElement('workspaceError').textContent = '桌面连接接口未加载，请从 Deepscord 客户端打开工作区。';
} else {
  void startWorkspace(desktopApi).catch(error => {
    requiredElement('workspaceError').hidden = false;
    requiredElement('workspaceError').textContent = error instanceof Error ? error.message : String(error);
  });
}

export {};
