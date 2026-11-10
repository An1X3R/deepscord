// @ts-check
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const helper = path.join(__dirname, 'native', 'bin', 'process-audio.exe');
const output = path.join(root, '.qa-tools', 'process-capture');
const tone = path.join(output, 'tone.exe');
/** @typedef {import('./desktop-schema.cjs').JsonValue} JsonValue */
/** @typedef {import('node:child_process').ChildProcessWithoutNullStreams} Child */

/** @param {Child} child @returns {Promise<number|null>} */
function exited(child) {
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
}
/** @param {number} frequency @returns {Promise<Child>} */
async function startTone(frequency) {
  const child = spawn(tone, [String(frequency)], { windowsHide:true,stdio:'pipe' });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tone ${frequency} Hz did not start`)), 5000);
    child.once('error', reject);
    child.stderr.on('data', (data) => reject(new Error(String(data))));
    child.stdout.once('data', () => { clearTimeout(timer); resolve(undefined); });
  });
  return child;
}
/** @param {Buffer} pcm @param {number} frequency @returns {number} */
function amplitude(pcm, frequency) {
  const count = Math.floor(pcm.length / 4);
  let real = 0;
  let imaginary = 0;
  let weightSum = 0;
  for (let index = 0; index < count; index += 1) {
    // Window unrelated playback to avoid off-bin spectral leakage in system capture.
    const weight = 0.5 * (1 - Math.cos(2 * Math.PI * index / (count - 1)));
    weightSum += weight;
    const sample = weight * (pcm.readInt16LE(index * 4) + pcm.readInt16LE(index * 4 + 2)) / 65536;
    const phase = 2 * Math.PI * frequency * index / 48000;
    real += sample * Math.cos(phase);
    imaginary += sample * Math.sin(phase);
  }
  return 2 * Math.hypot(real, imaginary) / weightSum;
}
/** @param {Child} target @param {number} selected @param {number} excluded @param {'stdin'|'process-exit'} stop @param {'--capture'|'--capture-excluding'} command @returns {Promise<{pid:number,selectedHz:number,excludedHz:number,selectedAmplitude:number,excludedAmplitude:number,rejectionDb:number,bytes:number,events:JsonValue[],stop:string}>} */
async function capture(target, selected, excluded, stop, command) {
  assert(target.pid);
  const child = spawn(helper, [command, String(target.pid)], { windowsHide:true,stdio:'pipe' });
  const done = exited(child);
  /** @type {Buffer[]} */ const chunks = [];
  /** @type {JsonValue[]} */ const events = [];
  let diagnostics = '';
  const timer = setTimeout(() => child.kill(), 12000);
  try {
    child.stdout.on('data', (data) => chunks.push(Buffer.from(data)));
    await new Promise((resolve, reject) => {
      child.stderr.on('data', (data) => {
        diagnostics += String(data);
        let newline = diagnostics.indexOf('\n');
        while (newline !== -1) {
          /** @type {JsonValue} */ const event = JSON.parse(diagnostics.slice(0, newline));
          events.push(event);
          diagnostics = diagnostics.slice(newline + 1);
          if (event && typeof event === 'object' && !Array.isArray(event)) {
            if (event.event === 'ready') resolve(undefined);
            if (event.event === 'error') reject(new Error(JSON.stringify(event)));
          }
          newline = diagnostics.indexOf('\n');
        }
      });
      child.once('error', reject);
      child.once('close', (code) => reject(new Error(`Capture ended before ready: ${code}; events=${JSON.stringify(events)}`)));
    });
    await new Promise((resolve) => setTimeout(resolve, 2600));
    if (stop === 'stdin') child.stdin.end();
    else target.kill();
    const code = await done;
    assert.equal(code, 0, `Capture failed: ${JSON.stringify(events)}`);
    const pcm = Buffer.concat(chunks);
    assert.equal(pcm.length % 4, 0, 'PCM must contain complete s16 stereo frames');
    assert(pcm.length >= 192000, `Expected at least one second of PCM, got ${pcm.length}`);
    const selectedAmplitude = amplitude(pcm, selected);
    const excludedAmplitude = amplitude(pcm, excluded);
    const rejectionDb = 20 * Math.log10(selectedAmplitude / Math.max(excludedAmplitude, 1e-12));
    assert(selectedAmplitude > 0.001, `Selected tone is missing: ${selectedAmplitude}`);
    console.log('process_capture_measurement', { command, selectedAmplitude,excludedAmplitude,rejectionDb });
    assert(rejectionDb > 40, `Other process tone was not isolated: ${rejectionDb} dB`);
    assert(events.some((event) => event && typeof event === 'object' && !Array.isArray(event) && event.event === 'ended'));
    return { pid:target.pid,selectedHz:selected,excludedHz:excluded,selectedAmplitude,excludedAmplitude,rejectionDb,bytes:pcm.length,events,stop };
  } finally { clearTimeout(timer); child.kill(); }
}
/** @returns {Promise<void>} */
async function main() {
  execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname, 'build-test-tone.ps1')], { stdio:'inherit' });
  const first = await startTone(431);
  const second = await startTone(997);
  try {
    /** @type {JsonValue} */ const raw = JSON.parse(execFileSync(helper, ['--list'], { encoding:'utf8',windowsHide:true,timeout:10000 }));
    assert(Array.isArray(raw));
    const own = raw.filter((item) => item && typeof item === 'object' && !Array.isArray(item) && [first.pid,second.pid].includes(Number(item.pid)));
    assert.equal(own.length, 2, 'Both real native playback processes must appear in the audio process list');
    const firstCapture = await capture(first, 431, 997, 'stdin', '--capture');
    const globalCapture = await capture(first, 997, 431, 'stdin', '--capture-excluding');
    const secondCapture = await capture(second, 997, 431, 'process-exit', '--capture');
    /** @type {{pid:string,code:number|null,event:JsonValue}[]} */ const invalid = [];
    for (const pid of ['0','4294967294']) {
      const child = spawn(helper, ['--capture',pid], { windowsHide:true,stdio:'pipe' });
      let error = '';
      child.stderr.on('data', (data) => { error += String(data); });
      const code = await exited(child);
      assert.equal(code, 1);
      /** @type {JsonValue} */ const event = JSON.parse(error.trim());
      assert(event && typeof event === 'object' && !Array.isArray(event) && event.event === 'error');
      invalid.push({ pid,code,event });
    }
    const report = { testedAt:new Date().toISOString(),toneAmplitudeDbFS:-40,ownProcesses:own,captures:[firstCapture,globalCapture,secondCapture],invalid };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { first.kill(); second.kill(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
