// @ts-check
'use strict';

const {initialInteractionCatalog}=require('../public/js/interaction-defaults.js');
const { createHash, createPublicKey, verify } = require('node:crypto');
const {parseMediaMetadata,checkMediaKind,mediaInteger}=require('../public/js/chat-protocol.js');
const {memberRole,roleRank,canManageMember}=require('../public/js/member-permissions.js');
const {parseTheme,parseCustomInteraction,parseCustomization,canManageCustomization,canManageServerCatalog}=require('../public/js/customization-protocol.js');
const {parseGovernanceCheckpoint,parseCheckpointPolicy,governanceRevision,ownerProofs,checkpointPayload,ownerProofPayload,extendsVerifiedGovernance}=require('../public/js/governance-checkpoint.js');

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('./room-replica.cjs').RoomDescriptor} RoomDescriptor */
/** @typedef {import('./steam-state.cjs').RoomServer} RoomServer */
/** @typedef {'manageChannels'|'manageMessages'|'moderateVoice'} DomainPermission */
/** @typedef {{type:'initializeInteractionCatalog'}|{type:'migrateServerCatalog'}|{type:'setTheme',domainId:string|null,theme:import('../public/js/customization-protocol.js').Theme|null}|{type:'putInteraction',domainId:string|null,interaction:import('../public/js/customization-protocol.js').CustomInteraction}|{type:'deleteInteraction',domainId:string|null,interactionId:string}} CustomizationCommand */
/** @typedef {{type:'setMemberAccess',domainId:string|null,memberKey:string,role:'server-admin'|'domain-owner'|'domain-admin'|'member',groupIds:string[]}} MemberAccessCommand */
/** @typedef {{type:'setServerAdmin',memberKey:string,enabled:boolean}|{type:'renameServer',name:string}|{type:'transferOwner',memberKey:string}|{type:'deleteDomain',domainId:string}|{type:'setDomainOwner',domainId:string,memberKey:string}|{type:'setDomainAdmin',domainId:string,memberKey:string,enabled:boolean}|{type:'putGroup',domainId:string,groupId:string,name:string,title?:string,permissions:DomainPermission[]}|{type:'deleteGroup',domainId:string,groupId:string}|{type:'setMemberGroups',domainId:string,memberKey:string,groupIds:string[]}|{type:'putEmoji',domainId:string|null,emojiId:string,name:string,asset:import('../public/js/chat-protocol.js').MediaMetadata,ts:number}|{type:'deleteEmoji',domainId:string|null,emojiId:string}|CustomizationCommand|MemberAccessCommand} GovernanceCommand */
/** @typedef {{revision:number,previousDigest:string,actorKey:string,command:GovernanceCommand,signature:string}} GovernanceEvent */
/** @typedef {{version:1,roomId:string,creatorKey:string,events:GovernanceEvent[],digest:string,checkpoint?:import('../public/js/governance-checkpoint.js').Checkpoint}} GovernanceJournal */
/** @typedef {{id:string,name:string,title?:string,permissions:DomainPermission[]}} GovernanceGroup */
/** @typedef {{id:string,ownerKey:string,admins:string[],groups:GovernanceGroup[],members:{memberKey:string,groupIds:string[]}[]}} GovernanceDomain */
/** @typedef {{ownerKey:string,name:string,serverAdmins?:string[],domains:GovernanceDomain[],emojis?:import('../public/js/chat-protocol.js').ServerEmoji[],customization?:import('../public/js/customization-protocol.js').CustomizationScope[],interactionCatalogVersion?:1|2}} GovernanceState */
/** @typedef {'server-owner'|'server-admin'|'domain-owner'|'domain-admin'|'special'|'member'} DomainRole */
/** @typedef {{journal:GovernanceJournal,state:GovernanceState}} Replay */
/** @typedef {{journal:GovernanceJournal,policy:GovernanceState}} GovernanceSnapshot */
/** @typedef {{snapshot:Replay,bytes:number}} VerificationEntry */
/** @typedef {{entries:number,bytes:number,hits:number,misses:number}} VerificationStats */

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 2048;
/** @type {readonly DomainPermission[]} */
const PERMISSIONS = ['manageChannels', 'manageMessages', 'moderateVoice'];

/** @param {JsonValue|undefined} value @param {string} field @returns {{[key:string]:JsonValue}} */
function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(field + ' must be a JSON object');
  return value;
}

/** @param {JsonValue|undefined} value @param {string} field @param {number} maximum @returns {JsonValue[]} */
function array(value, field, maximum) {
  if (!Array.isArray(value)) throw new TypeError(field + ' must be an array');
  if (value.length > maximum) throw new RangeError(field + ' exceeds its ' + maximum + '-entry limit');
  return value;
}

/** @param {JsonValue|undefined} value @param {string} field @param {number} maximum @returns {string} */
function text(value, field, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(field + ' must contain 1-' + maximum + ' characters without control characters');
  return value;
}

/** @param {JsonValue|undefined} value @param {string} field @returns {string} */
function identifier(value, field) {
  const result = text(value, field, 80);
  if (!/^[A-Za-z0-9_-]+$/.test(result) || ['__proto__', 'prototype', 'constructor'].includes(result)) throw new TypeError(field + ' must be a safe nonreserved ASCII identifier');
  return result;
}

