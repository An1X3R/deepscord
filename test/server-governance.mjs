// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import governance from '../lib/server-governance.cjs';
import governanceStore from '../lib/governance-store.cjs';
import {parseTheme,parseCustomInteraction,parseCustomization,canManageCustomization,canManageServerCatalog,effectiveTheme,customInteractions} from '../public/js/customization-protocol.js';
import {parseGovernanceCommand as parseBrowserCommand,parseServerState} from '../public/js/server-governance-ui.js';
import {memberTitles} from '../public/js/member-permissions.js';

/** @typedef {import('../lib/server-governance.cjs').GovernanceJournal} GovernanceJournal */
/** @typedef {import('../lib/server-governance.cjs').GovernanceCommand} GovernanceCommand */
/** @typedef {import('../lib/server-governance.cjs').GovernanceEvent} GovernanceEvent */
/** @typedef {import('../lib/room-replica.cjs').RoomDescriptor} RoomDescriptor */
/** @typedef {import('../lib/steam-state.cjs').RoomServer} RoomServer */
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{key:string,privateKey:import('node:crypto').KeyObject}} Identity */
const { createGovernance, parseGovernance, appendGovernance, governancePayload, governanceState, parseGovernanceCommand, domainRole, canManageDomain, canManageDomainRoles, isGovernanceExtension, stateCanManageDomain, stateDomainRole, stateCanManageDomainRoles, assertStructurePermission, createGovernanceVerifier } = governance;

test('author titles combine the strongest identity role with current domain custom groups',()=>{
  /** @type {import('../lib/server-governance.cjs').GovernanceState} */
  const policy={ownerKey:'owner',name:'Server',serverAdmins:['admin'],domains:[{id:'domain',ownerKey:'curator',admins:['moderator','owner'],groups:[{id:'group',name:'Engineers',title:'Architect',permissions:[]},{id:'legacy',name:'Legacy title',permissions:[]}],members:[{memberKey:'owner',groupIds:['group']},{memberKey:'member',groupIds:['group','legacy']}]}]};
  assert.deepEqual(memberTitles(policy,'owner','domain'),['服主','Architect']);
  assert.deepEqual(memberTitles(policy,'admin','domain'),['服务器管理员']);
  assert.deepEqual(memberTitles(policy,'curator','domain'),['域主']);
  assert.deepEqual(memberTitles(policy,'moderator','domain'),['域管理员']);
  assert.deepEqual(memberTitles(policy,'member','domain'),['Architect','Legacy title']);
  assert.deepEqual(memberTitles(policy,'member','other-domain'),[]);
  assert.deepEqual(memberTitles(policy,'ordinary','domain'),[]);
  assert.deepEqual(memberTitles(policy,null,'domain'),[]);
  assert.deepEqual(memberTitles({...policy,serverAdmins:[]},'admin','domain'),[]);
  assert.deepEqual(memberTitles(policy,'owner',null),['服主']);
});

/** @returns {Identity} */
function identity() {
  const pair = generateKeyPairSync('ed25519');
  return { key:pair.publicKey.export({ format:'der', type:'spki' }).toString('base64'), privateKey:pair.privateKey };
}

/** @param {Identity} creator @returns {RoomDescriptor} */
function descriptor(creator) { return { version:1, roomId:randomUUID(), creatorKey:creator.key }; }

/** @param {GovernanceJournal} journal @param {Identity} actor @param {GovernanceCommand} command @returns {GovernanceEvent} */
function event(journal, actor, command) {
  return { revision:journal.events.length + 1, previousDigest:journal.digest, actorKey:actor.key, command, signature:sign(null, Buffer.from(governancePayload(journal, actor.key, command)), actor.privateKey).toString('base64') };
}

/** @param {GovernanceJournal} journal @param {Identity} actor @param {GovernanceCommand} command @returns {GovernanceJournal} */
function append(journal, actor, command) { return appendGovernance(journal, event(journal, actor, command)); }

/** Build an authentic pre-migration chain through historical replay. @param {GovernanceJournal} journal @param {Identity} actor @param {GovernanceCommand} command @returns {GovernanceJournal} */
function appendLegacy(journal,actor,command) {
  const next=event(journal,actor,parseGovernanceCommand(command));
  const digest=createHash('sha256').update(JSON.stringify(['deepscord-governance-event-v1',journal.roomId,journal.creatorKey,next])).digest('hex');
  return parseGovernance({...journal,events:[...journal.events,next],digest},journal);
}


test('one signed member update applies role and groups together and can release domain ownership',()=>{
  const owner=identity(),local=identity(),member=identity(),successor=identity();
  let journal=createGovernance(descriptor(owner));
  journal=append(journal,owner,{type:'putGroup',domainId:'alpha',groupId:'team',name:'Team',title:'Builder',permissions:['manageMessages']});
  journal=append(journal,owner,{type:'setMemberAccess',domainId:'alpha',memberKey:local.key,role:'domain-owner',groupIds:[]});
  const before=journal.events.length;
  journal=append(journal,local,{type:'setMemberAccess',domainId:'alpha',memberKey:member.key,role:'domain-admin',groupIds:['team']});
  assert.equal(journal.events.length,before+1);
  assert.equal(domainRole(journal,member.key,'alpha'),'domain-admin');
  assert.deepEqual(memberTitles(governanceState(journal),member.key,'alpha'),['域管理员','Builder']);
  const unchanged=JSON.stringify(journal);
  assert.throws(()=>append(journal,local,{type:'setMemberAccess',domainId:'alpha',memberKey:member.key,role:'server-admin',groupIds:['team']}),/服主/);
  assert.throws(()=>append(journal,local,{type:'setMemberAccess',domainId:'alpha',memberKey:member.key,role:'member',groupIds:['missing']}),/absent group/);
  assert.equal(JSON.stringify(journal),unchanged);
  journal=append(journal,owner,{type:'setMemberAccess',domainId:'alpha',memberKey:member.key,role:'server-admin',groupIds:['team']});
  assert.equal(domainRole(journal,member.key,'alpha'),'server-admin');
  assert(!governanceState(journal).domains[0].admins.includes(member.key));
  journal=append(journal,owner,{type:'setMemberAccess',domainId:'alpha',memberKey:member.key,role:'domain-owner',groupIds:['team']});
  assert.equal(domainRole(journal,member.key,'alpha'),'domain-owner');
  assert(!governanceState(journal).serverAdmins?.includes(member.key));
  journal=append(journal,owner,{type:'setMemberAccess',domainId:'alpha',memberKey:member.key,role:'member',groupIds:['team']});
  assert.equal(governanceState(journal).domains[0].ownerKey,owner.key);
  assert.equal(domainRole(journal,member.key,'alpha'),'special');
  journal=append(journal,owner,{type:'transferOwner',memberKey:successor.key});
  assert.equal(governanceState(journal).domains[0].ownerKey,successor.key);
  assert.deepEqual(parseGovernance(journal,descriptorFromJournal(journal)),journal);
});

