'use strict';

/**
 * Deepscord desktop client: connect to an independent server or host a temporary direct room.
 */

const { app, BrowserWindow, Menu, Tray, shell, ipcMain, dialog, session, nativeImage, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { X509Certificate, createHash } = require('node:crypto');
const direct = require('./direct-host.cjs');
const { createDesktopFeatures } = require('./desktop-features.cjs');
const { createProfileStore } = require('./profile-store.cjs');
const capture = require('./capture-ipc.cjs');
const screenRelay = require('./screen-relay-ipc.cjs');
const { registerScreenDiagnostics } = require('./screen-diagnostics.cjs');
const { createWorkspaceStore } = require('./workspace-store.cjs');
const { governanceConsent } = require('./app-server/public/js/governance-consent.js');
const { registerPersonalStickerIpc } = require('./sticker-ipc.cjs');
const { createMediaValidator } = require('./app-server/lib/media-validator.cjs');
const { createServerTrust } = require('./server-trust.cjs');
const { createDesktopConsent } = require('./desktop-consent.cjs');
const { createRoomPermissions } = require('./room-permissions.cjs');
const { prepareRoomClient } = require('./room-client.cjs');
const {openContentVault}=require('./content-vault.cjs');
const {createContentService}=require('./content-service.cjs');
const windowsProtection=require('./windows-protection.cjs');
const {createClientPreferences}=require('./client-preferences.cjs');
const {createChatUnreadStore}=require('./chat-unread-store.cjs');
const {createCustomizationStore,readInterfaceFile}=require('./customization-store.cjs');
const {resolveResourceRoot,initializePortableResources}=require('./resource-location.cjs');
const {createResourcePackStore}=require('./resource-pack-store.cjs');
const {createResourceManager}=require('./resource-manager.cjs');
const {openRoomCredentials}=require('./room-credentials.cjs');
const {registerRadioMetadataIpc}=require('./radio-metadata.cjs');
const {createRadioAccess}=require('./radio-access.cjs');
const {registerNotificationSoundIpc}=require('./notification-sounds.cjs');
const radioAccess=createRadioAccess();
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('allow-loopback-in-peer-connection');

const APP_NAME = 'Deepscord';
const ICON_PNG = path.join(__dirname, 'assets', 'icon.png');

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.deepscord.client');
// 允许测试/便携使用独立数据目录
if (process.env.DEEPSCORD_USER_DATA) {
  app.setPath('userData', process.env.DEEPSCORD_USER_DATA);
}

let win = null;
let tray = null;
let quitting = false;
let bootstrapLoading = false;
let trayHintShown = false;
let config = {};
let pendingUrl = '';
/** @type {import('./direct-host.cjs').HostedRoom | null} */
let directRoom = null;
/** @type {(import('./direct-host.cjs').Invitation & {role:'host'|'guest'}) | null} */
let directConnection = null;
/** @type {Electron.Session | null} */
let directSession = null;
let directCreating = false;
let connectionActionPending = false;
/** @type {Promise<{ok:boolean,error?:string,cancelled?:boolean}>|null} */
let activeConnectionOperation = null;
/** @type {Promise<import('./direct-host.cjs').HostedRoom> | null} */
let directCreation = null;
/** @type {import('./steam-room.cjs').SteamRoom | null} */
let steamRoom = null;
/** @type {Electron.Session | null} */
let steamSession = null;
/** @type {Electron.Session|null} */
let serverSession = null;
/** @type {import('./server-trust.cjs').PreparedConnection|null} */
let serverConnection = null;
/** @type {Awaited<ReturnType<typeof startRoomClient>>|null} */
let roomClient = null;
/** @type {Promise<void>|null} */
let roomClientShutdown = null;
/** @type {ReturnType<typeof createServerTrust>|null} */
let serverTrust = null;
/** @type {ReturnType<typeof createDesktopConsent>|null} */
let desktopConsent = null;
/** @type {ReturnType<typeof createRoomPermissions>|null} */
let roomPermissions = null;
/** @type {Promise<import('./steam-room.cjs').SteamRoom> | null} */
let steamCreation = null;
/** @type {Promise<void> | null} */
let roomTransition = null;
/** @type {Promise<void> | null} */
let roomShutdown = null;
let replacingWindow = false;
/** @type {ReturnType<typeof createDesktopFeatures>|null} */
let desktopFeatures = null;
const bootstrapUrl = pathToFileURL(path.join(__dirname, 'bootstrap.html')).href;
const workspaceUrl = pathToFileURL(path.join(__dirname, 'workspace.html')).href;
const connectionsUrl = pathToFileURL(path.join(__dirname, 'connections.html')).href;
/** @type {ReturnType<typeof createWorkspaceStore>|null} */
let workspace = null;
/** @type {Promise<Awaited<ReturnType<typeof openContentVault>>>|null} */
let contentVault = null;
/** @type {ReturnType<typeof createContentService>|null} */
let contentService = null;
function requireContentVault(){if(process.platform!=='win32')throw new Error('加密房间目前需要 Windows 客户端');if(!contentVault)contentVault=openContentVault({directory:app.getPath('userData'),protection:windowsProtection});return contentVault;}
/** @type {ReturnType<typeof createClientPreferences>|null} */let clientPreferences=null;
/** @type {ReturnType<typeof createChatUnreadStore>|null} */let chatUnread=null;
/** @type {ReturnType<typeof createCustomizationStore>|null} */let customizationStore=null;
/** @type {ReturnType<typeof createResourcePackStore>|null} */let resourcePacks=null;
/** @type {ReturnType<typeof createResourceManager>|null} */let resourceManager=null;
/** @type {string} */let resourceRoot='';
/** @type {Promise<Awaited<ReturnType<typeof openRoomCredentials>>>|null} */let roomCredentials=null;
function requireRoomCredentials(){if(!roomCredentials)roomCredentials=openRoomCredentials({directory:app.getPath('userData'),protection:windowsProtection});return roomCredentials;}
function trustedRoomEntry(event){const entryId=activeWorkspaceEntry(event);if(new URL(event.senderFrame.url).origin!==(roomClient?.origin||steamRoom?.origin))throw new Error('此操作仅允许当前客户端的本机界面发起');return entryId;}
/** @type {Electron.BrowserWindow|null} */
let connectionPanel = null;
/** @type {'choose'|'create'|'join'|'workspace'} */
let panelIntent = 'choose';
/** @type {string|null} */
let activeEntryId = null;
/** @type {string|null} */
let selectedEntryId = null;
/** @type {import('./workspace-store.cjs').RoomSeed|null} */
let creationSeed = null;
/** @type {string|null} */
let invitedChannelId = null;
let startupRestorePending = false;
/** @type {ReturnType<typeof registerPersonalStickerIpc>|null} */
let personalStickers = null;
/** @type {string|null} */
let personalStickerOrigin = null;
const connectionActions = new Map();

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  const defaults = { serverUrl: '', autoConnect: false };
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    config = { ...defaults, ...(raw || {}) };
    delete config.trustedHosts;
  } catch (_) {
    config = { ...defaults };
  }
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
  } catch (_) {
    /* ignore */
  }
}

function normalizeServerUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  return u.toString();
}

/* ------------------------------------------------------------------ */
/* 窗口 / 权限                                                         */
/* ------------------------------------------------------------------ */

function setupSession(ses) {
  capture.configureCaptureSession(ses);
  const pinnedConnection = ses === directSession ? directConnection : null;
  const steamOrigin = ses === steamSession && steamRoom ? steamRoom.origin : null;
  const trustedConnection = ses === serverSession ? serverConnection : null;
  const localOrigin = roomClient && (ses === serverSession || ses === directSession) ? roomClient.origin : null;
  if (localOrigin) {
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      const target = new URL(details.url);
      if (target.protocol === 'ws:') target.protocol = 'http:';
      callback({ cancel: target.origin !== localOrigin && !radioAccess.permits(details) });
    });
  } else if (trustedConnection) {
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const target = new URL(details.url);
      if (target.protocol === 'wss:') target.protocol = 'https:';
      if (target.protocol === 'ws:') target.protocol = 'http:';
      callback({ cancel: target.origin !== trustedConnection.origin && !radioAccess.permits(details) });
    });
  }
  if (steamOrigin) {
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      const target = new URL(details.url);
      if (target.protocol === 'ws:') target.protocol = 'http:';
      callback({ cancel: target.origin !== steamOrigin && !radioAccess.permits(details) });
    });
  }
  if (pinnedConnection && !localOrigin) {
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      const target = new URL(details.url);
      if (target.protocol === 'wss:') target.protocol = 'https:';
      callback({ cancel: target.origin !== pinnedConnection.origin && !radioAccess.permits(details) });
    });
  }

  ses.webRequest.onBeforeRedirect(details=>radioAccess.redirect(details));
  ses.webRequest.onCompleted(details=>radioAccess.complete(details));
  ses.webRequest.onErrorOccurred(details=>radioAccess.complete(details));
  ses.webRequest.onBeforeSendHeaders((details,callback)=>{
    if(!radioAccess.permits(details)){callback({requestHeaders:details.requestHeaders});return;}
    const headers=Object.fromEntries(Object.entries(details.requestHeaders).filter(([name])=>!['cookie','authorization','proxy-authorization','referer'].includes(name.toLowerCase())));
    callback({requestHeaders:headers});
  });
  ses.webRequest.onHeadersReceived((details,callback)=>{
    if(!radioAccess.permits(details)){callback({});return;}
    const headers=Object.fromEntries(Object.entries(details.responseHeaders ?? {}).filter(([name])=>name.toLowerCase()!=='set-cookie'));
    callback({responseHeaders:headers});
  });

  if (!roomPermissions) throw new Error('Room permission service is not initialized');
  roomPermissions.configure(ses);

  // Certificate exceptions belong to a pinned connection, never a host allowlist.
  ses.setCertificateVerifyProc((request, callback) => {
    if (pinnedConnection) {
      const connection = pinnedConnection;
      const hostname = connection && new URL(connection.origin).hostname.replace(/^\[|\]$/g, '');
      if(request.hostname!==hostname){callback(-3);return;}
      let fingerprint = '';
      try {
        fingerprint = new X509Certificate(request.certificate.data).fingerprint256.replaceAll(':', '').toLowerCase();
      } catch (error) {
        callback(-2);
        return;
      }
      callback(connection && request.hostname === hostname && fingerprint === connection.fingerprint ? 0 : -2);
      return;
    }
    if (trustedConnection && serverTrust && request.hostname===new URL(trustedConnection.origin).hostname.replace(/^\[|\]$/g,'')) { serverTrust.verifyCertificate(trustedConnection.origin, request, callback); return; }
    callback(-3);
  });
}

function createWindow(initialUrl) {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0b0d12',
    title: APP_NAME,
    icon: ICON_PNG,
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
      session: steamSession || directSession || serverSession || session.defaultSession,
    },
  });

  const visibilityWindow=win;
  for(const event of ['show','hide','minimize','restore'])visibilityWindow.on(event,()=>{if(!visibilityWindow.isDestroyed())visibilityWindow.webContents.send('window:visibility',visibilityWindow.isVisible()&&!visibilityWindow.isMinimized());});

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    try {
      const current = new URL(win.webContents.getURL());
      const next = new URL(url);
      if (next.origin === current.origin && next.protocol === current.protocol) return;
      event.preventDefault();
      shell.openExternal(url);
    } catch (_) {
      event.preventDefault();
    }
  });

  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || bootstrapLoading) return;
    if (errorCode === -3) return; // 主动取消
    if (steamSession) {
      console.error('Steam page load failed', { errorCode, errorDescription });
      return;
    }
    const safeUrl = new URL(validatedURL);
    safeUrl.hash = '';
    loadBootstrap(`无法连接到服务器\n${safeUrl.href}\n(${errorDescription})`);
  });

  win.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) {
      personalStickers?.cancel();
      if (desktopFeatures) desktopFeatures.resetVoice();
      capture.stopAllCapture().catch((error) => console.error('capture_navigation_cleanup_failed', { message:error.message }));
    }
  });
  win.webContents.on('render-process-gone', () => {
    desktopFeatures?.resetVoice();
    capture.stopAllCapture().catch((error) => console.error('capture_crash_cleanup_failed', { message:error.message }));
  });

  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    if (!trayHintShown && tray) {
      trayHintShown = true;
      try {
        tray.displayBalloon({
          title: APP_NAME + ' 仍在运行',
          content: '窗口已隐藏到系统托盘，点击托盘图标可以重新打开。',
        });
      } catch (_) {
        /* ignore */
      }
    }
  });

  win.on('closed', () => {
    if (desktopFeatures) desktopFeatures.resetVoice();
    capture.stopAllCapture().catch((error) => console.error('capture_window_cleanup_failed', { message:error.message }));
    win = null;
  });

  bootstrapLoading = false;
  if (initialUrl) { loadServer(initialUrl); return; }
  loadBootstrap();
}

function loadServer(url) {
  if (!win) return;
  personalStickers?.cancel();
  roomPermissions?.reset();
  const safeUrl = new URL(url);
  personalStickerOrigin = ['http:','https:'].includes(safeUrl.protocol) ? safeUrl.origin : null;
  safeUrl.hash = '';
  if (!directSession && !steamSession && !roomClient && ['http:', 'https:'].includes(safeUrl.protocol)) pendingUrl = safeUrl.href;
  bootstrapLoading = safeUrl.protocol === 'file:';
  win.loadURL(url).catch(() => {
    /* did-fail-load 会处理 */
  });
}

function loadBootstrap(errorMessage) {
  personalStickers?.cancel();
  roomPermissions?.reset();
  personalStickerOrigin = null;
  stopRoomClient().catch(error => console.error('room_client_cleanup_failed',{message:error.message}));
  if (!win) return;
  if (directSession || steamSession || serverSession) {
    replacingWindow = true;
    win.destroy();
    directSession = null;
    steamSession = null;
    serverSession = null;
    serverConnection = null;
    createWindow(workspaceUrl + (errorMessage ? '?error=' + encodeURIComponent(errorMessage) : ''));
    replacingWindow = false;
    return;
  }
  bootstrapLoading = true;
  const options = errorMessage ? { query: { error: errorMessage } } : {};
  win.loadFile(path.join(__dirname, 'workspace.html'), options).catch(error => console.error('workspace_load_failed', {message:error.message}));
}

