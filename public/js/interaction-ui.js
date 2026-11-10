// @ts-check

/** @typedef {{getSelfId:()=>string,getChannelId:()=>string|null,canThrow:(userId:string)=>boolean,onThrow:(userId:string,kind:string)=>void,reportError:(error:Error)=>void,getCatalog?:()=>import('./customization-protocol.js').CustomInteraction[],loadThumbnail?:import('./interaction-catalog.js').ThumbnailLoader}} InteractionCallbacks */
/** @typedef {{card:HTMLElement,userId:string,row:HTMLDivElement,button:HTMLButtonElement,events:AbortController}} CardControl */
/** @typedef {{decorateCard:(card:HTMLElement,userId:string)=>void,reconcile:()=>void,close:()=>void,destroy:()=>void}} InteractionUI */

/** @param {InteractionCallbacks} callbacks @returns {InteractionUI} */
export function createInteractionUI(callbacks) {
  const events = new AbortController();
  /** @type {Map<HTMLElement,CardControl>} */
  const controls = new Map();
  /** @type {CardControl|null} */
  let active = null;
  /** @type {string|null} */
  let channelId = null;
  let destroyed = false;
  const picker = document.createElement('div');
  picker.className = 'interaction-picker'; picker.id = 'interactionPicker'; picker.hidden = true;
  picker.dataset.testid = 'interaction-picker'; picker.setAttribute('role', 'menu'); picker.setAttribute('aria-label', '选择互动道具');
  /** @type {HTMLButtonElement[]} */
  const items = [];
  let catalogSignature = '';
  let pickerEvents = new AbortController();
  let thumbnailEvents = new AbortController();
  let thumbnailsStarted = false;
  /** @type {{image:HTMLImageElement,asset:import('./interaction-catalog.js').MediaMetadata}[]} */ const thumbnails = [];
  /** @type {import('./interaction-catalog.js').ThumbnailLease[]} */ const leases = [];
  /** @returns {void} */
  function releaseThumbnails() { thumbnailEvents.abort(); thumbnailsStarted = false; for (const lease of leases.splice(0)) lease.release(); for (const entry of thumbnails) entry.image.removeAttribute('src'); }
  /** @returns {void} */
  function loadThumbnails() {
    if (thumbnailsStarted || !callbacks.loadThumbnail) return;
    thumbnailsStarted = true; thumbnailEvents = new AbortController(); const signal = thumbnailEvents.signal;
    for (const entry of thumbnails) {
      callbacks.loadThumbnail(entry.asset, signal).then(lease => {
        if (signal.aborted) { lease.release(); return; }
        leases.push(lease); entry.image.src = lease.url;
      }).catch(error => { if (signal.aborted) return; if (!(error instanceof Error)) throw error; callbacks.reportError(error); });
    }
  }
  /** @returns {void} */
  function rebuild() {
    const catalog = callbacks.getCatalog?.() ?? [];
    const signature = JSON.stringify(catalog);
    if (catalogSignature === signature) return;
    releaseThumbnails(); pickerEvents.abort(); pickerEvents = new AbortController(); catalogSignature = signature; thumbnails.length = 0;
    picker.replaceChildren(); items.length = 0;
    for (const interaction of catalog) {
      const item = document.createElement('button'); item.type = 'button'; item.className = 'interaction-item';
      item.dataset.testid = `interaction-${interaction.id}`; item.setAttribute('role', 'menuitem');
      item.setAttribute('aria-label', interaction.name); item.title = interaction.name;
      const image = document.createElement('img'); image.alt = ''; image.width = 42; image.height = 42;
      if (interaction.thumbnail) thumbnails.push({ image, asset: interaction.thumbnail });
      else if ('scene' in interaction && interaction.scene) image.src = `assets/interactions/${interaction.scene.actors[0].model === 'fist' ? 'fist' : interaction.scene.actors[0].model === 'dollar' || interaction.scene.actors[0].model === 'wallet' ? 'dollar' : interaction.model === 'bomb' ? 'bomb' : 'poop'}.svg`;
      else if ('model' in interaction && interaction.model !== 'thumbnail') image.src = `assets/interactions/${interaction.model}.svg`;
      const name = document.createElement('span'); name.className = 'interaction-item-name'; name.textContent = interaction.name;
      item.append(image, name); picker.append(item); items.push(item);
      item.addEventListener('click', () => {
        const target = active;
        if (!target || !available(target) || callbacks.getChannelId() !== channelId) { close(); return; }
        try { callbacks.onThrow(target.userId, interaction.id); }
        catch (error) { if (!(error instanceof Error)) throw error; callbacks.reportError(error); }
      }, { signal: pickerEvents.signal });
    }
    if (!items.length) {
      const empty = document.createElement('p'); empty.dataset.testid = 'interaction-picker-empty'; empty.textContent = '当前没有互动道具'; picker.append(empty);
    }
    if (!picker.hidden) loadThumbnails();
  }
  rebuild(); document.body.append(picker);

  /** @param {CardControl} control @returns {boolean} */
  function available(control) {
    return control.card.isConnected && !control.card.closest('[hidden]') && control.card.getClientRects().length > 0
      && control.userId !== callbacks.getSelfId() && callbacks.getChannelId() !== null && callbacks.canThrow(control.userId);
  }

  /** @returns {void} */
  function close() {
    releaseThumbnails();
    active?.button.setAttribute('aria-expanded', 'false'); active = null; channelId = null;
    picker.hidden = true; delete picker.dataset.targetUser;
    for (const item of items) delete item.dataset.targetUser;
  }

  /** @returns {void} */
  function position() {
    if (!active) return;
    const anchor = active.button.getBoundingClientRect(); const bounds = picker.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0; const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth; const height = viewport?.height ?? window.innerHeight;
    const x = Math.max(left + 8, Math.min(anchor.right - bounds.width, left + width - bounds.width - 8));
    const preferredY = anchor.top - bounds.height - 8;
    const y = Math.max(top + 8, Math.min(preferredY >= top + 8 ? preferredY : anchor.bottom + 8, top + height - bounds.height - 8));
    picker.style.left = `${x}px`; picker.style.top = `${y}px`;
  }

  /** @param {CardControl} control @returns {void} */
  function remove(control) {
    if (active === control) close();
    control.events.abort(); control.row.remove(); controls.delete(control.card);
  }

  /** @param {HTMLElement} card @param {string} userId @returns {void} */
  function decorateCard(card, userId) {
    if (destroyed) return;
    const previous = controls.get(card);
    if (previous && previous.userId !== userId) remove(previous);
    if (userId === callbacks.getSelfId() || callbacks.getChannelId() === null || !callbacks.canThrow(userId)) {
      const stale = controls.get(card); if (stale) remove(stale); return;
    }
    const existing = controls.get(card);
    if (existing) { if (card.lastElementChild !== existing.row) card.append(existing.row); return; }
    const row = document.createElement('div'); row.className = 'interaction-card-actions';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'interaction-trigger';
    button.dataset.testid = 'interaction-trigger'; button.dataset.targetUser = userId;
    button.setAttribute('aria-label', '向这位成员投掷道具'); button.title = '投掷道具';
    button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-controls', picker.id); button.setAttribute('aria-expanded', 'false');
    button.innerHTML = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4 16 4-4 4 4-4 4zM13 11l6-6M15 5h4v4M5 7h4M7 5v4"/></svg>';
    row.append(button); card.append(row);
    const control = { card, userId, row, button, events: new AbortController() }; controls.set(card, control);
    button.addEventListener('click', event => {
      event.stopPropagation();
      if (active === control) { close(); return; }
      close(); if (!available(control)) return; rebuild();
      active = control; channelId = callbacks.getChannelId(); picker.dataset.targetUser = userId;
      for (const item of items) item.dataset.targetUser = userId;
      picker.hidden = false; loadThumbnails(); button.setAttribute('aria-expanded', 'true'); position(); items[0]?.focus();
    }, { signal: control.events.signal });
  }

  /** @returns {void} */
  function reconcile() {
    rebuild();
    for (const control of controls.values()) if (!available(control) || !control.card.contains(control.row)) remove(control);
    if (active && callbacks.getChannelId() !== channelId) close();
    position();
  }

  picker.addEventListener('keydown', event => {
    if (!items.length) return;
    const index = items.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    if (event.key === 'Tab') { const button = active?.button; close(); button?.focus(); return; }
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % items.length
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index + items.length - 1) % items.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); items[next].focus(); }
  }, { signal: events.signal });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !active) return;
    const button = active.button; event.preventDefault(); close(); button.focus();
  }, { signal: events.signal });
  document.addEventListener('pointerdown', event => {
    if (event.target instanceof Node && !picker.contains(event.target) && !active?.button.contains(event.target)) close();
  }, { signal: events.signal });
  document.addEventListener('focusin', event => {
    if (active && event.target instanceof Node && !picker.contains(event.target) && !active.button.contains(event.target)) close();
  }, { signal: events.signal });
  window.addEventListener('resize', reconcile, { signal: events.signal });
  window.addEventListener('scroll', reconcile, { capture: true, signal: events.signal });
  window.visualViewport?.addEventListener('resize', reconcile, { signal: events.signal });
  window.visualViewport?.addEventListener('scroll', reconcile, { signal: events.signal });

  /** @returns {void} */
  function destroy() {
    close(); destroyed = true; releaseThumbnails(); pickerEvents.abort(); events.abort(); for (const control of controls.values()) remove(control); picker.remove();
  }
  return { decorateCard, reconcile, close, destroy };
}
