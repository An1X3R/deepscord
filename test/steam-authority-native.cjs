// @ts-check
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { SteamClient } = require('../desktop/steam-client.cjs');

/** @returns {Promise<{checks:string[],membershipEvents:number}>} */
async function smoke() {
  /** @type {import('../desktop/steam-client.cjs').SteamEvent[]} */
  const events = [];
  /** @type {string[]} */
  const checks = [];
  const client = new SteamClient(480, (event) => events.push(event));
  try {
    assert.throws(() => client.authority(), /requires membership/);
    assert.throws(() => client.publishedAuthority(), /requires membership/);
    assert.throws(() => client.claimAuthority(randomBytes(16).toString('hex')), /requires membership/);
    checks.push('authority operations reject calls without lobby membership');

    const room = await client.create();
    assert.equal(room.ownerId, client.selfId);
    assert.equal(typeof room.epoch, 'string');
    assert.match(/** @type {string} */ (room.epoch), /^[a-f0-9]{32}$/);
    assert.deepEqual(client.authority(), { ownerId: room.ownerId, epoch: room.epoch });
    checks.push('real Steam lobby creation publishes and reads its initial owner-bound epoch');

    assert.deepEqual(client.publishedAuthority(), { ownerId: room.ownerId, epoch: room.epoch });
    checks.push('published authority exposes the real lobby metadata record as a recovery hint');

    assert(events.some((event) => event.type === 'members' && event.ownerId === room.ownerId && event.epoch === room.epoch));
    checks.push('initial membership event includes the native owner and authority epoch');

    for (const invalid of ['', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32)]) {
      assert.throws(() => client.claimAuthority(invalid), TypeError);
    }
    assert.deepEqual(client.authority(), { ownerId: room.ownerId, epoch: room.epoch });
    checks.push('invalid epochs fail without changing the live lobby authority');

    const replacement = randomBytes(16).toString('hex');
    assert.notEqual(replacement, room.epoch);
    client.claimAuthority(replacement);
    assert.deepEqual(client.authority(), { ownerId: room.ownerId, epoch: replacement });
    assert.deepEqual(client.publishedAuthority(), { ownerId: room.ownerId, epoch: replacement });
    assert(events.some((event) => event.type === 'members' && event.ownerId === room.ownerId && event.epoch === replacement));
    checks.push('the real native owner replaces its epoch and publishes a changed membership event');

    await delay(100);
    const before = events.filter((event) => event.type === 'members').length;
    client.claimAuthority(replacement);
    await delay(100);
    assert.equal(events.filter((event) => event.type === 'members').length, before);
    checks.push('an unchanged epoch does not duplicate membership events during polling');

    const secondReplacement = randomBytes(16).toString('hex');
    client.claimAuthority(secondReplacement);
    assert.deepEqual(client.authority(), { ownerId: room.ownerId, epoch: secondReplacement });
    assert.deepEqual(client.publishedAuthority(), { ownerId: room.ownerId, epoch: secondReplacement });
    checks.push('a second authority rotation remains readable through the native SDK');

    client.leave();
    assert.deepEqual(client.members(), []);
    assert.throws(() => client.authority(), /requires membership/);
    assert.throws(() => client.publishedAuthority(), /requires membership/);
    checks.push('leaving removes local lobby authority access');

    const secondRoom = await client.create();
    assert.equal(secondRoom.ownerId, client.selfId);
    assert.match(/** @type {string} */ (secondRoom.epoch), /^[a-f0-9]{32}$/);
    assert.notEqual(secondRoom.epoch, secondReplacement);
    assert.deepEqual(client.authority(), { ownerId: secondRoom.ownerId, epoch: secondRoom.epoch });
    assert.deepEqual(client.publishedAuthority(), { ownerId: secondRoom.ownerId, epoch: secondRoom.epoch });
    checks.push('a separately created lobby has a fresh initial authority epoch');

    client.leave();
    assert.equal(events.filter((event) => event.type === 'error').length, 0);
    checks.push('the native SDK reported no connector errors during creation, rotation, and leave');
  } finally {
    client.dispose();
  }
  assert.throws(() => client.authority(), /disposed/);
  assert.throws(() => client.publishedAuthority(), /disposed/);
  assert.throws(() => client.claimAuthority(randomBytes(16).toString('hex')), /disposed/);
  checks.push('disposed connectors reject authority reads and claims');
  return { checks, membershipEvents: events.filter((event) => event.type === 'members').length };
}

/** @param {string} resultPath @returns {Promise<void>} */
async function worker(resultPath) {
  const startedAt = Date.now();
  try {
    const result = await smoke();
    fs.writeFileSync(resultPath, JSON.stringify({ status: 'passed', appId: 480, scope: 'single-account real Steam API only; cross-account owner handoff and non-owner rejection are not verified', ...result, elapsedMs: Date.now() - startedAt }, null, 2) + '\n');
    console.log(JSON.stringify({ event: 'steam-authority-native-passed', checks: result.checks.length, result: resultPath }));
  } catch (error) {
    fs.writeFileSync(resultPath, JSON.stringify({ status: 'failed', name: error instanceof Error ? error.name : 'NonErrorFailure', message: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - startedAt }, null, 2) + '\n');
    throw error;
  }
}

if (process.argv[2] === '--worker') {
  const resultPath = process.argv[3];
  assert.equal(typeof resultPath, 'string');
  worker(resultPath).then(() => process.exit(0), (error) => {
    console.error('Steam authority native smoke failed', { name: error instanceof Error ? error.name : 'NonErrorFailure', message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
} else {
  const directory = path.join(__dirname, '..', '.qa-tools', 'host-continuity', 'steam-authority-native', randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  const result = spawnSync(process.execPath, [__filename, '--worker', path.join(directory, 'result.json')], { encoding: 'utf8', timeout: 45000, windowsHide: true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Steam authority native subprocess failed; status=${result.status}, signal=${result.signal}`);
}
