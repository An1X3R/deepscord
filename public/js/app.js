import {reconcileMarkup} from './dom-reconcile.js';
import {needsGovernanceCheckpoint} from './governance-checkpoint.js';
/* Deepscord — 主应用 */

import { $, $$, el, esc, colorFor, initials, fmtTime, fmtDay, renderText, store, debounce, clamp } from './util.js';
import { icon } from './icons.js';
import {installPresentationVisibility,isPresentationHidden} from './presentation-visibility.js';
import { Socket } from './ws.js';
import { VoiceEngine } from './voice.js';
import { parseNetworkConfig, parsePublicConfig } from './network-protocol.js';
import { openSettingsPanel, loadSettings, saveSettings, keyLabel } from './settings.js';
import { openModal, confirmDialog, promptDialog, toast, toggleMembersPanel } from './ui.js';
import { loadProfile, saveProfile, createProfile, profilePayload } from './profile.js';
import { createMediaUI, attachQuickVolume } from './media-ui.js';
import { listScreenSources, listAudioProcesses, captureScreen, ProcessAudioCapture } from './desktop-capture.js';
import { ScreenRoomRequests } from './screen-room.js';
import { exportScreenDiagnostics, getScreenDiagnosticReports } from './screen-diagnostics.js';
import { getScreenPreferences } from './screen-preferences.js';
import { installWorkspaceNavigation, showRoomConflict } from './room-workspace-ui.js';
import { parseServerState, parseIdentityChallenge, canPerform, canModerateMember, roleLabel, openGovernancePanel } from './server-governance-ui.js';
import { createChatView, parseChatMessage } from './chat-view.js';
import {createChatMediaClient} from './chat-media-client.js';
import {createChatMedia} from './chat-media.js';
import {createBrowserIdentity} from './browser-identity.js';
import {parseReactions,mediaId,mediaInteger,mediaObject,MEDIA_LIMITS} from './chat-protocol.js';
import { createPokeAudio } from './poke-audio.js';
import { createDesktopPoke } from './poke-desktop.js';
import { createInteractionAudio } from './interaction-audio.js';
import {configureInterfaceCommands,publishInterfaceState,clearInterfacePackage} from './interface-package.js';
import { createInteractionUI } from './interaction-ui.js';
import { createInteractionRenderer } from './interaction-renderer.js';
import { canManageServerCatalog, customInteractions } from './customization-protocol.js';
import {createRadioClient} from './radio-client.js';
import {createRadioFields} from './radio-ui.js';
import {canManageMember,memberTitles} from './member-permissions.js';
import {initInterfaceProfile,applyInterfaceProfile} from './interface-profile.js';
import {applyInterfaceSelection,clearSchemeVariables,listInterfaceSchemes} from './interface-scheme-runtime.js';
import {resolveInterfaceScheme} from './interface-scheme.js';
import {openCustomizationDirectory} from './developer-guides.js';
import { applyCustomizationTheme } from './customization-theme.js';
import { openCustomizationPanel } from './customization-ui.js';
import { createInteractionThumbnailQueue } from './interaction-thumbnail-queue.js';
import {createContentClient} from './content-client.js';
import {parseContentPolicy,mapContentAsset} from './content-protocol.js';
import {openContentSettings} from './content-settings.js';

/* -------------------------------------------------------------------- */
/* 状态                                                                  */
/* -------------------------------------------------------------------- */

const state = {
  selfId: null,
  users: new Map(),
  servers: [],
  messages: new Map(),
  activeServerId: null,
  activeChannelId: null,
  voiceChannelId: null,
  desiredVoiceChannelId: null,
  settings: loadSettings(),
  latency: null,
  connStatus: 'connecting',
  config: { iceServers: [] },
  requirePassword: false,
  password: '',
  peerStates: new Map(),
  speaking: new Set(),
  helloSent: false,
  roomReady: false,
  resumeToken: null,
  pendingVoiceChannelId: null,
  invitationSession: false,
  steamSession: false,
  profile: null,
  desktopSettings: null,
};

let socket = null;
let engine = null;
let booted = false;
let soundCtx = null;
let networkRefresh = null;
let voiceJoinSequence = 0;
let pttPrevMuted = null;
let mediaRenderScheduled = false;
let linkMeasurementPending = false;
let chatView = null;
/** @type {Awaited<ReturnType<typeof createChatMedia>>|null} */let chatMedia=null;
/** @type {Awaited<ReturnType<typeof createBrowserIdentity>>|null} */let browserIdentity=null;
/** @type {Promise<Awaited<ReturnType<typeof createBrowserIdentity>>>|null} */let browserIdentityPromise=null;
let reactionActorId=null;
let authorKeys=new Map();
let textSendPending=false;
const chatMediaClient=createChatMediaClient({send:frame=>state.roomReady && socket?.send(frame)===true,isReady:()=>state.roomReady && state.connStatus==='open'});
const contentClient=createContentClient(window.deepscord ?? null);
let contentInitialization=Promise.resolve();
let contentMessages=Promise.resolve();
let contentConnectionGeneration=0;
let contentLocalMigration=false;
let contentMigrating=false;
let roomDescriptor=null;
let transportContext=null;
/** @type {Set<{digest:string,resolve:()=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}>} */const governanceWaiters=new Set();
/** @type {import('./server-governance-ui.js').ServerState|null} */
let serverGovernance = null;
let governanceCheckpointPending = false;
let governanceCheckpointAttempt = '';
let governanceGeneration = 0;
let governanceUpdateSequence = 0;
let identityStatus = '';
let governanceView = null;
let governanceViewDomainId = null;
const disposeInterfaceProfile=initInterfaceProfile(state.settings.interfaceProfile);
configureInterfaceCommands(command=>{if(command==='toggleMic')return toggleMute();if(command==='toggleDeafen')return toggleDeafen();const id={settings:'railSettingsBtn',serverMenu:'serverMenuBtn',toggleMembers:'toggleMembers'}[command];const button=document.getElementById(id);if(!button)throw new Error('主题操作入口不可用：'+command);button.click();});
window.addEventListener('deepscord-theme-error',event=>{if(event instanceof CustomEvent)toast('主题脚本错误：'+event.detail.message,'error',7000);});
applySavedInterface();
let customizationView = null;
let customizationSaving = false;
let customizationEpoch = 0;
let refreshCustomizationAudio = () => {};
let interactionCatalogKey = '';
let roomSyncGeneration = 0;
let roomSyncRound = null;
let roomConflictDialog = null;
const screenRoom = new ScreenRoomRequests((request) => state.roomReady && socket?.send(request) === true, () => state.config.screen?.mode === 'sfu' ? state.config.screen.url : null);

