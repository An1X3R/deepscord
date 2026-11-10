// @ts-check
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pokeRequest', {
  /** @param {(state:import('./poke-request.cjs').RequestState)=>void} callback @returns {void} */
  onState(callback) { ipcRenderer.on('poke-request:state', (_event, state) => callback(state)); },
  /** @param {import('./poke-request.cjs').PokeDecision} value @returns {Promise<void>} */
  decide(value) { return ipcRenderer.invoke('poke-request:decision', value); },
});