/** @param {'choose'|'create'|'join'|'workspace'} intent @returns {void} */
function openConnectionPanel(intent) {
  if (!['choose','create','join','workspace'].includes(intent)) throw new TypeError('无效的连接面板类型');
  panelIntent = intent;
  if (connectionPanel && !connectionPanel.isDestroyed()) {
    connectionPanel.loadURL(intent === 'workspace' ? workspaceUrl : connectionsUrl).catch(error => console.error('connection_panel_load_failed',{message:error.message}));
    connectionPanel.show();connectionPanel.focus();return;
  }
  const panel = new BrowserWindow({width:1040,height:760,minWidth:720,minHeight:560,title:'Deepscord · 服务器',backgroundColor:'#0b0d12',autoHideMenuBar:true,show:false,webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false}});
  connectionPanel=panel;
  panel.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  panel.webContents.on('will-navigate', event => event.preventDefault());
  panel.once('ready-to-show',() => panel.show());
  panel.once('closed',() => {if(connectionPanel===panel) connectionPanel=null;});
  panel.loadURL(intent === 'workspace' ? workspaceUrl : connectionsUrl).catch(error => console.error('connection_panel_load_failed',{message:error.message}));
}

/** @returns {void} */
function closeConnectionPanel() {
  const panel=connectionPanel;
  if(panel) setTimeout(() => {if(!panel.isDestroyed()) panel.close();},100);
}

/** @returns {ReturnType<typeof createWorkspaceStore>} */
function requireWorkspace() {if(!workspace) throw new Error('本地频道资料尚未初始化');return workspace;}

/** @param {Electron.IpcMainInvokeEvent} event @returns {string} */
function activeWorkspaceEntry(event) {
  assertMainFrame(event);
  if(isBootstrap(event) || !activeEntryId) throw new Error('当前没有已连接的服务器');
  return activeEntryId;
}

function registerConnectionAction(channel, handler) {
  const execute=async(event,input) => {
    assertBootstrap(event);
    if(directCreating || connectionActionPending) return {ok:false,error:'房间正在连接，请稍候'};
    connectionActionPending=true;
    try {
    if(!channel.endsWith(':enter') && activeEntryId && win && !win.isDestroyed() && /^https?:/.test(win.webContents.getURL())) {
      if(!desktopConsent) throw new Error('切换确认窗口尚未初始化');
      const accepted=await desktopConsent.confirm({title:'切换服务器',message:'目标服务器准备成功后才会离开当前房间；连接失败会保留当前房间和语音。',details:[{label:'当前服务器',value:requireWorkspace().get(activeEntryId).name},{label:'目标服务器',value:selectedEntryId ? requireWorkspace().get(selectedEntryId).name : channel.endsWith(':create') ? '新建服务器' : channel.startsWith('steam:') ? 'Steam 邀请房间' : channel.startsWith('direct:') ? '直连邀请房间' : normalizeServerUrl(input)}],acceptLabel:'确认切换'},AbortSignal.timeout(120000));
      if(!accepted) return {ok:false,cancelled:true,error:'已取消切换'};
    }
    let channelHint=invitedChannelId;
    if(channel.endsWith(':join') || channel==='server:connect') {
      const address=new URL(channel==='server:connect' ? normalizeServerUrl(input) : input);
      const fragment=new URLSearchParams(address.hash.slice(1));
      const secrets=fragment.getAll('content');
      if(secrets.length>1)throw new TypeError('邀请包含重复的房间加密密钥');
      if(secrets.length===1){await (await requireContentVault()).importSecret(secrets[0]);fragment.delete('content');address.hash=fragment.toString();input=address.href;}
      const candidate=fragment.get('channel');
      if(candidate!==null && !/^[A-Za-z0-9_-]{1,80}$/.test(candidate)) throw new TypeError('邀请中的频道 ID 无效');
      channelHint=candidate;
      if(channel==='server:connect' && candidate!==null) {fragment.delete('channel');address.hash=fragment.toString();input=address.href;}
    } else if(channel.endsWith(':create')) channelHint=null;
    if(channel==='steam:create'||channel==='direct:create') creationSeed=requireWorkspace().seed(selectedEntryId);
    const result=await handler(event,input);
    if(result.ok) {
      invitedChannelId=channelHint;
      if(channel.endsWith(':join') || channel==='server:connect' || channel.endsWith(':enter')) closeConnectionPanel();
    }
    return result;
    } catch(error) {
      const message=error instanceof Error ? error.message : String(error);
      console.error('room_connection_action_failed',{action:channel,message});
      return {ok:false,error:message};
    } finally {creationSeed=null;connectionActionPending=false;}
  };
  const wrapped=(event,input) => {
    const operation=execute(event,input);
    if(!activeConnectionOperation) activeConnectionOperation=operation;
    return operation.finally(()=>{if(activeConnectionOperation===operation) activeConnectionOperation=null;});
  };
  connectionActions.set(channel,wrapped);
  ipcMain.handle(channel,wrapped);
}

/** @param {Electron.IpcMainInvokeEvent} event @param {string} entryId @param {'connect'|'reopen'} action */
async function useSavedRoom(event,entryId,action) {
  assertBootstrap(event);
  if(selectedEntryId || directCreating || connectionActionPending) return {ok:false,error:'另一条服务器连接正在处理'};
  const entry=requireWorkspace().get(entryId), connection=entry.connection;
  if(action==='connect' && entryId===activeEntryId && win && !win.isDestroyed() && /^https?:/.test(win.webContents.getURL())) {
    win.show();win.focus();closeConnectionPanel();return {ok:true};
  }
  selectedEntryId=entryId;
  try {
    if(action==='reopen' && connection.mode==='server') throw new Error('自建服务器由独立服务端管理，请连接已经运行的服务');
    if(action==='reopen') {
      if(connection.mode==='direct' && (!connection.hostAddress || !connection.hostPort)) throw new Error('此直连记录没有本机公开地址，请通过创建页面重新开房');
      const channel=connection.mode==='steam' ? 'steam:create' : 'direct:create';
      const options=connection.mode==='steam' ? {appId:connection.appId,stunUrls:connection.stunUrls} : {address:connection.hostAddress,port:connection.hostPort};
      const result=await connectionActions.get(channel)(event,options);
      if(!result.ok) return result;
      return connectionActions.get(connection.mode==='steam' ? 'steam:enter' : 'direct:enter')(event,undefined);
    }
    const channel=connection.mode==='server' ? 'server:connect' : connection.mode==='steam' ? 'steam:join' : 'direct:join';
    return await connectionActions.get(channel)(event,connection.mode==='server' ? connection.address : connection.invite);
  } catch(error) {return {ok:false,error:error.message};}
  finally {selectedEntryId=null;creationSeed=null;}
}

/* ------------------------------------------------------------------ */
/* 菜单 / 托盘                                                         */
/* ------------------------------------------------------------------ */

