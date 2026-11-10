// @ts-check
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const executable = path.resolve(process.env.DEEPSCORD_GO_EXECUTABLE || path.join(root, '.qa-tools', 'go-toolchain', 'go', 'bin', 'go.exe'));
const moduleCache = path.resolve(process.env.DEEPSCORD_GO_MODULE_CACHE || path.join(root, '.qa-tools', 'go-mod-cache'));
const buildCache = path.resolve(process.env.DEEPSCORD_GO_BUILD_CACHE || path.join(root, '.qa-tools', 'go-build-cache'));
if (!fs.existsSync(executable) || !fs.existsSync(moduleCache)) throw new Error('Screen relay build requires the pinned local Go toolchain and module cache. Configure DEEPSCORD_GO_EXECUTABLE and DEEPSCORD_GO_MODULE_CACHE explicitly when stored elsewhere.');
fs.mkdirSync(buildCache, { recursive: true });
const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'build-screen-relay.ps1'), '-GoExecutable', executable, '-ModuleCache', moduleCache, '-BuildCache', buildCache], { cwd: root, windowsHide: true, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Screen relay build failed with exit status ${result.status}`);
const notices = spawnSync(process.execPath, [path.join(__dirname, 'screen-relay-notices.cjs'), path.dirname(path.dirname(executable)), moduleCache], { cwd: root, windowsHide: true, stdio: 'inherit' });
if (notices.error) throw notices.error;
if (notices.status !== 0) throw new Error(`Screen relay license collection failed with exit status ${notices.status}`);