const dom = {};
const interactionThumbnails = createInteractionThumbnailQueue(async (asset, signal) => {
  if (!chatMedia) throw new Error('媒体资源尚未就绪，请稍后重试');
  return chatMedia.loadInteractionThumbnail(asset, signal);
});
const pokeAudio = createPokeAudio({ getOutput: () => ({ volume: state.settings.outVolume, deafened: !engine?.inVoice || engine.deafened, deviceId: state.settings.outputDeviceId }), getPeerVolume: id => engine?.getPeerVolume(id) ?? 100, reportError: reportNetworkError });
const interactionAudio = createInteractionAudio({
  resolveCustom: (id, revision) => engine?.interactions.resolveCustom(id, revision) ?? null,
  getSettings: () => ({ enabled: state.settings.sounds && state.settings.interactionSounds, volume: state.settings.interactionVolume }),
  getOutput: () => ({ volume: state.settings.outVolume, deafened: !engine?.inVoice || engine.deafened, deviceId: state.settings.outputDeviceId }),
  getPeerVolume: id => engine?.getPeerVolume(id) ?? 100, reportError: reportNetworkError,
});
const interactionRenderer = createInteractionRenderer({
  resolveCustom: (id, revision) => engine?.interactions.resolveCustom(id, revision) ?? null,
  loadThumbnail: loadInteractionThumbnail, reportError: reportNetworkError,
  getAvatar: id => {
    if (!engine?.inVoice || state.activeChannelId !== engine.channelId || dom.stage?.hidden) return null;
    const card = [...(dom.stageGrid?.children ?? [])].find(node => node.dataset.userId === id);
    return card?.querySelector('.tile-avatar') ?? null;
  },
  onImpact: event => {
    if (engine?.channelId === event.channelId && state.selfId) interactionAudio.play(event, state.selfId).catch(reportNetworkError);
  },
});
const interactionUI = createInteractionUI({
  getCatalog: () => engine?.interactions.getCatalog() ?? [],
  loadThumbnail: loadInteractionThumbnail,
  getSelfId: () => state.selfId ?? '',
  getChannelId: () => engine?.inVoice && state.activeChannelId === engine.channelId ? engine.channelId : null,
  canThrow: id => engine?.interactions.canThrow(id) === true && engine.peers.get(id)?.link.interactionControl.readyState === 'open',
  onThrow: (id, kind) => {
    if (!engine?.inVoice) throw new Error('请先加入语音频道再使用互动道具');
    engine.interactions.throwAt(id, kind);
  },
  reportError: reportNetworkError,
});
/** @returns {boolean} */
function interactionSoundEnabled() {
  return Boolean(engine?.inVoice && state.settings.sounds && state.settings.interactionSounds && state.settings.interactionVolume > 0);
}
/** @returns {void} */
function syncInteractionTimers() {
  if (!interactionSoundEnabled()) interactionRenderer.silence();
  else if (state.selfId && (engine?.deafened || state.settings.outVolume === 0)) interactionRenderer.silenceSender(state.selfId);
}
/** @returns {void} */
function refreshInteractionAudio() {
  syncInteractionTimers();
  interactionAudio.refresh().catch(reportNetworkError);
  refreshCustomizationAudio();
  radioClient.refreshOutput();
}
window.addEventListener('deepscord-settings-changed', refreshInteractionAudio);
/** @param {import('./chat-protocol.js').MediaMetadata} asset @param {AbortSignal} signal */
async function loadInteractionThumbnail(asset, signal) {
  return interactionThumbnails.load(asset, signal);
}
function applySavedInterface(){
  if(state.settings.interfaceSelection)applyInterfaceSelection(state.settings.interfaceSelection);
  else{clearInterfacePackage();clearSchemeVariables();applyCustomizationTheme(state.settings.localTheme);applyInterfaceProfile(state.settings.interfaceProfile);}
}
function refreshCustomization() {
  if (!customizationView) applySavedInterface();
  if (!engine) return;
  const domainId = findChannel(engine.channelId)?.server.id ?? null;
  const entries = engine.inVoice && serverGovernance ? customInteractions(serverGovernance.policy, domainId) : [];
  const key = JSON.stringify([domainId, entries]);
  if (key === interactionCatalogKey) return;
  interactionCatalogKey = key;
  engine.interactions.setCatalog(entries).catch(error => { if (interactionCatalogKey === key) interactionCatalogKey = ''; reportNetworkError(error); });
}
/** @param {'theme'|'interactions'} initialTab */
function openServerCustomization(initialTab) {
  if (!serverGovernance?.selfKey || initialTab==='interactions' && !canManageServerCatalog(serverGovernance.policy, serverGovernance.selfKey)) return;
  customizationView?.close();
  const epoch = ++customizationEpoch;
  const generation = governanceGeneration;
  let previewEntry = null;
  const previewRevision = '0'.repeat(64);
  const resolvePreview = (id, revision) => previewEntry?.id === id && revision === previewRevision ? previewEntry : null;
  const previewAudio = createInteractionAudio({ getSettings: () => ({ enabled: state.settings.sounds && state.settings.interactionSounds, volume: state.settings.interactionVolume }), getOutput: () => ({ volume: state.settings.outVolume, deafened: engine?.deafened ?? false, deviceId: state.settings.outputDeviceId }), getPeerVolume: () => 100, reportError: reportNetworkError, resolveCustom: resolvePreview });
  const previewRenderer = createInteractionRenderer({ getAvatar: id => document.getElementById(id === 'preview-from' ? 'customizationPreviewFrom' : 'customizationPreviewTo'), onImpact: event => previewAudio.play(event, 'preview-from').catch(reportNetworkError), resolveCustom: resolvePreview, loadThumbnail: loadInteractionThumbnail, reportError: reportNetworkError });
  function restoreTheme() { if(epoch===customizationEpoch)applySavedInterface(); }
  refreshCustomizationAudio = () => {
    if(engine?.deafened || !state.settings.sounds || !state.settings.interactionSounds || state.settings.interactionVolume===0 || state.settings.outVolume===0)previewRenderer.silence();
    previewAudio.refresh().catch(reportNetworkError);
  };
  function context() {
    if (epoch!==customizationEpoch || generation !== governanceGeneration || !state.roomReady || !serverGovernance?.selfKey) throw new Error('服务器连接或身份已变化，请重新打开自定义面板');
    return { roomId:serverGovernance.server.id, policy: serverGovernance.policy, selfKey: serverGovernance.selfKey, serverName: serverGovernance.server.name, domains: state.servers.map(domain => ({ id: domain.id, name: domain.name })), domainId: state.activeServerId };
  }
  customizationView = openCustomizationPanel({
    getContext: context, initialTab,
    listInteractionDrafts:async()=>{const current=context();if(typeof window.deepscord?.listServerInteractions!=='function')throw new Error('读取本机待上传互动定义需要使用 Windows 桌面客户端。');const result=await window.deepscord.listServerInteractions(current.roomId);context();return result;},
    openInteractionDirectory:()=>openCustomizationDirectory('interactions',typeof window.deepscord?.openCustomizationDirectory==='function'?window.deepscord:null),
    openResourceManager:async()=>{context();if(typeof window.deepscord?.openResourceManager!=='function')throw new Error('资源管理需要使用 Windows 桌面客户端。');await window.deepscord.openResourceManager();context();},
    getInterfaceProfile:()=>state.settings.interfaceProfile,
    getInterfaceSelection:()=>state.settings.interfaceSelection,
    listSchemes:()=>listInterfaceSchemes(typeof window.deepscord?.listInterfaceSchemes==='function'?window.deepscord:null),
    openSchemeDirectory:()=>openCustomizationDirectory('interfaces',typeof window.deepscord?.openCustomizationDirectory==='function'?window.deepscord:null),
    previewInterfaceSelection:applyInterfaceSelection,
    saveInterfaceSelection:async selection=>{const resolved=resolveInterfaceScheme(selection.scheme,selection.values);const next={...state.settings,localTheme:resolved.theme,interfaceProfile:resolved.interfaceProfile,interfaceSelection:{scheme:selection.scheme,values:resolved.values}};saveSettings(next);state.settings=next;},
    modal: options => openModal({ ...options, onClose: () => { options.onClose(); previewRenderer.destroy(); previewAudio.close().catch(reportNetworkError); if(epoch===customizationEpoch){customizationView = null; refreshCustomizationAudio=()=>{}; restoreTheme();} } }),
    submit: async (command,signal) => {
      const current = context();
      /** @returns {void} */
      function assertCurrent(){signal.throwIfAborted();const latest=context();if(latest.roomId!==current.roomId||latest.selfKey!==current.selfKey||!('domainId' in command)||command.domainId!==null||!canManageServerCatalog(latest.policy,latest.selfKey))throw new Error('服务器连接、身份或管理权限已变化，请重新打开自定义面板');}
      assertCurrent();
      let published=command;
      if(command.type==='putInteraction'&&command.interaction.thumbnail&&typeof window.deepscord?.readInteractionDraftAsset==='function'){
        const asset=await window.deepscord.readInteractionDraftAsset({roomId:current.roomId,interactionId:command.interaction.id,sha256:command.interaction.thumbnail.sha256});assertCurrent();
        if(asset!==null){
          const row=mediaObject(asset,'Imported interaction thumbnail'),encoded=row.data;
          if(typeof encoded!=='string'||!encoded.length||encoded.length>Math.ceil(MEDIA_LIMITS.server.bytes/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw new TypeError('Imported interaction thumbnail requires bounded canonical AVIF base64');
          const decoded=atob(encoded);if(btoa(decoded)!==encoded||decoded.length!==command.interaction.thumbnail.bytes)throw new TypeError('Imported interaction thumbnail differs from its declared byte count');
          const media=chatMedia;if(!media)throw new Error('媒体资源尚未就绪');
          const file=new File([Uint8Array.from(decoded,character=>character.charCodeAt(0))],command.interaction.id+'.avif',{type:'image/avif'});
          const thumbnail=await media.prepareInteractionThumbnail(file,null,signal);assertCurrent();if(chatMedia!==media)throw new Error('媒体会话已变化，请重新打开自定义面板');
          published={...command,interaction:{...command.interaction,thumbnail}};
        }
      }
      assertCurrent();
      customizationSaving = true;
      try { await submitGovernance(published);assertCurrent(); } finally { customizationSaving = false; }
      restoreTheme();
    },
    prepareThumbnail: (file, domainId, signal) => { context(); if (!chatMedia) throw new Error('媒体资源尚未就绪'); return chatMedia.prepareInteractionThumbnail(file, domainId, signal); },
    loadThumbnail: loadInteractionThumbnail,
    previewTheme: applyCustomizationTheme, restoreTheme,
    cancelPreview: () => { previewRenderer.clear(); previewAudio.stop(); },
    previewInteraction: entry => { previewRenderer.clear(); previewAudio.stop(); previewEntry = entry; previewRenderer.play({ eventId: crypto.randomUUID(), channelId: 'preview', fromUserId: 'preview-from', toUserId: 'preview-to', kind: 'custom', soundIndex: 0, customId: entry.id, customRevision: previewRevision }); refreshCustomizationAudio(); },
  });
}
function radioContext(channelId) {
  const hit=findChannel(channelId),snapshot=serverGovernance;
  if(!state.roomReady || !hit || hit.channel.type!=='radio' || !snapshot)return null;
  const permission=key=>Boolean(key && (key===hit.channel.radio.creatorKey || key===snapshot.policy.ownerKey || snapshot.policy.serverAdmins?.includes(key) || snapshot.policy.domains.some(domain=>domain.id===hit.server.id && (domain.ownerKey===key || domain.admins.includes(key) || domain.groups.some(group=>group.permissions.includes('manageChannels') && domain.members.some(member=>member.memberKey===key && member.groupIds.includes(group.id)))))));
  return {name:hit.channel.name,radio:hit.channel.radio,canEdit:permission(snapshot.selfKey),privilegedOnline:snapshot.members.some(member=>state.users.get(member.userId)?.signalConnected!==false && permission(member.memberKey)),joined:engine?.inVoice && engine.channelId===channelId,selfKey:snapshot.selfKey,vote:null};
}
const radioClient=createRadioClient({
  getListeningChannel:()=>state.roomReady && state.connStatus==='open' && engine?.inVoice && findChannel(engine.channelId)?.channel.type==='radio'?engine.channelId:null,
  getContext:radioContext,getOutput:()=>({volume:state.settings.outVolume,deviceId:state.settings.outputDeviceId,deafened:engine?.deafened ?? false}),
  getVolume:()=>state.settings.radioVolume,saveVolume:volume=>{state.settings.radioVolume=volume;saveSettings(state.settings);},
  send:frame=>state.roomReady && socket?.send(frame)===true,modal:openModal,
  metadataBridge:window.deepscord?.inspectRadioStation?window.deepscord:null,reportError:reportNetworkError,notify:message=>toast(message,'info'),
});
const desktopPoke = createDesktopPoke({ getSession: () => engine?.poke.state().sessionId ?? null, getState: () => engine?.poke.state() ?? { sessionId: null, peers: [], requests: [], authorized: [] }, getName: id => state.users.get(id)?.name ?? '成员', respond: decision => pokeAction(() => { if (decision.approved) engine?.poke.approve(decision.userId, decision.requestId); else engine?.poke.reject(decision.userId, decision.requestId); }), reportError: reportNetworkError, notify: message => toast(message, 'info') });
/** @param {()=>void} action */
function pokeAction(action) { try { action(); } catch (error) { reportNetworkError(error instanceof Error ? error : new Error(String(error))); } }
const musicCapture = new ProcessAudioCapture(reportNetworkError, () => {
  if (engine) engine.stopAccompaniment().catch(reportNetworkError);
});
/** @param {()=>Promise<MediaStream>} capture @param {AbortSignal} signal @returns {Promise<void>} */
async function startAccompaniment(capture, signal) {
    if (!engine?.inVoice) throw new Error('请先加入语音');
    const owner = engine;
    const channelId = owner.channelId;
    const sequence = voiceJoinSequence;
    const stream = await capture();
    try { if (signal.aborted || sequence !== voiceJoinSequence || engine !== owner || owner.channelId !== channelId || !owner.inVoice) throw new DOMException('伴奏已取消', 'AbortError'); await owner.startAccompaniment(stream); }
    catch (error) { await musicCapture.stop(); throw error; }
    renderStage();
}
const mediaUI = createMediaUI({
  listScreens: listScreenSources,
  listProcesses: listAudioProcesses,
  async startScreen(id, signal) {
    if (!engine?.inVoice) throw new Error('请先加入语音');
    const owner = engine;
    const channelId = owner.channelId;
    const sequence = voiceJoinSequence;
    const stream = await captureScreen(id, getScreenPreferences(state.settings, Boolean(window.deepscord?.screenRelayOffer)));
    try { if (signal.aborted || sequence !== voiceJoinSequence || engine !== owner || owner.channelId !== channelId || !owner.inVoice) throw new DOMException('分享已取消', 'AbortError'); await owner.startScreenShare(stream); }
    catch (error) { for (const track of stream.getTracks()) track.stop(); throw error; }
    const pokeSession = owner.poke.state().sessionId;
    if (pokeSession) {
      try { await desktopPoke.begin(pokeSession, id); }
      catch (error) { await owner.stopScreenShare(); throw error; }
    }
    renderStage();
  },
  async stopScreen() { if (engine) await engine.stopScreenShare(); renderStage(); },
  async startMusic(pid, signal) {
    await startAccompaniment(() => musicCapture.start(pid), signal);
  },
  async startGlobalMusic(signal) {
    await startAccompaniment(() => musicCapture.startGlobal(), signal);
  },
  async stopMusic() { await musicCapture.stop(); if (engine) await engine.stopAccompaniment(); renderStage(); },
  async watch(id) { if (!engine) throw new Error('语音尚未就绪'); if (id !== state.selfId) await engine.watchScreen(id); },
  stopWatching(id) { engine?.stopWatching(id); },
  getScreenStream(id) { return engine?.getScreenStream(id) ?? null; },
  setPeerVolume(id, value) {
    engine?.setPeerVolume(id, value);
    const key = state.users.get(id)?.profileId || location.origin + ':' + id;
    state.settings.peerVolumes = { ...state.settings.peerVolumes, [key]: value };
    saveSettings(state.settings);
  },
  getPeerVolume(id) { return engine?.getPeerVolume(id) ?? 100; },
  poke: {
    getState: () => engine?.poke.state() ?? { sessionId: null, peers: [], requests: [], authorized: [] },
    request: id => pokeAction(() => engine?.poke.request(id)),
    respond: (id, requestId, approved) => pokeAction(() => { if (approved) engine?.poke.approve(id, requestId); else engine?.poke.reject(id, requestId); }),
    revoke: id => pokeAction(() => engine?.poke.revoke(id)),
    revokeAll: () => pokeAction(() => engine?.poke.revokeAll()),
    hit: (id, nx, ny, boom) => pokeAction(() => engine?.poke.hit(id, nx, ny, boom)),
    getName: id => state.users.get(id)?.name ?? '成员',
    getAudio: () => pokeAudio.getSettings(),
    setAudio: settings => pokeAction(() => pokeAudio.setSettings(settings)),
  },
  async exportDiagnostics() {
    if (!engine?.inVoice) throw new Error('请先加入语音后导出屏幕诊断');
    const owner = engine;
    const result = await exportScreenDiagnostics({ capture: owner.screenStream, preferences: owner.screenStream ? owner.screenPreferences() : null, previews: mediaUI.diagnosticPreviews(), getReports: () => getScreenDiagnosticReports(owner.screenTransport) });
    if (result.status === 'saved') toast('屏幕诊断已导出', 'success');
  },
  reportError: reportNetworkError,
});

async function persistIdentity() {
  const original = state.profile || createProfile(state.settings.name, state.settings.color);
  const saved = await saveProfile({ ...original, name: state.settings.name, color: state.settings.color, avatar: state.settings.avatar || null });
  state.profile = saved;
  state.settings.name = saved.name;
  state.settings.color = saved.color;
  state.settings.avatar = saved.avatar;
  saveSettings(state.settings);
}

function syncVoiceOverlay() {
  if (!window.deepscord?.updateVoiceOverlay) return;
  const connected = Boolean(engine?.inVoice);
  const members = connected ? usersInChannel(state.voiceChannelId).map((user) => ({
    id: user.id, name: user.name, color: user.color, avatar: user.avatar || null,
    speaking: state.speaking.has(user.id), muted: user.serverMuted===true || (user.id === state.selfId ? engine.muted : user.muted === true),
  })) : [];
  window.deepscord.updateVoiceOverlay({ connected, members }).catch(reportNetworkError);
}

/* -------------------------------------------------------------------- */
/* 小工具                                                                */
/* -------------------------------------------------------------------- */

function me() {
  return state.users.get(state.selfId) || null;
}

function findServer(serverId) {
  return state.servers.find((s) => s.id === serverId) || null;
}

function findChannel(channelId) {
  for (const srv of state.servers) {
    const channel = srv.channels.find((c) => c.id === channelId);
    if (channel) return { server: srv, channel };
  }
  return null;
}

function activeChannel() {
  const hit = findChannel(state.activeChannelId);
  return hit ? hit.channel : null;
}

function activeServer() {
  return findServer(state.activeServerId) || state.servers[0] || null;
}

function usersInChannel(channelId) {
  return [...state.users.values()]
    .filter((u) => u.voiceChannelId === channelId)
    .sort((a, b) => (a.id === state.selfId ? -1 : b.id === state.selfId ? 1 : a.name.localeCompare(b.name, 'zh')));
}

function sortedOnline() {
  return [...state.users.values()].sort((a, b) => {
    if (a.id === state.selfId) return -1;
    if (b.id === state.selfId) return 1;
    return a.name.localeCompare(b.name, 'zh');
  });
}

function avatarHtml(user, size = 32, cls = '') {
  const color = user.color || colorFor(user.name || user.id);
  const avatar = typeof user.avatar === 'string' && user.avatar.length <= 16407 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(user.avatar)
    ? `<img src="${esc(user.avatar)}" alt="" width="96" height="96" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">` : esc(initials(user.name));
  return `<span class="avatar ${cls}" style="--av-size:${size}px;--av-color:${esc(color)}">${avatar}</span>`;
}

function playTone(kind) {
  if (state.settings.sounds === false) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!soundCtx) soundCtx = new Ctx();
    if (soundCtx.state === 'suspended') soundCtx.resume().catch(() => {});
    const now = soundCtx.currentTime;
    const make = (freq, start, dur, vol = 0.06, type = 'sine') => {
      const osc = soundCtx.createOscillator();
      const gain = soundCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now + start);
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(vol, now + start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain).connect(soundCtx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.05);
    };
    if (kind === 'join') {
      make(523.25, 0, 0.1, 0.05, 'triangle');
      make(783.99, 0.08, 0.14, 0.05, 'triangle');
    } else if (kind === 'leave') {
      make(493.88, 0, 0.1, 0.045, 'triangle');
      make(329.63, 0.08, 0.16, 0.04, 'triangle');
    } else if (kind === 'message') {
      make(880, 0, 0.06, 0.035, 'sine');
    } else if (kind === 'error') {
      make(220, 0, 0.18, 0.05, 'square');
    }
  } catch (_) {
    /* ignore */
  }
}

function reportNetworkError(error) {
  console.error('Network operation failed', { name: error.name, message: error.message });
  toast(error.message || '网络操作失败', 'error', 6000);
}

function scheduleNetworkRefresh() {
  clearTimeout(networkRefresh);
  const delay = state.config.iceExpiresAt === null ? 900000 : Math.max(1000, Math.min(900000, state.config.iceExpiresAt * 1000 - Date.now() - 30000));
  networkRefresh = setTimeout(() => {
    if (!state.roomReady || !socket.send({ t: 'refreshNetwork' })) {
      reportNetworkError(new Error('房间离线，无法续期中继凭据；请恢复房间连接'));
    }
  }, delay);
}

function applyNetworkConfig(config) {
  try {
    const next = roomNetworkConfig(config);
    engine.updateNetwork(next);
    state.config = next;
    scheduleNetworkRefresh();
    updateNetworkStatus();
  } catch (error) {
    leaveVoice();
    reportNetworkError(error);
  }
}

function localScreenEndpoint(value){
  if(!transportContext?.localUi||!transportContext.transportOrigin||transportContext.transportOrigin===location.origin)return value;
  const endpoint=new URL(value),remote=new URL(transportContext.transportOrigin);
  if(endpoint.host!==remote.host||endpoint.protocol!==(remote.protocol==='https:'?'wss:':'ws:')||endpoint.pathname!=='/screen-sfu'||endpoint.search||endpoint.hash)throw new TypeError('屏幕服务地址与已验证的房间地址不一致');
  return (location.protocol==='https:'?'wss://':'ws://')+location.host+'/screen-sfu';
}
function roomNetworkConfig(input){const parsed=parseNetworkConfig(input);return parsed.screen?.mode==='sfu'?{...parsed,screen:{...parsed.screen,url:localScreenEndpoint(parsed.screen.url)}}:parsed;}

function updateNetworkStatus() {
  const node = document.getElementById('networkStatus');
  if (!node || !state.config.mediaPolicy) return;
  const peers = engine ? Object.values(engine.getPeerInfo()) : [];
  const routes = peers.map((peer) => peer.route);
  const label = state.steamSession ? 'Steam牵线 · 语音直连' : state.config.networkMode === 'direct' ? '独立直连' : { direct: '仅直连', 'relay-allowed': '允许中继', 'relay-only': '仅中继' }[state.config.mediaPolicy];
  node.textContent = label + (routes.includes('relay') ? ' · 正在中继' : routes.includes('direct') ? ' · 正在直连' : '')+(contentClient.encrypted?' · 内容已加密':'');
  node.title = state.steamSession ? 'Steam 只传输房间和信令；语音由 WebRTC 直连。房间已连接不代表成员语音已连通' : '当前语音传输策略；房间连接延迟不代表语音延迟';
}

async function setupDirectInvitation() {
  if (!window.deepscord?.getDirectSession) return;
  const steam = window.deepscord.getSteamSession ? await window.deepscord.getSteamSession() : null;
  state.steamSession = Boolean(steam);
  updateNetworkStatus();
  const direct = steam || await window.deepscord.getDirectSession();
  if (!steam && direct?.role !== 'host') return;
  const button = document.getElementById('copyDirectInvite');
  button.hidden = false;
  if (steam) { button.title = '复制 Steam 房间邀请'; button.setAttribute('aria-label', '复制 Steam 房间邀请'); }
  button.addEventListener('click', async () => {
    try { await copyChannelInvite(state.activeChannelId); }
    catch (error) { reportNetworkError(error); }
  });
}

/* -------------------------------------------------------------------- */
/* 启动                                                                  */
/* -------------------------------------------------------------------- */

