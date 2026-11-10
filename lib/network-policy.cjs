// @ts-check
'use strict';

const { createHmac } = require('node:crypto');
const { isIP } = require('node:net');

/** @typedef {'server' | 'direct'} NetworkMode */
/** @typedef {'direct' | 'relay-allowed' | 'relay-only'} MediaPolicy */
/** @typedef {Readonly<Record<string, string | undefined>>} Environment */
/** @typedef {{networkMode: NetworkMode, mediaPolicy: MediaPolicy, stunUrls: string[], turnUrls: string[], turnSecret: string, turnTtlSeconds: number, requirePassword: boolean}} NetworkPolicy */
/** @typedef {{urls: string, username?: string, credential?: string}} IceServer */
/** @typedef {{networkMode: NetworkMode, mediaPolicy: MediaPolicy, iceTransportPolicy: 'all' | 'relay', version: '1.0.0'}} PublicNetworkConfig */
/** @typedef {PublicNetworkConfig & {iceServers: IceServer[], iceExpiresAt: number | null}} AuthenticatedNetworkConfig */

class NetworkPolicyError extends Error {
  /** @param {string} field @param {string} reason */
  constructor(field, reason) {
    super(`Invalid network configuration: ${field} ${reason}`);
    this.name = 'NetworkPolicyError';
    this.field = field;
  }
}

/** @param {Environment} env @param {string} field @returns {string | undefined} */
function optionalValue(env, field) {
  const value = env[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new NetworkPolicyError(field, 'must be nonempty when configured; remove it to leave it unset.');
  }
  return value.trim();
}

/** @param {Environment} env @param {string} field @returns {string | undefined} */
function optionalIceValue(env, field) {
  const value = env[field];
  if (value === undefined || (typeof value === 'string' && value.trim() === '')) return undefined;
  return optionalValue(env, field);
}

/** @param {string} host @returns {boolean} */
function validHost(host) {
  if (host.startsWith('[') && host.endsWith(']')) return isIP(host.slice(1, -1)) === 6;
  if (isIP(host) === 4) return true;
  if (/^[\d.]+$/.test(host)) return false;
  return host.length <= 253 && host.split('.').every((label) =>
    /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label));
}

