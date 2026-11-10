// @ts-check
import { createPokeUI } from './poke-ui.js';

/** @typedef {{id:string,name:string,kind:'screen'|'window',thumbnail:string}} ScreenSource */
/** @typedef {{pid:number,name:string,title:string}} AudioProcess */
/** @typedef {{id:string,name:string,self:boolean,screenSharing:boolean}} MemberMedia */
/** @typedef {{listScreens:()=>Promise<ScreenSource[]>,listProcesses:()=>Promise<AudioProcess[]>,startScreen:(id:string,signal:AbortSignal)=>Promise<void>,stopScreen:()=>Promise<void>,startMusic:(pid:number,signal:AbortSignal)=>Promise<void>,stopMusic:()=>Promise<void>,startGlobalMusic?:(signal:AbortSignal)=>Promise<void>,watch:(id:string)=>Promise<void>,stopWatching:(id:string)=>void,getScreenStream:(id:string)=>MediaStream|null,setPeerVolume:(id:string,value:number)=>void,getPeerVolume:(id:string)=>number,reportError:(error:Error)=>void,exportDiagnostics?:()=>Promise<void>,poke?:import('./poke-ui.js').PokeCallbacks}} MediaCallbacks */

/** @param {string} text @param {string} testId @returns {HTMLButtonElement} */
function button(text, testId) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'btn ghost small';
  node.textContent = text;
  node.dataset.testid = testId;
  return node;
}

