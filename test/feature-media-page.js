// @ts-check
import { PeerLink } from '../public/js/peer-link.js';
import { RemoteAudio } from '../public/js/remote-audio.js';
import { parsePeerSignal } from '../public/js/network-protocol.js';

/** @typedef {import('../public/js/network-protocol.js').PeerSignal} PeerSignal */
/** @typedef {import('../public/js/network-protocol.js').PeerControl} PeerControl */
/** @typedef {{playback:RemoteAudio,analyser:AnalyserNode}} AudioSink */
/** @typedef {{checks:{name:string,details:string}[],errors:string[],failure:string|null,diagnostics:string}} FeatureReport */
/** @param {number} ms @returns {Promise<void>} */
function render(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
/** @param {AnalyserNode} analyser @returns {number} */
function rms(analyser) {
  const values = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(values);
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
}
/** @param {AnalyserNode} analyser @returns {number} */
function frequency(analyser) {
  const values = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(values);
  let peak = 0;
  for (let index = 1; index < values.length; index += 1) if (values[index] > values[peak]) peak = index;
  return peak * analyser.context.sampleRate / analyser.fftSize;
}
/** @param {AnalyserNode} analyser @param {number} hz @returns {number} */
function toneDb(analyser, hz) {
  const values = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(values);
  const bin = Math.round(hz * analyser.fftSize / analyser.context.sampleRate);
  return Math.max(-160, ...values.slice(Math.max(0, bin - 1), bin + 2));
}
/** @param {RTCPeerConnection} pc @returns {Promise<number>} */
async function decoded(pc) {
  let frames = 0;
  (await pc.getStats()).forEach(/** @param {{type:string,kind?:string,framesDecoded?:number}} entry */ (entry) => {
    if (entry.type === 'inbound-rtp' && entry.kind === 'video' && typeof entry.framesDecoded === 'number') frames += entry.framesDecoded;
  });
  return frames;
}
/** @param {RTCPeerConnection} pc @returns {Promise<number>} */
async function sentFrames(pc) {
  let frames = 0;
  (await pc.getStats()).forEach(/** @param {{type:string,kind?:string,framesSent?:number}} entry */ (entry) => {
    if (entry.type === 'outbound-rtp' && entry.kind === 'video' && typeof entry.framesSent === 'number') frames += entry.framesSent;
  });
  return frames;
}
/** @param {{brokerUrl:string,stopUrl:string}} options @returns {Promise<FeatureReport>} */
export async function run(options) {
  const context = new AudioContext({ sampleRate: 48000 });
  const silent = new GainNode(context, { gain: 0 });
  silent.connect(context.destination);
  const mic = context.createMediaStreamDestination();
  const music = context.createMediaStreamDestination();
  const micTone = new OscillatorNode(context, { frequency: 440 });
  const musicTone = new OscillatorNode(context, { frequency: 880 });
  const micLevel = new GainNode(context, { gain: 0.08 });
  const musicLevel = new GainNode(context, { gain: 0.08 });
  const stereoMusic = new MediaStreamAudioDestinationNode(context, { channelCount: 2, channelCountMode: 'explicit' });
  const leftTone = new OscillatorNode(context, { frequency: 660 });
  const rightTone = new OscillatorNode(context, { frequency: 1320 });
  const leftLevel = new GainNode(context, { gain: 0.08 });
  const rightLevel = new GainNode(context, { gain: 0.08 });
  const merger = new ChannelMergerNode(context, { numberOfInputs: 2 });
  leftTone.connect(leftLevel).connect(merger, 0, 0);
  rightTone.connect(rightLevel).connect(merger, 0, 1);
  merger.connect(stereoMusic);
  micTone.connect(micLevel).connect(mic);
  musicTone.connect(musicLevel).connect(music);
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
  const painter = canvas.getContext('2d');
  if (!painter) throw new Error('Canvas 2D context unavailable');
  let tick = 0;
  const drawing = setInterval(() => { painter.fillStyle = `rgb(${tick++ % 255},80,160)`; painter.fillRect(0, 0, 320, 180); }, 33);
  const screen = canvas.captureStream(30);
  /** @type {Map<string,AudioSink>} */ const audio = new Map();
  /** @type {Map<string,HTMLVideoElement>} */ const videos = new Map();
  /** @type {string[]} */ const errors = [];
  /** @type {FeatureReport['checks']} */ const checks = [];
  /** @type {PeerControl[]} */ const controls = [];
  /** @type {PeerLink[]} */ const links = [];
  /** @type {Promise<void>[]} */ const sends = [];
  let offline = false;
  let failure = null;
  let diagnostics = '';
  /** @param {Error} error @returns {void} */
  function fail(error) { errors.push(error.name + ': ' + error.message); }
  /** @param {boolean} condition @param {string} name @param {string} details @returns {void} */
  function check(condition, name, details) {
    if (!condition) throw new Error(name + ': ' + details);
    checks.push({ name, details });
  }
  /** @param {string} name @param {()=>boolean|Promise<boolean>} probe @returns {Promise<void>} */
  async function until(name, probe) {
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) {
      if (errors.length) throw new Error(JSON.stringify({ name, errors }));
      if (await probe()) return;
      await render(80);
    }
    throw new Error('Native feature timeout: ' + name);
  }
  /** @param {'a'|'b'} id @param {'a'|'b'} other @returns {PeerLink} */
  function create(id, other) {
    const link = new PeerLink({ selfId: id, peerId: other,
      config: { networkMode: 'direct', mediaPolicy: 'direct', iceTransportPolicy: 'all', iceServers: [], iceExpiresAt: null },
      track: mic.stream.getAudioTracks()[0], stream: mic.stream,
      sendSignal: (signal) => {
        if (offline) { fail(new Error('Broker signaling attempted after physical broker shutdown')); return; }
        const task = fetch(options.brokerUrl + '/' + other, { method: 'POST', body: JSON.stringify(signal) }).then((response) => { if (!response.ok) throw new Error('Broker POST status=' + response.status); });
        sends.push(task); task.catch(fail);
      },
      onTrack: (stream, kind) => {
        if (kind === 'screen') {
          const video = document.createElement('video'); video.autoplay = true; video.muted = true; video.srcObject = stream;
          document.body.append(video); videos.set(id, video); return;
        }
        const playback = new RemoteAudio(context, stream, 1, fail);
        const analyser = new AnalyserNode(context, { fftSize: 4096, smoothingTimeConstant: 0 });
        playback.gain.disconnect(); playback.gain.connect(analyser).connect(silent);
        audio.set(id + ':' + kind, { playback, analyser });
      },
      onControl: (message) => {
        controls.push(message);
        if (message.type === 'watch') link.setScreenTrack(message.watching ? screen.getVideoTracks()[0] : null).catch(fail);
      }, onReady: () => {}, onState: () => {}, onError: fail,
    });
    links.push(link); return link;
  }
  /** @param {'a'|'b'} id @param {PeerLink} link @returns {Promise<void>} */
  async function pump(id, link) {
    const response = await fetch(options.brokerUrl + '/' + id);
    if (!response.ok) throw new Error('Broker GET status=' + response.status);
    /** @type {import('../public/js/network-protocol.js').JsonValue} */ const messages = await response.json();
    if (!Array.isArray(messages)) throw new TypeError('Broker queue must be an array');
    for (const message of messages) {
      if (typeof message !== 'string') throw new TypeError('Broker signal must be JSON text');
      await link.receive(parsePeerSignal(JSON.parse(message), 'direct'));
    }
  }
  /** @param {string} key @returns {AudioSink} */
  function sink(key) { const result = audio.get(key); if (!result) throw new Error('Missing actual remote sink: ' + key); return result; }
  try {
    await context.resume(); micTone.start(); musicTone.start(); leftTone.start(); rightTone.start();
    const a = create('a', 'b'); const b = create('b', 'a');
    await until('three reserved transceivers connect bidirectionally', async () => {
      await Promise.all(sends); await pump('a', a); await pump('b', b);
      return links.every((link) => link.pc.connectionState === 'connected' && link.control.readyState === 'open');
    });
    check(links.every((link) => link.pc.getTransceivers().length === 3 && link.pc.signalingState === 'stable'), 'fixed-three-m-lines', JSON.stringify(links.map((link) => link.pc.getTransceivers().map((transceiver) => ({ mid: transceiver.mid, direction: transceiver.currentDirection })))));
    await until('bidirectional decoded microphone PCM', () => ['a:microphone', 'b:microphone'].every((key) => audio.has(key) && rms(sink(key).analyser) > 0.01));
    await Promise.all(links.map((link) => link.setAccompanimentTrack(music.stream.getAudioTracks()[0])));
    await until('bidirectional decoded accompaniment after null-to-track', () => ['a:accompaniment', 'b:accompaniment'].every((key) => audio.has(key) && rms(sink(key).analyser) > 0.01));
    const frequencies = ['a', 'b'].map((id) => ({ id, microphone: frequency(sink(id + ':microphone').analyser), accompaniment: frequency(sink(id + ':accompaniment').analyser) }));
    check(frequencies.every((value) => Math.abs(value.microphone - 440) < 25 && Math.abs(value.accompaniment - 880) < 25), 'independent-decoded-frequencies', JSON.stringify(frequencies));
    const stopped = await fetch(options.stopUrl, { method: 'POST' }); check(stopped.ok, 'physical-signaling-broker-stopped', String(stopped.status)); offline = true;
    a.sendControl({ type: 'media', screen: true, accompaniment: true });
    await until('offline media declaration over real data channel', () => controls.some((control) => control.type === 'media' && control.screen));
    await render(300); check(await decoded(b.pc) === 0 && await sentFrames(a.pc) === 0, 'no-screen-frames-before-watch', JSON.stringify({ sent: await sentFrames(a.pc), decoded: await decoded(b.pc) }));
    b.sendControl({ type: 'watch', watching: true });
    await until('watch starts actual decoded video without renegotiation', async () => await decoded(b.pc) > 3);
    const firstFrames = await decoded(b.pc); b.sendControl({ type: 'watch', watching: false });
    await until('unwatch detaches sender', () => a.screen !== null && a.screen.sender.track === null);
    await render(500); const pausedFrames = await decoded(b.pc); const pausedSent = await sentFrames(a.pc); await render(500);
    check(await decoded(b.pc) === pausedFrames && await sentFrames(a.pc) === pausedSent, 'unwatch-stops-new-decoded-frames', JSON.stringify({ firstFrames, pausedFrames, after: await decoded(b.pc), pausedSent, afterSent: await sentFrames(a.pc) }));
    b.sendControl({ type: 'watch', watching: true }); await until('rewatch resumes actual video', async () => await decoded(b.pc) > pausedFrames + 3);
    check(await decoded(b.pc) > pausedFrames + 3, 'rewatch-resumes-decoded-video', JSON.stringify({ pausedFrames, resumedFrames: await decoded(b.pc), sentFrames: await sentFrames(a.pc) }));
    check(links.every((link) => link.pc.signalingState === 'stable' && link.pc.getTransceivers().length === 3), 'null-track-replacements-preserve-negotiated-m-lines', 'audio/video start, stop and restart used replaceTrack');
    mic.stream.getAudioTracks()[0].enabled = false;
    await until('muted microphone produces decoded silence', () => rms(sink('b:microphone').analyser) < 0.001);
    check(rms(sink('b:accompaniment').analyser) > 0.01, 'microphone-mute-keeps-music', String(rms(sink('b:accompaniment').analyser)));
    mic.stream.getAudioTracks()[0].enabled = true;
    await until('microphone resumes', () => rms(sink('b:microphone').analyser) > 0.01);
    const target = sink('b:microphone'); await render(200); const baseline = rms(target.analyser);
    for (const [userGain, masterGain] of [[0, 1], [1, 1], [2, 1], [2, 0.5]]) {
      target.playback.setVolume(userGain * masterGain); await render(250);
      const actual = rms(target.analyser); const expected = baseline * userGain * masterGain;
      check(expected === 0 ? actual < 0.000001 : Math.abs(actual / expected - 1) < 0.1, 'remote-user-and-master-gain', JSON.stringify({ userGain, masterGain, baseline, actual, expected }));
    }
    const splitter = new ChannelSplitterNode(context, { numberOfOutputs: 2 });
    const left = new AnalyserNode(context, { fftSize: 4096, smoothingTimeConstant: 0 });
    const right = new AnalyserNode(context, { fftSize: 4096, smoothingTimeConstant: 0 });
    const localStereo = context.createMediaStreamSource(stereoMusic.stream);
    localStereo.connect(splitter); splitter.connect(left, 0); splitter.connect(right, 1); left.connect(silent); right.connect(silent);
    await render(200);
    check(Math.abs(frequency(left) - 660) < 25 && Math.abs(frequency(right) - 1320) < 25, 'generated-source-has-distinct-stereo-channels', JSON.stringify({ channels: stereoMusic.stream.getAudioTracks()[0].getSettings().channelCount, leftHz: frequency(left), rightHz: frequency(right) }));
    localStereo.disconnect();
    sink('b:accompaniment').playback.source.connect(splitter);
    await a.setAccompanimentTrack(stereoMusic.stream.getAudioTracks()[0]);
    await render(600);
    const stereo = { leftHz: frequency(left), rightHz: frequency(right), leftRms: rms(left), rightRms: rms(right), leftSeparationDb: toneDb(left, 660) - toneDb(left, 1320), rightSeparationDb: toneDb(right, 1320) - toneDb(right, 660) };
    check(Math.abs(stereo.leftHz - 660) < 25 && Math.abs(stereo.rightHz - 1320) < 25 && stereo.leftRms > 0.01 && stereo.rightRms > 0.01 && stereo.leftSeparationDb > 20 && stereo.rightSeparationDb > 20, 'stereo-accompaniment-preserves-left-right-tones', JSON.stringify(stereo));
    splitter.disconnect(); left.disconnect(); right.disconnect();
    await Promise.all(links.map((link) => link.setAccompanimentTrack(null)));
    await until('music detached while microphone continues decoded PCM', () => rms(sink('b:accompaniment').analyser) < 0.001 && rms(sink('b:microphone').analyser) > 0.01);
    check(rms(sink('b:microphone').analyser) > 0.01, 'stop-music-preserves-microphone-pcm', JSON.stringify({ musicRms: rms(sink('b:accompaniment').analyser), microphoneRms: rms(sink('b:microphone').analyser) }));
    check(errors.length === 0, 'offline-features-no-errors', JSON.stringify(errors));
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    const reports = await Promise.all(links.map(async (link) => {
      /** @type {{type:string,kind?:string,bytesReceived?:number,bytesSent?:number,totalAudioEnergy?:number,packetsReceived?:number}[]} */ const entries = [];
      (await link.pc.getStats()).forEach((entry) => { if (entry.type === 'inbound-rtp' || entry.type === 'outbound-rtp' || entry.type === 'media-source') entries.push(entry); }); return entries;
    }));
    diagnostics = JSON.stringify({ context: context.state, sampleRate: context.sampleRate, sinks: [...audio].map(([key, value]) => ({ key, rms: rms(value.analyser), frequency: frequency(value.analyser), tracks: value.playback.source.mediaStream.getTracks().map((track) => ({ id: track.id, kind: track.kind, muted: track.muted, state: track.readyState })) })), reports });
  }
  finally {
    clearInterval(drawing); for (const link of links) link.close();
    for (const value of audio.values()) { value.playback.dispose(); value.analyser.disconnect(); }
    for (const video of videos.values()) { video.pause(); video.srcObject = null; video.remove(); }
    for (const stream of [mic.stream, music.stream, stereoMusic.stream, screen]) for (const track of stream.getTracks()) track.stop();
    micTone.stop(); musicTone.stop(); leftTone.stop(); rightTone.stop(); await context.close();
  }
  return { checks, errors, failure, diagnostics };
}
/** @type {Window & {featureMedia?:{run:typeof run}}} */ const host = window;
host.featureMedia = { run };
