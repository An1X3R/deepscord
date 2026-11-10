// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { planScreenRoutes, screenBudget, validateOneHop } from '../public/js/screen-plan.js';
import { parseScreenMessage } from '../public/js/screen-protocol.js';

test('40 Mbps targets retain 20 percent wire headroom and explicit upload admission', () => {
  const viewers = [{ id: 'viewer', availableBps: 0, relay: false }];
  const high = planScreenRoutes('source', 48000000, 40000000, viewers, []);
  assert.equal(high.bitrateBps, 40000000);
  assert.equal(high.wireBps, 48000000);
  const limited = planScreenRoutes('source', 6000000, 40000000, viewers, []);
  assert.ok(limited.wireBps <= 6000000 && limited.wireBps >= limited.bitrateBps * 1.2);
  const message = { kind: 'plan', version: 2, sourceId: 'source', shareId: 'share', epoch: 1, bitrateBps: 40000000, wireBps: 48000000, routes: [{ viewerId: 'viewer', parentId: 'source', routeId: 'route' }] };
  assert.equal(parseScreenMessage(message, 'direct').kind, 'plan');
  assert.throws(() => parseScreenMessage({ ...message, bitrateBps: 40000001 }, 'direct'));
  assert.throws(() => parseScreenMessage({ ...message, wireBps: 48000001 }, 'direct'));
  assert.throws(() => planScreenRoutes('source', 100000000, 40000001, viewers, []));
});

test('one-hop planner honors source and per-user aggregate capacity', () => {
  const viewers = Array.from({ length: 9 }, (_, index) => ({ id: `u${index}`, availableBps: index < 3 ? 6500000 : 500000, relay: true }));
  const before = JSON.stringify(viewers);
  const plan = planScreenRoutes('source', screenBudget(10000000, 9), 2500000, viewers, []);
  validateOneHop('source', plan.routes);
  assert.equal(plan.routes.length, 9);
  assert.equal(JSON.stringify(viewers), before);
  for (const id of ['source', ...viewers.map((peer) => peer.id)]) {
    const budget = id === 'source' ? screenBudget(10000000, 9) : viewers.find((peer) => peer.id === id)?.availableBps;
    assert.ok(typeof budget === 'number');
    assert.ok(plan.routes.filter((route) => route.parentId === id).length * plan.wireBps <= budget);
  }
});

test('relay exit promotes an eligible surviving viewer within capacity', () => {
  const viewers = Array.from({ length: 9 }, (_, index) => ({ id: `u${index}`, availableBps: 6500000, relay: true }));
  const first = planScreenRoutes('source', 8000000, 2000000, viewers, []);
  const oldRelay = first.routes.find((route) => route.parentId !== 'source')?.parentId;
  assert.ok(oldRelay);
  const next = planScreenRoutes('source', 8000000, 2000000, viewers.filter((viewer) => viewer.id !== oldRelay), first.routes);
  validateOneHop('source', next.routes);
  assert.equal(next.routes.length, 8);
  assert.ok(next.routes.every((route) => route.parentId !== oldRelay && route.viewerId !== oldRelay));
});

test('non-contributing clients remain leaf viewers and capacity failure is explicit', () => {
  const viewers = [{ id: 'a', availableBps: 100000000, relay: false }, { id: 'b', availableBps: 100000000, relay: false }];
  const plan = planScreenRoutes('source', 1200000, 2000000, viewers, []);
  assert.ok(plan.routes.every((route) => route.parentId === 'source'));
  assert.ok(plan.bitrateBps < 1000000);
  assert.throws(() => planScreenRoutes('source', 100000, 2000000, viewers, []), /上传不足/);
});

test('degradation reaches the exact 300 kbps floor without exceeding the wire budget', () => {
  const viewers = [{ id: 'viewer', availableBps: 0, relay: false }];
  for (const targetBps of [300001, 2500000, 8000000]) {
    const plan = planScreenRoutes('source', 360000, targetBps, viewers, []);
    assert.equal(plan.bitrateBps, 300000);
    assert.equal(plan.wireBps, 360000);
    assert.deepEqual(plan.routes, [{ viewerId: 'viewer', parentId: 'source' }]);
  }
  assert.throws(() => planScreenRoutes('source', 359999, 2500000, viewers, []), RangeError);
});

