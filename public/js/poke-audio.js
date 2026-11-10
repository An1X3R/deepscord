// @ts-check
import {createAudioIdleRelease} from './audio-idle.js';

/** @typedef {{enabled:boolean,volume:number}} PokeAudioSettings */
/** @typedef {{volume:number,deafened:boolean,deviceId:string}} PokeOutput */
/** @typedef {{fromUserId:string,combo:number,boom:boolean}} PokeAudioHit */
/** @typedef {{getOutput:()=>PokeOutput,getPeerVolume:(id:string)=>number,reportError:(error:Error)=>void}} PokeAudioOptions */
/** @typedef {AudioContext & {setSinkId?:(id:string)=>Promise<void>}} PokeContext */
/** @typedef {{source:AudioBufferSourceNode,gain:GainNode,userId:string}} PlayingPoke */

const STORAGE_KEY = 'deepscord.poke-audio.v1';
const ASSET_URL = new URL('../assets/vine-boom.wav', import.meta.url).href;

/** @param {number} value @param {number} maximum @param {string} name @returns {number} */
function bounded(value, maximum, name) {
  if (!Number.isFinite(value) || value < 0 || value > maximum) throw new RangeError(`${name} must be between 0 and ${maximum}; received ${value}`);
  return value;
}

/** @param {PokeAudioSettings} value @returns {PokeAudioSettings} */
function validateSettings(value) {
  if (value === null || typeof value !== 'object' || typeof value.enabled !== 'boolean' || typeof value.volume !== 'number') throw new TypeError('Screen Poke audio settings require enabled:boolean and volume:number');
  return { enabled: value.enabled, volume: bounded(value.volume, 100, 'Screen Poke receiver volume') };
}

/** Local playback only. This graph has no capture or transmitted media destination.
 * @param {PokeAudioOptions} options */
