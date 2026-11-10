// @ts-check
import { PeerLink } from '../public/js/peer-link.js';
import { initialInteractionCatalog } from '../public/js/interaction-defaults.js';
import { createInteractions } from '../public/js/interactions.js';
import { parseInteractionMessage } from '../public/js/interaction-protocol.js';

/** @typedef {import('../public/js/interaction-protocol.js').InteractionMessage} Message */
/** @typedef {import('../public/js/interaction-protocol.js').InteractionEvent} InteractionEvent */
/** @typedef {{id:string,interactions:ReturnType<typeof createInteractions>,links:Map<string,PeerLink>,events:InteractionEvent[],clears:(string|null)[],sent:{to:string,data:Message}[],received:{from:string,data:Message}[]}} Endpoint */
/** @param {boolean} condition @param {string} message @returns {asserts condition} */
function assert(condition, message) { if (!condition) throw new Error(message); }
/** @param {number} milliseconds @returns {Promise<void>} */
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

/** @returns {Promise<{checks:string[],errors:string[]}>} */
export async function run() {
  /** @type {string[]} */ const checks = [];
  /** @type {string[]} */ const errors = [];
  /** @type {Map<string,Endpoint>} */ const endpoints = new Map();
  /** @type {PeerLink[]} */ const links = [];
  /** @param {Error} error @returns {void} */
  function fail(error) { errors.push(`${error.name}: ${error.message}`); }
  /** @param {string} label @param {boolean} condition @returns {void} */
  function check(label, condition) { assert(condition, label); checks.push(label); }
  /** @param {string} label @param {()=>boolean} predicate @returns {Promise<void>} */
  async function until(label, predicate) {
    const deadline = performance.now() + 10000;
    while (performance.now() < deadline) {
      assert(errors.length === 0, `${label}: ${errors.join('; ')}`);
      if (predicate()) return;
      await delay(20);
    }
    throw new Error(`Interaction test timed out: ${label}`);
  }
  /** @param {string} id @returns {Endpoint} */
  function endpoint(id) { const point = endpoints.get(id); assert(!!point, `Missing endpoint ${id}`); return point; }
  /** @param {string} id @returns {Endpoint} */
  function create(id) {
    const interactions = createInteractions({ getSelfId: () => id, getPeerIds: () => [...endpoint(id).links.keys()],
      send: (to, data) => { const point = endpoint(id); point.sent.push({ to, data }); return point.links.get(to)?.sendControl({ type: 'interaction', data }) === true; },
      onEvent: event => endpoint(id).events.push(event), onState: () => {}, onClear: member => endpoint(id).clears.push(member),
    });
    /** @type {Endpoint} */
    const point = { id, interactions, links: new Map(), events: [], clears: [], sent: [], received: [] };
    endpoints.set(id, point); return point;
  }
  /** @param {Endpoint} point @param {Endpoint} other @returns {PeerLink} */
  function connect(point, other) {
    const link = new PeerLink({ selfId: point.id, peerId: other.id,
      config: { networkMode: 'direct', mediaPolicy: 'direct', iceTransportPolicy: 'all', iceServers: [], iceExpiresAt: null }, track: null, stream: null,
      sendSignal: signal => { const remote = other.links.get(point.id); assert(!!remote, 'Signal before pair construction'); void remote.receive(signal).catch(fail); },
      onTrack: () => {}, onState: () => {}, onReady: () => {}, onError: fail,
      onControl: message => {
        if (message.type === 'interaction') { point.received.push({ from: other.id, data: message.data }); point.interactions.receive(other.id, message.data); }
        if (message.type === 'media') point.interactions.advertise(other.id, message.interaction ?? null);
      },
    });
    point.links.set(other.id, link); links.push(link); return link;
  }
  /** @param {Endpoint} point @returns {void} */
  function advertise(point) {
    for (const link of point.links.values()) assert(link.sendControl({ type: 'media', screen: false, accompaniment: false, interaction: point.interactions.advertisement() }), 'Media advertisement dropped');
  }
  /** @returns {Promise<void>} */
  async function sync() {
    for (const point of endpoints.values()) advertise(point);
    await until('all same-channel advertisements delivered', () => [...endpoints.values()].every(point => [...point.links.keys()].every(id => point.interactions.canThrow(id))));
  }
  /** @param {Endpoint} point @param {string} to @returns {Message} */
  function last(point, to) { const packet = point.sent.filter(item => item.to === to).at(-1); assert(!!packet, `Missing datagram ${point.id}->${to}`); return packet.data; }
  /** @param {Endpoint} source @param {Endpoint} recipient @param {Message} data @returns {Promise<void>} */
  async function replay(source, recipient, data) {
    const before = recipient.received.length;
    assert(source.links.get(recipient.id)?.sendControl({ type: 'interaction', data }) === true, 'Replay transport unavailable');
    await until('recorded datagram crosses real channel', () => recipient.received.length === before + 1);
  }
  try {
    const a = create('actor'); const b = create('target'); const c = create('observer');
    for (const point of [a, b, c]) point.interactions.join('room-one');
    connect(a, b); connect(b, a); connect(a, c); connect(c, a); connect(b, c); connect(c, b);
    const ab = a.links.get(b.id); assert(!!ab, 'Missing actor-target link');
    const aSession = a.interactions.advertisement(); const bSession = b.interactions.advertisement(); assert(!!aSession && !!bSession, 'Missing initial sessions');
    const early = { eventId: crypto.randomUUID(), ...aSession, targetUserId: b.id, targetSessionId: bSession.sessionId, recipientSessionId: bSession.sessionId, kind: /** @type {const} */ ('bomb'), soundIndex: 0, sequence: 1 };
    check('connecting-datagram-is-dropped-immediately', !ab.sendControl({ type: 'interaction', data: early }));
    await until('six real peer channels open', () => links.every(link => link.control.readyState === 'open' && link.interactionControl.readyState === 'open'));
    check('interaction-channel-negotiated-id-two-unordered-800ms', links.every(link => link.interactionControl.id === 2 && link.interactionControl.label === 'deepscord-interaction-v1' && !link.interactionControl.ordered && link.interactionControl.maxPacketLifeTime === 800));
    await sync();
    check('connecting-event-was-never-queued-for-reliable-delivery', [a, b, c].every(point => point.events.length === 0 && point.received.length === 0));
    a.interactions.throwAt(b.id, 'bomb');
    await until('bomb reaches actor-target-observer', () => [a, b, c].every(point => point.events.length === 1));
    const first = a.events[0];
    check('all-three-receive-exactly-one-canonical-event', [a, b, c].every(point => point.events[0].eventId === first.eventId && point.events[0].fromUserId === a.id && point.events[0].toUserId === b.id));
    check('all-three-use-identical-random-bomb-sound', [a, b, c].every(point => point.events[0].kind === 'bomb' && point.events[0].soundIndex === first.soundIndex) && first.soundIndex >= 0 && first.soundIndex <= 3);
    check('remote-source-is-authenticated-link-peer', b.received[0].from === a.id && c.received[0].from === a.id && !Object.hasOwn(b.received[0].data, 'fromUserId'));
    const oldTarget = last(a, b.id); const oldObserver = last(a, c.id);
    await replay(a, b, oldTarget); await replay(a, c, oldObserver);
    check('duplicate-event-is-ignored-by-target-and-observer', b.events.length === 1 && c.events.length === 1);
    a.interactions.throwAt(b.id, 'poop');
    await until('second event crosses datagrams', () => b.events.length === 2 && c.events.length === 2);
    await replay(a, b, oldTarget); await replay(a, c, oldObserver);
    check('out-of-order-event-is-ignored-after-newer-sequence', b.events.length === 2 && c.events.length === 2 && b.events[1].kind === 'poop' && b.events[1].soundIndex === 0);
    const beforeTargetRejoin = last(a, b.id);
    b.interactions.leave(); b.interactions.join('room-one'); await sync();
    await replay(a, b, beforeTargetRejoin);
    check('target-rejoin-rejects-old-target-session', b.events.length === 2);
    const beforeSourceRejoin = last(a, c.id);
    a.interactions.leave(); a.interactions.join('room-one'); await sync();
    await replay(a, c, beforeSourceRejoin);
    check('source-rejoin-rejects-old-source-session', c.events.length === 2);
    a.interactions.throwAt(b.id, 'bomb');
    await until('new-source-sequence-one-accepted', () => b.events.length === 3 && c.events.length === 3);
    check('fresh-source-session-resets-sequence-window', last(a, b.id).sequence === 1);
    const beforeObserverRejoin = last(a, c.id);
    c.interactions.leave(); c.interactions.join('room-one'); await sync();
    await replay(a, c, beforeObserverRejoin);
    check('observer-rejoin-rejects-old-recipient-session', c.events.length === 3);
    a.interactions.throwAt(b.id, 'poop');
    await until('new-observer-session-receives-fresh-event', () => c.events.length === 4 && b.events.length === 4);
    check('fresh-event-survives-all-three-session-rejoins', a.events.length === 4 && c.events.length === 4);
    c.interactions.leave(); c.interactions.join('other-room'); advertise(c); advertise(a); advertise(b);
    await until('different-channel-capability-removed', () => !a.interactions.canThrow(c.id) && !b.interactions.canThrow(c.id));
    const observerCount = c.events.length; const observerWire = c.received.length;
    a.interactions.throwAt(b.id, 'bomb');
    await until('same-channel-target-receives-event', () => b.events.length === 5);
    check('different-channel-observer-is-excluded-at-source', c.events.length === observerCount && c.received.length === observerWire);
    await replay(a, c, beforeObserverRejoin);
    check('different-channel-datagram-is-rejected-at-recipient', c.events.length === observerCount);
    let unavailable = false;
    try { a.interactions.throwAt(c.id, 'bomb'); } catch (error) { unavailable = error instanceof DOMException && error.name === 'InvalidStateError'; }
    check('different-channel-target-cannot-be-selected', unavailable);
    const validated = parseInteractionMessage({ ...last(a, b.id), fromUserId: 'discarded-extra-field' });
    check('runtime-schema-strips-extra-source-identity', !Object.hasOwn(validated, 'fromUserId'));
    for (const point of [a, b]) { point.interactions.remove(c.id); point.links.get(c.id)?.close(); point.links.delete(c.id); }
    for (const link of c.links.values()) link.close(); c.links.clear(); c.interactions.leave();
    check('disconnect-clears-member-and-rendering-state', !a.interactions.canThrow(c.id) && a.clears.includes(c.id) && c.clears.at(-1) === null);
    /** @type {import('../public/js/customization-protocol.js').CustomInteraction} */
    const custom = { id: 'snowball', name: 'Snowball', thumbnail: null, model: 'bomb', trajectory: 'linear', sound: 'bomb-2', durationMs: 400 };
    await Promise.all([a.interactions.setCatalog([custom]), b.interactions.setCatalog([custom])]);
    a.interactions.throwAt(b.id, custom.id);
    await until('custom-event-crosses-datagram', () => b.events.length === 6);
    const customMessage = last(a, b.id);
    check('custom-definition-bound-by-sha256', customMessage.kind === 'custom' && customMessage.customId === custom.id && /^[a-f0-9]{64}$/.test(customMessage.customRevision ?? '') && a.events.at(-1)?.customRevision === b.events.at(-1)?.customRevision);
    await b.interactions.setCatalog([{ ...custom, trajectory: 'arc' }]);
    a.interactions.throwAt(b.id, custom.id); await delay(80);
    check('changed-custom-definition-rejects-stale-event', b.events.length === 6);
    await b.interactions.setCatalog([]);
    a.interactions.throwAt(b.id, custom.id); await delay(80);
    check('removed-custom-definition-rejects-event', b.events.length === 6);
    await b.interactions.setCatalog([custom]);
    a.interactions.throwAt(b.id, custom.id);
    await until('matching-custom-definition-receives-again', () => b.events.length === 7);
    check('custom-schema-strips-untrusted-extra-definition', !Object.hasOwn(parseInteractionMessage({ ...last(a, b.id), customDefinition: { sound: 'arbitrary.mp3' } }), 'customDefinition'));
    let invalidRevision = false;
    try { parseInteractionMessage({ ...last(a, b.id), customRevision: 'untrusted' }); } catch (error) { invalidRevision = error instanceof TypeError; }
    check('custom-schema-rejects-invalid-definition-revision', invalidRevision);
    const shadow = a.interactions.getCatalog(); shadow[0].durationMs = 2000;
    check('catalog-getter-does-not-mutate-trusted-definition', a.interactions.getCatalog()[0].durationMs === 400);
    const defaults=initialInteractionCatalog();
    await Promise.all([a.interactions.setCatalog(defaults),b.interactions.setCatalog(defaults)]);
    a.interactions.throwAt(b.id,'default-bomb');
    await until('default catalog bomb crosses custom datagram',()=>b.events.length===8);
    check('default-bomb-is-an-ordinary-revision-bound-custom-event',last(a,b.id).kind==='custom' && last(a,b.id).customId==='default-bomb' && a.events.at(-1)?.customRevision===b.events.at(-1)?.customRevision);
    await a.interactions.setCatalog(defaults.filter(entry=>entry.id!=='default-bomb'));
    let removedDefault=false;
    try {a.interactions.throwAt(b.id,'default-bomb');} catch(error){removedDefault=error instanceof TypeError;}
    check('deleted-default-cannot-be-thrown-from-catalog',removedDefault);
    ab.interactionControl.close();
    await until('transient-channel-closes-while-reliable-stays-open', () => ab.interactionControl.readyState === 'closed');
    const targetWire = b.received.length; const actorEvents = a.events.length;
    check('closed-transient-channel-does-not-use-reliable-control', ab.control.readyState === 'open' && !ab.sendControl({ type: 'interaction', data: last(a, b.id) }));
    let networkError = false;
    try { a.interactions.throwAt(b.id, 'bomb'); } catch (error) { networkError = error instanceof DOMException && error.name === 'NetworkError'; }
    await delay(100);
    check('failed-target-send-produces-no-local-event-or-queued-delivery', networkError && a.events.length === actorEvents && b.received.length === targetWire);
    for (const point of [a, b]) point.interactions.leave();
    check('leave-clears-session-and-availability', [a, b].every(point => point.interactions.advertisement() === null && !point.interactions.canThrow(b.id) && point.clears.at(-1) === null));
    check('no-browser-or-transport-errors', errors.length === 0);
    return { checks, errors };
  } finally {
    for (const point of endpoints.values()) point.interactions.leave();
    for (const link of links) link.close();
  }
}
