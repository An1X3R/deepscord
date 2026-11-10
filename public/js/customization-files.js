// @ts-check
import {parseTheme} from './customization-protocol.js';
import {parseInterfaceProfile} from './interface-profile.js';
import {mediaObject} from './chat-protocol.js';
/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {{version:1,theme:import('./customization-protocol.js').Theme|null,interfaceProfile:import('./interface-profile.js').InterfaceProfile}} InterfaceDefinition */

/** @param {File} file @returns {Promise<JsonValue>} */
export async function readCustomizationFile(file){
  if(file.size>262144)throw new RangeError('自定义文件不能超过 256 KiB');
  return JSON.parse(await file.text());
}
/** @param {JsonValue} value @returns {InterfaceDefinition} */
export function parseInterfaceDefinition(value){
  const row=mediaObject(value,'Interface definition');
  if(row.version!==1)throw new TypeError('Unsupported interface definition version');
  return {version:1,theme:row.theme===null?null:parseTheme(row.theme),interfaceProfile:parseInterfaceProfile(row.interfaceProfile)};
}
/** @param {JsonValue} value @param {string} filename @returns {void} */
export function downloadCustomization(value,filename){
  const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)+'\n'],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=filename;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
