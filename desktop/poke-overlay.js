// @ts-check
'use strict';
/** @typedef {import('./poke-overlay.cjs').PokeHit} OverlayHit */
/** @type {Map<string,{element:HTMLDivElement,timer:ReturnType<typeof setTimeout>,color:string}>} */
const markers = new Map();
const pointers = document.getElementById('pointers');
if (!pointers) throw new Error('Poke overlay root is missing');
const surface = pointers;
/** @param {string} userId @param {string[]} occupied @returns {string} */
function identityColor(userId, occupied) {
  const palette = ['#87d8ce', '#f8cd79', '#aab9ff', '#e5a5e3', '#8de0a3', '#9cdafa'];
  let hash = 0;
  for (const character of userId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  for (let offset = 0; offset < palette.length; offset += 1) {
    const color = palette[(hash + offset) % palette.length];
    if (!occupied.includes(color)) return color;
  }
  throw new Error('Poke marker identity palette exhausted');
}
/** @param {string} id @returns {void} */
function removeMarker(id) {
  const marker = markers.get(id);
  if (marker) { clearTimeout(marker.timer); marker.element.remove(); markers.delete(id); }
}
/** @param {OverlayHit} hit @returns {void} */
function renderHit(hit) {
  const previousColor = markers.get(hit.fromUserId)?.color;
  removeMarker(hit.fromUserId);
  if (markers.size >= 3) { const oldest = markers.keys().next().value; if (oldest !== undefined) removeMarker(oldest); }
  const marker = document.createElement('div');
  marker.className = 'poke-marker';
  marker.dataset.fromUserId = hit.fromUserId;
  const color = previousColor || identityColor(hit.fromUserId, [...markers.values()].map((entry) => entry.color));
  marker.style.setProperty('--poke-identity', color);
  marker.dataset.heat = String(hit.combo >= 5 ? 3 : hit.combo >= 3 ? 2 : 1);
  marker.style.left = `${hit.nx * 100}%`; marker.style.top = `${hit.ny * 100}%`;
  const target = document.createElement('span'); target.className = 'poke-target'; marker.append(target);
  const finger = document.createElement('div'); finger.className = 'poke-finger';
  finger.textContent = '👆'; marker.append(finger);
  const badge = document.createElement('span'); badge.className = 'poke-badge'; badge.textContent = `${hit.pokerName} ×${hit.combo}`; marker.append(badge);
  surface.append(marker);
  markers.set(hit.fromUserId, { element: marker, color, timer: setTimeout(() => removeMarker(hit.fromUserId), 1600) });
}
const pokeBridge = /** @type {Window & {pokeOverlay?:{onHit:(callback:(hit:OverlayHit)=>void)=>void,onClear:(callback:()=>void)=>void}}} */ (window).pokeOverlay;
if (!pokeBridge) throw new Error('Poke overlay preload bridge is missing');
pokeBridge.onHit(renderHit);
pokeBridge.onClear(() => { for (const id of markers.keys()) removeMarker(id); });
