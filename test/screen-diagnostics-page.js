// @ts-check
import { createMediaUI } from '../public/js/media-ui.js';
import { ScreenLink } from '../public/js/screen-link.js';
import { collectScreenDiagnostics, exportScreenDiagnostics, parseScreenDiagnosticReport } from '../public/js/screen-diagnostics.js';
import { DEFAULT_SCREEN_PREFERENCES } from '../public/js/screen-preferences.js';
/** @typedef {import('../public/js/network-protocol.js').JsonObject} JsonObject */
/** @typedef {import('../public/js/screen-diagnostics.js').DiagnosticOptions} DiagnosticOptions */
/** @param {boolean} condition @param {string} message @returns {asserts condition} */
function check(condition, message) { if (!condition) throw new Error(message); }
/** @param {number} ms @returns {Promise<void>} */
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
/** @param {()=>boolean} predicate @param {number} ms @param {string} label @returns {Promise<void>} */
async function until(predicate, ms, label) { const deadline = performance.now() + ms; while (!predicate()) { check(performance.now() < deadline, 'Diagnostic integration timed out: ' + label); await delay(25); } }
/** @param {(options:DiagnosticOptions)=>Promise<void>} complete @returns {Promise<JsonObject>} */
async function runDiagnostics(complete) {
  const canvas = document.getElementById('diagnosticCanvas'), cards = document.getElementById('cards'), controls = document.getElementById('controls');
  check(canvas instanceof HTMLCanvasElement && cards instanceof HTMLElement && controls instanceof HTMLElement, 'Stable diagnostic fixture nodes missing');
  const context = canvas.getContext('2d'); check(context !== null, 'Actual Canvas renderer missing');
  let frame = 0, exported = false;
  /** @type {MediaStream|null} */ let received = null;
  /** @type {string[]} */ const errors = [];
  /** @type {Promise<void>[]} */ const ice = [];
  const drawing = setInterval(() => { frame += 1; context.fillStyle = '#132536'; context.fillRect(0, 0, 1280, 720); context.fillStyle = '#fbd530'; context.fillRect(frame * 17 % 1100, 100, 150, 150); }, 33);
  const stream = canvas.captureStream(30), original = stream.getVideoTracks()[0];
  original.contentHint = 'motion';
  /** @type {MediaStreamTrack[]} */ const temporaryClones = [];
  const realClone = original.clone.bind(original);
  original.clone = () => { const clone = realClone(); temporaryClones.push(clone); return clone; };
  const receiver = new ScreenLink({ network: { iceServers: [], iceTransportPolicy: 'all' }, onStream: value => { received = value; }, onIce: candidate => { ice.push(sender.addIce(candidate)); }, onFault: error => errors.push(error.message) });
  const sender = new ScreenLink({ network: { iceServers: [], iceTransportPolicy: 'all' }, onStream: () => { throw new Error('Unexpected return video'); }, onIce: candidate => { ice.push(receiver.addIce(candidate)); }, onFault: error => errors.push(error.message) });
  /** @type {ReturnType<typeof createMediaUI>|null} */ let ui = null;
  try {
    const offer = await sender.sendOffer(stream, 1800000, 30, 'motion'); const answering = receiver.answer(offer); sender.releaseIce(); const answer = await answering; const accepting = sender.acceptAnswer(answer); receiver.releaseIce(); await accepting; await Promise.all(ice);
    ui = createMediaUI({ listScreens: async () => [], listProcesses: async () => [], startScreen: async () => { throw new Error('Source chooser is outside this diagnostic test'); }, stopScreen: async () => { original.stop(); }, startMusic: async () => { throw new Error('Music is outside this diagnostic test'); }, stopMusic: async () => { throw new Error('Music is outside this diagnostic test'); }, watch: async id => { check(id === 'local' || id === 'remote', 'Unexpected preview identity'); }, stopWatching: () => {}, getScreenStream: id => id === 'local' ? stream : received, setPeerVolume: () => {}, getPeerVolume: () => 100, reportError: error => errors.push(error.message), exportDiagnostics: async () => {
      check(ui !== null, 'Production media UI missing');
      await complete({ preferences: { ...DEFAULT_SCREEN_PREFERENCES }, capture: stream, previews: ui.diagnosticPreviews(), getReports: async () => ({ reports: await Promise.all([sender.pc.getStats(), receiver.pc.getStats()]), unsupported: 0 }) });
      exported = true;
    } });
    controls.append(ui.renderToolbar({ connected: true, screenActive: true, musicActive: false }));
    for (const id of ['local', 'remote']) { const card = document.createElement('div'); card.className = 'tile'; card.dataset.userId = id; cards.append(card); ui.decorateCard(card, { id, name: id, self: id === 'local', screenSharing: true }); const watch = card.querySelector('[data-testid="screen-watch"]'); check(watch instanceof HTMLButtonElement, 'Production watch control missing'); watch.click(); }
    ui.reconcile();
    await until(() => ui !== null && ui.diagnosticPreviews().length === 2, 6000, 'production watch controls attached actual streams');
    const previews = ui.diagnosticPreviews(); check(previews.length === 2, 'Both actual preview streams must be attached');
    await until(() => previews.every(item => item.video.getVideoPlaybackQuality().totalVideoFrames > 3), 6000, 'actual local and WebRTC video');
    const before = previews.map(item => item.video.getVideoPlaybackQuality().totalVideoFrames);
    const button = controls.querySelector('[data-testid="screen-diagnostics"]'); check(button instanceof HTMLButtonElement && button.getAttribute('aria-label') === '导出屏幕诊断', 'Stable production diagnostic button missing');
    button.click();
    await until(() => exported || errors.length > 0, 120000, 'real native Save As completion');
    check(errors.length === 0, 'Diagnostic export emitted errors: ' + JSON.stringify(errors));
    check(original.readyState === 'live', 'Diagnostic sampling stopped the original capture track');
    check(temporaryClones.length === 1 && temporaryClones.every(track => track.readyState === 'ended'), 'Diagnostic capture clone remained live after sampling');
    await delay(1000);
    const after = previews.map(item => item.video.getVideoPlaybackQuality().totalVideoFrames);
    check(after.every((value, index) => value > before[index]), 'Sharing or preview stopped after diagnostic export');
    check(!button.disabled && !button.hasAttribute('aria-busy'), 'Production diagnostic control did not return to ready');
    // Schema rejection uses a real malformed request; it must never open a save dialog.
    let rejected = false;
    try { parseScreenDiagnosticReport({ schemaVersion: 99 }); } catch (error) { check(error instanceof TypeError, 'Malformed diagnostic schema returned an unexpected error'); rejected = true; }
    check(rejected, 'Unsupported diagnostic schema was accepted');
    return { exported, before, after, originalTrackState: original.readyState, temporaryCloneStates: temporaryClones.map(track => track.readyState), buttonReady: !button.disabled, errors };
  } finally { ui?.destroy(); sender.close(); receiver.close(); stream.getTracks().forEach(track => track.stop()); clearInterval(drawing); }
}
/** @returns {Promise<JsonObject>} */
async function runNativeDiagnostics() {
  return runDiagnostics(async options => { const result = await exportScreenDiagnostics(options); check(result.status === 'saved', 'Real native diagnostic save was cancelled'); });
}
/** @returns {Promise<JsonObject>} */
async function runCollectedDiagnostics() {
  /** @type {JsonObject|null} */ let report = null;
  const result = await runDiagnostics(async options => { report = await collectScreenDiagnostics(options); });
  check(report !== null, 'Actual diagnostic collection produced no report');
  return { ...result, report };
}
const diagnosticWindow = /** @type {Window & {runDiagnostics?:()=>Promise<JsonObject>,runCollectedDiagnostics?:()=>Promise<JsonObject>}} */ (window);
diagnosticWindow.runDiagnostics = runNativeDiagnostics;
diagnosticWindow.runCollectedDiagnostics = runCollectedDiagnostics;
