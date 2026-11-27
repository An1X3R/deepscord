// @ts-check
'use strict';

const path = require('node:path');

/** Bind the flat API from the same runtime used by steamworks.js. */
function bindSessionCloser() {
  const libraries = { win32: 'win64/steam_api64.dll', linux: 'linux64/libsteam_api.so', darwin: 'osx/libsteam_api.dylib' };
  if (!Object.hasOwn(libraries, process.platform)) throw new Error('Unsupported Steam platform: ' + process.platform);
  const filename = libraries[/** @type {keyof typeof libraries} */ (process.platform)];
  const sdk = require('koffi').load(path.join(path.dirname(require.resolve('steamworks.js')), 'dist', filename));
  const getInterface = sdk.func('void *SteamAPI_SteamNetworking_v006(void)');
  const close = sdk.func('bool SteamAPI_ISteamNetworking_CloseP2PSessionWithUser(void *networking, uint64_t peer)');
  /** @param {bigint} peer */
  return peer => {
    const networking = getInterface();
    if (networking == null) throw new Error('Steam networking interface is unavailable during session cleanup');
    // False means the session was already closed.
    close(networking, peer);
  };
}

/** @param {(peer:bigint)=>void} close */
function createPeerRegistry(close) {
  /** @type {Map<string,Set<object>>} */
  const owners = new Map();
  return {
    /** @param {object} room @param {string} peer */
    retain(room, peer) {
      const current = owners.get(peer) ?? new Set();
      current.add(room);
      owners.set(peer, current);
    },
    /** @param {object} room @param {string} peer */
    release(room, peer) {
      const current = owners.get(peer);
      if (!current?.delete(room) || current.size) return;
      owners.delete(peer);
      close(BigInt(peer));
    },
    /** @param {object} room */
    peers(room) { return [...owners].filter(([, rooms]) => rooms.has(room)).map(([peer]) => peer); },
  };
}

// EResult values for connection loss, timeout, unavailable service, failed connection,
// remote disconnect and CM handoff. Account failures remain terminal.
const transientDisconnect = new Set([3, 16, 20, 35, 38, 48,
  'NoConnection', 'Timeout', 'ServiceUnavailable', 'ConnectFailed', 'RemoteDisconnect', 'TryAnotherCM']);

/** @param {number} timeoutMs @param {(reason:string|number)=>void} expired */
function createRecoveryWindow(timeoutMs, expired) {
  /** @type {{timer:ReturnType<typeof setTimeout>,done:Promise<void>,finish:()=>void}|null} */
  let window = null;
  let connected = false;
  function clear() {
    if (window) {
      clearTimeout(window.timer);
      window.finish();
      window = null;
    }
    connected = false;
  }
  return {
    get waiting() { return window?.done; },
    get connected() { return connected; },
    markConnected() { connected = window !== null; },
    /** @param {string|number} reason */
    begin(reason) {
      connected = false;
      if (window) return false;
      /** @type {()=>void} */
      let finish;
      /** @type {Promise<void>} */
      const done = new Promise(resolve => { finish = resolve; });
      const timer = setTimeout(() => { clear(); expired(reason); }, timeoutMs);
      window = {timer, done, finish:() => finish()};
      return true;
    },
    clear,
  };
}

module.exports = { bindSessionCloser, createPeerRegistry, createRecoveryWindow, transientDisconnect };
