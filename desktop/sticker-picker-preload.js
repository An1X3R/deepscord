// @ts-check
'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('stickerPicker',{
  context:()=>ipcRenderer.invoke('stickers:context'),
  /** @param {number} requestId */
  present:requestId=>ipcRenderer.invoke('stickers:present',requestId),
  /** @param {()=>void} callback */
  onResume:callback=>{const listener=()=>callback();ipcRenderer.on('stickers:resume',listener);return ()=>ipcRenderer.removeListener('stickers:resume',listener);},
  /** @param {()=>void} callback */
  onSuspend:callback=>{const listener=()=>callback();ipcRenderer.on('stickers:suspend',listener);return ()=>ipcRenderer.removeListener('stickers:suspend',listener);},
  /** @param {'server'|'unicode'} tab */
  switchTab:tab=>ipcRenderer.invoke('stickers:switch-tab',tab),
  cancel:()=>ipcRenderer.invoke('stickers:cancel'),
  /** @param {string|null} id */
  confirm:id=>ipcRenderer.invoke('stickers:confirm',id),
  listPersonalStickers:()=>ipcRenderer.invoke('stickers:list'),
  /** @param {{name:string,data:string}} input */
  addPersonalSticker:input=>ipcRenderer.invoke('stickers:add',input),
  /** @param {string} id */
  removePersonalSticker:id=>ipcRenderer.invoke('stickers:remove',id),
  /** @param {string} id */
  pinPersonalSticker:id=>ipcRenderer.invoke('stickers:pin',id),
  /** @param {string} id */
  recordPersonalStickerUse:id=>ipcRenderer.invoke('stickers:use',id),
  /** @param {import('../public/js/sticker-panel.js').StickerPreferences} preferences */
  setStickerPreferences:preferences=>ipcRenderer.invoke('stickers:preferences',preferences),
  /** @param {string} hash */
  readPersonalSticker:hash=>ipcRenderer.invoke('stickers:read',hash)
});
