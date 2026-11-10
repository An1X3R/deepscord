// @ts-check
import { ScreenLink } from '../public/js/screen-link.js';
import { ScreenRelay } from '../public/js/screen-relay.js';
import { DEFAULT_SCREEN_PREFERENCES } from '../public/js/screen-preferences.js';
import { parsePeerControl } from '../public/js/network-protocol.js';

/** @typedef {import('../public/js/screen-ice.js').ScreenIceCandidate} Candidate */
/** @typedef {import('../public/js/screen-protocol.js').ScreenMessage} Message */
/** @typedef {Extract<Message,{kind:'ice'}>} IceMessage */
/** @typedef {import('../public/js/network-protocol.js').JsonValue} Value */
/** @typedef {import('../public/js/network-protocol.js').JsonObject} RecordValue */
/** @typedef {{type:string,id:string,kind?:string,bytesReceived?:number,framesDecoded?:number,selectedCandidatePairId?:string,localCandidateId?:string,remoteCandidateId?:string,candidateType?:string}} Stat */
/** @typedef {{video:HTMLVideoElement,presented:()=>number,frames:()=>number,dispose:()=>void}} Display */
/** @param {boolean} condition @param {string} message @returns {asserts condition} */
function check(condition, message) { if (!condition) throw new Error(message); }
/** @param {number} milliseconds @returns {Promise<void>} */
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
/** @param {()=>boolean} condition @param {number} milliseconds @param {string} label @returns {Promise<void>} */
async function until(condition, milliseconds, label) {
  const deadline = performance.now() + milliseconds;
  while (!condition()) { if (performance.now() >= deadline) throw new Error('Real screen ICE condition timed out: ' + label); await delay(20); }
}
/** @returns {Display} */
function display() {
  const video = document.createElement('video'); video.id = 'screenIceVideo-' + crypto.randomUUID(); video.autoplay = true; video.muted = true; document.body.append(video);
  let frames = 0, disposed = false;
  /** @param {number} _now @param {VideoFrameCallbackMetadata} _metadata @returns {void} */
  function frame(_now, _metadata) { frames += 1; if (!disposed) video.requestVideoFrameCallback(frame); }
  video.requestVideoFrameCallback(frame);
  return { video, presented: () => frames, frames: () => video.getVideoPlaybackQuality().totalVideoFrames, dispose: () => { disposed = true; video.pause(); video.srcObject = null; video.remove(); } };
}
/** @param {RTCPeerConnection} pc @returns {Promise<RecordValue>} */
async function evidence(pc) {
  const reports = await pc.getStats();
  let bytes = 0, decoded = 0;
  /** @type {RecordValue[]} */ const paths = [];
  reports.forEach(/** @param {Stat} item */ item => {
    if (item.type === 'inbound-rtp' && item.kind === 'video') { bytes += item.bytesReceived ?? 0; decoded += item.framesDecoded ?? 0; }
    if (item.type === 'transport' && item.selectedCandidatePairId) {
      const pair = /** @type {Stat|undefined} */ (reports.get(item.selectedCandidatePairId));
      const local = pair?.localCandidateId ? /** @type {Stat|undefined} */ (reports.get(pair.localCandidateId)) : undefined;
      const remote = pair?.remoteCandidateId ? /** @type {Stat|undefined} */ (reports.get(pair.remoteCandidateId)) : undefined;
      paths.push({ pair: item.selectedCandidatePairId, local: local?.candidateType ?? null, remote: remote?.candidateType ?? null });
    }
  });
  return { state: pc.connectionState, gathering: pc.iceGatheringState, bytesReceived: bytes, framesDecoded: decoded, paths };
}
/** @param {string} label @param {RTCIceServer[]} iceServers @param {MediaStream} stream @param {string} order @returns {Promise<RecordValue>} */
async function direct(label, iceServers, stream, order) {
  const view = display(), started = performance.now();
  /** @type {string[]} */ const faults = [];
  /** @type {Candidate[]} */ const senderCandidates = [];
  /** @type {Promise<void>[]} */ const deliveries = [];
  /** @type {ScreenLink|null} */ let sender = null;
  /** @type {ScreenLink|null} */ let receiver = null;
  /** @type {Candidate|null} */ let early = null;
  let offerSent = false, answerSent = false, earlyQueued = 0;
  try {
    receiver = new ScreenLink({ network: { iceServers, iceTransportPolicy: 'all' }, onStream: received => { view.video.srcObject = received; view.video.play().catch(error => faults.push(String(error))); }, onFault: error => faults.push(error.message), onIce: candidate => { check(answerSent, 'Answer ICE escaped before the SDP was sent'); check(sender !== null, 'Missing sender'); deliveries.push(sender.addIce(candidate)); } });
    sender = new ScreenLink({ network: { iceServers, iceTransportPolicy: 'all' }, onStream: () => { throw new Error('Sender unexpectedly received a video track'); }, onFault: error => faults.push(error.message), onIce: candidate => { check(offerSent, 'Offer ICE escaped before the SDP was sent'); senderCandidates.push(candidate); if (early === candidate) return; check(receiver !== null, 'Missing receiver'); deliveries.push(receiver.addIce(candidate)); } });
    const offer = await sender.sendOffer(stream, 1800000, 30, 'motion');
    const offerMs = performance.now() - started, gatheringAtOffer = sender.pc.iceGatheringState;
    check(offerMs < 10000, label + ': SDP exceeded the explicit 10s negotiation deadline: ' + offerMs + 'ms');
    if (label === 'blackhole-stun') check(gatheringAtOffer !== 'complete', 'Blackhole offer waited for ICE gathering to complete');
    if (order === 'candidate-before-sdp') {
      await until(() => sender !== null && sender.localIce.some(candidate => candidate.candidate.length > 0), 3000, 'actual local host candidate');
      early = sender.localIce.find(candidate => candidate.candidate.length > 0) ?? null;
      check(early !== null && receiver.pc.remoteDescription === null, 'Candidate-before-SDP setup is invalid');
      await receiver.addIce(early); earlyQueued = receiver.remoteIce.length;
      check(earlyQueued === 1, 'Real ICE was not queued before remote SDP');
    }
    offerSent = true;
    const answering = receiver.answer(offer);
    sender.releaseIce();
    const answer = await answering;
    answerSent = true;
    const accepting = sender.acceptAnswer(answer);
    receiver.releaseIce();
    await accepting; await Promise.all(deliveries);
    await until(() => view.presented() >= 1 && view.frames() >= 3, 6000, label + ' decoded and displayed video');
    const firstFramesMs = performance.now() - started, first = await evidence(receiver.pc), before = view.frames();
    await delay(800);
    const last = await evidence(receiver.pc);
    check(Array.isArray(last.paths) && last.paths.some(path => path !== null && typeof path === 'object' && !Array.isArray(path) && path.local === 'host' && path.remote === 'host'), label + ': actual selected host-to-host path is missing');
    check(view.frames() > before && Number(last.framesDecoded) > Number(first.framesDecoded), label + ': video did not continue decoding: ' + JSON.stringify({ before, after: view.frames(), first, last, faults }));
    check(Number(last.bytesReceived) > Number(first.bytesReceived), label + ': RTP bytes did not grow');
    check(view.video.videoWidth > 0 && view.video.videoHeight > 0 && Math.abs(view.video.videoWidth / view.video.videoHeight - 16 / 9) < 0.02, label + ': invalid decoded dimensions: ' + view.video.videoWidth + 'x' + view.video.videoHeight);
    check(faults.length === 0, label + ': ' + JSON.stringify(faults));
    return { label, order, offerMs, gatheringAtOffer, firstFramesMs, earlyQueued, queuedAfterSdp: receiver.remoteIce.length, actualCandidates: senderCandidates.length, first, last, presentedCallbacks: view.presented(), playbackFrames: view.frames(), width: view.video.videoWidth, height: view.video.videoHeight, faults };
  } finally { sender?.close(); receiver?.close(); view.dispose(); }
}

