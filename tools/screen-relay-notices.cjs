// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

/** @typedef {{name:string,version:string}} ModuleVersion */

const root = path.resolve(__dirname, '..');

/** @param {Buffer} value @returns {string} */
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

/** @param {string} title @param {string} source @param {Buffer} content @returns {Buffer} */
function section(title, source, content) {
  return Buffer.concat([Buffer.from(`\n${'='.repeat(78)}\n${title}\nSource: ${source}\nSHA256: ${sha256(content)}\n${'='.repeat(78)}\n\n`), content, Buffer.from('\n')]);
}

/** @param {string} directory @returns {string[]} */
function licenseFiles(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && /^(?:LICENSE|LICENCE|COPYING|NOTICE|PATENTS)(?:[.-].*)?$/i.test(entry.name)).map((entry) => entry.name);
  const auxiliary = entries.find((entry) => entry.isDirectory() && entry.name === 'LICENSES');
  if (auxiliary) {
    for (const entry of fs.readdirSync(path.join(directory, auxiliary.name), { withFileTypes: true })) {
      if (!entry.isFile()) throw new Error(`Nested license directory requires explicit review: ${directory}/${auxiliary.name}/${entry.name}`);
      files.push(`${auxiliary.name}/${entry.name}`);
    }
  }
  if (!files.some((file) => /^LICEN[CS]E(?:[.-]|$)/i.test(file))) throw new Error(`No primary license found: ${directory}`);
  return files.sort();
}

/** @param {string} goRoot @param {string} moduleCache @returns {void} */
function generate(goRoot, moduleCache) {
  const sourceDirectory = path.join(root, 'desktop/native/screen-relay');
  const binary = path.join(root, 'desktop/native/bin/screen-relay.exe');
  const goMod = fs.readFileSync(path.join(sourceDirectory, 'go.mod'));
  const declaration = goMod.toString('utf8');
  if (/^\s*(?:replace|exclude)\b/m.test(declaration)) throw new Error('go.mod replacements/exclusions require explicit notice resolution');
  const declared = new Map([...declaration.matchAll(/^\s+([^\s]+)\s+(v[^\s]+)(?:\s+\/\/ indirect)?\s*$/gm)].map((match) => [match[1], match[2]]));
  if (!declared.size) throw new Error('No pinned dependency versions found in screen relay go.mod');
  const goVersion = fs.readFileSync(path.join(goRoot, 'VERSION'), 'utf8').split(/\r?\n/)[0];
  const executable = path.join(goRoot, 'bin', process.platform === 'win32' ? 'go.exe' : 'go');
  const buildInfo = execFileSync(executable, ['version', '-m', binary], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off' } });
  if (!buildInfo.split(/\r?\n/)[0].endsWith(`: ${goVersion}`)) throw new Error('The native binary Go version differs from the explicit toolchain');
  if (!/^\tpath\tdeepscord\.desktop\/screen-relay$/m.test(buildInfo)) throw new Error('Unexpected native binary module identity');
  if (/^\t=>/m.test(buildInfo)) throw new Error('Native binary module replacements require explicit notice resolution');
  /** @type {ModuleVersion[]} */
  const modules = [...buildInfo.matchAll(/^\tdep\t([^\s]+)\t([^\s]+)\t[^\r\n]+/gm)].map((match) => ({ name: match[1], version: match[2] }));
  if (!modules.length) throw new Error('Native binary has no dependency build information');
  for (const module of modules) if (declared.get(module.name) !== module.version) throw new Error(`Native binary/go.mod version mismatch: ${module.name}@${module.version}`);
  if (modules.length !== declared.size) throw new Error('Native binary/go.mod module sets differ; review removed or test-only dependencies explicitly');
  /** @type {Buffer[]} */
  const chunks = [Buffer.from(`SCREEN RELAY THIRD-PARTY NOTICES\n\nArtifact: desktop/native/bin/screen-relay.exe\nArtifact SHA256: ${sha256(fs.readFileSync(binary))}\nGo toolchain: ${goVersion}\ngo.mod SHA256: ${sha256(goMod)}\n\nDependency versions are verified against the actual binary build information and go.mod.\nLicense files below are reproduced verbatim. Auxiliary SPDX texts may also cover\nmodule source files not linked into this executable.\n`)];
  for (const file of licenseFiles(goRoot)) chunks.push(section(`Go ${goVersion}`, `GoRoot/${file}`, fs.readFileSync(path.join(goRoot, file))));
  // Standard-library vendored modules have their own notices in the toolchain.
  const vendor = path.join(goRoot, 'src/vendor');
  const vendorManifest = fs.readFileSync(path.join(vendor, 'modules.txt'), 'utf8');
  for (const match of vendorManifest.matchAll(/^# (\S+) (v\S+)$/gm)) {
    for (const file of licenseFiles(path.join(vendor, match[1]))) chunks.push(section(`Go standard-library vendor: ${match[1]} ${match[2]}`, `GoRoot/src/vendor/${match[1]}/${file}`, fs.readFileSync(path.join(vendor, match[1], file))));
  }
  for (const module of modules.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const escaped = `${module.name}@${module.version}`.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
    const directory = path.join(moduleCache, escaped);
    for (const file of licenseFiles(directory)) chunks.push(section(`${module.name} ${module.version}`, `ModuleCache/${escaped}/${file}`, fs.readFileSync(path.join(directory, file))));
    if (module.name === 'github.com/pion/transport/v5') {
      const file = 'utils/xor/xor_generic.go';
      const content = fs.readFileSync(path.join(directory, file), 'utf8');
      const header = content.match(/^(?:\/\/[^\n]*\n)+/);
      if (!header || !header[0].includes('2013 The Go Authors') || !header[0].includes('BSD-3-Clause')) throw new Error('Pion XOR attribution changed; review the upstream license header');
      chunks.push(section(`${module.name} ${module.version}: XOR source attribution`, `ModuleCache/${escaped}/${file} (leading comment)`, Buffer.from(header[0])));
    }
  }
  const output = path.join(root, 'desktop/native/bin/screen-relay-NOTICES.txt');
  const content = Buffer.concat(chunks);
  fs.writeFileSync(output, content);
  console.log(JSON.stringify({ event: 'screen_relay_notices_generated', modules: modules.length, output: path.relative(root, output), sha256: sha256(content) }));
}

if (process.argv.length !== 4) throw new Error('Usage: node tools/screen-relay-notices.cjs <GoRoot> <ModuleCache>');
generate(path.resolve(process.argv[2]), path.resolve(process.argv[3]));
