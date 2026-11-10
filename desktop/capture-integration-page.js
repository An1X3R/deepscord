// @ts-check
import { ProcessAudioCapture, captureScreen, listScreenSources, listAudioProcesses } from '../public/js/desktop-capture.js';
import { DEFAULT_SCREEN_PREFERENCES } from '../public/js/screen-preferences.js';

/** @typedef {{amplitude431:number,amplitude997:number,sampleRate:number,channels:number,frames:number}} Measurement */
/** @type {{errors:string[],ended:number,measurements:Measurement[],tracks:MediaStreamTrack[],videoFrames:number,videoWidth:number,videoHeight:number,videoPixel:number[]}} */
const state = { errors:[],ended:0,measurements:[],tracks:[],videoFrames:0,videoWidth:0,videoHeight:0,videoPixel:[] };
const capture = new ProcessAudioCapture((error) => state.errors.push(error.message), () => { state.ended += 1; });
/** @type {AudioContext|null} */ let consumer = null;
/** @type {MediaStream|null} */ let videoStream = null;
/** @type {HTMLCanvasElement|null} */ const pattern = document.querySelector('#pattern');
if (!pattern) throw new Error('Missing controlled capture pattern');
const painter = pattern.getContext('2d');
if (!painter) throw new Error('Missing pattern canvas context');
let tick = 0;
setInterval(() => {
  painter.fillStyle = '#2459d8'; painter.fillRect(0, 0, 640, 360);
  painter.fillStyle = '#ffdd35'; painter.fillRect((tick++ * 8) % 520, 120, 120, 120);
}, 80);

/** @param {number} pid @returns {Promise<{tracks:{kind:string,readyState:MediaStreamTrackState}[],sampleRate:number}>} */
async function startAudio(pid) {
  state.measurements = [];
  const stream = await capture.start(pid);
  state.tracks = stream.getTracks();
  consumer = new AudioContext({ sampleRate:48000,latencyHint:'interactive' });
  await consumer.audioWorklet.addModule('/analysis.js');
  await consumer.resume();
  const source = consumer.createMediaStreamSource(stream);
  const analyzer = new AudioWorkletNode(consumer, 'capture-analysis', { numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2] });
  analyzer.port.onmessage = (event) => { state.measurements.push(/** @type {Measurement} */ (event.data)); };
  const silent = consumer.createGain(); silent.gain.value = 0;
  source.connect(analyzer).connect(silent).connect(consumer.destination);
  return { tracks:state.tracks.map((track) => ({ kind:track.kind,readyState:track.readyState })),sampleRate:consumer.sampleRate };
}
/** @returns {Promise<string[]>} */
async function stopAudio() {
  await capture.stop();
  if (consumer) { await consumer.close(); consumer = null; }
  return state.tracks.map((track) => track.readyState);
}
/** @param {string} id @returns {Promise<void>} */
async function startVideo(id) {
  videoStream = await captureScreen(id, DEFAULT_SCREEN_PREFERENCES);
  /** @type {HTMLVideoElement|null} */ const video = document.querySelector('#video');
  if (!video) throw new Error('Missing video consumer');
  video.srcObject = videoStream;
  await video.play();
  /** @param {DOMHighResTimeStamp} _time @param {VideoFrameCallbackMetadata} metadata @returns {void} */
  function frame(_time, metadata) {
    if (!video || !videoStream) return;
    state.videoFrames += 1;
    state.videoWidth = metadata.width;
    state.videoHeight = metadata.height;
    const snapshot = document.createElement('canvas'); snapshot.width = metadata.width; snapshot.height = metadata.height;
    const context = snapshot.getContext('2d');
    if (!context) throw new Error('Missing video sample context');
    context.drawImage(video, 0, 0);
    state.videoPixel = [...context.getImageData(Math.floor(metadata.width / 2), Math.floor(metadata.height / 2), 1, 1).data];
    video.requestVideoFrameCallback(frame);
  }
  video.requestVideoFrameCallback(frame);
}
/** @returns {string[]} */
function stopVideo() {
  const tracks = videoStream?.getTracks() || [];
  for (const track of tracks) track.stop();
  videoStream = null;
  return tracks.map((track) => track.readyState);
}
/** @returns {object} */
function status() { return { ...state,tracks:state.tracks.map((track) => ({ kind:track.kind,readyState:track.readyState })) }; }
Object.assign(window, { captureProbe:{ startAudio,stopAudio,startVideo,stopVideo,status,listScreenSources,listAudioProcesses } });