function quitApp() {
  quitting = true;
  app.quit();
}

function createMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '切换服务器…', accelerator: 'CmdOrCtrl+Shift+S', click: () => openConnectionPanel('workspace') },
        { label: '重新连接', accelerator: 'CmdOrCtrl+R', click: () => win && win.reload() },
        { label: '资源管理（主题与表情）…', click: () => resourceManager.open().catch(error=>dialog.showErrorBox('资源管理无法打开',error.message)) },
        { type: 'separator' },
        { label: '隐藏到托盘', accelerator: 'CmdOrCtrl+W', click: () => win && win.hide() },
        { label: '退出 Deepscord', accelerator: 'Alt+F4', click: quitApp },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '刷新', accelerator: 'F5', click: () => win && win.reload() },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于 Deepscord', click: showAbout },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showAbout() {
  dialog.showMessageBox({
    type: 'info',
    title: '关于 Deepscord',
    message: 'Deepscord ' + app.getVersion(),
    detail:
      '语音频道桌面客户端\n\n' +
      'Electron ' + process.versions.electron + '\n' +
      'Chromium ' + process.versions.chrome + '\n' +
      'Node ' + process.versions.node,
    buttons: ['好的'],
  });
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(ICON_PNG);
    tray = new Tray(img.resize({ width: 16, height: 16 }));
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: '显示 Deepscord',
          click: () => {
            if (!win) return;
            win.show();
            win.focus();
          },
        },
        { label: '切换服务器…', click: () => openConnectionPanel('workspace') },
        { type: 'separator' },
        { label: '退出', click: quitApp },
      ])
    );
    tray.on('click', () => {
      if (!win) return;
      if (win.isVisible()) win.hide();
      else {
        win.show();
        win.focus();
      }
    });
  } catch (err) {
    console.warn('托盘创建失败:', err.message);
  }
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function setupIpc() {
  personalStickers = registerPersonalStickerIpc({directory:path.join(resourceRoot,'stickers'),assertOwner:assertPersonalStickerFrame,getWindow:()=>win,validator:createMediaValidator({maxPending:4})});
  resourcePacks=createResourcePackStore({root:resourceRoot,readInterfaceFile,listLegacyInterfaces:()=>customizationStore.listInterfaceSchemes(),listPersonal:()=>personalStickers.listForResourceManager(),importStickers:(inputs,signal)=>personalStickers.importPack(inputs,signal),removeStickers:ids=>personalStickers.removePackItems(ids),activeThemeId:()=>{const settings=clientPreferences.read().settings;return settings?.interfaceSelection?.scheme.id??settings?.interfaceProfile.preset??'industrial';}});
  resourceManager=createResourceManager({root:resourceRoot,store:resourcePacks,getParent:()=>win,getCurrentServer:()=>{const entry=activeEntryId?requireWorkspace().get(activeEntryId):null;return entry?.roomId?{id:entry.roomId,name:entry.name}:null;}});
  ipcMain.handle('resource-manager:open',event=>{assertMainFrame(event);if(!isBootstrap(event))trustedRoomEntry(event);return resourceManager.open();});
  registerScreenDiagnostics({ getWindow: () => win, assertOwner: assertMainFrame });
  capture.registerCaptureIpc({ getWindow:() => win });
  screenRelay.installScreenRelay({ getWindow: () => win });
  const profiles = createProfileStore(app.getPath('userData'));
  ipcMain.handle('profile:get', (event) => { assertMainFrame(event); return profiles.load(); });
  ipcMain.handle('profile:save', (event, profile) => { assertMainFrame(event); return profiles.save(profile); });
  ipcMain.handle('workspace:list',(event) => {
    assertBootstrap(event);
    if(startupRestorePending) {
      startupRestorePending=false;
      setImmediate(async () => {
        try {
          const entryId=config.lastWorkspaceEntryId;
          if(typeof entryId!=='string') throw new TypeError('上次连接记录无效，请从服务器列表重新选择');
          const result=await useSavedRoom(event,entryId,'connect');
          if(!result.ok) loadBootstrap(`无法恢复上次连接：${result.error}。可切换服务器；临时房间关闭后可从列表重新开房。`);
        } catch(error) {
          const message=error instanceof Error ? error.message : String(error);
          console.error('workspace_startup_restore_failed',{message});
          loadBootstrap(`无法恢复上次连接：${message}。请从服务器列表重新选择。`);
        }
      });
    }
    return {entries:requireWorkspace().list(),activeEntryId};
  });
  ipcMain.handle('workspace:open',(event,intent) => {if(!isBootstrap(event)) assertMainFrame(event);openConnectionPanel(intent);return {ok:true};});
  ipcMain.handle('workspace:context',(event) => {
    if(!isBootstrap(event)) assertPersonalStickerFrame(event);
    const transportOrigin=serverConnection?.origin || directConnection?.origin || steamRoom?.origin || null;
    const localUi=personalStickerOrigin!==null && (roomClient?.origin===personalStickerOrigin || steamRoom?.origin===personalStickerOrigin);
    return {intent:panelIntent,config:{serverUrl:pendingUrl||config.serverUrl||''},directAddresses:direct.localAddresses(),transportOrigin,localUi};
  });
  ipcMain.handle('workspace:select',(event,entryId) => useSavedRoom(event,entryId,'connect'));
  ipcMain.handle('workspace:reopen',(event,entryId) => useSavedRoom(event,entryId,'reopen'));
  ipcMain.handle('workspace:remove',(event,entryId) => {assertBootstrap(event);if(entryId===activeEntryId) return {ok:false,error:'请先切换或退出此服务器再移除记录'};requireWorkspace().remove(entryId);return {ok:true};});
  ipcMain.handle('workspace:vote',(event,offer) => requireWorkspace().vote(activeWorkspaceEntry(event),offer));
  ipcMain.handle('workspace:identity',(event,challenge) => requireWorkspace().signServerIdentity(activeWorkspaceEntry(event),challenge));
  ipcMain.handle('workspace:governance',(event,journal) => {requireWorkspace().saveServerGovernance(activeWorkspaceEntry(event),journal);return {ok:true};});
  ipcMain.handle('workspace:governance-sign',async(event,change) => {
    const entryId=activeWorkspaceEntry(event),store=requireWorkspace();
    const signed=store.signGovernanceChange(entryId,change),details=governanceConsent(signed.event.command);
    if(details){
      const entry=store.get(entryId);
      const accepted=await desktopConsent.confirm({...details,details:[{label:'服务器',value:entry.name},...details.details]},AbortSignal.timeout(120000));
      if(!accepted)throw new Error('已取消权限修改');
      if(activeWorkspaceEntry(event)!==entryId)throw new Error('服务器已切换，请重新核对权限修改');
      return store.signGovernanceChange(entryId,change);
    }
    return signed;
  });
  ipcMain.handle('workspace:confirm-action',async(event,input)=>{
    const entryId=activeWorkspaceEntry(event);
    if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.title!=='string'||typeof input.message!=='string'||typeof input.acceptLabel!=='string')throw new TypeError('确认操作必须包含标题、说明与按钮文字');
    const accepted=await desktopConsent.confirm({title:input.title,message:input.message,acceptLabel:input.acceptLabel,details:[{label:'服务器',value:requireWorkspace().get(entryId).name}]},AbortSignal.timeout(120000));
    return accepted && activeWorkspaceEntry(event)===entryId;
  });
  ipcMain.handle('workspace:governance-checkpoint',event => requireWorkspace().signGovernanceCheckpoint(activeWorkspaceEntry(event)));
  ipcMain.handle('workspace:commit',(event,document) => {
    const entryId=activeWorkspaceEntry(event),store=requireWorkspace();
    if(steamRoom) {const entry=store.get(entryId);store.saveConnection({...entry.connection,stunUrls:steamRoom.stunUrls},entryId);}
    store.commit(entryId,document);
    if(config.lastWorkspaceEntryId!==entryId) {
      config.lastWorkspaceEntryId=entryId;
      fs.writeFileSync(configPath(),JSON.stringify(config,null,2),'utf8');
    }
    return {ok:true};
  });
  ipcMain.handle('workspace:conflict',(event,candidates) => {requireWorkspace().preserveConflict(activeWorkspaceEntry(event),candidates);return {ok:true};});
  ipcMain.handle('workspace:copy-invite',async(event,channelId) => {
    activeWorkspaceEntry(event);
    if(typeof channelId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(channelId)) throw new TypeError('无效的频道 ID');
    const entry=requireWorkspace().get(activeEntryId);
    const address=steamRoom?.invite || directRoom?.invite || entry.connection.invite || entry.connection.address;
    if(!address) throw new Error('当前服务器没有可用的邀请地址');
    const invite=new URL(address);
    const fragment=new URLSearchParams(invite.hash.slice(1));fragment.set('channel',channelId);
    if(entry.roomId&&entry.creatorKey&&contentVault){
      const secret=(await contentVault).exportSecret({version:1,roomId:entry.roomId,creatorKey:entry.creatorKey});
      if(secret){
        const accepted=await desktopConsent.confirm({title:'分享加密房间邀请',message:'邀请包含房间解密密钥；收到链接的人可读取此房间的全部历史。请只发给可信的人。',details:[{label:'服务器',value:entry.name},{label:'频道 ID',value:channelId}],acceptLabel:'复制含密钥的邀请'},AbortSignal.timeout(120000));
        if(!accepted)throw new Error('已取消复制加密邀请');
        if(activeWorkspaceEntry(event)!==entry.id)throw new Error('服务器已切换，邀请未复制');
        fragment.set('content',secret);
      }
    }
    invite.hash=fragment.toString();
    clipboard.writeText(invite.href);return {ok:true};
  });
  ipcMain.handle('workspace:invited-channel',(event) => {activeWorkspaceEntry(event);return invitedChannelId;});
  const contentOperations={activate: 'activate',prepare:'prepare',signPolicy:'signPolicy',sealChat:'sealChat',openChat:'openChat',sealReaction:'sealReaction',sealMedia:'sealMedia',openMedia:'openMedia'};
  ipcMain.handle('chat-unread:get',event=>{trustedRoomEntry(event);return chatUnread.read();});
  ipcMain.handle('chat-unread:save',(event,input)=>{trustedRoomEntry(event);return chatUnread.save(input);});
  ipcMain.handle('preferences:get',event=>{trustedRoomEntry(event);return clientPreferences.read();});
  ipcMain.handle('preferences:local-interface',event=>{
    assertBootstrap(event);
    const settings=clientPreferences.read().settings;
    return settings ? {selection:settings.interfaceSelection,theme:settings.localTheme,profile:settings.interfaceProfile} : null;
  });
  ipcMain.handle('customization:server-interactions',async(event,roomId)=>{trustedRoomEntry(event);const entry=requireWorkspace().get(activeWorkspaceEntry(event));if(!entry||entry.roomId!==roomId)throw new Error('互动目录仅可读取当前服务器');return {...customizationStore.interactionDirectory(roomId),...await resourcePacks.interactionDrafts(roomId)};});
  ipcMain.handle('customization:interfaces',async event=>{trustedRoomEntry(event);return {directory:customizationStore.directory('interfaces'),schemes:await resourcePacks.interfaceSchemes()};});
  ipcMain.handle('customization:interaction-asset',async(event,input)=>{
    trustedRoomEntry(event);const entry=requireWorkspace().get(activeWorkspaceEntry(event));
    if(!input||typeof input!=='object'||Array.isArray(input)||input.roomId!==entry?.roomId||typeof input.interactionId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(input.interactionId)||typeof input.sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.sha256))throw new TypeError('互动缩略图请求必须对应当前服务器及有效内容指纹');
    const data=await resourcePacks.interactionAssetForServer(input.roomId,input.interactionId,input.sha256);return data?{data:data.toString('base64')}:null;
  });
  ipcMain.handle('customization:open-directory',async(event,kind)=>{
    trustedRoomEntry(event);
    const directory=customizationStore.directory(kind),error=await shell.openPath(directory);
    if(error)throw new Error('Cannot open customization directory '+directory+': '+error);
  });
  registerRadioMetadataIpc({ipcMain,assertSender:trustedRoomEntry,access:radioAccess});
  registerNotificationSoundIpc({ipcMain,dialog,directory:app.getPath('userData'),assertSender:trustedRoomEntry});
  ipcMain.handle('preferences:settings',(event,input)=>{trustedRoomEntry(event);clientPreferences.saveSettings(input);});
  ipcMain.handle('preferences:channel',(event,input)=>{trustedRoomEntry(event);clientPreferences.saveLastChannel(input);});
  ipcMain.handle('room-password:get',async event=>{trustedRoomEntry(event);return serverConnection?(await requireRoomCredentials()).read(serverConnection.origin):null;});
  ipcMain.handle('room-password:set',async(event,input)=>{trustedRoomEntry(event);if(!serverConnection)throw new Error('此房间使用独立邀请，不保存服务器访问口令');const origin=serverConnection.origin;await (await requireRoomCredentials()).save(origin,input);});
  for(const [channel,method] of Object.entries(contentOperations))ipcMain.handle('content:'+channel,async(event,input)=>{
    const entryId=activeWorkspaceEntry(event),origin=new URL(event.senderFrame.url).origin;
    if(process.platform!=='win32'||origin!==(roomClient?.origin||steamRoom?.origin))throw new Error('加密操作仅允许当前 Windows 客户端的本机房间界面发起');
    if(!contentService)throw new Error('房间加密服务尚未初始化');
    if(method==='signPolicy'){
      const entry=requireWorkspace().get(entryId),digest=entry.governance?.digest;
      const accepted=await desktopConsent.confirm({title:'启用房间端到端加密',message:'迁移后只接受支持加密的客户端。旧明文副本无法追溯收回，新成员通过邀请可读取全部历史。',details:[{label:'服务器',value:entry.name}],acceptLabel:'签署加密迁移'},AbortSignal.timeout(120000));
      if(!accepted)throw new Error('已取消加密迁移');
      if(activeWorkspaceEntry(event)!==entryId || requireWorkspace().get(entryId).governance?.digest!==digest)throw new Error('确认期间服务器或权限已变化，请重新发起加密迁移');
    }
    return contentService[method](entryId,input);
  });
  ipcMain.handle('config:get', (event) => {
    assertBootstrap(event);
    return ({
    serverUrl: pendingUrl || config.serverUrl || '',
    autoConnect: config.autoConnect !== false,
    defaultServer: '',
    version: app.getVersion(),
    electron: process.versions.electron,
    directAddresses: direct.localAddresses(),
  }); });

  registerConnectionAction('server:connect', async (event, rawUrl) => {
    assertBootstrap(event);
    const url = normalizeServerUrl(rawUrl);
    if (!url) return { ok: false, error: '服务器地址格式不正确' };
    const parsed = new URL(url);
    if (parsed.hash || parsed.username || parsed.password) return { ok: false, error: '服务器地址不能包含账号、密码或邀请密钥' };
    if (!serverTrust) throw new Error('Server certificate verifier is not initialized');
    const verifiedConnection = await serverTrust.prepareConnection(url);
    if (directCreating) return { ok: false, error: '房间正在创建，请稍候' };
    directCreating = true;
    /** @type {import('./room-client.cjs').RoomClient|null} */let candidate=null;
    try {
      roomTransition = (async () => {
        candidate=await prepareRoomClient({serverDirectory:path.join(__dirname,'app-server'),connection:verifiedConnection});
        if(quitting) throw new Error('软件正在退出，已取消连接');
        const entryId=requireWorkspace().saveConnection({mode:'server',role:'guest',address:url,invite:'',hostAddress:'',hostPort:0,appId:0,stunUrls:[]},selectedEntryId);
        await stopTemporaryRooms();
        roomClient=candidate;activeEntryId=entryId;
      })();
      await roomTransition;
    }
    catch(error) {if(candidate && candidate!==roomClient) await candidate.stop();throw error;}
    finally { directCreating = false; roomTransition = null; }
    config.serverUrl = url;
    pendingUrl = url;
    saveConfig();
    replacingWindow=true;
    if(win) win.destroy();
    directSession=null;steamSession=null;
    serverConnection=verifiedConnection;
    serverSession=session.fromPartition('persist:server-'+createHash('sha256').update(verifiedConnection.origin+'|'+(verifiedConnection.fingerprint ?? 'ca')).digest('hex'));
    setupSession(serverSession);
    createWindow(roomClient ? roomClient.url : url);replacingWindow=false;
    return { ok: true, url };
  });

  ipcMain.handle('ui:bootstrap', (event) => {
    if(!isBootstrap(event)) assertMainFrame(event);
    openConnectionPanel('workspace');
    return { ok: true };
  });

  ipcMain.handle('shell:external', (event, url) => {
    if (/^https?:/i.test(String(url || ''))) shell.openExternal(String(url));
  });

  ipcMain.handle('app:quit', () => {
    quitApp();
  });

  registerConnectionAction('direct:create', async (event, options) => {
    assertBootstrap(event);
    if (directCreating) return { ok: false, error: '房间正在创建，请稍候' };
    directCreating = true;
    const replacingRoom=win && !win.isDestroyed() && /^https?:/.test(win.webContents.getURL());
    /** @type {import('./direct-host.cjs').HostedRoom|null} */let candidate=null;
    /** @type {import('./room-client.cjs').RoomClient|null} */let candidateClient=null;
    try {
      const validated = direct.hostOptions(options);
      directCreation = direct.startRoom({...validated,roomSeed:creationSeed}, app.getPath('userData'), path.join(__dirname, 'app-server'), process.execPath);
      candidate = await directCreation;
      const connection = { role: 'host', origin: `https://localhost:${validated.port}`, fingerprint: candidate.fingerprint, token: candidate.token };
      candidateClient=await prepareRoomClient({serverDirectory:path.join(__dirname,'app-server'),connection});
      if(quitting) throw new Error('软件正在退出，已取消创建');
      const entryId=requireWorkspace().saveConnection({mode:'direct',role:'host',invite:candidate.invite,address:candidate.origin,hostAddress:validated.address,hostPort:validated.port,appId:0,stunUrls:[]},selectedEntryId);
      await stopTemporaryRooms();
      directRoom=candidate;directConnection=connection;roomClient=candidateClient;activeEntryId=entryId;
      candidate.process.once('exit', () => { if(directRoom===candidate) {directRoom = null; if (directConnection?.role === 'host') directConnection = null;} });
      if(replacingRoom) await enterDirect();
      return { ok: true, session: { role: 'host', origin: directRoom.origin, invite: directRoom.invite } };
    } catch (error) {
      if(candidateClient && candidateClient!==roomClient) await candidateClient.stop();
      if(candidate && candidate!==directRoom) await direct.stopRoom(candidate);
      return { ok: false, error: error.message };
    } finally { directCreating = false; directCreation = null; }
  });
  registerConnectionAction('direct:join', async (event, invitation) => {
    assertBootstrap(event);
    if (directCreating) return { ok: false, error: '房间正在创建，请稍候' };
    /** @type {import('./room-client.cjs').RoomClient|null} */let candidate=null;
    try {
      const parsed = direct.parseInvitation(invitation);
      directCreating = true;
      roomTransition = (async()=>{
        candidate=await prepareRoomClient({serverDirectory:path.join(__dirname,'app-server'),connection:parsed});
        if(quitting) throw new Error('软件正在退出，已取消连接');
        const entryId=requireWorkspace().saveConnection({mode:'direct',role:'guest',invite:invitation,address:parsed.origin,hostAddress:'',hostPort:0,appId:0,stunUrls:[]},selectedEntryId);
        await stopTemporaryRooms();
        roomClient=candidate;activeEntryId=entryId;
        directConnection = { role: 'guest', ...parsed };
        await enterDirect();
      })();
      await roomTransition;
      return { ok: true };
    } catch (error) {if(candidate && candidate!==roomClient) await candidate.stop();return { ok: false, error: error.message }; }
    finally { directCreating = false; roomTransition = null; }
  });
  registerConnectionAction('direct:enter', async (event) => {
    assertBootstrap(event);
    if (directCreating) return { ok: false, error: '房间正在创建，请稍候' };
    if (!directRoom || !directConnection || directConnection.role !== 'host') return { ok: false, error: '请先创建房间' };
    directCreating = true;
    try { roomTransition=enterDirect();await roomTransition;return { ok: true }; }
    catch(error) {return {ok:false,error:error.message};}
    finally {directCreating=false;roomTransition=null;}
  });
  registerConnectionAction('steam:create', async (event, options) => {
    assertBootstrap(event);
    if (directCreating) return { ok: false, error: '房间正在创建，请稍候' };
    directCreating = true;
    const replacingRoom=win && !win.isDestroyed() && /^https?:/.test(win.webContents.getURL());
    /** @type {import('./steam-room.cjs').SteamRoom|null} */let candidate=null;
    try {
      if (!options || !Number.isInteger(options.appId) || options.appId < 1 || options.appId > 4294967295 || !Array.isArray(options.stunUrls) || options.stunUrls.some((url) => typeof url !== 'string')) {
        throw new TypeError('Steam AppID 必须是 1–4294967295 的整数，语音发现地址必须是文本列表');
      }
      if(options.stunUrls.length>8 || options.stunUrls.some(url=>url.length>2048 || url.includes(','))) throw new TypeError('最多填写 8 个有效的语音发现地址');
      require('./app-server/lib/network-policy.cjs').readNetworkPolicy({ECHO_NETWORK_MODE:'server',ECHO_MEDIA_POLICY:'direct',STUN_URLS:options.stunUrls.join(',')});
      const { createSteamRoom } = require('./steam-room.cjs');
      steamCreation = createSteamRoom({ appId: options.appId, stunUrls: options.stunUrls, roomSeed:creationSeed }, steamPaths(), reportSteamFailure);
      candidate = await steamCreation;
      if(quitting) throw new Error('软件正在退出，已取消创建');
      const entryId=requireWorkspace().saveConnection({mode:'steam',role:'host',invite:candidate.invite,appId:candidate.appId,stunUrls:candidate.stunUrls,address:'',hostAddress:'',hostPort:0},selectedEntryId);
      await stopTemporaryRooms();
      steamRoom=candidate;activeEntryId=entryId;
      if(replacingRoom) enterSteam();
      return { ok: true, session: steamSessionInfo() };
    } catch (error) {if(candidate && candidate!==steamRoom) await candidate.stop();return { ok: false, error: error.message }; }
    finally { directCreating = false; steamCreation = null; }
  });
  registerConnectionAction('steam:join', async (event, invitation) => {
    assertBootstrap(event);
    if (directCreating) return { ok: false, error: '房间正在创建，请稍候' };
    directCreating = true;
    /** @type {import('./steam-room.cjs').SteamRoom|null} */let candidate=null;
    try {
      if (typeof invitation !== 'string') throw new TypeError('请粘贴完整 Steam 房间邀请');
      const parsed=require('./steam-wire.cjs').parseSteamInvite(invitation);
      if(steamRoom && parsed.lobbyId===steamRoom.lobbyId && parsed.appId===steamRoom.appId) {
        if(parsed.token!==require('./steam-wire.cjs').parseSteamInvite(steamRoom.invite).token) throw new Error('邀请密钥与当前 Steam 房间不一致');
        enterSteam();return {ok:true};
      }
      const { joinSteamRoom } = require('./steam-room.cjs');
      steamCreation = joinSteamRoom(invitation, steamPaths(), reportSteamFailure);
      candidate = await steamCreation;
      if(quitting) throw new Error('软件正在退出，已取消连接');
      const entryId=requireWorkspace().saveConnection({mode:'steam',role:'guest',invite:candidate.invite,appId:candidate.appId,stunUrls:candidate.stunUrls,address:'',hostAddress:'',hostPort:0},selectedEntryId);
      await stopTemporaryRooms();
      steamRoom=candidate;activeEntryId=entryId;
      enterSteam();
      return { ok: true };
    } catch (error) {if(candidate && candidate!==steamRoom) await candidate.stop();return { ok: false, error: error.message }; }
    finally { directCreating = false; steamCreation = null; }
  });
  registerConnectionAction('steam:enter', (event) => {
    assertBootstrap(event);
    if (directCreating) return { ok: false, error: '房间正在创建，请稍候' };
    if (!steamRoom) return { ok: false, error: '请先创建 Steam 房间' };
    enterSteam();
    return { ok: true };
  });
  ipcMain.handle('steam:session', (event) => {
    if (!isBootstrap(event)) {
      if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !steamSession || !steamRoom) return null;
      if (new URL(event.senderFrame.url).origin !== steamRoom.origin) return null;
    }
    return steamSessionInfo();
  });
  ipcMain.handle('direct:session', (event) => {
    if (!authorizedDirect(event)) return null;
    if (directRoom && directConnection && directConnection.role === 'host') return { role: 'host', origin: directRoom.origin, invite: directRoom.invite };
    if (directConnection && directConnection.role === 'guest' && !isBootstrap(event)) return { role: 'guest', origin: directConnection.origin };
    return null;
  });
}

