// @ts-check
'use strict';

const { createPublicKey, verify } = require('node:crypto');
const { parseRoomDescriptor } = require('./room-replica.cjs');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{roomId:string,creatorKey:string,nonce:string,userId:string}} IdentityChallenge */

/** @param {JsonValue} value @returns {IdentityChallenge} */
function parseIdentityChallenge(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Identity challenge must be an object');
  const descriptor = parseRoomDescriptor({ version:1,roomId:value.roomId,creatorKey:value.creatorKey });
  if (typeof value.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(value.nonce)) throw new TypeError('Identity nonce must contain 32 random bytes');
  if (typeof value.userId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.userId)) throw new TypeError('Identity challenge must name its connection user');
  return { roomId:descriptor.roomId,creatorKey:descriptor.creatorKey,nonce:value.nonce,userId:value.userId };
}

/** @param {IdentityChallenge} challenge @returns {string} */
function identityPayload(challenge) {
  const parsed = parseIdentityChallenge(challenge);
  return JSON.stringify(['deepscord-identity-v1',parsed.roomId,parsed.creatorKey,parsed.nonce,parsed.userId]);
}

/** @param {IdentityChallenge} challenge @param {JsonValue} value @returns {string} */
function verifyIdentityProof(challenge, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Identity proof must be an object');
  if (value.nonce !== challenge.nonce) throw new TypeError('Identity proof belongs to another connection challenge');
  if (typeof value.memberKey !== 'string' || value.memberKey.length > 128 || typeof value.signature !== 'string' || value.signature.length > 128) throw new TypeError('Identity proof must contain a bounded key and signature');
  const bytes = Buffer.from(value.memberKey,'base64');
  if (bytes.length !== 44 || bytes.toString('base64') !== value.memberKey || !bytes.subarray(0,12).equals(Buffer.from('302a300506032b6570032100','hex'))) throw new TypeError('Identity public key is not canonical Ed25519');
  const key = createPublicKey({ key:bytes,format:'der',type:'spki' });
  const signature = Buffer.from(value.signature,'base64');
  if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || signature.toString('base64') !== value.signature || !verify(null,Buffer.from(identityPayload(challenge)),key,signature)) throw new TypeError('Identity signature is invalid for this server and connection');
  return value.memberKey;
}

module.exports = { parseIdentityChallenge,identityPayload,verifyIdentityProof };