/** @param {JsonValue|undefined} value @param {string} field @param {number} bytes @returns {Buffer} */
function base64(value, field, bytes) {
  if (typeof value !== 'string' || value.length !== Math.ceil(bytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new TypeError(field + ' must be canonical base64');
  const data = Buffer.from(value, 'base64');
  if (data.length !== bytes || data.toString('base64') !== value) throw new TypeError(field + ' has invalid size or base64 encoding');
  return data;
}

/** @param {JsonValue|undefined} value @returns {string} */
function memberKey(value) {
  const data = base64(value, 'Governance member key', 44);
  const key = createPublicKey({ key:data, format:'der', type:'spki' });
  if (key.asymmetricKeyType !== 'ed25519' || !key.export({ format:'der', type:'spki' }).equals(data)) throw new TypeError('Governance member key must be a canonical Ed25519 SPKI public key');
  return data.toString('base64');
}

/** @param {JsonValue} value @returns {RoomDescriptor} */
function descriptor(value) {
  const row = object(value, 'Governance descriptor');
  if (row.version !== 1) throw new TypeError('Governance descriptor version must be 1');
  if (typeof row.roomId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.roomId)) throw new TypeError('Governance room ID must be a canonical lowercase UUID');
  return { version:1, roomId:row.roomId, creatorKey:memberKey(row.creatorKey) };
}

/** @param {JsonValue|undefined} value @param {string} field @returns {string} */
function digest(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(field + ' must be 64 lowercase hexadecimal characters');
  return value;
}

/** @param {JsonValue} value @returns {void} */
function bound(value) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BYTES) throw new RangeError('Governance journal exceeds its 2 MiB JSON limit');
}

/** @param {string[]} values @param {string} field @returns {string[]} */
function uniqueSorted(values, field) {
  if (new Set(values).size !== values.length) throw new TypeError(field + ' contains duplicate entries');
  return [...values].sort();
}

/** @param {JsonValue} value @returns {GovernanceCommand} */
function parseGovernanceCommand(value) {
  bound(value);
  const row = object(value, 'Governance command');
  switch (row.type) {
    case 'setMemberAccess': {
      if(row.role!=='server-admin' && row.role!=='domain-owner' && row.role!=='domain-admin' && row.role!=='member')throw new TypeError('Invalid member role');
      const domainId=row.domainId===null?null:identifier(row.domainId,'Domain ID');
      const groupIds=uniqueSorted(array(row.groupIds,'Member groups',64).map(value=>identifier(value,'Group ID')),'Member groups');
      if(domainId===null && (groupIds.length || row.role==='domain-owner' || row.role==='domain-admin'))throw new TypeError('Domain roles and groups require a domain');
      return {type:row.type,domainId,memberKey:memberKey(row.memberKey),role:row.role,groupIds};
    }
    case 'setTheme': return {type:row.type,domainId:row.domainId===null ? null : identifier(row.domainId,'Customization domain'),theme:row.theme===null ? null : parseTheme(row.theme)};
    case 'initializeInteractionCatalog':
    case 'migrateServerCatalog': return {type:row.type};
    case 'putInteraction': return {type:row.type,domainId:row.domainId===null ? null : identifier(row.domainId,'Customization domain'),interaction:parseCustomInteraction(row.interaction)};
    case 'deleteInteraction': return {type:row.type,domainId:row.domainId===null ? null : identifier(row.domainId,'Customization domain'),interactionId:identifier(row.interactionId,'Interaction ID')};
    case 'putEmoji': {
      if(row.asset===undefined)throw new TypeError('Server emoji requires a validated asset');
      return{type:row.type,domainId:row.domainId===null ? null : identifier(row.domainId,'Domain ID'),emojiId:identifier(row.emojiId,'Emoji ID'),name:text(row.name,'Emoji name',40),asset:checkMediaKind(parseMediaMetadata(row.asset),'server'),ts:mediaInteger(row.ts,'Emoji creation time',0,Number.MAX_SAFE_INTEGER)};
    }
    case 'deleteEmoji': return{type:row.type,domainId:row.domainId===null ? null : identifier(row.domainId,'Domain ID'),emojiId:identifier(row.emojiId,'Emoji ID')};
    case 'renameServer': return { type:row.type, name:text(row.name, 'Server name', 80) };
    case 'transferOwner': return { type:row.type, memberKey:memberKey(row.memberKey) };
    case 'deleteDomain': return { type:row.type, domainId:identifier(row.domainId, 'Domain ID') };
    case 'setDomainOwner': return { type:row.type, domainId:identifier(row.domainId, 'Domain ID'), memberKey:memberKey(row.memberKey) };
    case 'setServerAdmin': {
      if(typeof row.enabled!=='boolean')throw new TypeError('Server administrator enabled must be boolean');
      return {type:row.type,memberKey:memberKey(row.memberKey),enabled:row.enabled};
    }
    case 'setDomainAdmin': {
      if (typeof row.enabled !== 'boolean') throw new TypeError('Domain administrator enabled must explicitly be boolean');
      return { type:row.type, domainId:identifier(row.domainId, 'Domain ID'), memberKey:memberKey(row.memberKey), enabled:row.enabled };
    }
    case 'putGroup': {
      const permissions = uniqueSorted(array(row.permissions, 'Group permissions', 3).map(value => {
        if (value !== 'manageChannels' && value !== 'manageMessages' && value !== 'moderateVoice') throw new TypeError('Group permission must be manageChannels, manageMessages or moderateVoice');
        return value;
      }), 'Group permissions');
      return { type:row.type, domainId:identifier(row.domainId, 'Domain ID'), groupId:identifier(row.groupId, 'Group ID'), name:text(row.name, 'Group name', 40), ...(row.title===undefined ? {} : {title:text(row.title,'Group title',24)}), permissions:/** @type {DomainPermission[]} */ (permissions) };
    }
    case 'deleteGroup': return { type:row.type, domainId:identifier(row.domainId, 'Domain ID'), groupId:identifier(row.groupId, 'Group ID') };
    case 'setMemberGroups': return { type:row.type, domainId:identifier(row.domainId, 'Domain ID'), memberKey:memberKey(row.memberKey), groupIds:uniqueSorted(array(row.groupIds, 'Member groups', 64).map(value=>identifier(value, 'Group ID')), 'Member groups') };
    default: throw new TypeError('Unsupported governance command type: ' + String(row.type));
  }
}

