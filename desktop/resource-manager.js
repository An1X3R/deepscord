// @ts-check
/** @typedef {'interfaces'|'interactions'|'stickers'} ResourceKind */
/** @typedef {{id:string,name:string,version:string,kind:ResourceKind,entryCount:number,bytes:number,serverIds:string[],active:boolean,source:'package'|'legacy',pendingRemoval?:boolean}} ResourcePack */
/** @typedef {{root:string,currentServer:{id:string,name:string}|null,packs:ResourcePack[],personal:{count:number,bytes:number,directory:string}}} ResourceState */
/** @typedef {{getState:()=>Promise<ResourceState>,installArchive:()=>Promise<ResourceState|null>,installDirectory:()=>Promise<ResourceState|null>,removePack:(id:string)=>Promise<ResourceState>,bindServer:(id:string)=>Promise<ResourceState>,openRoot:()=>Promise<void>,openPack:(id:string)=>Promise<void>}} ResourceManagerBridge */

/** @param {string} id @returns {HTMLElement} */
function element(id) {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Resource manager element missing: ${id}`);
  return result;
}

/** @param {string} id @returns {HTMLButtonElement} */
function buttonElement(id) {
  const result = element(id);
  if (!(result instanceof HTMLButtonElement)) throw new TypeError(`Resource manager button missing: ${id}`);
  return result;
}

/** @param {number} bytes @returns {string} */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** @param {number} value @returns {boolean} */
function validCount(value) { return Number.isSafeInteger(value) && value >= 0; }

/** @param {ResourceState} state @returns {ResourceState} */
function validateState(state) {
  if (!state || typeof state.root !== 'string' || !state.root || !Array.isArray(state.packs) || !state.personal ||
      !validCount(state.personal.count) || !validCount(state.personal.bytes) || typeof state.personal.directory !== 'string') {
    throw new TypeError('本机资源状态格式错误：缺少目录、资源列表或个人表情统计。');
  }
  if (state.currentServer !== null && (!state.currentServer || typeof state.currentServer.id !== 'string' || !state.currentServer.id || typeof state.currentServer.name !== 'string')) {
    throw new TypeError('本机资源状态格式错误：当前服务器信息无效。');
  }
  /** @type {Set<string>} */
  const ids = new Set();
  for (const pack of state.packs) {
    if (!pack || typeof pack.id !== 'string' || !pack.id || typeof pack.name !== 'string' || typeof pack.version !== 'string' ||
        !['interfaces', 'interactions', 'stickers'].includes(pack.kind) || !['package', 'legacy'].includes(pack.source) ||
        !validCount(pack.entryCount) || !validCount(pack.bytes) || typeof pack.active !== 'boolean' ||
        (pack.pendingRemoval !== undefined && typeof pack.pendingRemoval !== 'boolean') ||
        !Array.isArray(pack.serverIds) || pack.serverIds.some(id => typeof id !== 'string') || ids.has(pack.id)) {
      throw new TypeError('本机资源状态格式错误：资源包字段无效或 ID 重复。');
    }
    ids.add(pack.id);
  }
  return {
    root: state.root,
    currentServer: state.currentServer === null ? null : { id: state.currentServer.id, name: state.currentServer.name },
    packs: state.packs.map(pack => ({ id: pack.id, name: pack.name, version: pack.version, kind: pack.kind, entryCount: pack.entryCount, bytes: pack.bytes, serverIds: [...pack.serverIds], active: pack.active, source: pack.source, ...(pack.pendingRemoval === undefined ? {} : { pendingRemoval: pack.pendingRemoval }) })),
    personal: { count: state.personal.count, bytes: state.personal.bytes, directory: state.personal.directory },
  };
}

/** @param {string} tag @param {string} className @param {string} text @returns {HTMLElement} */
function node(tag, className, text) {
  const result = document.createElement(tag);
  result.className = className;
  result.textContent = text;
  return result;
}

/** @param {string} action @param {string} label @param {()=>void} callback @returns {HTMLButtonElement} */
function actionButton(action, label, callback) {
  const result = document.createElement('button');
  result.type = 'button';
  result.className = 'btn ghost';
  result.dataset.action = action;
  result.textContent = label;
  result.addEventListener('click', callback);
  return result;
}

const main = element('rm-main');
const status = element('rm-status');
const content = element('rm-content');
const packList = element('rm-pack-list');
const refreshButton = buttonElement('rm-refresh');
/** @returns {ResourceManagerBridge} */
function getBridge() {
  const value = /** @type {Window & {resourceManager?:ResourceManagerBridge}} */ (window).resourceManager;
  if (!value) {
    status.textContent = '资源管理未能连接本机客户端，请关闭窗口后重新打开。';
    status.dataset.level = 'error';
    status.setAttribute('role', 'alert');
    main.setAttribute('aria-busy', 'false');
    throw new Error('Resource manager native bridge is unavailable');
  }
  return value;
}
const bridge = getBridge();
/** @type {ResourceState|null} */
let currentState = null;
let busy = false;
let disposed = false;
/** @type {string|null} */
let pendingRemoval = null;
const kindLabels = { interfaces: '界面主题', interactions: '互动表情', stickers: '表情包' };

/** @param {string} message @param {'info'|'error'} level @returns {void} */
function report(message, level) {
  status.textContent = message;
  status.dataset.level = level;
  status.setAttribute('role', level === 'error' ? 'alert' : 'status');
}

/** @param {string} id @returns {Promise<ResourceState>} */
async function removePack(id) {
  try {
    return await bridge.removePack(id);
  } catch (error) {
    try {
      const state = validateState(await bridge.getState());
      if (!disposed) { currentState = state; render(state); }
    } catch (refreshError) {
      const reason = error instanceof Error ? error.message : String(error);
      const refreshReason = refreshError instanceof Error ? refreshError.message : String(refreshError);
      throw new AggregateError([error, refreshError], `移除失败：${reason}；读取移除状态失败：${refreshReason}`);
    }
    throw error;
  }
}

/** @param {ResourcePack} pack @param {ResourceState} state @returns {HTMLElement} */
function packCard(pack, state) {
  const card = node('article', 'rm-pack', '');
  card.dataset.packId = pack.id;
  const heading = node('div', 'rm-pack-head', '');
  heading.append(node('h3', '', pack.name), node('span', 'rm-tag', kindLabels[pack.kind]), node('span', 'rm-tag', `v${pack.version}`));
  if (pack.active) heading.append(node('span', 'rm-tag', '使用中'));
  if (pack.pendingRemoval) heading.append(node('span', 'rm-tag rm-removal-warning', '移除未完成，可重试'));
  card.append(heading, node('p', 'rm-pack-meta', `${pack.entryCount} 项 · ${formatBytes(pack.bytes)} · ${pack.source === 'legacy' ? '已有本机资源' : '已安装资源包'}`), node('p', 'rm-pack-id', `ID: ${pack.id}`));
  const actions = node('div', 'rm-pack-actions', '');
  actions.append(actionButton('open', '打开目录', () => { void runOperation(() => bridge.openPack(pack.id), '正在打开资源目录…', '已打开资源目录。'); }));
  if (pack.kind === 'interactions') {
    const server = state.currentServer;
    const bound = server !== null && pack.serverIds.includes(server.id);
    const bind = actionButton('bind', bound ? '已绑定当前服务器' : '绑定当前服务器', () => { void runOperation(() => bridge.bindServer(pack.id), '正在绑定服务器…', '已绑定当前服务器，请到互动管理中选择并发布。'); });
    bind.disabled = !server || bound || pack.pendingRemoval === true;
    bind.dataset.locked = String(bind.disabled);
    if (!server) bind.title = '连接服务器后可绑定互动包';
    if (pack.pendingRemoval) bind.title = '移除尚未完成，请先重试移除';
    actions.append(bind);
  }
  const protectedTheme = pack.kind === 'interfaces' && pack.active;
  const remove = actionButton('remove', pack.pendingRemoval ? '重试移除' : '移除', () => { pendingRemoval = pack.id; render(state); });
  remove.disabled = protectedTheme;
  remove.dataset.locked = String(protectedTheme);
  if (protectedTheme) remove.title = '请先切换到其他主题，再移除此资源包';
  actions.append(remove);
  if (protectedTheme) actions.append(node('span', 'rm-remove-note', '切换主题后可移除'));
  card.append(actions);
  if (pendingRemoval === pack.id) {
    const confirmation = node('div', 'rm-confirm', '');
    confirmation.append(node('p', '', `确认移除「${pack.name}」？资源文件和本机绑定将被删除。`), actionButton('confirm-remove', '确认移除', () => { pendingRemoval = null; void runOperation(() => removePack(pack.id), '正在移除资源包…', '资源包已移除。'); }), actionButton('cancel-remove', '取消', () => { pendingRemoval = null; render(state); }));
    card.append(confirmation);
  }
  return card;
}

/** @param {ResourceState} state @returns {void} */
function render(state) {
  element('rm-root').textContent = state.root;
  element('rm-server').textContent = state.currentServer?.name ?? '未连接服务器';
  element('rm-pack-count').textContent = `${state.packs.length} 个资源包`;
  packList.replaceChildren(...state.packs.map(pack => packCard(pack, state)));
  if (state.packs.length === 0) packList.append(node('p', 'rm-empty', '暂无本机资源包。选择 ZIP 包或文件夹开始安装。'));
  element('rm-personal-summary').textContent = `${state.personal.count} 张表情 · ${formatBytes(state.personal.bytes)}`;
  element('rm-personal-directory').textContent = state.personal.directory;
  content.hidden = false;
}

/** @param {boolean} value @returns {void} */
function setBusy(value) {
  busy = value;
  main.setAttribute('aria-busy', String(value));
  for (const button of main.querySelectorAll('button')) button.disabled = value || button.dataset.locked === 'true';
  if (!value && currentState === null) {
    buttonElement('rm-open-root').disabled = true;
    buttonElement('rm-install-archive').disabled = true;
    buttonElement('rm-install-directory').disabled = true;
  }
}

/** @param {()=>Promise<ResourceState|null|void>} operation @param {string} progress @param {string} success @returns {Promise<void>} */
async function runOperation(operation, progress, success) {
  if (busy || disposed) return;
  setBusy(true);
  report(progress, 'info');
  try {
    const result = await operation();
    if (disposed) return;
    if (result) {
      currentState = validateState(result);
      render(currentState);
    }
    if (result && result.packs.some(pack => pack.pendingRemoval)) report('资源包移除未完成，可在对应资源包下重试。', 'error');
    else report(result === null ? '已取消安装。' : success, 'info');
  } catch (error) {
    if (!disposed) report(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    if (!disposed) setBusy(false);
  }
}

/** @returns {Promise<void>} */
async function refresh() {
  pendingRemoval = null;
  await runOperation(() => bridge.getState(), '正在读取本机资源…', '本机资源已更新。');
}

/** @returns {void} */
function onFocus() { if (!busy) void refresh(); }
/** @returns {void} */
function dispose() { disposed = true; window.removeEventListener('focus', onFocus); }

buttonElement('rm-install-archive').addEventListener('click', () => { void runOperation(() => bridge.installArchive(), '正在选择并安装 ZIP 包…', '资源包已安装。'); });
buttonElement('rm-install-directory').addEventListener('click', () => { void runOperation(() => bridge.installDirectory(), '正在选择并安装文件夹…', '资源包已安装。'); });
buttonElement('rm-open-root').addEventListener('click', () => { void runOperation(() => bridge.openRoot(), '正在打开资源目录…', '已打开资源目录。'); });
refreshButton.addEventListener('click', () => { void refresh(); });
window.addEventListener('focus', onFocus);
window.addEventListener('pagehide', dispose, { once: true });
void refresh();

export {};
