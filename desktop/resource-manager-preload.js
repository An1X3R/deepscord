// @ts-check
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/** @type {import('./resource-manager.js').ResourceManagerBridge} */
const resourceManager = {
  getState: () => ipcRenderer.invoke('resource-manager:state'),
  installArchive: () => ipcRenderer.invoke('resource-manager:install-archive'),
  installDirectory: () => ipcRenderer.invoke('resource-manager:install-directory'),
  removePack: id => ipcRenderer.invoke('resource-manager:remove', id),
  bindServer: id => ipcRenderer.invoke('resource-manager:bind-server', id),
  openRoot: () => ipcRenderer.invoke('resource-manager:open-root'),
  openPack: id => ipcRenderer.invoke('resource-manager:open-pack', id),
};
contextBridge.exposeInMainWorld('resourceManager', resourceManager);