/** @param {GovernanceJournal} journal @returns {RoomDescriptor} */
function descriptorFromJournal(journal){return {version:1,roomId:journal.roomId,creatorKey:journal.creatorKey};}

test('member-access command has identical browser and server canonical fields',()=>{
  const member=identity();
  const input={type:'setMemberAccess',domainId:'alpha',memberKey:member.key,role:'member',groupIds:['z','a'],extra:'discard'};
  const expected={type:'setMemberAccess',domainId:'alpha',memberKey:member.key,role:'member',groupIds:['a','z']};
  assert.deepEqual(parseGovernanceCommand(input),expected);assert.deepEqual(parseBrowserCommand(input),expected);
  for(const parse of [parseGovernanceCommand,parseBrowserCommand]){
    assert.throws(()=>parse({...input,role:'server-owner'}),/role/);
    assert.throws(()=>parse({...input,domainId:null}),/domain/);
    assert.throws(()=>parse({...input,groupIds:['a','a']}),/duplicate|groups/);
  }
});

/** @type {import('../public/js/customization-protocol.js').Theme} */
const theme={accent:'#123456',background:'charcoal',density:'compact',corners:'square'};
/** @param {string} id @returns {import('../public/js/customization-protocol.js').CustomInteraction} */
function interaction(id) {return {id,name:'Snowball',thumbnail:null,model:'bomb',trajectory:'arc',sound:'none',durationMs:900};}

test('customization schemas are canonical, bounded and shared with browser signing',()=>{
  /** @type {JsonValue[]} */
  const commands=[{type:'setTheme',domainId:null,theme:{...theme,css:'body{}'}},{type:'putInteraction',domainId:'alpha',interaction:{...interaction('snow'),html:'<script/>'}},{type:'deleteInteraction',domainId:'alpha',interactionId:'snow'}];
  for(const command of commands)assert.deepEqual(parseGovernanceCommand(command),parseBrowserCommand(command));
  assert.deepEqual(parseTheme({...theme,css:'body{}'}),theme);
  assert.deepEqual(parseCustomInteraction({...interaction('snow'),html:'<script/>'}),interaction('snow'));
  assert.throws(()=>parseTheme({...theme,accent:'red;display:none'}),/hexadecimal/);
  assert.throws(()=>parseTheme({...theme,background:'url(external)'}),/background/);
  assert.throws(()=>parseTheme({...theme,density:'tiny'}),/density/);
  assert.throws(()=>parseTheme({...theme,corners:'circle'}),/corners/);
  for(const id of ['bomb','poop','__proto__','bad/id'])assert.throws(()=>parseCustomInteraction(interaction(id)),TypeError);
  assert.throws(()=>parseCustomInteraction({...interaction('snow'),name:'x'.repeat(25)}),/24/);
  const {thumbnail,...missingThumbnail}=interaction('snow');
  assert.throws(()=>parseCustomInteraction(missingThumbnail),/explicitly/);
  assert.throws(()=>parseCustomInteraction({...interaction('snow'),model:'thumbnail'}),/asset/);
  assert.throws(()=>parseCustomInteraction({...interaction('snow'),sound:'https://evil/audio.mp3'}),/sound/);
  assert.throws(()=>parseCustomInteraction({...interaction('snow'),durationMs:2001}),/300..2000/);
  assert.throws(()=>parseCustomInteraction({...interaction('snow'),trajectory:'script'}),/trajectory/);
  const asset={sha256:'a'.repeat(64),width:240,height:240,bytes:100,animated:false,frames:1,durationMs:0};
  assert.deepEqual(parseCustomInteraction({...interaction('snow'),model:'thumbnail',thumbnail:asset}).thumbnail,asset);
  assert.throws(()=>parseCustomInteraction({...interaction('snow'),thumbnail:{...asset,animated:true,frames:2,durationMs:100}}),/static AVIF/);
  assert.throws(()=>parseCustomInteraction({...interaction('snow'),thumbnail:{...asset,width:241}}),/server media/);
  const scope={domainId:null,theme,interactions:[interaction('snow')]};
  assert.throws(()=>parseCustomization([scope,scope]),/duplicate scope/);
  assert.throws(()=>parseCustomization([{...scope,interactions:[interaction('snow'),interaction('snow')]}]),/duplicate interaction/);
  assert.throws(()=>parseCustomization([{...scope,domainId:'alpha',interactions:Array.from({length:25},(_,index)=>interaction('i'+index))}]),/interaction limit/);
  assert.throws(()=>parseCustomization(Array.from({length:14},(_,index)=>({...scope,domainId:'d'+index}))),/13/);
  assert.throws(()=>parseCustomization(Array.from({length:5},(_,index)=>({...scope,domainId:'d'+index,interactions:Array.from({length:24},(_,item)=>interaction('i'+item))}))),/96/);
});