/** @param {MediaCallbacks} callbacks */
export function createMediaUI(callbacks) {
  const toolbar = document.createElement('div');
  toolbar.className = 'media-toolbar';
  toolbar.dataset.testid = 'media-toolbar';
  const screen = button('共享画面', 'screen-start');
  const screenStop = button('停止共享', 'screen-stop');
  const music = button('伴奏', 'music-start');
  const musicStop = button('停止伴奏', 'music-stop');
  const diagnostics = button('导出屏幕诊断', 'screen-diagnostics');
  diagnostics.setAttribute('aria-label', '导出屏幕诊断');
  diagnostics.title = '采样约 4 秒，仅保存帧数与环境信息，不包含图像或音频';
  diagnostics.hidden = !callbacks.exportDiagnostics;
  let diagnosing = false;
  toolbar.append(screen, screenStop, music, musicStop, diagnostics);
  const poke = callbacks.poke ? createPokeUI(callbacks.poke, toolbar) : null;
  /** @type {Map<string,{shell:HTMLDivElement,video:HTMLVideoElement,status:HTMLParagraphElement,expand:HTMLButtonElement,card:HTMLElement,name:string,local:boolean}>} */
  const views = new Map();
  /** @type {Set<string>} */
  const watching = new Set();
  /** @type {string|null} */
  let expanded = null;
  /** @type {HTMLDialogElement|null} */
  let chooser = null;
  /** @type {AbortController|null} */
  let chooserController = null;

  /** @param {()=>Promise<void>} action @param {HTMLButtonElement} control */
  async function run(action, control) {
    control.disabled = true;
    try { await action(); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const loading = chooser?.querySelector('[data-testid="media-source-loading"]');
      if (loading) loading.textContent = '来源读取失败，请关闭后重试。';
      callbacks.reportError(error instanceof Error ? error : new TypeError(String(error)));
    }
    finally { control.disabled = false; }
  }

  /** @param {string} title @returns {{dialog:HTMLDialogElement,list:HTMLDivElement,signal:AbortSignal}} */
  function openChooser(title) {
    chooserController?.abort();
    chooser?.close();
    chooser?.remove();
    const controller = new AbortController();
    chooserController = controller;
    const dialog = document.createElement('dialog');
    dialog.className = 'media-chooser';
    dialog.dataset.testid = 'media-source-dialog';
    const heading = document.createElement('h2');
    heading.id = 'media-source-heading';
    heading.textContent = title;
    dialog.setAttribute('aria-labelledby', heading.id);
    const close = button('取消', 'media-source-cancel');
    close.addEventListener('click', () => { controller.abort(); dialog.close(); });
    dialog.addEventListener('cancel', () => controller.abort());
    const list = document.createElement('div');
    list.className = 'media-source-list';
    list.setAttribute('aria-live', 'polite');
    const loading = document.createElement('p');
    loading.dataset.testid = 'media-source-loading';
    loading.textContent = '正在读取可用来源…';
    list.append(loading);
    dialog.append(heading, list, close);
    const previous = document.activeElement;
    dialog.addEventListener('close', () => {
      controller.abort();
      if (chooserController === controller) chooserController = null;
      dialog.remove();
      if (chooser === dialog) chooser = null;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    }, { once: true });
    document.body.append(dialog);
    chooser = dialog;
    dialog.showModal();
    return { dialog, list, signal:controller.signal };
  }

  screen.addEventListener('click', () => {
    const { dialog, list, signal } = openChooser('选择共享的屏幕或窗口');
    void run(async () => {
      const sources = await callbacks.listScreens();
      if (!dialog.open) return;
      list.replaceChildren();
      if (!sources.length) list.textContent = '当前没有可共享的屏幕或窗口。';
      for (const source of sources) {
        const choice = button(source.name, 'screen-source');
        choice.dataset.sourceId = source.id;
        choice.className = 'media-source';
        if (source.thumbnail) {
          const preview = document.createElement('img');
          preview.src = source.thumbnail;
          preview.alt = '';
          choice.prepend(preview);
        }
        const kind = document.createElement('span');
        kind.className = 'media-source-kind';
        kind.textContent = source.kind === 'screen' ? '整个屏幕' : '窗口';
        choice.append(kind);
        choice.addEventListener('click', () => void run(async () => {
          await callbacks.startScreen(source.id, signal);
          dialog.close();
        }, choice));
        list.append(choice);
      }
    }, screen);
  });
  music.addEventListener('click', () => {
    const { dialog, list, signal } = openChooser('选择伴奏来源');
    void run(async () => {
      const processes = await callbacks.listProcesses();
      if (!dialog.open) return;
      list.replaceChildren();
      list.classList.add('process-source-list');
      const startGlobal = callbacks.startGlobalMusic;
      if (startGlobal) {
        const global = button('系统全部声音', 'music-source-global'); global.className = 'media-source process-source';
        const detail = document.createElement('span'); detail.className = 'media-source-kind'; detail.textContent = '排除 Deepscord 自身声音，避免通话回传；麦克风独立'; global.append(detail);
        global.addEventListener('click', () => void run(async () => { await startGlobal(signal); dialog.close(); }, global));
        list.append(global);
      }
      if (!processes.length && !startGlobal) list.textContent = '当前没有可用的音频进程，请先打开播放应用。';
      for (const process of processes) {
        const choice = button(process.title || process.name, 'music-source');
        choice.dataset.pid = String(process.pid);
        choice.className = 'media-source process-source';
        const detail = document.createElement('span');
        detail.className = 'media-source-kind';
        detail.textContent = `${process.name} · ${process.pid}`;
        choice.append(detail);
        choice.addEventListener('click', () => void run(async () => {
          await callbacks.startMusic(process.pid, signal);
          dialog.close();
        }, choice));
        list.append(choice);
      }
    }, music);
  });
  screenStop.addEventListener('click', () => void run(callbacks.stopScreen, screenStop));
  musicStop.addEventListener('click', () => void run(callbacks.stopMusic, musicStop));
  diagnostics.addEventListener('click', () => void run(async () => {
    if (!callbacks.exportDiagnostics) throw new DOMException('当前客户端不支持屏幕诊断导出', 'NotSupportedError');
    diagnosing = true; diagnostics.textContent = '正在采样…（4 秒）'; diagnostics.setAttribute('aria-busy', 'true');
    try { await callbacks.exportDiagnostics(); }
    finally { diagnosing = false; diagnostics.textContent = '导出屏幕诊断'; diagnostics.removeAttribute('aria-busy'); }
  }, diagnostics));

  function collapse() {
    if (!expanded) return;
    const view = views.get(expanded);
    expanded = null;
    if (!view) return;
    view.shell.classList.remove('media-expanded');
    view.expand.textContent = '放大';
    view.card.append(view.shell);
    view.expand.focus();
    poke?.reconcile();
  }

  /** @param {KeyboardEvent} event */
  function escape(event) { if (event.key === 'Escape' && expanded) { event.preventDefault(); collapse(); } }
  document.addEventListener('keydown', escape);

  /** @param {string} id */
  function stop(id) {
    watching.delete(id);
    callbacks.stopWatching(id);
    if (expanded === id) collapse();
    const view = views.get(id);
    if (view) {
      view.video.srcObject = null;
      view.shell.hidden = true;
      const watch = view.card.querySelector('[data-testid="screen-watch"]');
      if (watch instanceof HTMLButtonElement) watch.hidden = false;
    }
    poke?.reconcile();
  }

  /** @param {HTMLElement} card @param {MemberMedia} member */
  function decorateCard(card, member) {
    card.dataset.userId = member.id;
    card.classList.toggle('screen-sharing', member.screenSharing);
    if (!member.self && !card.querySelector('[data-testid="peer-volume"]')) {
      const volume = document.createElement('label');
      volume.className = 'peer-volume';
      const text = document.createElement('span');
      const slider = document.createElement('input');
      slider.type = 'range'; slider.min = '0'; slider.max = '200'; slider.step = '1';
      slider.value = String(callbacks.getPeerVolume(member.id));
      slider.dataset.testid = 'peer-volume'; slider.dataset.userId = member.id;
      slider.setAttribute('aria-label', `${member.name} 的音量`);
      text.textContent = `音量 ${slider.value}%`;
      slider.addEventListener('input', () => {
        callbacks.setPeerVolume(member.id, Number(slider.value));
        text.textContent = `音量 ${slider.value}%`;
      });
      volume.append(text, slider); card.append(volume);
    }
    let view = views.get(member.id);
    if (!member.screenSharing) { card.querySelector('[data-testid="screen-watch"]')?.remove(); if (watching.has(member.id)) stop(member.id); if (view) { poke?.remove(member.id); view.video.srcObject = null; view.shell.remove(); views.delete(member.id); } return; }
    if (!view) {
      const shell = document.createElement('div');
      shell.className = 'member-screen'; shell.dataset.testid = 'member-screen'; shell.dataset.userId = member.id; shell.hidden = true;
      const video = document.createElement('video');
      video.addEventListener('loadeddata',reconcile);
      video.autoplay = true; video.playsInline = true; video.muted = true; video.dataset.testid = 'screen-video';
      const status = document.createElement('p'); status.className = 'screen-status'; status.setAttribute('role', 'status');
      const controls = document.createElement('div'); controls.className = 'screen-controls';
      const name = document.createElement('span'); name.className = 'screen-owner'; name.textContent = member.name;
      const expand = button('放大', 'screen-expand');
      const stopButton = button('停止观看', 'screen-unwatch');
      expand.addEventListener('click', () => {
        if (expanded === member.id) { collapse(); return; }
        collapse();
        expanded = member.id;
        shell.classList.add('media-expanded'); expand.textContent = '收起';
        const app = document.getElementById('app');
        if (!app) throw new Error('Cannot expand screen: #app is missing.');
        app.append(shell); expand.focus();
        poke?.reconcile();
      });
      stopButton.addEventListener('click', () => stop(member.id));
      controls.append(name, expand, stopButton); shell.append(video, status, controls);
      view = { shell, video, status, expand, card, name: member.name, local: member.self };
      views.set(member.id, view);
      poke?.attach(member.id, view, controls);
    }
    view.card = card; view.name = member.name;
    const owner = view.shell.querySelector('.screen-owner'); if (owner) owner.textContent = member.name;
    if (expanded !== member.id && view.shell.parentElement !== card) card.append(view.shell);
    if (!card.querySelector('[data-testid="screen-watch"]')) {
      const watch = button(member.self ? '预览画面' : '观看画面', 'screen-watch');
      watch.classList.add('screen-watch'); watch.hidden = watching.has(member.id);
      watch.addEventListener('click', () => void run(async () => {
        await callbacks.watch(member.id);
        watching.add(member.id);
        watch.hidden = true;
        reconcile();
      }, watch));
      card.append(watch);
    }
  }

  /** @param {string} id */
  function removeMember(id) {
    stop(id);
    const view = views.get(id);
    if (view) { poke?.remove(id); view.video.srcObject = null; view.shell.remove(); views.delete(id); }
  }

  function reconcile() {
    for (const [id, view] of views) {
      if (!view.card.isConnected) { if (watching.has(id)) stop(id); poke?.remove(id); view.shell.remove(); views.delete(id); continue; }
      const stream = watching.has(id) ? callbacks.getScreenStream(id) : null;
      if (view.video.srcObject !== stream) view.video.srcObject = stream;
      view.shell.hidden = !watching.has(id);
      view.video.hidden = !stream;
      view.status.hidden = !!stream && view.video.readyState>=2;
      view.status.textContent = '正在接收共享画面…';
    }
    poke?.reconcile();
  }

  /** @param {{screenActive:boolean,musicActive:boolean,connected:boolean}} state */
  function renderToolbar(state) {
    document.addEventListener('keydown', escape);
    screen.hidden = state.screenActive; screenStop.hidden = !state.screenActive;
    music.hidden = state.musicActive; musicStop.hidden = !state.musicActive;
    screen.disabled = !state.connected; music.disabled = !state.connected;
    diagnostics.disabled = !state.connected || diagnosing;
    toolbar.hidden = !state.connected;
    toolbar.dataset.screenActive = String(state.screenActive); toolbar.dataset.musicActive = String(state.musicActive);
    poke?.reconcile();
    return toolbar;
  }
  function destroy() {
    poke?.destroy();
    for (const id of watching) callbacks.stopWatching(id);
    watching.clear();
    for (const view of views.values()) { view.video.srcObject = null; view.shell.remove(); }
    views.clear(); expanded = null; toolbar.remove(); chooserController?.abort(); chooser?.close(); chooser?.remove();
    document.removeEventListener('keydown', escape);
  }
  function diagnosticPreviews() { return [...views.values()].filter(view => view.video.srcObject instanceof MediaStream).map(view => ({ video: view.video, local: view.local })); }
  function reconcilePoke() { poke?.reconcile(); }
  /** @param {import('./screen-poke.js').PokeHit} hit */
  function showPoke(hit) { poke?.show(hit); }
  /** @param {string} targetUserId */
  function clearPokes(targetUserId) { poke?.clear(targetUserId); }
  return { renderToolbar, decorateCard, reconcile, removeMember, destroy, diagnosticPreviews, reconcilePoke, showPoke, clearPokes };
}

/** @param {HTMLButtonElement} control @param {{label:string,value:number,max:number,onChange:(value:number)=>Promise<void>,reportError:(error:Error)=>void}} options */
export function attachQuickVolume(control, options) {
  const wrap = document.createElement('div'); wrap.className = 'quick-volume';
  control.replaceWith(wrap); wrap.append(control);
  const panel = document.createElement('label'); panel.className = 'quick-volume-panel';
  const title = document.createElement('span'); title.textContent = options.label;
  const output = document.createElement('output'); output.textContent = `${options.value}%`;
  const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = String(options.max); slider.step = '1'; slider.value = String(options.value);
  slider.dataset.testid = options.max === 200 ? 'quick-mic-volume' : 'quick-output-volume'; slider.setAttribute('aria-label', options.label);
  slider.addEventListener('input', () => {
    const value = Number(slider.value); output.textContent = `${value}%`;
    void options.onChange(value).catch((error) => options.reportError(error instanceof Error ? error : new TypeError(String(error))));
  });
  panel.append(title, output, slider); wrap.append(panel);
}
