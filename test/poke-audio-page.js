// @ts-check
import { createPokeAudio } from '../public/js/poke-audio.js';

/** @type {import('../public/js/poke-audio.js').PokeOutput} */
const output = { volume: 100, deafened: false, deviceId: 'default' };
/** @type {string[]} */ const errors = [];
localStorage.removeItem('deepscord.poke-audio.v1');
const player = createPokeAudio({ getOutput: () => output, getPeerVolume: () => 100, reportError: error => errors.push(error.message) });
if (player.getSettings().volume !== 20) throw new Error('Fresh receiver sound volume must be 20 percent');
const hit = { fromUserId: 'integration-peer', combo: 10, boom: true };
Object.assign(window, {
  pokeAudioTest: {
    player, output, errors,
    silent: () => player.play({ ...hit, boom: false }),
    cancelled: async () => { const pending = player.play(hit); player.stop(); await pending; },
    play: () => player.play(hit),
    prepareIdle: async () => { output.deviceId = 'default'; player.setSettings({ enabled: true, volume: 27 }); player.stop(); await player.refresh(); },
    burst: () => Promise.all(Array.from({ length: 12 }, () => player.play(hit))),
    deafened: async () => { output.deafened = true; await player.refresh(); await player.play(hit); },
    rateLimited: async () => {
      output.deafened = false;
      await player.play(hit);
      player.stop();
      await player.play(hit);
    },
    invalidSink: async () => {
      output.deafened = false; output.deviceId = 'invalid-poke-output-device';
      try { await player.play(hit); }
      catch (error) { if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error; return error.name; }
      throw new Error('Missing output device unexpectedly succeeded');
    },
    close: async () => {
      output.deviceId = 'default';
      player.setSettings({ enabled: true, volume: 27 });
      const pending = player.play(hit);
      await player.close(); await pending; await player.play(hit);
    },
    persisted: async () => {
      player.setSettings({ enabled: false, volume: 27 });
      const next = createPokeAudio({ getOutput: () => output, getPeerVolume: () => 100, reportError: error => errors.push(error.message) });
      const saved = next.getSettings(); await next.close();
      if (saved.enabled !== false || saved.volume !== 27) throw new Error('Receiver audio preference did not persist');
      return saved;
    },
  },
});
