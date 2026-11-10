// @ts-check

/** @typedef {{url:string,name:string}} RadioStation */
/** @typedef {{stationName:string,trackTitle:string|null}} RadioMetadata */
/** @typedef {RadioMetadata & {format:'hls'|'audio',metadataAvailable:boolean}} RadioInspection */
/** @typedef {{inspectRadioStation:(request:{id:string,url:string})=>Promise<RadioInspection>,readRadioMetadata:(request:{id:string,url:string})=>Promise<RadioInspection>,cancelRadioMetadata:(id:string)=>Promise<void>,authorizeRadioResource:(request:{stationId:string,url:string})=>Promise<void>,releaseRadioStation:(stationId:string)=>Promise<void>}} RadioMetadataBridge */
/** @typedef {{volume:number,deviceId:string,deafened:boolean}} RadioOutput */
/** @typedef {'idle'|'loading'|'playing'|'error'} RadioState */
/** @typedef {{onMetadata:(metadata:RadioMetadata)=>void,onError:(error:Error)=>void,onState:(state:RadioState)=>void,metadataBridge:RadioMetadataBridge|null}} RadioPlayerOptions */
/** @typedef {{setStation:(station:RadioStation|null)=>Promise<void>,setOutput:(output:RadioOutput)=>Promise<void>,dispose:()=>Promise<void>}} RadioPlayer */

/** @param {string} input @returns {string} */
function streamUrl(input) {
  const url = new URL(input);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || input.length > 4096) throw new TypeError('Radio requires an HTTP(S) direct audio or HLS URL without embedded credentials');
  url.hash = '';
  return url.href;
}
/** @param {string} url @returns {string} */
function address(url) { const parsed = new URL(url); return parsed.origin + parsed.pathname; }

/** Local listening uses an independent media element and never creates a capture stream.
 * @param {RadioPlayerOptions} options @returns {RadioPlayer} */
