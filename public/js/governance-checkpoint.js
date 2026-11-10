// @ts-check
import {objectValue} from './network-protocol.js';
import {mediaId,mediaInteger,parseServerEmoji} from './chat-protocol.js';
import {parseCustomization} from './customization-protocol.js';
/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../../lib/server-governance.cjs').GovernanceState} Policy */
/** @typedef {import('../../lib/server-governance.cjs').GovernanceJournal} Journal */
/** @typedef {import('../../lib/server-governance.cjs').GovernanceEvent} Event */
/** @typedef {{revision:number,digest:string,state:Policy,owners:Event[],signature:string}} Checkpoint */

/** @param {JsonValue|undefined} value @param {string} label @param {number} limit @returns {JsonValue[]} */
function rows(value,label,limit){if(!Array.isArray(value)||value.length>limit)throw new TypeError(label+' exceeds its entry limit');return value;}
/** @param {JsonValue|undefined} value @param {string} label @param {number} limit @returns {string} */
function text(value,label,limit){if(typeof value!=='string'||!value.length||value.length>limit||/[\u0000-\u001f\u007f]/.test(value))throw new TypeError(label+' requires bounded printable text');return value;}
/** @param {JsonValue|undefined} value @returns {string} */
function key(value){const result=text(value,'Member key',60);if(!/^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/.test(result))throw new TypeError('Checkpoint requires a canonical Ed25519 identity');return result;}
/** @param {JsonValue|undefined} value @returns {string} */
function digest(value){const result=text(value,'Digest',64);if(!/^[a-f0-9]{64}$/.test(result))throw new TypeError('Checkpoint digest must be SHA-256');return result;}
/** @param {string[]} values @returns {string[]} */
function unique(values){if(new Set(values).size!==values.length)throw new TypeError('Checkpoint contains duplicate identifiers');return values;}
/** @param {JsonValue|undefined} value @param {number} maximum @returns {string[]} */
function keys(value,maximum){return unique(rows(value,'Member keys',maximum).map(key));}
/** @param {JsonValue|undefined} value @returns {import('../../lib/server-governance.cjs').DomainPermission[]} */
function permissions(value){return rows(value,'Group permissions',3).map(item=>{if(item!=='manageChannels'&&item!=='manageMessages'&&item!=='moderateVoice')throw new TypeError('Unknown checkpoint permission');return item;});}

/** @param {JsonValue} input @returns {Policy} */
export function parseCheckpointPolicy(input){
  const row=objectValue(input);
  const domains=rows(row.domains,'Domains',12).map(value=>{
    const domain=objectValue(value),groups=rows(domain.groups,'Groups',64).map(value=>{
      const group=objectValue(value);
      return {id:mediaId(group.id,'Group ID'),name:text(group.name,'Group name',40),...(group.title===undefined?{}:{title:text(group.title,'Group title',24)}),permissions:permissions(group.permissions)};
    });
    unique(groups.map(group=>group.id));
    const members=rows(domain.members,'Members',256).map(value=>{
      const member=objectValue(value),groupIds=unique(rows(member.groupIds,'Member groups',64).map(id=>mediaId(id,'Group ID')));
      if(groupIds.some(id=>!groups.some(group=>group.id===id)))throw new TypeError('Checkpoint member references an absent group');
      return {memberKey:key(member.memberKey),groupIds};
    });
    unique(members.map(member=>member.memberKey));
    return {id:mediaId(domain.id,'Domain ID'),ownerKey:key(domain.ownerKey),admins:keys(domain.admins,256),groups,members};
  });
  unique(domains.map(domain=>domain.id));
  if(domains.reduce((count,domain)=>count+domain.groups.length,0)>64)throw new RangeError('Checkpoint exceeds 64 groups');
  const ownerKey=key(row.ownerKey),serverAdmins=row.serverAdmins===undefined?undefined:keys(row.serverAdmins,64);
  if(new Set([ownerKey,...(serverAdmins??[]),...domains.flatMap(domain=>[domain.ownerKey,...domain.admins,...domain.members.map(member=>member.memberKey)])]).size>256)throw new RangeError('Checkpoint exceeds 256 member identities');
  if(row.interactionCatalogVersion!==undefined&&row.interactionCatalogVersion!==1&&row.interactionCatalogVersion!==2)throw new TypeError('Invalid checkpoint catalog version');
  return {ownerKey,name:text(row.name,'Server name',80),domains,...(serverAdmins===undefined?{}:{serverAdmins}),...(row.emojis===undefined?{}:{emojis:rows(row.emojis,'Server emojis',256).map(parseServerEmoji)}),...(row.customization===undefined?{}:{customization:parseCustomization(row.customization)}),...(row.interactionCatalogVersion===undefined?{}:{interactionCatalogVersion:row.interactionCatalogVersion})};
}