/** @param {JsonValue} value @returns {string} */
function hash(value) { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'); }

/** @param {RoomDescriptor} anchorInput @returns {GovernanceJournal} */
function createGovernance(anchorInput) {
  const anchor = descriptor(anchorInput);
  return { ...anchor, events:[], digest:hash(['deepscord-governance-genesis-v1', anchor.roomId, anchor.creatorKey]) };
}

/** @param {GovernanceJournal} journal @param {string} actorKey @param {GovernanceCommand} command @returns {string} */
function payload(journal, actorKey, command) {
  return JSON.stringify(['deepscord-governance-v1', 1, journal.roomId, journal.creatorKey, governanceRevision(journal) + 1, journal.digest, actorKey, command]);
}

/** @param {GovernanceState} state @param {string} domainId @returns {GovernanceDomain} */
function domain(state, domainId) {
  return state.domains.find(entry=>entry.id === domainId) ?? { id:domainId, ownerKey:state.ownerKey, admins:[], groups:[], members:[] };
}

/** @param {GovernanceState} state @param {GovernanceDomain} next @returns {GovernanceState} */
function replaceDomain(state, next) {
  const domains = [...state.domains.filter(entry=>entry.id !== next.id), next].sort((a,b)=>a.id.localeCompare(b.id, 'en'));
  if (domains.length > 12) throw new RangeError('Governance exceeds its 12-domain policy limit');
  if (domains.reduce((count, entry)=>count + entry.groups.length, 0) > 64) throw new RangeError('Governance exceeds its 64-group server limit');
  const keys = new Set([state.ownerKey, ...(state.serverAdmins ?? []), ...domains.flatMap(entry=>[entry.ownerKey, ...entry.admins, ...entry.members.map(member=>member.memberKey)])]);
  if (keys.size > 256) throw new RangeError('Governance exceeds its 256-member server limit');
  return { ...state, domains };
}

/** Flatten signed legacy scopes without rewriting historical events. @param {GovernanceState} state @returns {GovernanceState} */
function migrateServerCatalog(state) {
  const scopes=state.customization ?? [];
  const current=scopes.find(scope=>scope.domainId===null);
  const ordered=[...(current ? [current] : []),...scopes.filter(scope=>scope.domainId!==null).sort((a,b)=>String(a.domainId).localeCompare(String(b.domainId),'en'))];
  const reserved=new Set(ordered.flatMap(scope=>scope.interactions.map(entry=>entry.id)));
  /** @type {Set<string>} */ const used=new Set();
  const interactions=ordered.flatMap(scope=>scope.interactions.map(entry=>{
    if(!used.has(entry.id)){used.add(entry.id);return {...entry};}
    let index=1;
    let id=entry.id.slice(0,60)+'-migrated-'+index;
    while(reserved.has(id) || used.has(id)){index+=1;id=entry.id.slice(0,60)+'-migrated-'+index;}
    used.add(id);
    return {...entry,id};
  }));
  const additions=state.interactionCatalogVersion===undefined ? initialInteractionCatalog().filter(entry=>!used.has(entry.id)).slice(0,96-interactions.length) : [];
  const customization=parseCustomization([{domainId:null,theme:current?.theme ?? null,interactions:[...interactions,...additions]},...scopes.filter(scope=>scope.domainId!==null && scope.theme!==null).map(scope=>({...scope,interactions:[]}))]);
  return {...state,interactionCatalogVersion:2,customization,...(state.emojis ? {emojis:state.emojis.map(entry=>({...entry,domainId:null}))} : {})};
}

/** @param {GovernanceJournal} journal @param {GovernanceState} state @param {string} actorKey @param {GovernanceCommand} command @returns {GovernanceState} */
function apply(journal, state, actorKey, command) {
  const serverOwner = actorKey === state.ownerKey;
  const serverAdmin = state.serverAdmins?.includes(actorKey) === true;
  if(command.type==='setMemberAccess') {
    if(!canManageMember(state,actorKey,command.memberKey,command.domainId))throw new TypeError('不能管理自己、同级或更高权限成员');
    if(command.role==='server-admin' && !serverOwner)throw new TypeError('只有服主可以任命服务器管理员');
    if(command.role==='domain-owner' && !serverOwner && !serverAdmin)throw new TypeError('只有服主或服务器管理员可以任命域主');
    const admins=[...(state.serverAdmins ?? []).filter(key=>key!==command.memberKey),...(command.role==='server-admin'?[command.memberKey]:[])].sort();
    if(admins.length>64)throw new RangeError('Server administrator limit is 64');
    const next={...state,...(state.serverAdmins!==undefined || admins.length ? {serverAdmins:admins} : {})};
    if(command.domainId===null){
      const keys=new Set([next.ownerKey,...admins,...next.domains.flatMap(entry=>[entry.ownerKey,...entry.admins,...entry.members.map(member=>member.memberKey)])]);
      if(keys.size>256)throw new RangeError('Governance exceeds its 256-member server limit');
      return next;
    }
    const current=domain(state,command.domainId);
    if(command.groupIds.some(id=>!current.groups.some(group=>group.id===id)))throw new TypeError('Member group assignment references an absent group in domain '+command.domainId);
    return replaceDomain(next,{...current,
      ownerKey:command.role==='domain-owner'?command.memberKey:current.ownerKey===command.memberKey?state.ownerKey:current.ownerKey,
      admins:[...current.admins.filter(key=>key!==command.memberKey),...(command.role==='domain-admin'?[command.memberKey]:[])].sort(),
      members:[...current.members.filter(member=>member.memberKey!==command.memberKey),...(command.groupIds.length?[{memberKey:command.memberKey,groupIds:[...command.groupIds]}]:[])].sort((a,b)=>a.memberKey.localeCompare(b.memberKey,'en')),
    });
  }
  if(command.type==='setServerAdmin') {
    if(!serverOwner || command.memberKey===state.ownerKey)throw new TypeError('Only the server owner can appoint or remove a different server administrator');
    const admins=[...(state.serverAdmins ?? []).filter(key=>key!==command.memberKey),...(command.enabled?[command.memberKey]:[])].sort();
    if(admins.length>64)throw new RangeError('Server administrator limit is 64');
    const keys=new Set([state.ownerKey,...admins,...state.domains.flatMap(entry=>[entry.ownerKey,...entry.admins,...entry.members.map(member=>member.memberKey)])]);
    if(keys.size>256)throw new RangeError('Governance exceeds its 256-member server limit');
    return {...state,serverAdmins:admins};
  }
  if(command.type==='migrateServerCatalog') {
    if(!canManageServerCatalog(state,actorKey))throw new TypeError('Server catalog migration requires the server owner or a server administrator');
    if(state.interactionCatalogVersion===2)throw new TypeError('Server catalog has already been migrated');
    return migrateServerCatalog(state);
  }
  if(command.type==='initializeInteractionCatalog') {
    if(!serverOwner)throw new TypeError('Interaction catalog initialization requires the current server owner');
    if(state.interactionCatalogVersion!==undefined)throw new TypeError('Interaction catalog has already been initialized');
    const scopes=state.customization ?? [];
    const current=scopes.find(scope=>scope.domainId===null) ?? {domainId:null,theme:null,interactions:[]};
    const additions=initialInteractionCatalog().filter(entry=>!current.interactions.some(existing=>existing.id===entry.id));
    if(current.interactions.length+additions.length>24)throw new RangeError('Legacy catalog initialization permits at most 24 interactions per scope');
    const next=[...scopes.filter(scope=>scope.domainId!==null),{...current,interactions:[...current.interactions,...additions]}];
    return {...state,interactionCatalogVersion:1,customization:parseCustomization(next)};
  }
  if(command.type==='setTheme' || command.type==='putInteraction' || command.type==='deleteInteraction') {
    if(command.type!=='setTheme' && state.interactionCatalogVersion===2)assertCatalogCommand(state,actorKey,command);
    else if(!canManageCustomization(state,actorKey,command.domainId))throw new TypeError('Customization requires the current server owner or the owner of the selected domain');
    const scopes=state.customization ?? [];
    const current=scopes.find(scope=>scope.domainId===command.domainId) ?? {domainId:command.domainId,theme:null,interactions:[]};
    if(command.type==='deleteInteraction' && !current.interactions.some(entry=>entry.id===command.interactionId))throw new TypeError('Interaction is absent from the selected customization scope');
    const theme=command.type==='setTheme' ? command.theme : current.theme;
    const interactions=command.type==='putInteraction' ? [...current.interactions.filter(entry=>entry.id!==command.interaction.id),command.interaction] : command.type==='deleteInteraction' ? current.interactions.filter(entry=>entry.id!==command.interactionId) : current.interactions;
    const next=[...scopes.filter(scope=>scope.domainId!==command.domainId),...(theme===null && interactions.length===0 ? [] : [{domainId:command.domainId,theme,interactions}])];
    return {...state,customization:parseCustomization(next)};
  }
  if (command.type === 'renameServer' || command.type === 'transferOwner' || command.type === 'setDomainOwner' || command.type === 'deleteDomain') {
    if (!serverOwner && !(serverAdmin && (command.type==='setDomainOwner' || command.type==='deleteDomain' || command.type==='renameServer'))) throw new TypeError('Governance command ' + command.type + ' requires the current server owner');
    if (command.type === 'renameServer') return { ...state, name:command.name };
    if (command.type === 'deleteDomain') return { ...state, domains:state.domains.filter(entry=>entry.id !== command.domainId),...(state.emojis ? {emojis:state.emojis.filter(entry=>entry.domainId!==command.domainId)} : {}),...(state.customization ? {customization:state.customization.filter(entry=>entry.domainId!==command.domainId)} : {}) };
    if (command.type === 'transferOwner') {
      const explicitOwners = new Map(journal.events.reduce(/** @param {[string,string][]} entries */ (entries,event)=>{
        const previous = event.command;
        if (previous.type === 'deleteDomain') return entries.filter(([id])=>id !== previous.domainId);
        if(previous.type==='setDomainOwner')return [...entries.filter(([id])=>id!==previous.domainId),[previous.domainId,previous.memberKey]];
        if(previous.type==='setMemberAccess' && previous.domainId!==null && previous.role==='domain-owner')return [...entries.filter(([id])=>id!==previous.domainId),[previous.domainId,previous.memberKey]];
        if(previous.type==='setMemberAccess')return entries.filter(([id,key])=>id!==previous.domainId || key!==previous.memberKey);
        return entries;
      }, []));
      const next = { ...state, ownerKey:command.memberKey, domains:state.domains.map(entry=>explicitOwners.has(entry.id) ? entry : { ...entry, ownerKey:command.memberKey }) };
      const keys = new Set([next.ownerKey, ...(next.serverAdmins ?? []), ...next.domains.flatMap(entry=>[entry.ownerKey, ...entry.admins, ...entry.members.map(member=>member.memberKey)])]);
      if (keys.size > 256) throw new RangeError('Governance exceeds its 256-member server limit');
      return next;
    }
    return replaceDomain(state, { ...domain(state, command.domainId), ownerKey:command.memberKey });
  }
  if(command.type==='putEmoji' || command.type==='deleteEmoji') {
    if(command.domainId===null || state.interactionCatalogVersion===2)assertCatalogCommand(state,actorKey,command);
    else if(!serverOwner && !serverAdmin && actorKey!==domain(state,command.domainId).ownerKey)throw new TypeError('Server emoji requires the server owner or domain owner');
    if(command.type==='putEmoji'){
      const emojis=state.emojis ?? [],existing=emojis.find(entry=>entry.id===command.emojiId);
      if(existing && existing.domainId!==command.domainId)throw new TypeError('An emoji cannot be moved across domains');
      if(!existing && emojis.length>=256)throw new RangeError('Server emoji limit is 256');
      return {...state,emojis:[...emojis.filter(entry=>entry.id!==command.emojiId),{id:command.emojiId,domainId:command.domainId,name:command.name,asset:command.asset,ts:command.ts,addedBy:actorKey}]};
    }
    const emojis=state.emojis ?? [];
    if(!emojis.some(entry=>entry.id===command.emojiId && entry.domainId===command.domainId))throw new TypeError('Emoji is absent from the selected catalog');
    return {...state,emojis:emojis.filter(entry=>entry.id!==command.emojiId)};
  }
  const current = domain(state, command.domainId);
  if (!serverOwner && !serverAdmin && actorKey !== current.ownerKey) throw new TypeError('Governance command ' + command.type + ' requires the server owner or the owner of domain ' + command.domainId);
  switch (command.type) {
    case 'setDomainAdmin': return replaceDomain(state, { ...current, admins:[...current.admins.filter(key=>key !== command.memberKey), ...(command.enabled ? [command.memberKey] : [])].sort() });
    case 'putGroup': return replaceDomain(state, { ...current, groups:[...current.groups.filter(group=>group.id !== command.groupId), { id:command.groupId, name:command.name, ...(command.title===undefined ? {} : {title:command.title}), permissions:[...command.permissions] }].sort((a,b)=>a.id.localeCompare(b.id, 'en')) });
    case 'deleteGroup': {
      if (!current.groups.some(group=>group.id === command.groupId)) throw new TypeError('Cannot delete absent group ' + command.groupId + ' from domain ' + command.domainId);
      return replaceDomain(state, { ...current, groups:current.groups.filter(group=>group.id !== command.groupId), members:current.members.map(member=>({ ...member, groupIds:member.groupIds.filter(id=>id !== command.groupId) })).filter(member=>member.groupIds.length > 0) });
    }
    case 'setMemberGroups': {
      if (command.groupIds.some(id=>!current.groups.some(group=>group.id === id))) throw new TypeError('Member group assignment references an absent group in domain ' + command.domainId);
      return replaceDomain(state, { ...current, members:[...current.members.filter(member=>member.memberKey !== command.memberKey), ...(command.groupIds.length ? [{ memberKey:command.memberKey, groupIds:[...command.groupIds] }] : [])].sort((a,b)=>a.memberKey.localeCompare(b.memberKey, 'en')) });
    }
  }
}

/** @param {GovernanceJournal} journal @param {GovernanceState} state @param {JsonValue} value @returns {Replay} */
function replayEvent(journal, state, value) {
  const row = object(value, 'Governance event');
  if (row.revision !== governanceRevision(journal) + 1) throw new TypeError('Governance event revision must be exactly ' + (governanceRevision(journal) + 1));
  if (digest(row.previousDigest, 'Previous governance digest') !== journal.digest) throw new TypeError('Governance event previousDigest does not match the current journal');
  const actorKey = memberKey(row.actorKey);
  if (row.command === undefined) throw new TypeError('Governance event requires a command');
  const command = parseGovernanceCommand(row.command);
  const signature = base64(row.signature, 'Governance signature', 64);
  if (!verify(null, Buffer.from(payload(journal, actorKey, command), 'utf8'), { key:Buffer.from(actorKey, 'base64'), format:'der', type:'spki' }, signature)) throw new TypeError('Governance event Ed25519 signature is invalid at revision ' + row.revision);
  const next = apply(journal, state, actorKey, command);
  /** @type {GovernanceEvent} */
  const event = { revision:row.revision, previousDigest:journal.digest, actorKey, command, signature:signature.toString('base64') };
  return { journal:{ ...journal, events:[...journal.events, event], digest:hash(['deepscord-governance-event-v1', journal.roomId, journal.creatorKey, event]) }, state:next };
}

/** @param {JsonValue} value @param {RoomDescriptor} expectedInput @returns {Replay} */
function replay(value, expectedInput) {
  bound(value);
  const row = object(value, 'Governance journal');
  const anchor = descriptor(row);
  const expected = descriptor(expectedInput);
  if (anchor.roomId !== expected.roomId || anchor.creatorKey !== expected.creatorKey) throw new TypeError('Governance journal differs from the pinned room identity');
  const initial = createGovernance(expected);
  /** @type {Replay} */
  const start = row.checkpoint===undefined ? { journal:initial, state:{ ownerKey:initial.creatorKey, name:'Deepscord', domains:[] } } : checkpointStart(initial,row.checkpoint);
  const result = array(row.events, 'Governance events', MAX_EVENTS).reduce(/** @param {Replay} current */ (current, event)=>replayEvent(current.journal, current.state, event), start);
  if (digest(row.digest, 'Governance digest') !== result.journal.digest) throw new TypeError('Governance journal digest does not match its signed event chain');
  return result;
}

/** @param {JsonValue} value @param {RoomDescriptor} descriptor @returns {GovernanceJournal} */
function parseGovernance(value, descriptor) { return replay(value, descriptor).journal; }

/** @param {GovernanceJournal} initial @param {JsonValue} value @returns {Replay} */
function checkpointStart(initial,value) {
  const checkpoint=parseGovernanceCheckpoint(value);
  let owner=initial.creatorKey,revision=0;
  for(const event of checkpoint.owners){
    if(event.actorKey!==owner || event.revision<=revision || event.command.type!=='transferOwner')throw new TypeError('Checkpoint owner succession is not rooted in the room creator');
    const signature=base64(event.signature,'Owner transfer signature',64);
    if(!verify(null,Buffer.from(ownerProofPayload(initial,event)),{key:Buffer.from(owner,'base64'),format:'der',type:'spki'},signature))throw new TypeError('Checkpoint owner transfer signature is invalid');
    owner=memberKey(event.command.memberKey);revision=event.revision;
  }
  if(checkpoint.state.ownerKey!==owner)throw new TypeError('Checkpoint policy owner differs from its signed succession');
  if(!verify(null,Buffer.from(checkpointPayload(initial,checkpoint)),{key:Buffer.from(owner,'base64'),format:'der',type:'spki'},base64(checkpoint.signature,'Checkpoint signature',64)))throw new TypeError('Checkpoint must be signed by its current server owner');
  return {journal:{...initial,checkpoint,digest:checkpoint.digest},state:checkpoint.state};
}

/** @param {GovernanceJournal} journal @returns {Omit<import('../public/js/governance-checkpoint.js').Checkpoint,'signature'>} */
function checkpointDraft(journal){const current=replay(journal,journal);return {revision:governanceRevision(current.journal),digest:current.journal.digest,state:parseCheckpointPolicy(current.state),owners:ownerProofs(current.journal)};}
/** @param {GovernanceJournal} journal @returns {string} */
function governanceCheckpointPayload(journal){return checkpointPayload(journal,checkpointDraft(journal));}
/** @param {GovernanceJournal} journal @param {string} signature @returns {GovernanceJournal} */
function compactGovernance(journal,signature){const checkpoint={...checkpointDraft(journal),signature};return parseGovernance({...journal,checkpoint,events:[]},journal);}

/** @param {GovernanceJournal} journal @param {JsonValue} event @returns {GovernanceJournal} */
function appendGovernance(journal, event) {
  const current = replay(journal, journal);
  if (current.journal.events.length >= MAX_EVENTS) throw new RangeError('管理记录已达到 2048 条，请服主使用 Windows 客户端连接并完成权限快照整理后重试');
  bound(event);
  assertMemberMutation(current.state,event);
  const next = replayEvent(current.journal, current.state, event).journal;
  bound(next);
  return next;
}

/** @param {GovernanceState} state @param {string} actor @param {{domainId:string|null}} command @returns {void} */
function assertCatalogCommand(state,actor,command) {
  if(!canManageServerCatalog(state,actor))throw new TypeError('Server catalog management requires the server owner or a server administrator');
  if(command.domainId!==null)throw new TypeError('Server catalog commands require a null domain');
}

/** @param {GovernanceState} state @param {JsonValue} event @returns {void} */
function assertMemberMutation(state,event) {
  const row=object(event,'Governance event');
  if(row.command===undefined)throw new TypeError('Governance event requires a command');
  const command=parseGovernanceCommand(row.command),actor=memberKey(row.actorKey);
  if(command.type==='putEmoji' || command.type==='deleteEmoji' || command.type==='putInteraction' || command.type==='deleteInteraction')assertCatalogCommand(state,actor,command);
  if(command.type==='setDomainAdmin' || command.type==='setMemberGroups' || command.type==='setDomainOwner') {
    if(!canManageMember(state,actor,command.memberKey,command.domainId))throw new TypeError('不能管理自己、同级或更高权限成员');
  }
}

/** @param {GovernanceJournal} journal @param {string} actorKey @param {GovernanceCommand} command @returns {string} */
function governancePayload(journal, actorKey, command) {
  const current = replay(journal, journal);
  return payload(current.journal, memberKey(actorKey), parseGovernanceCommand(command));
}

/** @param {GovernanceJournal} journal @returns {GovernanceState} */
function governanceState(journal) { return replay(journal, journal).state; }

/** Cache exact validated inputs at an explicit connector boundary. @param {{maxEntries:number,maxBytes:number}} options */
function createGovernanceVerifier(options) {
  if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1 || options.maxEntries > 128) throw new RangeError('Governance verifier maxEntries must be an integer from 1 to 128');
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 32 * 1024 * 1024) throw new RangeError('Governance verifier maxBytes must be an integer from 1 to 33554432');
  const maxEntries = options.maxEntries, maxBytes = options.maxBytes;
  /** @type {Map<string,VerificationEntry>} */ const cache = new Map();
  let bytes = 0;
  let hits = 0;
  let misses = 0;
  /** @param {JsonValue} value @param {RoomDescriptor} expected @returns {string} */
  function cacheKey(value, expected) {
    const anchor = descriptor(expected);
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized,'utf8') > MAX_BYTES) throw new RangeError('Governance journal exceeds its 2 MiB JSON limit');
    return hash([anchor.roomId,anchor.creatorKey,serialized]);
  }
  /** @param {string} key @param {Replay} snapshot @returns {void} */
  function remember(key, snapshot) {
    const size = Buffer.byteLength(JSON.stringify(snapshot),'utf8') + Buffer.byteLength(key,'utf8');
    if (size > maxBytes) return;
    const existing = cache.get(key);
    if (existing) { bytes -= existing.bytes; cache.delete(key); }
    while (cache.size >= maxEntries || bytes + size > maxBytes) {
      const oldest = cache.entries().next().value;
      if (!oldest) throw new TypeError('Governance verifier accounting has no entry to evict');
      cache.delete(oldest[0]); bytes -= oldest[1].bytes;
    }
    cache.set(key,{ snapshot,bytes:size }); bytes += size;
  }
  /** @param {JsonValue} value @param {RoomDescriptor} expected @returns {Replay} */
  function read(value, expected) {
    const key = cacheKey(value,expected);
    const entry = cache.get(key);
    if (entry) { hits += 1; cache.delete(key); cache.set(key,entry); return entry.snapshot; }
    misses += 1;
    const snapshot = replay(value,expected);
    remember(key,snapshot);
    return snapshot;
  }
  /** @param {JsonValue} value @param {RoomDescriptor} expected @returns {GovernanceSnapshot} */
  function verifyJournal(value, expected) {
    const snapshot = read(value,expected);
    return structuredClone({ journal:snapshot.journal,policy:snapshot.state });
  }
  /** @param {GovernanceJournal} journal @param {string} actorKey @param {GovernanceCommand} command @returns {string} */
  function cachedPayload(journal, actorKey, command) {
    const snapshot = read(journal,journal);
    return payload(snapshot.journal,memberKey(actorKey),parseGovernanceCommand(command));
  }
  /** @param {GovernanceJournal} journal @param {JsonValue} event @returns {GovernanceJournal} */
  function append(journal, event) {
    const current = read(journal,journal);
    if (current.journal.events.length >= MAX_EVENTS) throw new RangeError('管理记录已达到 2048 条，请服主使用 Windows 客户端连接并完成权限快照整理后重试');
    bound(event);
    assertMemberMutation(current.state,event);
    const next = replayEvent(current.journal,current.state,event);
    bound(next.journal);
    remember(cacheKey(next.journal,next.journal),next);
    return structuredClone(next.journal);
  }
  /** @param {GovernanceJournal} journal @returns {GovernanceState} */
  function state(journal) { return structuredClone(read(journal,journal).state); }
  /** @returns {VerificationStats} */
  function stats() { return { entries:cache.size,bytes,hits,misses }; }
  return { verify:verifyJournal,payload:cachedPayload,append,state,stats };
}

