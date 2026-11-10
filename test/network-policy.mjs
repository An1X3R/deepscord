// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readNetworkPolicy, publicNetworkConfig, authenticatedNetworkConfig, NetworkPolicyError,
} from '../lib/network-policy.cjs';

const relayEnvironment = Object.freeze({
  ECHO_PASSWORD: 'test-access-password',
  ECHO_MEDIA_POLICY: 'relay-allowed',
  TURN_URL: 'turn:relay.example.com:3478?transport=udp,turns:relay.example.com:5349?transport=tcp',
  TURN_SECRET: 'test-relay-secret',
});

test('no environment preserves empty ICE and strips unrelated fields', () => {
  const policy = readNetworkPolicy({ UNRELATED_SECRET: 'never-public' });
  assert.deepEqual(policy, {
    networkMode: 'server', mediaPolicy: 'direct', stunUrls: [], turnUrls: [],
    turnSecret: '', turnTtlSeconds: 3600, requirePassword: false,
  });
  assert.deepEqual(authenticatedNetworkConfig(policy, 'u_1', 1700000000), {
    networkMode: 'server', mediaPolicy: 'direct', iceTransportPolicy: 'all', version: '1.0.0', iceServers: [], iceExpiresAt: null,
  });
});

test('direct host mode never supplies discovery or relay services', () => {
  const policy = readNetworkPolicy({ ECHO_NETWORK_MODE: 'direct' });
  assert.equal(authenticatedNetworkConfig(policy, 'u_1', 1700000000).iceServers.length, 0);
  assert.equal(publicNetworkConfig(policy).networkMode, 'direct');
  for (const extra of [
    { STUN_URL: 'stun:example.com' }, { STUN_URLS: 'stun:example.com' },
    { TURN_URL: 'turn:example.com' }, { TURN_SECRET: 'secret' },
    { TURN_TTL_SECONDS: '3600' }, { ECHO_MEDIA_POLICY: 'relay-only' },
  ]) {
    assert.throws(() => readNetworkPolicy({ ECHO_NETWORK_MODE: 'direct', ...extra }), NetworkPolicyError);
  }
});

test('server direct permits normalized STUN discovery only', () => {
  const policy = readNetworkPolicy({ STUN_URLS: 'STUN:EXAMPLE.COM:3478,stun:[2001:db8::1],stun:example.com:3478' });
  assert.deepEqual(authenticatedNetworkConfig(policy, 'u_1', 1700000000).iceServers, [
    { urls: 'stun:example.com:3478' }, { urls: 'stun:[2001:db8::1]' },
  ]);
  assert.deepEqual(readNetworkPolicy({ STUN_URL: 'stuns:example.com:5349' }).stunUrls, ['stuns:example.com:5349']);
  for (const extra of [{ TURN_URL: 'turn:example.com' }, { TURN_SECRET: 'secret' }, { TURN_TTL_SECONDS: '3600' }]) {
    assert.throws(() => readNetworkPolicy(extra), NetworkPolicyError);
  }
});

test('TURN REST credentials match the HMAC vector and are absent from public metadata', () => {
  const policy = readNetworkPolicy(relayEnvironment);
  assert.deepEqual(publicNetworkConfig(policy), {
    networkMode: 'server', mediaPolicy: 'relay-allowed', iceTransportPolicy: 'all', version: '1.0.0',
  });
  const config = authenticatedNetworkConfig(policy, 'user_123', 1700000000);
  assert.equal(config.iceExpiresAt, 1700003600);
  assert.equal(config.iceServers.length, 2);
  for (const server of config.iceServers) {
    assert.equal(server.username, '1700003600:user_123');
    assert.equal(server.credential, 'bJJ8Nl5L4PpUeiOVI47SllAt400=');
  }
  const refreshed = authenticatedNetworkConfig(policy, 'user_123', 1700000060);
  assert.notEqual(refreshed.iceServers[0].credential, config.iceServers[0].credential);
  assert.equal(refreshed.iceServers[0].username, '1700003660:user_123');
  assert.equal(JSON.stringify(config).includes(relayEnvironment.TURN_SECRET), false);
  assert.equal(JSON.stringify(publicNetworkConfig(policy)).includes('credential'), false);
});

