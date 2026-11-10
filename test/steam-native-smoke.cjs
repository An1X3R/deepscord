// @ts-check
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { SteamClient } = require('../desktop/steam-client.cjs');

/** @returns {Promise<void>} */
async function smoke() {
  /** @type {import('../desktop/steam-client.cjs').SteamEvent[]} */
  const events = [];
  const client = new SteamClient(480, (event) => events.push(event));
  try {
    await assert.rejects(client.join('480'), TypeError);
    const room = await client.create();
    assert.match(room.lobbyId, /^[1-9][0-9]+$/);
    assert.equal(room.ownerId, client.selfId);
    assert.deepEqual(client.members(), [client.selfId]);
    assert.equal(events.some((event) => event.type === 'members'), true);
    assert.throws(() => client.send(client.selfId, Buffer.alloc(32769)), RangeError);
    assert.throws(() => client.send(client.selfId, Buffer.from('self')), /not a remote member/);
    await assert.rejects(client.join(room.lobbyId), /Leave the current Steam lobby/);
    client.leave();
    assert.deepEqual(client.members(), []);
    const second = await client.create();
    assert.equal(second.ownerId, client.selfId);
    client.leave();
    assert.deepEqual(client.members(), []);
    assert.equal(events.filter((event) => event.type === 'error').length, 0);
    console.log('Steam native smoke passed', { appId: 480, lobbyCreated: true, recreatedLobby: true, leftLobby: true });
  } finally {
    client.dispose();
  }
  assert.throws(() => client.members(), /disposed/);
}

if (process.argv.includes('--worker')) {
  smoke().then(() => process.exit(0), (error) => {
    console.error('Steam native smoke failed', { message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
} else {
  const result = spawnSync(process.execPath, [__filename, '--worker'], { encoding: 'utf8', timeout: 30000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Steam native smoke subprocess failed; status=${result.status}, signal=${result.signal}`);
}