test('signed customization isolates scopes, excludes admins and follows ownership transfers',()=>{
  const owner=identity(),local=identity(),admin=identity(),member=identity(),successor=identity();
  let journal=createGovernance(descriptor(owner));
  assert.equal(canManageCustomization(governanceState(journal),owner.key,null),true);
  assert.equal('customization' in governanceState(journal),false);
  journal=appendLegacy(journal,owner,{type:'setDomainOwner',domainId:'alpha',memberKey:local.key});
  journal=appendLegacy(journal,local,{type:'setDomainAdmin',domainId:'alpha',memberKey:admin.key,enabled:true});
  journal=appendLegacy(journal,local,{type:'putGroup',domainId:'alpha',groupId:'editors',name:'Editors',permissions:['manageChannels','manageMessages','moderateVoice']});
  journal=appendLegacy(journal,local,{type:'setMemberGroups',domainId:'alpha',memberKey:member.key,groupIds:['editors']});
  journal=appendLegacy(journal,owner,{type:'setTheme',domainId:null,theme});
  journal=appendLegacy(journal,owner,{type:'putInteraction',domainId:null,interaction:interaction('snow')});
  for(const actor of [local,admin,member])assert.throws(()=>appendLegacy(journal,actor,{type:'setTheme',domainId:null,theme}),/current server owner/);
  for(const actor of [admin,member])assert.throws(()=>appendLegacy(journal,actor,{type:'putInteraction',domainId:'alpha',interaction:interaction('snow')}),/selected domain/);
  assert.throws(()=>appendLegacy(journal,local,{type:'setTheme',domainId:'beta',theme}),/selected domain/);
  const localTheme={...theme,accent:'#abcdef'};
  journal=appendLegacy(journal,local,{type:'setTheme',domainId:'alpha',theme:localTheme});
  journal=appendLegacy(journal,local,{type:'putInteraction',domainId:'alpha',interaction:{...interaction('snow'),name:'Local'}});
  const state=governanceState(journal),before=JSON.stringify(state);
  assert.deepEqual(effectiveTheme(state,'alpha'),localTheme);
  assert.deepEqual(effectiveTheme(state,'beta'),theme);
  assert.equal(customInteractions(state,'alpha')[0].name,'Local');
  assert.equal(customInteractions(state,'beta')[0].name,'Snowball');
  assert.equal(customInteractions(state,null).length,1);
  for(const key of [admin.key,member.key,null])assert.equal(canManageCustomization(state,key,'alpha'),false);
  assert.equal(canManageCustomization(state,local.key,'alpha'),true);
  assert.equal(canManageCustomization(state,local.key,'beta'),false);
  assert.equal(JSON.stringify(state),before);
  journal=appendLegacy(journal,owner,{type:'transferOwner',memberKey:successor.key});
  assert.throws(()=>appendLegacy(journal,owner,{type:'setTheme',domainId:null,theme:null}),/current server owner/);
  journal=appendLegacy(journal,successor,{type:'setTheme',domainId:null,theme:null});
  journal=appendLegacy(journal,local,{type:'setTheme',domainId:'alpha',theme:null});
  assert.equal(effectiveTheme(governanceState(journal),'alpha'),null);
  journal=appendLegacy(journal,local,{type:'deleteInteraction',domainId:'alpha',interactionId:'snow'});
  assert.equal(customInteractions(governanceState(journal),'alpha')[0].name,'Snowball');
  assert.throws(()=>appendLegacy(journal,local,{type:'deleteInteraction',domainId:'alpha',interactionId:'snow'}),/absent/);
  journal=appendLegacy(journal,local,{type:'putInteraction',domainId:'alpha',interaction:interaction('local')});
  journal=appendLegacy(journal,successor,{type:'deleteDomain',domainId:'alpha'});
  assert.equal(governanceState(journal).customization?.some(scope=>scope.domainId==='alpha'),false);
});

test('customization signatures, replay and persistent storage retain canonical choices',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-customization-'));
  try {
    const owner=identity(),anchor=descriptor(owner),initial=createGovernance(anchor);
    const signed=event(initial,owner,{type:'setTheme',domainId:null,theme});
    assert.throws(()=>appendGovernance(initial,{...signed,command:{type:'setTheme',domainId:null,theme:{...theme,accent:'#ffffff'}}}),/signature/);
    const options={dataDir:directory,descriptor:anchor,seed:null,authority:false,signAuthority:/** @param {string} value */ value=>sign(null,Buffer.from(value),owner.privateKey).toString('base64')};
    const store=governanceStore.openGovernanceStore(options);
    store.change(owner.key,signed);
    const next=event(store.getJournal(),owner,{type:'putInteraction',domainId:null,interaction:interaction('snow')});
    store.change(owner.key,next);
    const restarted=governanceStore.openGovernanceStore(options),policy=restarted.getPolicy();
    assert.deepEqual(restarted.getJournal(),store.getJournal());
    assert.deepEqual(policy,store.getPolicy());
    assert.deepEqual(effectiveTheme(policy,null),theme);
    const serverState=parseServerState({t:'serverState',server:{id:anchor.roomId,name:policy.name},journal:store.getJournal(),policy,selfKey:owner.key,capabilities:[],members:[]});
    assert.deepEqual(serverState.policy,policy);
    assert.throws(()=>store.change(owner.key,next),/revision/);
  } finally {assert.equal(path.dirname(directory),os.tmpdir());fs.rmSync(directory,{recursive:true,force:true});}
});

test('empty governance is pinned to its creator and never promotes ordinary or unauthenticated members', () => {
  const owner = identity(), visitor = identity(), anchor = descriptor(owner);
  const journal = createGovernance(anchor);
  assert.deepEqual(governanceState(journal), { ownerKey:owner.key, name:'Deepscord', domains:[] });
  assert.deepEqual(parseGovernance(journal, anchor), journal);
  assert.equal(domainRole(journal, owner.key, 'legacy-domain'), 'server-owner');
  assert.equal(domainRole(journal, visitor.key, 'legacy-domain'), 'member');
  assert.equal(domainRole(journal, null, 'legacy-domain'), 'member');
  assert.equal(canManageDomainRoles(journal, null, 'legacy-domain'), false);
  assert.equal(canManageDomain(journal, visitor.key, 'legacy-domain', 'manageChannels'), false);
  assert.throws(()=>append(journal, visitor, { type:'transferOwner', memberKey:visitor.key }), /current server owner/);
});

test('domain ownership, delegated administrators and named groups stay within their own domain', () => {
  const owner = identity(), domainOwner = identity(), admin = identity(), member = identity();
  const initial = createGovernance(descriptor(owner));
  const frozen = JSON.stringify(initial);
  let journal = append(initial, owner, { type:'setDomainOwner', domainId:'alpha', memberKey:domainOwner.key });
  journal = append(journal, domainOwner, { type:'setDomainAdmin', domainId:'alpha', memberKey:admin.key, enabled:true });
  assert.equal(domainRole(journal, domainOwner.key, 'alpha'), 'domain-owner');
  assert.equal(domainRole(journal, admin.key, 'alpha'), 'domain-admin');
  for (const permission of /** @type {const} */ (['manageChannels','manageMessages','moderateVoice'])) {
    assert.equal(canManageDomain(journal, admin.key, 'alpha', permission), true);
    assert.equal(canManageDomain(journal, admin.key, 'beta', permission), false);
    assert.equal(canManageDomain(journal, domainOwner.key, 'beta', permission), false);
  }
  assert.equal(canManageDomainRoles(journal, admin.key, 'alpha'), false);
  assert.equal(canManageDomainRoles(journal, domainOwner.key, 'alpha'), true);
  assert.throws(()=>append(journal, admin, { type:'setDomainAdmin', domainId:'alpha', memberKey:member.key, enabled:true }), /同级或更高/);
  assert.throws(()=>append(journal, admin, { type:'setDomainOwner', domainId:'alpha', memberKey:admin.key }), /同级或更高/);
  assert.throws(()=>append(journal, domainOwner, { type:'setDomainOwner', domainId:'alpha', memberKey:member.key }), /current server owner/);
  assert.throws(()=>append(journal, domainOwner, { type:'putGroup', domainId:'beta', groupId:'editors', name:'Editors', permissions:['manageChannels'] }), /owner of domain beta/);
  journal = append(journal, domainOwner, { type:'putGroup', domainId:'alpha', groupId:'editors', name:'Editors', permissions:['manageMessages','manageChannels'] });
  journal = append(journal, domainOwner, { type:'setMemberGroups', domainId:'alpha', memberKey:member.key, groupIds:['editors'] });
  assert.equal(domainRole(journal, member.key, 'alpha'), 'special');
  assert.equal(canManageDomain(journal, member.key, 'alpha', 'manageMessages'), true);
  assert.equal(canManageDomain(journal, member.key, 'alpha', 'moderateVoice'), false);
  assert.equal(canManageDomain(journal, member.key, 'beta', 'manageChannels'), false);
  assert.equal(canManageDomainRoles(journal, member.key, 'alpha'), false);
  assert.throws(()=>append(journal, admin, { type:'putGroup', domainId:'alpha', groupId:'root', name:'Root', permissions:['manageChannels'] }), /owner of domain alpha/);
  assert.throws(()=>append(journal, domainOwner, { type:'setMemberGroups', domainId:'alpha', memberKey:member.key, groupIds:['absent'] }), /absent group/);
  journal = append(journal, domainOwner, { type:'deleteGroup', domainId:'alpha', groupId:'editors' });
  journal = append(journal, domainOwner, { type:'setDomainAdmin', domainId:'alpha', memberKey:admin.key, enabled:false });
  assert.equal(domainRole(journal, member.key, 'alpha'), 'member');
  assert.equal(domainRole(journal, admin.key, 'alpha'), 'member');
  assert.equal(JSON.stringify(initial), frozen, 'Appending governance mutated the original journal');
});