test('a contributing parent serves at most three leaves and disabled contributors serve none', () => {
  const viewers = [
    { id: 'hub', availableBps: 100000000, relay: true },
    ...Array.from({ length: 4 }, (_, index) => ({ id: `leaf${index}`, availableBps: 1000000000, relay: false })),
  ];
  assert.throws(() => planScreenRoutes('source', 360000, 300000, viewers, []), RangeError);
  const plan = planScreenRoutes('source', 720000, 300000, viewers, []);
  assert.equal(plan.routes.filter((route) => route.parentId === 'source').length, 2);
  assert.equal(plan.routes.filter((route) => route.parentId === 'hub').length, 3);
  assert.ok(plan.routes.every((route) => route.parentId === 'source' || route.parentId === 'hub'));
  validateOneHop('source', plan.routes);
});

test('planning accepts frozen inputs and preserves previous routes and reservations', () => {
  const viewers = Object.freeze([
    Object.freeze({ id: 'hub', availableBps: 1080000, relay: true }),
    Object.freeze({ id: 'leaf', availableBps: 0, relay: false }),
  ]);
  const previous = Object.freeze([
    Object.freeze({ viewerId: 'hub', parentId: 'source' }),
    Object.freeze({ viewerId: 'leaf', parentId: 'hub' }),
  ]);
  const before = JSON.stringify({ viewers, previous });
  const plan = planScreenRoutes('source', 360000, 300000, viewers, previous);
  assert.deepEqual(plan.routes, previous);
  assert.equal(JSON.stringify({ viewers, previous }), before);
  assert.notEqual(plan.routes, previous);
});

test('invalid capacity inputs fail before a route can be admitted', () => {
  const viewer = { id: 'viewer', availableBps: 0, relay: false };
  for (const sourceBudgetBps of [-1, NaN, Infinity]) {
    assert.throws(() => planScreenRoutes('source', sourceBudgetBps, 300000, [viewer], []), RangeError);
  }
  for (const availableBps of [-1, NaN, Infinity]) {
    assert.throws(() => planScreenRoutes('source', 360000, 300000, [{ ...viewer, availableBps }], []), RangeError);
  }
  assert.throws(() => planScreenRoutes('source', 720000, 300000, [viewer, viewer], []), RangeError);
  assert.throws(() => planScreenRoutes('source', 360000, 300000, [{ ...viewer, id: 'source' }], []), RangeError);
  assert.throws(() => validateOneHop('source', [{ viewerId: 'viewer', parentId: 'viewer' }]), TypeError);
  assert.throws(() => validateOneHop('source', [{ viewerId: 'viewer', parentId: 'missing' }]), TypeError);
});

test('screen protocol rejects cycles, multi-hop, audio SDP and relay bypass', () => {
  const base = { kind: 'plan', version: 2, sourceId: 'source', shareId: 'share', epoch: 1, bitrateBps: 1000000, wireBps: 1200000 };
  assert.throws(() => parseScreenMessage({ ...base, routes: [{ viewerId: 'a', parentId: 'source', routeId: 'r1' }, { viewerId: 'b', parentId: 'a', routeId: 'r2' }, { viewerId: 'c', parentId: 'b', routeId: 'r3' }] }, 'direct'), /one intermediate/);
  assert.throws(() => parseScreenMessage({ ...base, routes: [{ viewerId: 'a', parentId: 'b', routeId: 'r1' }, { viewerId: 'b', parentId: 'a', routeId: 'r2' }] }, 'direct'), /one intermediate/);
  const signal = { kind: 'offer', version: 2, sourceId: 'source', shareId: 'share', edgeId: 'edge', negotiationId: 'negotiation', role: 'direct', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' };
  assert.throws(() => parseScreenMessage(signal, 'direct'), /video section/);
  assert.throws(() => parseScreenMessage({ ...signal, sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=candidate:1 1 udp 1 127.0.0.1 9999 typ relay\r\n' }, 'direct'), /TURN/);
});

test('screen protocol strips unrelated fields and enforces explicit version', () => {
  assert.deepEqual(parseScreenMessage({ kind: 'capacity', version: 2, availableBps: 1234, relay: true, reservations: [], unrelated: 'drop' }, 'direct'), { kind: 'capacity', version: 2, availableBps: 1234, relay: true, reservations: [] });
  assert.throws(() => parseScreenMessage({ kind: 'capacity', availableBps: 1234, relay: true }, 'direct'), /不兼容/);
});
