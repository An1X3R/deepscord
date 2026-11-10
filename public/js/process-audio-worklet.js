// @ts-check
/// <reference path="../../types/audio-worklet.d.ts" />

class ProcessAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(9600);
    this.right = new Float32Array(9600);
    this.read = 0;
    this.write = 0;
    this.count = 0;
    this.started = false;
    this.port.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer) || event.data.byteLength % 4 !== 0 || event.data.byteLength > 192000) {
        this.port.postMessage({ type: 'error', message: 'Invalid stereo PCM capture packet' });
        return;
      }
      const samples = new Int16Array(event.data);
      let dropped = 0;
      for (let index = 0; index < samples.length; index += 2) {
        if (this.count === this.left.length) { this.read = (this.read + 1) % this.left.length; this.count -= 1; dropped += 1; }
        this.left[this.write] = samples[index] / 32768;
        this.right[this.write] = samples[index + 1] / 32768;
        this.write = (this.write + 1) % this.left.length;
        this.count += 1;
      }
      if (dropped > 0) this.port.postMessage({ type: 'overflow', droppedSamples: dropped });
    };
  }

  /** @param {Float32Array[][]} inputs @param {Float32Array[][]} outputs @param {Record<string,Float32Array>} parameters @returns {boolean} */
  process(inputs, outputs, parameters) {
    const channels = outputs[0];
    if (!channels || channels.length !== 2) return true;
    if (!this.started && this.count >= 960) this.started = true;
    if (!this.started) return true;
    for (let frame = 0; frame < channels[0].length; frame += 1) {
      if (this.count === 0) { this.started = false; break; }
      channels[0][frame] = this.left[this.read];
      channels[1][frame] = this.right[this.read];
      this.read = (this.read + 1) % this.left.length;
      this.count -= 1;
    }
    return true;
  }
}

registerProcessor('deepscord-process-audio', ProcessAudioProcessor);
