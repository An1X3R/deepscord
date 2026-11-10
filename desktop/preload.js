'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deepscord', {
  confirmAction:input=>ipcRenderer.invoke('workspace:confirm-action',input),
  getWindowVisibility:()=>ipcRenderer.invoke('window:visibility'),
  /** @param {(visible:boolean)=>void} callback @returns {()=>void} */
  onWindowVisibility:callback=>{const listener=(_event,visible)=>{if(typeof visible!=='boolean')throw new TypeError('Invalid native window visibility');callback(visible);};ipcRenderer.on('window:visibility',listener);return ()=>ipcRenderer.removeListener('window:visibility',listener);},
  inspectRadioStation: input => ipcRenderer.invoke('radio:inspect',input),
  readRadioMetadata: input => ipcRenderer.invoke('radio:metadata',input),
  cancelRadioMetadata: id => ipcRenderer.invoke('radio:cancel',id),
  authorizeRadioResource: input => ipcRenderer.invoke('radio:authorize',input),
  releaseRadioStation: id => ipcRenderer.invoke('radio:release',id),
  getClientPreferences: () => ipcRenderer.invoke('preferences:get'),
  listServerInteractions: roomId => ipcRenderer.invoke('customization:server-interactions',roomId),
  listInterfaceSchemes: () => ipcRenderer.invoke('customization:interfaces'),
  openResourceManager: () => ipcRenderer.invoke('resource-manager:open'),
  readInteractionDraftAsset: input => ipcRenderer.invoke('customization:interaction-asset',input),
  openCustomizationDirectory: kind => ipcRenderer.invoke('customization:open-directory',kind),
  saveClientPreferences: input => ipcRenderer.invoke('preferences:settings',input),
  saveLastChannel: input => ipcRenderer.invoke('preferences:channel',input),
  getRoomPassword: () => ipcRenderer.invoke('room-password:get'),
  saveRoomPassword: input => ipcRenderer.invoke('room-password:set',input),
  activateContentRoom: input => ipcRenderer.invoke('content:activate',input),
  prepareContentRoom: () => ipcRenderer.invoke('content:prepare'),
  signContentPolicy: input => ipcRenderer.invoke('content:signPolicy',input),
  sealContentReaction: input => ipcRenderer.invoke('content:sealReaction',input),
  sealContentMessage: input => ipcRenderer.invoke('content:sealChat',input),
  openContentMessage: input => ipcRenderer.invoke('content:openChat',input),
  sealContentMedia: input => ipcRenderer.invoke('content:sealMedia',input),
  openContentMedia: input => ipcRenderer.invoke('content:openMedia',input),
  getWorkspace: () => ipcRenderer.invoke('workspace:list'),
  openConnectionPanel: (intent) => ipcRenderer.invoke('workspace:open',intent),
  getConnectionContext: () => ipcRenderer.invoke('workspace:context'),
  selectSavedRoom: (entryId) => ipcRenderer.invoke('workspace:select',entryId),
  reopenSavedRoom: (entryId) => ipcRenderer.invoke('workspace:reopen',entryId),
  removeSavedRoom: (entryId) => ipcRenderer.invoke('workspace:remove',entryId),
  prepareRoomVote: (offer) => ipcRenderer.invoke('workspace:vote',offer),
  signServerIdentity: (challenge) => ipcRenderer.invoke('workspace:identity',challenge),
  saveServerGovernance: (journal) => ipcRenderer.invoke('workspace:governance',journal),
  signGovernanceChange: (change) => ipcRenderer.invoke('workspace:governance-sign',change),
  signGovernanceCheckpoint: () => ipcRenderer.invoke('workspace:governance-checkpoint'),
  saveRoomDocument: (document) => ipcRenderer.invoke('workspace:commit',document),
  preserveRoomConflict: (candidates) => ipcRenderer.invoke('workspace:conflict',candidates),
  copyChannelInvite: (channelId) => ipcRenderer.invoke('workspace:copy-invite',channelId),
  getInvitedChannel: () => ipcRenderer.invoke('workspace:invited-channel'),
  beginShortcutCapture: () => ipcRenderer.invoke('desktop:shortcut:capture-begin'),
  endShortcutCapture: (id) => ipcRenderer.invoke('desktop:shortcut:capture-end', id),
  exportScreenDiagnostics: (report) => ipcRenderer.invoke('screen-diagnostics:export', report),
  screenRelayRoom: (request) => ipcRenderer.invoke('screen-relay:room', request),
  screenRelayBudget: (request) => ipcRenderer.invoke('screen-relay:budget', request),
  screenRelayOffer: (request) => ipcRenderer.invoke('screen-relay:offer', request),
  screenRelayIce: (request) => ipcRenderer.invoke('screen-relay:ice', request),
  screenRelayCandidates: (request) => ipcRenderer.invoke('screen-relay:candidates', request),
  screenRelayRemove: (id) => ipcRenderer.invoke('screen-relay:remove', id),
  screenRelayStats: () => ipcRenderer.invoke('screen-relay:stats'),
  listCaptureSources: () => ipcRenderer.invoke('capture:sources'),
  selectCaptureSource: (id) => ipcRenderer.invoke('capture:select', id),
  /** @param {import('./poke-overlay.cjs').BeginPoke} payload */
  beginScreenPokeSession: (payload) => ipcRenderer.invoke('poke:begin', payload),
  /** @param {import('./poke-overlay.cjs').PokeHit} payload */
  triggerScreenPokeOverlay: (payload) => ipcRenderer.invoke('poke:hit', payload),
  /** @param {{sessionId:string}} payload */
  clearScreenPokeOverlay: (payload) => ipcRenderer.invoke('poke:clear', payload),
  /** @param {{sessionId:string}} payload */
  endScreenPokeSession: (payload) => ipcRenderer.invoke('poke:end', payload),
  /** @param {import('./poke-request.cjs').RequestState} payload */
  updateScreenPokeRequests: (payload) => ipcRenderer.invoke('poke:requests', payload),
  /** @param {(decision:import('./poke-request.cjs').PokeDecision)=>void} callback @returns {()=>void} */
  onScreenPokeDecision: (callback) => {
    const listener = (_event, decision) => callback(decision);
    ipcRenderer.on('poke:decision', listener);
    return () => ipcRenderer.removeListener('poke:decision', listener);
  },
  listAudioProcesses: () => ipcRenderer.invoke('capture:processes'),
  startProcessAudio: (pid) => ipcRenderer.invoke('capture:start-process', pid),
  startGlobalAudio: () => ipcRenderer.invoke('capture:start-global'),
  stopProcessAudio: () => ipcRenderer.invoke('capture:stop-process'),
  onProcessAudio: (callback) => {
    const listener = (_event, packet) => callback(packet);
    ipcRenderer.on('capture:pcm', listener);
    return () => ipcRenderer.removeListener('capture:pcm', listener);
  },
  onProcessAudioEnded: (callback) => {
    const listener = (_event, packet) => callback(packet);
    ipcRenderer.on('capture:ended', listener);
    return () => ipcRenderer.removeListener('capture:ended', listener);
  },
  getDesktopSettings: () => ipcRenderer.invoke('desktop:settings:get'),
  getShortcutStatus: () => ipcRenderer.invoke('desktop:shortcut:status'),
  /** @param {import('./desktop-schema.cjs').DesktopSettings} settings */
  setDesktopSettings: (settings) => ipcRenderer.invoke('desktop:settings:set', settings),
  /** @param {import('./desktop-schema.cjs').VoiceOverlay} state */
  updateVoiceOverlay: (state) => ipcRenderer.invoke('desktop:overlay:update', state),
  getProfile: () => ipcRenderer.invoke('profile:get'),
  /** @param {import('./profile-store.cjs').Profile} profile */
  saveProfile: (profile) => ipcRenderer.invoke('profile:save', profile),
  choosePersonalSticker: input => ipcRenderer.invoke('stickers:choose',input),
  cancelPersonalStickerRequest: () => ipcRenderer.invoke('stickers:cancel-request'),
  /** @param {{name:string,data:string}} input */
  savePersonalSticker: (input) => ipcRenderer.invoke('stickers:save',input),
  /** @param {()=>void} callback @returns {()=>void} */
  onMuteShortcut: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('desktop:mute-shortcut', listener);
    return () => { ipcRenderer.removeListener('desktop:mute-shortcut', listener); };
  },
  getConfig: () => ipcRenderer.invoke('config:get'),
  connect: (url) => ipcRenderer.invoke('server:connect', url),
  /** @param {{address:string,port:number}} options */
  createDirect: (options) => ipcRenderer.invoke('direct:create', options),
  /** @param {string} invite */
  joinDirect: (invite) => ipcRenderer.invoke('direct:join', invite),
  enterDirect: () => ipcRenderer.invoke('direct:enter'),
  getDirectSession: () => ipcRenderer.invoke('direct:session'),
  /** @param {{appId:number,stunUrls:string[]}} options */
  createSteam: (options) => ipcRenderer.invoke('steam:create', options),
  /** @param {string} invite */
  joinSteam: (invite) => ipcRenderer.invoke('steam:join', invite),
  enterSteam: () => ipcRenderer.invoke('steam:enter'),
  getSteamSession: () => ipcRenderer.invoke('steam:session'),
  back: () => ipcRenderer.invoke('ui:bootstrap'),
  openExternal: (url) => ipcRenderer.invoke('shell:external', url),
  quit: () => ipcRenderer.invoke('app:quit'),
});
