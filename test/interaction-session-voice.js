// @ts-check
import { VoiceEngine } from '../public/js/voice.js';
import { DEFAULT_SCREEN_PREFERENCES } from '../public/js/screen-preferences.js';

/** @typedef {import('../public/js/voice.js').VoiceEvent} VoiceEvent */
/** @typedef {import('../public/js/interaction-protocol.js').InteractionEvent} InteractionEvent */
/** @param {boolean} condition @param {string} message @returns {asserts condition} */
function assert(condition, message) { if (!condition) throw new Error(message); }
/** @param {number} milliseconds @returns {Promise<void>} */
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

/** @returns {Promise<{checks:string[],errors:string[]}>} */
export async function runVoice() {
  /** @type {string[]} */ const checks = [];
  /** @type {string[]} */ const errors = [];
  /** @type {Map<string,VoiceEngine>} */ const engines = new Map();
  /** @type {Map<string,VoiceEvent[]>} */ const events = new Map();
  /** @type {OscillatorNode[]} */ const oscillators = [];
  /** @type {MediaStreamTrack[]} */ const tracks = [];
  /** @type {import('../public/js/voice.js').VoiceSettings} */
  const settings = { inputDeviceId: 'default', echoCancellation: false, noiseSuppression: false, autoGainControl: false, micVolume: 100, outVolume: 0, mode: 'vad', vadThreshold: -60, monitor: false, outputDeviceId: 'default', screenPreferences: { ...DEFAULT_SCREEN_PREFERENCES } };
  /** @param {string} label @param {boolean} condition @returns {void} */
  function check(label, condition) { assert(condition, label); checks.push(label); }
  /** @param {string} label @param {()=>boolean} predicate @returns {Promise<void>} */
  async function until(label, predicate) {
    const deadline = performance.now() + 12000;
    while (performance.now() < deadline) {
      assert(errors.length === 0, `${label}: ${errors.join('; ')}`);
      if (predicate()) return;
      await delay(20);
    }
    throw new Error(`Voice interaction test timed out: ${label}`);
  }
  /** @param {string} id @returns {VoiceEngine} */
  function create(id) {
    events.set(id, []);
    const engine = new VoiceEngine({ selfId: id, getSettings: () => settings,
      config: { networkMode: 'direct', mediaPolicy: 'direct', iceTransportPolicy: 'all', iceServers: [], iceExpiresAt: null },
      sendSignal: (to, signal) => { const remote = engines.get(to); assert(!!remote, `Missing voice signal recipient ${to}`); void remote.handleSignal(id, signal).catch(error => errors.push(error instanceof Error ? error.message : String(error))); },
      onEvent: event => { events.get(id)?.push(event); if (event.type === 'error') errors.push(event.message); },
    });
    engines.set(id, engine); return engine;
  }
  /** Install a real generated audio source without opening a microphone. @param {VoiceEngine} engine @returns {Promise<void>} */
  async function source(engine) {
    if (!engine.ctx) engine.ctx = new AudioContext();
    await engine.ctx.resume();
    const oscillator = engine.ctx.createOscillator(); const output = engine.ctx.createMediaStreamDestination();
    oscillator.connect(output); oscillator.start(); oscillators.push(oscillator); tracks.push(...output.stream.getTracks());
    engine.capture.stream = output.stream; engine._buildChain(output.stream);
    assert(engine.micReady, 'Generated source must satisfy production join readiness');
  }
  /** @param {VoiceEngine} engine @returns {InteractionEvent[]} */
  function interactions(engine) {
    const history = events.get(engine.selfId); assert(!!history, 'Missing voice event history');
    return history.flatMap(event => event.type === 'interaction' ? [event.event] : []);
  }
  /** @param {VoiceEngine[]} points @returns {Promise<void>} */
  async function connect(points) {
    for (const point of points) for (const other of points) if (point !== other) point.connectPeer(other.selfId);
    await until('production advertisements enable all three participants', () => points.every(point => points.every(other => point === other || point.interactions.canThrow(other.selfId))));
  }
  try {
    const a = create('voice-actor'); const b = create('voice-target'); const c = create('voice-observer'); const all = [a, b, c];
    for (const point of all) { await source(point); point.join('voice-room'); }
    await connect(all);
    check('voice-production-join-publishes-interaction-capability', all.every(point => point.inVoice && point.interactions.advertisement()?.channelId === 'voice-room' && point.peers.size === 2));
    a.interactions.throwAt(b.selfId, 'bomb');
    await until('production callbacks deliver bomb to three participants', () => all.every(point => interactions(point).length === 1));
    const bomb = interactions(a)[0];
    check('voice-production-callbacks-emit-one-identical-bomb', all.every(point => interactions(point)[0].eventId === bomb.eventId && interactions(point)[0].soundIndex === bomb.soundIndex && interactions(point)[0].fromUserId === a.selfId && interactions(point)[0].toUserId === b.selfId));
    const oldSession = c.interactions.advertisement()?.sessionId; c.leave();
    await until('production-leave-removes-observer', () => a.peers.size === 1 && b.peers.size === 1);
    check('voice-leave-clears-interaction-session-and-member-effects', c.interactions.advertisement() === null && !c.micReady && events.get(a.selfId)?.some(event => event.type === 'interaction-clear' && event.memberId === c.selfId) === true && events.get(c.selfId)?.some(event => event.type === 'interaction-clear' && event.memberId === null) === true);
    a.interactions.throwAt(b.selfId, 'poop');
    await until('remaining-two-continue-after-leave', () => interactions(b).length === 2);
    check('voice-departed-observer-receives-no-events', interactions(c).length === 1);
    await source(c); c.join('voice-room'); await connect(all);
    check('voice-rejoin-creates-new-recipient-session', c.interactions.advertisement()?.sessionId !== oldSession);
    a.interactions.throwAt(b.selfId, 'poop');
    await until('rejoined-observer-receives-fresh-event', () => interactions(b).length === 3 && interactions(c).length === 2);
    check('voice-rejoined-observer-receives-once', interactions(c).at(-1)?.eventId === interactions(a).at(-1)?.eventId);
    const previous = a.interactions.advertisement()?.sessionId; a.join('different-room');
    check('voice-channel-switch-tears-down-old-peer-capabilities', a.peers.size === 0 && a.interactions.advertisement()?.channelId === 'different-room' && a.interactions.advertisement()?.sessionId !== previous && !a.interactions.canThrow(b.selfId));
    b.removePeer(a.selfId); c.removePeer(a.selfId); a.connectPeer(b.selfId); b.connectPeer(a.selfId);
    await until('different-channel-real-peer-transport-opens', () => a.peers.get(b.selfId)?.link.interactionControl.readyState === 'open' && b.peers.get(a.selfId)?.link.interactionControl.readyState === 'open');
    await delay(100);
    check('voice-live-transport-does-not-override-channel-membership', !a.interactions.canThrow(b.selfId) && !b.interactions.canThrow(a.selfId));
    for (const point of all) point.leave();
    check('voice-final-leave-clears-all-state-and-generated-tracks', all.every(point => !point.inVoice && point.peers.size === 0 && point.interactions.advertisement() === null) && tracks.every(track => track.readyState === 'ended'));
    check('voice-interaction-integration-emits-no-errors', errors.length === 0);
    return { checks, errors };
  } finally {
    for (const point of engines.values()) point.destroy();
    for (const oscillator of oscillators) { oscillator.stop(); oscillator.disconnect(); }
    for (const track of tracks) track.stop();
  }
}
