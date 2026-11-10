// @ts-check
import { ExternalE2EEKeyProvider, isE2EESupported } from '../vendor/livekit-client.js';

/** @typedef {{key:Uint8Array,keyId:string,identity:string,onError:(error:Error)=>void}} ScreenEncryptionOptions */
/** @typedef {{readable:ReadableStream<RTCEncodedVideoFrame>,writable:WritableStream<RTCEncodedVideoFrame>}} EncodedStreams */
/** @typedef {{createEncodedStreams:()=>EncodedStreams}} EncodedEndpoint */
/** @typedef {{kind:string,data:{enabled?:boolean,participantIdentity?:string,error?:Error,level?:string,msg?:string}}} WorkerReply */
/** @typedef {{kind:string,resolve:()=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}} PendingAck */
const WORKER_URL = new URL('../vendor/livekit-e2ee-worker.js', import.meta.url);
const ACK_TIMEOUT_MS = 10000;

/** @param {ScreenEncryptionOptions} options @returns {void} */
function validateOptions(options) {
  if (!(options.key instanceof Uint8Array) || options.key.byteLength !== 32) throw new TypeError('Screen encryption requires a 32-byte room key');
  if (typeof options.keyId !== 'string' || !options.keyId || options.keyId.length > 256) throw new TypeError('Screen encryption requires a bounded key identifier');
  if (typeof options.identity !== 'string' || !options.identity || options.identity.length > 256) throw new TypeError('Screen encryption requires a bounded participant identity');
  if (typeof options.onError !== 'function') throw new TypeError('Screen encryption requires an error handler');
  if (!globalThis.isSecureContext || !crypto.subtle || !isE2EESupported()) throw new Error('This browser cannot provide encrypted screen frames in this context');
}

/**
 * Use one controller per peer connection and key epoch. The connection MUST use
 * encodedInsertableStreams:true, and video MUST negotiate VP8. Bind senders before
 * creating an offer. Bind receivers after applying the offer, before creating an
 * answer: Chromium resets receiver streams if bound before the remote offer.
 * Track IDs are unique within a controller. The identity
 * labels local cryptors; the shared room key also decrypts remote publishers.
 * Destroy and close the peer connection together; transformed endpoints cannot be reused.
 * The official LiveKit worker owns frame serialization and encryption. keyId is
 * application epoch metadata, never the worker's one-byte key index.
 * @param {ScreenEncryptionOptions} options
 * @returns {Promise<{bindSender:(sender:RTCRtpSender,trackId:string)=>Promise<void>,bindReceiver:(receiver:RTCRtpReceiver,trackId:string)=>Promise<void>,destroy:()=>void}>}
 */