test('relay-only selects browser relay enforcement and respects explicit TTL', () => {
  const policy = readNetworkPolicy({ ...relayEnvironment, ECHO_MEDIA_POLICY: 'relay-only', TURN_TTL_SECONDS: '60' });
  const config = authenticatedNetworkConfig(policy, 'u_1', 1700000000);
  assert.equal(config.iceTransportPolicy, 'relay');
  assert.equal(config.iceServers[0].username, '1700000060:u_1');
  assert.equal(readNetworkPolicy({ ...relayEnvironment, TURN_TTL_SECONDS: '86400' }).turnTtlSeconds, 86400);
});

test('relay refuses missing authentication, incomplete secrets, and static credentials', () => {
  for (const env of [
    { ...relayEnvironment, ECHO_PASSWORD: undefined },
    { ...relayEnvironment, ECHO_PASSWORD: '   ' },
    { ...relayEnvironment, TURN_URL: undefined },
    { ...relayEnvironment, TURN_SECRET: undefined },
    { ...relayEnvironment, TURN_SECRET: ' secret ' },
    { ...relayEnvironment, TURN_USERNAME: 'legacy' },
    { ...relayEnvironment, TURN_CREDENTIAL: 'legacy' },
  ]) {
    assert.throws(() => readNetworkPolicy(env), NetworkPolicyError);
  }
});

test('empty inherited ICE settings are unset; invalid modes and nonblank TTLs fail', () => {
  for (const field of ['ECHO_NETWORK_MODE', 'ECHO_MEDIA_POLICY']) {
    assert.throws(() => readNetworkPolicy({ [field]: '  ' }), NetworkPolicyError);
  }
  for (const field of ['STUN_URL', 'STUN_URLS', 'TURN_URL', 'TURN_SECRET', 'TURN_TTL_SECONDS', 'TURN_USERNAME', 'TURN_CREDENTIAL']) {
    assert.deepEqual(readNetworkPolicy({ [field]: '  ' }), readNetworkPolicy({}));
  }
  for (const ttl of ['0', '59', '86401', '1.5', '-1', '1e3', 'NaN']) {
    assert.throws(() => readNetworkPolicy({ ...relayEnvironment, TURN_TTL_SECONDS: ttl }), NetworkPolicyError);
  }
  assert.throws(() => readNetworkPolicy({ ECHO_NETWORK_MODE: 'p2p' }), NetworkPolicyError);
  assert.throws(() => readNetworkPolicy({ ECHO_MEDIA_POLICY: 'relay' }), NetworkPolicyError);
  assert.throws(() => readNetworkPolicy({ STUN_URL: 'stun:a.com', STUN_URLS: 'stun:b.com' }), NetworkPolicyError);
});

test('malformed ICE URLs and embedded credentials fail without leaking supplied values', () => {
  const malformed = [
    'https://relay.example.com', 'turn://relay.example.com', 'turn:user:password@relay.example.com',
    'turn:relay.example.com/path', 'turn:relay.example.com#fragment', 'turn:relay.example.com?x=y',
    'turn:relay.example.com:0', 'turn:relay.example.com:65536', 'turn:', 'turn:999.999.999.999',
    'turn:bad..example.com', 'turn:-bad.example.com', 'turn:[invalid]', 'turn:relay.example.com,',
    'turns:relay.example.com?transport=UDP', 'stun:relay.example.com', 'turn:relay.example.com?transport=sctp',
  ];
  for (const url of malformed) {
    assert.throws(() => readNetworkPolicy({ ...relayEnvironment, TURN_URL: url }), (error) => {
      assert.ok(error instanceof NetworkPolicyError);
      assert.equal(error.message.includes(url), false);
      assert.equal(error.field, 'TURN_URL');
      return true;
    });
  }
  for (const url of ['stun:example.com?transport=udp', 'turn:example.com', 'stun:example.com,']) {
    assert.throws(() => readNetworkPolicy({ STUN_URL: url }), NetworkPolicyError);
  }
});

test('credential issuance validates identity and integer timestamps', () => {
  const policy = readNetworkPolicy(relayEnvironment);
  for (const userId of ['', 'u:admin', 'u\nadmin', 'a'.repeat(129)]) {
    assert.throws(() => authenticatedNetworkConfig(policy, userId, 1700000000), NetworkPolicyError);
  }
  for (const time of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => authenticatedNetworkConfig(policy, 'u_1', time), NetworkPolicyError);
  }
});