export function createPokeAudio(options) {
  const stored = localStorage.getItem(STORAGE_KEY);
  let settings = stored === null ? { enabled: true, volume: 20 } : validateSettings(JSON.parse(stored));
  /** @type {PokeContext|null} */ let context = null;
  /** @type {GainNode|null} */ let master = null;
  /** @type {Promise<AudioBuffer>|null} */ let decoded = null;
  /** @type {Set<PlayingPoke>} */ const playing = new Set();
  /** @type {number[]} */ let starts = [];
  let generation = 0;
  let closed = false;
  let pendingPlays=0;
  let routedDevice = '';
  let routing = Promise.resolve();
  const idle=createAudioIdleRelease({delayMs:30000,isBusy:()=>closed||playing.size>0||pendingPlays>0,release:releaseContext,reportError:options.reportError});
  /** @returns {Promise<void>} */
  async function releaseContext(){
    const previous=context;context=null;master=null;decoded=null;starts=[];routedDevice='';routing=Promise.resolve();
    if(previous)await previous.close();
  }


  /** @returns {PokeOutput} */
  function output() {
    const value = options.getOutput();
    bounded(value.volume, 200, 'Screen Poke output volume');
    if (typeof value.deafened !== 'boolean' || typeof value.deviceId !== 'string') throw new TypeError('Screen Poke output requires deafened:boolean and deviceId:string');
    return value;
  }

  /** @returns {void} */
  function stop() {
    generation += 1;
    for (const entry of playing) {
      entry.source.onended=null;entry.source.stop();
      entry.source.disconnect();
      entry.gain.disconnect();
    }
    playing.clear();idle.schedule();
  }

  /** @returns {boolean} */
  function audible() {
    const current = output();
    return !closed && settings.enabled && settings.volume > 0 && !current.deafened && current.volume > 0;
  }

  /** @param {string} userId @returns {number} */
  function gainValue(userId) {
    const current = output();
    const peer = bounded(options.getPeerVolume(userId), 200, 'Screen Poke sender volume');
    return settings.enabled && !current.deafened ? settings.volume / 100 * current.volume / 100 * peer / 100 : 0;
  }

  /** @returns {PokeContext} */
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
    if (!audible()) {
      stop();
      if (master) master.gain.value = 0;
      return;
    }
    const currentContext = context;
    const currentMaster = master;
    if (!currentContext || !currentMaster) return;
    currentMaster.gain.value = 0;
    for (const entry of playing) entry.gain.gain.value = gainValue(entry.userId);
    const requested = output().deviceId;
    const device = requested === 'default' ? '' : requested;
    const route = async () => {
      if (closed || currentContext.state === 'closed') return;
      if (typeof currentContext.setSinkId !== 'function') {
        if (device !== '') throw new DOMException(`Screen Poke cannot select output device ${requested}: AudioContext.setSinkId is unavailable`, 'NotSupportedError');
      } else if (routedDevice !== device) {
        await currentContext.setSinkId(device);
      }
      if (closed) return;
      routedDevice = device;
      if ((output().deviceId === 'default' ? '' : output().deviceId) === device && audible()) currentMaster.gain.value = 1;
    };
    const pending = routing.then(route, route);
    routing = pending;
    await pending;
  }

  /** @param {number} attempt @returns {Promise<Response>} */
  async function fetchAsset(attempt) {
    let response;
    try { response = await fetch(ASSET_URL); }
    catch (error) {
      if (!(error instanceof TypeError) || attempt >= 2) throw error;
      console.warn('Screen Poke audio asset request will retry', { url: ASSET_URL, attempt, error: error.message });
      return fetchAsset(attempt + 1);
    }
    if (!response.ok) {
      const error = new Error(`Screen Poke audio asset request failed: url=${ASSET_URL}; status=${response.status}; body=${(await response.text()).slice(0, 512)}`);
      if (response.status < 500 || attempt >= 2) throw error;
      console.warn('Screen Poke audio asset request will retry', { url: ASSET_URL, attempt, status: response.status, error: error.message });
      return fetchAsset(attempt + 1);
    }
    return response;
  }

  /** @param {PokeContext} target @returns {Promise<AudioBuffer>} */
  async function loadBuffer(target) {
    const response = await fetchAsset(1);
    return target.decodeAudioData(await response.arrayBuffer());
  }

  /** @param {PokeAudioHit} hit @returns {Promise<void>} */
  async function play(hit) {
    if (typeof hit.fromUserId !== 'string' || hit.fromUserId.length === 0 || !Number.isSafeInteger(hit.combo) || hit.combo < 1 || typeof hit.boom !== 'boolean') throw new TypeError('Screen Poke audio hit requires a sender, a positive integer combo, and boom:boolean');
    if (!hit.boom || !audible() || gainValue(hit.fromUserId) === 0) return;
    idle.cancel();pendingPlays+=1;
    try {
    const receivedAt = performance.now();
    const token = generation;
    const target = ensureContext();
    if (!decoded) decoded = loadBuffer(target).catch(error => { decoded = null; throw error; });
    const buffer = await decoded;
    if (token !== generation || !audible()) return;
    await refresh();
    if (token !== generation || !audible()) return;
    await target.resume();
    if (token !== generation || !audible()) return;
    const now = performance.now();
    if (now - receivedAt > 1000) return;
    starts = starts.filter(time => now - time < 1000);
    if (starts.length >= 4 || playing.size >= 3) return;
    if (!master) throw new Error('Screen Poke audio graph is missing its output gain');
    const gain = new GainNode(target, { gain: gainValue(hit.fromUserId) });
    const source = new AudioBufferSourceNode(target, { buffer });
    const entry = { source, gain, userId: hit.fromUserId };
    source.connect(gain).connect(master);
    source.onended = () => { source.onended=null;playing.delete(entry); source.disconnect(); gain.disconnect();idle.schedule(); };
    playing.add(entry);
    starts.push(now);
    source.start();
    } finally {pendingPlays-=1;idle.schedule();}
  }

  /** @param {PokeAudioSettings} state @returns {void} */
  function setSettings(state) {
    const next = validateSettings(state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    settings = next;
    refresh().catch(error => options.reportError(error instanceof Error ? error : new Error(String(error))));
  }

  /** @returns {Promise<void>} */
  async function close() {
    if (closed) return;
    closed = true;
    stop();
    idle.cancel();await releaseContext();
  }

  return { play, refresh, getSettings: () => ({ ...settings }), setSettings, stop, close };
}