export async function createScreenEncryption(options) {
  validateOptions(options);
  if (typeof (/** @type {RTCRtpSender & EncodedEndpoint} */ (RTCRtpSender.prototype)).createEncodedStreams !== 'function' || typeof (/** @type {RTCRtpReceiver & EncodedEndpoint} */ (RTCRtpReceiver.prototype)).createEncodedStreams !== 'function') throw new Error('Encrypted screen relay requires Chromium encoded frame streams');
  const worker = new Worker(WORKER_URL, { type: 'module', name: 'deepscord-screen-e2ee' });
  /** @type {PendingAck|null} */ let pending = null;
  /** @type {Error|null} */ let failure = null;
  /** @type {Set<string>} */ const tracks = new Set();
  /** @type {WeakSet<RTCRtpSender|RTCRtpReceiver>} */ const endpoints = new WeakSet();
  /** @type {Promise<void>} */ let binding = Promise.resolve();
  let destroyed = false;

  /** @param {Error} error @returns {void} */
  function fail(error) {
    if (destroyed) return;
    failure = error;
    destroy();
    options.onError(error);
  }
  /** @returns {void} */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (pending) { clearTimeout(pending.timer); pending.reject(failure || new Error('Screen encryption controller was destroyed')); pending = null; }
    // Termination leaves encoded streams closed; never detach to plaintext.
    worker.terminate();
    tracks.clear();
  }
  /** @param {string} kind @returns {Promise<void>} */
  function acknowledgement(kind) {
    if (destroyed) return Promise.reject(failure || new Error('Screen encryption controller is closed'));
    if (pending) throw new Error('Screen encryption worker operation is already pending');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('Screen encryption worker timed out awaiting ' + kind)), ACK_TIMEOUT_MS);
      pending = { kind, resolve, reject, timer };
    });
  }
  /** @param {MessageEvent<WorkerReply>} event @returns {void} */
  worker.onmessage = (event) => {
    const message = event.data;
    if (!message || typeof message.kind !== 'string' || !message.data) { fail(new Error('Screen encryption worker returned an invalid message')); return; }
    if (message.kind === 'error') { fail(new Error('Screen encryption worker failed: ' + (message.data.error?.message || 'unspecified encryption error'))); return; }
    if (message.kind === 'log' && message.data.level === 'error') { fail(new Error('Screen encryption worker reported: ' + message.data.msg)); return; }
    if (pending && message.kind === pending.kind) {
      if (message.kind === 'enable' && (message.data.enabled !== true || message.data.participantIdentity !== options.identity)) { fail(new Error('Screen encryption worker did not enable the expected participant')); return; }
      const current = pending; pending = null; clearTimeout(current.timer); current.resolve();
    }
  };
  worker.onerror = (event) => fail(new Error('Screen encryption worker failed to execute: ' + event.message));
  worker.onmessageerror = () => fail(new Error('Screen encryption worker message could not be decoded'));
  try {
    const provider = new ExternalE2EEKeyProvider({ keySize: 256 });
    const initialized = acknowledgement('initAck');
    worker.postMessage({kind:'init',data:{keyProviderOptions:provider.getOptions(),loglevel:'error'}});
    await initialized;
    const ownedKey = new Uint8Array(options.key);
    try { await provider.setKey(ownedKey.buffer); } finally { ownedKey.fill(0); }
    const keyInfo = provider.getKeys()[0];
    if (!keyInfo) throw new Error('Screen encryption SDK did not import the supplied room key');
    worker.postMessage({kind:'setKey',data:{key:keyInfo.key,keyIndex:0,updateCurrentKeyIndex:true,participantIdentity:options.identity,isPublisher:true}});
    const enabled = acknowledgement('enable');
    // The worker serializes these messages, so enable acknowledges key derivation too.
    worker.postMessage({kind:'enable',data:{enabled:true,participantIdentity:options.identity}});
    await enabled;
  } catch (error) {
    destroy();
    throw error;
  }
  /** @param {RTCRtpSender|RTCRtpReceiver} endpoint @param {string} trackId @param {'encode'|'decode'} kind @returns {Promise<void>} */
  async function bind(endpoint, trackId, kind) {
    if (destroyed) throw failure || new Error('Screen encryption controller is closed');
    if (typeof trackId !== 'string' || !trackId || trackId.length > 256 || tracks.has(trackId)) throw new TypeError('Screen encryption requires a unique bounded track identifier');
    if (tracks.size >= 8) throw new RangeError('Screen encryption supports at most eight endpoints per connection');
    if (endpoints.has(endpoint)) throw new Error('Screen endpoint already has an encryption transform');
    if (endpoint.track && endpoint.track.kind !== 'video' && endpoint.track.kind !== 'audio') throw new TypeError('Screen encryption endpoint must carry audio or video');
    const streams = /** @type {RTCRtpSender & EncodedEndpoint} */ (endpoint).createEncodedStreams();
    tracks.add(trackId); endpoints.add(endpoint);
    worker.postMessage({kind,data:{readableStream:streams.readable,writableStream:streams.writable,participantIdentity:options.identity,trackId,codec:endpoint.track?.kind === 'audio' ? undefined : 'vp8',hasPacketTrailer:false}},[streams.readable,streams.writable]);
    const enabled = acknowledgement('enable');
    worker.postMessage({kind:'enable',data:{enabled:true,participantIdentity:options.identity}});
    await enabled;
  }
  return {
    bindSender: (sender, trackId) => { binding = binding.then(() => bind(sender, trackId, 'encode')); return binding; },
    bindReceiver: (receiver, trackId) => { binding = binding.then(() => bind(receiver, trackId, 'decode')); return binding; },
    destroy,
  };
}

/**
 * Pass e2ee to new SDK Room({e2ee}), await room.setE2EEEnabled(true) before
 * connect/publish, and publish videoCodec:'vp8'. Disconnect room before destroy.
 * SDK owns endpoint binding; this worker must never be shared with a peer adapter.
 * Recreate the room for every key epoch. No room keys go to a relay or SFU.
 * @param {ScreenEncryptionOptions} options
 * @returns {Promise<{e2ee:{keyProvider:ExternalE2EEKeyProvider,worker:Worker},destroy:()=>void}>}
 */
export async function createScreenSfuEncryption(options) {
  validateOptions(options);
  const keyProvider = new ExternalE2EEKeyProvider({ keySize: 256 });
  const ownedKey = new Uint8Array(options.key);
  try { await keyProvider.setKey(ownedKey.buffer); } finally { ownedKey.fill(0); }
  const worker = new Worker(WORKER_URL, {type:'module',name:'deepscord-sfu-e2ee'});
  worker.addEventListener('error', (event) => options.onError(new Error('Screen SFU encryption worker failed: ' + event.message)));
  return {e2ee:{keyProvider,worker},destroy:()=>worker.terminate()};
}
