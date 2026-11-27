// @ts-check
import { PeerLink } from '../public/js/peer-link.js';
import { createScreenPoke } from '../public/js/screen-poke.js';
import { createMediaUI } from '../public/js/media-ui.js';
import { getVideoContentRect } from '../public/js/poke-visual.js';
import { parsePeerControl } from '../public/js/network-protocol.js';
import { parsePokeMessage } from '../public/js/poke-protocol.js';

/** @typedef {import('../public/js/poke-protocol.js').PokeMessage} PokeMessage */
/** @typedef {import('../public/js/screen-poke.js').PokeHit} PokeHit */
/** @typedef {{id:string,poke:ReturnType<typeof createScreenPoke>,links:Map<string,PeerLink>,hits:PokeHit[],clears:string[],sent:{to:string,data:PokeMessage}[],received:{from:string,data:PokeMessage}[],ui:ReturnType<typeof createMediaUI>|null,streams:Map<string,MediaStream>,audio:{enabled:boolean,volume:number}}} Endpoint */

/** @param {number} milliseconds @returns {Promise<void>} */
function frame(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
/** @param {boolean} condition @param {string} label @returns {asserts condition} */
function assert(condition, label) { if (!condition) throw new Error(label); }
/** @param {HTMLElement} root @param {string} id @returns {HTMLButtonElement} */
function button(root, id) {
  const node = root.querySelector(`[data-testid="${id}"]`);
  assert(node instanceof HTMLButtonElement, `Missing button: ${id}`); return node;
}

/** @returns {Promise<{checks:string[],errors:string[]}>} */
export async function run() {
  /** @type {string[]} */ const checks = [];
  /** @type {string[]} */ const errors = [];
  /** @type {Map<string,Endpoint>} */ const endpoints = new Map();
  /** @type {PeerLink[]} */ const links = [];
  const candidate = document.getElementById('app'); assert(candidate instanceof HTMLElement, 'Missing #app'); const app = candidate;
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
  const context = canvas.getContext('2d'); assert(context !== null, 'Canvas rendering unavailable');
  let tick = 0;
  const draw = setInterval(() => { context.fillStyle = '#26383a'; context.fillRect(0, 0, 640, 360); context.fillStyle = '#87d8ce'; context.fillRect((tick++ * 7) % 600, 160, 30, 30); }, 40);
  const stream = canvas.captureStream(25);

  /** @param {Error} error @returns {void} */
  function fail(error) { errors.push(`${error.name}: ${error.message}`); }
  /** @param {string} label @param {()=>boolean} predicate @returns {Promise<void>} */
  async function until(label, predicate) {
    const deadline = performance.now() + 10000;
    while (performance.now() < deadline) {
      assert(errors.length === 0, `${label}: ${errors.join('; ')}`);
      if (predicate()) return;
      await frame(20);
    }
    throw new Error(`Timed out: ${label}`);
  }
  /** @param {string} label @param {boolean} condition @returns {void} */
  function check(label, condition) { assert(condition, label); checks.push(label); }
  /** @param {string} id @returns {Endpoint} */
  function endpoint(id) { const result = endpoints.get(id); assert(!!result, `Missing endpoint ${id}`); return result; }
  /** @param {string} id @returns {Endpoint} */
  function create(id) {
    const poke = createScreenPoke({ getSelfId: () => id,
      send: (to, data) => { const point = endpoint(id); point.sent.push({ to, data }); return point.links.get(to)?.sendControl({ type: 'poke', data }) === true; },
      onState: () => endpoints.get(id)?.ui?.reconcilePoke(),
      onHit: hit => { const point = endpoint(id); point.hits.push(hit); point.ui?.showPoke(hit); },
      onClear: target => { const point = endpoints.get(id); point?.clears.push(target); point?.ui?.clearPokes(target); }, onError: fail,
    });
    /** @type {Endpoint} */
    const point = { id, poke, links: new Map(), hits: [], clears: [], sent: [], received: [], ui: null, streams: new Map(), audio: { enabled: true, volume: 70 } };
    endpoints.set(id, point); return point;
  }
  /** @param {Endpoint} point @param {Endpoint} other @returns {PeerLink} */
  function link(point, other) {
    const connection = new PeerLink({ selfId: point.id, peerId: other.id,
      config: { networkMode: 'direct', mediaPolicy: 'direct', iceTransportPolicy: 'all', iceServers: [], iceExpiresAt: null }, track: null, stream: null,
      sendSignal: signal => { const remote = other.links.get(point.id); assert(!!remote, 'Initial signal arrived before pair construction'); void remote.receive(signal).catch(fail); },
      onTrack: (media, kind) => { if (kind === 'screen') { point.streams.set(other.id, media); point.ui?.reconcile(); } },
      onControl: message => {
        if (message.type === 'poke') { point.received.push({ from: other.id, data: message.data }); point.poke.receive(other.id, message.data); }
        if (message.type === 'media') point.poke.advertise(other.id, message.poke ?? null);
        if (message.type === 'watch' && point.id === 'a') void connection.setScreenTrack(message.watching ? stream.getVideoTracks()[0] : null).catch(fail);
      }, onReady: () => {}, onState: () => {}, onError: fail,
    });
    point.links.set(other.id, connection); links.push(connection); return connection;
  }
  /** @param {Endpoint} point @returns {ReturnType<typeof createMediaUI>} */
  function mediaUI(point) {
    const ui = createMediaUI({
      listScreens: async () => [{ id: 'canvas', name: '测试画面', kind: 'screen', thumbnail: '' }], listProcesses: async () => [],
      startScreen: async () => { point.poke.start(); }, stopScreen: async () => { point.poke.end(); },
      startMusic: async () => { throw new DOMException('No audio process in this browser test', 'NotSupportedError'); }, stopMusic: async () => {},
      watch: async id => { point.poke.watch(id); point.links.get(id)?.sendControl({ type: 'watch', watching: true }); },
      stopWatching: id => { point.poke.unwatch(id); point.links.get(id)?.sendControl({ type: 'watch', watching: false }); },
      getScreenStream: id => point.streams.get(id) ?? null, setPeerVolume: () => {}, getPeerVolume: () => 100, reportError: fail,
      poke: { getState: point.poke.state, request: point.poke.request,
        respond: (id, requestId, approved) => { if (approved) point.poke.approve(id, requestId); else point.poke.reject(id, requestId); },
        revoke: point.poke.revoke, revokeAll: point.poke.revokeAll, hit: point.poke.hit, getName: id => id.toUpperCase(),
        getFunnyGestures: () => point.poke.state().allowFunnyGestures, setFunnyGestures: point.poke.setFunnyGestures,
        getAudio: () => point.audio, setAudio: audio => { point.audio = audio; },
      },
    });
    point.ui = ui; app.append(ui.renderToolbar({ connected: true, screenActive: point.id === 'a', musicActive: false })); return ui;
  }
  /** @param {Endpoint} owner @returns {void} */
  function advertise(owner) { for (const connection of owner.links.values()) connection.sendControl({ type: 'media', screen: owner.poke.state().sessionId !== null, accompaniment: false, poke: owner.poke.advertisement() }); }
  /** @param {Endpoint} point @returns {string} */
  function status(point) { return point.poke.state().peers.find(peer => peer.userId === 'a')?.status ?? 'missing'; }
  /** @param {Endpoint} owner @param {string} id @returns {Promise<void>} */
  async function approve(owner, id) {
    await until(`request ${id} reaches owner`, () => owner.poke.state().requests.some(item => item.userId === id));
    const request = owner.poke.state().requests.find(item => item.userId === id); assert(!!request, `Missing request ${id}`);
    owner.poke.approve(id, request.requestId); await until(`grant ${id} reaches viewer`, () => status(endpoint(id)) === 'approved');
  }
  try {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) create(id);
    const a = endpoint('a'); const b = endpoint('b'); const c = endpoint('c'); const d = endpoint('d'); const e = endpoint('e'); const f = endpoint('f');
    for (const id of ['b', 'c', 'd', 'e', 'f']) { link(a, endpoint(id)); link(endpoint(id), a); }
    link(f, c); link(c, f);
    await until('all twelve real peer data channels open', () => links.every(item => item.control.readyState === 'open' && item.pokeControl.readyState === 'open'));
    check('unreliable-poke-channel-is-unordered-and-lifetime-bounded', links.every(item => !item.pokeControl.ordered && item.pokeControl.maxPacketLifeTime === 500));
    a.poke.start(); advertise(a);
    for (const viewer of [b, c, d, e, f]) viewer.links.get('a')?.sendControl({ type: 'media', screen: false, accompaniment: false, poke: viewer.poke.advertisement() });
    await until('capabilities cross real control channels', () => [b, c, d, e, f].every(point => point.poke.state().peers.some(peer => peer.userId === 'a' && peer.supported && !!peer.sessionId)) && a.poke.state().peers.length === 5);
    f.links.get('c')?.sendControl({ type: 'media', screen: false, accompaniment: false, poke: f.poke.advertisement() });
    await until('observer knows unrelated peer capability', () => c.poke.state().peers.some(peer => peer.userId === 'f' && peer.supported));
    const ownerUI = mediaUI(a); const viewerUI = mediaUI(b);
    const card = document.createElement('article'); card.dataset.testid = 'poke-member-card'; app.append(card);
    viewerUI.decorateCard(card, { id: 'a', name: 'A', self: false, screenSharing: true });
    button(card, 'screen-watch').click();
    for (const viewer of [c, d, e]) viewer.poke.watch('a');
    await until('actual screen RTP decodes into viewer video', () => { const video = card.querySelector('[data-testid="screen-video"]'); return video instanceof HTMLVideoElement && video.videoWidth === 640 && video.videoHeight === 360; });
    button(card, 'screen-expand').click();
    const shell = app.querySelector('[data-testid="member-screen"]'); assert(shell instanceof HTMLElement, 'Missing expanded shell');
    button(shell, 'poke-request').click();
    check('ui-request-enters-pending', status(b) === 'pending' && button(shell, 'poke-request').disabled);
    await until('owner sees interactive permission popup', () => document.querySelector('[data-testid="poke-request-toast"][data-user-id="b"]') !== null);
    const ownerToolbar = ownerUI.renderToolbar({ connected: true, screenActive: true, musicActive: false });
    const requestPopup = document.querySelector('[data-testid="poke-request-toast"][data-user-id="b"]'); assert(requestPopup instanceof HTMLElement, 'Missing request popup');
    const requestStack = requestPopup.parentElement; assert(requestStack instanceof HTMLElement && requestStack.parentElement === document.body, 'Popup must escape toolbar clipping');
    check('request-popup-identifies-requester', requestPopup.querySelector('.poke-request-name')?.textContent === 'B');
    check('request-popup-is-bottom-right-above-expanded-video', getComputedStyle(requestStack).position === 'fixed' && getComputedStyle(requestStack).right === '20px' && getComputedStyle(requestStack).bottom === '20px' && Number(getComputedStyle(requestStack).zIndex) > Number(getComputedStyle(shell).zIndex));
    const focused = document.activeElement; ownerUI.reconcilePoke();
    check('request-popup-keeps-current-focus', document.activeElement === focused);
    button(requestPopup, 'poke-approve').click(); await until('ui-grant-approved', () => status(b) === 'approved');
    check('answered-popup-is-removed', !requestPopup.isConnected);
    for (const viewer of [c, d]) { viewer.poke.request('a'); await approve(a, viewer.id); }
    e.poke.request('a'); await until('fourth viewer explicitly denied', () => status(e) === 'idle');
    check('maximum-three-authorized', a.poke.state().authorized.length === 3);
    let nonviewerRejected = false;
    try { f.poke.request('a'); } catch (error) { nonviewerRejected = error instanceof DOMException && error.name === 'InvalidStateError'; }
    const session = a.poke.state().sessionId; assert(session !== null, 'Missing live share session');
    const rejectedBefore = a.poke.stats().rejected;
    f.links.get('a')?.sendControl({ type: 'poke', data: { action: 'request', sessionId: session, requestId: crypto.randomUUID() } });
    await until('forged nonviewer request rejected', () => a.poke.stats().rejected > rejectedBefore);
    check('nonviewers-cannot-request-or-observe', nonviewerRejected && !a.poke.state().authorized.some(item => item.userId === 'f'));
    button(shell, 'poke-mode-toggle').click();
    const video = shell.querySelector('[data-testid="screen-video"]'); assert(video instanceof HTMLVideoElement, 'Expanded video missing');
    const rect = getVideoContentRect(video); assert(rect !== null, 'Decoded video content rect missing'); const box = video.getBoundingClientRect();
    const beforeBars = b.sent.filter(item => item.data.action === 'hit').length;
    const bar = rect.top > box.top + 1 ? { x: box.left + box.width / 2, y: box.top + 1 } : { x: box.left + 1, y: box.top + box.height / 2 };
    video.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: bar.x, clientY: bar.y }));
    check('letterbox-click-does-not-send', b.sent.filter(item => item.data.action === 'hit').length === beforeBars);
    video.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + rect.width * .5, clientY: rect.top + rect.height * .5 }));
    await until('authoritative first hit echoes to all actual watchers', () => [a, b, c, d, e].every(point => point.hits.length === 1));
    check('observer-retains-original-poker-identity', [a, b, c, d, e].every(point => point.hits[0].fromUserId === 'b' && point.hits[0].targetUserId === 'a') && f.hits.length === 0);
    check('ui-renders-once-after-authoritative-echo', shell.querySelectorAll('[data-testid="poke-finger"]').length === 1);
    check('ui-coordinate-normalization', Math.abs(a.hits[0].nx - .5) < .001 && Math.abs(a.hits[0].ny - .5) < .001);
    button(shell, 'screen-expand').click();
    check('collapse-clears-transient-marker-but-retains-grant', shell.querySelector('[data-testid="poke-finger"]') === null && status(b) === 'approved');
    button(shell, 'screen-expand').click();
    check('reexpansion-requires-explicit-poke-mode', button(shell, 'poke-mode-toggle').getAttribute('aria-pressed') === 'false');
    button(shell, 'poke-mode-toggle').click(); button(shell, 'poke-sound-toggle').click();
    const nextRect = getVideoContentRect(video); assert(nextRect !== null, 'Expanded content geometry missing');
    video.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: nextRect.left + nextRect.width * .5, clientY: nextRect.top + nextRect.height * .5 }));
    await until('muted sender click reaches owner', () => a.hits.length === 2);
    check('sender-boom-toggle-is-independent-of-receiver', !a.hits[1].boom && a.audio.enabled && b.audio.enabled);
    for (let index = 2; index <= 11; index += 1) { await frame(40); b.poke.hit('a', .5, .5, false); await until(`canonical combo ${index + 1}`, () => a.hits.length === index + 1); }
    await until('all watcher gesture echoes arrive', () => [b,c,d,e].every(point => point.hits.length === a.hits.length));
    check('host-selects-one-gesture-for-all-watchers', [b,c,d,e].every(point => point.hits.every((hit,index) => hit.gesture === a.hits[index].gesture)));
    check('cold-combos-always-use-point', a.hits.filter(hit => hit.combo < 5).every(hit => hit.gesture === 'point'));
    const gestureToggle = button(ownerToolbar, 'poke-funny-gestures'); gestureToggle.click();
    check('host-can-disable-funny-gestures', !a.poke.state().allowFunnyGestures && localStorage.getItem('deepscord.poke.funnyGestures') === 'false');
    gestureToggle.click();
    check('host-can-enable-funny-gestures', a.poke.state().allowFunnyGestures && localStorage.getItem('deepscord.poke.funnyGestures') === 'true');
    check('owner-computes-combo-and-caps-at-ten', a.hits.map(hit => hit.combo).join(',') === '1,2,3,4,5,6,7,8,9,10,10,10');
    const previousRate = a.poke.stats().rateLimited;
    for (let index = 0; index < 8; index += 1) b.poke.hit('a', .5, .5, false);
    await until('per-poker-flood-is-dropped', () => a.poke.stats().rateLimited > previousRate);
    check('rate-limit-keeps-real-channel-connected', links.every(item => item.pc.connectionState === 'connected'));
    const accepted = a.sent.filter(item => item.to === 'c' && item.data.action === 'event').at(-1); assert(!!accepted && accepted.data.action === 'event', 'Missing recorded relay event');
    const staleHit = b.sent.filter(item => item.data.action === 'hit').at(-1); assert(!!staleHit, 'Missing recorded viewer hit');
    a.poke.revoke('b'); await until('revoke reaches origin and observer', () => status(b) === 'idle' && shell.querySelector('[data-testid="poke-finger"]') === null);
    check('revoke-clears-ui-markers-immediately', button(shell, 'poke-mode-toggle').hidden === true);
    const unrelatedSession = f.poke.start();
    f.links.get('c')?.sendControl({ type: 'media', screen: true, accompaniment: false, poke: f.poke.advertisement() });
    await until('unrelated peer changes its advertisement', () => c.poke.state().peers.some(peer => peer.userId === 'f' && peer.sessionId === unrelatedSession));
    const cCount = c.hits.length; const cRejected = c.poke.stats().rejected;
    a.links.get('c')?.sendControl({ type: 'poke', data: accepted.data });
    await until('reordered-event-tombstone-rejects', () => c.poke.stats().rejected > cRejected);
    check('unrelated-peer-advertisement-preserves-owner-revoke-tombstone', c.hits.length === cCount);
    const staleRejected = a.poke.stats().rejected;
    b.links.get('a')?.sendControl({ type: 'poke', data: staleHit.data });
    await until('revoked-viewer-hit-rejected', () => a.poke.stats().rejected > staleRejected);
    check('revoked-hit-cannot-reenter-relay', a.poke.state().authorized.length === 2);
    const cBefore = c.hits.length; c.poke.hit('a', .8, .2, false); await until('second poker event accepted', () => c.hits.length > cBefore);
    const cEvent = a.sent.filter(item => item.to === 'c' && item.data.action === 'event' && item.data.fromUserId === 'c').at(-1); assert(!!cEvent, 'Missing C relay');
    c.poke.unwatch('a'); await until('stop watching revokes owner grant', () => !a.poke.state().authorized.some(item => item.userId === 'c'));
    const stoppedCount = c.hits.length; const stoppedRejected = c.poke.stats().rejected;
    a.links.get('c')?.sendControl({ type: 'poke', data: cEvent.data }); await until('unwatched event rejected', () => c.poke.stats().rejected > stoppedRejected);
    check('stop-watching-invalidates-grant-and-rendering', status(c) === 'idle' && c.hits.length === stoppedCount);
    const oldResponse = a.sent.filter(item => item.to === 'd' && item.data.action === 'response').at(-1); assert(!!oldResponse, 'Old grant response missing');
    const oldSession = session; a.poke.start(); advertise(a);
    await until('new share session invalidates prior grant', () => status(d) === 'idle' && d.poke.state().peers.find(peer => peer.userId === 'a')?.sessionId !== oldSession);
    d.poke.request('a'); await until('new-session request reaches owner', () => a.poke.state().requests.some(item => item.userId === 'd'));
    const dRejected = d.poke.stats().rejected; a.links.get('d')?.sendControl({ type: 'poke', data: oldResponse.data });
    await until('old-session approval rejected', () => d.poke.stats().rejected > dRejected);
    check('old-response-cannot-approve-new-session', status(d) === 'pending'); await approve(a, 'd');
    a.poke.end(); advertise(a); await until('share-stop-clears-all-grants', () => status(d) === 'idle' && a.poke.state().authorized.length === 0);
    check('stopping-share-clears-every-session', a.poke.state().sessionId === null);
    a.links.get('e')?.sendControl({ type: 'media', screen: true, accompaniment: false });
    await until('legacy-media-clears-optional-capability', () => e.poke.state().peers.some(peer => peer.userId === 'a' && !peer.supported));
    check('legacy-media-remains-safe', parsePeerControl('{"type":"media","screen":true,"accompaniment":false}', 'direct').type === 'media');
    const legacyEvent = parsePokeMessage({action:'event',sessionId:'x',grantId:'g',seq:1,nx:.5,ny:.5,boom:false,fromUserId:'b',combo:5});
    check('legacy-event-defaults-to-point', legacyEvent.action === 'event' && legacyEvent.gesture === 'point');
    const middleEvent = parsePokeMessage({action:'event',sessionId:'x',grantId:'g',seq:2,nx:.5,ny:.5,boom:false,fromUserId:'b',combo:8,gesture:'middle'});
    check('middle-event-survives-protocol-parser', middleEvent.action === 'event' && middleEvent.gesture === 'middle');
    let malformed = 0;
    /** @type {import('../public/js/network-protocol.js').JsonValue[]} */
    const malformedPackets = [null, {}, { action: 'hit', sessionId: 'x', grantId: 'g', seq: 1, nx: 1.01, ny: .5, boom: false }, { action: 'event', sessionId: 'x', grantId: 'g', seq: 1, nx: .5, ny: .5, boom: true, fromUserId: 'b', combo: 11 }, { action: 'request', sessionId: 'x', requestId: '' }, {action:'event',sessionId:'x',grantId:'g',seq:2,nx:.5,ny:.5,boom:false,fromUserId:'b',combo:8,gesture:'wave'}];
    for (const value of malformedPackets) {
      try { parsePokeMessage(value); } catch (error) { assert(error instanceof TypeError, 'Malformed packet had incorrect failure type'); malformed += 1; }
    }
    check('malformed-poke-messages-fail-explicitly', malformed === 6);
    const receiveButton = button(ownerToolbar, 'poke-audio-toggle'); receiveButton.click();
    const audioSlider = ownerToolbar.querySelector('[data-testid="poke-audio-volume"]'); assert(audioSlider instanceof HTMLInputElement, 'Missing receiver volume');
    check('receiver-audio-toggle-is-independent', !a.audio.enabled && b.audio.enabled && audioSlider.disabled);
    ownerUI.destroy();
    const rejoinedToolbar = ownerUI.renderToolbar({ connected: true, screenActive: false, musicActive: false }); app.append(rejoinedToolbar);
    check('same-media-ui-reattaches-poke-panel-after-rejoin', rejoinedToolbar.querySelectorAll('[data-testid="poke-permissions"]').length === 1 && button(rejoinedToolbar, 'poke-audio-toggle').isConnected);
    a.poke.start(); advertise(a);
    await until('rejoin publishes new share session', () => d.poke.state().peers.some(peer => peer.userId === 'a' && peer.sessionId === a.poke.state().sessionId));
    d.poke.watch('a');
    d.poke.request('a');
    await until('reused-ui-displays-new-permission-request', () => document.querySelector('[data-testid="poke-request-toast"][data-user-id="d"]') !== null);
    const rejoinedPopup = document.querySelector('[data-testid="poke-request-toast"][data-user-id="d"]'); assert(rejoinedPopup instanceof HTMLElement, 'Missing rejoined popup');
    button(rejoinedPopup, 'poke-approve').click(); await until('reused-ui-approval-reaches-real-peer', () => status(d) === 'approved');
    check('same-media-ui-authorizes-after-rejoin', a.poke.state().authorized.some(item => item.userId === 'd'));
    const latestResponse = a.sent.filter(item => item.to === 'd' && item.data.action === 'response').at(-1);
    assert(!!latestResponse && latestResponse.data.action === 'response', 'Missing latest request identity');
    const grantedRequestId = latestResponse.data.requestId;
    const grantedSession = latestResponse.data.sessionId;
    const wrongRequestId = crypto.randomUUID();
    d.links.get('a')?.sendControl({ type: 'poke', data: { action: 'cancel', sessionId: grantedSession, requestId: wrongRequestId } });
    await until('mismatched late cancel crosses channel', () => a.received.some(item => item.from === 'd' && item.data.action === 'cancel' && item.data.requestId === wrongRequestId));
    check('late-cancel-must-match-granted-request', a.poke.state().authorized.some(item => item.userId === 'd'));
    d.links.get('a')?.sendControl({ type: 'poke', data: { action: 'cancel', sessionId: grantedSession, requestId: grantedRequestId } });
    await until('matching timeout cancel revokes late approval', () => !a.poke.state().authorized.some(item => item.userId === 'd') && status(d) === 'idle');
    check('late-cancel-revokes-exact-request-after-grant', a.poke.state().authorized.length === 0);
    check('no-browser-or-transport-errors', errors.length === 0);
    return { checks, errors };
  } finally {
    for (const point of endpoints.values()) { point.ui?.destroy(); point.poke.reset(); }
    for (const item of links) item.close();
    clearInterval(draw); for (const track of stream.getTracks()) track.stop();
  }
}
