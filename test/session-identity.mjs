// @ts-check
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import identity from '../lib/session-identity.cjs';

const { SessionTokenError, issueResumeToken, verifyResumeToken } = identity;
const SECRET = Buffer.from('0123456789abcdef0123456789abcdef', 'ascii');
const OTHER_SECRET = Buffer.from('fedcba9876543210fedcba9876543210', 'ascii');
const NOW = 1_800_000_000;

/** @param {() => void} action @param {string} code */
function expectTokenError(action, code) {
  assert.throws(action, /** @param {Error} error */ (error) => {
    assert.ok(error instanceof SessionTokenError);
    assert.equal(error.code, code);
    return true;
  });
}

/** @param {string} payload @param {Buffer} secret @returns {string} */
function tokenWithPayload(payload, secret) {
  const signature = createHmac('sha256', secret).update(payload, 'ascii').digest('hex');
  return `${payload}.${signature}`;
}

test('issues and verifies a signed resume token for the existing user ID form', () => {
  const token = issueResumeToken(SECRET, 'u-0123456789', NOW);
  assert.equal(verifyResumeToken(SECRET, token, NOW), 'u-0123456789');
  assert.equal(token.split('.')[2], String(NOW + 86400));
});

test('rejects tampered user ID, expiry, and signature', () => {
  const token = issueResumeToken(SECRET, 'u-0123456789', NOW);
  const [version, userId, expiry, signature] = token.split('.');
  expectTokenError(() => verifyResumeToken(SECRET, `${version}.u-9876543210.${expiry}.${signature}`, NOW), 'token_signature');
  expectTokenError(() => verifyResumeToken(SECRET, `${version}.${userId}.${Number(expiry) + 1}.${signature}`, NOW), 'token_signature');
  const alteredSignature = `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`;
  expectTokenError(() => verifyResumeToken(SECRET, `${version}.${userId}.${expiry}.${alteredSignature}`, NOW), 'token_signature');
});

test('rejects tokens signed by another secret and expired tokens', () => {
  const token = issueResumeToken(SECRET, 'u-0123456789', NOW);
  expectTokenError(() => verifyResumeToken(OTHER_SECRET, token, NOW), 'token_signature');
  expectTokenError(() => verifyResumeToken(SECRET, token, NOW + 86400), 'token_expired');
});

test('rejects malformed, oversized, and unsupported tokens', () => {
  expectTokenError(() => verifyResumeToken(SECRET, 'not-a-token', NOW), 'token_format');
  expectTokenError(() => verifyResumeToken(SECRET, 'x'.repeat(257), NOW), 'token_format');
  expectTokenError(() => verifyResumeToken(SECRET, 'v2.u-0123456789.1800086400.' + '0'.repeat(64), NOW), 'token_version');
  expectTokenError(() => verifyResumeToken(SECRET, tokenWithPayload('v1.bad$id.1800086400', SECRET), NOW), 'token_user_id');
  expectTokenError(() => verifyResumeToken(SECRET, tokenWithPayload(`v1.u-0123456789.${NOW + 86401}`, SECRET), NOW), 'token_expiry');
  expectTokenError(() => verifyResumeToken(SECRET, 'v1.u-0123456789.1800086400.' + 'g'.repeat(64), NOW), 'token_signature');
});

test('rejects invalid secrets, IDs, and timestamps during issuance and verification', () => {
  expectTokenError(() => issueResumeToken(randomBytes(31), 'u-0123456789', NOW), 'secret_length');
  expectTokenError(() => issueResumeToken(SECRET, 'bad.id', NOW), 'user_id');
  expectTokenError(() => issueResumeToken(SECRET, 'x'.repeat(81), NOW), 'user_id');
  expectTokenError(() => issueResumeToken(SECRET, 'u-0123456789', 1.5), 'timestamp');
  expectTokenError(() => issueResumeToken(SECRET, 'u-0123456789', Number.MAX_SAFE_INTEGER), 'timestamp');
  expectTokenError(() => verifyResumeToken(SECRET, 'v1.u-0123456789.1800086400.' + '0'.repeat(64), -1), 'timestamp');
});
