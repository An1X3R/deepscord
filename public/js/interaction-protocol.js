// @ts-check

/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {'bomb'|'poop'|'custom'} InteractionKind */
/** @typedef {{sessionId:string,channelId:string}} InteractionAdvertisement */
/** @typedef {{eventId:string,sessionId:string,channelId:string,targetUserId:string,targetSessionId:string,recipientSessionId:string,kind:InteractionKind,customId?:string,customRevision?:string,soundIndex:number,sequence:number}} InteractionMessage */
/** @typedef {{eventId:string,channelId:string,fromUserId:string,toUserId:string,kind:InteractionKind,customId?:string,customRevision?:string,soundIndex:number}} InteractionEvent */

/** @param {JsonValue|undefined} value @returns {{[key:string]:JsonValue}} */
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid interaction object');
  return value;
}
/** @param {JsonValue|undefined} value @returns {string} */
function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new TypeError('Invalid interaction identifier');
  return value;
}
/** @param {JsonValue|undefined} value @returns {InteractionAdvertisement|null} */
export function parseInteractionAdvertisement(value) {
  if (value === null) return null;
  const input = object(value);
  return { sessionId: id(input.sessionId), channelId: id(input.channelId) };
}
/** @param {JsonValue|undefined} value @returns {InteractionMessage} */
export function parseInteractionMessage(value) {
  const input = object(value);
  if (input.kind !== 'bomb' && input.kind !== 'poop' && input.kind !== 'custom') throw new TypeError('Unsupported interaction kind');
  const { kind, soundIndex, sequence } = input;
  /** @type {{customId?:string,customRevision?:string}} */ const custom = {};
  if (kind === 'custom') {
    custom.customId = id(input.customId);
    if (typeof input.customRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.customRevision)) throw new TypeError('Invalid custom interaction revision');
    custom.customRevision = input.customRevision;
  } else if (input.customId !== undefined || input.customRevision !== undefined) throw new TypeError('Built-in interaction cannot carry a custom definition');
  if (typeof soundIndex !== 'number' || !Number.isInteger(soundIndex) || soundIndex < 0 || soundIndex > (kind === 'bomb' ? 3 : 0)) throw new TypeError('Invalid interaction sound index');
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError('Invalid interaction sequence');
  return {
    eventId: id(input.eventId), sessionId: id(input.sessionId), channelId: id(input.channelId),
    targetUserId: id(input.targetUserId), targetSessionId: id(input.targetSessionId),
    recipientSessionId: id(input.recipientSessionId), kind, soundIndex, sequence, ...custom,
  };
}
