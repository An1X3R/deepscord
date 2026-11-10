// @ts-check
import { MicrophoneCapture } from '../public/js/microphone-capture.js';
import { MicrophoneGraph } from '../public/js/microphone-graph.js';

/** @typedef {{echoCancellation:boolean,noiseSuppression:boolean,autoGainControl:boolean}} Processing */
/** @typedef {{label:string,requested:Processing,previousLive:number,settings:MediaTrackSettings,capabilities:MediaTrackCapabilities,constraints:MediaTrackConstraints,matches:boolean,allTrackStates:string[]}} Observation */
/** @typedef {{name:string,message:string,constraint:string|null,stage:string}} CaptureFailure */
/** @typedef {{supported:MediaTrackSupportedConstraints,observations:Observation[],stopped:boolean,failure:CaptureFailure|null,devices:{deviceId:string,groupId:string,label:string}[]}} CaptureReport */

/** @param {MediaStream} stream @returns {MediaStreamTrack} */
function audioTrack(stream) {
  const tracks = stream.getAudioTracks();
  if (tracks.length !== 1) throw new Error(`Expected one physical audio track; received ${tracks.length}`);
  return tracks[0];
}

/** @param {Processing} processing @param {string} inputDeviceId @returns {MediaTrackConstraints} */
function exactConstraints(processing, inputDeviceId) {
  return {
    deviceId: { exact: inputDeviceId },
    echoCancellation: { exact: processing.echoCancellation },
    noiseSuppression: { exact: processing.noiseSuppression },
    autoGainControl: { exact: processing.autoGainControl },
  };
}

/** @param {string} label @param {Processing} requested @param {number} previousLive @param {MediaStream} stream @param {ReadonlyArray<MediaStream>} streams @returns {Observation} */
function observe(label, requested, previousLive, stream, streams) {
  const track = audioTrack(stream);
  const settings = track.getSettings();
  return {
    label, requested, previousLive, settings,
    capabilities: track.getCapabilities(), constraints: track.getConstraints(),
    matches: settings.echoCancellation === requested.echoCancellation && settings.noiseSuppression === requested.noiseSuppression && settings.autoGainControl === requested.autoGainControl,
    allTrackStates: streams.flatMap((active) => active.getTracks()).map((active) => active.readyState),
  };
}

/** @param {string} inputDeviceId @returns {Promise<CaptureReport>} */
export async function run(inputDeviceId) {
  const supported = navigator.mediaDevices.getSupportedConstraints();
  if (!supported.echoCancellation || !supported.noiseSuppression || !supported.autoGainControl) throw new Error('Required audio processing constraints are not supported');
  /** @type {MediaStream[]} */
  const streams = [];
  /** @type {Observation[]} */
  const observations = [];
  /** @type {CaptureFailure|null} */
  let failure = null;
  let stage = 'initial';
  /** @type {{deviceId:string,groupId:string,label:string}[]} */
  let devices = [];
  /** @type {ReadonlyArray<Readonly<{label:string,processing:Processing}>>} */
  const cases = [
    { label: 'all-on', processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } },
    { label: 'all-off', processing: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } },
    { label: 'mixed', processing: { echoCancellation: false, noiseSuppression: true, autoGainControl: false } },
  ];
  try {
    for (const entry of cases) {
      stage = 'overlapping-' + entry.label;
      const previousLive = streams.flatMap((stream) => stream.getTracks()).filter((track) => track.readyState === 'live').length;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: exactConstraints(entry.processing, inputDeviceId), video: false });
      streams.push(stream);
      observations.push(observe('overlapping-' + entry.label, entry.processing, previousLive, stream, streams));
      if (devices.length === 0) devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput').map((device) => ({ deviceId: device.deviceId, groupId: device.groupId, label: device.label }));
      for (const previous of streams.slice(0, -1)) for (const track of previous.getTracks()) track.stop();
    }
    for (const stream of streams) for (const track of stream.getTracks()) track.stop();
    for (const entry of cases) {
      stage = 'exclusive-' + entry.label;
      const previousLive = streams.flatMap((stream) => stream.getTracks()).filter((track) => track.readyState === 'live').length;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: exactConstraints(entry.processing, inputDeviceId), video: false });
      streams.push(stream);
      const track = audioTrack(stream);
      observations.push(observe('exclusive-' + entry.label, entry.processing, previousLive, stream, streams));
      for (const captured of stream.getTracks()) captured.stop();
    }
  } catch (error) {
    if (!(error instanceof Error) && !(error instanceof DOMException)) throw new TypeError('Capture failed with a non-error value');
    failure = { name: error.name, message: error.message, stage, constraint: 'constraint' in error && typeof error.constraint === 'string' ? error.constraint : null };
  } finally {
    for (const stream of streams) for (const track of stream.getTracks()) track.stop();
  }
  return { supported, observations, stopped: streams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended')), failure, devices };
}