async function boot() {
  if(window.deepscord?.getConnectionContext)transportContext=await window.deepscord.getConnectionContext();
  if(window.deepscord?.getClientPreferences){const preferences=await window.deepscord.getClientPreferences();if(preferences.settings){localStorage.setItem('echo.settings',JSON.stringify(preferences.settings));state.settings=loadSettings();}if(preferences.lastChannel)store.set('echo.lastChannel',preferences.lastChannel);}
  dom.rail = $('#serverRail');
  dom.serverList = $('#serverList');
  dom.channelScroll = $('#channelScroll');
  dom.serverName = $('#serverName');
  dom.topbarName = $('#topbarName');
  dom.topbarIcon = $('#topbarIcon');
  dom.topbarDesc = $('#topbarDesc');
  dom.stage = $('#voiceStage');
  dom.stageTitle = $('#stageTitle');
  dom.stageSub = $('#stageSub');
  dom.stageGrid = $('#stageGrid');
  dom.stageActions = $('#stageActions');
  dom.messages = $('#messages');
  dom.msgInput = $('#msgInput');
  dom.composer = $('#composer');
  dom.membersScroll = $('#membersScroll');
  dom.connPill = $('#connPill');
  dom.selfPanel = $('#selfPanel');

  state.profile = await loadProfile();
  if (state.profile) Object.assign(state.settings, { name: state.profile.name, color: state.profile.color, avatar: state.profile.avatar });
  if (window.deepscord?.getDesktopSettings) state.desktopSettings = await window.deepscord.getDesktopSettings();
  const params = new URLSearchParams(location.search);
  const nameParam = params.get('name');
  if (nameParam) state.settings.name = nameParam.trim().slice(0, 24);
  const colorParam = params.get('color');
  if (colorParam && /^#[0-9a-fA-F]{6}$/.test(colorParam)) state.settings.color = colorParam;

  if (state.settings.name) await persistIdentity();
  wireStaticUI();
  chatMedia=await createChatMedia({input:dom.msgInput,form:dom.composer,host:$('#composerWrap'),anchor:$('#emojiPanelBtn'),view:ensureChatView(),client:chatMediaClient,content:contentClient,getContext:chatMediaContext,submitGovernance:async(command,signal)=>{signal.throwIfAborted();await submitGovernance(command);signal.throwIfAborted();},acceptMessage:(channelId,message)=>onMessage({channelId,message}),reportError:reportNetworkError});

  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('读取房间配置失败：HTTP ' + response.status);
  const metadata = parsePublicConfig(await response.json());
  state.config = metadata;
  state.requirePassword = metadata.requirePassword;
  const fragmentInvite = new URLSearchParams(location.hash.slice(1)).get('invite');
  const invite = fragmentInvite === null ? sessionStorage.getItem('deepscord.invite') : fragmentInvite;
  if (invite !== null && !/^[A-Za-z0-9_-]{43}$/.test(invite)) throw new TypeError('邀请密钥格式不正确');
  state.invitationSession = invite !== null;
  state.password = invite === null ? (window.deepscord?.getRoomPassword ? await window.deepscord.getRoomPassword() ?? '' : store.get('echo.password', '') || '') : invite;
  if (invite !== null) {
    sessionStorage.setItem('deepscord.invite', invite);
    history.replaceState(null, '', location.pathname + location.search);
  }
  await setupDirectInvitation();

  if (!state.settings.name || (state.requirePassword && !state.password)) showWelcome();
  else startApp();
}

function showWelcome(opts = {}) {
  const needsPassword = state.requirePassword && !state.invitationSession;
  const colors = ['#7c6cf5', '#4dd4ac', '#ff8a5c', '#4aa8ff', '#f25f8b', '#f5c451', '#8f7dff', '#3ecf8e'];
  let picked = state.settings.color || colors[0];
  const nameInput = el('input', {
    id: 'welcomeNameInput',
    class: 'input big',
    placeholder: '输入你的昵称',
    maxlength: '24',
    autocomplete: 'off',
    value: state.settings.name || '',
  });
  const passInput = needsPassword
    ? el('input', {
        class: 'input',
        type: 'password',
        placeholder: '输入访问口令',
        autocomplete: 'current-password',
      })
    : null;
  const swatches = el('div', { class: 'swatches center' });
  for (const c of colors) {
    const b = el('button', {
      type: 'button',
      class: 'swatch' + (c === picked ? ' active' : ''),
      style: { background: c },
    });
    b.addEventListener('click', () => {
      picked = c;
      for (const child of swatches.children) child.classList.toggle('active', child === b);
    });
    swatches.appendChild(b);
  }
  const enterBtn = el('button', { id: 'welcomeEnterBtn', class: 'btn primary wide' }, opts.retry ? '重新进入' : '进入 Deepscord');
  const body = el(
    'div',
    { class: 'welcome' },
    el('div', { class: 'welcome-art', html: icon('logo', 56) }),
    el('p', { class: 'welcome-sub' }, needsPassword ? '私人频道 · 需要访问口令' : state.invitationSession ? '使用邀请加入 · 设置昵称后进入房间' : '一个开箱即用的局域语音频道'),
    opts.error ? el('div', { class: 'welcome-error' }, opts.error) : null,
    nameInput,
    needsPassword ? el('div', { class: 'welcome-label' }, '访问口令') : null,
    passInput,
    el('div', { class: 'welcome-label' }, '选一个头像颜色'),
    swatches
  );
  const modal = openModal({
    title: opts.retry ? '访问口令不正确' : '欢迎来到 Deepscord',
    body,
    footer: [enterBtn],
    width: 460,
    locked: true,
  });
  const shake = (node) => {
    node.classList.add('shake');
    setTimeout(() => node.classList.remove('shake'), 350);
  };
  const submit = async () => {
    const name = nameInput.value.trim().slice(0, 24);
    if (!name) {
      shake(nameInput);
      return;
    }
    if (needsPassword) {
      const pwd = passInput ? passInput.value.trim() : '';
      if (!pwd) {
        shake(passInput);
        return;
      }
      state.password = pwd;
      if (!state.invitationSession&&!window.deepscord?.saveRoomPassword) store.set('echo.password', pwd);
    }
    state.settings.name = name;
    state.settings.color = picked;
    enterBtn.disabled = true;
    try {if(needsPassword&&window.deepscord?.saveRoomPassword)await window.deepscord.saveRoomPassword(state.password);await persistIdentity(); }
    catch (error) { enterBtn.disabled = false; reportNetworkError(error); return; }
    modal.close();
    if (!booted) startApp();
    else setTimeout(sendHello, 150);
  };
  enterBtn.addEventListener('click', submit);
  nameInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') submit();
  });
  if (passInput) {
    passInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') submit();
    });
  }
  setTimeout(() => {
    if (state.settings.name) nameInput.focus();
    else nameInput.focus();
  }, 150);
}

function startApp() {
  if (booted) return;
  booted = true;
  updateSelfPanel();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${proto}://${location.host}/ws`;
  socket = new Socket({
    url: wsUrl,
    onStatus: onConnStatus,
    onEvent: receiveServerEvent,
    onLatency: (ms) => {
      state.latency = ms;
      updateConnPill();
      updateSelfPanel();
    },
  });
  socket.connect();
  setupShortcuts();
  setupPttMouse();
  window.addEventListener('beforeunload', () => {
    disposePresentationVisibility();
    pokeAudio.close().catch(reportNetworkError);
    disposeInterfaceProfile();
    radioClient.dispose();
    interactionUI.destroy(); interactionRenderer.destroy(); interactionAudio.close().catch(reportNetworkError);
    chatMedia?.destroy();chatView?.destroy();browserIdentity?.destroy();chatMediaClient.reset();
    try {
      if (engine?.inVoice) { socket.send({ t: 'leaveVoice' }); engine.leave(); }
      socket.close();
    } catch (_) {
      /* ignore */
    }
  });
  const disposePresentationVisibility=installPresentationVisibility(window.deepscord?.getWindowVisibility?window.deepscord:null,()=>{renderAll();updateNetworkStatus();},reportNetworkError);
  setInterval(() => {if(!isPresentationHidden())updateSelfPanel();}, 5000);
  setInterval(async () => {
    if(linkMeasurementPending)return;
    linkMeasurementPending=true;
    try {
      if (engine?.peers.size) await engine.measureLinks();
      if(!isPresentationHidden()){updateNetworkStatus();updateConnPill();}
    } finally {linkMeasurementPending=false;}
  }, 2000);
}

/* -------------------------------------------------------------------- */
/* 连接与事件                                                            */
/* -------------------------------------------------------------------- */

function sendHello() {
  if (!socket) return;
  state.helloSent = true;
  socket.send({
    t: 'hello',
    name: state.settings.name,
    color: state.settings.color,
    ...(state.profile ? profilePayload(state.profile) : {}),
    password: state.password || '',
    resumable: true,
    ...(window.deepscord?.activateContentRoom ? {contentVersion:1}:{}),
    ...(state.resumeToken ? { resumeToken: state.resumeToken } : {}),
  });
}

function onConnStatus(status) {
  state.connStatus = status;
  if (status === 'open' && !state.helloSent) {
    sendHello();
  }
  if (status === 'disconnected' || status === 'reconnecting' || status === 'closed') {
    radioClient.disconnect();authorKeys.clear();
    contentConnectionGeneration++;
    chatMedia?.reset();chatMediaClient.reset();reactionActorId=null;
    for(const waiter of governanceWaiters){clearTimeout(waiter.timer);waiter.reject(new DOMException('服务器连接已变化','AbortError'));}governanceWaiters.clear();
    roomSyncGeneration+=1;roomSyncRound=null;
    governanceGeneration+=1;governanceCheckpointPending=false;governanceCheckpointAttempt='';governanceUpdateSequence+=1;governanceViewDomainId=null;serverGovernance=null;identityStatus='';
    customizationView?.close(); customizationView=null;
    governanceView?.close();governanceView=null;closeContextMenu();
    roomConflictDialog?.close();roomConflictDialog=null;
    screenRoom.disconnect();
    engine?.disconnectScreenRoom();
    state.helloSent = false;
    state.roomReady = false;
    state.latency = null;
    state.pendingVoiceChannelId = null;
    voiceJoinSequence += 1;
    if (engine && !engine.inVoice) engine.stopMic();
    if (status === 'disconnected') toast(engine?.inVoice ? '房间连接中断，已建立的语音继续；正在恢复房间连接' : '房间连接中断，正在重连', 'warn');
  }

  updateConnPill();
  updateSelfPanel();
}

function receiveServerEvent(msg){
  if(chatMediaClient.receive(msg))return;
  if(msg.t==='welcome'){
    const generation=++contentConnectionGeneration;
    contentInitialization=onWelcome(msg,generation);
    void contentInitialization.catch(error=>{if(generation!==contentConnectionGeneration)return;state.roomReady=false;engine?.leave();socket?.close();reportNetworkError(error);});
    return;
  }
  const generation=contentConnectionGeneration;
  void contentInitialization.then(()=>{if(generation===contentConnectionGeneration)return onServerEvent(msg);}).catch(error=>{if(generation===contentConnectionGeneration)reportNetworkError(error);});
}
function onServerEvent(msg) {
  if(msg.t==='radioState' || msg.t==='radioResult'){radioClient.receive(msg);return;}
  switch (msg.t) {
    case 'mediaStatus':chatMedia?.receiveStatus(msg);renderMessages();return;
    case 'messageReactions': {
      if(msg.message){const generation=contentConnectionGeneration;const channelId=mediaId(msg.channelId,'Reaction channel');const task=contentMessages.then(async()=>{const message=await contentClient.openMessage(channelId,parseChatMessage(msg.message));if(generation===contentConnectionGeneration)onMessage({channelId,message});});contentMessages=task.catch(error=>reportNetworkError(error));return contentMessages;}
      const channelId=mediaId(msg.channelId,'Reaction channel'),messageId=mediaId(msg.messageId,'Reaction message'),reactions=parseReactions(msg.reactions),revision=mediaInteger(msg.revision,'Reaction revision',0,Number.MAX_SAFE_INTEGER),list=state.messages.get(channelId) || [];
      const index=list.findIndex(message=>message.id===messageId);if(index<0 || revision<(list[index].reactionRevision ?? 0))return;
      state.messages.set(channelId,list.map((message,position)=>position===index ? {...message,reactions,reactionRevision:revision} : message));if(channelId===state.activeChannelId)renderMessages();return;
    }
    case 'identityChallenge':
      answerIdentityChallenge(msg).catch(reportNetworkError);return;
    case 'serverState':
      acceptServerState(msg).catch(reportNetworkError);return;
    case 'messageDeleted': {
      if(typeof msg.channelId !== 'string' || typeof msg.messageId !== 'string') return reportNetworkError(new TypeError('Invalid message deletion event'));
      state.messages.set(msg.channelId,(state.messages.get(msg.channelId)||[]).filter(message=>message.id!==msg.messageId));
      renderMessages();return;
    }
    case 'roomSyncOffer':
      synchronizeRoomOffer(msg).catch(reportNetworkError);return;
    case 'roomSyncCommit':
      acceptRoomDocument(msg).catch(reportNetworkError);return;
    case 'roomSyncConflict':
      displayRoomConflict(msg).catch(reportNetworkError);return;
    case 'userJoined':
      return onUserJoined(msg.user);
    case 'userLeft':
      return onUserLeft(msg.id, msg.reason);
    case 'userUpdated':
      return onUserUpdated(msg.user);
    case 'voiceState':
      return onVoiceState(msg);
    case 'voicePeers':
      return onVoicePeers(msg).catch(reportNetworkError);
    case 'networkConfig':
      if (typeof msg.resumeToken === 'string') state.resumeToken = msg.resumeToken;
      return applyNetworkConfig(msg.config);
    case 'screenSfuToken':
    case 'screenSfuRelease':
      return screenRoom.receive(msg.url?{...msg,url:localScreenEndpoint(msg.url)}:msg);
    case 'userConnection': {
      const user = state.users.get(msg.id);
      if (user) user.signalConnected = msg.connected === true;
      radioClient.refresh();return renderMembers();
    }
    case 'resumeRejected':
      state.roomReady = false;
      if (msg.code === 'session_active') return;
      return toast(msg.message + '；现有通话保持，退出后重新打开房间即可。', 'error', 8000);
    case 'signal':
      if (!engine?.inVoice || !state.users.has(msg.from)) return;
      return engine.handleSignal(msg.from, msg.data).catch(reportNetworkError);
    case 'message':
      {const generation=contentConnectionGeneration;const task=contentMessages.then(async()=>{const message=await contentClient.openMessage(msg.channelId,parseChatMessage(msg.message));if(generation===contentConnectionGeneration)onMessage({channelId:msg.channelId,message});});contentMessages=task.catch(error=>reportNetworkError(error));return contentMessages;}
    case 'servers':
      return onServers(msg.servers);
    case 'authFailed':
      return onAuthFailed(msg);
    case 'error':
      if (msg.action === 'joinVoice') {
        state.pendingVoiceChannelId = null;
        if (engine?.channelId === msg.channelId) engine.leave();
        else if (engine && !engine.inVoice) engine.stopMic();
      }
      return toast(msg.message || '服务器返回错误', 'error');
    default:
      return undefined;
  }
}

/** @param {import('./network-protocol.js').JsonValue} value */
async function answerIdentityChallenge(value) {
  const challenge=parseIdentityChallenge(value), connection=socket, generation=governanceGeneration;
  if(challenge.userId!==state.selfId || !state.roomReady) throw new TypeError('身份验证请求不属于当前连接');
  if(!window.deepscord?.signServerIdentity && (!isSecureContext || !crypto.subtle)){identityStatus='普通成员模式 · 浏览器身份验证需要 HTTPS';renderSidebar();return;}
  const identity=window.deepscord?.signServerIdentity ? window.deepscord : await getBrowserIdentity();
  const proof=await identity.signServerIdentity(challenge);
  if(connection!==socket || generation!==governanceGeneration || !state.roomReady)return;
  if(!connection.send(proof)) throw new Error('身份验证发送失败：房间连接已中断');
}