/** @typedef {{a:RTCDataChannel,b:RTCDataChannel,close:()=>void}} Wire */
/** @returns {Promise<Wire>} */
async function wire() {
  const left = new RTCPeerConnection({ iceServers: [] }), right = new RTCPeerConnection({ iceServers: [] });
  const a = left.createDataChannel('real-screen-protocol', { ordered: true });
  /** @type {RTCDataChannel|null} */ let b = null;
  /** @type {Promise<void>[]} */ const candidates = [];
  left.onicecandidate = event => { if (event.candidate) candidates.push(right.addIceCandidate(event.candidate)); };
  right.onicecandidate = event => { if (event.candidate) candidates.push(left.addIceCandidate(event.candidate)); };
  right.ondatachannel = event => { b = event.channel; };
  try {
    await left.setLocalDescription(await left.createOffer()); check(left.localDescription !== null, 'Control offer is missing'); await right.setRemoteDescription(left.localDescription);
    await right.setLocalDescription(await right.createAnswer()); check(right.localDescription !== null, 'Control answer is missing'); await left.setRemoteDescription(right.localDescription);
    await until(() => a.readyState === 'open' && b !== null && b.readyState === 'open', 5000, 'real control data channel');
    await Promise.all(candidates); check(b !== null, 'Remote control channel is missing');
    return { a, b, close: () => { left.close(); right.close(); } };
  } catch (error) { left.close(); right.close(); throw error; }
}

