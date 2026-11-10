// @ts-check

/** @typedef {{beginShortcutCapture:()=>Promise<{id:string}>,endShortcutCapture:(id:string)=>Promise<void>}} ShortcutCaptureBridge */

/** @param {KeyboardEvent} event @returns {string|null} */
export function shortcutAccelerator(event) {
  if (['Control','Shift','Alt','Meta','OS'].includes(event.key)) return null;
  if (event.isComposing || event.getModifierState('AltGraph')) throw new TypeError('请使用普通键盘按键，不能使用输入法或 AltGr');
  const modifiers = [event.ctrlKey ? 'Control' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', event.metaKey ? 'Super' : ''].filter(Boolean);
  const special = /** @type {{[key:string]:string}} */ ({ ' ':'Space', Enter:'Enter', Tab:'Tab', Home:'Home', End:'End', PageUp:'PageUp', PageDown:'PageDown', Insert:'Insert', ArrowUp:'Up', ArrowDown:'Down', ArrowLeft:'Left', ArrowRight:'Right', '+':'Plus' });
  const key = /^[A-Za-z0-9,./;'\[\]\\`=\-]$/.test(event.key) ? event.key.toUpperCase() : /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(event.key) ? event.key : special[event.key];
  if (!key) throw new TypeError('这个按键不支持全局快捷键，请换一个按键');
  return [...modifiers, key].join('+');
}

/** Capture actual keyboard input while the desktop owns a bounded suspension lease. @param {HTMLElement} control @param {ShortcutCaptureBridge} bridge @param {(message:string)=>void} feedback @returns {Promise<string|null>} */
export async function captureShortcut(control, bridge, feedback) {
  const lease = await bridge.beginShortcutCapture();
  if (typeof lease.id !== 'string' || !lease.id) throw new TypeError('桌面快捷键录入没有返回有效的会话');
  try {
    if (!control.isConnected || !document.hasFocus()) return null;
    let expired = false;
    const result = await new Promise(/** @param {(value:string|null)=>void} resolve */ resolve => {
      let pending = '', pendingCode = '', done = false;
      /** @param {string|null} value @returns {void} */
      function finish(value) {
        if (done) return;
        done = true; clearTimeout(timer); observer.disconnect();
        window.removeEventListener('keydown', keydown, true); window.removeEventListener('keyup', keyup, true); window.removeEventListener('blur', cancel);
        resolve(value);
      }
      /** @returns {void} */
      function cancel() { finish(null); }
      /** @param {KeyboardEvent} event @returns {void} */
      function keydown(event) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.repeat) return;
        if (event.key === 'Escape') { finish(null); return; }
        if (event.key === 'Backspace' || event.key === 'Delete') { pending = ''; pendingCode = ''; feedback('本版不支持清空全局快捷键；原值保留。按 Escape 取消或录入新按键。'); return; }
        try {
          const value = shortcutAccelerator(event);
          if (value) { pending = value; pendingCode = event.key.toUpperCase(); feedback(value + ' · 松开按键完成录入'); }
        } catch (error) { pending = ''; pendingCode = ''; feedback(error instanceof Error ? error.message : '按键无法识别'); }
      }
      /** @param {KeyboardEvent} event @returns {void} */
      function keyup(event) { event.preventDefault(); event.stopImmediatePropagation(); if (pending && event.key.toUpperCase() === pendingCode) finish(pending); }
      const observer = new MutationObserver(() => { if (!control.isConnected) finish(null); });
      const timer = setTimeout(() => { expired = true; finish(null); }, 20000);
      observer.observe(document.documentElement, { childList:true, subtree:true });
      window.addEventListener('keydown', keydown, true); window.addEventListener('keyup', keyup, true); window.addEventListener('blur', cancel);
      feedback('请按单键或组合键；Escape 取消；Backspace/Delete 不会清空原值');
    });
    if (expired) throw new DOMException('键盘录入超过 20 秒，原快捷键已保留', 'TimeoutError');
    return result;
  } finally { await bridge.endShortcutCapture(lease.id); }
}
