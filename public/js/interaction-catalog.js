// @ts-check
/** @typedef {'bomb'|'poop'} InteractionKind */
/** @typedef {Readonly<{id:InteractionKind,name:string,thumbnail:string,durationMs:number}>} Interaction */

/** @type {ReadonlyArray<Interaction>} */
export const INTERACTIONS = Object.freeze([
  Object.freeze({ id: 'bomb', name: '炸弹', thumbnail: 'assets/interactions/bomb.svg', durationMs: 1000 }),
  Object.freeze({ id: 'poop', name: '便便', thumbnail: 'assets/interactions/poop.svg', durationMs: 650 }),
]);

/** @typedef {import('./customization-protocol.js').CustomInteraction} CustomInteraction */
/** @typedef {import('./chat-protocol.js').MediaMetadata} MediaMetadata */
/** @typedef {{url:string,release:()=>void}} ThumbnailLease */
/** @typedef {{model:'bomb'|'poop'|'thumbnail',trajectory:'arc'|'linear',durationMs:number,thumbnail:MediaMetadata|null,scene?:import('./interaction-scene.js').InteractionScene}} PlaybackDefinition */
/** @typedef {(id:string,revision:string)=>CustomInteraction|null} CustomResolver */
/** @typedef {(asset:MediaMetadata,signal:AbortSignal)=>Promise<ThumbnailLease>} ThumbnailLoader */

/** @param {import('./interaction-protocol.js').InteractionEvent} event @param {CustomResolver|undefined} resolveCustom @returns {PlaybackDefinition|null} */
export function playbackDefinition(event, resolveCustom) {
  if (event.kind === 'custom') return event.customId && event.customRevision ? resolveCustom?.(event.customId, event.customRevision) ?? null : null;
  const builtin = INTERACTIONS.find(item => item.id === event.kind);
  return builtin ? { model: builtin.id, trajectory: builtin.id === 'bomb' ? 'arc' : 'linear', durationMs: builtin.durationMs, thumbnail: null } : null;
}

/** @param {import('./network-protocol.js').JsonValue} value @returns {import('./network-protocol.js').JsonValue} */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

/** @param {CustomInteraction} definition @returns {Promise<string>} */
export async function interactionRevision(definition) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(definition))));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
