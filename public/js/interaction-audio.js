// @ts-check
import {createAudioIdleRelease} from './audio-idle.js';

/** @typedef {{enabled:boolean,volume:number}} InteractionAudioSettings */
/** @typedef {{volume:number,deafened:boolean,deviceId:string}} InteractionOutput */
/** @typedef {{kind:'bomb'|'poop'|'custom',customId?:string,customRevision?:string,soundIndex:number,fromUserId:string,toUserId:string}} InteractionAudioEvent */
/** @typedef {{getSettings:()=>InteractionAudioSettings,getOutput:()=>InteractionOutput,getPeerVolume:(id:string)=>number,reportError:(error:Error)=>void,resolveCustom?:import('./interaction-catalog.js').CustomResolver}} InteractionAudioOptions */
/** @typedef {AudioContext & {setSinkId?:(id:string)=>Promise<void>}} InteractionContext */
/** @typedef {{source:AudioBufferSourceNode,gain:GainNode,event:InteractionAudioEvent,selfId:string}} PlayingInteraction */
/** @typedef {{event:InteractionAudioEvent,selfId:string,cancelled:boolean}} PendingInteraction */

const ASSETS = ['bomb-1.mp3', 'bomb-2.mp3', 'bomb-3.mp3', 'bomb-4.mp3', 'poop.mp3'].map(name => new URL('../assets/interactions/' + name, import.meta.url).href);

/** @param {number} value @param {number} maximum @param {string} label @returns {number} */
function bounded(value, maximum, label) {
  if (!Number.isFinite(value) || value < 0 || value > maximum) throw new RangeError(`${label} must be between 0 and ${maximum}; received ${value}`);
  return value;
}

/** Local effects never connect to a capture or transmitted media destination.
 * @param {InteractionAudioOptions} options */
