// @ts-check
import { parseInteractionScene } from './interaction-scene.js';
import {mediaObject,mediaId,mediaText,mediaInteger,parseMediaMetadata,checkMediaKind} from './chat-protocol.js';

/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('./chat-protocol.js').MediaMetadata} MediaMetadata */
/** @typedef {import('../../lib/server-governance.cjs').GovernanceState} GovernanceState */
/** @typedef {{accent:string,background:'charcoal'|'slate'|'midnight',density:'comfortable'|'compact',corners:'square'|'soft'}} Theme */
/** @typedef {{id:string,name:string,thumbnail:MediaMetadata|null,model:'bomb'|'poop'|'thumbnail',trajectory:'linear'|'arc',sound:'none'|'bomb-1'|'bomb-2'|'bomb-3'|'bomb-4'|'poop',durationMs:number,scene?:import('./interaction-scene.js').InteractionScene}} CustomInteraction */
/** @typedef {{domainId:string|null,theme:Theme|null,interactions:CustomInteraction[]}} CustomizationScope */

/** @param {JsonValue|undefined} value @returns {Theme} */
export function parseTheme(value) {
  const row=mediaObject(value,'Theme');
  if(typeof row.accent!=='string' || !/^#[a-fA-F0-9]{6}$/.test(row.accent))throw new TypeError('Theme accent must be a six-digit hexadecimal RGB color');
  if(row.background!=='charcoal' && row.background!=='slate' && row.background!=='midnight')throw new TypeError('Unsupported theme background');
  if(row.density!=='comfortable' && row.density!=='compact')throw new TypeError('Unsupported theme density');
  if(row.corners!=='square' && row.corners!=='soft')throw new TypeError('Unsupported theme corners');
  return {accent:row.accent,background:row.background,density:row.density,corners:row.corners};
}

/** @param {JsonValue|undefined} value @returns {CustomInteraction} */
export function parseCustomInteraction(value) {
  const row=mediaObject(value,'Custom interaction');
  const id=mediaId(row.id,'Interaction ID');
  if(id==='bomb' || id==='poop')throw new TypeError('Custom interaction ID cannot replace a stock interaction');
  if(row.model!=='bomb' && row.model!=='poop' && row.model!=='thumbnail')throw new TypeError('Unsupported custom interaction model');
  if(row.trajectory!=='linear' && row.trajectory!=='arc')throw new TypeError('Unsupported custom interaction trajectory');
  if(row.sound!=='none' && row.sound!=='bomb-1' && row.sound!=='bomb-2' && row.sound!=='bomb-3' && row.sound!=='bomb-4' && row.sound!=='poop')throw new TypeError('Unsupported custom interaction sound');
  if(row.thumbnail===undefined)throw new TypeError('Custom interaction thumbnail must be explicitly supplied');
  const thumbnail=row.thumbnail===null ? null : checkMediaKind(parseMediaMetadata(row.thumbnail),'server');
  if(thumbnail?.animated)throw new TypeError('Custom interaction thumbnail must be a static AVIF asset');
  const scene=row.scene===undefined ? null : parseInteractionScene(row.scene);
  if((scene ? scene.actors.some(actor=>actor.model==='thumbnail') : row.model==='thumbnail') && thumbnail===null)throw new TypeError('Thumbnail interaction model requires a validated media asset');
  return {id,name:mediaText(row.name,'Interaction name',24),thumbnail,model:row.model,trajectory:row.trajectory,sound:row.sound,durationMs:mediaInteger(row.durationMs,'Interaction duration',300,scene ? 4000 : 2000),...(scene ? {scene} : {})};
}

/** @param {JsonValue|undefined} value @returns {CustomizationScope[]} */
export function parseCustomization(value) {
  if(!Array.isArray(value) || value.length>13)throw new RangeError('Customization requires at most 13 scopes');
  /** @type {Set<string|null>} */
  const scopes=new Set();
  let total=0;
  return value.map(entry=>{
    const row=mediaObject(entry,'Customization scope');
    const domainId=row.domainId===null ? null : mediaId(row.domainId,'Customization domain');
    if(scopes.has(domainId))throw new TypeError('Customization contains a duplicate scope');
    scopes.add(domainId);
    if(!Array.isArray(row.interactions) || row.interactions.length>(domainId===null ? 96 : 24))throw new RangeError('Customization scope exceeds its interaction limit');
    total+=row.interactions.length;
    if(total>96)throw new RangeError('Customization permits at most 96 interactions across all scopes');
    const interactions=row.interactions.map(parseCustomInteraction);
    if(new Set(interactions.map(interaction=>interaction.id)).size!==interactions.length)throw new TypeError('Customization contains duplicate interaction IDs in a scope');
    return {domainId,theme:row.theme===null ? null : parseTheme(row.theme),interactions};
  });
}

/** @param {GovernanceState} policy @param {string|null} selfKey @param {string|null} domainId @returns {boolean} */
export function canManageCustomization(policy,selfKey,domainId) {
  if(!selfKey)return false;
  return selfKey===policy.ownerKey || domainId!==null && policy.domains.some(domain=>domain.id===domainId && domain.ownerKey===selfKey);
}

/** @param {GovernanceState} policy @param {string|null} domainId @returns {Theme|null} */
export function effectiveTheme(policy,domainId) {
  const scopes=policy.customization ?? [];
  const theme=scopes.find(scope=>scope.domainId===domainId)?.theme ?? scopes.find(scope=>scope.domainId===null)?.theme ?? null;
  return theme===null ? null : {...theme};
}

/** @param {GovernanceState} policy @param {string|null} domainId @returns {CustomInteraction[]} */
export function customInteractions(policy,domainId) {
  const scopes=policy.customization ?? [];
  const global=scopes.find(scope=>scope.domainId===null)?.interactions ?? [];
  const local=domainId===null ? [] : scopes.find(scope=>scope.domainId===domainId)?.interactions ?? [];
  return [...global.filter(entry=>!local.some(override=>override.id===entry.id)),...local].map(entry=>({...entry,thumbnail:entry.thumbnail===null ? null : {...entry.thumbnail},...(entry.scene ? {scene:{version:entry.scene.version,actors:entry.scene.actors.map(actor=>({model:actor.model,keyframes:actor.keyframes.map(frame=>({...frame}))}))}} : {})}));
}

/** @param {GovernanceState} policy @param {string|null} selfKey @returns {boolean} */
export function canManageServerCatalog(policy,selfKey) {
  return selfKey!==null && (selfKey===policy.ownerKey || policy.serverAdmins?.includes(selfKey)===true);
}
