// @ts-check
import { parseCustomInteraction } from './customization-protocol.js';
import { interactionRevision } from './interaction-catalog.js';
import { parseInteractionAdvertisement } from './interaction-protocol.js';

/** @typedef {import('./interaction-protocol.js').InteractionAdvertisement} Advertisement */
/** @typedef {import('./interaction-protocol.js').InteractionMessage} Message */
/** @typedef {import('./interaction-protocol.js').InteractionEvent} InteractionEvent */
/** @typedef {{getSelfId:()=>string,getPeerIds:()=>string[],send:(id:string,data:Message)=>boolean,onEvent:(event:InteractionEvent)=>void,onState:()=>void,onClear:(memberId:string|null)=>void}} InteractionOptions */

/** A transient session connector; no interaction history is retained. @param {InteractionOptions} options */
export function createInteractions(options) {
  /** @type {Advertisement|null} */ let local = null;
  /** @type {Map<string,Advertisement>} */ const peers = new Map();
  /** @type {Map<string,number>} */ const received = new Map();
  let sequence = 0;
  let catalogGeneration = 0;
  /** @type {Map<string,{definition:import('./customization-protocol.js').CustomInteraction,revision:string}>} */ let catalog = new Map();

  /** @param {import('./customization-protocol.js').CustomInteraction[]} entries @returns {Promise<void>} */
  async function setCatalog(entries) {
    const generation = ++catalogGeneration;
    catalog = new Map(); options.onClear(null); options.onState();
    if (entries.length > 48) throw new RangeError('Custom interaction catalog exceeds 48 items');
    const definitions = entries.map(parseCustomInteraction);
    /** @type {Map<string,{definition:import('./customization-protocol.js').CustomInteraction,revision:string}>} */ const next = new Map();
    for (const definition of definitions) {
      if (next.has(definition.id)) throw new TypeError('Duplicate or reserved custom interaction identifier');
      next.set(definition.id, { definition, revision: await interactionRevision(definition) });
    }
    if (generation !== catalogGeneration) return;
    catalog = next; options.onState();
  }
  /** @returns {import('./customization-protocol.js').CustomInteraction[]} */
  function getCatalog() { return Array.from(catalog.values(), item => structuredClone(item.definition)); }
  /** @param {string} id @param {string} revision @returns {import('./customization-protocol.js').CustomInteraction|null} */
  function resolveCustom(id, revision) {
    const entry = catalog.get(id);
    return entry?.revision === revision ? structuredClone(entry.definition) : null;
  }

  /** @param {string} peerId @returns {void} */
  function remove(peerId) {
    peers.delete(peerId); received.delete(peerId);
    options.onClear(peerId); options.onState();
  }
  /** @returns {void} */
  function leave() {
    local = null; sequence = 0; peers.clear(); received.clear();
    options.onClear(null); options.onState();
  }
  /** @param {string} channelId @returns {void} */
  function join(channelId) {
    if (local?.channelId === channelId) return;
    const next = parseInteractionAdvertisement({ sessionId: crypto.randomUUID(), channelId });
    leave(); local = next; options.onState();
  }
  /** @param {string} peerId @param {Advertisement|null} advertisement @returns {void} */
  function advertise(peerId, advertisement) {
    if (!local || peerId === options.getSelfId() || !options.getPeerIds().includes(peerId)) return;
    const next = parseInteractionAdvertisement(advertisement);
    if (!next || next.channelId !== local.channelId) { remove(peerId); return; }
    const previous = peers.get(peerId);
    if (previous?.sessionId === next.sessionId && previous.channelId === next.channelId) return;
    if (peers.size >= 256 && !previous) throw new RangeError('Interaction member limit exceeded');
    remove(peerId); peers.set(peerId, next); options.onState();
  }
  /** @param {string} targetId @returns {boolean} */
  function canThrow(targetId) {
    return !!local && targetId !== options.getSelfId() && peers.get(targetId)?.channelId === local.channelId && options.getPeerIds().includes(targetId);
  }
  /** @param {string} targetId @param {string} kind @returns {void} */
  function throwAt(targetId, kind) {
    const target = peers.get(targetId);
    if (!local || !target || !canThrow(targetId)) throw new DOMException('对方不在当前语音频道或互动连接尚未就绪', 'InvalidStateError');
    const custom = catalog.get(kind);
    if (kind !== 'bomb' && kind !== 'poop' && !custom) throw new TypeError('Unsupported interaction kind');
    /** @type {Pick<Message,'kind'|'customId'|'customRevision'>} */
    const selection = custom ? { kind: 'custom', customId: kind, customRevision: custom.revision } : { kind: /** @type {'bomb'|'poop'} */ (kind) };
    if (sequence === Number.MAX_SAFE_INTEGER) throw new RangeError('Interaction sequence exhausted; rejoin the voice channel');
    const soundIndex = kind === 'bomb' ? crypto.getRandomValues(new Uint8Array(1))[0] % 4 : 0;
    const eventId = crypto.randomUUID();
    const message = { eventId, ...local, targetUserId: targetId, targetSessionId: target.sessionId, ...selection, soundIndex, sequence: ++sequence };
    if (!options.send(targetId, { ...message, recipientSessionId: target.sessionId })) throw new DOMException('互动连接忙碌或已断开，请稍后重试', 'NetworkError');
    for (const id of options.getPeerIds()) {
      const peer = peers.get(id);
      if (id === targetId || !peer || peer.channelId !== local.channelId) continue;
      if (!options.send(id, { ...message, recipientSessionId: peer.sessionId })) console.warn('Interaction observer skipped', { peerId: id, eventId, reason: 'transport-unavailable' });
    }
    options.onEvent({ eventId, channelId: local.channelId, fromUserId: options.getSelfId(), toUserId: targetId, ...selection, soundIndex });
  }
  /** @param {string} fromId @param {Message} message @returns {void} */
  function receive(fromId, message) {
    const from = peers.get(fromId);
    const target = message.targetUserId === options.getSelfId() ? local : peers.get(message.targetUserId);
    if (!local || !from || !target || !options.getPeerIds().includes(fromId)) return;
    if (from.channelId !== local.channelId || target.channelId !== local.channelId || message.channelId !== local.channelId) return;
    if (message.sessionId !== from.sessionId || message.targetSessionId !== target.sessionId || message.recipientSessionId !== local.sessionId || message.targetUserId === fromId) return;
    if (message.sequence <= (received.get(fromId) ?? 0)) return;
    if (message.kind === 'custom' && (!message.customId || !message.customRevision || !resolveCustom(message.customId, message.customRevision))) return;
    received.set(fromId, message.sequence);
    options.onEvent({ eventId: message.eventId, channelId: message.channelId, fromUserId: fromId, toUserId: message.targetUserId, kind: message.kind, ...(message.kind === 'custom' ? { customId: message.customId, customRevision: message.customRevision } : {}), soundIndex: message.soundIndex });
  }
  return { setCatalog, getCatalog, resolveCustom, join, leave, advertise, remove, canThrow, throwAt, receive, advertisement: () => local ? { ...local } : null };
}
