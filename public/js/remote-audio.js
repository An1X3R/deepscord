// @ts-check

/** One received audio track, with independent gain and a shared output device. */
export class RemoteAudio {
  /** @param {AudioContext} context @param {MediaStream} stream @param {number} volume @param {(error:Error)=>void} onError */
  constructor(context, stream, volume, onError) {
    this.disposed = false;
    this.sink = new Audio();
    this.sink.srcObject = stream;
    this.sink.volume = 0;
    // Chromium requires a media sink to drive remote RTP audio decoding.
    this.sink.play().catch((error) => {
      if (!this.disposed) onError(error instanceof Error ? error : new Error(String(error)));
    });
    this.source = new MediaStreamAudioSourceNode(context, { mediaStream: stream });
    this.gain = new GainNode(context, { gain: volume });
    this.analyser = new AnalyserNode(context, { fftSize: 512, smoothingTimeConstant: 0 });
    this.source.connect(this.analyser);
    this.source.connect(this.gain).connect(context.destination);
  }

  /** @param {number} volume @returns {void} */
  setVolume(volume) {
    this.gain.gain.setTargetAtTime(volume, this.gain.context.currentTime, 0.01);
  }

  /** @returns {void} */
  dispose() {
    this.disposed = true;
    this.sink.pause();
    this.sink.srcObject = null;
    this.source.disconnect();
    this.gain.disconnect();
    this.analyser.disconnect();
  }
}
