// @ts-check
import { MAX_SCREEN_BITRATE_BPS } from './screen-preferences.js';

/** @typedef {{id:string,availableBps:number,relay:boolean}} ScreenCapacity */
/** @typedef {{viewerId:string,parentId:string}} ScreenRoute */
/** @typedef {{bitrateBps:number,wireBps:number,routes:ScreenRoute[]}} ScreenPlan */

/** @param {number} uploadBps @param {number} audioPeers @returns {number} */
export function screenBudget(uploadBps, audioPeers) {
  if (!Number.isFinite(uploadBps) || uploadBps < 1000000 || !Number.isSafeInteger(audioPeers) || audioPeers < 0) throw new RangeError('Invalid screen upload budget');
  return Math.max(0, Math.floor(uploadBps * 0.85 - Math.max(256000, audioPeers * 256000)));
}

/** @param {string} sourceId @param {number} sourceBudgetBps @param {number} targetBps @param {ReadonlyArray<ScreenCapacity>} viewers @param {ReadonlyArray<ScreenRoute>} previous @returns {ScreenPlan} */
export function planScreenRoutes(sourceId, sourceBudgetBps, targetBps, viewers, previous) {
  if (!sourceId || !Number.isFinite(sourceBudgetBps) || sourceBudgetBps < 0 || targetBps < 300000 || targetBps > MAX_SCREEN_BITRATE_BPS || !Number.isFinite(targetBps)) throw new RangeError('Invalid screen planning limits');
  if (viewers.length > 100 || new Set(viewers.map((peer) => peer.id)).size !== viewers.length) throw new RangeError('Invalid screen viewer set');
  for (const peer of viewers) if (!peer.id || peer.id === sourceId || !Number.isFinite(peer.availableBps) || peer.availableBps < 0) throw new RangeError('Invalid screen viewer capacity');
  if (viewers.length === 0) return { bitrateBps: targetBps, wireBps: Math.ceil(targetBps * 1.2), routes: [] };
  const previousParents = new Set(previous.filter((route) => route.parentId !== sourceId).map((route) => route.parentId));
  const ordered = [...viewers].sort((a, b) => {
    const capacityA = a.relay ? a.availableBps : 0;
    const capacityB = b.relay ? b.availableBps : 0;
    return capacityB - capacityA || Number(previousParents.has(b.id)) - Number(previousParents.has(a.id)) || a.id.localeCompare(b.id);
  });
  for (let bitrate = Math.floor(targetBps); bitrate >= 300000; bitrate = bitrate === 300000 ? 0 : Math.max(300000, Math.floor(bitrate * 0.8))) {
    const wireBps = Math.ceil(bitrate * 1.2);
    const slots = Math.min(viewers.length, Math.floor(sourceBudgetBps / wireBps));
    if (!slots) continue;
    const parents = ordered.slice(0, slots);
    const capacity = parents.reduce((sum, peer) => sum + (peer.relay ? Math.min(3, Math.floor(peer.availableBps / wireBps)) : 0), 0);
    if (slots + capacity < viewers.length) continue;
    /** @type {ScreenRoute[]} */ const routes = parents.map((peer) => ({ viewerId: peer.id, parentId: sourceId }));
    const remaining = parents.map((peer) => ({ id: peer.id, slots: peer.relay ? Math.min(3, Math.floor(peer.availableBps / wireBps)) : 0 }));
    for (const viewer of ordered.slice(slots)) {
      const prior = previous.find((route) => route.viewerId === viewer.id)?.parentId;
      const parent = remaining.find((peer) => peer.id === prior && peer.slots > 0) || remaining.find((peer) => peer.slots > 0);
      if (!parent) throw new RangeError('Screen routing capacity accounting failed');
      parent.slots -= 1;
      routes.push({ viewerId: viewer.id, parentId: parent.id });
    }
    return { bitrateBps: bitrate, wireBps, routes: routes.sort((a, b) => a.viewerId.localeCompare(b.viewerId)) };
  }
  throw new RangeError('可用上传不足以容纳这些观看者；请提高上传上限、减少观看人数或使用自建 SFU');
}

/** @param {string} sourceId @param {ReadonlyArray<ScreenRoute>} routes @returns {void} */
export function validateOneHop(sourceId, routes) {
  if (new Set(routes.map((route) => route.viewerId)).size !== routes.length) throw new TypeError('Duplicate screen route');
  const direct = new Set(routes.filter((route) => route.parentId === sourceId).map((route) => route.viewerId));
  for (const route of routes) {
    if (route.viewerId === sourceId || route.viewerId === route.parentId || (route.parentId !== sourceId && !direct.has(route.parentId))) throw new TypeError('Screen route exceeds one intermediate user or contains a cycle');
  }
}