/** @returns {{userData:string,serverDirectory:string,executable:string}} */
function steamPaths() {
  return { userData: app.getPath('userData'), serverDirectory: path.join(__dirname, 'app-server'), executable: process.execPath };
}

/** @param {string} message @returns {void} */
function reportSteamFailure(message) {
  console.error('Steam room connection failed', { message });
}

/** @returns {{role:'host'|'guest',invite:string,appId:number,lobbyId:string,origin:string}|null} */
function steamSessionInfo() {
  if (!steamRoom) return null;
  const { role, invite, appId, lobbyId, origin } = steamRoom;
  return { role, invite, appId, lobbyId, origin };
}

/** @returns {Promise<void>} */
async function stopTemporaryRooms() {
  await Promise.all([capture.stopAllCapture(),screenRelay.stopScreenRelay()]);
  await stopRoomClient();
  if (steamRoom) {
    await steamRoom.stop();
    steamRoom = null;
  }
  if (directRoom) {
    await direct.stopRoom(directRoom);
    directRoom = null;
  }
  directConnection = null;
}

/** @returns {Promise<void>} */
async function stopRoomClient() {
  const current = roomClient;
  roomClient = null;
  if (roomClientShutdown) await roomClientShutdown;
  if (!current) return;
  const cleanup = current.stop();
  roomClientShutdown = cleanup;
  await cleanup;
  if (roomClientShutdown === cleanup) roomClientShutdown = null;
}