test('server ownership transfer preserves explicit domain owners and transfers inherited policies', () => {
  const original = identity(), successor = identity(), domainOwner = identity(), admin = identity();
  let journal = createGovernance(descriptor(original));
  journal = append(journal, original, { type:'setDomainOwner', domainId:'explicit', memberKey:domainOwner.key });
  journal = append(journal, original, { type:'setDomainAdmin', domainId:'inherited', memberKey:admin.key, enabled:true });
  const transfer = event(journal, original, { type:'transferOwner', memberKey:successor.key });
  journal = appendGovernance(journal, transfer);
  assert.equal(governanceState(journal).ownerKey, successor.key);
  assert.equal(domainRole(journal, original.key, 'fresh'), 'member');
  assert.equal(domainRole(journal, original.key, 'inherited'), 'member');
  assert.equal(domainRole(journal, successor.key, 'fresh'), 'server-owner');
  assert.equal(domainRole(journal, domainOwner.key, 'explicit'), 'domain-owner');
  assert.equal(domainRole(journal, admin.key, 'inherited'), 'domain-admin');
  assert.equal(governanceState(journal).domains.find(entry=>entry.id === 'inherited')?.ownerKey, successor.key);
  assert.throws(()=>append(journal, original, { type:'renameServer', name:'Stale owner' }), /current server owner/);
  journal = append(journal, successor, { type:'renameServer', name:'New server' });
  assert.equal(governanceState(journal).name, 'New server');
  assert.throws(()=>appendGovernance(journal, transfer), /revision/);
});

test('real signed chains reject tampering, forgery, invalid pins and stale replay', () => {
  const owner = identity(), attacker = identity(), anchor = descriptor(owner), empty = createGovernance(anchor);
  const signed = event(empty, owner, { type:'renameServer', name:'Authenticated' });
  const saved = appendGovernance(empty, signed);
  assert.throws(()=>appendGovernance(empty, { ...signed, previousDigest:'0'.repeat(64) }), /previousDigest/);
  assert.throws(()=>appendGovernance(empty, { ...signed, revision:2 }), /revision/);
  assert.throws(()=>appendGovernance(empty, { ...signed, command:{ type:'renameServer', name:'Tampered' } }), /signature/);
  assert.throws(()=>appendGovernance(empty, { ...signed, actorKey:attacker.key }), /signature/);
  assert.throws(()=>appendGovernance(empty, { ...signed, signature:Buffer.alloc(64).toString('base64') }), /signature/);
  assert.throws(()=>appendGovernance(empty, { ...signed, signature:'invalid' }), /base64/);
  assert.throws(()=>parseGovernance({ ...saved, digest:'0'.repeat(64) }, anchor), /digest/);
  assert.throws(()=>parseGovernance(saved, { ...anchor, roomId:randomUUID() }), /pinned room identity/);
  assert.throws(()=>parseGovernance(saved, { ...anchor, creatorKey:attacker.key }), /pinned room identity/);
  const forged = event(empty, attacker, { type:'renameServer', name:'Forged owner' });
  assert.throws(()=>appendGovernance(empty, forged), /current server owner/);
  assert.throws(()=>parseGovernance({ ...saved, events:[forged] }, anchor), /current server owner/);
  const alternate = append(empty, owner, { type:'renameServer', name:'Other branch' });
  const next = event(saved, owner, { type:'renameServer', name:'Next' });
  assert.throws(()=>appendGovernance(alternate, next), /previousDigest/);
});

test('canonical parsing strips extra fields and refuses permission escalation and ambiguous groups', () => {
  const owner = identity(), anchor = descriptor(owner), empty = createGovernance(anchor);
  const command = parseGovernanceCommand({ type:'putGroup', domainId:'domain', groupId:'editors', name:'Editors', permissions:['manageMessages','manageChannels'], ownerKey:owner.key });
  assert.deepEqual(command, { type:'putGroup', domainId:'domain', groupId:'editors', name:'Editors', permissions:['manageChannels','manageMessages'] });
  const signed = event(empty, owner, command);
  const saved = appendGovernance(empty, { ...signed, ignored:true, command:{ ...command, ignored:true } });
  assert.deepEqual(parseGovernance({ ...saved, ignored:true }, anchor), saved);
  assert.equal('ignored' in saved.events[0], false);
  assert.equal('ignored' in saved.events[0].command, false);
  for (const permission of ['manageRoles','owner','admin','administrator','transferOwner']) {
    assert.throws(()=>parseGovernanceCommand({ type:'putGroup', domainId:'domain', groupId:'root', name:'Root', permissions:[permission] }), /Group permission/);
  }
  assert.throws(()=>parseGovernanceCommand({ type:'putGroup', domainId:'domain', groupId:'root', name:'Root', permissions:['manageChannels','manageChannels'] }), /duplicate/);
  assert.throws(()=>parseGovernanceCommand({ type:'setMemberGroups', domainId:'domain', memberKey:owner.key, groupIds:['group','group'] }), /duplicate/);
  assert.throws(()=>parseGovernanceCommand({ type:'setDomainAdmin', domainId:'domain', memberKey:owner.key, enabled:1 }), /boolean/);
  assert.throws(()=>parseGovernanceCommand({ type:'renameServer', name:'\u0000' }), /control/);
  assert.throws(()=>parseGovernanceCommand({ type:'deleteGroup', domainId:'__proto__', groupId:'group' }), /safe/);
  assert.throws(()=>parseGovernanceCommand({ type:'transferOwner', memberKey:'not-a-key' }), /base64/);
});