/** @param {import('./network-protocol.js').JsonValue} value */
async function acceptServerState(value) {
  const snapshot=parseServerState(value), connection=socket, generation=governanceGeneration, sequence=++governanceUpdateSequence;
  if(!state.roomReady)return;
  if(window.deepscord?.saveServerGovernance)await window.deepscord.saveServerGovernance(snapshot.journal);
  else if(isSecureContext && crypto.subtle)await (await getBrowserIdentity()).saveServerGovernance(snapshot.journal);
  const actor=snapshot.selfKey ? 'm_'+[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(snapshot.selfKey)))].map(byte=>byte.toString(16).padStart(2,'0')).join('') : null;
  const memberKeys=[...new Set([snapshot.policy.ownerKey,...(snapshot.policy.serverAdmins ?? []),...snapshot.members.map(member=>member.memberKey),...snapshot.policy.domains.flatMap(domain=>[domain.ownerKey,...domain.admins,...domain.members.map(member=>member.memberKey)])].filter(Boolean))];
  const titleKeys=new Map(await Promise.all(memberKeys.map(async key=>['m_'+[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key)))].map(byte=>byte.toString(16).padStart(2,'0')).join(''),key])));
  if(connection!==socket || generation!==governanceGeneration || sequence!==governanceUpdateSequence || !state.roomReady)return;
  const invalidatesManagement=serverGovernance?.journal.digest!==snapshot.journal.digest || serverGovernance?.selfKey!==snapshot.selfKey || (governanceViewDomainId!==null && !state.servers.some(domain=>domain.id===governanceViewDomainId));
  const incoming=value.content===undefined||value.content===null?null:parseContentPolicy(value.content);
  contentMigrating=value.contentMigrating===true;
  if(contentClient.encrypted&&(!incoming||incoming.signature!==contentClient.policy.signature))throw new Error('服务器返回的房间加密配置与本机固定记录不一致');
  if(incoming&&!contentClient.encrypted&&!contentLocalMigration){
    state.roomReady=false;engine?.leave();socket?.close();
    const back=el('button',{id:'contentRejoinBtn',class:'btn primary'},'使用新邀请重新加入');
    const dialog=openModal({title:'房间已启用内容加密',body:el('p',{class:'dialog-text'},'原频道与历史已保留。请向服主索取包含密钥的新邀请，再通过左上角服务器入口加入。'),footer:[back],locked:true});
    back.addEventListener('click',()=>{dialog.close();window.deepscord?.back().catch(reportNetworkError);});return;
  }
  serverGovernance={...snapshot,policy:{...snapshot.policy,emojis:snapshot.policy.emojis?.map(emoji=>({...emoji,asset:mapContentAsset(contentClient.policy,emoji.asset)})),...(snapshot.policy.customization ? {customization:snapshot.policy.customization.map(scope=>({...scope,interactions:scope.interactions.map(entry=>({...entry,thumbnail:entry.thumbnail ? mapContentAsset(contentClient.policy,entry.thumbnail) : null}))}))} : {})}};
  reactionActorId=actor;authorKeys=titleKeys;
  if(snapshot.selfKey===snapshot.policy.ownerKey && needsGovernanceCheckpoint(snapshot.journal) && window.deepscord?.signGovernanceCheckpoint && !governanceCheckpointPending && governanceCheckpointAttempt!==snapshot.journal.digest){
    governanceCheckpointPending=true;governanceCheckpointAttempt=snapshot.journal.digest;
    window.deepscord.signGovernanceCheckpoint().then(frame=>{
      if(generation!==governanceGeneration || connection!==socket || !state.roomReady)return;
      return chatMediaClient.call(frame,new AbortController().signal);
    }).catch(reportNetworkError).finally(()=>{if(generation===governanceGeneration)governanceCheckpointPending=false;});
  }
  for(const waiter of [...governanceWaiters])if(waiter.digest===snapshot.journal.digest){clearTimeout(waiter.timer);governanceWaiters.delete(waiter);waiter.resolve();}
  identityStatus=snapshot.selfKey ? '' : '普通成员模式 · 身份尚未验证';
  if(invalidatesManagement){governanceView?.close();governanceView=null;governanceViewDomainId=null;closeContextMenu();}
  if(invalidatesManagement && !customizationSaving){customizationView?.close();customizationView=null;}
  renderAll();
  const attemptKey=governanceGeneration+':'+snapshot.server.id;
  if(canManageServerCatalog(snapshot.policy,snapshot.selfKey) && snapshot.policy.interactionCatalogVersion!==2 && interactionCatalogAttempt!==attemptKey){
    interactionCatalogAttempt=attemptKey;
    ensureInteractionCatalog().catch(reportNetworkError);
  }
}

/** @type {{generation:number,promise:Promise<void>}|null} */
let interactionCatalogInitialization=null;
let interactionCatalogAttempt='';

/** @returns {Promise<void>} */
async function prepareInteractionCustomization(){
  const generation=governanceGeneration;
  await ensureInteractionCatalog();
  if(generation===governanceGeneration && state.roomReady)openServerCustomization('interactions');
}
/** @returns {Promise<void>} */
async function ensureInteractionCatalog() {
  if(interactionCatalogInitialization?.generation===governanceGeneration)return interactionCatalogInitialization.promise;
  const generation=governanceGeneration;
  const promise=initializeInteractionCatalog();
  const pending={generation,promise};
  interactionCatalogInitialization=pending;
  try{await promise;}finally{if(interactionCatalogInitialization===pending)interactionCatalogInitialization=null;}
}
/** @returns {Promise<void>} */
async function initializeInteractionCatalog() {
  if(!serverGovernance || serverGovernance.policy.interactionCatalogVersion===2 || !canManageServerCatalog(serverGovernance.policy,serverGovernance.selfKey))return;
  await submitGovernance({type:'migrateServerCatalog'});
}

/** @param {import('./server-governance-ui.js').GovernanceCommand} command */
async function submitGovernance(command) {
  if(command.type!=='migrateServerCatalog' && interactionCatalogInitialization?.generation===governanceGeneration){
    const generation=governanceGeneration;
    await interactionCatalogInitialization.promise;
    if(generation!==governanceGeneration)throw new Error('服务器连接已变化，请重新打开管理面板');
  }
  if(!serverGovernance || !serverGovernance.selfKey)throw new Error('身份验证尚未完成，无法提交权限修改');
  const snapshot=serverGovernance, connection=socket, generation=governanceGeneration;
  const identity=window.deepscord?.signGovernanceChange ? window.deepscord : await getBrowserIdentity();
  const signed=await identity.signGovernanceChange({journal:snapshot.journal,command});
  if(generation!==governanceGeneration || connection!==socket || !state.roomReady || serverGovernance?.journal.digest!==snapshot.journal.digest) throw new Error('服务器权限已变化，请重新打开管理面板');
  const result=mediaObject(await chatMediaClient.call(signed,new AbortController().signal),'Governance acknowledgement');
  if(typeof result.digest!=='string' || !/^[a-f0-9]{64}$/.test(result.digest))throw new TypeError('Governance acknowledgement has no canonical digest');
  if(serverGovernance?.journal.digest!==result.digest)await new Promise((resolve,reject)=>{const waiter={digest:result.digest,resolve:()=>resolve(undefined),reject,timer:setTimeout(()=>{governanceWaiters.delete(waiter);reject(new Error('服务器已确认修改，但签名权限状态同步超时'));},15000)};governanceWaiters.add(waiter);});
}

/** @returns {Promise<Awaited<ReturnType<typeof createBrowserIdentity>>>} */
function getBrowserIdentity(){if(!browserIdentityPromise)browserIdentityPromise=createBrowserIdentity().then(identity=>{browserIdentity=identity;return identity;});return browserIdentityPromise;}
/** @returns {import('./chat-media.js').MediaContext} */
function chatMediaContext(){return{roomId:serverGovernance?.server.id ?? null,channelId:activeChannel()?.type==='text' ? state.activeChannelId : null,domainId:state.activeServerId,selfKey:serverGovernance?.selfKey ?? null,actorId:reactionActorId,domains:state.servers.map(domain=>({id:domain.id,name:domain.name})),policy:serverGovernance?.policy ?? null};}

function openServerGovernance() {
  openMemberGovernance(null);
}

/** @param {string|null} selectedMemberKey */
function openMemberGovernance(selectedMemberKey) {
  if(selectedMemberKey && (!serverGovernance || !canManageMember(serverGovernance.policy,serverGovernance.selfKey,selectedMemberKey,state.activeServerId)))return;
  if(!serverGovernance)return toast('服务器权限正在同步，请稍后重试','info');
  const generation=governanceGeneration;
  const snapshot=serverGovernance;
  governanceViewDomainId=state.activeServerId;
  openGovernancePanel({snapshot,domainId:state.activeServerId,domainName:activeServer()?.name ?? '',selectedMemberKey,users:[...state.users.values()],submit:submitGovernance,
    claim:async token=>{if(generation!==governanceGeneration || !state.roomReady)throw new Error('服务器连接已变化');if(!socket.send({t:'claimOwner',token}))throw new Error('服主认领发送失败');},
    modal:options=>{governanceView=openModal(options);return governanceView;}});
}

function isServerOwner() {return Boolean(serverGovernance?.selfKey && serverGovernance.selfKey===serverGovernance.policy.ownerKey);}
function canManageServer(){return Boolean(isServerOwner() || serverGovernance?.selfKey && serverGovernance.policy.serverAdmins?.includes(serverGovernance.selfKey));}

/** @param {{roundId:string,document:import('../../lib/room-replica.cjs').RoomDocument}} offer */
async function synchronizeRoomOffer(offer) {
  roomSyncRound=offer.roundId;
  const generation=++roomSyncGeneration;
  roomConflictDialog?.close();roomConflictDialog=null;
  if(!window.deepscord?.prepareRoomVote) return;
  const vote=await window.deepscord.prepareRoomVote(offer);
  if(generation!==roomSyncGeneration || !state.roomReady) return;
  if(!socket.send(vote)) throw new Error('频道副本核对时连接断开，请等待房间重新连接');
}

/** @param {{document:import('../../lib/room-replica.cjs').RoomDocument}} message */
async function acceptRoomDocument(message) {
  const generation=roomSyncGeneration;
  if(window.deepscord?.saveRoomDocument) await window.deepscord.saveRoomDocument(message.document);
  if(generation!==roomSyncGeneration || !state.roomReady) return;
  roomConflictDialog?.close();roomConflictDialog=null;
  onServers(message.document.servers);
}

/** @param {{roundId:string,candidates:import('../../lib/room-replica.cjs').RoomDocument[]}} message */
async function displayRoomConflict(message) {
  if(message.roundId!==roomSyncRound) return;
  if(window.deepscord?.preserveRoomConflict) await window.deepscord.preserveRoomConflict(message.candidates);
  if(message.roundId!==roomSyncRound || !state.roomReady) return;
  roomConflictDialog?.close();
  roomConflictDialog=showRoomConflict(message,async(digest) => {
    if(message.roundId!==roomSyncRound) throw new Error('成员已经变化，请处理新一轮频道核对');
    if(!socket.send({t:'roomSyncChoose',roundId:message.roundId,digest})) throw new Error('连接断开，频道副本尚未覆盖');
  });
}

async function copyChannelInvite(channelId) {
  if(!channelId) throw new Error('请先选择一个频道');
  if(window.deepscord?.copyChannelInvite) await window.deepscord.copyChannelInvite(channelId);
  else {const url=new URL(location.href);url.hash=new URLSearchParams({channel:channelId}).toString();await navigator.clipboard.writeText(url.href);}
  toast('频道邀请已复制','success');
}

async function onWelcome(msg,generation) {
  state.roomReady=false;
  roomDescriptor={version:1,roomId:msg.roomDocument?.roomId,creatorKey:msg.roomDocument?.creatorKey};
  const contentKey=await contentClient.initialize({descriptor:roomDescriptor,journal:msg.governance,policy:msg.content??null});
  try {
  if(generation!==contentConnectionGeneration)throw new DOMException('Room connection changed during initialization','AbortError');
  const wasReconnect = !!state.selfId;
  const prevVoice = state.desiredVoiceChannelId;
  const retained = [...state.users.values()].filter((user) => engine?.peers.has(user.id));
  if (state.selfId && state.selfId !== msg.selfId && engine?.inVoice) {
    reportNetworkError(new Error('恢复身份与当前通话不一致，请退出通话后重新打开房间'));
    return;
  }
  state.resumeToken = msg.resumeToken;
  state.selfId = msg.selfId;
  state.users.clear();
  for (const user of retained) state.users.set(user.id, { ...user, signalConnected: false });
  for (const u of msg.users || []) state.users.set(u.id, u);
  state.servers = msg.servers || [];
  state.config = roomNetworkConfig(msg.config);
  if (msg.config && typeof msg.config.requirePassword === 'boolean') {
    state.requirePassword = msg.config.requirePassword;
  }
  const messages=new Map();
  for (const [channelId, list] of Object.entries(msg.messages || {})) {
    if(!Array.isArray(list))throw new TypeError('Channel chat history must be an array');
    const decoded=[];
    for(const value of list.slice(-300)){
      if(generation!==contentConnectionGeneration)throw new DOMException('Room connection changed while reading history','AbortError');
      decoded.push(await contentClient.openMessage(channelId,parseChatMessage(value)));
    }
    messages.set(channelId,decoded);
  }
  if(generation!==contentConnectionGeneration)throw new DOMException('Room connection changed after reading history','AbortError');
  if (!state.servers.length) throw new TypeError('房间没有可显示的域');

  // 创建语音引擎（只创建一次）
  if (!engine) {
    engine = new VoiceEngine({
      getSettings: () => state.settings,
      config: state.config,
      sendSignal: (to, data) => {
        if (!state.roomReady || !socket.send({ t: 'signal', to, data })) throw new Error('房间未连接，无法建立新的语音连接');
      },
      onEvent: onVoiceEvent,
      selfId: state.selfId,
      screenSfu: { requestToken: (channelId, sourceUserId) => screenRoom.token(channelId, sourceUserId), releaseToken: (channelId, sourceUserId, identity) => screenRoom.release(channelId, sourceUserId, identity) },
    });
  } else {
    // 重连后 userId 会变化，同步给引擎用于说话检测
    engine.updateNetwork(state.config);
    engine.updateIdentity(state.selfId);
  }
  for(const user of state.users.values())syncMemberModeration(user);
  await engine.setContentEncryption(contentKey);
  if(generation!==contentConnectionGeneration)throw new DOMException('Room connection changed while applying encryption','AbortError');
  state.messages=messages;
  state.roomReady=true;

  // 恢复上次所在频道
  const last = store.get('echo.lastChannel', null);
  if (!state.activeChannelId) {
    const lastHit = last && findChannel(last.channelId);
    if (lastHit) {
      state.activeServerId = lastHit.server.id;
      state.activeChannelId = lastHit.channel.id;
    } else {
      const srv = activeServer();
      const firstText = srv.channels.find((c) => c.type === 'text') || srv.channels[0];
      state.activeServerId = srv.id;
      state.activeChannelId = firstText ? firstText.id : null;
    }
  }
  // 保证 active 频道仍然存在
  if (!findChannel(state.activeChannelId)) {
    const srv = activeServer();
    const fallback = srv.channels.find((c) => c.type === 'text') || srv.channels[0];
    state.activeChannelId = fallback ? fallback.id : null;
  }

  renderAll();

  scheduleNetworkRefresh();
  if(!wasReconnect) selectInvitedChannel().catch(reportNetworkError);
  updateNetworkStatus();
  if (wasReconnect) {
    toast('已重新连接', 'success', 2000);
  } else {
    // 首次进入：消费一次 URL 中的 name 参数
    if (new URLSearchParams(location.search).has('name')) {
      saveSettings(state.settings);
    }
  }

  // 断线重连后自动回到原来的语音频道
  const target = prevVoice || state.desiredVoiceChannelId;
  if (target && findChannel(target)) {
    state.desiredVoiceChannelId = target;
    if (state.voiceChannelId === target && engine.inVoice) {
      state.pendingVoiceChannelId = target;
      socket.send({ t: 'joinVoice', channelId: target, muted: engine.muted, deafened: engine.deafened });
    } else joinVoice(target);
  } else if (target && engine.inVoice) {
    engine.leave();
    reportNetworkError(new Error('原语音频道已不存在，通话已结束'));
  } else if (msg.you?.voiceChannelId) {
    socket.send({ t: 'leaveVoice' });
  }
  } finally {contentKey?.key.fill(0);}
}

