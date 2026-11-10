// @ts-check

/** @typedef {{inputDeviceId:string,echoCancellation:boolean,noiseSuppression:boolean,autoGainControl:boolean}} CapturePreferences */
/** @typedef {{echoCancellation:boolean|null,noiseSuppression:boolean|null,autoGainControl:boolean|null,sampleRate:number|null,channelCount:number|null,latency:number|null,deviceId:string,deviceLabel:string,trackId:string}} CaptureReceipt */

/** @param {CapturePreferences} value @returns {CapturePreferences} */
export function capturePreferences(value) {
  if (typeof value.inputDeviceId !== 'string' || value.inputDeviceId.length === 0) throw new TypeError('麦克风设备标识无效');
  for (const key of /** @type {const} */ (['echoCancellation', 'noiseSuppression', 'autoGainControl'])) {
    if (typeof value[key] !== 'boolean') throw new TypeError('麦克风增强选项必须为开或关：' + key);
  }
  return { inputDeviceId: value.inputDeviceId, echoCancellation: value.echoCancellation, noiseSuppression: value.noiseSuppression, autoGainControl: value.autoGainControl };
}

/** @param {CapturePreferences} a @param {CapturePreferences} b @returns {boolean} */
function samePreferences(a, b) {
  return a.inputDeviceId === b.inputDeviceId && a.echoCancellation === b.echoCancellation && a.noiseSuppression === b.noiseSuppression && a.autoGainControl === b.autoGainControl;
}

/** @param {CapturePreferences} requested @returns {MediaTrackConstraints} */
function constraints(requested) {
  const supported = navigator.mediaDevices.getSupportedConstraints();
  for (const key of /** @type {const} */ (['echoCancellation', 'noiseSuppression', 'autoGainControl'])) {
    if (!supported[key]) throw new DOMException('当前音频引擎不支持此增强选项：' + key, 'NotSupportedError');
  }
  return {
    deviceId: { exact: requested.inputDeviceId },
    echoCancellation: { exact: requested.echoCancellation },
    noiseSuppression: { exact: requested.noiseSuppression },
    autoGainControl: { exact: requested.autoGainControl },
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 },
  };
}

/** @param {MediaStreamTrack} track @returns {CaptureReceipt} */
function receipt(track) {
  const actual = /** @type {MediaTrackSettings & {latency?:number}} */ (track.getSettings());
  return {
    echoCancellation: typeof actual.echoCancellation === 'boolean' ? actual.echoCancellation : null,
    noiseSuppression: typeof actual.noiseSuppression === 'boolean' ? actual.noiseSuppression : null,
    autoGainControl: typeof actual.autoGainControl === 'boolean' ? actual.autoGainControl : null,
    sampleRate: actual.sampleRate ?? null, channelCount: actual.channelCount ?? null,
    latency: typeof actual.latency === 'number' && Number.isFinite(actual.latency) && actual.latency >= 0 ? actual.latency : null,
    deviceId: actual.deviceId ?? '', deviceLabel: track.label, trackId: track.id,
  };
}

/** A serialized, transactional connector to the native microphone. */
export class MicrophoneCapture {
  /** @param {(stream:MediaStream)=>void} install */
  constructor(install) {
    this.install = install;
    /** @type {MediaStream|null} */ this.stream = null;
    /** @type {CapturePreferences|null} */ this.requested = null;
    /** @type {CapturePreferences|null} */ this.applied = null;
    /** @type {Promise<void>|null} */ this.pending = null;
    /** @type {Promise<void>} */ this.settled = Promise.resolve();
    /** @type {string|null} */ this.error = null;
    this.generation = 0;
  }