test('journal and policy limits fail explicitly', () => {
  const owner = identity(), delegate = identity(), anchor = descriptor(owner);
  let journal = createGovernance(anchor);
  for (let index = 0; index < 12; index++) journal = append(journal, owner, { type:'setDomainOwner', domainId:'domain-' + index, memberKey:delegate.key });
  assert.throws(()=>append(journal, owner, { type:'setDomainOwner', domainId:'domain-13', memberKey:delegate.key }), /12-domain/);
  for (let index = 0; index < 64; index++) journal = append(journal, owner, { type:'putGroup', domainId:'domain-0', groupId:'group-' + index, name:'Group', permissions:[] });
  assert.throws(()=>append(journal, owner, { type:'putGroup', domainId:'domain-1', groupId:'group-65', name:'Group', permissions:[] }), /64-group/);
  assert.throws(()=>parseGovernance({ ...journal, ignored:'x'.repeat(2 * 1024 * 1024) }, anchor), /2 MiB/);
  assert.throws(()=>parseGovernance({ ...journal, events:Array(2049).fill(null) }, anchor), /2048-entry/);
  /** @type {JsonValue[]} */
  const invalid = [null, [], { ...journal, version:2 }];
  for (const value of invalid) assert.throws(()=>parseGovernance(value, anchor), TypeError);
});

test('verified chain extensions reject forks, rollbacks and unrelated identities', () => {
  const owner = identity(), anchor = descriptor(owner), initial = createGovernance(anchor);
  const first = append(initial, owner, { type:'renameServer', name:'First' });
  const second = append(first, owner, { type:'renameServer', name:'Second' });
  const fork = append(initial, owner, { type:'renameServer', name:'Fork' });
  const forkNext = append(fork, owner, { type:'renameServer', name:'Fork next' });
  assert.equal(isGovernanceExtension(initial, initial), true);
  assert.equal(isGovernanceExtension(first, structuredClone(first)), true);
  assert.equal(isGovernanceExtension(initial, second), true);
  assert.equal(isGovernanceExtension(first, second), true);
  assert.equal(isGovernanceExtension(second, first), false);
  assert.equal(isGovernanceExtension(first, fork), false);
  assert.equal(isGovernanceExtension(first, forkNext), false);
  assert.equal(isGovernanceExtension(initial, createGovernance(descriptor(owner))), false);
  assert.equal(isGovernanceExtension(initial, createGovernance({ ...anchor, creatorKey:identity().key })), false);
});

test('cached state permissions match journal permissions without granting unverified members authority', () => {
  const owner = identity(), domainOwner = identity(), admin = identity(), member = identity();
  let journal = createGovernance(descriptor(owner));
  journal = append(journal, owner, { type:'setDomainOwner', domainId:'alpha', memberKey:domainOwner.key });
  journal = append(journal, owner, { type:'setDomainAdmin', domainId:'alpha', memberKey:admin.key, enabled:true });
  journal = append(journal, domainOwner, { type:'putGroup', domainId:'alpha', groupId:'editors', name:'Editors', permissions:['manageChannels'] });
  journal = append(journal, domainOwner, { type:'setMemberGroups', domainId:'alpha', memberKey:member.key, groupIds:['editors'] });
  const state = governanceState(journal), snapshot = JSON.stringify(state);
  for (const key of [owner.key, domainOwner.key, admin.key, member.key, null]) {
    for (const domainId of ['alpha', 'beta']) {
      assert.equal(stateDomainRole(state, key, domainId), domainRole(journal, key, domainId));
      assert.equal(stateCanManageDomainRoles(state, key, domainId), canManageDomainRoles(journal, key, domainId));
      for (const permission of /** @type {const} */ (['manageChannels','manageMessages','moderateVoice'])) assert.equal(stateCanManageDomain(state, key, domainId, permission), canManageDomain(journal, key, domainId, permission));
    }
  }
  assert.equal(JSON.stringify(state), snapshot);
});

test('structure votes enforce domain and channel permissions on legacy server records', () => {
  const owner = identity(), domainOwner = identity(), admin = identity(), editor = identity(), member = identity();
  let journal = createGovernance(descriptor(owner));
  journal = append(journal, owner, { type:'setDomainOwner', domainId:'srv-main', memberKey:domainOwner.key });
  journal = append(journal, domainOwner, { type:'setDomainAdmin', domainId:'srv-main', memberKey:admin.key, enabled:true });
  journal = append(journal, domainOwner, { type:'putGroup', domainId:'srv-main', groupId:'editors', name:'Editors', permissions:['manageChannels'] });
  journal = append(journal, domainOwner, { type:'setMemberGroups', domainId:'srv-main', memberKey:editor.key, groupIds:['editors'] });
  const state = governanceState(journal);
  /** @type {RoomServer[]} */
  const previous = [
    { id:'srv-main', name:'Deepscord', icon:'D', color:'#7c6cf5', channels:[{ id:'ch-lobby', name:'Lobby', type:'voice', userLimit:0 }, { id:'ch-chat', name:'Chat', type:'text', userLimit:0 }] },
    { id:'srv-night', name:'Night', icon:'N', color:'#3ecf8e', channels:[{ id:'ch-night-voice', name:'Room', type:'voice', userLimit:0 }] },
  ];
  const before = JSON.stringify(previous);
  const channels = previous.map(entry=>entry.id === 'srv-main' ? { ...entry, channels:[...entry.channels, { id:'ch-new', name:'New channel', type:/** @type {const} */ ('text'), userLimit:0 }] } : entry);
  const crossDomain = previous.map(entry=>entry.id === 'srv-night' ? { ...entry, channels:[] } : entry);
  const metadata = previous.map(entry=>entry.id === 'srv-main' ? { ...entry, name:'Changed domain', icon:'C', color:'#123456' } : entry);
  for (const key of [owner.key, domainOwner.key, admin.key, editor.key, member.key]) assert.doesNotThrow(()=>assertStructurePermission(state, key, previous, structuredClone(previous)));
  assert.doesNotThrow(()=>assertStructurePermission(state, member.key, previous, [...previous].reverse()));
  for (const key of [owner.key, domainOwner.key, admin.key, editor.key]) assert.doesNotThrow(()=>assertStructurePermission(state, key, previous, channels));
  assert.throws(()=>assertStructurePermission(state, member.key, previous, channels), /srv-main.*manageChannels/);
  for (const key of [domainOwner.key, admin.key, editor.key, member.key]) assert.throws(()=>assertStructurePermission(state, key, previous, crossDomain), /srv-night.*manageChannels/);
  assert.doesNotThrow(()=>assertStructurePermission(state, domainOwner.key, previous, metadata));
  assert.doesNotThrow(()=>assertStructurePermission(state, owner.key, previous, metadata));
  for (const key of [admin.key, editor.key, member.key]) assert.throws(()=>assertStructurePermission(state, key, previous, metadata), /srv-main metadata.*domain owner/);
  for (const key of [domainOwner.key, admin.key, editor.key, member.key]) {
    assert.throws(()=>assertStructurePermission(state, key, previous, previous.slice(0,1)), /Adding or removing domains/);
    assert.throws(()=>assertStructurePermission(state, key, previous, previous.map(entry=>entry.id === 'srv-night' ? { ...entry, id:'replacement' } : entry)), /Adding or removing domains/);
  }
  assert.doesNotThrow(()=>assertStructurePermission(state, owner.key, previous, []));
  const reorderedChannels = previous.map(entry=>entry.id === 'srv-main' ? { ...entry, channels:[...entry.channels].reverse() } : entry);
  assert.throws(()=>assertStructurePermission(state, member.key, previous, reorderedChannels), /manageChannels/);
  assert.doesNotThrow(()=>assertStructurePermission(state, admin.key, previous, reorderedChannels));
  const differentPropertyOrder = previous.map(entry=>({ ...entry, channels:entry.channels.map(channel=>({ ...channel, userLimit:channel.userLimit, name:channel.name, id:channel.id })) }));
  assert.doesNotThrow(()=>assertStructurePermission(state, member.key, previous, differentPropertyOrder));
  assert.equal(JSON.stringify(previous), before);
});