/** @param {string} value @param {string} field @param {ReadonlyArray<string>} schemes @returns {string[]} */
function parseUrls(value, field, schemes) {
  return [...new Set(value.split(',').map((part) => {
    const url = part.trim();
    const match = /^(stun|stuns|turn|turns):((?:\[[a-f\d:.]+\])|[^:/?#@\s]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i.exec(url);
    if (!match || !schemes.includes(match[1].toLowerCase()) || !validHost(match[2])) {
      throw new NetworkPolicyError(field, 'must contain comma-separated ICE URLs with a valid scheme and host, without credentials or paths.');
    }
    const scheme = match[1].toLowerCase();
    const transport = match[4]?.toLowerCase();
    const port = match[3] === undefined ? undefined : Number(match[3]);
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      throw new NetworkPolicyError(field, 'contains a port outside 1..65535.');
    }
    if ((scheme === 'stun' || scheme === 'stuns') && transport !== undefined) {
      throw new NetworkPolicyError(field, 'STUN URLs cannot include a transport query.');
    }
    if (scheme === 'turns' && transport === 'udp') {
      throw new NetworkPolicyError(field, 'turns URLs must use TCP transport.');
    }
    return scheme + ':' + match[2].toLowerCase() + (port === undefined ? '' : ':' + port) +
      (transport === undefined ? '' : '?transport=' + transport);
  }))];
}

/**
 * TURN credentials expire after 3600 seconds unless explicitly configured (60..86400).
 * Only recognized environment fields are included in the returned policy.
 * @param {Environment} env
 * @returns {NetworkPolicy}
 */
function readNetworkPolicy(env) {
  const networkMode = optionalValue(env, 'ECHO_NETWORK_MODE') ?? 'server';
  const mediaPolicy = optionalValue(env, 'ECHO_MEDIA_POLICY') ?? 'direct';
  if (networkMode !== 'server' && networkMode !== 'direct') {
    throw new NetworkPolicyError('ECHO_NETWORK_MODE', 'must be server or direct.');
  }
  if (mediaPolicy !== 'direct' && mediaPolicy !== 'relay-allowed' && mediaPolicy !== 'relay-only') {
    throw new NetworkPolicyError('ECHO_MEDIA_POLICY', 'must be direct, relay-allowed, or relay-only.');
  }
  for (const field of ['TURN_USERNAME', 'TURN_CREDENTIAL']) {
    if (optionalIceValue(env, field) !== undefined) {
      throw new NetworkPolicyError(field, 'is no longer supported; remove static credentials and configure TURN_SECRET with coturn use-auth-secret.');
    }
  }
  const stunList = optionalIceValue(env, 'STUN_URLS');
  const stunSingle = optionalIceValue(env, 'STUN_URL');
  if (stunList !== undefined && stunSingle !== undefined) {
    throw new NetworkPolicyError('STUN_URLS/STUN_URL', 'cannot both be configured; choose one.');
  }
  const turnUrl = optionalIceValue(env, 'TURN_URL');
  const turnSecret = optionalIceValue(env, 'TURN_SECRET');
  const ttl = optionalIceValue(env, 'TURN_TTL_SECONDS');
  if (ttl !== undefined && (!/^\d+$/.test(ttl) || Number(ttl) < 60 || Number(ttl) > 86400)) {
    throw new NetworkPolicyError('TURN_TTL_SECONDS', 'must be an integer in 60..86400 seconds.');
  }
  const stunValue = stunList ?? stunSingle;
  if (networkMode === 'direct' && (mediaPolicy !== 'direct' || stunValue !== undefined ||
      turnUrl !== undefined || turnSecret !== undefined || ttl !== undefined)) {
    throw new NetworkPolicyError('ECHO_NETWORK_MODE=direct', 'requires media policy direct and no STUN or TURN settings.');
  }
  if (mediaPolicy === 'direct' && (turnUrl !== undefined || turnSecret !== undefined || ttl !== undefined)) {
    throw new NetworkPolicyError('ECHO_MEDIA_POLICY=direct', 'does not permit TURN settings; select relay-allowed or relay-only explicitly.');
  }
  const requirePassword = typeof env.ECHO_PASSWORD === 'string' && env.ECHO_PASSWORD.trim().length > 0;
  if (mediaPolicy !== 'direct') {
    if (!requirePassword) {
      throw new NetworkPolicyError('ECHO_PASSWORD', 'is required for relay policies to protect relay bandwidth.');
    }
    if (turnUrl === undefined || turnSecret === undefined) {
      throw new NetworkPolicyError('TURN_URL/TURN_SECRET', 'are both required for relay policies.');
    }
    if (turnSecret !== env.TURN_SECRET) {
      throw new NetworkPolicyError('TURN_SECRET', 'must not contain surrounding whitespace.');
    }
  }
  return {
    networkMode, mediaPolicy,
    stunUrls: stunValue === undefined ? [] : parseUrls(stunValue, 'STUN_URLS/STUN_URL', ['stun', 'stuns']),
    turnUrls: turnUrl === undefined ? [] : parseUrls(turnUrl, 'TURN_URL', ['turn', 'turns']),
    turnSecret: turnSecret ?? '',
    turnTtlSeconds: ttl === undefined ? 3600 : Number(ttl),
    requirePassword,
  };
}

/** @param {NetworkPolicy} policy @returns {PublicNetworkConfig} */
function publicNetworkConfig(policy) {
  return {
    networkMode: policy.networkMode,
    mediaPolicy: policy.mediaPolicy,
    iceTransportPolicy: policy.mediaPolicy === 'relay-only' ? 'relay' : 'all',
    version: '1.0.0',
  };
}

/**
 * Call only after successful application authentication.
 * @param {NetworkPolicy} policy @param {string} userId @param {number} nowSeconds
 * @returns {AuthenticatedNetworkConfig}
 */
function authenticatedNetworkConfig(policy, userId, nowSeconds) {
  if (typeof userId !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(userId)) {
    throw new NetworkPolicyError('userId', 'must be a 1..128 character ASCII identifier containing letters, digits, underscores, or hyphens.');
  }
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0 || !Number.isSafeInteger(nowSeconds + policy.turnTtlSeconds)) {
    throw new NetworkPolicyError('nowSeconds', 'must be a nonnegative safe integer timestamp.');
  }
  const username = `${nowSeconds + policy.turnTtlSeconds}:${userId}`;
  const iceServers = [
    ...policy.stunUrls.map((urls) => ({ urls })),
    ...policy.turnUrls.map((urls) => ({
      urls, username,
      credential: createHmac('sha1', policy.turnSecret).update(username).digest('base64'),
    })),
  ];
  return {
    ...publicNetworkConfig(policy), iceServers,
    iceExpiresAt: policy.turnUrls.length === 0 ? null : nowSeconds + policy.turnTtlSeconds,
  };
}

module.exports = { readNetworkPolicy, publicNetworkConfig, authenticatedNetworkConfig, NetworkPolicyError };