/** @param {MediaStream} stream @param {string} violation @returns {Promise<RecordValue>} */
async function protocol(stream, violation) {
  const channel = await wire(), view = display();
  /** @type {string[]} */ const errors = [];
  /** @type {{from:string,message:IceMessage}[]} */ const captured = [];
  /** @type {Map<string,ScreenRelay>} */ const nodes = new Map();
  /** @type {Map<string,Promise<void>>} */ const tails = new Map();
  /** @type {{kind:string,message:string}[]} */ const expectedRejections = [];
  /** @type {{match:RegExp,resolve:(message:string)=>void,reject:(error:Error)=>void}|null} */ let expected = null;
  /** @type {import('../public/js/network-protocol.js').NetworkConfig} */ const network = { networkMode: 'direct', mediaPolicy: 'direct', iceTransportPolicy: 'all', iceServers: [], iceExpiresAt: null };
  /** @param {string} self @param {RTCDataChannel} outbound @returns {ScreenRelay} */
  function make(self, outbound) {
    return new ScreenRelay({ selfId: self, getNetwork: () => network, getPreferences: () => ({ ...DEFAULT_SCREEN_PREFERENCES, screenBitrateMbps: 1.8, relayEnabled: false }), peerIds: () => [self === 'source' ? 'viewer' : 'source'], send: (_peer, message) => { if (outbound.readyState !== 'open') return false; outbound.send(JSON.stringify({ type: 'screen', data: message })); return true; }, onStream: (_source, received) => { if (received) { view.video.srcObject = received; view.video.play().catch(error => errors.push(String(error))); } }, onError: error => errors.push(error.message) });
  }
  const source = make('source', channel.a), viewer = make('viewer', channel.b); nodes.set('source', source); nodes.set('viewer', viewer);
  /** @param {string} destination @param {string} from @param {MessageEvent} event @returns {void} */
  function incoming(destination, from, event) {
    const previous = tails.get(destination) ?? Promise.resolve();
    const next = previous.then(async () => {
      check(typeof event.data === 'string', 'Screen control wire must carry actual text');
      const parsed = parsePeerControl(event.data, 'direct');
      check(parsed.type === 'screen', 'Unexpected non-screen control');
      if (parsed.data.kind === 'ice') captured.push({ from, message: parsed.data });
      const node = nodes.get(destination); check(node !== undefined, 'Missing actual protocol endpoint');
      try { await node.receive(from, parsed.data); }
      catch (error) {
        if (!(error instanceof Error)) throw new TypeError('Non-error screen protocol rejection');
        if (expected && expected.match.test(error.message)) { const pending = expected; expected = null; expectedRejections.push({ kind: parsed.data.kind, message: error.message }); pending.resolve(error.message); }
        else throw error;
      }
    });
    tails.set(destination, next); next.catch(error => { errors.push(String(error)); if (expected) expected.reject(error instanceof Error ? error : new Error(String(error))); });
  }
  channel.a.onmessage = event => incoming('source', 'viewer', event); channel.b.onmessage = event => incoming('viewer', 'source', event);
  /** @param {IceMessage} message @param {RegExp} match @returns {Promise<string>} */
  async function inject(message, match) {
    check(expected === null, 'Only one explicit fault injection may be pending');
    const result = new Promise((resolve, reject) => { expected = { match, resolve, reject }; });
    channel.a.send(JSON.stringify({ type: 'screen', data: message }));
    const timeout = setTimeout(() => { if (expected) { const pending = expected; expected = null; pending.reject(new Error('Protocol did not reject explicit ' + violation + ' injection')); } }, 3000);
    try { return await result; } finally { clearTimeout(timeout); }
  }
  try {
    source.join('real-ice-room'); viewer.join('real-ice-room'); source.peerReady('viewer'); viewer.peerReady('source');
    await until(() => source.capacities.has('viewer') && viewer.capacities.has('source'), 3000, 'capacity exchange');
    await source.publish(stream);
    await until(() => viewer.shares.has('source'), 3000, 'publication exchange'); await viewer.watch('source');
    await until(() => view.presented() >= 1 && view.frames() >= 5 && captured.some(row => row.from === 'source' && row.message.candidate.candidate.length > 0), 6000, 'controller video and actual ICE');
    check(errors.length === 0, 'Protocol failed before injection: ' + JSON.stringify(errors));
    const observed = captured.find(row => row.from === 'source' && row.message.candidate.candidate.length > 0); check(observed !== undefined, 'No real source ICE message');
    const current = observed.message, edge = viewer.edges.get(current.edgeId); check(edge !== undefined, 'Missing active viewer edge');
    const before = await evidence(edge.link.pc);
    const stale = await inject({ ...current, negotiationId: 'expired-' + current.negotiationId }, /negotiation|matching|authorized|expired/i);
    let rejection = '';
    if (violation === 'wrong-ufrag') {
      rejection = await inject({ ...current, candidate: { ...current.candidate, usernameFragment: 'WrongNegotiation' } }, /different negotiation|username/i);
    } else if (violation === 'overflow') {
      const count = edge.link.remoteCandidateCount;
      check(count > 0 && count < 128, 'Unexpected initial real candidate count: ' + count);
      for (let index = count; index < 128; index += 1) channel.a.send(JSON.stringify({ type: 'screen', data: current }));
      await until(() => edge.link.remoteCandidateCount === 128 || errors.length > 0, 3000, '128 actual candidate replays');
      check(errors.length === 0, 'Unexpected pre-limit rejection: ' + JSON.stringify(errors));
      rejection = await inject(current, /candidate limit exceeded/i);
    } else throw new TypeError('Unrecognized explicit protocol fault');
    check(errors.length === 0, 'Unexpected integration error: ' + JSON.stringify(errors));
    return { violation, realDataChannel: true, before, presentedCallbacks: view.presented(), playbackFrames: view.frames(), negotiationId: current.negotiationId, staleRejection: stale, rejection, rejected: expectedRejections, remoteCandidateCount: edge.link.remoteCandidateCount, errors };
  } finally { source.leave(); viewer.leave(); channel.close(); view.dispose(); }
}

