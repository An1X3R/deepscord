// @ts-check

/** @typedef {{left:number,top:number,width:number,height:number}} ContentRect */

/** @param {HTMLVideoElement} video @returns {ContentRect|null} */
export function getVideoContentRect(video) {
  const box = video.getBoundingClientRect();
  if (video.videoWidth <= 0 || video.videoHeight <= 0 || box.width <= 0 || box.height <= 0) return null;
  const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

/** @param {{combo:number,fromUserId?:string,gesture?:'point'|'middle'}} hit @param {string} name @returns {HTMLDivElement} */
export function createPokeMarker(hit, name) {
  const marker = document.createElement('div');
  marker.className = 'poke-finger';
  marker.dataset.testid = 'poke-finger';
  marker.dataset.heat = hit.combo >= 8 ? '4' : hit.combo >= 5 ? '3' : hit.combo >= 3 ? '2' : '1';
  marker.dataset.gesture = hit.gesture === 'middle' ? 'middle' : 'point';
  marker.setAttribute('aria-hidden', 'true');
  const palette = ['#9de7ff', '#ffdb93', '#d1b5ff', '#a8edbb', '#ffb8d3', '#b8d4ff'];
  const identity = [...(hit.fromUserId ?? name)].reduce((hash, character) => ((hash * 31) + character.charCodeAt(0)) >>> 0, 0);
  marker.style.setProperty('--poke-identity', palette[identity % palette.length]);
  const ring = document.createElement('span'); ring.className = 'poke-ripple';
  const hand = document.createElement('span'); hand.className = 'poke-hand'; hand.textContent = hit.gesture === 'middle' ? '🖕' : '👆';
  const caption = document.createElement('span'); caption.className = 'poke-combo-badge';
  caption.textContent = `${name} · ×${hit.combo}${hit.gesture === 'middle' ? ' 急了!' : ''}`;
  const identityDot = document.createElement('span'); identityDot.className = 'poke-identity-dot'; caption.prepend(identityDot);
  marker.append(ring, hand, caption);
  return marker;
}