/** @returns {void} */
function enterSteam() {
  if (!steamRoom) throw new Error('没有待加入的 Steam 房间');
  if(win && !win.isDestroyed() && steamSession && personalStickerOrigin===steamRoom.origin) {win.show();win.focus();return;}
  steamSession = session.fromPartition('steam-' + require('node:crypto').randomUUID());
  directSession = null;
  serverSession = null;
  serverConnection = null;
  setupSession(steamSession);
  replacingWindow = true;
  if (win) win.destroy();
  createWindow(steamRoom.url);
  replacingWindow = false;
}

/** @param {Electron.IpcMainInvokeEvent} event @returns {boolean} */
function isBootstrap(event) {
  const owner=[win,connectionPanel].find(candidate => candidate && !candidate.isDestroyed() && event.sender===candidate.webContents && event.senderFrame===candidate.webContents.mainFrame);
  if(!owner || !event.senderFrame) return false;
  const target=new URL(event.senderFrame.url);target.search='';target.hash='';
  return [bootstrapUrl,workspaceUrl,connectionsUrl].includes(target.href);
}

/** @param {Electron.IpcMainInvokeEvent} event @returns {void} */
function assertBootstrap(event) {
  if (!isBootstrap(event)) throw new Error('此操作只能从本地连接页面发起');
}

