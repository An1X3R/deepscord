// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DEFAULT_SCREEN_PREFERENCES } from '../public/js/screen-preferences.js';
import {parseInterfaceScheme} from '../public/js/interface-scheme.js';

const require = createRequire(import.meta.url);
/** @type {typeof import('../desktop/client-preferences.cjs')} */
const { createClientPreferences } = require('../desktop/client-preferences.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deepscord-interaction-preferences-'));
const filename = path.join(directory, 'client-preferences.json');
const legacy = {
  peerVolumes: { peer: 73 }, color: '#7c6cf5', inputDeviceId: 'default', outputDeviceId: 'default',
  micVolume: 115, outVolume: 67, mode: 'vad', pttKey: 'KeyV', vadThreshold: -42,
  echoCancellation: true, noiseSuppression: true, autoGainControl: true,
  monitor: false, sounds: false, membersOpen: true, screenPreferences: DEFAULT_SCREEN_PREFERENCES,
};
try {
  fs.writeFileSync(filename, JSON.stringify({ version: 1, settings: legacy, lastChannel: null }));
  const store = createClientPreferences(directory), migrated = store.read().settings;
  assert.deepEqual(migrated, { ...legacy, interactionSounds: true, interactionVolume: 20, radioVolume: 10, interfaceSelection: null, interfaceProfile: {version:1,preset:'industrial',motion:'reduced',navigation:'rail',memberPanel:'expanded'}, localTheme: null });
  assert.throws(() => store.saveSettings({ ...legacy, radioVolume: 30 }), TypeError, 'Current writes must explicitly contain interaction settings');
  const chosen = { ...legacy, interactionSounds: false, interactionVolume: 37, radioVolume: 10, interfaceSelection: null, interfaceProfile: {version:1,preset:'industrial',motion:'reduced',navigation:'rail',memberPanel:'expanded'}, localTheme: null };
  store.saveSettings(chosen);
  assert.deepEqual(store.read().settings, chosen, 'Both sound toggles and all prior values must survive a real disk round trip');
  const radioChosen = { ...chosen, radioVolume: 12 };
  store.saveSettings(radioChosen);
  assert.deepEqual(createClientPreferences(directory).read().settings, radioChosen, 'Local radio volume must survive a new preference store without changing other levels');
  const interfaceProfile={version:1,preset:'constructivist',motion:'full',navigation:'index',memberPanel:'compact'};
  store.saveSettings({...radioChosen,interfaceProfile:{...interfaceProfile,extra:'strip'}});
  assert.deepEqual(createClientPreferences(directory).read().settings,{...radioChosen,interfaceProfile},'Local interface structure must survive a new native store and strip extra fields');
  assert.throws(()=>store.saveSettings({...radioChosen,interfaceProfile:{...interfaceProfile,version:2}}),TypeError);
  assert.throws(()=>store.saveSettings({...radioChosen,interfaceProfile:{...interfaceProfile,motion:'invalid'}}),TypeError);
  assert.throws(() => store.saveSettings({ ...chosen, radioVolume: -1 }), RangeError);
  assert.throws(() => store.saveSettings({ ...chosen, radioVolume: 101 }), RangeError);
  assert.throws(() => store.saveSettings({ ...chosen, radioVolume: '30' }), RangeError);
  const theme = { accent: '#123456', background: 'midnight', density: 'compact', corners: 'soft' };
  store.saveSettings({ ...chosen, localTheme: { ...theme, ignored: 'strip' } });
  assert.deepEqual(createClientPreferences(directory).read().settings, { ...chosen, localTheme: theme }, 'Local theme must survive process-independent reads and strip unrelated fields');
  assert.throws(() => store.saveSettings({ ...chosen, localTheme: { ...theme, accent: 'red' } }), TypeError);
  assert.throws(() => store.saveSettings({ ...chosen, localTheme: { ...theme, background: 'invalid' } }), TypeError);
  assert.throws(() => store.saveSettings({ ...chosen, localTheme: { accent: '#123456' } }), TypeError);
  const scheme=parseInterfaceScheme(JSON.parse(fs.readFileSync(new URL('../public/customization/interfaces/constructivist.json',import.meta.url),'utf8')));
  store.saveSettings({...chosen,interfaceSelection:{scheme,values:{'content-spacing':20,'title-scale':1.2,ignored:true}}});
  const selected=createClientPreferences(directory).read().settings;
  assert.deepEqual(selected?.interfaceSelection,{scheme,values:{'content-spacing':20,'title-scale':1.2,'material-mode':'print','construction-rig':true}},'Scheme snapshot and canonical option values must survive an independent disk read');
  assert.deepEqual(selected?.localTheme,scheme.theme,'Saved scheme must supply its complete theme');
  assert.deepEqual(selected?.interfaceProfile,scheme.interfaceProfile,'Saved scheme must supply its complete interface structure');
  const openScheme=parseInterfaceScheme({...scheme,presentation:{html:'h'.repeat(128*1024),css:'c'.repeat(128*1024),script:'s'.repeat(128*1024)}});
  store.saveSettings({...chosen,interfaceSelection:{scheme:openScheme,values:{}}});
  assert(fs.statSync(filename).size>256*1024,'Full theme snapshots must exceed the old settings file budget in this regression');
  assert.deepEqual(createClientPreferences(directory).read().settings?.interfaceSelection?.scheme.presentation,openScheme.presentation,'Full HTML, CSS and script snapshots must survive a new native preference store');
  assert.throws(()=>store.saveSettings({...chosen,interfaceSelection:{scheme,values:{'content-spacing':400}}}),RangeError);
  store.saveSettings(chosen);
  assert.equal(createClientPreferences(directory).read().settings?.localTheme, null, 'Reset must persist without inheriting any server theme');
  assert.throws(() => store.saveSettings({ ...chosen, interactionSounds: 'false' }), TypeError);
  assert.throws(() => store.saveSettings({ ...chosen, interactionVolume: 101 }), RangeError);
  assert.throws(() => store.saveSettings({ ...chosen, interactionVolume: -1 }), RangeError);
  fs.writeFileSync(filename, JSON.stringify({ version: 1, settings: { ...chosen, interactionVolume: '20' }, lastChannel: null }));
  assert.throws(() => store.read(), RangeError, 'Malformed stored fields must fail rather than receive legacy defaults');
  console.log(JSON.stringify({ event: 'interaction-audio-preferences-passed', legacyMigration: true, strictCurrentWrites: true, realDiskRoundTrip: true }));
} finally { fs.rmSync(directory, { recursive: true }); }
