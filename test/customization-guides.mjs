// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseInterfaceScheme} from '../public/js/interface-scheme.js';
import {parseCustomInteraction} from '../public/js/customization-protocol.js';
import {initialInteractionCatalog} from '../public/js/interaction-defaults.js';
import {SCENE_EXAMPLES} from '../public/js/interaction-scene-examples.js';

/** @param {'interfaces'|'interactions'} kind @returns {import('../public/js/network-protocol.js').JsonValue[]} */
function examples(kind){
  const text=fs.readFileSync(new URL('../public/customization/'+kind+'/DEVELOPMENT.md',import.meta.url),'utf8');
  assert(Buffer.byteLength(text)<=262144,'Guide must fit the in-app viewer');
  return [...text.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map(match=>JSON.parse(match[1]));
}
const interfaces=examples('interfaces').map(parseInterfaceScheme);
assert.deepEqual(interfaces.map(value=>value.interfaceProfile.preset),['industrial','constructivist']);
const interactions=examples('interactions').map(parseCustomInteraction);
assert.deepEqual(interactions,SCENE_EXAMPLES,'Copyable guide examples must match the shipped scene examples');
for(const entry of initialInteractionCatalog()){
  const template=parseCustomInteraction(JSON.parse(fs.readFileSync(new URL('../public/customization/interactions/'+entry.id+'.json',import.meta.url),'utf8')));
  assert.deepEqual(template,entry,'Interaction folder template must match initial catalog');
}
console.log(JSON.stringify({event:'customization-guide-examples-passed',interfaces:interfaces.length,interactions:interactions.length}));