async function selectInvitedChannel() {
  const channelId=window.deepscord?.getInvitedChannel ? await window.deepscord.getInvitedChannel() : new URLSearchParams(location.hash.slice(1)).get('channel');
  if(!channelId || !state.roomReady) return;
  const found=findChannel(channelId);
  if(!found) {toast('邀请中的频道已不存在，已显示当前频道列表','warn');return;}
  state.activeServerId=found.server.id;state.activeChannelId=found.channel.id;renderAll();
}

function onAuthFailed(msg) {
  state.helloSent = false;
  state.roomReady = false;
  sessionStorage.removeItem('deepscord.invite');
  store.remove('echo.password');
  if(!state.invitationSession&&window.deepscord?.saveRoomPassword)window.deepscord.saveRoomPassword('').catch(reportNetworkError);
  state.password = '';
  if (engine) {
    engine.leave();
    state.voiceChannelId = null;
    state.desiredVoiceChannelId = null;
  }
  toast(msg.message || '访问口令不正确', 'error', 4000);
  showWelcome({ error: msg.message || '访问口令不正确', retry: true });
}

function onUserJoined(user) {
  const isNew = !state.users.has(user.id);
  state.users.set(user.id, user);
  if (isNew) {
    renderMembers();
    renderStage();
    renderSidebar();
    renderTopbar();
    if (user.voiceChannelId) playTone('join');
  }
}

function onUserLeft(id, reason) {
  if (reason === 'signal-timeout' && engine?.peers.has(id)) {
    const retained = state.users.get(id);
    if (retained) retained.signalConnected = false;
    return;
  }
  const user = state.users.get(id);
  state.users.delete(id);
  engine?.setPeerServerMuted(id,false);
  state.speaking.delete(id);
  state.peerStates.delete(id);
  if (engine) engine.removePeer(id);
  renderMembers();
  renderStage();
  renderSidebar();
  renderTopbar();
  if (user && user.voiceChannelId) playTone('leave');
}

function onUserUpdated(user) {
  const prev = state.users.get(user.id);
  state.users.set(user.id, user);
  syncMemberModeration(user);
  if (user.id === state.selfId) updateSelfPanel();
  renderMembers();
  renderStage();
  renderSidebar();
  renderTopbar();
  if (prev?.name !== user.name) renderMessages();
}

function onVoiceState({ userId, channelId, serverMuted }) {
  const user = state.users.get(userId);
  if (!user) return;
  const prev = user.voiceChannelId;
  user.voiceChannelId = channelId || null;
  if(typeof serverMuted==='boolean'){user.serverMuted=Boolean(channelId) && serverMuted;syncMemberModeration(user);}

  if (userId === state.selfId) {
    const wasIn = !!state.voiceChannelId;
    if (!channelId) state.voiceChannelId = null;
    if (!channelId && engine && engine.channelId &&
        (!state.pendingVoiceChannelId || state.pendingVoiceChannelId === engine.channelId)) {
      engine.leave();
      state.desiredVoiceChannelId = null;
    }
    if (channelId) {
      state.desiredVoiceChannelId = channelId;
      if (!wasIn) playTone('join');
    }
    renderAll();
    return;
  }

  if (channelId && channelId === state.voiceChannelId && engine?.inVoice) engine.connectPeer(userId);
  if (!channelId && engine) engine.removePeer(userId);
  if (channelId && state.voiceChannelId && channelId !== state.voiceChannelId && engine) {
    engine.removePeer(userId);
  }
  if (channelId && !prev) playTone('join');
  if (!channelId && prev) {
    playTone('leave');
    state.speaking.delete(userId);
    state.peerStates.delete(userId);
  }
  renderMembers();
  renderStage();
  renderTopbar();
  renderSidebar();
}

function onMessage({ channelId, message: value }) {
  let message=parseChatMessage(value);
  const list = state.messages.get(channelId) || [];
  const previous=list.findIndex(entry=>entry.id===message.id);
  if(previous>=0){const old=list[previous];if((old.reactionRevision ?? 0)>(message.reactionRevision ?? 0))message={...message,reactions:old.reactions,reactionRevision:old.reactionRevision};list[previous]=message;}else list.push(message);
  if (list.length > 300) list.splice(0, list.length - 300);
  state.messages.set(channelId, list);
  if (channelId === state.activeChannelId) {
    renderMessages();
  }
  if (previous<0 && message && message.userId !== state.selfId && message.system !== true) {
    if (channelId !== state.activeChannelId || document.hidden) playTone('message');
  }
}

function onServers(servers) {
  state.servers = servers || [];
  const channelIds=new Set(state.servers.flatMap(domain=>domain.channels.map(channel=>channel.id)));
  for(const channelId of state.messages.keys())if(!channelIds.has(channelId))state.messages.delete(channelId);
  if(governanceViewDomainId!==null && !state.servers.some(domain=>domain.id===governanceViewDomainId)){governanceView?.close();governanceView=null;governanceViewDomainId=null;closeContextMenu();}
  if (!findServer(state.activeServerId)) {
    state.activeServerId = state.servers[0] ? state.servers[0].id : null;
  }
  if (!findChannel(state.activeChannelId)) {
    const srv = activeServer();
    const fallback = srv && (srv.channels.find((c) => c.type === 'text') || srv.channels[0]);
    state.activeChannelId = fallback ? fallback.id : null;
    if (state.desiredVoiceChannelId && !findChannel(state.desiredVoiceChannelId)) {
      state.desiredVoiceChannelId = null;
    }
  }
  renderAll();
}

/* -------------------------------------------------------------------- */
/* 语音引擎事件                                                          */
/* -------------------------------------------------------------------- */

function onVoiceEvent(ev) {
  if (ev.type === 'interaction-state' || ev.type === 'left') refreshCustomization();
  if (ev.type === 'interaction') {
    interactionRenderer.play(ev.event);
    syncInteractionTimers();
    return;
  }
  if (ev.type === 'interaction-clear') {
    if (ev.memberId === null) { interactionRenderer.clear(); interactionAudio.stop(); interactionUI.close(); }
    else { interactionRenderer.clearMember(ev.memberId); interactionAudio.stopMember(ev.memberId); }
    interactionUI.reconcile();
    return;
  }
  if (ev.type === 'poke-state') { mediaUI.reconcilePoke(); desktopPoke.sync(); return; }
  if (ev.type === 'poke-clear') { mediaUI.clearPokes(ev.targetUserId); pokeAudio.stop(); if (ev.targetUserId === state.selfId) desktopPoke.clear(); return; }
  if (ev.type === 'poke-hit') {
    mediaUI.showPoke(ev.hit);
    pokeAudio.play(ev.hit).catch(reportNetworkError);
    if (ev.hit.targetUserId === state.selfId) desktopPoke.show(ev.hit);
    return;
  }
  if (ev.type === 'output-settings') { pokeAudio.refresh().catch(reportNetworkError); refreshInteractionAudio(); return; }
  if (ev.type === 'media' || ev.type === 'interaction-state') {
    if (!mediaRenderScheduled) {
      mediaRenderScheduled = true;
      requestAnimationFrame(() => { mediaRenderScheduled = false; renderStage(); });
    }
    syncVoiceOverlay();
    return;
  }
  switch (ev.type) {
    case 'peer-state': {
      state.peerStates.set(ev.userId, ev.state);
      updateTileState(ev.userId);
      if (ev.state === 'failed') {
        toast('有成员的语音连接失败，可能是网络或设备问题', 'error');
      }
      return;
    }
    case 'speaking': {
      const key = ev.userId;
      if (ev.speaking) state.speaking.add(key);
      else state.speaking.delete(key);
      syncVoiceOverlay();
      if(isPresentationHidden())return;
      const tile = dom.stageGrid.querySelector(`[data-user-id="${key}"]`);
      if (tile) tile.classList.toggle('speaking', ev.speaking);
      const row = dom.membersScroll.querySelector(`[data-user-id="${key}"]`);
      if (row) row.classList.toggle('speaking', ev.speaking);
      const sideRow = dom.channelScroll.querySelector(`.ch-member[data-user-id="${key}"]`);
      if (sideRow) sideRow.classList.toggle('speaking', ev.speaking);
      return;
    }
    case 'mic-ready':
      updateSelfPanel();
      return;
    case 'mic-stopped':
      updateSelfPanel();
      return;
    case 'left':
      if (musicCapture.context || musicCapture.starting) musicCapture.stop().catch(reportNetworkError);
      mediaUI.destroy();
      syncVoiceOverlay();
      state.voiceChannelId = null;
      state.desiredVoiceChannelId = null;
      state.speaking.clear();
      state.peerStates.clear();
      renderAll();
      return;
    case 'error':
      toast(ev.message || '语音出错', 'error', 5000);
      return;
    case 'peer-left':
      return onVoiceState({ userId: ev.userId, channelId: null });
    case 'peer-removed':
      mediaUI.removeMember(ev.userId);
      return;
    case 'peer-mic-state': {
      const user = state.users.get(ev.userId);
      if (user) { user.muted = ev.muted; user.deafened = ev.deafened; }
      return renderStage();
    }
    case 'muted':
    case 'deafened':
      refreshInteractionAudio();
      syncVoiceOverlay();
      if (state.roomReady) socket.send({ t: 'micState', muted: engine.muted, deafened: engine.deafened });
      updateSelfPanel();
      renderStage();
      return;
    case 'remote-audio':
      return;
    default:
      return;
  }
}

/* -------------------------------------------------------------------- */
/* 渲染                                                                  */
/* -------------------------------------------------------------------- */

function renderAll() {
  refreshCustomization();
  renderRail();
  renderSidebar();
  renderTopbar();
  radioClient.refresh();
  renderStage();
  renderMessages();
  renderMembers();
  updateSelfPanel();
  updateConnPill();
}

function renderRail() {
  const html = [];
  for (const srv of state.servers) {
    const active = srv.id === state.activeServerId;
    const color = srv.color || colorFor(srv.name);
    html.push(`
      <button class="rail-item ${active ? 'active' : ''}" data-server-id="${esc(srv.id)}" aria-label="域 · ${esc(srv.name)}" title="域 · ${esc(srv.name)}">
        <span class="rail-indicator"></span>
        <span class="rail-icon" style="--srv-color:${esc(color)}">${esc(srv.icon || initials(srv.name))}</span>
        <span class="rail-tip">${esc(srv.name)}</span>
      </button>
    `);
  }
  reconcileMarkup(dom.serverList,html.join(''));
  const add=$('#addServerBtn');add.disabled=!state.roomReady || !canManageServer();add.title=canManageServer() ? '添加域' : '仅服主或服务器管理员可添加域';add.setAttribute('aria-label','添加域');
}

function renderSidebar() {
  const srv = activeServer();
  const serverLabel=$('#connectionServerName');
  if(serverLabel){serverLabel.textContent=(serverGovernance?.server.name || '服务器')+(identityStatus ? ' · 普通成员' : '');serverLabel.title=identityStatus || '当前连接的服务器';}
  dom.serverName.title=identityStatus || '域与服务器管理';
  if (!srv) {
    dom.serverName.textContent = '尚无域';
    reconcileMarkup(dom.channelScroll,'<div class="empty-hint">此服务器尚无域。服主或服务器管理员可通过左侧 + 添加域。</div>');
    return;
  }
  dom.serverName.textContent = srv.name;
  const voiceChannels = srv.channels.filter((c) => c.type === 'voice');
  const radioChannels=srv.channels.filter(channel=>channel.type==='radio');
  const textChannels = srv.channels.filter((c) => c.type === 'text');

  const memberRows = (ch) => {
    const members = usersInChannel(ch.id);
    if (!members.length) return '';
    return `
      <div class="ch-members" data-channel-members="${esc(ch.id)}">
        ${members
          .map((user) => {
            const isSelf = user.id === state.selfId;
            const speaking = state.speaking.has(user.id);
            const flag = user.deafened
              ? `<span class="ch-member-flag" title="闭音">${icon('headphonesOff', 12)}</span>`
              : user.muted || user.serverMuted
                ? `<span class="ch-member-flag" title="静音">${icon('micOff', 12)}</span>`
                : '';
            return `
              <div class="ch-member ${speaking ? 'speaking' : ''}" data-user-id="${esc(user.id)}" title="${esc(user.name)}">
                ${avatarHtml(user, 20, 'ch-member-avatar')}
                <span class="ch-member-name">${esc(user.name)}${isSelf ? ' <span class="you">你</span>' : ''}</span>
                ${flag}
              </div>
            `;
          })
          .join('')}
      </div>
    `;
  };

  const channelHtml = (ch) => {
    const active = ch.id === state.activeChannelId;
    const joined = ch.id === state.voiceChannelId;
    const inChannel = usersInChannel(ch.id);
    const limit = Number(ch.userLimit) || 0;
    let countBadge = '';
    if (ch.type !== 'text') {
      if (limit > 0) {
        const current = String(inChannel.length).padStart(2, '0');
        countBadge = `<span class="ch-count ratio" title="${inChannel.length}/${limit} 人">${current}/${limit}</span>`;
      } else if (inChannel.length) {
        countBadge = `<span class="ch-count">${inChannel.length}</span>`;
      }
    }
    return `
      <div class="channel-row" data-channel-row="${esc(ch.id)}"><button class="channel ${active ? 'active' : ''} ${joined ? 'joined' : ''}" data-channel-id="${esc(ch.id)}" data-channel-type="${esc(ch.type)}" title="${esc(ch.name)}${ch.type !== 'text' ? '（双击进入语音）' : ''}">
        <span class="ch-icon">${icon(ch.type==='radio' ? 'music' : ch.type !== 'text' ? 'volume' : 'hash', 18)}</span>
        <span class="ch-name">${esc(ch.name)}</span>
        ${countBadge}
        ${joined ? '<span class="ch-live"></span>' : ''}
      </button>
      <button id="channel-settings-${esc(ch.id)}" class="channel-settings" data-channel-settings="${esc(ch.id)}" aria-label="频道操作：${esc(ch.name)}" aria-haspopup="menu" title="频道设置与分享">${icon('settings',14)}</button></div>
      ${ch.type !== 'text' ? memberRows(ch) : ''}
    `;
  };

  reconcileMarkup(dom.channelScroll,`
    <div class="channel-group" data-channel-group="voice">
      <div class="group-head">
        <span>语音频道</span>
        <button class="group-add" ${canPerform(serverGovernance,srv.id,'manageChannels') ? '' : 'hidden disabled'} data-create="voice" title="创建语音频道">${icon('plus', 14)}</button>
      </div>
      ${voiceChannels.map(channelHtml).join('') || '<div class="empty-hint small">还没有语音频道</div>'}
    </div>
    <div class="channel-group" data-channel-group="text">
      <div class="group-head">
        <span>文字频道</span>
        <button class="group-add" ${canPerform(serverGovernance,srv.id,'manageChannels') ? '' : 'hidden disabled'} data-create="text" title="创建文字频道">${icon('plus', 14)}</button>
      </div>
      ${textChannels.map(channelHtml).join('') || '<div class="empty-hint small">还没有文字频道</div>'}
    </div>
    <div class="channel-group" data-channel-group="radio"><div class="group-head"><span>电台频道</span><button class="group-add" ${canPerform(serverGovernance,srv.id,'manageChannels')?'':'hidden disabled'} data-create="radio" title="创建电台频道">${icon('plus',14)}</button></div>${radioChannels.map(channelHtml).join('') || '<div class="empty-hint small">还没有电台频道</div>'}</div>
  `);
}

function renderTopbar() {
  const hit = findChannel(state.activeChannelId);
  if (!hit) {
    dom.topbarIcon.innerHTML = '';
    dom.topbarName.textContent = 'Deepscord';
    dom.topbarDesc.textContent = '';
    return;
  }
  const { channel } = hit;
  dom.topbarIcon.innerHTML = icon(channel.type==='radio' ? 'music' : channel.type === 'voice' ? 'volume' : 'hash', 20);
  dom.topbarName.textContent = channel.name;
  if (channel.type !== 'text') {
    const count = usersInChannel(channel.id).length;
    dom.topbarDesc.textContent = `${channel.type==='radio'?'电台频道':'语音频道'} · ${count} 人`;
  } else {
    dom.topbarDesc.textContent = `${hit.server.name} · 文字频道`;
    dom.msgInput.placeholder = `给 #${channel.name} 发消息…`;
  }
}