/** @param {number} port @returns {Promise<RecordValue>} */
async function bidirectional(port) {
  const channel = await wire(), leftView = display(), rightView = display();
  leftView.video.style.cssText = 'left:0;width:320px;height:180px';
  rightView.video.style.cssText = 'left:320px;width:320px;height:180px';
  /** @type {string[]} */ const errors = [];
  /** @type {Map<string,ScreenRelay>} */ const nodes = new Map();
  /** @type {Map<string,Promise<void>>} */ const tails = new Map();
  /** @type {import('../public/js/network-protocol.js').NetworkConfig} */
  const network = { networkMode: 'direct', mediaPolicy: 'direct', iceTransportPolicy: 'all', iceServers: [{ urls: 'stun:127.0.0.1:' + port }], iceExpiresAt: null };
  /** @param {string} id @param {string} peer @param {RTCDataChannel} outbound @param {Display} view @returns {ScreenRelay} */
  function endpoint(id, peer, outbound, view) {
    return new ScreenRelay({ selfId: id, getNetwork: () => network, getPreferences: () => ({ ...DEFAULT_SCREEN_PREFERENCES, screenBitrateMbps: 1.8, relayEnabled: false }), peerIds: () => [peer], send: (_recipient, message) => { if (outbound.readyState !== 'open') return false; outbound.send(JSON.stringify({ type: 'screen', data: message })); return true; }, onStream: (source, received) => {
      if (source !== peer) return;
      view.video.srcObject = received;
      if (received) view.video.play().catch(error => errors.push(String(error)));
    }, onError: error => errors.push(error.message) });
  }
  const left = endpoint('left', 'right', channel.a, leftView), right = endpoint('right', 'left', channel.b, rightView);
  nodes.set('left', left); nodes.set('right', right);
  /** @param {string} destination @param {string} from @param {MessageEvent} event @returns {void} */
  function incoming(destination, from, event) {
    const previous = tails.get(destination) ?? Promise.resolve();
    const operation = previous.then(async () => {
      check(typeof event.data === 'string', 'Bidirectional control wire must carry text');
      const message = parsePeerControl(event.data, 'direct'); check(message.type === 'screen', 'Unexpected bidirectional control type');
      const node = nodes.get(destination); check(node !== undefined, 'Missing bidirectional endpoint');
      await node.receive(from, message.data);
    });
    tails.set(destination, operation); operation.catch(error => errors.push(String(error)));
  }
  channel.a.onmessage = event => incoming('left', 'right', event); channel.b.onmessage = event => incoming('right', 'left', event);
  /** @type {{canvas:HTMLCanvasElement,stream:MediaStream,timer:ReturnType<typeof setInterval>}[]} */ const sources = [];
  /** @param {string} id @param {string} color @param {number} direction @returns {MediaStream} */
  function source(id, color, direction) {
    const canvas = document.createElement('canvas'); canvas.id = id; canvas.width = 1280; canvas.height = 720; document.body.append(canvas);
    const context = canvas.getContext('2d'); check(context !== null, 'Independent canvas renderer unavailable');
    let frame = 0;
    const timer = setInterval(() => { frame += 1; context.fillStyle = '#132536'; context.fillRect(0, 0, 1280, 720); context.fillStyle = color; context.fillRect((frame * direction % 1100 + 1100) % 1100, 100, 150, 150); context.font = '32px sans-serif'; context.fillText(id + ' actual frame ' + frame, 50, 560); }, 33);
    const stream = canvas.captureStream(30); sources.push({ canvas, stream, timer }); return stream;
  }
  /** @param {ScreenRelay} node @param {string} peer @param {Display} view @returns {Promise<RecordValue>} */
  async function received(node, peer, view) {
    const edges = [...node.edges.values()].filter(edge => edge.sourceId === peer && edge.role === 'direct');
    check(edges.length === 1, 'Expected exactly one inbound edge from ' + peer);
    return { ...await evidence(edges[0].link.pc), edgeId: edges[0].id, negotiationId: edges[0].negotiationId, playbackFrames: view.frames(), presentedCallbacks: view.presented(), width: view.video.videoWidth, height: view.video.videoHeight };
  }
  /** @param {RecordValue} before @param {RecordValue} after @param {string} direction @returns {void} */
  function progressed(before, after, direction) {
    check(Number(after.framesDecoded) > Number(before.framesDecoded) && Number(after.bytesReceived) > Number(before.bytesReceived) && Number(after.playbackFrames) > Number(before.playbackFrames), 'Bidirectional screen stopped progressing: ' + direction + ' ' + JSON.stringify({ before, after }));
    check(after.edgeId === before.edgeId && after.negotiationId === before.negotiationId, 'Unexpected replacement of a healthy bidirectional edge: ' + direction);
  }
  try {
    const leftStream = source('screenIceLeftCanvas', '#f8d443', 17), rightStream = source('screenIceRightCanvas', '#53dbe3', -23);
    check(leftStream.getVideoTracks()[0].id !== rightStream.getVideoTracks()[0].id, 'Bidirectional sources must be independent tracks');
    left.join('bidirectional-blackhole'); right.join('bidirectional-blackhole'); left.peerReady('right'); right.peerReady('left');
    await until(() => left.capacities.has('right') && right.capacities.has('left'), 3000, 'bidirectional capacity exchange');
    await Promise.all([left.publish(leftStream), right.publish(rightStream)]);
    await until(() => left.shares.has('right') && right.shares.has('left'), 3000, 'simultaneous publications');
    await Promise.all([left.watch('right'), right.watch('left')]);
    await until(() => { check(errors.length === 0, 'Bidirectional negotiation failed: ' + JSON.stringify(errors)); return leftView.frames() >= 5 && rightView.frames() >= 5 && leftView.presented() >= 1 && rightView.presented() >= 1; }, 8000, 'both bidirectional screens decoded');
    const initial = { leftReceivesRight: await received(left, 'right', leftView), rightReceivesLeft: await received(right, 'left', rightView) };
    await delay(1200);
    const simultaneous = { leftReceivesRight: await received(left, 'right', leftView), rightReceivesLeft: await received(right, 'left', rightView) };
    progressed(initial.leftReceivesRight, simultaneous.leftReceivesRight, 'right-to-left'); progressed(initial.rightReceivesLeft, simultaneous.rightReceivesLeft, 'left-to-right');
    await left.unpublish(); leftStream.getTracks().forEach(track => track.stop());
    await until(() => !right.shares.has('left') && rightView.video.srcObject === null, 3000, 'stopped left publication removed remotely');
    check(right.shareId !== null && right.stream === rightStream && left.watching.has('right'), 'Stopping left publication cancelled the reverse publication');
    const afterStop = await received(left, 'right', leftView);
    check(afterStop.edgeId === simultaneous.leftReceivesRight.edgeId && afterStop.negotiationId === simultaneous.leftReceivesRight.negotiationId, 'Stopping left publication replaced the reverse connection');
    await delay(1500);
    const continuing = await received(left, 'right', leftView);
    progressed(afterStop, continuing, 'right-to-left after left stop');
    check(![...right.edges.values()].some(edge => edge.sourceId === 'left') && ![...left.edges.values()].some(edge => edge.sourceId === 'left'), 'Stopped publication retained a media edge');
    check(errors.length === 0, 'Bidirectional lifecycle errors: ' + JSON.stringify(errors));
    return { blackholeStun: 'stun:127.0.0.1:' + port, independentSourceTracks: true, realDataChannel: true, initial, simultaneous, stoppedSource: 'left', stoppedRemoteVideoCleared: rightView.video.srcObject === null, afterStop, continuing, errors };
  } finally { left.leave(); right.leave(); channel.close(); leftView.dispose(); rightView.dispose(); for (const item of sources) { clearInterval(item.timer); item.stream.getTracks().forEach(track => track.stop()); item.canvas.remove(); } }
}

