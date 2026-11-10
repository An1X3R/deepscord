/* 轻量 UI 组件：模态框 / 确认框 / 输入框 / Toast */

import { $, el } from './util.js';
import { icon } from './icons.js';

const modalRoot = () => document.getElementById('modalRoot');
const toastRoot = () => document.getElementById('toastRoot');

const modalStack = [];

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && modalStack.length) {
    const top = modalStack[modalStack.length - 1];
    if (!top.locked) {
      ev.stopPropagation();
      top.close();
    }
  }
});

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {Node|string} opts.body
 * @param {Node[]} [opts.footer]
 * @param {number} [opts.width]
 * @param {() => void} [opts.onClose]
 */
export function openModal({ title, body, footer = [], width = 560, onClose, locked = false }) {
  const closeBtn = el('button', { class: 'icon-btn modal-close', title: '关闭', 'aria-label': '关闭' });
  closeBtn.innerHTML = icon('close', 18);

  const bodyNode = el('div', { class: 'modal-body' });
  if (typeof body === 'string') bodyNode.innerHTML = body;
  else bodyNode.appendChild(body);

  const footNode = el('footer', { class: 'modal-foot' });
  for (const item of footer) footNode.appendChild(item);
  if (!footer.length) footNode.style.display = 'none';

  const card = el(
    'div',
    { class: 'modal', style: { '--modal-w': `${width}px` } },
    el(
      'header',
      { class: 'modal-head' },
      el('h2', {}, title),
      locked ? null : closeBtn
    ),
    bodyNode,
    footNode
  );

  const backdrop = el('div', { class: 'modal-backdrop' }, card);

  const entry = {
    close: () => close(),
    locked,
  };
  modalStack.push(entry);

  function close() {
    const idx = modalStack.indexOf(entry);
    if (idx >= 0) modalStack.splice(idx, 1);
    backdrop.classList.add('closing');
    setTimeout(() => {
      backdrop.remove();
      if (typeof onClose === 'function') onClose();
    }, 120);
  }

  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (ev) => {
    if (ev.target === backdrop && !locked) close();
  });

  modalRoot().appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('open'));

  // 自动聚焦第一个输入框
  setTimeout(() => {
    const input = bodyNode.querySelector('input, textarea, button.primary');
    if (input) input.focus();
  }, 60);

  return { close, card, body: bodyNode };
}

export function confirmDialog({ title, message, confirmText = '删除', danger = false }) {
  if(danger){
    if(window.deepscord?.confirmAction)return window.deepscord.confirmAction({title,message,acceptLabel:confirmText});
    return Promise.resolve(window.confirm(title+'\n\n'+message));
  }
  return new Promise((resolve) => {
    const okBtn = el(
      'button',
      { class: danger ? 'btn danger' : 'btn primary' },
      confirmText
    );
    const cancelBtn = el('button', { class: 'btn ghost' }, '取消');
    let done = false;
    const dlg = openModal({
      title,
      width: 420,
      body: el('p', { class: 'dialog-text' }, message),
      footer: [cancelBtn, okBtn],
      onClose: () => {
        if (!done) resolve(false);
      },
    });
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
      dlg.close();
    };
    okBtn.addEventListener('click', () => finish(true));
    cancelBtn.addEventListener('click', () => finish(false));
  });
}

export function promptDialog({ title, placeholder = '', value = '', submitText = '创建', maxlength = 24 }) {
  return new Promise((resolve) => {
    const input = el('input', {
      class: 'input',
      placeholder,
      value,
      maxlength: String(maxlength),
      autocomplete: 'off',
    });
    let done = false;
    const submitBtn = el('button', { class: 'btn primary' }, submitText);
    const cancelBtn = el('button', { class: 'btn ghost' }, '取消');
    const dlg = openModal({
      title,
      width: 460,
      body: el('div', { class: 'field' }, input),
      footer: [cancelBtn, submitBtn],
      onClose: () => {
        if (!done) resolve(null);
      },
    });
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
      dlg.close();
    };
    const submit = () => {
      const v = input.value.trim();
      if (!v) {
        input.classList.add('shake');
        setTimeout(() => input.classList.remove('shake'), 350);
        return;
      }
      finish(v);
    };
    submitBtn.addEventListener('click', submit);
    cancelBtn.addEventListener('click', () => finish(null));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submit();
      }
    });
    setTimeout(() => input.focus(), 80);
  });
}

export function toast(text, kind = 'info', duration = 3200) {
  const root = toastRoot();
  if (!root) return;
  const icons = { info: 'signal', success: 'check', error: 'close', warn: 'signal' };
  const node = el(
    'div',
    { class: `toast toast-${kind}` },
    el('span', { class: 'toast-ico', html: icon(icons[kind] || 'signal', 16) }),
    el('span', { class: 'toast-text' }, text)
  );
  root.appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));
  setTimeout(() => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 250);
  }, duration);
}

/** 右侧成员栏开关（窄屏） */
export function toggleMembersPanel(force) {
  const app = document.getElementById('app');
  if (!app) return;
  if (typeof force === 'boolean') app.classList.toggle('members-hidden', !force);
  else app.classList.toggle('members-hidden');
}
