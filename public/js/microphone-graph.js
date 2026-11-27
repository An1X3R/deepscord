// @ts-check

/** A mono gain/gate graph with a stable outbound track and replaceable input. */
export class MicrophoneGraph {
  /** @param {AudioContext} context @param {MediaStream} stream @param {number} inputGain @param {number} monitorGain */
  constructor(context, stream, inputGain, monitorGain) {
    this.context = context;
    this.src = context.createMediaStreamSource(stream);
    this.gain = new GainNode(context, { gain: inputGain, channelCount: 1, channelCountMode: 'explicit' });
    this.gate = new GainNode(context, { gain: 0 });
    // Retain at least 40 ms so the 32 ms VAD poll covers sounds between ticks.
    const historySize = 2 ** Math.ceil(Math.log2(context.sampleRate * 0.04));
    this.analyser = new AnalyserNode(context, { fftSize: historySize, smoothingTimeConstant: 0 });
    this.dest = new MediaStreamAudioDestinationNode(context, { channelCount: 1, channelCountMode: 'explicit' });
    this.monitor = new GainNode(context, { gain: monitorGain });
    this.src.connect(this.gain);
    this.gain.connect(this.gate);
    this.gate.connect(this.dest);
    this.gain.connect(this.analyser);
    this.gain.connect(this.monitor);
    this.monitor.connect(context.destination);
  }

  /** @param {MediaStream} stream @returns {void} */
  replaceSource(stream) {
    const next = this.context.createMediaStreamSource(stream);
    next.connect(this.gain);
    this.src.disconnect();
    this.src = next;
  }

  /** @returns {void} */
  dispose() {
    for (const node of [this.src, this.gain, this.gate, this.analyser, this.dest, this.monitor]) node.disconnect();
    for (const track of this.dest.stream.getTracks()) track.stop();
  }
}
