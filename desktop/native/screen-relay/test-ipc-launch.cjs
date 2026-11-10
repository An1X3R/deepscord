// @ts-check
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--electron' || args[2] !== '--runtime' || !path.isAbsolute(args[1]) || !path.isAbsolute(args[3])) throw new TypeError('Pass --electron ABS_EXE --runtime ABS_NEW_RUNTIME_DIRECTORY');
const binary = args[1], destination = args[3], source = path.dirname(binary), entry = path.join(__dirname, 'test-ipc.cjs');
const relative = path.relative(source, destination);
if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('Runtime destination must be outside the original Electron directory');
const marker = path.join(destination, '.screen-relay-owner');
const identity = JSON.stringify({ source, entry });
if (!fs.existsSync(destination)) {
  fs.cpSync(source, destination, { recursive: true, filter: name => name !== path.join(source, 'resources', 'app.asar') && name !== path.join(source, 'resources', 'app') && !name.startsWith(path.join(source, 'resources', 'app') + path.sep) });
  fs.writeFileSync(marker, identity, { flag: 'wx' });
} else if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== identity) throw new Error('Existing runtime is not owned by this isolated screen relay test');
const application = path.join(destination, 'resources', 'app');
fs.mkdirSync(application, { recursive: true });
fs.writeFileSync(path.join(application, 'package.json'), JSON.stringify({ name: 'screen-relay-ipc-integration', version: '1.0.0', main: 'main.cjs' }));
fs.writeFileSync(path.join(application, 'main.cjs'), 'require(' + JSON.stringify(entry) + ');\n');
/** @type {NodeJS.ProcessEnv} */ const env = { ...process.env, SCREEN_RELAY_TEST_PROFILE: path.join(destination, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(destination, path.basename(binary)), [], { env, windowsHide: true, stdio: 'inherit' });
const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 45000);
child.once('error', error => { clearTimeout(timer); console.error('screen_relay_test_spawn_failed', { message: error.message }); process.exitCode = 1; });
child.once('exit', code => { clearTimeout(timer); process.exitCode = code === 0 ? 0 : 1; });
