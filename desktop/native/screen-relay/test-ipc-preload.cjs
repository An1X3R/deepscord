// @ts-check
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
/** @typedef {import('../../screen-relay-ipc.cjs').Offer} Offer */
contextBridge.exposeInMainWorld('relayProbe', {
  /** @param {string|null} roomKey */
  screenRelayRoom: roomKey => ipcRenderer.invoke('screen-relay:room', { roomKey }),
  /** @param {Offer} offer */
  screenRelayOffer: offer => ipcRenderer.invoke('screen-relay:offer', offer),
  /** @param {import('../../screen-relay-ipc.cjs').IceRequest} request */
  screenRelayIce: request => ipcRenderer.invoke('screen-relay:ice', request),
  /** @param {{id:string,negotiationId:string,after:number}} request */
  screenRelayCandidates: request => ipcRenderer.invoke('screen-relay:candidates', request),
  /** @param {string} id */
  screenRelayRemove: id => ipcRenderer.invoke('screen-relay:remove', id),
  screenRelayStats: () => ipcRenderer.invoke('screen-relay:stats'),
  /** @param {number} sourceBudgetBps */
  screenRelayBudget: sourceBudgetBps => ipcRenderer.invoke('screen-relay:budget', { sourceBudgetBps }),
});
