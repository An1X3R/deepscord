// @ts-check
import {parseTheme} from './customization-protocol.js';
/** @typedef {import('./customization-protocol.js').Theme} Theme */
const DEFAULT_THEME = /** @type {Theme} */ ({accent:'#87d8ce',background:'charcoal',density:'comfortable',corners:'square'});
const PALETTES = {
  charcoal:['#15191b','#1c2123','#101517','#252c2e','#30383a','#151b1d'],
  slate:['#202630','#29313d','#191e27','#323d4b','#3e4a59','#1c232c'],
  midnight:['#101526','#171e32','#0b1020','#202a40','#2b3750','#10172a'],
};
const TOKENS=['--bg','--bg-side','--bg-rail','--bg-elev','--bg-elev2','--bg-input'];
/** @param {Theme|null} value @returns {void} */
export function applyCustomizationTheme(value) {
  const theme=parseTheme(value ?? DEFAULT_THEME),root=document.documentElement;
  for(let index=0;index<TOKENS.length;index+=1)root.style.setProperty(TOKENS[index],PALETTES[theme.background][index]);
  const rgb=[1,3,5].map(offset=>parseInt(theme.accent.slice(offset,offset+2),16));
  const bright=rgb[0]*0.299+rgb[1]*0.587+rgb[2]*0.114;
  root.style.setProperty('--accent',theme.accent);
  root.style.setProperty('--accent-2',`rgb(${rgb.map(channel=>Math.round(channel+(255-channel)*0.3)).join(',')})`);
  root.style.setProperty('--accent-ink',bright>150?'#101517':'#ffffff');
  root.style.setProperty('--accent-soft',theme.accent+'18');
  root.style.setProperty('--accent-glow',theme.accent+'30');
  root.style.setProperty('--radius',theme.corners==='soft'?'12px':'4px');
  root.dataset.customDensity=theme.density; root.dataset.customCorners=theme.corners;
}
