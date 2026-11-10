// @ts-check
'use strict';
const { isIP } = require('node:net');
const { createHash, timingSafeEqual } = require('node:crypto');
/** @typedef {{tokens:number,at:number}} Bucket */
/** @typedef {{rate:number,burst:number}} Budget */
/** @typedef {{count:number,until:number,expires:number}} Failure */

/** @param {string} input @returns {string} */
function address(input) {
  const value = input.startsWith('::ffff:') ? input.slice(7) : input;
  if (!isIP(value)) throw new TypeError('Proxy configuration and forwarded clients require literal IP addresses');
  return value;
}

/** @param {string} input @returns {ReadonlySet<string>} */
function parseTrustedProxies(input) {
  if (input.length > 4096) throw new RangeError('Trusted proxy list exceeds 4096 characters');
  return new Set(input.trim() ? input.split(',').map(value=>address(value.trim())) : []);
}

/** @param {import('node:http').IncomingMessage} request @param {ReadonlySet<string>} trusted @returns {string} */
function clientAddress(request, trusted) {
  if (!request.socket.remoteAddress) throw new TypeError('Client connection has no source address');
  const remote = address(request.socket.remoteAddress);
  if (!trusted.has(remote)) return remote;
  const header = request.headers['x-forwarded-for'];
  if (header === undefined) return remote;
  if (typeof header !== 'string' || header.length > 1024) throw new TypeError('Trusted proxy supplied an invalid forwarded address header');
  const chain = header.split(',').map(value=>address(value.trim()));
  if (chain.length > 16) throw new RangeError('Forwarded address chain exceeds 16 hops');
  for (let index=chain.length-1; index>0; index--) if (!trusted.has(chain[index])) return chain[index];
  return chain[0];
}

/** @param {import('node:http').IncomingMessage} request @returns {boolean} */
function permittedUpgrade(request) {
  if (request.url !== '/ws' || request.method !== 'GET') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string' || origin.length > 4096 || typeof request.headers.host !== 'string') return false;
  let parsed;
  try { parsed = new URL(origin); } catch (error) { if (error instanceof TypeError) return false; throw error; }
  return parsed.origin === origin && (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.host === request.headers.host;
}

/** @param {Budget} budget @param {number} at @returns {Bucket} */
function initialBucket(budget, at) { return { tokens:budget.burst, at }; }

/** @param {Bucket} previous @param {Budget} budget @param {number} cost @param {number} at @returns {Bucket|null} */
function consumeBucket(previous, budget, cost, at) {
  const tokens = Math.min(budget.burst, previous.tokens + Math.max(0, at-previous.at)*budget.rate/1000);
  return tokens < cost ? null : { tokens:tokens-cost, at };
}

/** @param {number} at */
function createMessageBudget(at) {
  const limits = { bytes:{rate:8*1024*1024,burst:16*1024*1024}, messages:{rate:1000,burst:2000}, chat:{rate:5,burst:20}, management:{rate:10,burst:30} };
  const state = {bytes:initialBucket(limits.bytes,at),messages:initialBucket(limits.messages,at),chat:initialBucket(limits.chat,at),management:initialBucket(limits.management,at)};
  /** @param {number} bytes @param {number} now @returns {boolean} */
  function accept(bytes, now) {
    const nextBytes=consumeBucket(state.bytes,limits.bytes,bytes,now),nextMessages=consumeBucket(state.messages,limits.messages,1,now);
    if (!nextBytes || !nextMessages) return false;
    state.bytes=nextBytes;state.messages=nextMessages;return true;
  }
  /** @param {'chat'|'management'} kind @param {number} now @returns {boolean} */
  function action(kind, now) {
    const next=consumeBucket(state[kind],limits[kind],1,now);
    if (!next) return false;state[kind]=next;return true;
  }
  return {accept,action};
}

/** @param {string} expected @param {string} input @returns {boolean} */
function passwordMatches(expected, input) {
  return timingSafeEqual(createHash('sha256').update(expected).digest(),createHash('sha256').update(input).digest());
}

/** @param {number} maximum */
function createAuthLimiter(maximum) {
  /** @type {Map<string,Failure>} */ const entries=new Map();
  /** @param {number} at @returns {void} */
  function sweep(at) { for (const [key,value] of entries) if (value.expires<=at) entries.delete(key); }
  /** @param {string} key @param {number} at @returns {boolean} */
  function blocked(key,at) { const value=entries.get(key);if(value && value.expires<=at){entries.delete(key);return false;}return Boolean(value && value.until>at); }
  /** @param {string} key @param {number} at @returns {void} */
  function failure(key,at) {
    if (entries.size>=maximum) sweep(at);
    const old=entries.get(key);
    if (!old && entries.size>=maximum) throw new RangeError('Authentication failure tracking capacity reached; retry after expired entries are removed');
    const count=(old && old.expires>at ? old.count : 0)+1;
    entries.set(key,{count:count>=5?0:count,until:count>=5?at+60000:0,expires:at+60000});
  }
  /** @param {string} key @returns {void} */
  function success(key) { entries.delete(key); }
  return {blocked,failure,success,sweep,size:()=>entries.size};
}

/** @param {{maxBytes:number,maxFrames:number}} limits */
function createSendBudget(limits) {
  let bytes=0,frames=0;
  /** @param {number} size @returns {(()=>void)|null} */
  function reserve(size) {
    if(bytes+size>limits.maxBytes || frames>=limits.maxFrames)return null;
    bytes+=size;frames++;
    let released=false;
    return ()=>{if(released)return;released=true;bytes-=size;frames--;};
  }
  return {reserve,stats:()=>({bytes,frames})};
}

module.exports={parseTrustedProxies,clientAddress,permittedUpgrade,consumeBucket,createMessageBudget,passwordMatches,createAuthLimiter,createSendBudget};