/** @param {GovernanceState} state @param {string|null} key @param {string} domainId @returns {DomainRole} */
function stateDomainRole(state, key, domainId) {
  return memberRole(state,key,domainId);
}

/** @param {GovernanceJournal} journal @param {string|null} key @param {string} domainId @returns {DomainRole} */
function domainRole(journal, key, domainId) {
  identifier(domainId, 'Domain ID');
  if (key !== null) memberKey(key);
  return stateDomainRole(governanceState(journal), key, domainId);
}

/** Read an already verified state without replaying its signatures. @param {GovernanceState} state @param {string|null} key @param {string} domainId @returns {boolean} */
function stateCanManageDomainRoles(state, key, domainId) {
  const current = stateDomainRole(state, key, domainId);
  return current === 'server-owner' || current === 'server-admin' || current === 'domain-owner';
}

/** @param {GovernanceJournal} journal @param {string|null} key @param {string} domainId @returns {boolean} */
function canManageDomainRoles(journal, key, domainId) {
  identifier(domainId, 'Domain ID');
  if (key !== null) memberKey(key);
  return stateCanManageDomainRoles(governanceState(journal), key, domainId);
}

/** Read an already verified state without replaying its signatures. @param {GovernanceState} state @param {string|null} key @param {string} domainId @param {DomainPermission} permission @returns {boolean} */
function stateCanManageDomain(state, key, domainId, permission) {
  if (!PERMISSIONS.includes(permission)) throw new TypeError('Unsupported domain permission: ' + permission);
  const currentRole = stateDomainRole(state, key, domainId);
  if (currentRole === 'server-owner' || currentRole === 'server-admin' || currentRole === 'domain-owner' || currentRole === 'domain-admin') return true;
  const current = domain(state, domainId);
  const assignment = current.members.find(member=>member.memberKey === key);
  return current.groups.some(group=>assignment?.groupIds.includes(group.id) && group.permissions.includes(permission));
}

