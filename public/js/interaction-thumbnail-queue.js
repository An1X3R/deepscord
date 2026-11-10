// @ts-check
/** @typedef {import('./interaction-catalog.js').ThumbnailLoader} ThumbnailLoader */
/** @typedef {import('./interaction-catalog.js').ThumbnailLease} ThumbnailLease */
/** @typedef {import('./interaction-catalog.js').MediaMetadata} MediaMetadata */
/** @typedef {{asset:MediaMetadata,signal:AbortSignal,resolve:(lease:ThumbnailLease)=>void,reject:(error:Error)=>void,abort:()=>void}} Job */

/** @param {ThumbnailLoader} loader @returns {{load:ThumbnailLoader}} */
export function createInteractionThumbnailQueue(loader) {
  /** @type {Job[]} */ const waiting = [];
  let active = 0;

  /** @param {Job} job @returns {Promise<void>} */
  async function execute(job) {
    active += 1;
    try {
      const lease = await loader(job.asset, job.signal);
      if (job.signal.aborted) { lease.release(); job.reject(new DOMException('Interaction thumbnail request was cancelled', 'AbortError')); }
      else job.resolve(lease);
    } catch (error) {
      job.reject(error instanceof Error ? error : new TypeError('Interaction thumbnail loader rejected without an Error', { cause: error }));
    } finally {
      job.signal.removeEventListener('abort', job.abort);
      active -= 1; pump();
    }
  }
  /** @returns {void} */
  function pump() {
    while (active < 2 && waiting.length) {
      const job = waiting.shift();
      if (job) void execute(job);
    }
  }
  /** @param {MediaMetadata} asset @param {AbortSignal} signal @returns {Promise<ThumbnailLease>} */
  function load(asset, signal) {
    if (signal.aborted) return Promise.reject(new DOMException('Interaction thumbnail request was cancelled', 'AbortError'));
    if (active >= 2 && waiting.length >= 96) return Promise.reject(new RangeError('Interaction thumbnail waiting queue exceeds 96 requests'));
    return new Promise((resolve, reject) => {
      /** @type {Job} */ const job = { asset, signal, resolve, reject, abort: () => {
        const index = waiting.indexOf(job);
        if (index >= 0) waiting.splice(index, 1);
        reject(new DOMException('Interaction thumbnail request was cancelled', 'AbortError'));
      } };
      signal.addEventListener('abort', job.abort, { once: true });
      waiting.push(job); pump();
    });
  }
  return { load };
}
