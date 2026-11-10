// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
/** @typedef {null|boolean|number|string|JsonValue[]|{[key:string]:JsonValue}} JsonValue */
/** @typedef {{[key:string]:JsonValue}} JsonObject */
const root = path.resolve(__dirname, '..');

/** @param {string} file @returns {JsonObject} */
function readObject(file) {
  const value = /** @type {JsonValue} */ (JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Expected a JSON object: ${file}`);
  return value;
}
/** @param {Buffer} content @returns {string} */
function sha256(content) { return crypto.createHash('sha256').update(content).digest('hex'); }
/** @param {string} file @param {string} expected @returns {Buffer} */
function pinnedLicense(file, expected) {
  const content = fs.readFileSync(path.join(root, file));
  if (sha256(content) !== expected) throw new Error(`Pinned upstream license changed: ${file}`);
  return content;
}
/** @param {string} title @param {string} source @param {Buffer} content @returns {Buffer} */
function section(title, source, content) {
  return Buffer.concat([Buffer.from(`\n${'='.repeat(78)}\n${title}\nSource: ${source}\nSHA256: ${sha256(content)}\n${'='.repeat(78)}\n\n`), content, Buffer.from('\n')]);
}
/** @param {string} name @param {string} version @returns {string} */
function packageDirectory(name, version) {
  const directory = path.join(root, 'node_modules', name);
  const metadata = readObject(path.join(directory, 'package.json'));
  if (metadata.name !== name || metadata.version !== version) throw new Error(`Installed license package differs from bundled dependency: ${name}@${version}`);
  return directory;
}
/** @param {string} name @param {string} version @returns {Buffer[]} */
function packageLicenses(name, version) {
  const directory = packageDirectory(name, version);
  const files = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && /^(?:LICENSE|LICENCE|NOTICE|COPYING|CopyrightNotice)(?:[.-].*)?$/i.test(entry.name));
  if (!files.length) throw new Error(`No license files found for bundled dependency: ${name}@${version}`);
  return files.sort((a, b) => a.name.localeCompare(b.name, 'en')).map((file) => section(`${name} ${version}`, `node_modules/${name}/${file.name}`, fs.readFileSync(path.join(directory, file.name))));
}

const sdkDirectory = packageDirectory('livekit-client', '2.23.0');
const bundle = fs.readFileSync(path.join(root, 'public/vendor/livekit-client.js'));
const upstream = fs.readFileSync(path.join(sdkDirectory, 'dist/livekit-client.esm.mjs'), 'utf8').replace(/^\/\/# sourceMappingURL=.*$/m, '');
if (!bundle.equals(Buffer.from(upstream))) throw new Error('Shipped browser bundle differs from the installed upstream ESM bundle');
const metadata = readObject(path.join(root, 'public/vendor/livekit-client.json'));
if (metadata.sha256 !== sha256(bundle) || metadata.version !== '2.23.0') throw new Error('Shipped browser bundle metadata is stale');
const map = readObject(path.join(sdkDirectory, 'dist/livekit-client.esm.mjs.map'));
if (!Array.isArray(map.sources) || !map.sources.every((source) => typeof source === 'string')) throw new TypeError('Upstream source map has no string source list');
/** @type {Map<string,string>} */ const dependencies = new Map();
for (const source of map.sources) {
  if (typeof source !== 'string') throw new TypeError('Invalid upstream source path');
  if (!source.includes('/node_modules/')) continue;
  const match = source.match(/\.pnpm\/(@?[^/]+)@([^/@]+)\/node_modules\//);
  if (!match) throw new Error(`Unrecognized bundled dependency source: ${source}`);
  const name = match[1].replace('+', '/');
  if (dependencies.has(name) && dependencies.get(name) !== match[2]) throw new Error(`Multiple bundled dependency versions require review: ${name}`);
  dependencies.set(name, match[2]);
}
const sdkMetadata = readObject(path.join(sdkDirectory, 'package.json'));
const declared = sdkMetadata.dependencies;
if (!declared || typeof declared !== 'object' || Array.isArray(declared)) throw new TypeError('LiveKit SDK dependency manifest is missing');
if (declared['@livekit/protocol'] !== '1.52.1' || declared.tslib !== '2.8.1' || !upstream.includes('proto3.makeMessageType("livekit.SignalRequest"') || !upstream.includes('Copyright (c) Microsoft Corporation.')) throw new Error('Generated protocol/tslib bundle provenance changed; review notices');
dependencies.set('@livekit/protocol', '1.52.1');
dependencies.set('tslib', '2.8.1');
/** @type {Buffer[]} */
const chunks = [Buffer.from(`LIVEKIT BROWSER BUNDLE THIRD-PARTY NOTICES\n\nArtifact: public/vendor/livekit-client.js\nArtifact SHA256: ${sha256(bundle)}\nUpstream: livekit-client 2.23.0 (unmodified ESM, source-map URL handling matches vendor script)\n\nBundled versions come from the upstream source map. Generated LiveKit protocol\nand TypeScript helper provenance is checked against the SDK manifest and bundle.\nThis list excludes server-only packages and type-only dependencies. License\nfiles and retained upstream source comments below are reproduced verbatim.\n\nBundled dependencies:\n${[...dependencies].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, version]) => `  ${name} ${version}`).join('\n')}\n`)];
chunks.push(...packageLicenses('livekit-client', '2.23.0'));
for (const [name, version] of [...dependencies].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
  if (name === 'jose') {
    if (version !== '6.2.12') throw new Error('The bundled jose version changed; acquire its exact upstream license');
    chunks.push(section('jose 6.2.12', 'https://raw.githubusercontent.com/panva/jose/v6.2.12/LICENSE.md (tools/license-sources/jose-6.2.12-LICENSE.md)', pinnedLicense('tools/license-sources/jose-6.2.12-LICENSE.md', '8078b0829d6c3e9ecde2f003e1966e4cad3efc6e7a640efbab0313cc166b1af1')));
  } else if (name === '@bufbuild/protobuf') {
    const directory = packageDirectory(name, version);
    if (version !== '1.10.1') throw new Error('The protobuf runtime version changed; review its Apache/BSD license texts');
    chunks.push(section(`${name} ${version}: Apache license`, 'https://raw.githubusercontent.com/bufbuild/protobuf-es/v1.10.1/LICENSE (tools/license-sources/protobuf-es-1.10.1-LICENSE)', pinnedLicense('tools/license-sources/protobuf-es-1.10.1-LICENSE', '6da19f017fad6716cbc9c938972ebee29957c295b8a4d51060dfb03da51d8502')));
    for (const file of ['dist/esm/private/assert.js', 'dist/esm/google/varint.js']) {
      const header = fs.readFileSync(path.join(directory, file), 'utf8').match(/^(?:\/\/[^\n]*\n)+/);
      if (!header || !header[0].includes('Copyright')) throw new Error(`Missing protobuf source license header: ${file}`);
      chunks.push(section(`${name} ${version}: retained source license`, `node_modules/${name}/${file} (leading comment)`, Buffer.from(header[0])));
    }
  } else chunks.push(...packageLicenses(name, version));
}
const debounceFile = 'node_modules/livekit-client/src/room/debounce.ts';
const debounce = fs.readFileSync(path.join(root, debounceFile), 'utf8').match(/^\/\*\*[\s\S]*?\*\//);
if (!debounce || !debounce[0].includes('MIT License') || !upstream.includes(debounce[0])) throw new Error('Vendored ts-debounce license comment changed');
chunks.push(section('ts-debounce-derived code (upstream does not identify a package version)', `${debounceFile} (retained complete leading comment)`, Buffer.from(debounce[0])));
const output = path.join(root, 'public/vendor/livekit-client-NOTICES.txt');
const content = Buffer.concat(chunks);
fs.writeFileSync(output, content);
console.log(JSON.stringify({ event: 'livekit_client_notices_generated', bundledDependencies: dependencies.size, output: path.relative(root, output), sha256: sha256(content) }));
