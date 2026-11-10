// @ts-check
'use strict';
const http = require('node:http');
const https = require('node:https');

/** @typedef {{stationName:string,trackTitle:string|null,format:'hls'|'audio',metadataAvailable:boolean}} RadioMetadata */
/** @param {string} input @returns {URL} */
function radioUrl(input) {
  if (typeof input !== 'string' || input.length > 4096) throw new TypeError('Radio URL must be an HTTP(S) URL of at most 4096 characters');
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Radio URL requires HTTP(S) without embedded credentials');
  url.hash = '';
  return url;
}
/** @param {URL} url @returns {string} */
function address(url) { return url.origin + url.pathname; }
/** @param {URL} url @param {AbortSignal} signal @param {number} redirects @returns {Promise<http.IncomingMessage>} */
async function response(url, signal, redirects) {
  const result = await new Promise(/** @param {(value:http.IncomingMessage)=>void} resolve */ (resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal, headers: { 'Icy-MetaData': '1', 'User-Agent': 'Deepscord-Radio/1.0', Accept: 'audio/*,application/vnd.apple.mpegurl,application/x-mpegURL' },
    }, resolve);
    request.on('error', reject);
  });
  const incoming = /** @type {http.IncomingMessage} */ (result);
  const status = incoming.statusCode || 0;
  if ([301,302,303,307,308].includes(status)) {
    incoming.destroy();
    if (redirects >= 4 || !incoming.headers.location) throw new Error(`Radio redirect limit or missing Location: ${address(url)}; status=${status}`);
    return response(radioUrl(new URL(incoming.headers.location, url).href), signal, redirects + 1);
  }
  if (status !== 200) { incoming.destroy(); throw new Error(`Radio request failed: ${address(url)}; status=${status}`); }
  return incoming;
}
/** @param {http.IncomingMessage} incoming @returns {RadioMetadata} */
function headers(incoming) {
  const contentType = String(incoming.headers['content-type'] || '').toLowerCase();
  const format = /mpegurl/.test(contentType) ? 'hls' : 'audio';
  if (!contentType.startsWith('audio/') && format !== 'hls' && !contentType.startsWith('application/ogg') && !contentType.startsWith('application/octet-stream')) {
    throw new TypeError(`Radio response is not an audio stream or HLS playlist; content-type=${contentType || '(missing)'}`);
  }
  return { stationName: String(incoming.headers['icy-name'] || '').slice(0,256), trackTitle: null, format, metadataAvailable: Number(incoming.headers['icy-metaint']) > 0 };
}
/** @param {string} input @param {AbortSignal} cancellation @returns {Promise<RadioMetadata>} */
async function inspectRadioStation(input, cancellation) {
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(10000)]);
  const incoming = await response(radioUrl(input), signal, 0);
  try { return headers(incoming); } finally { incoming.destroy(); }
}
/** @param {string} input @param {AbortSignal} cancellation @returns {Promise<RadioMetadata>} */
async function readRadioMetadata(input, cancellation) {
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(12000)]);
  const incoming = await response(radioUrl(input), signal, 0);
  try {
    const info = headers(incoming);
    if (!info.metadataAvailable || info.format === 'hls') return info;
    const interval = Number(incoming.headers['icy-metaint']);
    if (!Number.isSafeInteger(interval) || interval < 1 || interval > 262144) throw new RangeError(`Invalid or excessive ICY metadata interval: ${interval}`);
    let bytes = Buffer.alloc(0);
    for await (const chunk of incoming) {
      if (!Buffer.isBuffer(chunk)) throw new TypeError('Radio stream returned a non-binary chunk');
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 524288) throw new RangeError('Radio metadata read exceeded 512 KiB');
      if (bytes.length <= interval) continue;
      const length = bytes[interval] * 16;
      if (bytes.length < interval + 1 + length) continue;
      const block = bytes.subarray(interval + 1, interval + 1 + length);
      const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(block);
      const text = utf8.includes('\uFFFD') ? new TextDecoder('windows-1252').decode(block) : utf8;
      const title = /StreamTitle='([\s\S]*?)';/.exec(text)?.[1]?.replace(/\0/g,'').trim();
      return { ...info, trackTitle: title ? title.slice(0,1024) : null };
    }
    throw new Error('Radio stream ended before the first ICY metadata block');
  } finally { incoming.destroy(); }
}