test('signed domain deletion frees active policies while preserving the authorized historical chain', () => {
  const owner = identity(), domainOwner = identity(), admin = identity(), member = identity();
  const anchor = descriptor(owner);
  let journal = createGovernance(anchor);
  const initial = journal;
  for (let index = 0; index < 16; index++) {
    const domainId = 'cycled-' + index;
    journal = append(journal,owner,{ type:'setDomainOwner', domainId, memberKey:domainOwner.key });
    journal = append(journal,domainOwner,{ type:'setDomainAdmin', domainId, memberKey:admin.key, enabled:true });
    journal = append(journal,domainOwner,{ type:'putGroup', domainId, groupId:'editors', name:'Editors', permissions:['manageChannels'] });
    journal = append(journal,domainOwner,{ type:'setMemberGroups', domainId, memberKey:member.key, groupIds:['editors'] });
    const beforeDeletion = journal;
    const history = JSON.stringify(beforeDeletion.events);
    assert.equal(governanceState(journal).domains.length,1);
    assert.throws(()=>append(journal,domainOwner,{ type:'deleteDomain', domainId }),/current server owner/);
    assert.throws(()=>append(journal,admin,{ type:'deleteDomain', domainId }),/current server owner/);
    assert.throws(()=>append(journal,member,{ type:'deleteDomain', domainId }),/current server owner/);
    journal = append(journal,owner,{ type:'deleteDomain', domainId });
    assert.deepEqual(governanceState(journal).domains,[]);
    assert.equal(canManageDomain(journal,admin.key,domainId,'manageChannels'),false);
    assert.equal(canManageDomain(journal,member.key,domainId,'manageChannels'),false);
    assert.equal(domainRole(journal,domainOwner.key,domainId),'member');
    assert.equal(JSON.stringify(journal.events.slice(0,-1)),history);
    assert.deepEqual(parseGovernance(beforeDeletion,anchor),beforeDeletion);
    assert.equal(governanceState(beforeDeletion).domains[0].ownerKey,domainOwner.key);
  }
  assert.equal(journal.events.length,80);
  assert.equal(isGovernanceExtension(initial,journal),true);
  assert.deepEqual(parseGovernance(journal,anchor),journal);
  assert.deepEqual(parseGovernanceCommand({ type:'deleteDomain', domainId:'cycled-0', ignored:true }),{ type:'deleteDomain', domainId:'cycled-0' });
  const successor = identity();
  journal = append(journal,owner,{ type:'setDomainAdmin', domainId:'cycled-0', memberKey:admin.key, enabled:true });
  journal = append(journal,owner,{ type:'transferOwner', memberKey:successor.key });
  assert.equal(governanceState(journal).domains[0].ownerKey,successor.key,'A deleted owner assignment must not freeze a recreated policy to its old inherited owner');
  assert.equal(domainRole(journal,owner.key,'cycled-0'),'member');
  assert.equal(domainRole(journal,admin.key,'cycled-0'),'domain-admin');
});

test('connector verification caches exact inputs without trusting declared digests or exposing private snapshots', () => {
  const owner=identity(),anchor=descriptor(owner),initial=createGovernance(anchor);
  const options={maxEntries:4,maxBytes:1024*1024},verifier=createGovernanceVerifier(options);
  options.maxEntries=0;options.maxBytes=0;
  const verified=verifier.verify(initial,anchor);
  assert.deepEqual(verified,{journal:initial,policy:governanceState(initial)});
  const signed=event(initial,owner,{type:'renameServer',name:'Verified'});
  const next=verifier.append(initial,signed);
  const before=verifier.stats();
  const snapshot=verifier.verify(next,anchor);
  assert.equal(verifier.stats().hits,before.hits+1,'Appending a valid event must cache its fully verified result');
  snapshot.policy.name='Poisoned';snapshot.policy.ownerKey=identity().key;
  snapshot.journal.events[0].command={type:'renameServer',name:'Poisoned command'};snapshot.journal.events.splice(0);
  assert.equal(verifier.state(next).name,'Verified');
  assert.deepEqual(verifier.verify(next,anchor).journal,next);
  const tampered={...next,events:[{...next.events[0],command:{type:'renameServer',name:'Altered'}}]};
  assert.throws(()=>verifier.verify(tampered,anchor),/signature/);
  assert.throws(()=>verifier.verify({...next,events:[]},anchor),/digest/);
  assert.throws(()=>verifier.verify(next,{...anchor,roomId:randomUUID()}),/pinned room identity/);
  assert.throws(()=>verifier.append(next,signed),/revision/);
  const outsider=identity(),forged=event(next,outsider,{type:'renameServer',name:'Unauthorized'});
  assert.throws(()=>verifier.append(next,forged),/current server owner/);
  const payload=verifier.payload(next,owner.key,{type:'renameServer',name:'Next'});
  assert.equal(payload,governancePayload(next,owner.key,{type:'renameServer',name:'Next'}));
  assert.deepEqual(verifier.verify({...next,ignored:true},anchor).journal,next);
  assert.equal(verifier.state(next).ownerKey,owner.key);
});

