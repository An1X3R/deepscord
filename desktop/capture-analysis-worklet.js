// @ts-check
/// <reference path="../types/audio-worklet.d.ts" />

class CaptureAnalysisProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(32768);
    this.offset = 0;
  }
  /** @param {number} frequency @returns {number} */
  amplitude(frequency) {
    let real = 0;
    let imaginary = 0;
    let weights = 0;
    for (let index = 0; index < this.samples.length; index += 1) {
      const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (this.samples.length - 1));
      const phase = 2 * Math.PI * frequency * index / sampleRate;
      real += this.samples[index] * weight * Math.cos(phase);
      imaginary += this.samples[index] * weight * Math.sin(phase);
      weights += weight;
    }
    return 2 * Math.hypot(real, imaginary) / weights;
  }
  /** @param {Float32Array[][]} inputs @param {Float32Array[][]} outputs @param {Record<string,Float32Array>} parameters @returns {boolean} */
  process(inputs, outputs, parameters) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let frame = 0; frame < channels[0].length; frame += 1) {
      this.samples[this.offset++] = channels.length === 2 ? (channels[0][frame] + channels[1][frame]) / 2 : channels[0][frame];
      if (this.offset === this.samples.length) {
        this.port.postMessage({ amplitude431:this.amplitude(431),amplitude997:this.amplitude(997),sampleRate,channels:channels.length,frames:this.samples.length });
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture-analysis', CaptureAnalysisProcessor);
