'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

const PROJECT_ROOT = path.dirname(__dirname);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function under(parent, target) {
  const resolvedParent = path.resolve(parent);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget.startsWith(resolvedParent + path.sep);
}

async function reservePort() {
  const net = require('node:net');
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string', 'Could not reserve a loopback port.');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function serverEnvironment(port, dataDir) {
  const blocked = new Set([
    'PORT', 'HTTP_PORT', 'HTTP_HOST', 'HTTPS_PORT', 'HTTPS_PORTS', 'HTTPS_HOST', 'ECHO_DATA_DIR',
    'ECHO_PASSWORD', 'ECHO_NETWORK_MODE', 'ECHO_MEDIA_POLICY', 'ECHO_STUN_URL', 'ECHO_STUN_URLS',
    'ECHO_TURN_URL', 'ECHO_TURN_SECRET', 'ECHO_TURN_TTL_SECONDS', 'STUN_URL', 'STUN_URLS',
    'TURN_URL', 'TURN_SECRET', 'TURN_TTL_SECONDS', 'TURN_USERNAME', 'TURN_CREDENTIAL',
    'ECHO_TLS_PFX_PATH', 'ECHO_TLS_PFX_PASSWORD', 'ELECTRON_RUN_AS_NODE', 'DEEPSCORD_APP_NETWORK_TEMP',
  ]);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !blocked.has(key)));
  return {
    ...inherited,
    ELECTRON_RUN_AS_NODE: '1',
    PORT: String(port),
    HTTP_HOST: '127.0.0.1',
    HTTPS_PORTS: '0',
    ECHO_DATA_DIR: dataDir,
    ECHO_NETWORK_MODE: 'server',
    ECHO_MEDIA_POLICY: 'direct',
  };
}

function launchServer(port, dataDir) {
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'server.js')], {
    cwd: PROJECT_ROOT,
    env: serverEnvironment(port, dataDir),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output = (output + chunk).slice(-6000); });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output = (output + chunk).slice(-6000); });
  return { child, getOutput: () => output };
}

