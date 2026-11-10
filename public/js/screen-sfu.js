// @ts-check
import { MAX_SCREEN_BITRATE_BPS, screenEncodingPolicy } from './screen-preferences.js';

/** @typedef {{channelId:string,sourceUserId:string,url:string,token:string,expiresAt:number,identity:string,publisherIdentity:string}} ScreenSfuCredential */
/** @typedef {{selfId:string,getContentEncryption?:()=>import('./screen-link.js').ScreenContentEncryption|null,getBitrateBps:()=>number,getFrameRate:()=>number,getContentMode:()=>import('./screen-preferences.js').ScreenContentMode,requestToken:(channelId:string,sourceUserId:string)=>Promise<ScreenSfuCredential>,releaseToken:(channelId:string,sourceUserId:string,identity:string)=>Promise<void>,onStream:(userId:string,stream:MediaStream|null)=>void,onSourceEnded:(userId:string)=>void,onError:(error:Error)=>void}} ScreenSfuOptions */
/** @typedef {typeof import('../vendor/livekit-client.js')} ScreenSdk */
/** @typedef {{room:import('../vendor/livekit-client.js').Room,credential:ScreenSfuCredential,closing:boolean,sdk:ScreenSdk,encryption:Awaited<ReturnType<typeof import('./screen-encryption.js').createScreenSfuEncryption>>|null}} Connection */

