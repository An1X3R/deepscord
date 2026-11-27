import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import lifecycle from '../desktop/steam-session-lifecycle.cjs';

test('peer session is released exactly once after the last lobby stops using it', () => {
  const closed = [];
  const registry = lifecycle.createPeerRegistry(peer => closed.push(peer));
  const current = {}, candidate = {};
  const peer = '76561198000000001', other = '76561198000000002';
  registry.retain(current, peer);
  registry.retain(current, peer);
  registry.retain(candidate, peer);
  registry.retain(current, other);
  for (const id of registry.peers(current)) registry.release(current, id);
  assert.deepEqual(closed, [BigInt(other)]);
  registry.release(candidate, peer);
  registry.release(candidate, peer);
  assert.deepEqual(closed, [BigInt(other), BigInt(peer)]);
});

test('retry notifications share a deadline and a successful reconnect cancels it', async () => {
  const expired = [];
  const recovery = lifecycle.createRecoveryWindow(25, reason => expired.push(reason));
  assert.equal(recovery.begin('NoConnection'), true);
  const first = recovery.waiting;
  recovery.markConnected();
  assert.equal(recovery.begin('Timeout'), false);
  assert.equal(recovery.connected, false);
  assert.equal(recovery.waiting, first);
  recovery.markConnected();
  recovery.clear();
  await first;
  await delay(40);
  assert.deepEqual(expired, []);
  assert.equal(recovery.begin(35), true);
  const next = recovery.waiting;
  await next;
  assert.deepEqual(expired, [35]);
  assert.equal(recovery.waiting, undefined);
});

test('both SDK representations distinguish an outage from a replaced login', () => {
  for (const reason of [3,16,20,35,38,48,'NoConnection','Timeout','ServiceUnavailable','ConnectFailed','RemoteDisconnect','TryAnotherCM']) {
    assert(lifecycle.transientDisconnect.has(reason));
  }
  for (const reason of [6,34,'LoggedInElsewhere','LogonSessionReplaced']) {
    assert.equal(lifecycle.transientDisconnect.has(reason), false);
  }
});

test('the bundled Steam runtime exports the peer cleanup functions without logging in', {skip:process.platform !== 'win32'}, () => {
  assert.equal(typeof lifecycle.bindSessionCloser(), 'function');
});