ipcMain.handle('window:visibility',event=>{assertMainFrame(event);return !!win&&win.isVisible()&&!win.isMinimized();});

/** @param {Electron.IpcMainInvokeEvent} event @returns {void} */
function assertMainFrame(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('此操作只能从当前客户端主页面发起');
}

/** @param {Electron.IpcMainInvokeEvent} event @returns {void} */
function assertPersonalStickerFrame(event) {
  assertMainFrame(event);
  if(!personalStickerOrigin || new URL(event.senderFrame.url).origin!==personalStickerOrigin) throw new Error('Personal stickers require the current trusted room main frame');
}

/** @param {Electron.IpcMainInvokeEvent} event @returns {boolean} */
function authorizedDirect(event) {
  if (isBootstrap(event)) return true;
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !directSession || !directConnection) return false;
  return new URL(event.senderFrame.url).origin === (roomClient ? roomClient.origin : directConnection.origin);
}

/** @returns {Promise<void>} */
async function enterDirect() {
  if (!directConnection) throw new Error('没有待加入的直连房间');
  if(!roomClient) throw new Error('直连房间尚未通过连接检查');
  if(win && !win.isDestroyed() && directSession && personalStickerOrigin===roomClient.origin) {win.show();win.focus();return;}
  const url = `${roomClient ? roomClient.url : directConnection.origin + '/'}#invite=${directConnection.token}`;
  steamSession = null;
  serverSession = null;
  serverConnection = null;
  directSession = session.fromPartition('direct-' + require('node:crypto').randomUUID());
  setupSession(directSession);
  replacingWindow = true;
  if (win) win.destroy();
  createWindow(url);
  replacingWindow = false;
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    loadConfig();
    desktopConsent=createDesktopConsent({getWindow:()=>win,timeoutMs:120000});
    roomPermissions=createRoomPermissions({getWindow:()=>win,getRoom:()=>personalStickerOrigin ? {origin:personalStickerOrigin,source:steamSession && steamRoom?.origin===personalStickerOrigin ? 'bundled':'remote'} : null,confirm:(details,signal)=>desktopConsent.confirm({...details,details:details.details.map(detail=>({...detail,value:detail.value===personalStickerOrigin ? serverConnection?.origin || directConnection?.origin || detail.value : detail.value}))},signal)});
    serverTrust=createServerTrust({storePath:path.join(app.getPath('userData'),'server-trust.json'),timeoutMs:8000,logger:{warn:(message,fields)=>console.warn(message,fields)},requestConsent:details=>desktopConsent.confirm({title:'核对服务器证书',message:'这是服务器自己的证书。请通过其他可信渠道与服主核对指纹；确认后只信任这一张证书，证书变化将阻止连接。',details:[{label:'服务器',value:details.origin},{label:'SHA-256 指纹',value:details.fingerprint.match(/.{1,2}/g).join(':')},{label:'证书名称',value:details.subject},{label:'签发者',value:details.issuer},{label:'有效期',value:details.validFrom+' — '+details.validTo}],acceptLabel:'指纹一致，信任此证书'},AbortSignal.timeout(120000))});
    workspace=createWorkspaceStore(app.getPath('userData'));
    clientPreferences=createClientPreferences(app.getPath('userData'));
    chatUnread=createChatUnreadStore(app.getPath('userData'));
    resourceRoot=resolveResourceRoot({executable:process.execPath,developmentDirectory:path.dirname(__dirname),packaged:app.isPackaged,override:process.env.DEEPSCORD_RESOURCE_ROOT??(process.env.DEEPSCORD_USER_DATA?path.join(app.getPath('userData'),'mods'):null)});
    initializePortableResources({root:resourceRoot,legacyUserData:app.getPath('userData')});
    const bundledCustomization=path.join(__dirname,'app-server','public','customization');
    customizationStore=createCustomizationStore(resourceRoot,bundledCustomization);
    customizationStore.directory('interfaces');customizationStore.directory('interactions');
    const guideTarget=path.join(resourceRoot,'RESOURCE_PACKS.md'),guideStat=fs.lstatSync(guideTarget,{throwIfNoEntry:false});
    if(guideStat&&(guideStat.isSymbolicLink()||!guideStat.isFile()))throw new TypeError('Resource guide must be a regular file: '+guideTarget);
    fs.copyFileSync(path.join(bundledCustomization,'RESOURCE_PACKS.md'),guideTarget);
    contentService=createContentService({workspace,getVault:requireContentVault});
    startupRestorePending=config.lastWorkspaceEntryId!==undefined && config.lastWorkspaceEntryId!==null;
    desktopFeatures = createDesktopFeatures({ getWindow:() => win, userData:app.getPath('userData') });
    const shortcutStatus = desktopFeatures.getShortcutStatus();
    if (shortcutStatus.error) dialog.showErrorBox('全局麦克风快捷键不可用，请在设置中修改', shortcutStatus.error);
    setupSession(session.defaultSession);
    setupIpc();
    createWindow('');
    createMenu();
    createTray();

    app.on('activate', () => {
      if (!win) createWindow('');
      else {
        win.show();
        win.focus();
      }
    });
  }).catch((error) => {
    console.error('desktop_initialization_failed',{message:error.message,stack:error.stack});
    dialog.showErrorBox('桌面功能初始化失败', error.message);
    quitting = true;
    app.quit();
  });

  let captureQuitComplete = false;
  let unreadQuitComplete = false;
  let captureShutdown = null;
  app.on('before-quit', (event) => {
    quitting = true;
    if(activeConnectionOperation) {
      event.preventDefault();
      desktopConsent?.destroy();
      activeConnectionOperation.then(()=>app.quit(),()=>app.quit());
      return;
    }
    if (directCreation || steamCreation || roomTransition) {
      event.preventDefault();
      (directCreation || steamCreation || roomTransition).then(() => app.quit(), () => app.quit());
      return;
    }
    if (!captureQuitComplete) {
      event.preventDefault();
      roomPermissions?.reset();
      desktopConsent?.destroy();
      if (!captureShutdown) captureShutdown = Promise.all([capture.stopAllCapture(), screenRelay.stopScreenRelay(), (async()=>{if(resourceManager)await resourceManager.destroy();if(personalStickers)await personalStickers.destroy();})()]).then(() => {
        captureQuitComplete = true;
        app.quit();
      }).catch((error) => {
        captureShutdown = null;
        quitting = false;
        dialog.showErrorBox('桌面资源未能正常关闭', error.message);
      });
      return;
    }
    if (roomShutdown) { event.preventDefault(); return; }
    if (directRoom || steamRoom || roomClient || roomClientShutdown) {
      event.preventDefault();
      roomShutdown = stopTemporaryRooms();
      roomShutdown.then(() => { roomShutdown = null; app.quit(); }).catch((error) => {
        roomShutdown = null;
        dialog.showErrorBox('房间未能停止', error.message);
        quitting = false;
      });
      return;
    }
    if (chatUnread && !unreadQuitComplete) {
      event.preventDefault();
      chatUnread.close().then(() => {unreadQuitComplete=true;app.quit();}).catch(error => {
        quitting=false;
        dialog.showErrorBox('未读状态未能保存',error.message);
      });
    }
  });

  app.on('will-quit', () => {
    contentService?.close();
    if (desktopFeatures) { desktopFeatures.dispose(); desktopFeatures = null; }
  });

  app.on('window-all-closed', () => {
    if (replacingWindow) return;
    if (process.platform !== 'darwin') app.quit();
  });
}