test('connector cache evicts within entry and retained serialized-byte budgets', () => {
  const owner=identity(),anchor=descriptor(owner),initial=createGovernance(anchor);
  const first=append(initial,owner,{type:'renameServer',name:'One'}),second=append(first,owner,{type:'renameServer',name:'Two'});
  const verifier=createGovernanceVerifier({maxEntries:2,maxBytes:1024*1024});
  verifier.verify(initial,anchor);verifier.verify(first,anchor);verifier.verify(initial,anchor);verifier.verify(second,anchor);
  assert.equal(verifier.stats().entries,2);
  const before=verifier.stats();verifier.verify(first,anchor);
  assert.equal(verifier.stats().misses,before.misses+1,'The least recently used entry should be evicted');
  const measured=createGovernanceVerifier({maxEntries:8,maxBytes:1024*1024});measured.verify(first,anchor);
  const budget=measured.stats().bytes;
  const bytesLimited=createGovernanceVerifier({maxEntries:8,maxBytes:budget});
  bytesLimited.verify(first,anchor);assert.equal(bytesLimited.stats().entries,1);
  bytesLimited.verify(second,anchor);assert(bytesLimited.stats().bytes<=budget);assert(bytesLimited.stats().entries<=1);
  const noRetention=createGovernanceVerifier({maxEntries:1,maxBytes:1});
  assert.deepEqual(noRetention.verify(second,anchor).journal,second);assert.equal(noRetention.stats().entries,0);
  assert.throws(()=>createGovernanceVerifier({maxEntries:0,maxBytes:1024}),RangeError);
  assert.throws(()=>createGovernanceVerifier({maxEntries:1,maxBytes:Infinity}),RangeError);
  assert.throws(()=>verifier.verify({...initial,ignored:'x'.repeat(2*1024*1024)},anchor),/2 MiB/);
});

test('governance store preserves unchanged files and rejects forged or forked restores without writes', () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-governance-store-'));
  try {
    const owner=identity(),anchor=descriptor(owner),initial=createGovernance(anchor);
    const first=append(initial,owner,{type:'renameServer',name:'One'}),fork=append(initial,owner,{type:'renameServer',name:'Fork'});
    const options={dataDir:directory,descriptor:anchor,seed:first,authority:false,signAuthority:/** @param {string} value */ value=>sign(null,Buffer.from(value),owner.privateKey).toString('base64')};
    const store=governanceStore.openGovernanceStore(options),filename=path.join(directory,'server-governance.json');
    fs.utimesSync(filename,new Date('2000-01-01T00:00:00Z'),new Date('2000-01-01T00:00:00Z'));
    const before=fs.readFileSync(filename,'utf8'),modified=fs.statSync(filename).mtimeMs;
    assert.equal(store.restore(first),false);
    assert.equal(store.restore(initial),false);
    assert.throws(()=>store.restore(fork),/conflict/);
    assert.throws(()=>store.restore({...first,events:[]}),/digest/);
    const restarted=governanceStore.openGovernanceStore(options);
    assert.equal(restarted.getJournal().digest,first.digest);
    assert.equal(fs.statSync(filename).mtimeMs,modified);
    assert.equal(fs.readFileSync(filename,'utf8'),before);
    store.change(owner.key,event(first,owner,{type:'renameServer',name:'Two'}));
    assert.equal(store.getPolicy().name,'Two');
    assert.notEqual(fs.readFileSync(filename,'utf8'),before);
  } finally { assert.equal(path.dirname(directory),os.tmpdir());fs.rmSync(directory,{recursive:true,force:true}); }
});


test('one owner-signed catalog initialization preserves history, edits and deletions through restart',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-catalog-'));
  try {
    const owner=identity(),visitor=identity(),anchor=descriptor(owner);
    const options={dataDir:directory,descriptor:anchor,seed:null,authority:false,signAuthority:/** @param {string} value */ value=>sign(null,Buffer.from(value),owner.privateKey).toString('base64')};
    const store=governanceStore.openGovernanceStore(options);
    store.change(owner.key,event(store.getJournal(),owner,{type:'putInteraction',domainId:null,interaction:interaction('existing')}));
    store.change(owner.key,event(store.getJournal(),owner,{type:'putInteraction',domainId:null,interaction:{...interaction('playful-fist'),name:'Existing fist'}}));
    const historical=store.getJournal(),historicalBytes=JSON.stringify(historical);
    assert.equal(Object.hasOwn(store.getPolicy(),'interactionCatalogVersion'),false);
    assert.deepEqual(parseGovernance(historical,anchor),historical);
    assert.equal(JSON.stringify(historical),historicalBytes);
    assert.throws(()=>store.change(visitor.key,event(historical,visitor,{type:'initializeInteractionCatalog'})),/current server owner/);
    const command={type:/** @type {const} */ ('initializeInteractionCatalog')};
    assert.deepEqual(parseBrowserCommand({...command,extra:'discard'}),command);
    assert.deepEqual(parseGovernanceCommand({...command,extra:'discard'}),command);
    const signed=event(historical,owner,command);
    store.change(owner.key,signed);
    assert.equal(store.getJournal().events.length,historical.events.length+1);
    assert.equal(store.getPolicy().interactionCatalogVersion,1);
    const entries=customInteractions(store.getPolicy(),null);
    assert.equal(entries.length,5);
    assert.equal(entries.find(entry=>entry.id==='playful-fist')?.name,'Existing fist');
    assert.deepEqual(entries.filter(entry=>entry.id.startsWith('default-')).map(entry=>entry.model),['bomb','poop']);
    const edited={...entries.find(entry=>entry.id==='default-bomb'),name:'Edited bomb'};
    store.change(owner.key,event(store.getJournal(),owner,{type:'putInteraction',domainId:null,interaction:parseCustomInteraction(edited)}));
    store.change(owner.key,event(store.getJournal(),owner,{type:'deleteInteraction',domainId:null,interactionId:'default-poop'}));
    const restarted=governanceStore.openGovernanceStore(options),policy=restarted.getPolicy();
    assert.deepEqual(restarted.getJournal(),store.getJournal());
    assert.deepEqual(parseGovernance(restarted.getJournal(),anchor),store.getJournal());
    assert.equal(customInteractions(policy,null).find(entry=>entry.id==='default-bomb')?.name,'Edited bomb');
    assert.equal(customInteractions(policy,'alpha').some(entry=>entry.id==='default-poop'),false);
    assert.throws(()=>restarted.change(owner.key,event(restarted.getJournal(),owner,command)),/already been initialized/);
    const parsed=parseServerState({t:'serverState',server:{id:anchor.roomId,name:policy.name},journal:restarted.getJournal(),policy,selfKey:owner.key,capabilities:[],members:[]});
    assert.deepEqual(parsed.policy,policy);
    assert.throws(()=>parseServerState({t:'serverState',server:{id:anchor.roomId,name:policy.name},journal:restarted.getJournal(),policy:{...policy,interactionCatalogVersion:3},selfKey:owner.key,capabilities:[],members:[]}),/catalog version/);
  } finally {assert.equal(path.dirname(directory),os.tmpdir());fs.rmSync(directory,{recursive:true,force:true});}
});

