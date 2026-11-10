// @ts-check
import { scenePose } from './interaction-scene.js';
import { drawSceneActor } from './interaction-scene-drawing.js';
import { playbackDefinition } from './interaction-catalog.js';

/** @typedef {import('./interaction-protocol.js').InteractionEvent} InteractionEvent */
/** @typedef {{x:number,y:number,z:number}} Vector */
/** @typedef {{vertices:readonly Vector[],faces:readonly (readonly [number,number,number])[]}} Mesh */
/** @typedef {{getAvatar:(id:string)=>HTMLElement|null,onImpact:(event:InteractionEvent)=>void,resolveCustom?:import('./interaction-catalog.js').CustomResolver,loadThumbnail?:import('./interaction-catalog.js').ThumbnailLoader,reportError?:(error:Error)=>void}} RendererOptions */
/** @typedef {{event:InteractionEvent,started:number,duration:number,definition:import('./interaction-catalog.js').PlaybackDefinition,image:HTMLImageElement|null,controller:AbortController,lease:import('./interaction-catalog.js').ThumbnailLease|null}} Flight */

/** @returns {Mesh} */
function createSphere() {
  /** @type {Vector[]} */ const vertices = [];
  /** @type {[number,number,number][]} */ const faces = [];
  for (let row = 0; row <= 8; row += 1) {
    const latitude = Math.PI * row / 8;
    for (let column = 0; column < 12; column += 1) {
      const longitude = Math.PI * column / 6;
      vertices.push({ x: Math.sin(latitude) * Math.cos(longitude), y: Math.cos(latitude), z: Math.sin(latitude) * Math.sin(longitude) });
    }
  }
  for (let row = 0; row < 8; row += 1) for (let column = 0; column < 12; column += 1) {
    const a = row * 12 + column, b = row * 12 + (column + 1) % 12, c = a + 12, d = b + 12;
    if (row > 0) faces.push([a, c, b]);
    if (row < 7) faces.push([b, c, d]);
  }
  return { vertices, faces };
}
const SPHERE = createSphere();

/** @param {Vector} point @param {number} angle @returns {Vector} */
function rotate(point, angle) {
  const x = point.x * Math.cos(angle) - point.z * Math.sin(angle);
  const z = point.x * Math.sin(angle) + point.z * Math.cos(angle);
  const tilt = angle * 0.7;
  return { x: x * Math.cos(tilt) - point.y * Math.sin(tilt), y: x * Math.sin(tilt) + point.y * Math.cos(tilt), z };
}
/** @param {Vector} point @param {number} radius @returns {{x:number,y:number}} */
function project(point, radius) {
  const perspective = 4 / (4 - point.z);
  return { x: point.x * radius * perspective, y: -point.y * radius * perspective };
}
/** @param {CanvasRenderingContext2D} context @param {number} radius @param {number} angle @returns {void} */
function drawBomb(context, radius, angle) {
  const vertices = SPHERE.vertices.map(point => rotate(point, angle));
  const faces = SPHERE.faces.map(indices => ({ indices, depth: indices.reduce((sum, index) => sum + vertices[index].z, 0) / 3 })).sort((a, b) => a.depth - b.depth);
  for (const face of faces) {
    const points = face.indices.map(index => vertices[index]);
    const normal = { x: points.reduce((sum, point) => sum + point.x, 0) / 3, y: points.reduce((sum, point) => sum + point.y, 0) / 3, z: face.depth };
    const shade = Math.round(24 + 48 * Math.max(0, -normal.x * 0.35 + normal.y * 0.6 + normal.z * 0.7));
    const screen = points.map(point => project(point, radius));
    context.fillStyle = `rgb(${shade},${shade + 5},${shade + 9})`;
    context.beginPath(); context.moveTo(screen[0].x, screen[0].y);
    context.lineTo(screen[1].x, screen[1].y); context.lineTo(screen[2].x, screen[2].y); context.closePath(); context.fill();
  }
  const cap = project(rotate({ x: 0, y: 0.94, z: 0 }, angle), radius);
  const fuse = project(rotate({ x: 0.12, y: 1.45, z: 0 }, angle), radius);
  context.strokeStyle = '#c7a06b'; context.lineWidth = Math.max(2, radius * 0.11); context.lineCap = 'round';
  context.beginPath(); context.moveTo(cap.x, cap.y); context.lineTo(fuse.x, fuse.y); context.stroke();
  context.fillStyle = '#ffe5a6'; context.beginPath(); context.arc(fuse.x, fuse.y, 3, 0, Math.PI * 2); context.fill();
}