export function createInteractionAudio(options) {
  /** @type {InteractionContext|null} */ let context = null;
  /** @type {GainNode|null} */ let master = null;
  /** @type {Map<number,Promise<AudioBuffer>>} */ const buffers = new Map();
  /** @type {Set<PlayingInteraction>} */ const playing = new Set();
  /** @type {Set<PendingInteraction>} */ const pending = new Set();
  /** @type {number[]} */ let starts = [];
  let closed = false;
  let routedDevice = '';
  let routing = Promise.resolve();
  const idle=createAudioIdleRelease({delayMs:30000,isBusy:()=>closed||playing.size>0||pending.size>0,release:releaseContext,reportError:options.reportError});
  /** @returns {Promise<void>} */
  async function releaseContext(){
    const previous=context;context=null;master=null;buffers.clear();starts=[];routedDevice='';routing=Promise.resolve();
    if(previous)await previous.close();
  }


  /** @returns {InteractionAudioSettings} */
  function settings() {
    const value = options.getSettings();
    if (!value || typeof value.enabled !== 'boolean') throw new TypeError('Interaction settings require enabled:boolean');
    return { enabled: value.enabled, volume: bounded(value.volume, 100, 'Interaction volume') };
  }

  /** @returns {InteractionOutput} */
  function output() {
    const value = options.getOutput();
    if (!value || typeof value.deafened !== 'boolean' || typeof value.deviceId !== 'string') throw new TypeError('Interaction output requires deafened:boolean and deviceId:string');
    return { volume: bounded(value.volume, 200, 'Interaction output volume'), deafened: value.deafened, deviceId: value.deviceId };
  }

  /** @returns {boolean} */
  function audible() {
    const preference = settings();
    return !closed && preference.enabled && preference.volume > 0;
  }

  /** @param {InteractionAudioEvent} event @param {string} selfId @returns {number} */
  function gainValue(event, selfId) {
    const current = output(), preference = settings();
    if (event.toUserId === selfId) return preference.enabled ? preference.volume / 100 : 0;
    const peer = event.fromUserId === selfId ? 100 : bounded(options.getPeerVolume(event.fromUserId), 200, 'Interaction sender volume');
    return preference.enabled && !current.deafened ? preference.volume / 100 * current.volume / 100 * peer / 100 : 0;
  }

  /** @param {PlayingInteraction} entry @returns {void} */
  function stopEntry(entry) {
    playing.delete(entry);
    entry.source.onended = null;
    entry.source.stop();
    entry.source.disconnect();
    entry.gain.disconnect();
    idle.schedule();
  }

  /** @returns {void} */
  function stop() {
    for (const job of pending) job.cancelled = true;
    for (const entry of playing) stopEntry(entry);
    idle.schedule();
  }

  /** @param {string} id @returns {void} */
  function stopMember(id) {
    for (const job of pending) if (job.event.fromUserId === id || job.event.toUserId === id) job.cancelled = true;
    for (const entry of playing) if (entry.event.fromUserId === id || entry.event.toUserId === id) stopEntry(entry);
    idle.schedule();
  }

  /** @returns {InteractionContext} */
  function ensureContext() {
    if (context) return context;
    context = new AudioContext();
    const compressor = new DynamicsCompressorNode(context, { threshold: -12, knee: 0, ratio: 20, attack: 0.001, release: 0.1 });
    const curve = new Float32Array(4096);
    for (let index = 0; index < curve.length; index += 1) curve[index] = 0.9 * Math.tanh(2 * (index * 2 / (curve.length - 1) - 1));
    const limiter = new WaveShaperNode(context, { curve, oversample: '4x' });
    master = new GainNode(context, { gain: 0 });
    master.connect(compressor).connect(limiter).connect(context.destination);
    return context;
  }

  /** @returns {Promise<void>} */
  async function refresh() {
    if (closed) return;
    if (!audible()) { stop(); if (master) master.gain.value = 0; return; }
    for (const job of pending) if (gainValue(job.event, job.selfId) === 0) job.cancelled = true;
    const target = context, outputGain = master;
    if (!target || !outputGain) return;
    outputGain.gain.value = 0;
    for (const entry of playing) {
      const gain = gainValue(entry.event, entry.selfId);
      if (gain === 0) stopEntry(entry); else entry.gain.gain.value = gain;
    }
    const requested = output().deviceId, device = requested === 'default' ? '' : requested;
    const route = async () => {
      if (closed || target.state === 'closed') return;
      if (typeof target.setSinkId !== 'function') {
        if (device !== '') throw new DOMException(`Interaction audio cannot select output device ${requested}: AudioContext.setSinkId is unavailable`, 'NotSupportedError');
      } else if (routedDevice !== device) await target.setSinkId(device);
      if (closed) return;
      routedDevice = device;
      const current = output().deviceId;
      if ((current === 'default' ? '' : current) === device && audible()) outputGain.gain.value = 1;
    };
    const operation = routing.then(route, route);
    routing = operation;
    await operation;
  }

  /** @param {string} url @param {number} attempt @returns {Promise<Response>} */
  async function fetchAsset(url, attempt) {
    let response;
    try { response = await fetch(url); }
    catch (error) {
      if (!(error instanceof TypeError) || attempt >= 2) throw error;
      console.warn('Interaction audio asset request will retry', { url, attempt, error: error.message });
      return fetchAsset(url, attempt + 1);
    }
    if (!response.ok) {
      const error = new Error(`Interaction audio asset request failed: url=${url}; status=${response.status}; body=${(await response.text()).slice(0, 512)}`);
      if (response.status < 500 || attempt >= 2) throw error;
      console.warn('Interaction audio asset request will retry', { url, attempt, status: response.status, error: error.message });
      return fetchAsset(url, attempt + 1);
    }
    return response;
  }

  /** @param {InteractionContext} target @param {number} index @returns {Promise<AudioBuffer>} */
  async function loadBuffer(target, index) {
    const url = ASSETS[index];
    const response = await fetchAsset(url, 1);
    return target.decodeAudioData(await response.arrayBuffer());
  }

  /** @param {InteractionAudioEvent} event @param {string} selfId @returns {Promise<void>} */
  async function play(event, selfId) {
    if (!event || (event.kind !== 'bomb' && event.kind !== 'poop' && event.kind !== 'custom') || !Number.isSafeInteger(event.soundIndex) || event.soundIndex < 0 || event.soundIndex > (event.kind === 'bomb' ? 3 : 0) || typeof event.fromUserId !== 'string' || !event.fromUserId || typeof event.toUserId !== 'string' || !event.toUserId || typeof selfId !== 'string' || !selfId) throw new TypeError('Interaction audio requires kind, valid soundIndex, sender, target, and local identity');
    const custom = event.kind === 'custom' && event.customId && event.customRevision ? options.resolveCustom?.(event.customId, event.customRevision) : null;
    if (event.kind === 'custom' && (!custom || custom.sound === 'none')) return;
    const sound = custom?.sound;
    const index = sound === 'poop' ? 4 : sound && sound !== 'none' ? Number(sound.slice(-1)) - 1 : event.kind === 'bomb' ? event.soundIndex : 4;
    if ((event.fromUserId !== selfId && event.toUserId !== selfId) || !audible() || gainValue(event, selfId) === 0 || pending.size + playing.size >= 4) return;
    const receivedAt = performance.now();
    starts = starts.filter(time => receivedAt - time < 1000);
    if (starts.length >= 4) return;
    const job = { event: { ...event }, selfId, cancelled: false };
    idle.cancel();pending.add(job);
    try {
      const target = ensureContext();
      let decoded = buffers.get(index);
      if (!decoded) {
        decoded = loadBuffer(target, index).catch(error => { buffers.delete(index); throw error; });
        buffers.set(index, decoded);
      }
      const buffer = await decoded;
      if (job.cancelled || !audible()) return;
      await refresh();
      if (job.cancelled || !audible()) return;
      await target.resume();
      if (job.cancelled || !audible() || gainValue(event, selfId) === 0 || performance.now() - receivedAt > 1000) return;
      starts = starts.filter(time => performance.now() - time < 1000);
      if (starts.length >= 4) return;
      if (!master) throw new Error('Interaction audio graph is missing its output gain');
      const gain = new GainNode(target, { gain: gainValue(event, selfId) });
      const source = new AudioBufferSourceNode(target, { buffer });
      const entry = { source, gain, event: job.event, selfId };
      source.connect(gain).connect(master);
      source.onended = () => { source.onended=null;playing.delete(entry); source.disconnect(); gain.disconnect(); idle.schedule(); };
      playing.add(entry);
      starts.push(performance.now());
      source.start();
    } finally { pending.delete(job);idle.schedule(); }
  }

  /** @returns {Promise<void>} */
  async function close() {
    if (closed) return;
    closed = true;
    stop();
    idle.cancel();await releaseContext();
  }
  return { play, refresh, stop, stopMember, close };
}
