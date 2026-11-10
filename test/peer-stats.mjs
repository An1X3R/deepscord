// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizePeerStats } from '../public/js/peer-stats.js';

/** @typedef {import('../public/js/peer-stats.js').StatsEntry} StatsEntry */
/** @type {ReadonlyArray<Readonly<StatsEntry>>} */
const path = Object.freeze([
  Object.freeze({ id: 'transport', type: 'transport', timestamp: 1000, selectedCandidatePairId: 'selected' }),
  Object.freeze({ id: 'other', type: 'candidate-pair', timestamp: 1000, currentRoundTripTime: 1 }),
  Object.freeze({ id: 'selected', type: 'candidate-pair', timestamp: 1000, localCandidateId: 'local', remoteCandidateId: 'remote', currentRoundTripTime: 0.15, bytesSent: 1200, bytesReceived: 1400 }),
  Object.freeze({ id: 'local', type: 'local-candidate', timestamp: 1000, candidateType: 'host' }),
  Object.freeze({ id: 'remote', type: 'remote-candidate', timestamp: 1000, candidateType: 'srflx' }),
  Object.freeze({ id: 'opus', type: 'codec', timestamp: 1000, mimeType: 'audio/opus', clockRate: 48000 }),
]);
/** @type {Readonly<StatsEntry>} */
const before = Object.freeze({ id: 'audio', type: 'inbound-rtp', kind: 'audio', timestamp: 1000, codecId: 'opus', jitter: 0.006, jitterBufferDelay: 10, jitterBufferEmittedCount: 1000, packetsReceived: 100, packetsLost: 2, concealedSamples: 100, totalSamplesReceived: 2000 });
/** @type {Readonly<StatsEntry>} */
const after = Object.freeze({ ...before, timestamp: 3000, jitterBufferDelay: 16, jitterBufferEmittedCount: 1200, packetsReceived: 196, packetsLost: 6, concealedSamples: 120, totalSamplesReceived: 3000 });

test('selected path RTT stays round trip and interval audio metrics use counter differences', () => {
  const result = summarizePeerStats([...path, after], [before]);
  assert.equal(result.route, 'direct');
  assert.equal(result.roundTripMs, 150);
  assert.equal(result.jitterMs, 6);
  assert.equal(result.jitterBufferMs, 30);
  assert.equal(result.packetsLostDelta, 4);
  assert.equal(result.packetsReceivedDelta, 96);
  assert.equal(result.packetLossRatio, 0.04);
  assert.equal(result.concealedSamplesRatio, 0.02);
  assert.equal(result.codecMimeType, 'audio/opus');
  assert.equal(result.codecClockRate, 48000);
  assert.equal(before.jitterBufferDelay, 10);
});

test('first sample and missing measurements remain null', () => {
  const initial = summarizePeerStats([...path, before], []);
  assert.equal(initial.jitterBufferMs, null);
  assert.equal(initial.packetLossRatio, null);
  assert.equal(initial.concealedSamplesRatio, null);
  const empty = summarizePeerStats([], []);
  assert.equal(empty.route, 'pending');
  assert.equal(empty.roundTripMs, null);
  assert.equal(empty.bytesSent, null);
  assert.equal(empty.jitterMs, null);
  assert.equal(empty.codecClockRate, null);
});

test('counter reset, replaced stream, repeated timestamp and no emitted audio yield no interval estimate', () => {
  const reset = summarizePeerStats([...path, { ...before, timestamp: 4000 }], [after]);
  assert.equal(reset.jitterBufferMs, null);
  assert.equal(reset.packetLossRatio, null);
  assert.equal(reset.concealedSamplesRatio, null);
  assert.equal(summarizePeerStats([after], [after]).jitterBufferMs, null);
  assert.equal(summarizePeerStats([{ ...after, id: 'replacement' }], [before]).jitterBufferMs, null);
  assert.equal(summarizePeerStats([{ ...before, timestamp: 4000 }], [before]).jitterBufferMs, null);
});

test('late-packet loss corrections do not become a false zero-loss result', () => {
  const result = summarizePeerStats([{ ...after, packetsLost: 1 }], [before]);
  assert.equal(result.packetsLostDelta, null);
  assert.equal(result.packetLossRatio, null);
});

test('relay route and invalid numeric values retain explicit measurements', () => {
  const relay = path.map((entry) => entry.id === 'remote' ? { ...entry, candidateType: 'relay' } : entry);
  assert.equal(summarizePeerStats(relay, []).route, 'relay');
  assert.equal(summarizePeerStats([{ ...before, jitter: Number.NaN }], []).jitterMs, null);
  assert.equal(summarizePeerStats(path.filter((entry) => entry.id !== 'transport'), []).roundTripMs, null);
});

test('microphone MID wins over accompaniment order and music alone never becomes microphone stats', () => {
  const music = { ...after, id: 'music', mid: '1', jitter: 0.09 };
  const microphone = { ...after, mid: '0', jitter: 0.006 };
  const result = summarizePeerStats([...path, music, microphone], [{ ...before, mid: '0' }]);
  assert.equal(result.inboundAudioId, 'audio');
  assert.equal(result.jitterMs, 6);
  assert.equal(result.jitterBufferMs, 30);
  assert.equal(summarizePeerStats([music], []).inboundAudioId, null);
  assert.equal(summarizePeerStats([music, after], []).inboundAudioId, null);
  assert.equal(summarizePeerStats([after], [before]).inboundAudioId, 'audio');
});