/** One bounded drawing surface; no window overlays or continuous idle work. @param {RendererOptions} options */
export function createInteractionRenderer(options) {
  /** @type {Map<string,Flight>} */ const flights = new Map();
  /** @type {Map<string,{event:InteractionEvent,timer:ReturnType<typeof setTimeout>,audible:boolean}>} */ const impacts = new Map();
  /** @type {HTMLCanvasElement|null} */ let canvas = null;
  /** @type {CanvasRenderingContext2D|null} */ let context = null;
  let frame = 0;
  let destroyed = false;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  /** @returns {void} */
  function hide() {
    for (const flight of flights.values()) releaseFlight(flight); flights.clear(); cancelAnimationFrame(frame); frame = 0;
    if (canvas) { canvas.width = 1; canvas.height = 1; canvas.remove(); }
    canvas = null; context = null;
  }
  /** @param {string} id @returns {DOMRect|null} */
  function avatar(id) {
    const element = options.getAvatar(id);
    if (!element || !element.isConnected) return null;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth ? rect : null;
  }
  /** @returns {void} */
  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.className = 'interaction-animation'; canvas.dataset.testid = 'interaction-animation';
    canvas.setAttribute('aria-hidden', 'true');
    context = canvas.getContext('2d', { alpha: true });
    if (!context) throw new Error('互动动画无法创建绘制画布');
    document.body.append(canvas);
  }
  /** @param {number} now @returns {void} */
  function draw(now) {
    frame = 0;
    if (!canvas || !context || document.hidden) { hide(); return; }
    const scale = Math.min(devicePixelRatio, 1.5);
    const width = Math.ceil(innerWidth * scale), height = Math.ceil(innerHeight * scale);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    context.setTransform(scale, 0, 0, scale, 0, 0); context.clearRect(0, 0, innerWidth, innerHeight);
    for (const [id, flight] of flights) {
      const elapsed = now - flight.started, progress = Math.min(1, elapsed / flight.duration);
      const from = avatar(flight.event.fromUserId), to = avatar(flight.event.toUserId);
      if (!from || !to || elapsed > flight.duration + 320) { releaseFlight(flight); flights.delete(id); continue; }
      const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
      const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
      const radius = Math.max(13, Math.min(23, from.width * 0.28, to.width * 0.28));
      if (flight.definition.scene) {
        const phase = reducedMotion.matches ? 1 : progress;
        const actors = flight.definition.scene.actors.map(actor => ({actor,pose:scenePose(actor,phase,start,end)})).sort((a,b)=>a.pose.z-b.pose.z);
        for (const {actor,pose} of actors) drawSceneActor(context,actor.model,pose,radius,flight.image,drawBomb);
        continue;
      }
      const bomb = flight.definition.model === 'bomb';
      const arcHeight = Math.max(0, Math.min(140, Math.max(45, Math.abs(end.x - start.x) * 0.25), Math.min(start.y, end.y) - radius * 1.6 - 8));
      const arc = flight.definition.trajectory === 'arc' ? arcHeight * 4 * progress * (1 - progress) : 0;
      const x = reducedMotion.matches ? end.x : start.x + (end.x - start.x) * progress;
      const y = reducedMotion.matches ? end.y : start.y + (end.y - start.y) * progress - arc;
      context.save(); context.translate(x, y);
      if (elapsed < flight.duration) {
        context.globalAlpha = reducedMotion.matches ? 0.6 : 1;
        if (flight.definition.model === 'thumbnail') { if (flight.image?.complete && flight.image.naturalWidth > 0) context.drawImage(flight.image, -radius, -radius, radius * 2, radius * 2); }
        else if (bomb) drawBomb(context, radius, reducedMotion.matches ? 0.4 : progress * Math.PI * 3.2);
        else { context.font = `${radius * 2}px "Segoe UI Emoji", sans-serif`; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText('💩', 0, 0); }
      } else {
        const impact = (elapsed - flight.duration) / 320;
        context.globalAlpha = 1 - impact;
        context.strokeStyle = bomb ? '#f5cd88' : '#9de1cd'; context.lineWidth = 3 * (1 - impact);
        context.beginPath(); context.arc(0, 0, radius * (1 + impact), 0, Math.PI * 2); context.stroke();
        if (bomb && !reducedMotion.matches) for (let index = 0; index < 8; index += 1) {
          const angle = index * Math.PI / 4;
          context.fillStyle = index % 2 ? '#ed9557' : '#f5cd88';
          context.fillRect(Math.cos(angle) * radius * (1 + impact * 1.6) - 2, Math.sin(angle) * radius * (1 + impact * 1.6) - 2, 4, 4);
        }
      }
      context.restore();
    }
    if (flights.size) frame = requestAnimationFrame(draw); else hide();
  }
  /** @param {Flight} flight @returns {void} */
  function releaseFlight(flight) { flight.controller.abort(); flight.lease?.release(); flight.lease = null; flight.image = null; }
  /** @param {string} id @returns {void} */
  function discard(id) {
    const pending = impacts.get(id); if (pending) clearTimeout(pending.timer);
    impacts.delete(id); const flight = flights.get(id); if (flight) releaseFlight(flight); flights.delete(id);
  }
  /** @param {InteractionEvent} event @returns {void} */
  function play(event) {
    if (destroyed || impacts.has(event.eventId) || flights.has(event.eventId)) return;
    const definition = playbackDefinition(event, options.resolveCustom);
    if (!definition) return;
    while (impacts.size >= 8) { const first = impacts.keys().next().value; if (first) discard(first); }
    while (flights.size >= 8) { const first = flights.keys().next().value; if (first) discard(first); }
    const deadline = performance.now() + definition.durationMs;
    const timer = setTimeout(() => {
      const pending = impacts.get(event.eventId); impacts.delete(event.eventId);
      if (pending?.audible && performance.now() - deadline <= 500) options.onImpact(event);
    }, definition.durationMs);
    impacts.set(event.eventId, { event, timer, audible: true });
    if (document.hidden || !avatar(event.fromUserId) || !avatar(event.toUserId)) return;
    ensureCanvas();
    /** @type {Flight} */ const flight = { event, started: performance.now(), duration: definition.durationMs, definition, image: null, controller: new AbortController(), lease: null };
    flights.set(event.eventId, flight);
    if (definition.scene ? definition.scene.actors.some(actor => actor.model === 'thumbnail') : definition.model === 'thumbnail') {
      if (!definition.thumbnail || !options.loadThumbnail) { discard(event.eventId); throw new TypeError('Custom thumbnail interaction requires a thumbnail loader and asset'); }
      options.loadThumbnail(definition.thumbnail, flight.controller.signal).then(lease => {
        if (flight.controller.signal.aborted) { lease.release(); return; }
        flight.lease = lease; const image = new Image(); flight.image = image; image.src = lease.url;
        image.addEventListener('error', () => { discard(event.eventId); const error = new Error('Custom interaction thumbnail decoding failed'); if (options.reportError) options.reportError(error); else console.error(error); }, { once: true, signal: flight.controller.signal });
      }).catch(error => {
        if (flight.controller.signal.aborted) return;
        discard(event.eventId); if (!(error instanceof Error)) throw error;
        if (options.reportError) options.reportError(error); else console.error(error);
      });
    }
    if (!frame) frame = requestAnimationFrame(draw);
  }
  /** @param {string} id @returns {void} */
  function clearMember(id) {
    for (const [key, entry] of impacts) if (entry.event.fromUserId === id || entry.event.toUserId === id) discard(key);
    for (const [key, entry] of flights) if (entry.event.fromUserId === id || entry.event.toUserId === id) discard(key);
    if (!flights.size) hide();
  }
  /** @returns {void} */
  function clear() { for (const id of impacts.keys()) discard(id); hide(); }
  /** @returns {void} */
  function silence() { for (const pending of impacts.values()) pending.audible = false; }
  /** @param {string} selfId @returns {void} */
  function silenceSender(selfId) { for (const pending of impacts.values()) if (pending.event.fromUserId === selfId && pending.event.toUserId !== selfId) pending.audible = false; }
  /** @returns {void} */
  function visibility() { if (document.hidden) hide(); }
  document.addEventListener('visibilitychange', visibility);
  /** @returns {void} */
  function destroy() { destroyed = true; clear(); document.removeEventListener('visibilitychange', visibility); }
  return { play, hide, clear, clearMember, silence, silenceSender, destroy };
}