function renderStage() {
  const hit = findChannel(state.activeChannelId);
  const isVoice = hit && hit.channel.type !== 'text';
  dom.stage.hidden = !isVoice;
  if (!isVoice) { interactionUI.reconcile(); interactionRenderer.hide(); return; }

  const channel = hit.channel;
  const joined = state.voiceChannelId === channel.id;
  const members = usersInChannel(channel.id);
  dom.stageTitle.textContent = channel.name;
  dom.stageSub.textContent = joined
    ? `${members.length} 人在语音 · 你已连接`
    : `${members.length} 人在语音`;

  if (!members.length) {
    dom.stageGrid.innerHTML = `
      <div class="stage-empty">
        <div class="stage-empty-ico">${icon('volume', 34)}</div>
        <p>${joined ? '你是第一个进来的人，等朋友加入吧' : '这里还很安静，点下面的按钮加入语音'}</p>
      </div>`;
  } else {
    const memberIds = new Set(members.map(user => user.id));
    for (const node of [...dom.stageGrid.children]) {
      if (!memberIds.has(node.dataset.userId)) node.remove();
    }
    for (const user of members) {
      const isSelf = user.id === state.selfId;
      const peerState = state.peerStates.get(user.id);
      let status = '';
      if (user.muted || user.serverMuted) status = `<span class="tile-status muted">${icon('micOff', 14)} ${user.serverMuted ? '管理静音' : '已静音'}</span>`;
      else if (!isSelf && joined && peerState && peerState !== 'connected') {
        const map = { new: '连接中…', connecting: '连接中…', failed: '连接失败', disconnected: '重连中…', closed: '已断开' };
        status = `<span class="tile-status dim">${icon('signal', 14)} ${map[peerState] || peerState}</span>`;
      } else if (isSelf) {
        status = `<span class="tile-status dim">${icon('mic', 14)} 你</span>`;
      } else {
        status = `<span class="tile-status dim">${icon('signal', 14)} 已连接</span>`;
      }
      let card = [...dom.stageGrid.children].find(node => node.dataset.userId === user.id);
      if (!card) {
        card = document.createElement('div');
        card.className = 'tile'; card.dataset.userId = user.id;
        card.innerHTML = '<div class="tile-avatar"></div><div class="tile-name"></div><div class="tile-status-row"></div>';
        card.querySelector('.tile-status-row').dataset.statusFor = user.id;
        dom.stageGrid.append(card);
      }
      card.classList.toggle('speaking', state.speaking.has(user.id));
      const avatar = card.querySelector('.tile-avatar');
      const avatarMarkup = avatarHtml(user, 64);
      if (avatar.innerHTML !== avatarMarkup) avatar.innerHTML = avatarMarkup;
      card.querySelector('.tile-name').textContent = user.name + (isSelf ? '（你）' : '');
      const statusRow = card.querySelector('.tile-status-row');
      if (statusRow.innerHTML !== status) statusRow.innerHTML = status;
    }
  }

  const peerInfo=engine?.getPeerInfo() ?? {};
  for (const user of members) {
    const card = dom.stageGrid.querySelector(`[data-user-id="${user.id}"]`);
    if (!card) continue;
    const saved = state.settings.peerVolumes?.[user.profileId || location.origin + ':' + user.id];
    if (typeof saved === 'number' && Number.isFinite(saved) && saved >= 0 && saved <= 200) engine?.setPeerVolume(user.id, saved);
    mediaUI.decorateCard(card, { id: user.id, name: user.name, self: user.id === state.selfId, screenSharing: user.id === state.selfId ? Boolean(engine?.screenStream) : peerInfo[user.id]?.screenSharing === true });
    interactionUI.decorateCard(card, user.id);
  }
  interactionUI.reconcile();
  mediaUI.reconcile();
  syncVoiceOverlay();
  const pttHint = state.settings.mode === 'ptt' ? `按住 ${keyLabel(state.settings.pttKey)} 说话` : '语音感应已开启';
  if (joined) {
    dom.stageActions.innerHTML = `
      <div class="stage-hint">${esc(pttHint)}</div>
      <div class="stage-buttons">
        <button class="btn ${engine && (engine.muted || engine.serverMuted) ? 'danger-soft' : 'ghost'}" data-action="mute" ${engine?.serverMuted ? 'disabled' : ''}>
          ${icon(engine && (engine.muted || engine.serverMuted) ? 'micOff' : 'mic', 16)} ${engine?.serverMuted ? '管理静音' : engine?.muted ? '取消静音' : '静音'}
        </button>
        <button class="btn ${engine && engine.deafened ? 'danger-soft' : 'ghost'}" data-action="deafen">
          ${icon(engine && engine.deafened ? 'headphonesOff' : 'headphones', 16)} ${engine && engine.deafened ? '恢复声音' : '闭音'}
        </button>
        <button class="btn danger" data-action="leave">${icon('phoneOff', 16)} 断开</button>
      </div>
    `;
  } else {
    dom.stageActions.innerHTML = `
      <button class="btn primary big" data-action="join">${icon('phone', 18)} 加入语音</button>
    `;
  }
  if (joined) dom.stageActions.append(mediaUI.renderToolbar({ screenActive: Boolean(engine?.screenStream), musicActive: Boolean(engine?.accompanimentStream), connected: true }));
  if(channel.type==='radio'){const button=el('button',{id:'radioStageManageBtn',class:'btn ghost',type:'button'},'电台列表与换台');button.addEventListener('click',()=>radioClient.open(channel.id));dom.stageActions.append(button);}
  if(channel.type==='voice' && (state.messages.get(channel.id)||[]).length){const history=el('button',{id:'voiceLegacyHistoryBtn',class:'btn ghost',type:'button'},'查看旧文字记录');history.addEventListener('click',()=>openVoiceHistory(channel.id));dom.stageActions.append(history);}
}

function updateTileState(userId) {
  const node = dom.stageGrid.querySelector(`[data-status-for="${userId}"]`);
  if (!node) return;
  const user = state.users.get(userId);
  if (!user) return;
  const stateStr = state.peerStates.get(userId);
  if (user.muted || user.serverMuted) {
    node.innerHTML = `<span class="tile-status muted">${icon('micOff', 14)} ${user.serverMuted ? '管理静音' : '已静音'}</span>`;
    return;
  }
  if (user.id === state.selfId) {
    node.innerHTML = `<span class="tile-status dim">${icon('mic', 14)} 你</span>`;
    return;
  }
  const map = { new: '连接中…', connecting: '连接中…', failed: '连接失败', disconnected: '重连中…', closed: '已断开' };
  if (stateStr && stateStr !== 'connected' && state.voiceChannelId === user.voiceChannelId) {
    node.innerHTML = `<span class="tile-status dim">${icon('signal', 14)} ${map[stateStr] || stateStr}</span>`;
  } else {
    node.innerHTML = `<span class="tile-status dim">${icon('signal', 14)} 已连接</span>`;
  }
}

function renderMessages() {
  ensureChatView();chatMedia?.refresh();
  const channel=activeChannel();
  $('#chat').hidden=channel?.type!=='text';
  dom.msgInput.disabled=channel?.type!=='text';
  chatView.render({channel:channel?.type==='text' ? channel : null,messages:channel?.type==='text' ? state.messages.get(channel.id) || [] : [],authors:chatAuthors(channel?.id),...mentionSnapshot()});
}

function chatAuthors(channelId) {
  const authors=new Map(state.users),domainId=findChannel(channelId)?.server.id;
  const byId=new Map(),byKey=new Map(),titles=new Map();
  for(const member of serverGovernance?.members ?? []){byId.set(member.userId,member);byKey.set(member.memberKey,member);}
  for(const message of state.messages.get(channelId) || []) {
    const key=message.authorId?authorKeys.get(message.authorId):byId.get(message.userId)?.memberKey;
    const liveId=message.authorId?byKey.get(key)?.userId:message.userId;
    const author=state.users.get(liveId) ?? {name:message.name,color:message.color};
    if(key && !titles.has(key))titles.set(key,serverGovernance?memberTitles(serverGovernance.policy,key,domainId):[]);
    authors.set(message.authorId ?? message.userId,{...author,titles:titles.get(key) ?? []});
  }
  return authors;
}

/** @returns {{selfKey:string|null,members:{memberKey:string,name:string}[]}} */
function mentionSnapshot(){return{selfKey:serverGovernance?.selfKey ?? null,members:(serverGovernance?.members ?? []).filter(member=>member.memberKey).map(member=>({memberKey:member.memberKey,name:state.users.get(member.userId)?.name ?? '成员'}))};}

/** @param {string} channelId */
function openVoiceHistory(channelId){
  const channel=findChannel(channelId)?.channel;
  if(channel?.type!=='voice')return;
  const body=el('div',{id:'voiceLegacyHistory',class:'messages',style:{maxHeight:'65vh',overflow:'auto'}});
  const view=createChatView(body,{escape:esc,body:renderText,time:fmtTime,day:fmtDay,color:colorFor,avatar:avatarHtml,icon});
  view.render({channel,messages:state.messages.get(channel.id)||[],authors:chatAuthors(channel?.id),...mentionSnapshot()});
  const close=el('button',{id:'closeVoiceHistoryBtn',class:'btn ghost'},'关闭');
  const modal=openModal({title:channel.name+' · 旧文字记录（只读）',body,width:720,footer:[close]});close.addEventListener('click',()=>modal.close());
}

function ensureChatView(){if(!chatView)chatView=createChatView(dom.messages,{escape:esc,body:renderText,time:fmtTime,day:fmtDay,color:colorFor,avatar:avatarHtml,icon});return chatView;}

function renderMembers() {
  publishInterfaceState({serverName:serverGovernance?.server.name??activeServer()?.name??'',channelName:activeChannel()?.name??'',connected:state.connStatus==='open',memberCount:state.users.size});
  const groups = new Map();
  const online=sortedOnline();
  const voiceUsers = online.filter((u) => u.voiceChannelId);
  const onlineUsers = online.filter((u) => !u.voiceChannelId);

  if (voiceUsers.length) {
    groups.set('语音中', voiceUsers);
  }
  groups.set('在线', onlineUsers);

  const html = [];
  for (const [label, users] of groups) {
    if (!users.length) continue;
    html.push(`<div class="members-group" data-member-group="${esc(label)}"><div class="members-label">${label} — ${users.length}</div>`);
    for (const user of users) {
      const isSelf = user.id === state.selfId;
      const ch = user.voiceChannelId ? findChannel(user.voiceChannelId) : null;
      const speaking = state.speaking.has(user.id);
      let sub = '';
      if (ch) sub = `语音 · ${esc(ch.channel.name)}`;
      else if (isSelf) sub = '在线';
      html.push(`
        <div class="member ${speaking ? 'speaking' : ''}" data-user-id="${esc(user.id)}">
          <div class="member-avatar">${avatarHtml(user, 32)}</div>
          <div class="member-info">
            <div class="member-name">${esc(user.name)}${isSelf ? ' <span class="you">你</span>' : ''}</div>
            <div class="member-role">${esc(roleLabel(serverGovernance,state.activeServerId,user.id))}</div>
            ${sub ? `<div class="member-sub">${sub}</div>` : ''}
          </div>
          ${user.deafened ? `<span class="member-flag">${icon('headphonesOff', 14)}</span>` : user.muted || user.serverMuted ? `<span class="member-flag" title="${user.serverMuted ? '管理静音' : '静音'}">${icon('micOff', 14)}</span>` : ''}
        </div>`);
    }
    html.push('</div>');
  }
  reconcileMarkup(dom.membersScroll,html.join('') || '<div class="empty-hint">还没有其他成员</div>');
}

function updateSelfPanel() {
  if (!dom.selfPanel) return;
  const user = me();
  const name = (user && user.name) || state.settings.name || '未命名';
  const color = (user && user.color) || state.settings.color;
  const muted = engine ? engine.muted || engine.serverMuted : false;
  const deafened = engine ? engine.deafened : false;
  const inVoice = !!state.voiceChannelId;
  const ch = inVoice ? findChannel(state.voiceChannelId) : null;

  let status;
  if (state.connStatus !== 'open') {
    status = inVoice ? '房间离线 · 通话保持' : '房间连接中…';
  } else if (inVoice && ch) {
    status = `语音中 · ${ch.channel.name}`;
  } else {
    status = state.latency != null ? `房间往返 ${state.latency}ms` : '在线';
  }
  const muteShortcut = state.desktopSettings?.muteShortcut || 'Ctrl+Shift+M';
  const muteTitle = `${muted ? '取消静音' : '静音'} (${muteShortcut})`;
  const deafenTitle = `${deafened ? '恢复声音' : '闭音'} (Ctrl+Shift+D)`;
  if (dom.selfPanel.querySelector('.quick-volume:hover, .quick-volume:focus-within')) {
    for (const [action, enabled, glyph, title] of [['mute', muted, muted ? 'micOff' : 'mic', muteTitle], ['deafen', deafened, deafened ? 'headphonesOff' : 'headphones', deafenTitle]]) {
      const button = dom.selfPanel.querySelector(`[data-self-action="${action}"]`);
      if (button) { button.classList.toggle('on-danger', enabled); button.setAttribute('aria-pressed', String(enabled)); button.title = title; button.innerHTML = icon(glyph, 18); }
    }
    const statusNode = dom.selfPanel.querySelector('.self-status');
    if (statusNode) { statusNode.textContent = status; statusNode.className = `self-status ${state.connStatus !== 'open' ? 'bad' : inVoice ? 'voice' : ''}`; }
    return;
  }

  dom.selfPanel.innerHTML = `
    <div class="self-main">
      ${avatarHtml({ name, color, avatar: state.settings.avatar }, 34, 'self-avatar')}
      <div class="self-meta">
        <div class="self-name">${esc(name)}</div>
        <div class="self-status ${state.connStatus !== 'open' ? 'bad' : inVoice ? 'voice' : ''}">${esc(status)}</div>
      </div>
    </div>
    <div class="self-actions">
      <button class="icon-btn ${muted ? 'on-danger' : ''}" data-self-action="mute" aria-pressed="${muted}" title="${esc(muteTitle)}">
        ${icon(muted ? 'micOff' : 'mic', 18)}
      </button>
      <button class="icon-btn ${deafened ? 'on-danger' : ''}" data-self-action="deafen" aria-pressed="${deafened}" title="${esc(deafenTitle)}">
        ${icon(deafened ? 'headphonesOff' : 'headphones', 18)}
      </button>
      <button class="icon-btn" data-self-action="settings" title="设置">${icon('settings', 18)}</button>
    </div>
  `;
  for (const [action, key, maximum, label] of [['mute', 'micVolume', 200, '麦克风输入音量'], ['deafen', 'outVolume', 100, '扬声器输出音量']]) {
    const button = dom.selfPanel.querySelector(`[data-self-action="${action}"]`);
    if (button) attachQuickVolume(button, { label, value: state.settings[key], max: maximum, async onChange(value) {
      state.settings[key] = value;
      if (engine) await engine.applySettings({ [key]: value });
      saveSettings(state.settings);
    }, reportError: reportNetworkError });
  }
}

function updateConnPill() {
  if (!dom.connPill) return;
  const map = {
    open: [state.roomReady ? '房间已连接' : '房间验证中', state.roomReady ? 'ok' : 'warn'],
    connecting: ['连接中…', 'warn'],
    reconnecting: ['重连中…', 'warn'],
    disconnected: ['已断开', 'bad'],
    closed: ['已断开', 'bad'],
    idle: ['未连接', 'bad'],
  };
  const [text, cls] = map[state.connStatus] || ['连接中…', 'warn'];
  dom.connPill.className = `conn-pill ${cls}`;
  const peers = engine ? Object.values(engine.getPeerInfo()) : [];
  const roundTrips = peers.filter((peer) => peer.pcState === 'connected' && peer.roundTripMs !== null).map((peer) => peer.roundTripMs);
  const voiceLabel = state.voiceChannelId && peers.length ? roundTrips.length ? ` · 语音往返 ${Math.max(...roundTrips)}ms` : ' · 语音往返待测' : '';
  const roomLabel = state.latency !== null && cls === 'ok' ? `房间往返 ${state.latency}ms` : '房间往返待测';
  dom.connPill.innerHTML = `<span class="conn-dot"></span>${text}${voiceLabel}`;
  dom.connPill.title = `${roomLabel}；语音往返来自实际 WebRTC 链路，多人时显示最高值。两者均不是单向说话到听见的延迟。`;
}

