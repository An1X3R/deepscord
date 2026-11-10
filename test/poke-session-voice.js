// @ts-check
import { VoiceEngine } from '../public/js/voice.js';
import { ScreenRelay } from '../public/js/screen-relay.js';
import { DEFAULT_SCREEN_PREFERENCES } from '../public/js/screen-preferences.js';

/** @param {boolean} condition @param {string} message @returns {asserts condition} */
function assert(condition, message) { if (!condition) throw new Error(message); }
/** @param {number} milliseconds @returns {Promise<void>} */
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

/** @returns {Promise<{checks:string[],errors:string[]}>} */
export async function runVoice() {
  /** @type {string[]} */ const checks = [];
  /** @type {string[]} */ const errors = [];
  /** @type {Map<string,VoiceEngine>} */ const engines = new Map();
  /** @type {Map<string,import('../public/js/voice.js').VoiceEvent[]>} */ const events = new Map();
  /** @type {import('../public/js/voice.js').VoiceSettings} */
  const settings = { inputDeviceId: 'default', echoCancellation: false, noiseSuppression: false, autoGainControl: false, micVolume: 100, outVolume: 100, mode: 'vad', vadThreshold: -60, monitor: false, outputDeviceId: 'default', screenPreferences: { ...DEFAULT_SCREEN_PREFERENCES, screenBitrateMbps: 1, screenResolution: 480, screenFrameRate: 15 } };
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
  const context = canvas.getContext('2d'); assert(context !== null, 'Voice probe canvas unavailable');
  let position = 0;
  const drawing = setInterval(() => { context.fillStyle = '#15191b'; context.fillRect(0, 0, 640, 360); context.fillStyle = '#87d8ce'; context.fillRect((position++ * 12) % 600, 120, 40, 40); }, 60);
  const video = document.createElement('video'); video.autoplay = true; video.muted = true; video.dataset.testid = 'voice-poke-video'; document.body.append(video);
  /** @param {string} label @param {()=>boolean} predicate @returns {Promise<void>} */
  async function until(label, predicate) {
    const deadline = performance.now() + 12000;
    while (performance.now() < deadline) {
      assert(!errors.length, `${label}: ${errors.join('; ')}`);
      if (predicate()) return;
      await delay(25);
    }
    throw new Error(`VoiceEngine timed out: ${label}`);
  }
  /** @param {string} label @param {boolean} condition @returns {void} */
  function check(label, condition) { assert(condition, label); checks.push(label); }
  /** @param {string} id @returns {VoiceEngine} */
  function create(id) {
    const history = /** @type {import('../public/js/voice.js').VoiceEvent[]} */ ([]); events.set(id, history);
    const engine = new VoiceEngine({ selfId: id, getSettings: () => settings,
      config: { networkMode: 'direct', mediaPolicy: 'direct', iceTransportPolicy: 'all', iceServers: [], iceExpiresAt: null },
      sendSignal: (to, signal) => { const remote = engines.get(to); assert(!!remote, `Missing voice signal destination ${to}`); void remote.handleSignal(id, signal).catch(error => errors.push(error instanceof Error ? error.message : String(error))); },
      onEvent: event => {
        history.push(event); if (event.type === 'error') errors.push(event.message);
        if (id === 'vb' && event.type === 'media' && event.userId === 'va') video.srcObject = engine.getScreenStream('va');
      },
    });
    // Screen-only fixture entry: microphone capture and room authentication are outside this test.
    engine.channelId = 'poke-screen-only'; engine.screenTransport.join('poke-screen-only');
    engines.set(id, engine); return engine;
  }
  /** @param {VoiceEngine} owner @param {VoiceEngine} viewer @returns {Promise<void>} */
  async function connect(owner, viewer) {
    owner.connectPeer('vb'); viewer.connectPeer('va');
    await until('actual voice peer channels connected', () => [...owner.peers.values(), ...viewer.peers.values()].every(peer => peer.link.control.readyState === 'open' && peer.link.pokeControl.readyState === 'open'));
  }
  /** @param {VoiceEngine} owner @param {VoiceEngine} viewer @returns {Promise<void>} */
  async function grant(owner, viewer) {
    viewer.poke.request('va');
    await until('production voice callback forwards request', () => owner.poke.state().requests.length === 1);
    owner.poke.approve('vb', owner.poke.state().requests[0].requestId);
    await until('production voice callback forwards approval', () => viewer.poke.state().peers.some(peer => peer.userId === 'va' && peer.status === 'approved'));
  }
  try {
    const owner = create('va'); const viewer = create('vb'); await connect(owner, viewer);
    const first = canvas.captureStream(15); await owner.startScreenShare(first);
    await until('voice media advertises poke session', () => viewer.peers.get('va')?.screenSharing === true && viewer.poke.state().peers.some(peer => peer.userId === 'va' && !!peer.sessionId));
    await viewer.watchScreen('va');
    await until('real ScreenRelay video decoded', () => video.videoWidth === 640 && video.videoHeight === 360 && viewer.getScreenStream('va') !== null);
    check('voice-engine-uses-production-screen-relay-with-real-video', owner.screenTransport instanceof ScreenRelay && viewer.screenTransport instanceof ScreenRelay && viewer.screenTransport.edges.size > 0);
    await grant(owner, viewer); viewer.poke.hit('va', .25, .75, false);
    await until('voice poke event reaches origin and owner', () => ['va', 'vb'].every(id => events.get(id)?.some(event => event.type === 'poke-hit' && event.hit.fromUserId === 'vb' && event.hit.targetUserId === 'va') === true));
    check('voice-engine-emits-authoritative-poke-events', events.get('vb')?.filter(event => event.type === 'poke-hit').length === 1);
    viewer.stopWatching('va');
    await until('voice stopWatching revokes permission', () => owner.poke.state().authorized.length === 0 && viewer.poke.state().peers.some(peer => peer.userId === 'va' && peer.status === 'idle'));
    check('voice-stop-watching-clears-screen-and-permission', viewer.getScreenStream('va') === null && viewer.peers.get('va')?.watching === false);
    await owner.stopScreenShare();
    await until('voice stopScreenShare clears remote session', () => viewer.peers.get('va')?.screenSharing === false && viewer.poke.state().peers.some(peer => peer.userId === 'va' && peer.sessionId === null));
    check('voice-stop-share-stops-capture-and-session', first.getVideoTracks()[0].readyState === 'ended' && owner.poke.state().sessionId === null);
    const second = canvas.captureStream(15); await owner.startScreenShare(second);
    await until('replacement voice share advertised', () => viewer.peers.get('va')?.screenSharing === true && viewer.poke.state().peers.some(peer => peer.userId === 'va' && !!peer.sessionId));
    await viewer.watchScreen('va'); await grant(owner, viewer);
    owner.removePeer('vb');
    check('voice-remove-peer-revokes-local-authority', owner.poke.state().authorized.length === 0 && !owner.peers.has('vb'));
    viewer.removePeer('va'); await connect(owner, viewer);
    await until('reconnected voice peer learns active share', () => viewer.peers.get('va')?.screenSharing === true && viewer.poke.state().peers.some(peer => peer.userId === 'va' && !!peer.sessionId));
    await viewer.watchScreen('va'); await grant(owner, viewer);
    viewer.leave();
    await until('production leave control removes owner grant', () => owner.peers.size === 0 && owner.poke.state().authorized.length === 0);
    check('voice-viewer-leave-cleans-peer-and-grants', viewer.poke.state().peers.length === 0 && !viewer.inVoice && events.get('va')?.some(event => event.type === 'peer-left' && event.userId === 'vb') === true);
    owner.leave();
    check('voice-owner-leave-clears-capture-session-and-channel', owner.poke.state().sessionId === null && owner.screenStream === null && second.getVideoTracks()[0].readyState === 'ended' && !owner.inVoice);
    check('voice-poke-clear-callback-is-emitted', ['va', 'vb'].every(id => events.get(id)?.some(event => event.type === 'poke-clear') === true));
    check('voice-integration-emits-no-errors', errors.length === 0);
    return { checks, errors };
  } finally {
    for (const engine of engines.values()) engine.destroy();
    clearInterval(drawing); video.srcObject = null; video.remove();
  }
}