  /** @param {CapturePreferences} value @returns {Promise<void>} */
  async open(value) {
    const generation = this.generation;
    this.requested = capturePreferences(value);
    this.error = null;
    do {
      if (!this.pending) {
        const task = this.settled.then(() => this.drain(generation)).catch((error) => {
          if (generation === this.generation) {
            this.error = error instanceof Error ? `${error.name}: ${error.message}` : '麦克风采集失败，音频引擎未提供错误详情';
            console.error('Microphone capture failed', { message: this.error, requested: this.requested });
          }
          throw error;
        }).finally(() => { if (this.pending === task) this.pending = null; });
        this.pending = task;
        // Callers receive task failures; the queue waits for cleanup even after cancellation.
        this.settled = Promise.allSettled([task]).then(() => undefined);
      }
      await this.pending;
      if (generation !== this.generation) throw new DOMException('麦克风操作已取消：已离开或停止采集', 'AbortError');
    } while (this.requested && (!this.applied || !this.stream?.active || !samePreferences(this.requested, this.applied)));
  }

  /** @param {number} generation @returns {Promise<void>} */
  async drain(generation) {
    if (generation !== this.generation) throw new DOMException('麦克风操作已取消：已离开或停止采集', 'AbortError');
    while (this.requested) {
      const requested = this.requested;
      if (this.stream?.active && this.applied && samePreferences(this.applied, requested)) return;
      // Chromium cannot always keep different processors on one physical input alive together.
      // Release only the capture source; the graph's outbound track remains connected.
      if (this.stream && this.applied && (
        this.applied.echoCancellation !== requested.echoCancellation ||
        this.applied.noiseSuppression !== requested.noiseSuppression ||
        this.applied.autoGainControl !== requested.autoGainControl
      )) {
        for (const track of this.stream.getTracks()) track.stop();
        this.stream = null;
        this.applied = null;
      }
      const candidate = await navigator.mediaDevices.getUserMedia({ audio: constraints(requested), video: false }).catch((error) => {
        if (error instanceof DOMException) {
          const failedConstraint = 'constraint' in error && typeof error.constraint === 'string' ? error.constraint : '未提供';
          throw new DOMException(`获取麦克风失败：${error.name}；约束=${failedConstraint}；输入=${requested.inputDeviceId}；回声消除=${requested.echoCancellation}；降噪=${requested.noiseSuppression}；自动增益=${requested.autoGainControl}；${error.message}`, error.name);
        }
        throw error;
      });
      try {
        if (generation !== this.generation) throw new DOMException('麦克风操作已取消：已离开或停止采集', 'AbortError');
        if (!this.requested || !samePreferences(requested, this.requested)) {
          for (const track of candidate.getTracks()) track.stop();
          continue;
        }
        const tracks = candidate.getAudioTracks();
        if (tracks.length !== 1 || tracks[0].readyState !== 'live') throw new DOMException('麦克风没有返回可用的单路音轨', 'NotReadableError');
        const actual = receipt(tracks[0]);
        for (const key of /** @type {const} */ (['echoCancellation', 'noiseSuppression', 'autoGainControl'])) {
          if (actual[key] !== requested[key]) throw new DOMException(`麦克风增强未生效：${key}，请求=${requested[key]}，实际=${actual[key]}`, 'NotSupportedError');
        }
        this.install(candidate);
        const previous = this.stream;
        this.stream = candidate;
        this.applied = requested;
        if (previous) for (const track of previous.getTracks()) track.stop();
      } catch (error) {
        for (const track of candidate.getTracks()) track.stop();
        throw error;
      }
    }
  }

  /** @returns {void} */
  stop() {
    this.generation += 1;
    this.pending = null;
    this.requested = null;
    this.applied = null;
    this.error = null;
    if (this.stream) for (const track of this.stream.getTracks()) track.stop();
    this.stream = null;
  }

  /** @returns {{requested:CapturePreferences|null,applied:CapturePreferences|null,actual:CaptureReceipt|null,pending:boolean,error:string|null}} */
  info() {
    const track = this.stream?.getAudioTracks()[0];
    return {
      requested: this.requested ? { ...this.requested } : null,
      applied: this.applied ? { ...this.applied } : null,
      actual: track && track.readyState === 'live' ? receipt(track) : null,
      pending: this.pending !== null, error: this.error,
    };
  }
}