/** @param {GovernanceJournal} journal @param {string|null} key @param {string} domainId @param {DomainPermission} permission @returns {boolean} */
function canManageDomain(journal, key, domainId, permission) {
  identifier(domainId, 'Domain ID');
  if (key !== null) memberKey(key);
  return stateCanManageDomain(governanceState(journal), key, domainId, permission);
}

/** Compare already verified chains without accepting a fork or rollback. @param {GovernanceJournal} previous @param {GovernanceJournal} next @returns {boolean} */
function isGovernanceExtension(previous, next) {
  return extendsVerifiedGovernance(previous,next);
}

/** @param {RoomServer} value @returns {string} */
function channelStructure(value) {
  return JSON.stringify(value.channels.map(channel=>({ id:channel.id, name:channel.name, type:channel.type, userLimit:channel.userLimit, ...(channel.type==='radio' ? {radio:channel.radio} : {}) })));
}

/** Authorize validated structure changes using a previously verified state. @param {GovernanceState} state @param {string} key @param {RoomServer[]} previous @param {RoomServer[]} next @returns {void} */
function assertStructurePermission(state, key, previous, next) {
  if (key === state.ownerKey || state.serverAdmins?.includes(key)) return;
  if (previous.length !== next.length || previous.some(entry=>!next.some(candidate=>candidate.id === entry.id)) || next.some(entry=>!previous.some(candidate=>candidate.id === entry.id))) throw new TypeError('Adding or removing domains requires the current server owner');
  for (const before of previous) {
    const after = next.find(entry=>entry.id === before.id);
    if (!after) throw new TypeError('Domain ' + before.id + ' is absent from the proposed structure');
    if ((before.name !== after.name || before.icon !== after.icon || before.color !== after.color) && !stateCanManageDomainRoles(state, key, before.id)) throw new TypeError('Changing domain ' + before.id + ' metadata requires its domain owner or the server owner');
    if (channelStructure(before) !== channelStructure(after) && !stateCanManageDomain(state, key, before.id, 'manageChannels')) throw new TypeError('Changing channels in domain ' + before.id + ' requires manageChannels permission');
  }
}

module.exports = { createGovernance, parseGovernance, appendGovernance, governancePayload, parseGovernanceCommand, governanceState, createGovernanceVerifier, governanceRevision, governanceCheckpointPayload, compactGovernance, canManageDomain, domainRole, canManageDomainRoles, isGovernanceExtension, stateCanManageDomain, stateDomainRole, stateCanManageDomainRoles, assertStructurePermission, parseMemberKey:memberKey };
