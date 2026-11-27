// @ts-check
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
/** @typedef {import('./desktop-schema.cjs').JsonValue} JsonValue */
/** @typedef {{connected:boolean,mode:'ptt'|'vad',key:string}} PTTConfig */
/** @typedef {{down:boolean,error:string|null}} PTTState */

/** @param {string} code @returns {number} */
function virtualKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return 111 + Number(code.slice(1));
  if (/^Numpad[0-9]$/.test(code)) return 96 + Number(code.slice(6));
  const keys = /** @type {{[key:string]:number}} */ ({ Mouse4:5,Mouse5:6,Backspace:8,Tab:9,Enter:13,NumpadEnter:13,ShiftLeft:160,ShiftRight:161,ControlLeft:162,ControlRight:163,AltLeft:164,AltRight:165,Pause:19,CapsLock:20,Escape:27,Space:32,PageUp:33,PageDown:34,End:35,Home:36,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Insert:45,Delete:46,MetaLeft:91,MetaRight:92,ContextMenu:93,NumpadMultiply:106,NumpadAdd:107,NumpadSubtract:109,NumpadDecimal:110,NumpadDivide:111,NumLock:144,ScrollLock:145,Semicolon:186,Equal:187,Comma:188,Minus:189,Period:190,Slash:191,Backquote:192,BracketLeft:219,Backslash:220,BracketRight:221,Quote:222 });
  const key = keys[code];
  if (!key) throw new TypeError(`Global PTT key "${code}" is unsupported; choose a keyboard key or Mouse4/Mouse5`);
  return key;
}
/** @param {JsonValue} value @returns {PTTConfig} */
function parsePTTConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.connected !== 'boolean' || (value.mode !== 'ptt' && value.mode !== 'vad') || typeof value.key !== 'string' || value.key.length > 40) throw new TypeError('Global PTT requires connected:boolean, mode:ptt|vad and a key code of at most 40 characters');
  virtualKey(value.key);
  return { connected:value.connected,mode:value.mode,key:value.key };
}
/** @param {{onState:(state:PTTState)=>void}} options */
function createGlobalPTT(options) {
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams|null} */
  let child = null;
  /** @type {NodeJS.Timeout|null} */
  let watchdog = null;
  let configured = '', disposed = false, down = false;
  /** @returns {void} */
  function stop() {
    const previous = child;
    const notify = down || previous !== null || configured !== '';
    child = null;
    if (watchdog) clearInterval(watchdog);
    watchdog = null; configured = ''; down = false;
    if (notify) options.onState({ down:false,error:null });
    if (previous) { previous.stdin.end(); previous.kill(); }
  }
  /** @param {JsonValue} input @returns {void} */
  function update(input) {
    if (disposed) throw new Error('Global PTT has been disposed');
    /** @type {PTTConfig} */
    let config;
    try { config = parsePTTConfig(input); }
    catch (error) { stop(); throw error; }
    const target = config.connected && config.mode === 'ptt' ? config.key : '';
    if (target === configured) return;
    stop();
    if (!target) return;
    if (process.platform !== 'win32') throw new Error('Global PTT requires Windows');
    configured = target;
    const executable = path.join(__dirname, 'native', 'bin', 'global-ptt.exe');
    const worker = spawn(executable, [String(virtualKey(target))], { windowsHide:true,stdio:['pipe','pipe','pipe'] });
    child = worker;
    let pending = '', stderr = '', lastMessage = Date.now();
    /** @param {Error} error @returns {void} */
    function fail(error) {
      if (child !== worker) return;
      stop(); configured = target;
      console.error('global_ptt_failed', { executable,key:target,message:error.message,stderr });
      options.onState({ down:false,error:error.message });
    }
    worker.stdin.on('error', error => fail(error));
    worker.on('error', error => fail(error));
    worker.once('exit', (code, signal) => fail(new Error(`Global PTT helper exited (code=${code}, signal=${signal}, key=${target}, stderr=${stderr})`)));
    worker.stderr.setEncoding('utf8'); worker.stderr.on('data', (/** @type {string} */ chunk) => { stderr = (stderr + chunk).slice(-2048); });
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', (/** @type {string} */ chunk) => {
      if (child !== worker) return;
      if (chunk.length + pending.length > 1024) { fail(new Error('Global PTT helper output exceeded 1024 bytes')); return; }
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1);
        if (!['UP','DOWN','PING'].includes(line)) { fail(new Error(`Global PTT helper sent invalid state: ${line.slice(0,80)}`)); return; }
        lastMessage = Date.now();
        if (line !== 'PING' && down !== (line === 'DOWN')) { down = line === 'DOWN'; options.onState({ down,error:null }); }
        newline = pending.indexOf('\n');
      }
    });
    watchdog = setInterval(() => { if (Date.now() - lastMessage > 4000) fail(new Error(`Global PTT helper stopped responding for 4000 ms (key=${target})`)); }, 1000);
  }
  /** @returns {void} */
  function dispose() { stop(); disposed = true; }
  return { update,stop,dispose };
}
module.exports = { createGlobalPTT,parsePTTConfig,virtualKey };
