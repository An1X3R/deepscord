// @ts-check
import { ScreenSfu } from '../public/js/screen-sfu.js';
import { Room } from '../public/vendor/livekit-client.js';

/** @typedef {null|boolean|number|string|JsonValue[]|{[key:string]:JsonValue}} JsonValue */
/** @typedef {{[key:string]:JsonValue}} JsonObject */
/** @typedef {{predicate:(message:JsonObject)=>boolean,resolve:(message:JsonObject)=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}} Waiter */
const base = new URL(location.href).searchParams.get('base') || '';
if (!base) throw new Error('Integration fixture requires its room server URL');
/** @type {string[]} */ const checks = [];
/** @type {string[]} */ const expectedDisconnects = [];
/** @type {{clientId:string,sourceUserId:string}[]} */ const sourceEndings = [];
/** @type {{clientId:string,message:string}[]} */ const disconnectEvents = [];
/** @param {boolean} condition @param {string} label */
function check(condition, label) { if (!condition) throw new Error(label); checks.push(label); }
/** @param {()=>boolean} predicate @param {string} label @returns {Promise<void>} */
async function until(predicate, label) {
  const deadline = Date.now() + 15000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`); await new Promise((resolve) => setTimeout(resolve, 50)); }
}

class RoomClient {
  /** @param {string} name */
  constructor(name) {
    this.name = name;
    this.socket = new WebSocket(base.replace('http:', 'ws:') + '/ws');
    this.id = '';
    /** @type {(()=>void)|null} */ this.onTokenRequest = null;
    /** @type {JsonObject[]} */ this.messages = [];
    /** @type {Waiter[]} */ this.waiters = [];
    this.socket.addEventListener('message', (event) => {
      /** @type {JsonObject} */ const message = JSON.parse(event.data);
      this.messages.push(message);
      for (const waiter of [...this.waiters]) if (waiter.predicate(message)) { this.waiters.splice(this.waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message); }
    });
  }
  /** @param {JsonObject} message */
  send(message) { this.socket.send(JSON.stringify(message)); }
  /** @param {(message:JsonObject)=>boolean} predicate @returns {Promise<JsonObject>} */
  wait(predicate) {
    const previous = this.messages.find(predicate);
    if (previous) return Promise.resolve(previous);
    return new Promise((resolve, reject) => {
      /** @type {Waiter} */ const waiter = { predicate, resolve, reject, timer: setTimeout(() => { this.waiters.splice(this.waiters.indexOf(waiter), 1); reject(new Error('Room signaling response timed out')); }, 10000) };
      this.waiters.push(waiter);
    });
  }
  /** @returns {Promise<void>} */
  async open() {
    await new Promise((resolve, reject) => { this.socket.addEventListener('open', () => resolve(undefined), { once: true }); this.socket.addEventListener('error', () => reject(new Error('Room WebSocket failed')), { once: true }); });
    this.send({ t: 'hello', name: this.name, password: 'screen-sfu-integration' });
    const welcome = await this.wait((message) => message.t === 'welcome');
    if (typeof welcome.selfId !== 'string') throw new Error('Room welcome has no user identity');
    this.id = welcome.selfId;
    check(!JSON.stringify(welcome).includes('LIVEKIT_API_SECRET'), 'welcome contains no server-only SFU secret');
  }
  /** @param {string} channelId @returns {Promise<void>} */
  async join(channelId) {
    this.messages = this.messages.filter((message) => message.t !== 'voicePeers');
    this.send({ t: 'joinVoice', channelId });
    await this.wait((message) => message.t === 'voicePeers' && message.channelId === channelId);
  }
  /** @param {string} type @param {string} channelId @param {string} sourceUserId @param {string} identity @returns {Promise<JsonObject>} */
  async request(type, channelId, sourceUserId, identity) {
    const requestId = crypto.randomUUID();
    this.send({ t: type, requestId, channelId, sourceUserId, ...(identity ? { identity } : {}) });
    return this.wait((message) => message.t === type && message.requestId === requestId);
  }
  /** @param {string} channelId @param {string} sourceUserId @returns {Promise<import('../public/js/screen-sfu.js').ScreenSfuCredential>} */
  async token(channelId, sourceUserId) {
    const pending = this.request('screenSfuToken', channelId, sourceUserId, '');
    if (this.onTokenRequest) this.onTokenRequest();
    const message = await pending;
    if (message.error) throw new Error(`Screen credential rejected: ${JSON.stringify(message.error)}`);
    const { url, token, expiresAt, identity, publisherIdentity } = message;
    if (typeof url !== 'string' || typeof token !== 'string' || typeof expiresAt !== 'number' || typeof identity !== 'string' || typeof publisherIdentity !== 'string') throw new Error('Screen credential schema differs');
    return { channelId, sourceUserId, url, token, expiresAt, identity, publisherIdentity };
  }
  /** @param {string} channelId @param {string} sourceUserId @param {string} identity @returns {Promise<void>} */
  async release(channelId, sourceUserId, identity) {
    const message = await this.request('screenSfuRelease', channelId, sourceUserId, identity);
    if (message.ok !== true) throw new Error(`Screen release rejected: ${JSON.stringify(message.error)}`);
  }
}

/** @param {RoomClient} client @param {(id:string,stream:MediaStream|null)=>void} onStream @returns {ScreenSfu} */
function adapter(client, onStream) {
  return new ScreenSfu({ selfId: client.id, getBitrateBps: () => bitrate, getFrameRate: () => 24, getContentMode: () => contentMode, requestToken: (channel, source) => client.token(channel, source), releaseToken: (channel, source, identity) => client.release(channel, source, identity), onStream, onSourceEnded: (sourceUserId) => { sourceEndings.push({ clientId: client.id, sourceUserId }); }, onError: (error) => { expectedDisconnects.push(error.message); disconnectEvents.push({ clientId: client.id, message: error.message }); } });
}

let bitrate = 1_800_000;
/** @type {import('../public/js/screen-preferences.js').ScreenContentMode} */ let contentMode = 'motion';

/** Exercise both production SFU policies using only ordinary publication and viewing.
 * @returns {Promise<object>} */
async function screenPolicyMedia() {
  const publisher = new RoomClient('screen-policy-source'), viewer = new RoomClient('screen-policy-viewer');
  await Promise.all([publisher.open(), viewer.open()]);
  await Promise.all([publisher.join('ch-lobby'), viewer.join('ch-lobby')]);
  const video = document.createElement('video'); video.autoplay = true; video.muted = true; document.body.append(video);
  const source = adapter(publisher, () => {}), receiver = adapter(viewer, (_id, stream) => { video.srcObject = stream; });
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
  const context = canvas.getContext('2d'); if (!context) throw new Error('Screen policy canvas context unavailable');
  let frame = 0;
  const timer = setInterval(() => { context.fillStyle = `hsl(${frame++ * 7 % 360},80%,50%)`; context.fillRect(0, 0, 640, 360); }, 50);
  const stream = canvas.captureStream(20);
  /** @type {object[]} */ const policies = [];
  try {
    await Promise.all([source.join('ch-lobby'), receiver.join('ch-lobby')]);
    for (const mode of /** @type {const} */ (['motion', 'detail'])) {
      contentMode = mode; bitrate = 300000;
      await source.publish(stream);
      const publication = [...(source.publisher?.room.localParticipant.videoTrackPublications.values() || [])][0];
      const sender = publication?.videoTrack?.sender;
      if (!sender) throw new Error('Screen policy test has no actual SFU sender');
      const preference = mode === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
      check(sender.getParameters().degradationPreference === preference && stream.getVideoTracks()[0].contentHint === mode, mode + ' policy retained by SFU sender and capture');
      await receiver.watch(publisher.id);
      await until(() => video.readyState >= 2 && video.getVideoPlaybackQuality().totalVideoFrames >= 4, mode + ' SFU actual decoded frames');
      const received = video.getVideoPlaybackQuality().totalVideoFrames;
      bitrate = 900000; await source.updatePreferences();
      check(sender.getParameters().encodings[0].maxBitrate === bitrate && sender.getParameters().degradationPreference === preference, mode + ' policy retained after live bitrate change');
      await until(() => video.getVideoPlaybackQuality().totalVideoFrames >= received + 5, mode + ' playback continues after bitrate update');
      policies.push({ mode, parameters: sender.getParameters(), decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames });
      await receiver.unwatch(publisher.id); await source.unpublish();
    }
    check(expectedDisconnects.length === 0, 'Screen policy media has no unexpected disconnects');
    return { status: 'passed', checks, policies };
  } finally {
    await receiver.leave(); await source.leave();
    publisher.socket.close(); viewer.socket.close();
    clearInterval(timer); stream.getTracks().forEach(track => track.stop()); video.remove();
  }
}

/** @returns {Promise<object>} */
async function main() {
  const publisher = new RoomClient('screen-source');
  const viewer = new RoomClient('screen-viewer');
  const outsider = new RoomClient('screen-outsider');
  await Promise.all([publisher.open(), viewer.open(), outsider.open()]);
  await Promise.all([publisher.join('ch-lobby'), viewer.join('ch-lobby'), outsider.join('ch-squad')]);
  const denied = await viewer.request('screenSfuToken', 'ch-lobby', publisher.id, '');
  check(!!denied.error, 'watch denied before screen publication');
  const crossRoom = await outsider.request('screenSfuToken', 'ch-squad', publisher.id, '');
  check(!!crossRoom.error, 'cross-channel watch denied');
  const source = adapter(publisher, () => {});
  const video = document.createElement('video'); video.autoplay = true; video.muted = true; video.width = 320; video.height = 180; document.body.append(video);
  let clears = 0;
  const receiver = adapter(viewer, (id, stream) => { if (id === publisher.id) { video.srcObject = stream; if (!stream) clears += 1; } });
  await Promise.all([source.join('ch-lobby'), receiver.join('ch-lobby')]);
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
  const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas context missing');
  let frame = 0;
  const timer = setInterval(() => { frame += 1; context.fillStyle = `hsl(${frame * 7 % 360},80%,50%)`; context.fillRect(0, 0, 320, 180); context.fillStyle = '#ffffff'; context.fillText(String(frame), 30, 60); }, 50);
  const stream = canvas.captureStream(20);
  const audio = new AudioContext(); const oscillator = audio.createOscillator(); const destination = audio.createMediaStreamDestination(); oscillator.connect(destination); oscillator.start();
  stream.addTrack(destination.stream.getAudioTracks()[0]);
  try {
    await source.publish(stream);
    const publication = [...(source.publisher?.room.localParticipant.videoTrackPublications.values() || [])][0];
    check(publication?.videoTrack?.sender?.getParameters().encodings[0].maxBitrate === 1_800_000, 'initial screen sender uses the configured 1.8 Mbps budget');
    check(publication.videoTrack?.sender?.getParameters().encodings[0].maxFramerate === 24, 'initial SFU screen sender uses the explicit 24 FPS upper bound');
    check(publication.videoTrack?.sender?.getParameters().degradationPreference === 'maintain-framerate' && publication.videoTrack.mediaStreamTrack.contentHint === 'motion', 'SFU capture and sender retain the selected motion policy');
    bitrate = 700_000; await source.updatePreferences();
    check(publication.videoTrack?.sender?.getParameters().encodings[0].maxBitrate === 700_000, 'live screen sender applies a lower 0.7 Mbps budget');
    bitrate = 40_000_000; await source.updatePreferences();
    check(publication.videoTrack?.sender?.getParameters().encodings[0].maxBitrate === 40_000_000, 'live screen sender accepts the higher 40 Mbps encoding upper bound');
    check(publication.videoTrack?.sender?.getParameters().encodings[0].maxFramerate === 24 && publication.options?.screenShareEncoding?.maxFramerate === 24, 'live SFU bitrate updates retain the active 24 FPS limit in both sender and SDK publication options');
    check(publication.videoTrack?.sender?.getParameters().degradationPreference === 'maintain-framerate' && publication.options?.degradationPreference === 'maintain-framerate', 'live SFU bitrate updates retain the active content policy in both sender and SDK publication options');
    check(source.publisher?.room.localParticipant.audioTrackPublications.size === 0 && source.publisher.room.localParticipant.videoTrackPublications.size === 1, 'only screen video published although capture stream includes audio');
    const sourceCredential = source.publisher?.credential; if (!sourceCredential) throw new Error('Publisher credential missing');
    /** @type {{video:{canPublish:boolean,canSubscribe:boolean,canPublishData:boolean,canPublishSources:string[],room:string},exp:number,nbf:number}} */
    const grants = JSON.parse(atob(sourceCredential.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    check(grants.video.canPublish === true && grants.video.canSubscribe === false && grants.video.canPublishData === false && grants.video.canPublishSources.join(',') === 'screen_share', 'publisher JWT is screen-only without data or subscribe permission');
    check(grants.exp - grants.nbf <= 60 && grants.exp > grants.nbf, 'screen JWT lifetime is at most 60 seconds');
    check(receiver.watchers.size === 0, 'joining voice alone creates no SFU watch connection');
    await receiver.watch(publisher.id);
    await until(() => video.getVideoPlaybackQuality().totalVideoFrames >= 8 && video.videoWidth === 320 && video.videoHeight === 180, 'real SFU video decode');
    const decoded = video.getVideoPlaybackQuality().totalVideoFrames;
    const watchCredential = receiver.watchers.get(publisher.id)?.credential; if (!watchCredential) throw new Error('Watch credential missing');
    /** @type {{video:{canPublish:boolean,canSubscribe:boolean,canPublishData:boolean,room:string}}} */
    const watchGrants = JSON.parse(atob(watchCredential.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    check(watchGrants.video.canPublish === false && watchGrants.video.canSubscribe === true && watchGrants.video.canPublishData === false && watchGrants.video.room === grants.video.room, 'viewer JWT is read-only and bound to the watched source room');
    await fetch('/admin-outage', { method: 'POST' });
    const failedRelease = await viewer.request('screenSfuRelease', 'ch-lobby', publisher.id, watchCredential.identity);
    check(!!failedRelease.error && failedRelease.ok !== true, 'real SFU admin transport outage reports failed revocation rather than success');
    const pendingRevocation = await fetch('/screen-sfu/rtc/validate?access_token=' + encodeURIComponent(watchCredential.token));
    check(pendingRevocation.status === 403, 'pending revocation immediately denies credential replay while admin is unavailable');
    await fetch('/admin-recover', { method: 'POST' });
    /** @type {{removeRequests:number}} */ const beforeRetry = await (await fetch('/admin-stats')).json();
    await viewer.release('ch-lobby', publisher.id, watchCredential.identity);
    /** @type {{removeRequests:number}} */ const afterRetry = await (await fetch('/admin-stats')).json();
    check(afterRetry.removeRequests > beforeRetry.removeRequests, 'retained failed revocation actually retries the real SFU admin endpoint after recovery');
    await receiver.unwatch(publisher.id);
    check(video.srcObject === null, 'unwatch clears the displayed stream');
    const revoked = await fetch('/screen-sfu/rtc/validate?access_token=' + encodeURIComponent(watchCredential.token));
    check(revoked.status === 403, 'released JWT cannot replay through the gateway');
    const replay = new Room(); let replayDenied = false;
    try { await replay.connect(watchCredential.url, watchCredential.token, { autoSubscribe: false, maxRetries: 0 }); } catch { replayDenied = true; } finally { await replay.disconnect(false); }
    check(replayDenied, 'real SDK reconnect with released credential is rejected');
    const admin = await fetch('/screen-sfu/twirp/livekit.RoomService/ListRooms?access_token=' + encodeURIComponent(sourceCredential.token));
    check(admin.status === 403, 'LiveKit management API is not exposed by the gateway');
    const tokenStarted = new Promise((resolve) => { viewer.onTokenRequest = () => resolve(undefined); });
    const cancelledWatch = receiver.watch(publisher.id).then(() => null, (error) => error);
    await tokenStarted;
    const cancelledCleanup = receiver.unwatch(publisher.id);
    const cancellation = await cancelledWatch; await cancelledCleanup; viewer.onTokenRequest = null;
    check(cancellation instanceof DOMException && cancellation.name === 'AbortError' && receiver.watchers.size === 0, 'unwatch immediately cancels a real in-flight credential request without late media');
    const racingRequest = viewer.request('screenSfuToken', 'ch-lobby', publisher.id, '');
    viewer.send({ t: 'leaveVoice' });
    const racingResponse = await racingRequest;
    check(!!racingResponse.error && !racingResponse.token, 'an in-flight watch authorization is rejected after voice membership changes');
    await viewer.join('ch-lobby');
    await receiver.watch(publisher.id);
    await until(() => video.srcObject !== null && video.getVideoPlaybackQuality().totalVideoFrames >= 4, 'watch after a new explicit lease');
    const replacement = receiver.watchers.get(publisher.id)?.credential; if (!replacement) throw new Error('Replacement watch credential missing');
    await viewer.release('ch-lobby', publisher.id, watchCredential.identity);
    const stillAuthorized = await fetch('/screen-sfu/rtc/validate?access_token=' + encodeURIComponent(replacement.token));
    check(stillAuthorized.ok, 'cleanup of an old lease cannot revoke its replacement credential');
    const viewerErrorsBefore = disconnectEvents.filter((event) => event.clientId === viewer.id).length;
    const publisherErrorsBefore = disconnectEvents.filter((event) => event.clientId === publisher.id).length;
    await publisher.join('ch-squad');
    await until(() => clears >= 2 && receiver.watchers.size === 0 && sourceEndings.some((event) => event.clientId === viewer.id && event.sourceUserId === publisher.id) && disconnectEvents.filter((event) => event.clientId === publisher.id).length > publisherErrorsBefore, 'real source-room deletion delivers its explicit end without a media control announcement');
    check(sourceEndings.some((event) => event.clientId === viewer.id && event.sourceUserId === publisher.id), 'real ROOM_DELETED reports the exact ended source without a preceding peer media declaration');
    check(disconnectEvents.filter((event) => event.clientId === viewer.id).length === viewerErrorsBefore, 'normal watched source-room deletion does not add a generic viewer disconnect error');
    const revokedPublisher = await fetch('/screen-sfu/rtc/validate?access_token=' + encodeURIComponent(sourceCredential.token));
    check(revokedPublisher.status === 403, 'publisher token revoked after channel switch');
    check(disconnectEvents.filter((event) => event.clientId === publisher.id).length > publisherErrorsBefore, 'unexpected publisher revocation remains a visible media disconnect');
    check(stream.getVideoTracks()[0].readyState === 'live', 'adapter disconnect preserves caller-owned capture track');
    await Promise.all([source.leave(), receiver.leave()]);
    return { status: 'passed', checks, decodedFrames: decoded, dimensions: [320, 180], expectedDisconnects, sourceEndings, disconnectEvents };
  } finally {
    clearInterval(timer); for (const track of stream.getTracks()) track.stop(); oscillator.stop(); await audio.close();
    publisher.socket.close(); viewer.socket.close(); outsider.socket.close();
  }
}

const operation = new URL(location.href).searchParams.get('operation');
if (operation !== null && operation !== 'media-policy') throw new TypeError('Unsupported SFU integration operation');
(operation === 'media-policy' ? screenPolicyMedia() : main()).then((result) => fetch('/result', { method: 'POST', body: JSON.stringify(result) })).catch((error) => fetch('/result', { method: 'POST', body: JSON.stringify({ status: 'failed', checks, error: error instanceof Error ? error.stack : String(error) }) }));