/* -------------------------------------------------------------------- */
/* 交互                                                                  */
/* -------------------------------------------------------------------- */

function wireStaticUI() {
  // 服务器切换
  dom.serverList.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-server-id]');
    if (!btn) return;
    const srv = findServer(btn.dataset.serverId);
    if (!srv) return;
    state.activeServerId = srv.id;
    const first = srv.channels.find((c) => c.type === 'text') || srv.channels[0];
    state.activeChannelId = first ? first.id : null;
    rememberChannel();
    renderAll();
  });

  // 频道选择（单击仅查看） / 双击进入
  // 注意：单击后 sidebar 会重渲染，原生 dblclick 会因两次点击目标不同而失效，
  // 所以这里自己统计同一频道的连续点击。
  let lastChannelClick = { id: null, at: 0 };
  dom.channelScroll.addEventListener('click', (ev) => {
    const settingsButton=ev.target.closest('[data-channel-settings]');
    if(settingsButton){const rect=settingsButton.getBoundingClientRect();openChannelMenu({clientX:rect.right,clientY:rect.bottom},settingsButton.dataset.channelSettings);return;}
    const createBtn = ev.target.closest('[data-create]');
    if (createBtn) {
      openCreateChannel(createBtn.dataset.create);
      return;
    }
    if (ev.target.closest('.ch-member')) return; // 点成员不切换频道
    const row = ev.target.closest('[data-channel-id]');
    if (!row) return;
    const channelId = row.dataset.channelId;
    const now = Date.now();
    const isDoubleClick =
      lastChannelClick.id === channelId && now - lastChannelClick.at > 0 && now - lastChannelClick.at < 420;
    if (isDoubleClick) {
      lastChannelClick = { id: null, at: 0 };
      enterChannel(channelId);
      return;
    }
    lastChannelClick = { id: channelId, at: now };
    selectChannel(channelId);
  });

  // 原生 dblclick 作为兜底（某些环境下 click 计数不可靠）
  dom.channelScroll.addEventListener('dblclick', (ev) => {
    const row = ev.target.closest('[data-channel-id]');
    if (!row) return;
    ev.preventDefault();
    lastChannelClick = { id: null, at: 0 };
    enterChannel(row.dataset.channelId);
  });

  // 频道右键菜单：加入语音 / 编辑频道（名称 + 人数上限）/ 删除
  dom.channelScroll.addEventListener('contextmenu', (ev) => {
    if(ev.target.closest('[data-user-id]'))return;
    const row=ev.target.closest('[data-channel-row]');if(!row)return;
    ev.preventDefault();openChannelMenu(ev,row.dataset.channelRow);
  });

  // 创建频道按钮（分组 +）
  $('#serverMenuBtn').addEventListener('click', (ev) => openServerMenu(ev));
  if(window.deepscord?.openConnectionPanel) installWorkspaceNavigation(window.deepscord);
  $('#addServerBtn').addEventListener('click', () => {
    if(!canManageServer())return;
    const generation=governanceGeneration;
    const input=el('input',{id:'createDomainNameInput',class:'input',placeholder:'域名称',maxlength:'20',autocomplete:'off','aria-label':'域名称'});
    const submit=el('button',{id:'createDomainSubmitBtn',class:'btn primary'},'添加域');
    const cancel=el('button',{id:'createDomainCancelBtn',class:'btn ghost'},'取消');
    const dialog=openModal({title:'添加域',width:460,body:input,footer:[cancel,submit]});
    const create=()=>{
      if(generation!==governanceGeneration || !canManageServer()){dialog.close();return;}
      const name=input.value.trim();
      if(!name){input.focus();return;}
      if(!socket.send({t:'createServer',name}))return toast('添加域失败：房间连接已中断','error');
      dialog.close();
    };
    submit.addEventListener('click',create);cancel.addEventListener('click',()=>dialog.close());
    input.addEventListener('keydown',event=>{if(event.key==='Enter')create();});
  });
  if(!window.deepscord?.openConnectionPanel){const brand=$('.rail-brand');brand.setAttribute('role','button');brand.setAttribute('aria-label','切换或添加服务器');brand.tabIndex=0;const openWorkspace=()=>toast('切换或添加服务器请使用桌面客户端','info');brand.addEventListener('click',openWorkspace);brand.addEventListener('keydown',event=>{if(event.key==='Enter' || event.key===' '){event.preventDefault();openWorkspace();}});}
  dom.messages.addEventListener('contextmenu',ev=>{
    const row=ev.target.closest('[data-msg-id]');
    const channel=activeChannel();
    if(!row || !channel)return;
    const message=(state.messages.get(channel.id)||[]).find(item=>item.id===row.dataset.msgId),items=[];
    if(message?.attachment && chatMedia)items.push({id:'favoriteMessageMenuBtn',label:'加入个人收藏',icon:'plus',onClick:()=>chatMedia.favoriteMessage(message,new AbortController().signal).catch(reportNetworkError)});
    if(canPerform(serverGovernance,state.activeServerId,'manageMessages'))items.push({id:'deleteMessageMenuBtn',label:'删除消息',icon:'trash',danger:true,onClick:()=>socket.send({t:'deleteMessage',channelId:channel.id,messageId:row.dataset.msgId})});
    if(!items.length)return;ev.preventDefault();openContextMenu(ev,items);
  });
  for(const surface of [dom.membersScroll,dom.channelScroll,dom.stageGrid])surface.addEventListener('contextmenu',openMemberMenu);
  $('#railSettingsBtn').addEventListener('click', openSettings);
  $('#serverName').addEventListener('click', (ev) => openServerMenu(ev));
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.context-menu') && !ev.target.closest('[data-channel-settings]') && !ev.target.closest('#serverMenuBtn') && !ev.target.closest('#serverName')) {
      closeContextMenu();
    }
  });

  // 侧边栏底部按钮（自绘）
  dom.selfPanel.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-self-action]');
    if (!btn) return;
    if (btn.dataset.selfAction === 'mute') toggleMute();
    else if (btn.dataset.selfAction === 'deafen') toggleDeafen();
    else if (btn.dataset.selfAction === 'settings') openSettings();
  });

  // 语音舞台按钮
  dom.stageActions.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'join') joinVoice(state.activeChannelId);
    else if (action === 'leave') leaveVoice();
    else if (action === 'mute') toggleMute();
    else if (action === 'deafen') toggleDeafen();
  });

  // 发送消息
  dom.composer.addEventListener('submit', (ev) => {
    ev.preventDefault();
    sendCurrentMessage();
  });
  dom.msgInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      sendCurrentMessage();
    }
  });
  dom.msgInput.addEventListener('input', () => {
    dom.msgInput.style.height = 'auto';
    dom.msgInput.style.height = Math.min(160, dom.msgInput.scrollHeight) + 'px';
  });

  // 成员栏开关
  $('#toggleMembers').addEventListener('click', () => toggleMembersPanel());

  // 点击消息区空白聚焦输入框
  dom.messages.addEventListener('click', (ev) => {
    if (ev.target === dom.messages) dom.msgInput.focus();
  });
}

function rememberChannel() {
  if (!state.activeChannelId) return;
  store.set('echo.lastChannel', {
    serverId: state.activeServerId,
    channelId: state.activeChannelId,
  });
  if(window.deepscord?.saveLastChannel)window.deepscord.saveLastChannel({serverId:state.activeServerId,channelId:state.activeChannelId}).catch(reportNetworkError);
}

function selectChannel(channelId, opts = {}) {
  const hit = findChannel(channelId);
  if (!hit) return;
  state.activeServerId = hit.server.id;
  state.activeChannelId = channelId;
  rememberChannel();
  if (hit.channel.type !== 'text' && opts.enter) {
    if (state.voiceChannelId !== channelId) joinVoice(channelId);
    else renderAll();
  } else {
    renderAll();
  }
  if(hit.channel.type==='text')dom.msgInput.focus();
}

/** 双击进入频道：语音频道 = 加入语音；文字频道 = 选中并聚焦输入框 */
function enterChannel(channelId) {
  const hit = findChannel(channelId);
  if (!hit) return;
  if (hit.channel.type !== 'text') {
    selectChannel(channelId, { enter: true });
  } else {
    selectChannel(channelId);
    dom.msgInput.focus();
  }
}

async function joinVoice(channelId) {
  if (!engine || !channelId) return;
  if (!state.roomReady) { toast('房间未连接，暂时不能加入或切换频道', 'warn'); return; }
  if (state.voiceChannelId === channelId || state.pendingVoiceChannelId) return;
  const sequence = ++voiceJoinSequence;
  try {
    state.pendingVoiceChannelId = channelId;
    await engine.ensureMic();
    if (sequence !== voiceJoinSequence || state.pendingVoiceChannelId !== channelId) {
      if (!engine.inVoice && state.pendingVoiceChannelId === null) engine.stopMic();
      return;
    }
    if (!state.roomReady || !socket.send({ t: 'joinVoice', channelId, muted: engine.muted, deafened: engine.deafened })) throw new Error('房间连接已中断');
  } catch (error) {
    if (sequence !== voiceJoinSequence) return;
    state.pendingVoiceChannelId = null;
    if (!engine.inVoice) engine.stopMic();
    reportNetworkError(error);
  }
}

async function onVoicePeers(message) {
  if (!engine || message.channelId !== state.pendingVoiceChannelId) return;
  if (engine.inVoice && engine.channelId !== message.channelId) {
    if (musicCapture.context || musicCapture.starting) musicCapture.stop().catch(reportNetworkError);
    mediaUI.destroy();
  }
  engine.join(message.channelId);
  const self=me();if(self){self.serverMuted=message.serverMuted===true;syncMemberModeration(self);}
  for(const peer of message.peers){const user=state.users.get(peer.id);if(user){user.serverMuted=peer.serverMuted===true;syncMemberModeration(user);}}
  state.voiceChannelId = message.channelId;
  state.desiredVoiceChannelId = message.channelId;
  state.pendingVoiceChannelId = null;
  await engine.handlePeers(message.peers);
  renderAll();
}

/** @param {{id:string,serverMuted?:boolean}} user */
function syncMemberModeration(user){if(user.id===state.selfId)engine?.setServerMuted(user.serverMuted===true);else engine?.setPeerServerMuted(user.id,user.serverMuted===true);}

function leaveVoice() {
  voiceJoinSequence += 1;
  if (!engine) return;
  state.pendingVoiceChannelId = null;
  if (state.roomReady) socket.send({ t: 'leaveVoice' });
  engine.leave();
  state.voiceChannelId = null;
  state.desiredVoiceChannelId = null;
  const self = me();
  if (self) self.voiceChannelId = null;
  state.speaking.clear();
  state.peerStates.clear();
  renderAll();
}

function toggleMute() {
  if (!engine) return;
  if(engine.serverMuted){toast('你已被管理静音，请联系此域的管理员解除','warn');return;}
  engine.setMuted(!engine.muted);
}

function toggleDeafen() {
  if (!engine) return;
  const next = !engine.deafened;
  if (next) {
    if (!engine.muted) {
      pttPrevMuted = false;
      engine.setMuted(true);
    } else {
      pttPrevMuted = true;
    }
    engine.setDeafened(true);
    toast('已闭音（不接收他人声音）', 'info', 2200);
  } else {
    engine.setDeafened(false);
    if (pttPrevMuted === false) engine.setMuted(false);
    pttPrevMuted = null;
  }
}

async function sendCurrentMessage() {
  if(textSendPending)return;
  const original=dom.msgInput.value;
  const text = dom.msgInput.value.trim();
  if (!text) return;
  const channel = activeChannel();
  if (!channel || channel.type!=='text') return;
  if (state.connStatus !== 'open') {
    toast('还没连上服务器，消息没有发出去', 'warn');
    return;
  }
  textSendPending=true;const send=$('#sendBtn');send.disabled=true;
  try{
    if(serverGovernance?.selfKey && chatMedia)await chatMedia.sendText(channel.id,text.slice(0,2000),new AbortController().signal);
    else if(!socket.send({t:'chat',channelId:channel.id,text:text.slice(0,2000)}))throw new Error('房间连接中断，消息没有发出去');
    if(dom.msgInput.value===original && state.activeChannelId===channel.id){dom.msgInput.value='';dom.msgInput.style.height='auto';dom.msgInput.focus();}
  }catch(error){if(!(error instanceof Error && error.name==='AbortError'))reportNetworkError(error);}
  finally{textSendPending=false;send.disabled=false;}
}

async function openSettings() {
  if (!engine) return;
  try {
    if (window.deepscord?.getDesktopSettings) state.desktopSettings = await window.deepscord.getDesktopSettings();
    openSettingsPanel({
      settings: state.settings,
      engine,
      desktopSettings: state.desktopSettings,
      async onDesktopSettingsChange(value) {
        state.desktopSettings = await window.deepscord.setDesktopSettings(value);
        syncVoiceOverlay();
      },
      onIdentityChange: () => {
        persistIdentity().then(() => {
          const user = me();
          if (user) Object.assign(user, { name: state.profile.name, color: state.profile.color, ...profilePayload(state.profile) });
          if (state.roomReady) socket.send({ t: 'rename', name: state.profile.name, color: state.profile.color, ...profilePayload(state.profile) });
          renderAll();
          syncVoiceOverlay();
        }).catch(reportNetworkError);
      },
    });
  } catch (error) { reportNetworkError(error); }
}

/* -------------------------------------------------------------------- */
/* 菜单 / 创建频道 / 服务器                                              */
/* -------------------------------------------------------------------- */

let contextMenuEl = null;

function openChannelMenu(ev,channelId) {
    const hit = findChannel(channelId);
    if (!hit) return;
    const generation=governanceGeneration;
    const items = [{id:'channelShareMenuBtn',label:'复制频道邀请',icon:'link',onClick:()=>copyChannelInvite(channelId).catch(reportNetworkError)}];
    if (hit.channel.type !== 'text') {
      items.push({ label: '加入语音频道', icon: 'phone', onClick: () => enterChannel(channelId) });
    }
    if(hit.channel.type==='radio')items.push({id:'radioChannelMenuBtn',label:'电台列表与换台',icon:'music',onClick:()=>radioClient.open(channelId)});
    if(canPerform(serverGovernance,hit.server.id,'manageChannels')) {
    items.push({
      id:'channelEditMenuBtn',
      label: hit.channel.type !== 'text' ? '频道设置 · 人数上限 '+(hit.channel.userLimit || '不限') : '频道设置 · 名称',
      icon: 'edit',
      onClick: () => openEditChannel(channelId),
    });
    items.push({
      id:'channelDeleteMenuBtn',label: '删除频道',
      icon: 'trash',
      danger: true,
      onClick: async () => {
        const ok = await confirmDialog({
          title: '删除频道',
          message: `确定删除「${hit.channel.name}」吗？频道内的消息会一起删除。`,
          confirmText: '删除频道',
          danger: true,
        });
        if (ok && generation===governanceGeneration && canPerform(serverGovernance,hit.server.id,'manageChannels')) socket.send({ t: 'deleteChannel', channelId });
      },
    });
    }
    if(items.length)openContextMenu(ev, items);
}

