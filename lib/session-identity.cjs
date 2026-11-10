// @ts-check
'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');

/** @typedef {'secret_length' | 'user_id' | 'timestamp' | 'token_format' | 'token_version' | 'token_user_id' | 'token_expiry' | 'token_signature' | 'token_expired'} SessionTokenErrorCode */

const TOKEN_VERSION = 'v1';
const TOKEN_LIFETIME_SECONDS = 86400;
const MAX_TOKEN_LENGTH = 256;

class SessionTokenError extends Error {
  /** @param {SessionTokenErrorCode} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'SessionTokenError';
    this.code = code;
  }
}

/** @param {Buffer} secret */
function validateSecret(secret) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) {
    throw new SessionTokenError('secret_length', 'Session secret must be exactly 32 bytes.');
  }
}

/** @param {string} userId */
function validateUserId(userId) {
  if (typeof userId !== 'string' || userId.length < 1 || userId.length > 80 || !/^[A-Za-z0-9_-]+$/.test(userId)) {
    throw new SessionTokenError('user_id', 'User ID must be 1 to 80 safe ASCII characters.');
  }
}

/** @param {number} nowSeconds */
function validateTimestamp(nowSeconds) {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new SessionTokenError('timestamp', 'Timestamp must be a nonnegative safe integer.');
  }
}

/** @param {string} payload @param {Buffer} secret @returns {Buffer} */
function signPayload(payload, secret) {
  return createHmac('sha256', secret).update(payload, 'ascii').digest();
}

/** @param {Buffer} secret @param {string} userId @param {number} nowSeconds @returns {string} */
function issueResumeToken(secret, userId, nowSeconds) {
  validateSecret(secret);
  validateUserId(userId);
  validateTimestamp(nowSeconds);
  const expiry = nowSeconds + TOKEN_LIFETIME_SECONDS;
  if (!Number.isSafeInteger(expiry)) {
    throw new SessionTokenError('timestamp', 'Timestamp is too large to encode a session expiry.');
  }
  const payload = `${TOKEN_VERSION}.${userId}.${expiry}`;
  const signature = signPayload(payload, secret).toString('hex');
  return `${payload}.${signature}`;
}

/** @param {Buffer} secret @param {string} token @param {number} nowSeconds @returns {string} */
function verifyResumeToken(secret, token, nowSeconds) {
  validateSecret(secret);
  validateTimestamp(nowSeconds);
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new SessionTokenError('token_format', 'Resume token must be a nonempty string within the size limit.');
  }

  const parts = token.split('.');
  if (parts.length !== 4) {
    throw new SessionTokenError('token_format', 'Resume token must contain four fields.');
  }
  const [version, userId, expiryText, signatureText] = parts;
  if (version !== TOKEN_VERSION) {
    throw new SessionTokenError('token_version', 'Resume token version is unsupported.');
  }
  if (userId.length < 1 || userId.length > 80 || !/^[A-Za-z0-9_-]+$/.test(userId)) {
    throw new SessionTokenError('token_user_id', 'Resume token contains an invalid user ID.');
  }
  if (!/^(0|[1-9][0-9]*)$/.test(expiryText)) {
    throw new SessionTokenError('token_expiry', 'Resume token expiry must be a canonical integer.');
  }
  const expiry = Number(expiryText);
  if (!Number.isSafeInteger(expiry)) {
    throw new SessionTokenError('token_expiry', 'Resume token expiry is outside the safe integer range.');
  }
  if (!/^[a-f0-9]{64}$/.test(signatureText)) {
    throw new SessionTokenError('token_signature', 'Resume token signature encoding is invalid.');
  }

  const payload = `${version}.${userId}.${expiryText}`;
  const expected = signPayload(payload, secret);
  const provided = Buffer.from(signatureText, 'hex');
  if (!timingSafeEqual(expected, provided)) {
    throw new SessionTokenError('token_signature', 'Resume token signature is invalid.');
  }
  if (expiry <= nowSeconds) {
    throw new SessionTokenError('token_expired', 'Resume token has expired.');
  }
  if (expiry - nowSeconds > TOKEN_LIFETIME_SECONDS) {
    throw new SessionTokenError('token_expiry', 'Resume token expiry exceeds the maximum lifetime.');
  }
  return userId;
}

module.exports = { SessionTokenError, issueResumeToken, verifyResumeToken };