async function waitForHealth(baseUrl, server) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null && server.child.exitCode !== undefined) {
      throw new Error(`Local server exited during startup: ${server.getOutput()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      await delay(50);
    }
  }
  throw new Error(`Local server readiness timed out: ${server.getOutput()}`);
}

async function stopProcess(child, timeoutMs) {
  if (child.exitCode !== null && child.exitCode !== undefined || child.signalCode !== null && child.signalCode !== undefined) return;
  const exited = once(child, 'exit').then(() => true);
  child.kill();
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const stopped = await Promise.race([exited, timedOut]);
  clearTimeout(timer);
  if (!stopped) {
    child.kill('SIGKILL');
    const forced = await Promise.race([exited, delay(timeoutMs).then(() => false)]);
    assert(forced, 'Owned child process did not exit after forced termination.');
  }
}

function resolveElectronBinary() {
  const configured = process.env.ELECTRON_TEST_BINARY;
  if (configured) {
    const resolved = path.resolve(configured);
    assert(fs.existsSync(resolved) && fs.statSync(resolved).isFile(), `ELECTRON_TEST_BINARY does not name a file: ${resolved}`);
    return resolved;
  }
  try {
    const installed = require('electron');
    assert(typeof installed === 'string' && fs.existsSync(installed) && fs.statSync(installed).isFile(), 'The locally installed electron package did not resolve to an executable.');
    return installed;
  } catch (error) {
    throw new Error(`Electron runtime unavailable. Set ELECTRON_TEST_BINARY to an Electron executable or install this project’s Electron dependency. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createRuntimeCopy(sourceExecutable) {
  const toolsDir = path.resolve(PROJECT_ROOT, '.qa-tools');
  const source = path.dirname(sourceExecutable);
  const destination = path.join(toolsDir, 'app-native-runtime');
  const sourceApp = path.resolve(source, 'resources', 'app');
  const sourceAppPrefix = sourceApp + path.sep;
  assert(path.dirname(destination) === toolsDir, 'Runtime copy escaped the QA tools directory.');
  assert(path.resolve(source) !== path.resolve(destination) && !under(destination, source), 'ELECTRON_TEST_BINARY must not be inside the isolated runtime copy.');
  assert(fs.existsSync(sourceExecutable), `Electron executable is missing: ${sourceExecutable}`);
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    force: true,
    filter: (sourcePath) => {
      const resolved = path.resolve(sourcePath);
      return resolved !== sourceApp && !resolved.startsWith(sourceAppPrefix);
    },
  });

  const copiedApp = path.join(destination, 'resources', 'app');
  fs.mkdirSync(copiedApp, { recursive: true });
  const packageJson = { name: 'deepscord-app-network-check', version: '1.0.0', main: 'main.js' };
  const testPath = path.join(PROJECT_ROOT, 'test', 'app-network.cjs');
  fs.writeFileSync(path.join(copiedApp, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf8');
  fs.writeFileSync(path.join(copiedApp, 'main.js'), `'use strict';\nrequire(${JSON.stringify(testPath)});\n`, 'utf8');

  const executable = path.join(destination, path.basename(sourceExecutable));
  assert(fs.existsSync(executable) && fs.statSync(executable).isFile(), `Copied Electron executable is missing: ${executable}`);
  assert(under(toolsDir, executable), 'Electron executable escaped the QA tools directory.');
  return { executable, destination };
}

async function launchElectronRunner(executable, tempDir) {
  const { ELECTRON_RUN_AS_NODE, ...childEnvironment } = process.env;
  const child = spawn(executable, [], {
    cwd: PROJECT_ROOT,
    env: { ...childEnvironment, DEEPSCORD_APP_NETWORK_TEMP: tempDir },
    stdio: 'inherit',
    windowsHide: true,
  });
  const failedToStart = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  await failedToStart;
  const timeoutMs = 180000;
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const ended = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
  const result = await Promise.race([ended, timedOut]);
  clearTimeout(timer);
  if (result === null) {
    await stopProcess(child, 5000);
    throw new Error(`Electron app-network runner exceeded ${timeoutMs} ms.`);
  }
  if (result.code !== 0) throw new Error(`Electron app-network runner failed with code ${result.code} (${result.signal || 'no signal'}).`);
}

function runUnderElectron() {
  const { app, BrowserWindow, session } = require('electron');
  const tempParent = path.resolve(os.tmpdir());
  const tempDir = process.env.DEEPSCORD_APP_NETWORK_TEMP;
  assert(typeof tempDir === 'string' && path.dirname(path.resolve(tempDir)) === tempParent &&
    /^deepscord-app-network-/.test(path.basename(tempDir)), 'Test temp directory is missing or unsafe.');
  let server = null;
  /** @type {import('electron').BrowserWindow[]} */
  const windows = [];
  /** @type {string[]} */
  const browserErrors = [];
  const report = { status: 'running', media: 'not checked', observations: [] };
  app.setPath('userData', path.join(tempDir, 'electron-user-data'));
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.on('window-all-closed', () => {});

  function logObservation(stage, details) {
    report.observations.push({ stage, details });
    console.log(JSON.stringify({ stage, details }));
  }

  async function waitFor(label, predicate, timeoutMs, intervalMs) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await predicate();
      if (last && last.ok) return last.value;
      await delay(intervalMs);
    }
    throw new Error(`${label} timed out: ${JSON.stringify(last && last.value)}; renderer errors=${JSON.stringify(browserErrors.slice(-12))}`);
  }

  async function waitForStable(label, readState, isStable, timeoutMs, intervalMs, sampleCount) {
    const deadline = Date.now() + timeoutMs;
    let matchingSamples = 0;
    let previousKey = '';
    let last = null;
    while (Date.now() < deadline) {
      last = await readState();
      if (isStable(last)) {
        const key = JSON.stringify(last);
        matchingSamples = key === previousKey ? matchingSamples + 1 : 1;
        previousKey = key;
        if (matchingSamples >= sampleCount) return last;
      } else {
        matchingSamples = 0;
        previousKey = '';
      }
      await delay(intervalMs);
    }
    throw new Error(`${label} did not settle: ${JSON.stringify(last)}`);
  }

  async function inspect(window) {
    return window.webContents.executeJavaScript(`(() => {
      if (!window.echo) return { loaded: false };
      const state = window.echo.getState();
      const voice = window.echo.getVoiceStats();
      const peers = voice ? Object.entries(voice.peers).map(([id, peer]) => ({
        id,
        state: peer.state,
        pcState: peer.pcState,
        iceState: peer.iceState,
        hasAudio: peer.hasAudio,
        micReady: peer.micReady,
        route: peer.route,
        bytesSent: peer.bytesSent,
        bytesReceived: peer.bytesReceived,
        roundTripMs: peer.roundTripMs,
        codecMimeType: peer.codecMimeType,
        codecClockRate: peer.codecClockRate,
        jitterMs: peer.jitterMs,
        jitterBufferMs: peer.jitterBufferMs,
      })) : [];
      return {
        loaded: true,
        selfId: state.selfId,
        connStatus: state.connStatus,
        roomReady: state.roomReady,
        voiceChannelId: state.voiceChannelId,
        desiredVoiceChannelId: state.desiredVoiceChannelId,
        users: state.users.map((user) => ({ id: user.id, voiceChannelId: user.voiceChannelId })),
        micReady: !!(voice && voice.micReady),
        localLevel: voice ? voice.localLevel : null,
        peers,
        voiceChannels: state.servers.flatMap((server) => server.channels)
          .filter((channel) => channel.type === 'voice')
          .map((channel) => ({ id: channel.id, name: channel.name })),
      };
    })()`, true);
  }

  async function createWindow(name, origin, partition) {
    const ses = session.fromPartition(partition);
    const permissionAllowed = (webContents, permission, requestingOrigin, details) => {
      if (permission !== 'media') return false;
      let pageOrigin = '';
      try { pageOrigin = new URL(webContents.getURL()).origin; } catch { return false; }
      if (pageOrigin !== origin || requestingOrigin && requestingOrigin !== origin) return false;
      const mediaTypes = details && details.mediaTypes;
      if (Array.isArray(mediaTypes)) return mediaTypes.length === 1 && mediaTypes[0] === 'audio';
      return details && details.mediaType === 'audio';
    };
    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
      callback(permissionAllowed(webContents, permission, origin, details));
    });
    ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      return permissionAllowed(webContents, permission, requestingOrigin, details);
    });

    const window = new BrowserWindow({
      width: 1160,
      height: 780,
      show: false,
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    windows.push(window);
    window.webContents.on('console-message', (details) => {
      if (details.level === 'error' && browserErrors.length < 30) browserErrors.push(`${name}: ${String(details.message).slice(0, 300)}`);
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      browserErrors.push(`${name}: renderer exited (${details.reason})`);
    });
    await window.loadURL(`${origin}/?name=${encodeURIComponent(name)}`);
    await waitFor(`${name} room ready`, async () => {
      const state = await inspect(window);
      return { ok: state.loaded && state.roomReady && typeof state.selfId === 'string' && state.selfId.length > 0, value: state };
    }, 20000, 100);
    return window;
  }

  async function createLimitedVoiceChannel(wsUrl, channelName) {
    const ws = new WebSocket(wsUrl);
    const inbox = [];
    const waiters = [];
    ws.addEventListener('message', (event) => {
      assert(typeof event.data === 'string', 'Admin WebSocket returned a non-text message.');
      const message = JSON.parse(event.data);
      inbox.push(message);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index];
        if (message.t === waiter.type && waiter.predicate(message)) {
          waiters.splice(index, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
    });
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('Temporary admin WebSocket failed to connect.')), { once: true });
    });
    const waitMessage = (type, predicate, timeoutMs) => {
      const existing = inbox.find((message) => message.t === type && predicate(message));
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          type,
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error(`Temporary admin WebSocket timed out waiting for ${type}.`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    };
    const closed = new Promise((resolve) => ws.addEventListener('close', resolve, { once: true }));
    try {
      ws.send(JSON.stringify({ t: 'hello', name: 'Temporary room admin', resumable: false }));
      await waitMessage('welcome', () => true, 5000);
      ws.send(JSON.stringify({ t: 'createChannel', serverId: 'srv-main', type: 'voice', name: channelName, userLimit: 1 }));
      const update = await waitMessage('servers', (message) => message.servers[0].channels.some((channel) => channel.name === channelName), 5000);
      const channel = update.servers[0].channels.find((entry) => entry.name === channelName);
      assert(channel && channel.type === 'voice' && channel.userLimit === 1, 'Server did not create the requested limited voice channel.');
      return channel;
    } finally {
      ws.close();
      await closed;
    }
  }

  async function probeMicrophone(window) {
    return window.webContents.executeJavaScript(`navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then((stream) => {
        for (const track of stream.getTracks()) track.stop();
        return { available: true };
      })
      .catch((error) => ({ available: false, name: error.name, message: String(error.message || error).slice(0, 180) }))`, true);
  }

  async function join(window, channelId) {
    await window.webContents.executeJavaScript(`window.echo.actions.joinVoice(${JSON.stringify(channelId)}); true`, true);
  }

  async function waitOnline(window, name) {
    return waitFor(`${name} restored authenticated room`, async () => {
      const state = await inspect(window);
      return { ok: state.roomReady && state.connStatus === 'open', value: state };
    }, 20000, 150);
  }

  async function waitOffline(window, name) {
    return waitFor(`${name} observed server outage`, async () => {
      const state = await inspect(window);
      const down = ['disconnected', 'reconnecting'].includes(state.connStatus);
      return { ok: down && !state.roomReady, value: state };
    }, 10000, 100);
  }

  async function waitForHealth(baseUrl) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (server.child.exitCode !== null && server.child.exitCode !== undefined) throw new Error(`Server exited: ${server.getOutput()}`);
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) return;
      } catch {
        await delay(50);
      }
    }
    throw new Error(`Server health timed out: ${server.getOutput()}`);
  }

  async function run() {
    await app.whenReady();

    const dataDir = path.join(tempDir, 'server-data');
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    server = launchServer(port, dataDir);
    await waitForHealth(origin);
    const publicConfig = await (await fetch(`${origin}/api/config`)).json();
    assert(publicConfig.networkMode === 'server' && publicConfig.mediaPolicy === 'direct', 'Test server did not start in loopback direct mode.');
    assert(!Object.hasOwn(publicConfig, 'iceServers'), 'Public config unexpectedly exposed ICE credentials.');

    const runId = `${process.pid}-${Date.now()}`;
    const alice = await createWindow('Alice', origin, `persist:app-network-alice-${runId}`);
    const bob = await createWindow('Bob', origin, `persist:app-network-bob-${runId}`);
    const initialAlice = await inspect(alice);
    const initialBob = await inspect(bob);
    assert(initialAlice.selfId !== initialBob.selfId, 'Independent renderers received the same user identity.');
    logObservation('authenticated-renderers', {
      alice: { selfId: initialAlice.selfId, roomReady: initialAlice.roomReady, mode: 'server', mediaPolicy: 'direct' },
      bob: { selfId: initialBob.selfId, roomReady: initialBob.roomReady },
    });

    const microphoneResults = await Promise.all([probeMicrophone(alice), probeMicrophone(bob)]);
    const microphoneAvailable = microphoneResults.every((result) => result.available);
    report.media = microphoneAvailable ? 'available' : 'unavailable';
    let firstPair = null;
    const channelId = initialAlice.voiceChannels[0] && initialAlice.voiceChannels[0].id;
    if (!microphoneAvailable) {
      const unavailable = microphoneResults.filter((result) => !result.available);
      if (unavailable.some((result) => !['NotFoundError', 'NotReadableError', 'AbortError'].includes(result.name))) {
        throw new Error(`Microphone permission or browser setup failed instead of reporting missing hardware: ${JSON.stringify(unavailable)}`);
      }
      console.log(JSON.stringify({ stage: 'media-check-skipped', reason: 'No usable physical microphone was available; no fake device was enabled.', results: microphoneResults }));
    } else {
      assert(typeof channelId === 'string', 'Server has no voice channel for the native app check.');
      await alice.webContents.executeJavaScript(`(async () => {
        const pending = window.echo.actions.joinVoice(${JSON.stringify(channelId)});
        window.echo.actions.leaveVoice();
        await pending;
        return true;
      })()`, true);
      const cancelledJoin = await waitForStable('cancelled initial join state', async () => {
        const [aliceState, bobState] = await Promise.all([inspect(alice), inspect(bob)]);
        const aliceOnBob = bobState.users.find((user) => user.id === aliceState.selfId) || null;
        return { alice: aliceState, bob: bobState, aliceOnBob };
      }, (state) => state.alice.voiceChannelId === null && !state.alice.micReady &&
        state.bob.roomReady && state.aliceOnBob !== null && state.aliceOnBob.voiceChannelId === null,
      7000, 100, 5);
      logObservation('initial-join-cancelled-before-server-admission', {
        alice: { selfId: cancelledJoin.alice.selfId, voiceChannelId: cancelledJoin.alice.voiceChannelId, micReady: cancelledJoin.alice.micReady },
        publicUserAtBob: cancelledJoin.aliceOnBob,
      });
      await join(alice, channelId);
      await waitFor('production microphone ready before settings controls', async () => {
        const state = await inspect(alice);
        return { ok: state.micReady && state.voiceChannelId === channelId, value: state };
      }, 15000, 100);
      const stableTrackId = await alice.webContents.executeJavaScript('window.echo.getVoiceStats().capture.outputTrackId', true);
      assert(typeof stableTrackId === 'string', 'Production capture has no output track');
      await alice.webContents.executeJavaScript('window.echo.actions.openVoiceSettings(); true', true);
      for (const preferences of [
        { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        { echoCancellation: false, noiseSuppression: true, autoGainControl: false },
        { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      ]) {
        await alice.webContents.executeJavaScript(`(() => {
          const preferences = ${JSON.stringify(preferences)};
          for (const [key, id] of [['echoCancellation','audioEchoCancellation'],['noiseSuppression','audioNoiseSuppression'],['autoGainControl','audioAutoGainControl']]) {
            const input = document.getElementById(id);
            if (!(input instanceof HTMLInputElement)) throw new Error('Missing stable audio control: ' + id);
            input.checked = preferences[key];
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return true;
        })()`, true);
        await waitFor('production microphone enhancement controls applied', async () => {
          const value = await alice.webContents.executeJavaScript(`(() => {
            const voice = window.echo.getVoiceStats();
            const status = document.getElementById('audioCaptureStatus');
            return { ...voice.capture, ready: voice.micReady, channelId: voice.channelId, status: status?.textContent };
          })()`, true);
          return { ok: value.ready && !value.pending && value.error === null && value.channelId === channelId &&
            value.outputTrackId === stableTrackId && Object.entries(preferences).every(([key, flag]) => value.actual?.[key] === flag) &&
            value.status?.includes('实际状态'), value };
        }, 15000, 100);
      }
      await alice.webContents.executeJavaScript("document.getElementById('audioSettingsDone').click(); true", true);
      logObservation('production-microphone-enhancement-ui', { combinations: 3, actualTrackSettingsVerified: true, stableOutputTrack: true });
      await Promise.all([join(alice, channelId), join(bob, channelId)]);
      firstPair = await waitFor('both app audio links connected and measured', async () => {
        const [a, b] = await Promise.all([inspect(alice), inspect(bob)]);
        const connectedPeer = (state, expectedId) => state.peers.length === 1 && state.peers[0].id === expectedId &&
          state.peers[0].pcState === 'connected' && state.peers[0].hasAudio && state.peers[0].route === 'direct' &&
          state.peers[0].bytesSent > 0 && state.peers[0].bytesReceived > 0 &&
          state.peers[0].roundTripMs !== null && state.peers[0].codecMimeType?.toLowerCase() === 'audio/opus' &&
          state.peers[0].codecClockRate === 48000 && state.peers[0].jitterMs !== null && state.peers[0].jitterBufferMs !== null;
        const ok = a.micReady && b.micReady && a.voiceChannelId === channelId && b.voiceChannelId === channelId &&
          connectedPeer(a, b.selfId) && connectedPeer(b, a.selfId);
        return { ok, value: { alice: a, bob: b } };
      }, 30000, 200);
      logObservation('native-audio-connected', {
        alice: { selfId: firstPair.alice.selfId, micReady: firstPair.alice.micReady, localLevel: firstPair.alice.localLevel, peers: firstPair.alice.peers },
        bob: { selfId: firstPair.bob.selfId, micReady: firstPair.bob.micReady, localLevel: firstPair.bob.localLevel, peers: firstPair.bob.peers },
      });

      const limitedName = 'QA Capacity Room';
      const limitedChannel = await createLimitedVoiceChannel(`${origin.replace(/^http/, 'ws')}/ws`, limitedName);
      await join(alice, limitedChannel.id);
      const aliceInLimited = await waitFor('Alice switched to the one-person room', async () => {
        const [a, b] = await Promise.all([inspect(alice), inspect(bob)]);
        const bobSeesAlice = b.users.find((user) => user.id === a.selfId);
        const aliceSeesBob = a.users.find((user) => user.id === b.selfId);
        const ok = a.voiceChannelId === limitedChannel.id && a.micReady && a.peers.length === 0 &&
          b.voiceChannelId === channelId && b.micReady && b.peers.length === 0 &&
          bobSeesAlice && bobSeesAlice.voiceChannelId === limitedChannel.id && aliceSeesBob && aliceSeesBob.voiceChannelId === channelId;
        return { ok, value: { alice: a, bob: b } };
      }, 10000, 100);
      logObservation('alice-switched-to-limited-room', {
        alice: { selfId: aliceInLimited.alice.selfId, voiceChannelId: aliceInLimited.alice.voiceChannelId, micReady: aliceInLimited.alice.micReady, peers: aliceInLimited.alice.peers },
        bob: { selfId: aliceInLimited.bob.selfId, voiceChannelId: aliceInLimited.bob.voiceChannelId, micReady: aliceInLimited.bob.micReady, peers: aliceInLimited.bob.peers },
      });
      await bob.webContents.executeJavaScript(`window.echo.actions.joinVoice(${JSON.stringify(limitedChannel.id)}); true`, true);
      const rejectedBob = await waitForStable('Bob remained in lobby after the full-room rejection', async () => {
        const [a, b] = await Promise.all([inspect(alice), inspect(bob)]);
        const bobUser = b.users.find((user) => user.id === b.selfId);
        const aliceUser = b.users.find((user) => user.id === a.selfId);
        const capacityToast = await bob.webContents.executeJavaScript(
          `[...document.querySelectorAll('.toast-error .toast-text')].map((node) => node.textContent || '')`, true);
        return {
          aliceId: a.selfId,
          aliceChannelId: a.voiceChannelId,
          alicePeers: a.peers.map((peer) => ({ id: peer.id, pcState: peer.pcState })),
          bobId: b.selfId,
          bobChannelId: b.voiceChannelId,
          bobMicReady: b.micReady,
          bobUserChannelId: bobUser && bobUser.voiceChannelId,
          aliceUserChannelId: aliceUser && aliceUser.voiceChannelId,
          bobPeers: b.peers.map((peer) => ({ id: peer.id, pcState: peer.pcState })),
          capacityRejected: capacityToast.some((message) => message.includes('人数已满')),
        };
      }, (state) => state.aliceChannelId === limitedChannel.id && state.bobChannelId === channelId &&
        state.bobMicReady && state.bobUserChannelId === channelId && state.aliceUserChannelId === limitedChannel.id &&
        state.alicePeers.length === 0 && state.bobPeers.length === 0 && state.capacityRejected,
      8000, 100, 4);
      logObservation('full-room-rejection-preserved-lobby-session', rejectedBob);

      await join(alice, channelId);
      const backInLobby = await waitForStable('Alice returned to lobby with exactly one connected peer', async () => {
        const [a, b] = await Promise.all([inspect(alice), inspect(bob)]);
        return {
          aliceId: a.selfId,
          bobId: b.selfId,
          aliceChannelId: a.voiceChannelId,
          bobChannelId: b.voiceChannelId,
          aliceMicReady: a.micReady,
          bobMicReady: b.micReady,
          alicePeers: a.peers.map((peer) => ({ id: peer.id, pcState: peer.pcState, hasAudio: peer.hasAudio, route: peer.route })),
          bobPeers: b.peers.map((peer) => ({ id: peer.id, pcState: peer.pcState, hasAudio: peer.hasAudio, route: peer.route })),
        };
      }, (state) => state.aliceChannelId === channelId && state.bobChannelId === channelId && state.aliceMicReady && state.bobMicReady &&
        state.alicePeers.length === 1 && state.alicePeers[0].id === state.bobId && state.alicePeers[0].pcState === 'connected' && state.alicePeers[0].hasAudio &&
        state.bobPeers.length === 1 && state.bobPeers[0].id === state.aliceId && state.bobPeers[0].pcState === 'connected' && state.bobPeers[0].hasAudio,
      20000, 100, 5);
      logObservation('channel-switch-return-reconnected-once', backInLobby);
    }

    await stopProcess(server.child, 5000);
    const outage = await Promise.all([waitOffline(alice, 'Alice'), waitOffline(bob, 'Bob')]);
    if (microphoneAvailable) {
      for (const state of outage) {
        assert(state.micReady, 'The app stopped its microphone while the signaling server was down.');
        assert(state.voiceChannelId, 'The app cleared voice membership while signaling was down.');
        assert(state.peers.length === 1 && state.peers[0].pcState === 'connected', 'Peer media connection did not survive the signaling outage.');
      }
      logObservation('signaling-outage-media-retained', outage.map((state) => ({ selfId: state.selfId, connStatus: state.connStatus, roomReady: state.roomReady, voiceChannelId: state.voiceChannelId, micReady: state.micReady, peers: state.peers })));
    } else {
      logObservation('signaling-outage-without-microphone', outage.map((state) => ({ selfId: state.selfId, connStatus: state.connStatus, roomReady: state.roomReady })));
    }

    server = launchServer(port, dataDir);
    await waitForHealth(origin);
    const online = await Promise.all([waitOnline(alice, 'Alice'), waitOnline(bob, 'Bob')]);
    assert(online[0].selfId === initialAlice.selfId, 'Alice identity changed after server restart.');
    assert(online[1].selfId === initialBob.selfId, 'Bob identity changed after server restart.');
    if (microphoneAvailable) {
      const restored = await waitFor('voice membership and peer links restored without duplicates', async () => {
        const [a, b] = await Promise.all([inspect(alice), inspect(bob)]);
        const ok = a.voiceChannelId === firstPair.alice.voiceChannelId && b.voiceChannelId === firstPair.bob.voiceChannelId &&
          a.peers.length === 1 && b.peers.length === 1 && a.peers[0].id === b.selfId && b.peers[0].id === a.selfId &&
          a.peers[0].pcState === 'connected' && b.peers[0].pcState === 'connected' && a.peers[0].hasAudio && b.peers[0].hasAudio;
        return { ok, value: { alice: a, bob: b } };
      }, 30000, 200);
      assert(restored.alice.micReady && restored.bob.micReady, 'Microphone did not remain active after restart.');
      logObservation('server-restart-resumed', {
        alice: { selfId: restored.alice.selfId, roomReady: restored.alice.roomReady, voiceChannelId: restored.alice.voiceChannelId, peers: restored.alice.peers },
        bob: { selfId: restored.bob.selfId, roomReady: restored.bob.roomReady, voiceChannelId: restored.bob.voiceChannelId, peers: restored.bob.peers },
      });

      await stopProcess(server.child, 5000);
      await Promise.all([waitOffline(alice, 'Alice before data-channel leave'), waitOffline(bob, 'Bob before data-channel leave')]);
      await alice.webContents.executeJavaScript('window.echo.actions.leaveVoice(); true', true);
      const bobAfterLeave = await waitFor('remote peer removed through the peer data channel while signaling is down', async () => {
        const state = await inspect(bob);
        return { ok: state.peers.length === 0, value: state };
      }, 10000, 100);
      const aliceAfterLeave = await inspect(alice);
      assert(aliceAfterLeave.voiceChannelId === null && !aliceAfterLeave.micReady, 'Local leave did not stop its voice session.');
      assert(bobAfterLeave.voiceChannelId === firstPair.bob.voiceChannelId, 'Remote data-channel leave unexpectedly cleared the other user’s room membership.');
      logObservation('leave-over-data-channel-offline', {
        alice: { selfId: aliceAfterLeave.selfId, voiceChannelId: aliceAfterLeave.voiceChannelId, micReady: aliceAfterLeave.micReady, peers: aliceAfterLeave.peers },
        bob: { selfId: bobAfterLeave.selfId, voiceChannelId: bobAfterLeave.voiceChannelId, peers: bobAfterLeave.peers },
      });
    }

    report.status = 'passed';
  }

  async function cleanup() {
    for (const window of windows) {
      if (!window.isDestroyed()) window.destroy();
    }
    if (server) await stopProcess(server.child, 5000);
  }

  app.whenReady().then(async () => {
    try {
      await run();
      console.log(JSON.stringify({ stage: 'result', status: report.status, media: report.media }));
    } catch (error) {
      report.status = 'failed';
      console.error(JSON.stringify({ stage: 'result', status: report.status, media: report.media, error: error instanceof Error ? error.message : String(error), observations: report.observations.slice(-4), rendererErrors: browserErrors.slice(-12) }));
      process.exitCode = 1;
    } finally {
      try {
        await cleanup();
      } catch (error) {
        process.exitCode = 1;
        console.error(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      app.exit(process.exitCode ? 1 : 0);
    }
  });
}

if (process.versions.electron) {
  runUnderElectron();
} else if (require.main === module) {
  (async () => {
    let tempDir = null;
    try {
      const electronBinary = resolveElectronBinary();
      const runtime = createRuntimeCopy(electronBinary);
      const tempParent = path.resolve(os.tmpdir());
      tempDir = fs.mkdtempSync(path.join(tempParent, 'deepscord-app-network-'));
      assert(path.dirname(path.resolve(tempDir)) === tempParent, 'Temporary data path is outside the OS temporary directory.');
      assert(/^deepscord-app-network-/.test(path.basename(tempDir)), 'Temporary data path marker is invalid.');
      await launchElectronRunner(runtime.executable, tempDir);
    } catch (error) {
      console.error(`App network runner failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    } finally {
      if (tempDir) {
        const tempParent = path.resolve(os.tmpdir());
        assert(path.dirname(path.resolve(tempDir)) === tempParent, 'Refusing to remove a temporary directory outside the OS temp path.');
        assert(/^deepscord-app-network-/.test(path.basename(tempDir)), 'Refusing to remove an unrecognized temporary directory.');
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  })();
}
