// @ts-check
import { captureScreen, listScreenSources } from '../public/js/desktop-capture.js';
import { ScreenLink } from '../public/js/screen-link.js';
import { screenCaptureTarget, screenEncodingPolicy } from '../public/js/screen-preferences.js';
import { collectScreenDiagnostics } from '../public/js/screen-diagnostics.js';

/** @typedef {import('../public/js/screen-preferences.js').ScreenPreferences} Preferences */
/** @typedef {{type:string,kind?:string,bytesReceived?:number,framesDecoded?:number,frameWidth?:number,frameHeight?:number,framesPerSecond?:number,bytesSent?:number,framesEncoded?:number,targetBitrate?:number}} RtpStats */
/** @param {boolean} condition @param {string} message @returns {asserts condition} */
function check(condition, message) { if (!condition) throw new Error(message); }
/** @param {number} milliseconds @returns {Promise<void>} */
function pause(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
/** @param {RTCPeerConnection} pc @param {string} type @returns {Promise<RtpStats[]>} */
async function videoStats(pc, type) {
  const report = await pc.getStats();
  /** @type {RtpStats[]} */ const rows = [];
  report.forEach(/** @param {RtpStats} row */ row => { if (row.type === type && row.kind === 'video') rows.push(row); });
  return rows;
}

/** Enumerate before the separate capture gesture, matching the production source picker.
 * @param {string} windowId @returns {Promise<string>} */
async function selectScreenMediaWindow(windowId) {
  const sources = await listScreenSources();
  const selected = sources.find(item => item.kind === 'window' && item.id.split(':')[1] === windowId);
  check(selected !== undefined, 'Controlled capture window was not enumerated: expected=' + windowId + '; candidates=' + JSON.stringify(sources.map(item => ({ id: item.id, kind: item.kind }))));
  return selected.id;
}

/** Exercise real capture and the production VP8 sender without replacing media APIs.
 * @param {'window'|'canvas'} source @param {Preferences} preferences @param {string|null} sourceId @returns {Promise<object>} */
async function runScreenMediaCase(source, preferences, sourceId) {
  const target = screenCaptureTarget(preferences);
  /** @type {MediaStream} */ let stream;
  /** @type {ReturnType<typeof setInterval>|null} */ let timer = null;
  if (source === 'window') {
    check(sourceId !== null, 'Window capture requires the explicitly selected native source ID');
    stream = await captureScreen(sourceId, preferences);
  } else {
    const canvas = document.createElement('canvas'); canvas.width = target.width; canvas.height = target.height;
    const context = canvas.getContext('2d'); check(context !== null, 'Canvas context unavailable');
    let tick = 0;
    const paint = () => { context.fillStyle = tick++ % 2 ? '#dd4411' : '#1166cc'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = '#f9f9ee'; context.fillRect((tick * 37) % canvas.width, 0, 60, canvas.height); };
    paint(); timer = setInterval(paint, 1000 / target.frameRate);
    stream = canvas.captureStream(target.frameRate);
  }
  const track = stream.getVideoTracks()[0]; check(track !== undefined, 'Capture returned no video track');
  const capture = track.getSettings();
  check(typeof capture.width === 'number' && capture.width > 0 && capture.width <= target.width, 'Capture width exceeded requested maximum');
  check(typeof capture.height === 'number' && capture.height > 0 && capture.height <= target.height, 'Capture height exceeded requested maximum');
  check(typeof capture.frameRate === 'number' && capture.frameRate > 0 && capture.frameRate <= target.frameRate + 0.01, 'Capture frame rate exceeded requested maximum');
  const video = document.createElement('video'); video.muted = true; video.autoplay = true; document.body.append(video);
  /** @type {string[]} */ const errors = [];
  /** @type {Promise<void>[]} */ const ice = [];
  const network = { iceServers: [], iceTransportPolicy: /** @type {const} */ ('all') };
  const sender = new ScreenLink({ network, onStream: () => {}, onFault: error => errors.push(error.message), onIce: candidate => { const pending = receiver.addIce(candidate); ice.push(pending); pending.catch(error => errors.push(String(error))); } });
  const receiver = new ScreenLink({ network, onStream: received => { video.srcObject = received; video.play().catch(error => errors.push(String(error))); }, onFault: error => errors.push(error.message), onIce: candidate => { const pending = sender.addIce(candidate); ice.push(pending); pending.catch(error => errors.push(String(error))); } });
  try {
    const offer = await sender.sendOffer(stream, preferences.screenBitrateMbps * 1000000, target.frameRate, preferences.screenContentMode);
    const answering = receiver.answer(offer); sender.releaseIce();
    const answer = await answering; const accepting = sender.acceptAnswer(answer); receiver.releaseIce();
    await accepting; await Promise.all(ice);
    const deadline = performance.now() + 12000;
    let inbound = await videoStats(receiver.pc, 'inbound-rtp');
    while (!(inbound[0]?.framesDecoded && inbound[0].framesDecoded >= 3) && performance.now() < deadline) { await pause(100); inbound = await videoStats(receiver.pc, 'inbound-rtp'); }
    check((inbound[0]?.framesDecoded ?? 0) >= 3, 'Actual remote video never decoded');
    const first = inbound[0]; const firstTime = video.currentTime;
    const encoding = sender.pc.getSenders().find(item => item.track?.kind === 'video'); check(encoding !== undefined, 'Missing actual video sender');
    const before = encoding.getParameters();
    const policy = screenEncodingPolicy(preferences.screenContentMode);
    check(track.contentHint === policy.contentHint && before.degradationPreference === policy.degradationPreference, 'Capture and sender content policies differ from the selected mode');
    check(before.encodings[0].maxBitrate === preferences.screenBitrateMbps * 1000000 && before.encodings[0].maxFramerate === target.frameRate, 'Encoder did not retain explicit bitrate/FPS limits');
    await pause(1600);
    const last = (await videoStats(receiver.pc, 'inbound-rtp'))[0];
    check((last?.framesDecoded ?? 0) > (first.framesDecoded ?? 0) && (last?.bytesReceived ?? 0) > (first.bytesReceived ?? 0), 'Actual decoded frames/received bytes did not advance');
    check(video.currentTime > firstTime && video.videoWidth > 0 && video.videoWidth <= target.width && video.videoHeight <= target.height, 'Actual remote playback did not advance within capture bounds');
    check((last.framesPerSecond ?? 0) <= target.frameRate + 2, 'Measured decode rate exceeded the configured upper bound');
    await encoding.setParameters({ ...before, encodings: before.encodings.map(item => ({ ...item, maxBitrate: 500000 })) });
    const after = encoding.getParameters(); check(after.encodings[0].maxBitrate === 500000 && after.encodings[0].maxFramerate === target.frameRate, 'Live bitrate update changed the active frame rate');
    check(after.degradationPreference === policy.degradationPreference, 'Live bitrate update changed the active content policy');
    check(errors.length === 0, JSON.stringify(errors));
    return { source, preferences, target, capture, contentHint: track.contentHint, degradationPreference: before.degradationPreference, encoding: before.encodings, bitrateUpdate: after.encodings, first, last, outbound: await videoStats(sender.pc, 'outbound-rtp'), playback: { currentTime: video.currentTime, width: video.videoWidth, height: video.videoHeight }, errors };
  } finally {
    sender.close(); receiver.close(); for (const item of stream.getTracks()) item.stop();
    if (timer !== null) clearInterval(timer); video.srcObject = null; video.remove();
    check(track.readyState === 'ended', 'Capture track was not released');
  }
}
Object.assign(window, { runScreenMediaCase, selectScreenMediaWindow });

/** Compare a real moving window before and during production encoding.
 * @param {Preferences} preferences @param {string} sourceId @returns {Promise<object>} */
async function runScreenCadenceCase(preferences, sourceId) {
  const stream = await captureScreen(sourceId, preferences);
  /** @type {string[]} */ const errors = [];
  /** @type {Promise<void>[]} */ const ice = [];
  const network = { iceServers: [], iceTransportPolicy: /** @type {const} */ ('all') };
  const sender = new ScreenLink({ network, onStream: () => {}, onFault: error => errors.push(error.message), onIce: candidate => { const pending = receiver.addIce(candidate); ice.push(pending); pending.catch(error => errors.push(String(error))); } });
  const receiver = new ScreenLink({ network, onStream: () => {}, onFault: error => errors.push(error.message), onIce: candidate => { const pending = sender.addIce(candidate); ice.push(pending); pending.catch(error => errors.push(String(error))); } });
  try {
    await pause(1000);
    const beforeWatching = await collectScreenDiagnostics({ capture: stream, preferences, previews: [], getReports: async () => ({ reports: [], unsupported: 0 }) });
    const offer = await sender.sendOffer(stream, preferences.screenBitrateMbps * 1000000, preferences.screenFrameRate, preferences.screenContentMode);
    const answering = receiver.answer(offer); sender.releaseIce();
    const answer = await answering; const accepting = sender.acceptAnswer(answer); receiver.releaseIce();
    await accepting; await Promise.all(ice);
    await pause(2000);
    const whileWatching = await collectScreenDiagnostics({ capture: stream, preferences, previews: [], getReports: async () => ({ reports: await Promise.all([sender.pc.getStats(), receiver.pc.getStats()]), unsupported: 0 }) });
    check(errors.length === 0, 'Real capture cadence errors: ' + JSON.stringify(errors));
    check((await videoStats(receiver.pc, 'inbound-rtp'))[0]?.framesDecoded !== undefined, 'Real capture cadence never decoded');
    return { preferences, beforeWatching, whileWatching };
  } finally { sender.close(); receiver.close(); stream.getTracks().forEach(track => track.stop()); }
}
Object.assign(window, { runScreenCadenceCase });
