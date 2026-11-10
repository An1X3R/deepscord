// @ts-check
import { createInteractionAudio } from '../public/js/interaction-audio.js';

/** @type {import('../public/js/interaction-audio.js').InteractionOutput} */
const output = { volume: 100, deafened: false, deviceId: 'default' };
const settings = { enabled: true, volume: 20 };
let peerVolume = 50;
/** @type {string[]} */ const errors = [];
/** @type {import('../public/js/customization-protocol.js').CustomInteraction} */
const custom = {id:'custom',name:'Custom',thumbnail:null,model:'bomb',trajectory:'linear',sound:'bomb-2',durationMs:400};
const player = createInteractionAudio({ resolveCustom:(id,revision)=>id==='custom'&&revision==='current'?custom:null, getSettings: () => settings, getOutput: () => output, getPeerVolume: () => peerVolume, reportError: error => errors.push(error.message) });
/** @type {import('../public/js/interaction-audio.js').InteractionAudioEvent} */
const hit = { kind: 'bomb', soundIndex: 0, fromUserId: 'actor', toUserId: 'target' };
Object.assign(window, {
  interactionAudioTest: {
    errors,
    outsider: () => player.play(hit, 'observer'),
    cancelled: async () => { const pending = player.play(hit, 'target'); player.stop(); await pending; },
    memberCancelled: async () => { const pending = player.play({ ...hit, soundIndex: 1 }, 'target'); player.stopMember('actor'); await pending; },
    actor: () => player.play(hit, 'actor'),
    prepareIdle: async () => { output.deviceId = 'default'; player.stop(); await player.refresh(); },
    mutePlayingSender: async () => { output.volume = 0; await player.refresh(); },
    receiver: () => player.play({ ...hit, soundIndex: 1 }, 'target'),
    burst: () => Promise.all(Array.from({ length: 12 }, () => player.play({ ...hit, soundIndex: 2 }, 'target'))),
    cancelledPreferences: async () => {
      const sender = player.play({ ...hit, soundIndex: 2 }, 'actor');
      output.deafened = true; await player.refresh(); output.deafened = false; await player.refresh(); await sender;
      const receiver = player.play({ ...hit, soundIndex: 3 }, 'target');
      settings.enabled = false; await player.refresh(); settings.enabled = true; await player.refresh(); await receiver;
    },
    deafened: async () => { output.deafened = true; await player.refresh(); await player.play(hit, 'actor'); await player.play(hit, 'target'); },
    zeroOutput: async () => { player.stop(); output.volume = 0; await player.refresh(); await player.play(hit, 'actor'); await player.play(hit, 'target'); },
    zeroPeer: async () => { player.stop(); output.volume = 100; output.deafened = false; peerVolume = 0; await player.refresh(); await player.play(hit, 'target'); peerVolume = 50; },
    allAssets: async () => {
      output.deafened = false;
      await player.play({ ...hit, soundIndex: 3 }, 'target');
      await player.play({ ...hit, kind: 'poop', soundIndex: 0 }, 'actor');
    },
    silentSettings: async () => {
      settings.enabled = false; await player.refresh(); await player.play(hit, 'target');
      settings.enabled = true; settings.volume = 0; await player.refresh(); await player.play(hit, 'target');
      settings.volume = 20;
    },
    custom: async () => {
      await player.play({ ...hit,kind:'custom',customId:'custom',customRevision:'stale' }, 'target');
      custom.sound='none';
      await player.play({ ...hit,kind:'custom',customId:'custom',customRevision:'current' }, 'target');
      custom.sound='bomb-2';
      await player.play({ ...hit,kind:'custom',customId:'custom',customRevision:'current' }, 'observer');
      await player.play({ ...hit,kind:'custom',customId:'custom',customRevision:'current' }, 'target');
    },
    invalidSink: async () => {
      output.deviceId = 'invalid-interaction-output-device';
      try { await player.play(hit, 'target'); }
      catch (error) { if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error; return error.name; }
      throw new Error('Missing output device unexpectedly succeeded');
    },
    close: async () => {
      output.deviceId = 'default';
      const pending = player.play(hit, 'target');
      await player.close(); await pending; await player.play(hit, 'target');
    },
    invalidEvent: async () => {
      try { await player.play({ ...hit, soundIndex: 4 }, 'target'); }
      catch (error) { if (!(error instanceof TypeError)) throw error; return error.message; }
      throw new Error('Invalid audio index unexpectedly succeeded');
    },
  },
});