/** @param {ScreenSfuCredential} value @param {string} channelId @param {string} sourceUserId @returns {ScreenSfuCredential} */
function credentialFor(value, channelId, sourceUserId) {
  if (!value || value.channelId !== channelId || value.sourceUserId !== sourceUserId || typeof value.token !== 'string' || !value.token || typeof value.identity !== 'string' || !value.identity || typeof value.publisherIdentity !== 'string' || !value.publisherIdentity || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) throw new TypeError('The room server returned an invalid or expired screen credential');
  const url = new URL(value.url);
  if ((url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.pathname !== '/screen-sfu' || url.username || url.password || url.search || url.hash) throw new TypeError('The room server returned an invalid screen signaling URL');
  return value;
}

export class ScreenSfu {
  /** @param {ScreenSfuOptions} options */
  constructor(options) {
    this.options = options;
    this.channelId = '';
    this.desiredChannel = '';
    /** @type {Connection|null} */ this.publisher = null;
    /** @type {Map<string,Connection>} */ this.watchers = new Map();
    /** @type {Promise<void>} */ this.pending = Promise.resolve();
    this.generation = 0;
    this.publication = 0;
    /** @type {Map<string,number>} */ this.subscriptions = new Map();
    /** @type {Set<Connection>} */ this.connecting = new Set();
  }

  /** @param {()=>Promise<void>} operation @returns {Promise<void>} */
  enqueue(operation) {
    const result = this.pending.then(operation);
    // The caller receives the original rejection; the tail only permits later cleanup to run.
    this.pending = result.then(() => {}, () => {});
    return result;
  }

  /** @returns {string} */
  requireChannel() {
    if (!this.channelId) throw new Error('Join a voice channel before requesting screen media');
    return this.channelId;
  }

  /** @returns {number} */
  bitrateBps() {
    const value = this.options.getBitrateBps();
    if (!Number.isFinite(value) || value < 300_000 || value > MAX_SCREEN_BITRATE_BPS) throw new RangeError('Screen video bitrate must be between 300000 and 40000000 bits per second after reserving voice bandwidth');
    return Math.floor(value);
  }

  /** @returns {number} */
  frameRate() {
    const value = this.options.getFrameRate();
    if (![15, 24, 30, 60].includes(value)) throw new RangeError('Screen frame rate must be 15, 24, 30 or 60');
    return value;
  }

  /** @param {string} channelId @returns {Promise<void>} */
  join(channelId) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(channelId)) return Promise.reject(new TypeError('A valid screen channel identifier is required'));
    if (this.desiredChannel !== channelId) { this.generation += 1; this.desiredChannel = channelId; this.interruptAll(); }
    const generation = this.generation;
    return this.enqueue(async () => {
      this.requireGeneration(generation);
      if (this.channelId === channelId) return;
      await this.closeAll();
      this.requireGeneration(generation);
      this.channelId = channelId;
    });
  }

  /** @param {number} generation @returns {void} */
  requireGeneration(generation) {
    if (this.generation !== generation) throw new DOMException('Screen operation cancelled by a channel change or leave', 'AbortError');
  }

  /** @param {Connection} connection @returns {void} */
  interrupt(connection) {
    connection.closing = true;
    connection.encryption?.destroy();
    connection.room.disconnect(false).catch((error) => this.options.onError(error instanceof Error ? error : new Error('Screen disconnection failed')));
  }

  /** @param {Connection} connection @param {Error} error @returns {void} */
  failEncryption(connection,error) {
    if(connection.closing)return;
    if(this.publisher===connection)this.publisher=null;
    if(this.watchers.get(connection.credential.sourceUserId)===connection)this.watchers.delete(connection.credential.sourceUserId);
    this.interrupt(connection);
    this.options.onStream(connection.credential.sourceUserId,null);
    this.options.onError(error);
    this.close(connection).catch(cleanup=>this.options.onError(cleanup instanceof Error?cleanup:new Error('Encrypted screen cleanup failed')));
  }

  /** @returns {void} */
  interruptAll() {
    for (const connection of [...this.connecting, ...this.watchers.values(), ...(this.publisher ? [this.publisher] : [])]) this.interrupt(connection);
  }

  /** @param {string} sourceUserId @param {()=>void} validate @returns {Promise<Connection>} */
  async connect(sourceUserId, validate) {
    const channelId = this.requireChannel();
    validate();
    const sdk = await import('../vendor/livekit-client.js');
    validate();
    const { DisconnectReason,Room,RoomEvent } = sdk;
    const credential = credentialFor(await this.options.requestToken(channelId, sourceUserId), channelId, sourceUserId);
    const content=this.options.getContentEncryption?.() || null;
    /** @type {Connection|null} */let active=null;
    /** @type {Error|null} */let encryptionFailure=null;
    const encryption=content?await (await import('./screen-encryption.js')).createScreenSfuEncryption({...content,identity:credential.identity,onError:error=>{encryptionFailure=error;if(active)this.failEncryption(active,error);else this.options.onError(error);}}):null;
    // The application owns video elements, so SDK element-visibility tracking must stay disabled.
    // A single encoding is budgeted directly; dynacast would restore its cached original bitrate.
    const room = new Room({ adaptiveStream: false, dynacast: false, disconnectOnPageLeave: true, singlePeerConnection: false, stopLocalTrackOnUnpublish: false, ...(encryption?{e2ee:encryption.e2ee}:{}) });
    /** @type {Connection} */ const connection = { room, credential, closing: false,sdk,encryption };
    active=connection;
    room.on(RoomEvent.EncryptionError,error=>this.failEncryption(connection,error));
    this.connecting.add(connection);
    room.on(RoomEvent.Disconnected, (reason) => {
      if (connection.closing) return;
      connection.closing = true;
      encryption?.destroy();
      const watching = this.watchers.get(sourceUserId) === connection;
      const active = this.publisher === connection || watching;
      if (this.publisher === connection) this.publisher = null;
      if (this.watchers.get(sourceUserId) === connection) this.watchers.delete(sourceUserId);
      if (active) this.options.onStream(sourceUserId, null);
      // Room deletion is the authoritative end of this source's isolated media room.
      if (watching && reason === DisconnectReason.ROOM_DELETED) this.options.onSourceEnded(sourceUserId);
      else this.options.onError(new Error(`Screen media disconnected for ${sourceUserId} (LiveKit reason ${reason})`));
      this.options.releaseToken(channelId, sourceUserId, credential.identity).catch((error) => this.options.onError(error instanceof Error ? error : new Error('Screen permission release failed')));
    });
    try {
      validate();
      if(encryption)await room.setE2EEEnabled(true);
      if(encryptionFailure)throw encryptionFailure;
      await room.connect(credential.url, credential.token, { autoSubscribe: false, maxRetries: 0 });
      validate();
      if(encryptionFailure||connection.closing)throw encryptionFailure || new Error('Screen encryption connection closed during setup');
      if (room.localParticipant.identity !== credential.identity) throw new Error('Screen media identity does not match the room credential');
      return connection;
    } catch (error) {
      connection.closing = true;
      encryption?.destroy();
      try { await room.disconnect(false); await this.options.releaseToken(channelId, sourceUserId, credential.identity); }
      catch (cleanupError) { this.options.onError(cleanupError instanceof Error ? cleanupError : new Error('Failed to revoke an unsuccessful screen connection')); }
      throw error;
    } finally { this.connecting.delete(connection); }
  }

  /** @param {MediaStream} stream @returns {Promise<void>} */
  publish(stream) {
    const generation = this.generation;
    const publication = ++this.publication;
    const validate = () => {
      this.requireGeneration(generation);
      if (this.publication !== publication) throw new DOMException('Screen publication cancelled', 'AbortError');
    };
    return this.enqueue(async () => {
      validate();
      this.requireChannel();
      const tracks = stream.getVideoTracks();
      if (tracks.length !== 1 || tracks[0].readyState !== 'live') throw new TypeError('Screen publication requires exactly one live video track');
      const bitrate = this.bitrateBps();
      const policy = screenEncodingPolicy(this.options.getContentMode());
      if (this.publisher) throw new Error('A screen is already published; unpublish it before replacing the capture');
      const connection = await this.connect(this.options.selfId, validate);
      this.publisher = connection;
      try {
        // Audio remains on the independent voice/music transport.
        tracks[0].contentHint = policy.contentHint;
        const publication = await connection.room.localParticipant.publishTrack(tracks[0], { source: connection.sdk.Track.Source.ScreenShare, videoCodec: 'vp8', simulcast: false, degradationPreference: policy.degradationPreference, screenShareEncoding: { maxBitrate: bitrate, maxFramerate: this.frameRate() } });
        const sender = publication.videoTrack?.sender;
        if (!sender) throw new Error('The screen publication has no RTP sender to apply its content policy');
        await sender.setParameters({ ...sender.getParameters(), degradationPreference: policy.degradationPreference });
        validate();
      } catch (error) {
        this.publisher = null;
        try { await this.close(connection); }
        catch (cleanupError) { this.options.onError(cleanupError instanceof Error ? cleanupError : new Error('Failed to revoke an unsuccessful screen publication')); }
        throw error;
      }
    });
  }

  /** @param {Connection} connection @returns {Promise<void>} */
  async close(connection) {
    connection.closing = true;
    connection.encryption?.destroy();
    await connection.room.disconnect(false);
    await this.options.releaseToken(connection.credential.channelId, connection.credential.sourceUserId, connection.credential.identity);
  }

  /** @returns {Promise<void>} */
  unpublish() {
    this.publication += 1;
    for (const connection of [...this.connecting, ...(this.publisher ? [this.publisher] : [])]) if (connection.credential.sourceUserId === this.options.selfId) this.interrupt(connection);
    return this.enqueue(async () => {
      const connection = this.publisher;
      this.publisher = null;
      if (connection) await this.close(connection);
    });
  }

  /** @returns {Promise<void>} */
  updatePreferences() {
    return this.enqueue(async () => {
      const connection = this.publisher;
      if (!connection || connection.closing) return;
      const maxBitrate = this.bitrateBps();
      const publications = [...connection.room.localParticipant.videoTrackPublications.values()];
      if (publications.length !== 1) throw new Error('Screen bitrate update requires exactly one video publication');
      const publication = publications[0];
      const track = publication.videoTrack;
      const sender = track?.sender;
      if (!track || !sender) throw new Error('The active screen publication has no RTP sender');
      const parameters = sender.getParameters();
      if (parameters.encodings.length !== 1) throw new Error('Screen bitrate update requires a single RTP encoding');
      await sender.setParameters({ ...parameters, encodings: parameters.encodings.map((encoding) => ({ ...encoding, maxBitrate })) });
      const options = { ...publication.options, screenShareEncoding: { maxBitrate, maxFramerate: this.frameRate() } };
      publication.options = options;
      track.publishOptions = options;
    });
  }

  /** @param {string} userId @returns {Promise<void>} */
  watch(userId) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(userId) || userId === this.options.selfId) return Promise.reject(new TypeError('Watch requires another valid user identifier'));
    const generation = this.generation;
    const subscription = (this.subscriptions.get(userId) || 0) + 1;
    this.subscriptions.set(userId, subscription);
    const validate = () => {
      this.requireGeneration(generation);
      if (this.subscriptions.get(userId) !== subscription) throw new DOMException('Screen watch cancelled', 'AbortError');
    };
    return this.enqueue(async () => {
      validate();
      if (this.watchers.has(userId)) return;
      const connection = await this.connect(userId, validate);
      const { room, credential } = connection;
      const { RoomEvent,Track } = connection.sdk;
      this.watchers.set(userId, connection);
      /** @param {import('livekit-client').RemoteTrackPublication} publication @param {import('livekit-client').RemoteParticipant} participant */
      const subscribe = (publication, participant) => {
        if (connection.closing || this.watchers.get(userId) !== connection) return;
        if (participant.identity === credential.publisherIdentity && publication.kind === Track.Kind.Video && publication.source === Track.Source.ScreenShare) {
          if(connection.encryption&&!publication.isEncrypted){this.failEncryption(connection,new Error('Encrypted room screen publication is missing frame encryption'));return;}
          publication.setSubscribed(true);
        }
      };
      room.on(RoomEvent.TrackPublished, subscribe);
      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (connection.closing) return;
        if(connection.encryption&&!publication.isEncrypted){this.failEncryption(connection,new Error('Encrypted room received a screen track without frame encryption'));return;}
        if (participant.identity !== credential.publisherIdentity || publication.kind !== Track.Kind.Video || publication.source !== Track.Source.ScreenShare || track.kind !== Track.Kind.Video) {
          publication.setSubscribed(false);
          this.options.onError(new Error('The screen service delivered an unauthorized media track'));
          return;
        }
        this.options.onStream(userId, new MediaStream([track.mediaStreamTrack]));
      });
      room.on(RoomEvent.TrackUnsubscribed, () => { if (!connection.closing && this.watchers.get(userId) === connection) this.options.onStream(userId, null); });
      room.on(RoomEvent.TrackSubscriptionFailed, (sid, participant, reason) => { if (!connection.closing && this.watchers.get(userId) === connection) this.options.onError(new Error(`Screen subscription failed for ${userId} (track ${sid}, publisher ${participant.identity}, reason ${reason})`)); });
      for (const participant of room.remoteParticipants.values()) for (const publication of participant.trackPublications.values()) subscribe(publication, participant);
    });
  }

  /** @param {string} userId @returns {Promise<void>} */
  unwatch(userId) {
    this.subscriptions.set(userId, (this.subscriptions.get(userId) || 0) + 1);
    for (const connection of [...this.connecting, ...this.watchers.values()]) if (connection.credential.sourceUserId === userId) this.interrupt(connection);
    this.options.onStream(userId, null);
    return this.enqueue(async () => {
      const connection = this.watchers.get(userId);
      this.watchers.delete(userId);
      if (connection) await this.close(connection);
      this.options.onStream(userId, null);
    });
  }

  /** @returns {Promise<void>} */
  async closeAll() {
    const connections = [...this.watchers.values(), ...(this.publisher ? [this.publisher] : [])];
    this.watchers.clear();
    this.publisher = null;
    this.channelId = '';
    const results = await Promise.allSettled(connections.map((connection) => this.close(connection)));
    for (const connection of connections) if (connection.credential.sourceUserId !== this.options.selfId) this.options.onStream(connection.credential.sourceUserId, null);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }

  /** @returns {Promise<void>} */
  leave() {
    this.generation += 1;
    this.desiredChannel = '';
    this.interruptAll();
    for (const userId of this.watchers.keys()) this.options.onStream(userId, null);
    return this.enqueue(() => this.closeAll());
  }
}
