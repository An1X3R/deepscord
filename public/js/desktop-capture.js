// @ts-check
import { screenCaptureTarget, screenEncodingPolicy } from './screen-preferences.js';

/** @typedef {{id:string,name:string,kind:'screen'|'window',thumbnail:string}} ScreenSource */
/** @typedef {{pid:number,name:string,title:string}} ProcessSource */
/** @typedef {{listCaptureSources:()=>Promise<ScreenSource[]>,selectCaptureSource:(id:string)=>Promise<void>,listAudioProcesses:()=>Promise<ProcessSource[]>,startProcessAudio:(pid:number)=>Promise<{id:string,sampleRate:number,channels:number}>,startGlobalAudio:()=>Promise<{id:string,sampleRate:number,channels:number}>,stopProcessAudio:()=>Promise<void>,onProcessAudio:(callback:(packet:{id:string,pcm:ArrayBuffer})=>void)=>(()=>void),onProcessAudioEnded:(callback:(packet:{id:string,error:string|null})=>void)=>(()=>void)}} CaptureBridge */

/** @returns {CaptureBridge} */
function bridge() {
  const desktop = /** @type {Window & {deepscord?:CaptureBridge}} */ (window).deepscord;
  if (!desktop) throw new DOMException('请使用 Windows 桌面客户端选择进程或屏幕', 'NotSupportedError');
  return desktop;
}

/** @returns {Promise<ScreenSource[]>} */
export async function listScreenSources() { return bridge().listCaptureSources(); }
/** @returns {Promise<ProcessSource[]>} */
export async function listAudioProcesses() { return bridge().listAudioProcesses(); }
/** @param {string} sourceId @param {import('./screen-preferences.js').ScreenPreferences} preferences @returns {Promise<MediaStream>} */
export async function captureScreen(sourceId, preferences) {
  const target = screenCaptureTarget(preferences);
  const constraints = { width: { ideal: target.width, max: target.width }, height: { ideal: target.height, max: target.height }, frameRate: { ideal: target.frameRate, max: target.frameRate } };
  await bridge().selectCaptureSource(sourceId);
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: constraints });
  const track = stream.getVideoTracks()[0];
  if (!track) { for (const value of stream.getTracks()) value.stop(); throw new DOMException('屏幕来源没有返回画面', 'NotReadableError'); }
  try { await track.applyConstraints(constraints); track.contentHint = screenEncodingPolicy(preferences.screenContentMode).contentHint; }
  catch (error) { for (const value of stream.getTracks()) value.stop(); throw error; }
  return stream;
}

/** A separate, unprocessed stereo source; it never enters the microphone graph. */
export class ProcessAudioCapture {
  /** @param {(error:Error)=>void} onError @param {()=>void} onEnded */
  constructor(onError, onEnded) {
    this.onError = onError;
    this.onEnded = onEnded;
    /** @type {AudioContext|null} */ this.context = null;
    /** @type {MediaStream|null} */ this.stream = null;
    /** @type {AudioWorkletNode|null} */ this.node = null;
    /** @type {string|null} */ this.id = null;
    /** @type {Array<()=>void>} */ this.unsubscribe = [];
    this.generation = 0;
    this.starting = false;
    /** @type {Promise<void>|null} */ this.stopping = null;
    this.lastWarning = 0;
  }

  /** @param {number} pid @returns {Promise<MediaStream>} */
  async start(pid) { return this.startSource(() => bridge().startProcessAudio(pid)); }

  /** @returns {Promise<MediaStream>} */
  async startGlobal() { return this.startSource(() => bridge().startGlobalAudio()); }

  /** @param {()=>Promise<{id:string,sampleRate:number,channels:number}>} openSource @returns {Promise<MediaStream>} */
  async startSource(openSource) {
    if (this.context || this.starting || this.stopping) throw new Error('请等待当前伴奏操作结束');
    const desktop = bridge();
    this.starting = true;
    const generation = ++this.generation;
    const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.context = context;
    try {
      await context.audioWorklet.addModule(new URL('./process-audio-worklet.js', import.meta.url));
      await context.resume();
      if (generation !== this.generation) throw new DOMException('伴奏已取消', 'AbortError');
      const node = new AudioWorkletNode(context, 'deepscord-process-audio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      this.node = node;
      const destination = new MediaStreamAudioDestinationNode(context, { channelCount: 2, channelCountMode: 'explicit' });
      node.connect(destination);
      const silent = new GainNode(context, { gain: 0 });
      node.connect(silent).connect(context.destination);
      this.stream = destination.stream;
      node.port.onmessage = (event) => {
        const message = /** @type {{type?:string,message?:string,droppedSamples?:number}} */ (event.data);
        if (message.type === 'error') this.onError(new Error(message.message));
        if (message.type === 'overflow' && performance.now() - this.lastWarning > 1000) {
          this.lastWarning = performance.now();
          console.warn('Accompaniment audio queue overflow', { droppedSamples: message.droppedSamples });
        }
      };
      this.unsubscribe.push(desktop.onProcessAudio((packet) => {
        if (packet.id !== this.id || !(packet.pcm instanceof ArrayBuffer)) return;
        node.port.postMessage(packet.pcm, [packet.pcm]);
      }));
      this.unsubscribe.push(desktop.onProcessAudioEnded((packet) => {
        if (packet.id !== this.id) return;
        if (packet.error) this.onError(new Error(packet.error));
        this.stop().then(() => this.onEnded(), (error) => this.onError(error));
      }));
      const result = await openSource();
      if (generation !== this.generation) throw new DOMException('伴奏已取消', 'AbortError');
      if (result.sampleRate !== 48000 || result.channels !== 2 || typeof result.id !== 'string') throw new TypeError('伴奏采集格式不匹配');
      this.id = result.id;
      return destination.stream;
    } catch (error) {
      if (generation === this.generation) await this.stop();
      throw error;
    } finally {
      this.starting = false;
    }
  }

  /** @returns {Promise<void>} */
  async stop() {
    if (this.stopping) return this.stopping;
    this.generation += 1;
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.id = null;
    if (this.stream) for (const track of this.stream.getTracks()) track.stop();
    this.stream = null;
    this.node?.disconnect();
    this.node = null;
    const context = this.context;
    this.context = null;
    this.stopping = (async () => {
      try { await bridge().stopProcessAudio(); }
      finally { if (context && context.state !== 'closed') await context.close(); }
    })();
    try { await this.stopping; }
    finally { this.stopping = null; }
  }
}