/** @param {JsonValue} input @returns {Checkpoint} */
export function parseGovernanceCheckpoint(input){
  const row=objectValue(input),revision=mediaInteger(row.revision,'Checkpoint revision',1,Number.MAX_SAFE_INTEGER);
  const owners=rows(row.owners,'Owner succession proofs',1024).map(value=>{
    const event=objectValue(value),command=objectValue(event.command??null);
    if(command.type!=='transferOwner')throw new TypeError('Owner succession must contain signed owner transfers only');
    return {revision:mediaInteger(event.revision,'Owner transfer revision',1,revision),previousDigest:digest(event.previousDigest),actorKey:key(event.actorKey),command:{type:/** @type {const} */('transferOwner'),memberKey:key(command.memberKey)},signature:text(event.signature,'Owner signature',88)};
  });
  if(row.state===undefined)throw new TypeError('Checkpoint requires a signed policy');
  return {revision,digest:digest(row.digest),state:parseCheckpointPolicy(row.state),owners,signature:text(row.signature,'Checkpoint signature',88)};
}

/** @param {Journal} journal @returns {number} */
export function governanceRevision(journal){return (journal.checkpoint?.revision??0)+journal.events.length;}
/** @param {Journal} journal @returns {Event[]} */
export function ownerProofs(journal){return [...(journal.checkpoint?.owners??[]),...journal.events.filter(event=>event.command.type==='transferOwner')];}
/** @param {{roomId:string,creatorKey:string}} descriptor @param {Omit<Checkpoint,'signature'>} checkpoint @returns {string} */
export function checkpointPayload(descriptor,checkpoint){return JSON.stringify(['deepscord-governance-checkpoint-v1',descriptor.roomId,descriptor.creatorKey,checkpoint.revision,checkpoint.digest,checkpoint.state,checkpoint.owners]);}
/** @param {{roomId:string,creatorKey:string}} descriptor @param {Event} event @returns {string} */
export function ownerProofPayload(descriptor,event){return JSON.stringify(['deepscord-governance-v1',1,descriptor.roomId,descriptor.creatorKey,event.revision,event.previousDigest,event.actorKey,event.command]);}
/** @param {Journal} journal @returns {boolean} */
export function needsGovernanceCheckpoint(journal){return journal.events.length>=256 || journal.events.length>0 && new TextEncoder().encode(JSON.stringify(journal)).length>=1024*1024;}
/** @param {Journal} previous @param {Journal} next @returns {boolean} */
export function extendsVerifiedGovernance(previous,next){
  if(previous.roomId!==next.roomId||previous.creatorKey!==next.creatorKey||previous.version!==next.version||governanceRevision(next)<governanceRevision(previous))return false;
  if(previous.digest===next.digest)return true;
  const boundary=next.checkpoint?.revision??0,revision=governanceRevision(previous);
  if(revision>=boundary)return next.events[revision-boundary]?.previousDigest===previous.digest;
  // A current owner can attest a newer policy, but cannot replace a pinned succession branch.
  const owners=ownerProofs(previous),candidate=ownerProofs(next).filter(event=>event.revision<=revision);
  return JSON.stringify(owners)===JSON.stringify(candidate);
}
