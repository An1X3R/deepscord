// @ts-check
import {loadLocalInterface} from './local-interface.js';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{[key:string]:JsonValue}} JsonObject */
/** @typedef {'choose'|'create'|'join'} ConnectionIntent */
/** @typedef {'steam'|'direct'|'server'} ConnectionMethod */
/** @typedef {{ok:true}|{ok:false,error:string,cancelled?:true}} ActionResult */
/** @typedef {{intent:ConnectionIntent,config:{serverUrl:string},directAddresses:string[]}} ConnectionContext */
/** @typedef {{kind:'steam'|'direct',invite:string}} CreatedRoom */
/** @typedef {{getConnectionContext:()=>Promise<JsonValue>,createDirect:(options:{address:string,port:number})=>Promise<JsonValue>,joinDirect:(invite:string)=>Promise<ActionResult>,enterDirect:()=>Promise<ActionResult>,createSteam:(options:{appId:number,stunUrls:string[]})=>Promise<JsonValue>,joinSteam:(invite:string)=>Promise<ActionResult>,enterSteam:()=>Promise<ActionResult>,connect:(url:string)=>Promise<ActionResult>}} ConnectionApi */

/** @param {string} id @returns {HTMLElement} */
function element(id) {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Connection panel element is missing: ${id}`);
  return found;
}

/** @param {string} id @returns {HTMLInputElement|HTMLTextAreaElement} */
function input(id) {
  const found = element(id);
  if (!(found instanceof HTMLInputElement) && !(found instanceof HTMLTextAreaElement)) throw new Error(`Connection field is not an input: ${id}`);
  return found;
}

/** @param {JsonValue} value @param {string} label @returns {JsonObject} */
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

/** @param {JsonValue} value @param {string} label @returns {string} */
function string(value, label) {
  if (typeof value !== 'string' || value.length > 65536) throw new TypeError(`${label} must be a string of at most 65536 characters`);
  return value;
}

/** @param {JsonValue} value @returns {ConnectionContext} */
function parseContext(value) {
  const row = record(value, 'Connection context');
  if (row.intent !== 'choose' && row.intent !== 'create' && row.intent !== 'join') throw new TypeError('Connection intent must be choose, create or join');
  const config = record(row.config, 'Connection configuration');
  if (!Array.isArray(row.directAddresses) || row.directAddresses.length > 256) throw new TypeError('Direct addresses must be an array of at most 256 values');
  return { intent: row.intent, config: { serverUrl: string(config.serverUrl, 'Server URL') }, directAddresses: row.directAddresses.map(address => string(address, 'Direct address')) };
}

/** @param {JsonValue} value @returns {'success'|'cancelled'} */
function parseActionOutcome(value) {
  const row = record(value, 'Connection operation');
  if (row.ok === true) return 'success';
  if (row.ok !== false || typeof row.error !== 'string' || !row.error) throw new TypeError('桌面操作没有返回有效结果');
  if (row.cancelled === true) return 'cancelled';
  if (row.cancelled !== undefined && row.cancelled !== false) throw new TypeError('桌面操作返回了无效的取消状态');
  throw new Error(row.error);
}

/** @param {JsonValue} value @param {'steam'|'direct'} kind @returns {CreatedRoom} */
function parseCreatedRoom(value, kind) {
  const row = record(value, 'Room creation response');
  if (row.ok !== true) throw new Error(typeof row.error === 'string' ? row.error : '创建房间没有返回成功结果');
  const session = record(row.session, 'Created room session');
  const invite = string(session.invite, 'Room invitation');
  if (!invite) throw new TypeError('Created room invitation must not be empty');
  return { kind, invite };
}

/** @param {ConnectionApi} api @returns {Promise<void>} */
async function startPanel(api) {
  await loadLocalInterface(/** @type {ConnectionApi & import('./local-interface.js').LocalInterfaceApi} */ (api));
  const context = parseContext(await api.getConnectionContext());
  /** @type {ConnectionIntent} */ let intent = context.intent;
  /** @type {ConnectionMethod|null} */ let method = null;
  /** @type {CreatedRoom|null} */ let created = null;
  let busy = false;
  const errorPanel = element('connectionError');
  const status = element('connectionStatus');

  /** @param {JsonValue} result @returns {boolean} */
  function completed(result) {
    if (parseActionOutcome(result) === 'success') return true;
    errorPanel.hidden = true;
    status.textContent = '已取消切换，当前房间保持连接。';
    return false;
  }
  const deploymentElement = element('serverDeployment');
  if (!(deploymentElement instanceof HTMLDetailsElement)) throw new Error('Server deployment section is not a details element');
  const serverDeployment = deploymentElement;
  input('directAddress').value = context.directAddresses[0] || '';
  for (const address of context.directAddresses) {
    const option = document.createElement('option'); option.value = address;
    element('directAddresses').append(option);
  }

  /** @returns {void} */
  function render() {
    element('connectionTitle').textContent = intent === 'choose' ? '添加服务器' : intent === 'create' ? '创建服务器' : '加入服务器';
    element('connectionDescription').textContent = intent === 'choose' ? '创建一个新的服务器，或加入朋友的服务器。' : intent === 'create' ? '选择创建方式，建立服务器后即可分享邀请。' : '选择邀请对应的连接方式，填写链接后加入。';
    element('connectionChoice').hidden = intent !== 'choose';
    element('connectionBody').hidden = intent === 'choose';
    element('connectionBackBtn').hidden = intent === 'choose';
    element('createdResult').hidden = !(intent === 'create' && created?.kind === method);
    for (const candidate of ['steam', 'direct', 'server']) element(`${candidate}MethodBtn`).setAttribute('aria-pressed', String(candidate === method));
    element('methodPlaceholder').hidden = method !== null;
    element('steamCreateSection').hidden = !(intent === 'create' && method === 'steam');
    element('directCreateSection').hidden = !(intent === 'create' && method === 'direct');
    element('steamJoinSection').hidden = !(intent === 'join' && method === 'steam');
    element('directJoinSection').hidden = !(intent === 'join' && method === 'direct');
    element('serverSection').hidden = method !== 'server';
    element('serverSectionTitle').textContent = intent === 'create' ? '使用独立自建服务' : '连接独立自建服务';
    element('serverDescription').textContent = intent === 'create' ? '自建服务需要在服务器机器上独立部署。服务已启动时，在下方填写它的 HTTPS 地址。' : '填写已运行的独立服务端地址。访问口令会在连接后由服务器页面询问。';
    serverDeployment.open = intent === 'create';
  }

  /** @param {ConnectionIntent} next @returns {void} */
  function selectIntent(next) {
    if (busy) return;
    const previous = intent;
    intent = next; method = null; render();
    errorPanel.hidden = true;
    status.textContent = next === 'choose' ? '选择要进行的操作。' : '选择连接方式。';
    element(next === 'choose' ? previous === 'join' ? 'chooseJoinBtn' : 'chooseCreateBtn' : 'connectionTitle').focus();
  }

  /** @param {ConnectionMethod} next @returns {void} */
  function selectMethod(next) {
    if (busy) return;
    method = next; render();
    errorPanel.hidden = true;
    status.textContent = '填写连接信息后继续。';
  }

  /** @param {()=>Promise<void>} operation @returns {Promise<void>} */
  async function perform(operation) {
    if (busy) return;
    busy = true;
    errorPanel.hidden = true;
    document.body.setAttribute('aria-busy', 'true');
    for (const control of document.querySelectorAll('button,input,textarea')) if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) control.disabled = true;
    try { await operation(); }
    catch (error) {
      errorPanel.hidden = false;
      errorPanel.textContent = error instanceof Error ? error.message : String(error);
      status.textContent = '操作失败，请检查上方说明。';
    } finally {
      busy = false;
      document.body.setAttribute('aria-busy', 'false');
      for (const control of document.querySelectorAll('button,input,textarea')) if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) control.disabled = false;
    }
  }

  /** @param {CreatedRoom} room @returns {void} */
  function showCreated(room) {
    created = room;
    input('createdInvite').value = room.invite;
    element('createdTitle').textContent = room.kind === 'steam' ? 'Steam 房间已创建' : '直连房间已创建';
    element('createdResult').hidden = false;
    status.textContent = '房间已创建，复制邀请给朋友，再进入房间。';
    element('createdResult').scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }

  element('chooseCreateBtn').addEventListener('click', () => selectIntent('create'));
  element('chooseJoinBtn').addEventListener('click', () => selectIntent('join'));
  element('connectionBackBtn').addEventListener('click', () => selectIntent('choose'));
  element('steamMethodBtn').addEventListener('click', () => selectMethod('steam'));
  element('directMethodBtn').addEventListener('click', () => selectMethod('direct'));
  element('serverMethodBtn').addEventListener('click', () => selectMethod('server'));
  element('steamCreateForm').addEventListener('submit', event => {
    event.preventDefault();
    void perform(async () => { status.textContent = '正在通过 Steam 创建房间…'; const result = await api.createSteam({ appId: 480, stunUrls: ['stun:stun.cloudflare.com:3478'] }); if (!completed(result)) return; showCreated(parseCreatedRoom(result, 'steam')); });
  });
  element('directCreateForm').addEventListener('submit', event => {
    event.preventDefault();
    void perform(async () => {
      const address = input('directAddress').value.trim();
      const port = Number(input('directPort').value);
      if (!address || !Number.isInteger(port) || port < 1024 || port > 65535) throw new TypeError('请填写可访问地址和 1024–65535 范围内的整数端口。');
      status.textContent = '正在创建直连房间…';
      const result = await api.createDirect({ address, port });
      if (!completed(result)) return;
      showCreated(parseCreatedRoom(result, 'direct'));
    });
  });
  element('steamJoinForm').addEventListener('submit', event => {
    event.preventDefault();
    void perform(async () => {
      const invite = input('steamJoinInvite').value.trim();
      if (!invite.startsWith('deepscord://steam?')) throw new TypeError('请粘贴以 deepscord://steam? 开头的完整 Steam 邀请。');
      status.textContent = '正在加入 Steam 房间…';
      if (!completed(await api.joinSteam(invite))) return; status.textContent = '已加入，正在打开房间…';
    });
  });
  element('directJoinForm').addEventListener('submit', event => {
    event.preventDefault();
    void perform(async () => {
      const invite = input('directJoinInvite').value.trim();
      if (!invite.startsWith('deepscord://join?')) throw new TypeError('请粘贴以 deepscord://join? 开头的完整直连邀请。');
      status.textContent = '正在加入直连房间…';
      if (!completed(await api.joinDirect(invite))) return; status.textContent = '已加入，正在打开房间…';
    });
  });
  element('serverForm').addEventListener('submit', event => {
    event.preventDefault();
    void perform(async () => {
      const url = new URL(input('serverUrl').value.trim());
      const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password) throw new TypeError('请填写 HTTPS 服务器地址（本机回环地址可用 HTTP），不要包含账号或密码。');
      const fragment = new URLSearchParams(url.hash.slice(1));
      if ([...fragment.keys()].some(key => key !== 'channel') || fragment.getAll('channel').length > 1 || (fragment.has('channel') && !/^[A-Za-z0-9_-]{1,80}$/.test(fragment.get('channel') || ''))) throw new TypeError('服务器链接只能包含有效的频道邀请。');
      status.textContent = '正在连接独立服务端…';
      if (!completed(await api.connect(url.href))) return; status.textContent = '正在打开服务器…';
    });
  });
  element('copyCreatedInviteBtn').addEventListener('click', () => {
    const room = created;
    if (!room) return;
    void perform(async () => { await navigator.clipboard.writeText(room.invite); status.textContent = '邀请已复制，仅分享给要加入的人。'; });
  });
  element('enterCreatedRoomBtn').addEventListener('click', () => {
    const room = created;
    if (!room) return;
    void perform(async () => { if (!completed(room.kind === 'steam' ? await api.enterSteam() : await api.enterDirect())) return; status.textContent = '正在打开房间…'; });
  });
  render(); status.textContent = intent === 'choose' ? '选择要进行的操作。' : '选择连接方式。';
}

const desktopApi = /** @type {Window & {deepscord?:ConnectionApi}} */ (window).deepscord;
if (!desktopApi) {
  document.documentElement.dataset.localInterface='ready';
  element('connectionError').hidden = false;
  element('connectionError').textContent = '桌面连接接口未加载，请从 Deepscord 客户端打开连接面板。';
  element('connectionStatus').textContent = '连接面板无法初始化。';
} else {
  void startPanel(desktopApi).catch(error => {
    element('connectionError').hidden = false;
    element('connectionError').textContent = error instanceof Error ? error.message : String(error);
    element('connectionStatus').textContent = '读取连接配置失败。';
  });
}

export {};