test('catalog initialization fails atomically at scope and total capacity',()=>{
  const owner=identity(),anchor=descriptor(owner);
  let journal=createGovernance(anchor);
  for(let index=0;index<21;index++)journal=append(journal,owner,{type:'putInteraction',domainId:null,interaction:interaction('custom-'+index)});
  const before=JSON.stringify(journal);
  assert.throws(()=>append(journal,owner,{type:'initializeInteractionCatalog'}),/24 interactions/);
  assert.equal(JSON.stringify(journal),before);
  assert.equal(Object.hasOwn(governanceState(journal),'interactionCatalogVersion'),false);
  journal=append(journal,owner,{type:'deleteInteraction',domainId:null,interactionId:'custom-20'});
  journal=append(journal,owner,{type:'initializeInteractionCatalog'});
  assert.equal(customInteractions(governanceState(journal),null).length,24);
  let total=createGovernance(anchor);
  for(const domainId of [null,'alpha','beta','gamma'])for(let index=0;index<24;index++)total=appendLegacy(total,owner,{type:'putInteraction',domainId,interaction:interaction('item-'+index)});
  total=append(total,owner,{type:'deleteInteraction',domainId:null,interactionId:'item-23'});
  total=append(total,owner,{type:'deleteInteraction',domainId:null,interactionId:'item-22'});
  total=append(total,owner,{type:'deleteInteraction',domainId:null,interactionId:'item-21'});
  total=append(total,owner,{type:'deleteInteraction',domainId:null,interactionId:'item-20'});
  total=appendLegacy(total,owner,{type:'putInteraction',domainId:'delta',interaction:interaction('extra')});
  assert.throws(()=>append(total,owner,{type:'initializeInteractionCatalog'}),/96 interactions/);
  assert.equal(Object.hasOwn(governanceState(total),'interactionCatalogVersion'),false);
});


test('signed server catalog migration preserves legacy collisions, themes and deleted defaults',()=>{
  const owner=identity(),local=identity(),admin=identity(),member=identity();
  let legacy=createGovernance(descriptor(owner));
  legacy=append(legacy,owner,{type:'setDomainOwner',domainId:'alpha',memberKey:local.key});
  legacy=append(legacy,owner,{type:'setServerAdmin',memberKey:admin.key,enabled:true});
  legacy=appendLegacy(legacy,owner,{type:'initializeInteractionCatalog'});
  legacy=appendLegacy(legacy,owner,{type:'deleteInteraction',domainId:null,interactionId:'default-poop'});
  legacy=appendLegacy(legacy,local,{type:'putInteraction',domainId:'alpha',interaction:{...interaction('playful-fist'),name:'Local fist'}});
  legacy=appendLegacy(legacy,local,{type:'putInteraction',domainId:'alpha',interaction:interaction('playful-fist-migrated-1')});
  legacy=appendLegacy(legacy,local,{type:'setTheme',domainId:'alpha',theme});
  const asset={sha256:'b'.repeat(64),width:40,height:40,bytes:100,animated:false,frames:1,durationMs:0};
  legacy=appendLegacy(legacy,local,{type:'putEmoji',domainId:'alpha',emojiId:'old-emoji',name:'Old emoji',asset,ts:1});
  const historical=JSON.stringify(legacy);
  assert.deepEqual(parseBrowserCommand({type:'migrateServerCatalog',extra:'strip'}),{type:'migrateServerCatalog'});
  for(const actor of [local,member])assert.throws(()=>append(legacy,actor,{type:'migrateServerCatalog'}),/owner or a server administrator/);
  let migrated=append(legacy,admin,{type:'migrateServerCatalog'});
  assert.equal(JSON.stringify(legacy),historical);
  assert.deepEqual(migrated.events.slice(0,-1),legacy.events);
  const policy=governanceState(migrated),entries=customInteractions(policy,null);
  assert.equal(policy.interactionCatalogVersion,2);
  assert.equal(entries.find(entry=>entry.name==='Local fist')?.id,'playful-fist-migrated-2');
  assert.equal(entries.some(entry=>entry.id==='default-poop'),false);
  assert.equal(entries.length,5);
  assert.deepEqual(customInteractions(policy,'alpha'),entries);
  assert.deepEqual(customInteractions(policy,'beta'),entries);
  assert.deepEqual(effectiveTheme(policy,'alpha'),theme);
  assert.equal(policy.customization?.find(scope=>scope.domainId==='alpha')?.interactions.length,0);
  assert.deepEqual(policy.emojis,[{id:'old-emoji',domainId:null,name:'Old emoji',asset,ts:1,addedBy:local.key}]);
  for(const key of [owner.key,admin.key])assert.equal(canManageServerCatalog(policy,key),true);
  for(const key of [local.key,member.key,null])assert.equal(canManageServerCatalog(policy,key),false);
  for(const actor of [local,member])for(const command of [
    {type:/** @type {const} */('putInteraction'),domainId:null,interaction:interaction('denied')},
    {type:/** @type {const} */('deleteEmoji'),domainId:null,emojiId:'old-emoji'},
  ])assert.throws(()=>append(migrated,actor,command),/owner or a server administrator/);
  assert.throws(()=>append(migrated,owner,{type:'putInteraction',domainId:'alpha',interaction:interaction('denied')}),/null domain/);
  assert.throws(()=>append(legacy,local,{type:'putInteraction',domainId:'alpha',interaction:interaction('denied')}),/owner or a server administrator/);
  migrated=append(migrated,admin,{type:'deleteEmoji',domainId:null,emojiId:'old-emoji'});
  migrated=append(migrated,admin,{type:'deleteInteraction',domainId:null,interactionId:'playful-fist-migrated-2'});
  migrated=append(migrated,owner,{type:'deleteDomain',domainId:'alpha'});
  assert.equal(governanceState(migrated).emojis?.length,0);
  assert.equal(customInteractions(governanceState(migrated),'beta').some(entry=>entry.name==='Local fist'),false);
  assert.throws(()=>append(migrated,owner,{type:'migrateServerCatalog'}),/already been migrated/);
  assert.deepEqual(parseGovernance(migrated,migrated),migrated);
});

test('full legacy migration keeps all 96 user entries and adds defaults only in spare capacity',()=>{
  const owner=identity();let legacy=createGovernance(descriptor(owner));
  for(const domainId of ['alpha','beta','gamma','delta'])for(let index=0;index<24;index++)legacy=appendLegacy(legacy,owner,{type:'putInteraction',domainId,interaction:interaction('item-'+index)});
  const migrated=append(legacy,owner,{type:'migrateServerCatalog'}),entries=customInteractions(governanceState(migrated),null);
  assert.equal(entries.length,96);assert.equal(new Set(entries.map(entry=>entry.id)).size,96);
  assert.equal(entries.some(entry=>entry.id==='default-bomb'),false);
  assert.throws(()=>append(migrated,owner,{type:'putInteraction',domainId:null,interaction:interaction('overflow')}),/interaction limit/);
});
