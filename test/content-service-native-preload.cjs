// @ts-check
'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('contentNative',{
  /** @param {'a'|'b'} actor @param {import('../public/js/network-protocol.js').JsonValue} input */
  activate:(actor,input)=>ipcRenderer.invoke('content-native:activate',actor,input),
});