/** @type {Window & {audioCaptureProbe?:{run:typeof run}}} */
const hostWindow = window;
hostWindow.audioCaptureProbe = { run };

/** @typedef {{name:string,passed:boolean}} Check */
/** @typedef {{checks:Check[],destinationTrackIds:string[],installedTrackIds:string[],stopped:boolean,failure:CaptureFailure|null,failureState:{info:ReturnType<MicrophoneCapture['info']>,streamReady:string[]}|null}} ConnectorReport */

/** @param {Promise<void>} task @returns {Promise<string>} */
async function outcome(task) {
  try { await task; return 'fulfilled'; }
  catch (error) {
    if (error instanceof Error || error instanceof DOMException) return error.name;
    throw new TypeError('Unexpected non-error capture rejection');
  }
}

/** @param {string} inputDeviceId @returns {Promise<ConnectorReport>} */
export async function connectorRun(inputDeviceId) {
  const context = new AudioContext({ latencyHint: 'interactive' });
  /** @type {{current:MicrophoneGraph|null}} */
  const graph = { current: null };
  /** @type {MediaStreamTrack[]} */
  const installed = [];
  /** @type {string[]} */
  const destinationTrackIds = [];
  const capture = new MicrophoneCapture((stream) => {
    if (graph.current) graph.current.replaceSource(stream);
    else graph.current = new MicrophoneGraph(context, stream, 1, 0);
    installed.push(audioTrack(stream));
    destinationTrackIds.push(audioTrack(graph.current.dest.stream).id);
  });
  /** @type {import('../public/js/microphone-capture.js').CapturePreferences} */
  const on = { inputDeviceId, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const off = { ...on, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  const mixed = { ...off, noiseSuppression: true };
  /** @type {Check[]} */
  const checks = [];
  /** @type {CaptureFailure|null} */
  let failure = null;
  /** @type {ConnectorReport['failureState']} */
  let failureState = null;
  let stage = 'context-resume';
  try {
    await context.resume();
    stage = 'sequential-processing';
    await capture.open(on);
    await capture.open(off);
    checks.push({ name: stage, passed: capture.info().actual?.echoCancellation === false && capture.info().actual?.noiseSuppression === false && capture.info().actual?.autoGainControl === false && installed[0].readyState === 'ended' });
    stage = 'rapid-latest-wins';
    await Promise.all([capture.open(off), capture.open(on), capture.open(mixed)]);
    checks.push({ name: stage, passed: capture.info().actual?.echoCancellation === false && capture.info().actual?.noiseSuppression === true && capture.info().actual?.autoGainControl === false && !capture.info().pending });
    const liveBeforeFailure = capture.stream;
    stage = 'invalid-device-preserves-live-stream';
    const deviceFailure = await outcome(capture.open({ ...mixed, inputDeviceId: 'deepscord-nonexistent-physical-input' }));
    checks.push({ name: stage, passed: (deviceFailure === 'OverconstrainedError' || deviceFailure === 'NotFoundError') && capture.stream === liveBeforeFailure && capture.stream?.active === true && capture.info().error !== null });
    stage = 'success-clears-error';
    await capture.open(on);
    checks.push({ name: stage, passed: capture.info().error === null && capture.info().actual?.echoCancellation === true });
    stage = 'enhancement-with-invalid-device-stops-input';
    const enhancementFailure = await outcome(capture.open({ ...off, inputDeviceId: 'deepscord-nonexistent-physical-input' }));
    checks.push({ name: stage, passed: (enhancementFailure === 'OverconstrainedError' || enhancementFailure === 'NotFoundError') && capture.stream === null && capture.info().actual === null && capture.info().error !== null });
    stage = 'recover-after-explicit-input-stop';
    await capture.open(on);
    checks.push({ name: stage, passed: capture.info().actual?.echoCancellation === true && capture.info().error === null && capture.stream?.active === true });
    checks.push({ name: 'graph-output-track-stable-across-replacements', passed: destinationTrackIds.length >= 3 && new Set(destinationTrackIds).size === 1 });
    capture.stop();
    if (graph.current) { graph.current.dispose(); graph.current = null; }
    stage = 'immediate-stop-cancels-install';
    const installations = installed.length;
    const canceled = outcome(capture.open(off));
    capture.stop();
    checks.push({ name: stage, passed: await canceled === 'AbortError' && installed.length === installations && capture.stream === null && !capture.info().pending });
    stage = 'new-generation-survives-old-cancel';
    const old = outcome(capture.open(on));
    capture.stop();
    const replacement = capture.open(mixed);
    const [oldOutcome] = await Promise.all([old, replacement]);
    checks.push({ name: stage, passed: oldOutcome === 'AbortError' && capture.info().actual?.noiseSuppression === true && capture.info().actual?.echoCancellation === false && capture.stream?.active === true && !capture.info().pending });
  } catch (error) {
    if (!(error instanceof Error) && !(error instanceof DOMException)) throw new TypeError('Connector failed with a non-error value');
    failure = { name: error.name, message: error.message, stage, constraint: 'constraint' in error && typeof error.constraint === 'string' ? error.constraint : null };
    failureState = { info: capture.info(), streamReady: capture.stream?.getTracks().map((track) => track.readyState) ?? [] };
  } finally {
    capture.stop();
    if (graph.current) graph.current.dispose();
    await context.close();
  }
  return { checks, destinationTrackIds, installedTrackIds: installed.map((track) => track.id), stopped: installed.every((track) => track.readyState === 'ended') && capture.stream === null, failure, failureState };
}

/** @type {Window & {audioCaptureConnector?:{run:typeof connectorRun}}} */
const connectorWindow = window;
connectorWindow.audioCaptureConnector = { run: connectorRun };

/** @typedef {{observations:Observation[],stableTrackId:boolean,stopped:boolean,failure:CaptureFailure|null}} ApplyReport */
/** @param {string} inputDeviceId @returns {Promise<ApplyReport>} */
export async function applyRun(inputDeviceId) {
  /** @type {Processing[]} */
  const cases = [
    { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    { echoCancellation: false, noiseSuppression: true, autoGainControl: false },
    { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  ];
  const stream = await navigator.mediaDevices.getUserMedia({ audio: exactConstraints(cases[0], inputDeviceId), video: false });
  const track = audioTrack(stream);
  const initialId = track.id;
  /** @type {Observation[]} */
  const observations = [];
  /** @type {CaptureFailure|null} */
  let failure = null;
  let stage = 'initial';
  try {
    for (const [index, requested] of cases.entries()) {
      stage = 'applyConstraints-' + index;
      await track.applyConstraints(exactConstraints(requested, inputDeviceId));
      observations.push(observe(stage, requested, 1, stream, [stream]));
    }
  } catch (error) {
    if (!(error instanceof Error) && !(error instanceof DOMException)) throw new TypeError('Constraint application failed with a non-error value');
    failure = { name: error.name, message: error.message, stage, constraint: 'constraint' in error && typeof error.constraint === 'string' ? error.constraint : null };
  } finally { for (const captured of stream.getTracks()) captured.stop(); }
  return { observations, stableTrackId: initialId === track.id, stopped: track.readyState === 'ended', failure };
}

/** @type {Window & {audioCaptureApply?:{run:typeof applyRun}}} */
const applyWindow = window;
applyWindow.audioCaptureApply = { run: applyRun };

/** @typedef {{observations:Observation[],destinationTrackIds:string[],stopped:boolean,failure:CaptureFailure|null}} ExclusiveGraphReport */
/** @param {string} inputDeviceId @returns {Promise<ExclusiveGraphReport>} */
export async function exclusiveGraphRun(inputDeviceId) {
  const context = new AudioContext({ latencyHint: 'interactive' });
  /** @type {{current:MicrophoneGraph|null}} */
  const graph = { current: null };
  /** @type {MediaStream[]} */
  const streams = [];
  /** @type {Observation[]} */
  const observations = [];
  /** @type {string[]} */
  const destinationTrackIds = [];
  /** @type {CaptureFailure|null} */
  let failure = null;
  /** @type {Processing[]} */
  const cases = [
    { echoCancellation: false, noiseSuppression: true, autoGainControl: false },
    { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    { echoCancellation: false, noiseSuppression: true, autoGainControl: false },
    { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  ];
  let stage = 'initial';
  try {
    await context.resume();
    for (const [index, requested] of cases.entries()) {
      stage = 'stop-input-before-gum-' + index;
      for (const stream of streams) for (const track of stream.getTracks()) track.stop();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...exactConstraints(requested, inputDeviceId), channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 } }, video: false });
      streams.push(stream);
      if (graph.current) graph.current.replaceSource(stream);
      else graph.current = new MicrophoneGraph(context, stream, 1, 0);
      destinationTrackIds.push(audioTrack(graph.current.dest.stream).id);
      observations.push(observe(stage, requested, 0, stream, streams));
    }
  } catch (error) {
    if (!(error instanceof Error) && !(error instanceof DOMException)) throw new TypeError('Exclusive graph capture failed with a non-error value');
    failure = { name: error.name, message: error.message, stage, constraint: 'constraint' in error && typeof error.constraint === 'string' ? error.constraint : null };
  } finally {
    for (const stream of streams) for (const track of stream.getTracks()) track.stop();
    if (graph.current) graph.current.dispose();
    await context.close();
  }
  return { observations, destinationTrackIds, stopped: streams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended')), failure };
}

/** @type {Window & {audioCaptureExclusiveGraph?:{run:typeof exclusiveGraphRun}}} */
const exclusiveGraphWindow = window;
exclusiveGraphWindow.audioCaptureExclusiveGraph = { run: exclusiveGraphRun };

/** @typedef {{amplitude:number,gain:number,expectedRms:number,actualRms:number,passed:boolean}} SignalMeasurement */
/** @typedef {{measurements:SignalMeasurement[],gateSilenceRms:number,stableDestination:boolean,stopped:boolean}} SignalReport */
/** @param {AnalyserNode} analyser @returns {number} */
function rms(analyser) {
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
}
/** @param {number} milliseconds @returns {Promise<void>} */
function renderAudio(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

/** @returns {Promise<SignalReport>} */
export async function signalRun() {
  const context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  const oscillator = new OscillatorNode(context, { frequency: 1000 });
  const amplitude = new GainNode(context, { gain: 0 });
  const input = context.createMediaStreamDestination();
  const replacementInput = context.createMediaStreamDestination();
  oscillator.connect(amplitude);
  amplitude.connect(input);
  amplitude.connect(replacementInput);
  const graph = new MicrophoneGraph(context, input.stream, 1, 0);
  const outputId = audioTrack(graph.dest.stream).id;
  const output = context.createMediaStreamSource(graph.dest.stream);
  const analyser = new AnalyserNode(context, { fftSize: 4096, smoothingTimeConstant: 0 });
  const silence = new GainNode(context, { gain: 0 });
  output.connect(analyser).connect(silence).connect(context.destination);
  /** @type {SignalMeasurement[]} */
  const measurements = [];
  let gateSilenceRms = Number.NaN;
  let stableDestination = false;
  try {
    await context.resume();
    oscillator.start();
    graph.gate.gain.value = 1;
    for (const level of [0.04, 0.2]) {
      amplitude.gain.value = level;
      for (const gain of [1, 1.5]) {
        graph.gain.gain.value = gain;
        await renderAudio(180);
        const actualRms = rms(analyser);
        const expectedRms = level * gain / Math.sqrt(2);
        measurements.push({ amplitude: level, gain, actualRms, expectedRms, passed: Math.abs(actualRms / expectedRms - 1) < 0.01 });
      }
    }
    graph.replaceSource(replacementInput.stream);
    stableDestination = outputId === audioTrack(graph.dest.stream).id;
    graph.gate.gain.value = 0;
    await renderAudio(180);
    gateSilenceRms = rms(analyser);
  } finally {
    oscillator.stop();
    for (const node of [oscillator, amplitude, input, replacementInput, output, analyser, silence]) node.disconnect();
    graph.dispose();
    for (const stream of [input.stream, replacementInput.stream]) for (const track of stream.getTracks()) track.stop();
    await context.close();
  }
  return { measurements, gateSilenceRms, stableDestination, stopped: [...input.stream.getTracks(), ...replacementInput.stream.getTracks(), ...graph.dest.stream.getTracks()].every((track) => track.readyState === 'ended') };
}

/** @type {Window & {audioCaptureSignal?:{run:typeof signalRun}}} */
const signalWindow = window;
signalWindow.audioCaptureSignal = { run: signalRun };