export function createRadioPlayer(options) {
  /** @type {HTMLAudioElement|null} */ let audio = null;
  /** @type {import('../vendor/hls/hls.mjs').default|null} */ let hls = null;
  /** @type {RadioOutput} */ let output = { volume:100, deviceId:'default', deafened:false };
  /** @type {ReturnType<typeof setTimeout>|null} */ let pollTimer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */ let loadTimer = null;
  /** @type {string|null} */ let requestId = null;
  /** @type {string|null} */ let stationToken = null;
  let generation = 0;
  let disposed = false;
  let routing = Promise.resolve();

  /** @returns {void} */
  function cancelRequest() {
    const id = requestId;
    requestId = null;
    if (id && options.metadataBridge) void options.metadataBridge.cancelRadioMetadata(id).catch(error => {
      options.onError(new Error(`Radio metadata cancellation failed: ${error instanceof Error ? error.message : String(error)}`));
    });
  }
  /** @returns {void} */
  function stop() {
    generation += 1;
    if (pollTimer !== null) clearTimeout(pollTimer);
    if (loadTimer !== null) clearTimeout(loadTimer);
    pollTimer = null; loadTimer = null;
    cancelRequest();
    const token = stationToken; stationToken = null;
    if (token && options.metadataBridge) void options.metadataBridge.releaseRadioStation(token).catch(error => {
      options.onError(new Error(`Radio station resource release failed: ${error instanceof Error ? error.message : String(error)}`));
    });
    hls?.destroy(); hls = null;
    if (audio) {
      audio.onplaying = null; audio.onerror = null; audio.onwaiting = null; audio.onended = null;
      audio.pause(); audio.removeAttribute('src'); audio.load(); audio.remove(); audio = null;
    }
  }
  /** @param {RadioOutput} value @returns {Promise<void>} */
  async function setOutput(value) {
    if (!Number.isFinite(value.volume) || value.volume < 0 || value.volume > 200 || typeof value.deviceId !== 'string' || typeof value.deafened !== 'boolean') throw new TypeError('Radio output requires volume 0..200, deviceId:string, deafened:boolean');
    output = { volume:value.volume, deviceId:value.deviceId, deafened:value.deafened };
    const target = audio;
    if (!target) return;
    target.muted = true;
    const route = async () => {
      if (target !== audio || disposed) return;
      const deviceId = output.deviceId === 'default' ? '' : output.deviceId;
      if (typeof target.setSinkId !== 'function') {
        if (deviceId) throw new DOMException('Radio output device selection is unavailable in this browser', 'NotSupportedError');
      } else if (target.sinkId !== deviceId) await target.setSinkId(deviceId);
      if (target !== audio || disposed) return;
      if ((output.deviceId === 'default' ? '' : output.deviceId) !== deviceId) return;
      target.volume = Math.min(1, output.volume / 100);
      target.muted = output.deafened;
    };
    const operation = routing.then(route, route);
    routing = operation;
    await operation;
  }
  /** @param {RadioStation} station @param {number} current @param {string} name @returns {Promise<void>} */
  async function pollMetadata(station, current, name) {
    const bridge = options.metadataBridge;
    if (!bridge || current !== generation) return;
    const id = crypto.randomUUID(); requestId = id;
    try {
      const info = await bridge.readRadioMetadata({ id, url:station.url });
      if (current !== generation) return;
      options.onMetadata({ stationName:info.stationName || name, trackTitle:info.trackTitle });
      if (!info.metadataAvailable) return;
    } catch (error) {
      if (current !== generation) return;
      options.onMetadata({stationName:name,trackTitle:null});
      options.onError(new Error(`Radio track metadata unavailable for ${address(station.url)}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    } finally { if (requestId === id) requestId = null; }
    if (current === generation) pollTimer = setTimeout(() => { void pollMetadata(station,current,name); }, 15000);
  }
  /** @param {RadioStation|null} station @returns {Promise<void>} */
  async function setStation(station) {
    if (disposed) throw new Error('Radio player is disposed');
    if (station && (typeof station.name !== 'string' || station.name.length > 256)) throw new TypeError('Radio station requires a name of at most 256 characters');
    const selected = station ? { url:streamUrl(station.url), name:station.name.trim() } : null;
    stop();
    if (!selected) { options.onMetadata({stationName:'',trackTitle:null}); options.onState('idle'); return; }
    const current = generation;
    const selectedUrl = selected.url;
    options.onState('loading');
    options.onMetadata({stationName:selected.name,trackTitle:null});
    /** @param {Error} error @returns {void} */
    function fail(error) {
      if (current !== generation) return;
      stop(); options.onState('error'); options.onError(error);
    }
    /** @returns {void} */
    function watchLoading() {
      if (loadTimer !== null) clearTimeout(loadTimer);
      loadTimer = setTimeout(() => fail(new Error(`Radio playback timed out after 25 seconds: ${address(selectedUrl)}`)),25000);
    }
    try {
      let format = /\.m3u8(?:$|\?)/i.test(selected.url) ? 'hls' : 'audio';
      let name = selected.name;
      let metadataAvailable = false;
      if (options.metadataBridge) {
        const id = crypto.randomUUID(); requestId = id; stationToken = id;
        const info = await options.metadataBridge.inspectRadioStation({id,url:selected.url});
        if (current !== generation) return;
        requestId = null;
        if (info.format === 'hls') format = 'hls';
        name = info.stationName || name; metadataAvailable = info.metadataAvailable;
        options.onMetadata({stationName:name,trackTitle:null});
      }
      const target = document.createElement('audio'); audio = target;
      target.preload = 'none'; target.autoplay = false; target.muted = true;
      target.setAttribute('aria-hidden','true'); target.style.display = 'none'; document.body.append(target);
      target.onplaying = () => { if (current === generation) { if (loadTimer !== null) clearTimeout(loadTimer); loadTimer = null; options.onState('playing'); } };
      target.onwaiting = () => { if (current === generation) { options.onState('loading'); watchLoading(); } };
      target.onerror = () => fail(new Error(`Radio media failed: ${address(selected.url)}; code=${target.error?.code}; detail=${target.error?.message || 'stream unavailable, unsupported codec, or blocked by browser policy'}`));
      target.onended = () => fail(new Error(`Radio live stream ended: ${address(selected.url)}`));
      await setOutput(output);
      if (current !== generation) return;
      watchLoading();
      if (format === 'hls' && (options.metadataBridge !== null || !target.canPlayType('application/vnd.apple.mpegurl'))) {
        const {default:Hls} = await import('../vendor/hls/hls.mjs');
        if (current !== generation) return;
        if (!Hls.isSupported()) throw new DOMException('HLS playback requires MediaSource support', 'NotSupportedError');
        const controller = new Hls({ enableWorker:false, maxBufferLength:15, backBufferLength:0,
          xhrSetup:async(_xhr,url) => {
            if (current !== generation) throw new DOMException('Radio station changed before HLS request', 'AbortError');
            if (options.metadataBridge) {
              const token = stationToken;
              if (!token) throw new DOMException('Radio station authorization was released', 'AbortError');
              await options.metadataBridge.authorizeRadioResource({stationId:token,url});
              if (current !== generation) throw new DOMException('Radio station changed during HLS authorization', 'AbortError');
            }
          },
          manifestLoadPolicy:{default:{maxTimeToFirstByteMs:10000,maxLoadTimeMs:15000,timeoutRetry:{maxNumRetry:1,retryDelayMs:1000,maxRetryDelayMs:1000},errorRetry:{maxNumRetry:1,retryDelayMs:1000,maxRetryDelayMs:1000}}},
        }); hls = controller;
        controller.on(Hls.Events.ERROR, (_event,data) => {
          if (data.fatal) fail(new Error(`Radio HLS failed: ${address(selected.url)}; type=${data.type}; detail=${data.details}; status=${data.response?.code ?? 'unavailable'}; HLS upstream must permit CORS`));
          else console.warn('Radio HLS request or buffer warning', { type:data.type, detail:data.details, status:data.response?.code });
        });
        controller.attachMedia(target); controller.loadSource(selected.url);
      } else target.src = selected.url;
      await target.play();
      if (current === generation && metadataAvailable) void pollMetadata(selected,current,name);
    } catch (error) {
      if (current !== generation) return;
      const failure = new Error(`Radio playback could not start: ${address(selected.url)}; ${error instanceof Error ? error.message : String(error)}`, {cause:error});
      fail(failure); throw failure;
    }
  }
  /** @returns {Promise<void>} */
  async function dispose() { stop(); disposed = true; options.onState('idle'); }
  return {setStation,setOutput,dispose};
}
