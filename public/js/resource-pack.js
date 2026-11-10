// @ts-check
import {mediaObject,mediaText,mediaInteger} from './chat-protocol.js';
/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {'interfaces'|'interactions'|'stickers'} PackKind */
/** @typedef {{format:1,id:string,name:string,version:string,kind:PackKind,entries:{file:string,name:string}[]}} ResourcePackManifest */
/** @typedef {{id:string,name:string,version:string,kind:PackKind,entryCount:number,bytes:number,serverIds:string[],active:boolean,source:'package'|'legacy',pendingRemoval:boolean}} PackSummary */
/** @param {JsonValue|undefined} value @returns {string} */
export function resourcePackId(value){const id=mediaText(value,'Resource pack ID',64);if(!/^[a-z][a-z0-9-]*$/.test(id))throw new TypeError('Resource pack ID requires lowercase letters, digits and hyphens');return id;}
/** @param {JsonValue|undefined} value @returns {string} */
export function resourceRelativePath(value){
  const text=mediaText(value,'Resource relative path',512),parts=text.split('/');
  if(parts.some(part=>!part||part==='.'||part==='..'||part.trim()!==part||part.endsWith('.')||/[\\<>:"|?*\u0000-\u001f]/.test(part)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))throw new TypeError('Resource path must be a safe relative path: '+text);
  return text;
}
/** @param {JsonValue|undefined} value @returns {PackKind} */
function kind(value){if(value!=='interfaces'&&value!=='interactions'&&value!=='stickers')throw new TypeError('Resource pack kind must be interfaces, interactions or stickers');return value;}
/** @param {JsonValue|undefined} value @returns {string} */
export function resourceServerId(value){const id=mediaText(value,'Resource server ID',36);if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))throw new TypeError('Resource server ID must be a canonical UUID');return id;}
/** @param {JsonValue|undefined} value @returns {ResourcePackManifest} */
export function parseResourcePackManifest(value){
  const row=mediaObject(value,'Resource pack manifest'),type=kind(row.kind),maximum=type==='interfaces'?64:type==='interactions'?96:300;
  if(row.format!==1||!Array.isArray(row.entries)||row.entries.length<1||row.entries.length>maximum)throw new RangeError('Resource pack requires format 1 and 1..'+maximum+' entries');
  const entries=row.entries.map(value=>{const entry=mediaObject(value,'Resource pack entry');return {file:resourceRelativePath(entry.file),name:mediaText(entry.name,'Resource entry name',80)};});
  if(new Set(entries.map(entry=>entry.file.toLowerCase())).size!==entries.length)throw new TypeError('Resource pack contains duplicate entry paths');
  return {format:1,id:resourcePackId(row.id),name:mediaText(row.name,'Resource pack name',80),version:mediaText(row.version,'Resource pack version',64),kind:type,entries};
}
/** @param {JsonValue|undefined} value @returns {PackSummary} */
export function parseResourcePackSummary(value){
  const row=mediaObject(value,'Resource pack summary');
  if(row.source!=='package'&&row.source!=='legacy'||typeof row.active!=='boolean'||typeof row.pendingRemoval!=='boolean'||!Array.isArray(row.serverIds))throw new TypeError('Invalid resource pack summary state');
  return {id:resourcePackId(row.id),name:mediaText(row.name,'Resource pack name',80),version:mediaText(row.version,'Resource pack version',64),kind:kind(row.kind),entryCount:mediaInteger(row.entryCount,'Pack entries',0,300),bytes:mediaInteger(row.bytes,'Pack bytes',0,64*1024*1024),serverIds:[...new Set(row.serverIds.map(resourceServerId))],active:row.active,source:row.source,pendingRemoval:row.pendingRemoval};
}
