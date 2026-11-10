// @ts-check
'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktopConsent',{
  read:()=>ipcRenderer.invoke('desktop-consent:read'),
  /** @param {'accept'|'deny'} decision */
  respond:decision=>ipcRenderer.invoke('desktop-consent:respond',decision),
});