/** @typedef {{ipcMain:Electron.IpcMain,assertSender:(event:Electron.IpcMainInvokeEvent)=>void,access:import('./radio-access.cjs').RadioAccess}} RadioIpcOptions */
/** @param {RadioIpcOptions} options @returns {void} */
function registerRadioMetadataIpc(options) {
  /** @type {Map<number,{id:string,controller:AbortController}>} */ const active = new Map();
  /** @type {Set<number>} */ const owners = new Set();
  /** @param {Electron.WebContents} sender @returns {void} */
  function bindOwner(sender) {
    const owner = sender.id;
    if (owners.has(owner)) return;
    owners.add(owner);
    sender.once('destroyed', () => { active.get(owner)?.controller.abort(); options.access.clear(owner); owners.delete(owner); });
    sender.on('did-start-navigation', (_event,_url,_inPlace,mainFrame) => {
      if (mainFrame) { active.get(owner)?.controller.abort(); options.access.clear(owner); }
    });
  }
  /** @param {Electron.IpcMainInvokeEvent} event @param {{id:string,url:string}} input @param {(url:string,signal:AbortSignal)=>Promise<RadioMetadata>} operation */
  async function run(event, input, operation) {
    options.assertSender(event);
    if (!input || typeof input.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(input.id)) throw new TypeError('Radio metadata requires a bounded request ID');
    radioUrl(input.url);
    const owner = event.sender.id;
    bindOwner(event.sender);
    active.get(owner)?.controller.abort();
    const controller = new AbortController();
    active.set(owner, { id: input.id, controller });
    const close = () => controller.abort();
    /** @param {Electron.Event} _event @param {string} _url @param {boolean} _inPlace @param {boolean} mainFrame */
    const navigate = (_event, _url, _inPlace, mainFrame) => { if (mainFrame) controller.abort(); };
    event.sender.once('destroyed', close);
    event.sender.on('did-start-navigation', navigate);
    try {
      for (let attempt = 1; ; attempt += 1) {
        try { return await operation(input.url, controller.signal); }
        catch (error) {
          if (controller.signal.aborted || attempt >= 2 || !(error instanceof Error) || error instanceof TypeError || error instanceof RangeError) throw error;
          console.warn('Radio metadata request will retry', { address: address(radioUrl(input.url)), attempt, error: error.message });
        }
      }
    } finally {
      event.sender.removeListener('destroyed', close);
      event.sender.removeListener('did-start-navigation', navigate);
      if (active.get(owner)?.controller === controller) active.delete(owner);
    }
  }
  options.ipcMain.handle('radio:inspect', (event,input) => run(event,input,async(url,signal) => {
    const info = await inspectRadioStation(url,signal);
    signal.throwIfAborted();
    options.access.grant(event.sender.id,input.id,url,info.format);
    return info;
  }));
  options.ipcMain.handle('radio:metadata', (event,input) => run(event,input,readRadioMetadata));
  options.ipcMain.handle('radio:cancel', (event,id) => {
    options.assertSender(event);
    if (active.get(event.sender.id)?.id === id) active.get(event.sender.id)?.controller.abort();
  });
  options.ipcMain.handle('radio:authorize', (event,input) => {
    options.assertSender(event);
    if (!input || typeof input.stationId !== 'string' || typeof input.url !== 'string') throw new TypeError('Radio resource authorization requires stationId:string and url:string');
    return options.access.authorize(event.sender.id,input.stationId,input.url);
  });
  options.ipcMain.handle('radio:release', (event,id) => {
    options.assertSender(event);
    if (typeof id !== 'string') throw new TypeError('Radio station release requires a string token');
    return options.access.release(event.sender.id,id);
  });
}
module.exports = { radioUrl, inspectRadioStation, readRadioMetadata, registerRadioMetadataIpc };
