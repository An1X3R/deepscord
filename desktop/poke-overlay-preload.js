// @ts-check
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pokeOverlay', {
  /** @param {(hit:import('./poke-overlay.cjs').PokeHit)=>void} callback @returns {void} */
  onHit(callback) { ipcRenderer.on('poke-overlay:hit', (_event, hit) => callback(hit)); },
  /** @param {()=>void} callback @returns {void} */
  onClear(callback) { ipcRenderer.on('poke-overlay:clear', () => callback()); },
});
