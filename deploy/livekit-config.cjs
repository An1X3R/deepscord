'use strict';
// @ts-check
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { readScreenPolicy } = require('../lib/screen-sfu.cjs');

/** @param {string|undefined} raw @param {string} name @returns {number} */
function port(raw, name) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new TypeError(`${name} must be an explicit integer port from 1024 to 65535`);
  return value;
}

/** @param {NodeJS.ProcessEnv} env @returns {string} */
function liveKitConfig(env) {
  const policy = readScreenPolicy(env);
  if (policy.mode !== 'sfu') throw new TypeError('Set ECHO_SCREEN_MODE=sfu before starting the independent screen SFU');
  const nodeIp = env.LIVEKIT_NODE_IP || '';
  if (!net.isIP(nodeIp)) throw new TypeError('LIVEKIT_NODE_IP must be this server public IP (or its reachable LAN IP for LAN-only deployment)');
  const udpPort = port(env.LIVEKIT_UDP_PORT, 'LIVEKIT_UDP_PORT');
  const tcpPort = port(env.LIVEKIT_TCP_PORT, 'LIVEKIT_TCP_PORT');
  const signalingPort = Number(new URL(policy.internalUrl).port);
  if (new Set([udpPort, tcpPort, signalingPort]).size !== 3) throw new TypeError('LiveKit signaling, UDP and TCP ports must be different');
  return [
    `port: ${signalingPort}`, 'bind_addresses: [127.0.0.1]',
    'rtc:', `  node_ip: ${JSON.stringify(nodeIp)}`, '  use_external_ip: false',
    `  udp_port: ${udpPort}`, `  tcp_port: ${tcpPort}`, '  enable_loopback_candidate: true',
    'room:', '  auto_create: true', '  empty_timeout: 60', '  departure_timeout: 0',
    '  enabled_codecs:', '    - mime: video/vp8',
    'keys:', `  ${JSON.stringify(policy.apiKey)}: ${JSON.stringify(policy.apiSecret)}`,
    'logging:', '  level: info', '  json: true', '  pion_level: error', '',
  ].join('\n');
}

/** @returns {void} */
function main() {
  const action = process.argv[2];
  const target = process.argv[3];
  if (!target) throw new TypeError('Specify init <server.env> or config <private-output.yaml>');
  if (action === 'init') {
    if (!fs.statSync(target).isFile()) throw new TypeError('Initialize the standalone server.env before adding SFU keys');
    const existing = fs.readFileSync(target, 'utf8');
    if (/^LIVEKIT_API_(KEY|SECRET)=.+$/m.test(existing)) throw new Error('server.env already has LiveKit credentials; retain the existing keys');
    const additions = `\nLIVEKIT_API_KEY=deepscord_${crypto.randomBytes(12).toString('hex')}\nLIVEKIT_API_SECRET=${crypto.randomBytes(48).toString('hex')}\n`;
    fs.appendFileSync(target, additions, { mode: 0o600 });
    console.log(JSON.stringify({ event: 'livekit-private-keys-created', configuration: path.resolve(target) }));
    return;
  }
  if (action !== 'config') throw new TypeError('LiveKit configuration action must be init or config');
  const config = liveKitConfig(process.env);
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, config, { mode: 0o600 });
}

if (require.main === module) main();
module.exports = { liveKitConfig };
