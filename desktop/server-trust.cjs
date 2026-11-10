// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const net = require('node:net');
const { X509Certificate, randomUUID } = require('node:crypto');

/** @typedef {{origin:string, fingerprint:string}} Pin */
/** @typedef {{origin:string, fingerprint:string, subject:string, issuer:string, validFrom:string, validTo:string}} ConsentDetails */
/** @typedef {{hostname:string, certificate:{data:string}}} VerificationRequest */
/** @typedef {{storePath:string, timeoutMs:number, requestConsent:(details:ConsentDetails)=>Promise<boolean>, logger:{warn:(message:string, fields:{origin:string, code:string, attempt:number})=>void}}} Options */
/** @typedef {{certificate:X509Certificate, authorized:boolean, authorizationError:string}} Probe */
/** @typedef {{origin:string, fingerprint:string|null}} PreparedConnection */
const MAX_STORE_BYTES = 131072;
const MAX_PINS = 256;
const FINGERPRINT = /^[a-f0-9]{64}$/;

/** @param {string} code @param {string} message @returns {Error & {code:string}} */
function trustError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** @param {string} address @returns {string} */
function connectionOrigin(address) {
  const url = new URL(address);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost' || hostname === '::1' || (net.isIP(hostname) === 4 && hostname.startsWith('127.'));
  if (url.username || url.password) throw trustError('INVALID_SERVER_ORIGIN', 'Server URLs must not include credentials');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw trustError('INSECURE_SERVER_ORIGIN', `Server requires HTTPS; HTTP is only permitted for loopback: ${url.origin}`);
  }
  return url.origin;
}

/** @param {X509Certificate} certificate @returns {string} */
function fingerprint(certificate) {
  return certificate.fingerprint256.replaceAll(':', '').toLowerCase();
}

/** @param {X509Certificate} certificate @param {string} origin @returns {void} */
function requireCurrentCertificate(certificate, origin) {
  const now = Date.now();
  const start = Date.parse(certificate.validFrom);
  const end = Date.parse(certificate.validTo);
  if (!Number.isFinite(start) || !Number.isFinite(end) || now < start || now >= end) {
    throw trustError('CERTIFICATE_DATE_INVALID', `Certificate for ${origin} is outside its validity period: ${certificate.validFrom} — ${certificate.validTo}`);
  }
}

/** @param {string} storePath @returns {Map<string, Pin>} */
function readPins(storePath) {
  let serialized;
  try {
    const size = fs.statSync(storePath).size;
    if (size > MAX_STORE_BYTES) throw trustError('TRUST_STORE_INVALID', `Trust store exceeds ${MAX_STORE_BYTES} bytes: ${storePath}`);
    serialized = fs.readFileSync(storePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return new Map();
    throw error;
  }
  /** @type {{version?:number, pins?:Pin[]}} */
  const data = JSON.parse(serialized);
  if (!data || typeof data !== 'object' || data.version !== 1 || !Array.isArray(data.pins) || data.pins.length > MAX_PINS) {
    throw trustError('TRUST_STORE_INVALID', `Invalid certificate trust-store schema: ${storePath}`);
  }
  /** @type {Map<string, Pin>} */
  const pins = new Map();
  for (const pin of data.pins) {
    if (!pin || typeof pin !== 'object' || typeof pin.origin !== 'string' || typeof pin.fingerprint !== 'string' || !FINGERPRINT.test(pin.fingerprint)) {
      throw trustError('TRUST_STORE_INVALID', `Invalid certificate pin in ${storePath}`);
    }
    if (!pin.origin.startsWith('https://') || connectionOrigin(pin.origin) !== pin.origin || new URL(pin.origin).href !== pin.origin + '/' || pins.has(pin.origin)) {
      throw trustError('TRUST_STORE_INVALID', `Invalid or duplicate certificate origin in ${storePath}: ${pin.origin}`);
    }
    pins.set(pin.origin, { origin: pin.origin, fingerprint: pin.fingerprint });
  }
  return pins;
}

/** @param {string} storePath @param {Map<string, Pin>} pins @returns {void} */
function writePins(storePath, pins) {
  if (pins.size > MAX_PINS) throw trustError('TRUST_STORE_FULL', `Certificate trust store is limited to ${MAX_PINS} origins`);
  const serialized = JSON.stringify({ version: 1, pins: [...pins.values()] });
  if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw trustError('TRUST_STORE_FULL', 'Certificate trust store size limit reached');
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const temporary = storePath + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, storePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** @param {string} origin @param {number} timeoutMs @returns {Promise<Probe>} */
function probeCertificate(origin, timeoutMs) {
  const url = new URL(origin);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: hostname, port: Number(url.port || 443), servername: net.isIP(hostname) ? '' : hostname, rejectUnauthorized: false });
    const timer = setTimeout(() => socket.destroy(trustError('ETIMEDOUT', `TLS certificate probe timed out after ${timeoutMs} ms: ${origin}`)), timeoutMs);
    socket.once('error', reject);
    socket.once('close', () => clearTimeout(timer));
    socket.once('secureConnect', () => {
      try {
        const certificate = socket.getPeerX509Certificate();
        if (!certificate) throw trustError('CERTIFICATE_MISSING', `TLS peer did not provide a certificate: ${origin}`);
        resolve({ certificate, authorized: socket.authorized, authorizationError: String(socket.authorizationError || '') });
      } catch (error) { reject(error); }
      finally { socket.destroy(); }
    });
  });
}

