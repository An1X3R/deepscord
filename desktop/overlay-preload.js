// @ts-check
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
/** @typedef {{voice:import('./desktop-schema.cjs').VoiceOverlay,settings:import('./desktop-schema.cjs').OverlaySettings}} OverlayState */
contextBridge.exposeInMainWorld('voiceOverlay', {
  finishAdjustment: () => ipcRenderer.invoke('overlay:adjustment:finish'),
  /** @param {{width:number,height:number}} bounds */
  resize: (bounds) => ipcRenderer.invoke('overlay:adjustment:resize', bounds),
  /** @param {(state:import('./desktop-schema.cjs').VoiceOverlayDelta)=>void} callback @returns {()=>void} */
  onDelta(callback) {
    /** @param {Electron.IpcRendererEvent} _event @param {import('./desktop-schema.cjs').VoiceOverlayDelta} state */
    const listener = (_event,state) => callback(state);
    ipcRenderer.on('overlay:delta',listener);
    return () => ipcRenderer.removeListener('overlay:delta',listener);
  },
  /** @param {(state:OverlayState)=>void} callback @returns {()=>void} */
  onState(callback) {
    /** @param {Electron.IpcRendererEvent} _event @param {OverlayState} state @returns {void} */
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('overlay:state', listener);
    return () => { ipcRenderer.removeListener('overlay:state', listener); };
  },
});
