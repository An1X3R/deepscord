// @ts-check
'use strict';
const { createServerTrust } = require('../desktop/server-trust.cjs');
const assert = require('node:assert/strict');
const address = process.argv[2];
const storePath = process.argv[3];
const mode = process.argv[4];
const trust = createServerTrust({ storePath, timeoutMs: 3000, requestConsent: async () => { throw new Error('CA validation must not request a self-signed exception'); }, logger: { warn: (message, fields) => console.warn(message, fields) } });
async function run() {
  if (mode === 'valid') {
    const result = await trust.prepareConnection(address);
    assert.deepEqual(result, { origin: address, fingerprint: null });
    trust.verifyCertificate(address, { hostname: '127.0.0.1', certificate: { data: '' } }, (code) => assert.equal(code, -3));
  } else {
    await assert.rejects(trust.prepareConnection(address), /ERR_TLS_CERT_ALTNAME_INVALID/);
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
