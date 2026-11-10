// @ts-check
export const THEME_COLORS=['--bg','--bg-side','--bg-rail','--bg-elev','--bg-elev2','--bg-input','--text','--text-2','--text-3','--accent','--accent-2','--accent-ink','--accent-soft','--accent-glow','--accent-border','--hover','--hover-2','--line','--line-2','--danger','--danger-text','--danger-soft','--green','--green-soft','--warn'];
/** @param {import('./network-protocol.js').JsonValue} input @returns {Record<string,string>} */
export function parseThemeColors(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('Theme colors require an object');
  /** @type {Record<string,string>} */const result={};
  for(const name of THEME_COLORS){const value=input[name];if(value===undefined)continue;if(typeof value!=='string'||value.length<1||value.length>256||/[;{}<>\\\x00-\x1f]/.test(value)||/url\s*\(/i.test(value))throw new TypeError('Invalid theme color: '+name);result[name]=value;}
  return result;
}