/**
 * The caller must bind verification to an isolated session restricted to this exact origin.
 * Electron's certificate verifier supplies a hostname but no port.
 * @param {Options} options
 */
function createServerTrust(options) {
  if (!path.isAbsolute(options.storePath) || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60000) {
    throw trustError('INVALID_TRUST_OPTIONS', 'Certificate trust requires an absolute store path and a timeout between 1 and 60000 ms');
  }
  let pins = readPins(options.storePath);
  /** @type {Set<string>} */ const prepared = new Set();
  /** @type {Map<string, Promise<PreparedConnection>>} */ const pending = new Map();

  /** @param {string} origin @returns {Promise<PreparedConnection>} */
  async function prepare(origin) {
    if (origin.startsWith('http:')) { prepared.add(origin); return { origin, fingerprint: null }; }
    /** @type {Probe | null} */ let probe = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try { probe = await probeCertificate(origin, options.timeoutMs); break; }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string' || !['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.code) || attempt === 2) throw error;
        options.logger.warn('Retrying TLS certificate probe', { origin, code: error.code, attempt });
      }
    }
    if (!probe) throw trustError('CERTIFICATE_MISSING', `No TLS certificate obtained: ${origin}`);
    requireCurrentCertificate(probe.certificate, origin);
    const actual = fingerprint(probe.certificate);
    const existing = pins.get(origin);
    if (existing) {
      if (existing.fingerprint !== actual) throw trustError('CERTIFICATE_PIN_CHANGED', `Certificate changed for ${origin}; expected SHA-256 ${existing.fingerprint}, received ${actual}. Review the server certificate before explicitly clearing its old pin.`);
      prepared.add(origin);
      return { origin, fingerprint: actual };
    }
    if (probe.authorized) { prepared.add(origin); return { origin, fingerprint: null }; }
    if (probe.authorizationError !== 'DEPTH_ZERO_SELF_SIGNED_CERT' || probe.certificate.subject !== probe.certificate.issuer || !probe.certificate.verify(probe.certificate.publicKey)) {
      throw trustError('CERTIFICATE_UNTRUSTED', `TLS validation failed for ${origin}: ${probe.authorizationError}; SHA-256 ${actual}`);
    }
    const accepted = await options.requestConsent({ origin, fingerprint: actual, subject: probe.certificate.subject, issuer: probe.certificate.issuer, validFrom: probe.certificate.validFrom, validTo: probe.certificate.validTo });
    if (accepted !== true) throw trustError('CERTIFICATE_DECLINED', `Certificate trust was declined for ${origin}; SHA-256 ${actual}`);
    requireCurrentCertificate(probe.certificate, origin);
    const next = new Map(pins);
    next.set(origin, { origin, fingerprint: actual });
    writePins(options.storePath, next);
    pins = next;
    prepared.add(origin);
    return { origin, fingerprint: actual };
  }

  /** @param {string} address @returns {Promise<PreparedConnection>} */
  function prepareConnection(address) {
    const origin = connectionOrigin(address);
    const current = pending.get(origin);
    if (current) return current;
    const operation = prepare(origin).finally(() => pending.delete(origin));
    pending.set(origin, operation);
    return operation;
  }

  /** @param {string} origin @param {VerificationRequest} request @param {(result:number)=>void} callback @returns {void} */
  function verifyCertificate(origin, request, callback) {
    if (!prepared.has(origin)) { callback(-2); return; }
    const expectedHost = new URL(origin).hostname.replace(/^\[|\]$/g, '');
    if (request.hostname.replace(/^\[|\]$/g, '').toLowerCase() !== expectedHost) { callback(-2); return; }
    const pin = pins.get(origin);
    if (!pin) { callback(-3); return; }
    let result;
    try {
      const certificate = new X509Certificate(request.certificate.data);
      requireCurrentCertificate(certificate, origin);
      result = fingerprint(certificate) === pin.fingerprint ? 0 : -2;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      result = -2;
    }
    callback(result);
  }

  /** @param {string} origin @param {string} expectedFingerprint @returns {void} */
  function clearPin(origin, expectedFingerprint) {
    if (pending.has(origin)) throw trustError('TRUST_REVIEW_PENDING', `Certificate review is pending for ${origin}`);
    const pin = pins.get(origin);
    if (!pin || pin.fingerprint !== expectedFingerprint) throw trustError('CERTIFICATE_PIN_CHANGED', `Certificate pin does not match the explicit removal request for ${origin}`);
    const next = new Map(pins);
    next.delete(origin);
    writePins(options.storePath, next);
    pins = next;
    prepared.delete(origin);
  }

  return { prepareConnection, verifyCertificate, clearPin };
}

module.exports = { createServerTrust, connectionOrigin };

