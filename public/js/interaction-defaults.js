// @ts-check
import { SCENE_EXAMPLES } from './interaction-scene-examples.js';

/** Keep version-one values and referenced scenes immutable across releases. @returns {import('./customization-protocol.js').CustomInteraction[]} */
export function initialInteractionCatalog() {
  return [
    {id:'default-bomb',name:'炸弹',thumbnail:null,model:'bomb',trajectory:'arc',sound:'bomb-1',durationMs:1000},
    {id:'default-poop',name:'便便',thumbnail:null,model:'poop',trajectory:'linear',sound:'poop',durationMs:650},
    ...structuredClone(SCENE_EXAMPLES),
  ];
}
