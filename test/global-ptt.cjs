// @ts-check
'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createGlobalPTT,parsePTTConfig,virtualKey } = require('../desktop/global-ptt.cjs');

/** @returns {Promise<void>} */
async function run() {
  assert.equal(virtualKey('Mouse4'), 5);
  assert.equal(virtualKey('Mouse5'), 6);
  assert.equal(virtualKey('F24'), 135);
  assert.throws(() => virtualKey('Control+V'), /unsupported/);
  assert.throws(() => parsePTTConfig({ connected:true,mode:'invalid',key:'KeyV' }), /requires/);
  assert.deepEqual(parsePTTConfig({ connected:true,mode:'ptt',key:'F24',extra:'stripped' }), { connected:true,mode:'ptt',key:'F24' });
  /** @type {import('../desktop/global-ptt.cjs').PTTState[]} */
  const states = [];
  const controller = createGlobalPTT({ onState:state => states.push(state) });
  /** @param {boolean} pressed @returns {Promise<void>} */
  async function key(pressed) {
    const source = 'using System.Runtime.InteropServices; public static class PTTProbe { [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra); }';
    const script = `Add-Type -TypeDefinition '${source}'; [PTTProbe]::keybd_event(135, 0, ${pressed ? 0 : 2}, [UIntPtr]::Zero)`;
    await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], { windowsHide:true,stdio:'pipe' });
      let stderr = '';
      child.stderr.setEncoding('utf8'); child.stderr.on('data', (/** @type {string} */ value) => { stderr += value; });
      const timer = setTimeout(() => { child.kill(); reject(new Error('F24 functional probe timed out after 10000 ms')); },10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(undefined); else reject(new Error(`F24 probe exited ${code}: ${stderr}`)); });
    });
  }
  /** @param {number} milliseconds @returns {Promise<void>} */
  function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve,milliseconds)); }
  /** @param {boolean} down @returns {Promise<void>} */
  async function expectState(down) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const last = states.at(-1);
      if (last?.error) throw new Error(last.error);
      if (last?.down === down) return;
      await delay(20);
    }
    assert.fail(`Global PTT did not reach down=${down}: ${JSON.stringify(states)}`);
  }
  try {
    controller.update({ connected:false,mode:'ptt',key:'F24' });
    assert.equal(states.length,0);
    await key(false);
    controller.update({ connected:true,mode:'ptt',key:'F24' });
    await delay(120);
    await key(true); await expectState(true);
    const count = states.length;
    for (let index = 0; index < 40; index += 1) controller.update({ connected:true,mode:'ptt',key:'F24' });
    assert.equal(states.length,count, 'Identical updates must preserve a held key without extra IPC');
    await key(false); await expectState(false);
    await key(true); await expectState(true);
    controller.update({ connected:true,mode:'vad',key:'F24' }); await expectState(false);
    controller.update({ connected:true,mode:'ptt',key:'F24' });
    await delay(120);
    assert.equal(states.at(-1)?.down,false, 'A held key across mode changes must require release');
    await key(false); await delay(40);
    await key(true); await expectState(true);
    assert.throws(() => controller.update({ connected:true,mode:'ptt',key:'InvalidKey' }), /unsupported/);
    await expectState(false);
    controller.update({ connected:true,mode:'ptt',key:'F24' });
    await key(false); await delay(40); await key(true); await expectState(true);
    controller.update({ connected:true,mode:'ptt',key:'F23' }); await expectState(false);
    controller.update({ connected:false,mode:'ptt',key:'F23' }); await expectState(false);
    assert(states.every(state => state.error === null));
    console.log('Global PTT passed: real native F24 down/up, same-key deduplication, VAD/disconnect/key-change release, held-key rearming, Mouse4/5 VK mapping.');
  } finally { controller.dispose(); await key(false); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