/** @param {number} port @returns {Promise<RecordValue>} */
async function run(port) {
  check(Number.isInteger(port) && port > 0 && port < 65536, 'Explicit blackhole UDP port is required');
  const canvas = document.getElementById('screenIceCanvas'); check(canvas instanceof HTMLCanvasElement, 'Missing stable test canvas');
  const context = canvas.getContext('2d'); check(context !== null, 'Canvas renderer unavailable');
  let frame = 0;
  const drawing = setInterval(() => { frame += 1; context.fillStyle = '#173045'; context.fillRect(0, 0, 1280, 720); context.fillStyle = '#f8d443'; context.fillRect(frame * 17 % 1100, 60, 160, 160); context.font = '32px sans-serif'; context.fillText('Actual canvas frame ' + frame, 40, 560); }, 33);
  const stream = canvas.captureStream(30);
  try {
    const control = await direct('no-stun-control', [], stream, 'sdp-before-candidates');
    const blackhole = await direct('blackhole-stun', [{ urls: 'stun:127.0.0.1:' + port }], stream, 'sdp-before-candidates');
    const queued = await direct('candidate-before-sdp', [], stream, 'candidate-before-sdp');
    const ufrag = await protocol(stream, 'wrong-ufrag');
    const overflow = await protocol(stream, 'overflow');
    const simultaneous = await bidirectional(port);
    return { scope: 'Same-machine real WebRTC regression; no public STUN reachability or microphone test', control, blackhole, queued, ufrag, overflow, bidirectional: simultaneous };
  } finally { clearInterval(drawing); stream.getTracks().forEach(track => track.stop()); }
}
/** @type {Window & {runScreenIce?:(port:number)=>Promise<RecordValue>}} */ (window).runScreenIce = run;