function openContextMenu(ev, items) {
  closeContextMenu();
  const menu = el('div', { class: 'context-menu',role:'menu' });
  for (const item of items) {
    if (item.sep) {
      menu.appendChild(el('div', { class: 'menu-sep' }));
      continue;
    }
    const btn = el(
      'button',
      { role:'menuitem',class: 'menu-item' + (item.danger ? ' danger' : ''), ...(item.id ? {id:item.id} : {}) },
      el('span', { class: 'menu-ico', html: icon(item.icon || 'chevronRight', 16) }),
      el('span', {}, item.label)
    );
    btn.addEventListener('click', () => {
      closeContextMenu();
      Promise.resolve().then(()=>item.onClick?.()).catch(reportNetworkError);
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  let x = ev.clientX;
  let y = ev.clientY;
  if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
  if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
  contextMenuEl = menu;
}

function closeContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.remove();
    contextMenuEl = null;
  }
}

/** @param {MouseEvent} event */
function openMemberMenu(event){
  const target=event.target;
  if(!(target instanceof Element))return;
  const row=target.closest('[data-user-id]'),user=state.users.get(row?.getAttribute('data-user-id'));
  if(!user)return;
  /** @type {{id:string,label:string,icon:string,danger?:boolean,onClick:()=>void}[]} */const items=[];
  const memberKey=serverGovernance?.members.find(member=>member.userId===user.id)?.memberKey;
  if(memberKey && activeServer()?.channels.some(channel=>channel.type==='text'))items.push({id:'mentionMemberMenuBtn',label:'@ '+user.name,icon:'hash',onClick:()=>insertMemberMention(memberKey)});
  if(memberKey && serverGovernance && canManageMember(serverGovernance.policy,serverGovernance.selfKey,memberKey,state.activeServerId))items.push({id:'assignMemberPermissionsMenuBtn',label:'分配成员权限…',icon:'settings',onClick:()=>openMemberGovernance(memberKey)});
  const domainId=user.voiceChannelId ? findChannel(user.voiceChannelId)?.server.id : null;
  if(domainId && canModerateMember(serverGovernance,domainId,user.id)){
    const muted=user.serverMuted===true;
    items.push({id:'serverMuteMemberMenuBtn',label:muted ? '解除管理静音' : '管理静音',icon:muted ? 'mic' : 'micOff',onClick:()=>{if(!canModerateMember(serverGovernance,domainId,user.id))return;if(!socket.send({t:'setVoiceMute',userId:user.id,muted:!muted}))reportNetworkError(new Error('管理静音发送失败：房间连接已中断'));}});
    items.push({id:'disconnectVoiceMenuBtn',label:'断开成员语音',icon:'phone',danger:true,onClick:()=>{if(canModerateMember(serverGovernance,domainId,user.id) && !socket.send({t:'disconnectVoice',userId:user.id}))reportNetworkError(new Error('断开语音发送失败：房间连接已中断'));}});
  }
  if(!items.length)return;
  event.preventDefault();openContextMenu(event,items);
}

/** @param {string} memberKey */
function insertMemberMention(memberKey){
  const channel=activeChannel()?.type==='text' ? activeChannel() : activeServer()?.channels.find(channel=>channel.type==='text');
  if(!channel)return;
  if(channel.id!==state.activeChannelId)selectChannel(channel.id);
  const input=dom.msgInput,token='<@'+memberKey+'> ',start=input.selectionStart,end=input.selectionEnd;
  if(input.value.length-end+start+token.length>input.maxLength){toast('输入内容已达长度上限，无法插入提及','warn');return;}
  input.setRangeText(token,start,end,'end');input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();
}

function openServerMenu(ev) {
  ev.stopPropagation();
  const srv=activeServer(),rect=(ev.currentTarget || ev.target).getBoundingClientRect();
  const items=[{id:'serverGovernanceMenuBtn',label:'服务器与域管理',icon:'settings',onClick:openServerGovernance}];
  if(serverGovernance?.selfKey)items.push({id:'themeCustomizationMenuBtn',label:'本机界面自定义',icon:'edit',onClick:()=>openServerCustomization('theme')});
  if(serverGovernance?.selfKey && canManageServerCatalog(serverGovernance.policy,serverGovernance.selfKey))items.push(
    {id:'interactionCustomizationMenuBtn',label:'互动表情管理',icon:'settings',onClick:()=>prepareInteractionCustomization().catch(reportNetworkError)}
  );
  if(window.deepscord?.activateContentRoom&&serverGovernance&&roomDescriptor)items.push({id:'contentSettingsMenuBtn',label:contentClient.encrypted?'内容加密已开启':'内容加密与历史迁移',icon:'settings',onClick:()=>openContentSettings({modal:openModal,content:contentClient,client:chatMediaClient,descriptor:roomDescriptor,journal:serverGovernance.journal,owner:isServerOwner(),emojis:serverGovernance.policy.emojis??[],onBusy:busy=>{contentLocalMigration=busy;},onComplete:async policy=>{const key=await contentClient.initialize({descriptor:roomDescriptor,journal:serverGovernance.journal,policy});key?.key.fill(0);location.reload();},reportError:reportNetworkError})});
  if(srv) {
    items.push({id:'copyChannelInviteMenuBtn',label:'复制频道邀请',icon:'link',onClick:()=>copyChannelInvite(state.activeChannelId).catch(reportNetworkError)});
    if(canPerform(serverGovernance,srv.id,'manageChannels')) {
      items.push({sep:true},{label:'创建文字频道',icon:'hash',onClick:()=>openCreateChannel('text')},{label:'创建语音频道',icon:'volume',onClick:()=>openCreateChannel('voice')},{id:'createRadioMenuBtn',label:'创建电台频道',icon:'music',onClick:()=>openCreateChannel('radio')});
      items.push({id:'renameDomainMenuBtn',label:'重命名域',icon:'edit',onClick:async()=>{
        const generation=governanceGeneration;
        const name=await promptDialog({title:'重命名域',value:srv.name,submitText:'保存',maxlength:20});
        if(name && generation===governanceGeneration && canPerform(serverGovernance,srv.id,'manageChannels'))socket.send({t:'updateDomain',domainId:srv.id,name});
      }});
    }
    if(canManageServer())items.push({sep:true},{id:'deleteDomainMenuBtn',label:'删除域',icon:'trash',danger:true,onClick:()=>{
      const generation=governanceGeneration;
      const confirm=el('button',{id:'deleteDomainConfirmBtn',class:'btn danger'},'删除域');
      const cancel=el('button',{id:'deleteDomainCancelBtn',class:'btn ghost'},'取消');
      const dialog=openModal({title:'删除域',width:420,body:el('p',{class:'dialog-text'},`确定删除「${srv.name}」吗？其中的频道、消息与权限组都会删除。`),footer:[cancel,confirm]});
      cancel.addEventListener('click',()=>dialog.close());
      confirm.addEventListener('click',async()=>{
        if(generation!==governanceGeneration || !canManageServer()){dialog.close();return;}
        confirm.disabled=true;
        try {await submitGovernance({type:'deleteDomain',domainId:srv.id});dialog.close();}
        catch(error){confirm.disabled=false;reportNetworkError(error);}
      });
    }});
  }
  openContextMenu({clientX:rect.left,clientY:rect.bottom+6},items);
}

async function openCreateChannel(type) {
  const domainId=state.activeServerId,generation=governanceGeneration;
  if(!canPerform(serverGovernance,domainId,'manageChannels'))return;
  let picked=type;
  const input=el('input',{id:'createChannelName',class:'input',maxlength:'20',autocomplete:'off',placeholder:'频道名称'});
  const choices=el('div',{class:'segmented'}),radio=createRadioFields();
  for(const [value,label] of [['voice','语音'],['text','文字'],['radio','电台']]) {
    const button=el('button',{id:'createChannelType-'+value,type:'button',class:'seg'+(value===picked?' active':'')},label);
    button.addEventListener('click',()=>{picked=value;for(const child of choices.children)child.classList.toggle('active',child===button);radio.element.hidden=picked!=='radio';});choices.append(button);
  }
  radio.element.hidden=picked!=='radio';
  const error=el('p',{id:'createChannelError',class:'governance-error',role:'alert',hidden:true},'');
  const submitBtn=el('button',{id:'createChannelSubmit',class:'btn primary'},'创建频道'),cancelBtn=el('button',{id:'createChannelCancel',class:'btn ghost'},'取消');
  const dlg=openModal({title:'创建频道',width:500,body:el('div',{class:'field'},choices,input,radio.element,error),footer:[cancelBtn,submitBtn]});
  const submit=()=>{
    try {
      if(generation!==governanceGeneration || !canPerform(serverGovernance,domainId,'manageChannels'))throw new Error('服务器连接或管理权限已变化，请重新打开');
      const name=input.value.trim();if(!name)throw new Error('请填写频道名称');
      const configuration=picked==='radio'?{radio:radio.read()}:{};
      if(!socket.send({t:'createChannel',serverId:domainId,type:picked,name,...configuration}))throw new Error('房间连接中断，频道没有创建');
      dlg.close();
    } catch(failure) {error.hidden=false;error.textContent=failure instanceof Error?failure.message:String(failure);}
  };
  submitBtn.addEventListener('click',submit);cancelBtn.addEventListener('click',()=>dlg.close());input.addEventListener('keydown',event=>{if(event.key==='Enter')submit();});
}

/* -------------------------------------------------------------------- */
/* 编辑频道（右键语音频道：名称 + 人数上限）                              */
/* -------------------------------------------------------------------- */

function openEditChannel(channelId) {
  const hit = findChannel(channelId);
  if (!hit || !canPerform(serverGovernance,hit.server.id,'manageChannels')) return;
  const generation=governanceGeneration;
  const channel = hit.channel;
  const isVoice = channel.type !== 'text';
  const nameInput = el('input', {
    class: 'input',
    value: channel.name,
    id: 'editChannelNameInput',
    maxlength: '20',
    autocomplete: 'off',
    placeholder: '频道名称',
  });
  const limitInput = isVoice
    ? el('input', {
        class: 'input',
        id: 'editChannelLimitInput',
        type: 'number',
        min: '0',
        max: '100',
        step: '1',
        value: String(Number(channel.userLimit) || 0),
        placeholder: '0 = 不限',
      })
    : null;

  const body = el(
    'div',
    { class: 'field' },
    el('div', { class: 'edit-label' }, channel.type==='radio' ? '电台频道名称' : isVoice ? '语音频道名称' : '文字频道名称'),
    nameInput,
    isVoice ? el('div', { class: 'edit-label' }, '人数上限（0 = 不限，最多 100）') : null,
    limitInput,
    isVoice
      ? el('p', { class: 'edit-hint' }, '达到上限后，其他人双击进入会提示「人数已满」。频道栏会显示「当前人数/上限」。')
      : null
  );

  const submitBtn = el('button', { class: 'btn primary', id:'editChannelSaveBtn' }, '保存修改');
  const cancelBtn = el('button', { class: 'btn ghost' }, '取消');
  const dlg = openModal({
    title: channel.type==='radio' ? '编辑电台频道' : isVoice ? '编辑语音频道' : '编辑文字频道',
    width: 460,
    body,
    footer: [cancelBtn, submitBtn],
  });

  const submit = () => {
    if(generation!==governanceGeneration || !canPerform(serverGovernance,hit.server.id,'manageChannels')){dlg.close();return;}
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.classList.add('shake');
      setTimeout(() => nameInput.classList.remove('shake'), 350);
      return;
    }
    let userLimit = 0;
    if (isVoice) {
      const n = Number(limitInput.value);
      if(!Number.isInteger(n) || n<0 || n>100){toast('人数上限必须是 0 到 100 的整数','warn');limitInput.focus();return;}
      userLimit = n;
    }
    socket.send({ t: 'updateChannel', channelId, name, userLimit });
    dlg.close();
    toast('频道已更新', 'success', 1800);
  };
  submitBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', () => dlg.close());
  nameInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') submit();
  });
  if (limitInput) {
    limitInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') submit();
    });
  }
}

/* -------------------------------------------------------------------- */
/* 快捷键 / PTT                                                          */
/* -------------------------------------------------------------------- */

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function modalOpen() {
  return !!document.querySelector('.modal-backdrop.open');
}

function setupShortcuts() {
  if (window.deepscord?.onMuteShortcut) window.deepscord.onMuteShortcut(() => toggleMute());
  window.addEventListener('keydown', (ev) => {
    const typing = isTypingTarget(ev.target);
    if (!window.deepscord?.onMuteShortcut && ev.ctrlKey && ev.shiftKey && !ev.repeat && (ev.key === 'M' || ev.key === 'm')) {
      ev.preventDefault();
      toggleMute();
      return;
    }
    if (ev.ctrlKey && ev.shiftKey && (ev.key === 'D' || ev.key === 'd')) {
      ev.preventDefault();
      toggleDeafen();
      return;
    }
    if (typing || modalOpen() || !engine) return;
    if (state.settings.mode === 'ptt' && ev.code === state.settings.pttKey && !ev.repeat) {
      ev.preventDefault();
      engine.setPTTDown(true);
    }
  });

  window.addEventListener('keyup', (ev) => {
    if (!engine) return;
    if (state.settings.mode === 'ptt' && ev.code === state.settings.pttKey) {
      engine.setPTTDown(false);
    }
  });

  window.addEventListener('blur', () => {
    if (engine) engine.setPTTDown(false);
  });
}

function setupPttMouse() {
  const handleDown = (ev) => {
    if (state.settings.mode !== 'ptt') return;
    const key = ev.button === 3 ? 'Mouse4' : ev.button === 4 ? 'Mouse5' : null;
    if (!key || key !== state.settings.pttKey) return;
    ev.preventDefault();
    engine?.setPTTDown(true);
  };
  const handleUp = (ev) => {
    if (state.settings.mode !== 'ptt') return;
    const key = ev.button === 3 ? 'Mouse4' : ev.button === 4 ? 'Mouse5' : null;
    if (!key || key !== state.settings.pttKey) return;
    ev.preventDefault();
    engine?.setPTTDown(false);
  };
  window.addEventListener('mousedown', handleDown, true);
  window.addEventListener('mouseup', handleUp, true);
  window.addEventListener('auxclick', (ev) => {
    if (ev.button === 3 || ev.button === 4) ev.preventDefault();
  }, true);
}

/* -------------------------------------------------------------------- */
/* 诊断接口（供开发者/自动化测试使用）                                    */
/* -------------------------------------------------------------------- */

window.echo = {
  version: '1.0.0',
  getState() {
    return {
      selfId: state.selfId,
      selfName: me() && me().name,
      connStatus: state.connStatus,
      roomReady: state.roomReady,
      networkMode: state.config.networkMode,
      mediaPolicy: state.config.mediaPolicy,
      latency: state.latency,
      roomRoundTripMs: state.latency,
      activeServerId: state.activeServerId,
      activeChannelId: state.activeChannelId,
      voiceChannelId: state.voiceChannelId,
      users: [...state.users.values()],
      servers: state.servers,
      messageCounts: Object.fromEntries([...state.messages.entries()].map(([k, v]) => [k, v.length])),
      settings: { ...state.settings },
      governanceDigest:serverGovernance?.journal.digest ?? null,
      identityStatus,selfKey:serverGovernance?.selfKey ?? null,ownerKey:serverGovernance?.policy.ownerKey ?? null,chatMedia:chatMedia?.stats() ?? null,
    };
  },
  getVoiceStats() {
    if (!engine) return null;
    return {
      channelId: engine.channelId,
      micReady: engine.micReady,
      muted: engine.muted,
      deafened: engine.deafened,
      monitor: engine.monitorEnabled,
      localLevel: engine.localLevel,
      roomRoundTripMs: state.latency,
      peers: engine.getPeerInfo(),
      capture: engine.getCaptureInfo(),
      screenSharing: engine.screenStream !== null,
      screenTransport: engine.getScreenStats(),
      accompaniment: engine.accompanimentStream !== null,
    };
  },
  actions: {
    selectChannel,
    enterChannel,
    joinVoice,
    leaveVoice,
    toggleMute,
    toggleDeafen,
    openSettings,
    openEditChannel,
    sendMessage(text) {
      dom.msgInput.value = text;
      sendCurrentMessage();
    },
  },
};

/* -------------------------------------------------------------------- */
boot().catch(reportNetworkError);
