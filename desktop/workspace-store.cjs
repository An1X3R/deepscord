// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { generateKeyPairSync, createPrivateKey, createPublicKey, randomUUID, sign } = require('node:crypto');
const { parseRoomDocument, parseRoomDescriptor, roomVotePayload } = require('./app-server/lib/room-replica.cjs');
const { parseSteamInvite } = require('./steam-wire.cjs');
const { parseInvitation } = require('./direct-host.cjs');
const { parseGovernance, parseGovernanceCommand, createGovernanceVerifier, governanceRevision, governanceCheckpointPayload, isGovernanceExtension } = require('./app-server/lib/server-governance.cjs');
const { parseIdentityChallenge, identityPayload } = require('./app-server/lib/server-identity.cjs');
const {sealMessage}=require('./app-server/lib/content-crypto.cjs');
const {parseContentPolicy,contentPolicyPayload}=require('./app-server/public/js/content-protocol.js');

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../lib/room-replica.cjs').RoomDocument} RoomDocument */
/** @typedef {{mode:'steam'|'direct'|'server',role:'host'|'guest',address:string,invite:string,hostAddress:string,hostPort:number,appId:number,stunUrls:string[]}} Connection */
/** @typedef {import('../lib/server-governance.cjs').GovernanceJournal} GovernanceJournal */
/** @typedef {{id:string,roomId:string|null,creatorKey:string|null,name:string,updatedAt:number,connection:Connection,document:RoomDocument|null,conflicts:RoomDocument[],governance:GovernanceJournal|null}} Entry */
/** @typedef {{version:1,privateKey:string,entries:Entry[]}} Workspace */
/** @typedef {{roomId:string,creatorKey:string,document:RoomDocument|null,governance?:GovernanceJournal}} RoomSeed */
/** @typedef {{entry:Entry,mergedIds:string[]}} Binding */

/** @param {GovernanceJournal|null} previous @param {GovernanceJournal} next @returns {GovernanceJournal} */
function extendGovernance(previous,next) {
  if (previous && !isGovernanceExtension(previous,next)) throw new Error('Governance journal rollback or fork rejected');
  if (previous?.digest===next.digest && (previous.checkpoint?.revision??0)>(next.checkpoint?.revision??0))return previous;
  return next;
}

/** @param {JsonValue|undefined} value @returns {RoomDocument} */
function parseDocument(value) {
  if (value === undefined) throw new TypeError('Missing room document');
  return parseRoomDocument(value,parseRoomDescriptor(value));
}

/** @param {JsonValue|undefined} value @param {string} field @returns {{[key:string]:JsonValue}} */
function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value;
}
/** @param {JsonValue|undefined} value @param {string} field @param {number} maximum @returns {string} */
function text(value, field, maximum) {
  if (typeof value !== 'string' || value.length > maximum) throw new TypeError(`${field} must be text within ${maximum} characters`);
  return value;
}
/** @param {JsonValue|undefined} value @returns {string} */
function id(value) {
  const result = text(value, 'Workspace ID', 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(result)) throw new TypeError('Workspace ID must be a UUID');
  return result;
}
/** @param {JsonValue|undefined} value @returns {Connection} */
function parseConnection(value) {
  const row = object(value, 'Connection');
  if (row.mode !== 'steam' && row.mode !== 'direct' && row.mode !== 'server') throw new TypeError('Unsupported connection mode');
  if (row.role !== 'host' && row.role !== 'guest') throw new TypeError('Unsupported connection role');
  if (typeof row.hostPort !== 'number' || !Number.isInteger(row.hostPort) || row.hostPort < 0 || row.hostPort > 65535) throw new TypeError('Invalid saved host port');
  if (typeof row.appId !== 'number' || !Number.isInteger(row.appId) || row.appId < 0 || row.appId > 4294967295) throw new TypeError('Invalid saved Steam App ID');
  if (!Array.isArray(row.stunUrls) || row.stunUrls.length > 8) throw new TypeError('Invalid saved discovery addresses');
  /** @type {Connection} */
  const result={ mode:row.mode, role:row.role, address:text(row.address,'Address',2048), invite:text(row.invite,'Invitation',4096), hostAddress:text(row.hostAddress,'Host address',255), hostPort:row.hostPort, appId:row.appId, stunUrls:row.stunUrls.map(url => text(url,'Discovery address',2048)) };
  if(result.mode==='steam' && parseSteamInvite(result.invite).appId!==result.appId) throw new TypeError('Saved Steam invite has a different App ID');
  if(result.mode==='direct') parseInvitation(result.invite);
  if(result.mode==='server') {const url=new URL(result.address);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash) throw new TypeError('Saved server address must be HTTP(S) without credentials or fragments');}
  return result;
}
/** @param {JsonValue} value @returns {Workspace} */
function parseWorkspace(value) {
  const row = object(value, 'Workspace');
  if (row.version !== 1 || !Array.isArray(row.entries) || row.entries.length > 128) throw new TypeError('Invalid workspace version or entry count');
  const privateKey = text(row.privateKey, 'Workspace private key', 256);
  const key = createPrivateKey({key:Buffer.from(privateKey,'base64'),format:'der',type:'pkcs8'});
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Workspace identity must be Ed25519');
  const entries = row.entries.map(value => {
    const entry = object(value, 'Workspace entry');
    const entryId = id(entry.id);
    if (typeof entry.updatedAt !== 'number' || !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < 0) throw new TypeError('Invalid entry update time');
    if (!Array.isArray(entry.conflicts) || entry.conflicts.length > 24) throw new TypeError('Invalid stored conflict count');
    const document = entry.document === null ? null : parseDocument(entry.document);
    const roomId = entry.roomId === null ? null : id(entry.roomId);
    const creatorKey=entry.creatorKey===null ? null : text(entry.creatorKey,'Pinned creator identity',256);
    if((roomId===null)!==(creatorKey===null)) throw new TypeError('Room ID and creator identity must be pinned together');
    if(roomId && creatorKey) parseRoomDescriptor({version:1,roomId,creatorKey});
    if (document && document.roomId !== roomId) throw new TypeError('Stored room identity does not match its document');
    if(document && document.creatorKey!==creatorKey) throw new TypeError('Stored document differs from its pinned creator identity');
    const conflicts = entry.conflicts.map(parseDocument);
    if (conflicts.some(item => item.roomId !== roomId || item.creatorKey !== creatorKey)) throw new TypeError('Stored conflict belongs to another room');
    const governance = entry.governance === undefined || entry.governance === null ? null : parseGovernance(entry.governance,parseRoomDescriptor({version:1,roomId,creatorKey}));
    return {id:entryId,roomId,creatorKey,name:text(entry.name,'Room name',120),updatedAt:entry.updatedAt,connection:parseConnection(entry.connection),document,conflicts,governance};
  });
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new TypeError('Duplicate workspace entry ID');
  return {version:1,privateKey,entries};
}

/** @param {string} userData */
function createWorkspaceStore(userData) {
  const filename = path.join(userData, 'workspace.json');
  const verifier = createGovernanceVerifier({ maxEntries:16,maxBytes:16 * 1024 * 1024 });
  let persisted = '';
  /** @type {Workspace} */
  let state;
  if (fs.existsSync(filename)) { state = parseWorkspace(JSON.parse(fs.readFileSync(filename,'utf8'))); persisted = JSON.stringify(state); }
  else {
    const keys = generateKeyPairSync('ed25519');
    state = {version:1,privateKey:keys.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),entries:[]};
    write(state);
  }
  const privateKey = createPrivateKey({key:Buffer.from(state.privateKey,'base64'),format:'der',type:'pkcs8'});
  const memberKey = createPublicKey(privateKey).export({type:'spki',format:'der'}).toString('base64');
  /** @param {Workspace} next @returns {void} */
  function write(next) {
    const serialized = JSON.stringify(next);
    if (serialized === persisted) return;
    fs.mkdirSync(userData,{recursive:true});
    const temporary = filename + '.pending';
    fs.writeFileSync(temporary,serialized,{encoding:'utf8',mode:0o600});
    fs.renameSync(temporary,filename);
    state = next;
    persisted = serialized;
  }
  /** @param {string} entryId @returns {Entry} */
  function get(entryId) {
    const entry = state.entries.find(item => item.id === id(entryId));
    if (!entry) throw new Error('本地没有这条服务器记录，请刷新列表');
    return structuredClone(entry);
  }
  /** @param {Entry} entry @returns {void} */
  function put(entry) { write({...state,entries:state.entries.map(item => item.id === entry.id ? entry : item)}); }
  /** @param {Connection} connection @param {string|null} entryId @returns {string} */
  function saveConnection(connection, entryId) {
    const parsed = parseConnection(connection);
    if (entryId !== null) { const entry=get(entryId);if(JSON.stringify(entry.connection)!==JSON.stringify(parsed))put({...entry,connection:parsed,updatedAt:Date.now()});return entry.id; }
    const same = state.entries.find(item => item.connection.mode === parsed.mode && (parsed.mode === 'server' ? item.connection.address === parsed.address : item.connection.invite === parsed.invite));
    if (same) { if(JSON.stringify(same.connection)!==JSON.stringify(parsed))put({...same,connection:parsed,updatedAt:Date.now()});return same.id; }
    if (state.entries.length >= 128) throw new RangeError('本地服务器记录已达 128 条，请移除不用的记录后再连接');
    const entry = {id:randomUUID(),roomId:null,creatorKey:null,name:parsed.mode === 'steam' ? 'Steam 房间' : parsed.mode === 'direct' ? '直连房间' : parsed.address,updatedAt:Date.now(),connection:parsed,document:null,conflicts:[],governance:null};
    write({...state,entries:[...state.entries,entry]});
    return entry.id;
  }
  /** @param {string} entryId @param {RoomDocument} document @returns {Binding} */
  function prepareBinding(entryId, document) {
    const entry = get(entryId);
    if (entry.roomId && entry.roomId !== document.roomId) throw new Error('服务器的固定 ID 已变化；本地副本已保留，请移除旧连接记录后重新加入');
    if (entry.creatorKey && entry.creatorKey !== document.creatorKey) throw new Error('频道创建者身份与本地记录不符，拒绝覆盖副本');
    const matches=state.entries.filter(item => item.id !== entry.id && item.roomId === document.roomId).sort((a,b)=>b.updatedAt-a.updatedAt);
    const previous=matches.find(item=>item.document!==null) || matches[0];
    if (matches.some(item=>item.creatorKey !== document.creatorKey)) throw new Error('同一频道 ID 出现不同创建者，拒绝同步');
    const savedDocument=entry.document || previous?.document || null;
    const copies=[entry,...matches].flatMap(item=>item.document ? [item.document] : []);
    const conflicts=[...new Map([...entry.conflicts,...matches.flatMap(item=>item.conflicts),...(new Set(copies.map(copy=>copy.digest)).size>1 ? copies : [])].map(copy=>[copy.digest,copy])).values()];
    if(conflicts.length>24) throw new RangeError('合并连接记录会超过 24 份频道冲突副本，所有原记录已保留');
    let governance=entry.governance;
    for (const candidate of matches.flatMap(item=>item.governance ? [item.governance] : [])) {
      governance = governance && governanceRevision(governance) > governanceRevision(candidate) ? (extendGovernance(candidate,governance)) : extendGovernance(governance,candidate);
    }
    const next = {...entry,roomId:document.roomId,creatorKey:document.creatorKey,document:savedDocument,conflicts,governance};
    return { entry:next,mergedIds:matches.map(item=>item.id) };
  }
  /** @param {Binding} binding @returns {void} */
  function persistBinding(binding) {
    write({...state,entries:state.entries.filter(item=>!binding.mergedIds.includes(item.id)).map(item=>item.id===binding.entry.id ? binding.entry : item)});
  }
  /** @param {string} entryId @param {RoomDocument} document @returns {Entry} */
  function bind(entryId, document) {
    const binding=prepareBinding(entryId,document);
    persistBinding(binding);
    return binding.entry;
  }
  /** @param {string} entryId @param {JsonValue} value */
  function vote(entryId,value) {
    const offer=object(value,'Room synchronization offer');
    const roundId=text(offer.roundId,'Round ID',128);
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(roundId)) throw new TypeError('Invalid synchronization round');
    const offered=parseDocument(offer.document);
    const entry=bind(entryId,offered);
    const document=entry.document || offered;
    const fresh=entry.document === null;
    const payload=roomVotePayload(roundId,memberKey,document,fresh);
    return {t:'roomSyncVote',roundId,memberKey,document,signature:sign(null,Buffer.from(payload,'utf8'),privateKey).toString('base64'),fresh};
  }
  /** @param {string} entryId @param {JsonValue} value @returns {void} */
  function commit(entryId,value) {
    const document=parseDocument(value);
    const binding=prepareBinding(entryId,document),entry=binding.entry;
    const name=entry.governance ? verifier.state(entry.governance).name : document.servers[0]?.name || '频道';
    const unchanged=JSON.stringify(entry.document)===JSON.stringify(document) && entry.name===name;
    persistBinding({...binding,entry:{...entry,document,name,updatedAt:unchanged ? entry.updatedAt : Date.now()}});
  }
  /** @param {string} entryId @param {JsonValue} value @returns {void} */
  function preserveConflict(entryId,value) {
    if (!Array.isArray(value) || value.length > 24) throw new TypeError('Invalid conflict candidate list');
    const candidates=value.map(parseDocument);
    const entry=get(entryId);
    if(candidates.some(document=>document.roomId!==entry.roomId || document.creatorKey!==entry.creatorKey)) throw new Error('频道冲突候选的创建者或固定 ID 与当前连接不一致');
    for (const document of candidates) bind(entryId,document);
    const documents=[...entry.conflicts,...(entry.document ? [entry.document] : []),...candidates];
    const conflicts=[...new Map(documents.map(document => [document.digest,document])).values()];
    if (conflicts.length > 24) throw new RangeError('频道冲突副本超过 24 份，请先处理现有冲突');
    put({...get(entryId),conflicts});
  }
  /** @param {string|null} entryId @returns {RoomSeed} */
  function seed(entryId) {
    if (entryId === null) return {roomId:randomUUID(),creatorKey:memberKey,document:null};
    const entry=get(entryId);
    if (!entry.document) throw new Error('此记录还没有完整频道副本，不能重新开房');
    return {roomId:entry.document.roomId,creatorKey:entry.document.creatorKey,document:entry.document,...(entry.governance ? {governance:entry.governance} : {})};
  }
  /** @param {string} entryId @param {JsonValue} value */
  function signServerIdentity(entryId,value) {
    const challenge=parseIdentityChallenge(value);
    let entry=get(entryId);
    if ((entry.roomId && entry.roomId!==challenge.roomId) || (entry.creatorKey && entry.creatorKey!==challenge.creatorKey)) throw new Error('Server identity challenge differs from the pinned room identity');
    if (!entry.roomId) { entry={...entry,roomId:challenge.roomId,creatorKey:challenge.creatorKey};put(entry); }
    return {t:'identityProof',nonce:challenge.nonce,memberKey,signature:sign(null,Buffer.from(identityPayload(challenge),'utf8'),privateKey).toString('base64'),...(entry.governance ? {governance:entry.governance} : {})};
  }
  /** @param {string} entryId @param {JsonValue} value @returns {void} */
  function saveServerGovernance(entryId,value) {
    const entry=get(entryId);
    if (!entry.roomId || !entry.creatorKey) throw new Error('Server identity must be pinned before saving governance');
    const verified=verifier.verify(value,{version:1,roomId:entry.roomId,creatorKey:entry.creatorKey});
    const governance=extendGovernance(entry.governance,verified.journal);
    if(entry.governance?.digest===governance.digest && entry.name===verified.policy.name && entry.governance.checkpoint?.revision===governance.checkpoint?.revision)return;
    put({...entry,governance,name:verified.policy.name,updatedAt:Date.now()});
  }
  /** @param {string} entryId @param {JsonValue} value */
  function signGovernanceChange(entryId,value) {
    const input=object(value,'Governance change');
    const entry=get(entryId);
    if (!entry.roomId || !entry.creatorKey || !entry.governance) throw new Error('No validated governance journal has been saved for this server');
    if (input.journal===undefined || input.command===undefined) throw new TypeError('Governance change requires journal and command');
    const journal=verifier.verify(input.journal,{version:1,roomId:entry.roomId,creatorKey:entry.creatorKey}).journal;
    if (journal.digest!==entry.governance.digest) throw new Error('Governance journal changed; refresh before signing');
    const command=parseGovernanceCommand(input.command);
    const event={revision:governanceRevision(journal)+1,previousDigest:journal.digest,actorKey:memberKey,command,signature:sign(null,Buffer.from(verifier.payload(journal,memberKey,command),'utf8'),privateKey).toString('base64')};
    verifier.append(journal,event);
    return {t:'governanceChange',event};
  }
  /** @param {string} entryId @returns {{t:string,checkpointSignature:string,expectedDigest:string}} */
  function signGovernanceCheckpoint(entryId){
    const entry=get(entryId),journal=entry.governance;
    if(!journal || verifier.state(journal).ownerKey!==memberKey)throw new Error('只有当前服主可以签署权限快照');
    return {t:'governanceChange',expectedDigest:journal.digest,checkpointSignature:sign(null,Buffer.from(governanceCheckpointPayload(journal)),privateKey).toString('base64')};
  }
  /** @param {string} entryId @param {JsonValue} descriptorInput @param {JsonValue} journal @returns {Entry} */
  function bindContentRoom(entryId,descriptorInput,journal){
    const descriptor=parseRoomDescriptor(descriptorInput),entry=get(entryId);
    if(entry.roomId && (entry.roomId!==descriptor.roomId||entry.creatorKey!==descriptor.creatorKey))throw new Error('加密房间与本地固定身份不一致');
    verifier.verify(journal,descriptor);
    if(!entry.roomId)put({...entry,roomId:descriptor.roomId,creatorKey:descriptor.creatorKey});
    saveServerGovernance(entryId,journal);
    return get(entryId);
  }
  /** @param {string} entryId @param {{channelId:string,requestId:string}} context @param {{keyId:string,key:Buffer,nonce:Buffer}} material @param {JsonValue} value */
  function sealContent(entryId,context,material,value){const entry=get(entryId);if(!entry.roomId||!entry.governance)throw new Error('加密前必须验证房间身份');return sealMessage({...material,context:{...context,roomId:entry.roomId},memberKey,sign:bytes=>sign(null,bytes,privateKey)},value);}
  /** @param {string} entryId @param {{keyId:string,keyHash:string,assets:import('../public/js/content-protocol.js').ContentAsset[]}} input */
  function signContentPolicy(entryId,input){const entry=get(entryId);if(!entry.roomId||!entry.governance||verifier.state(entry.governance).ownerKey!==memberKey)throw new Error('只有服主可以签署房间加密迁移');const policy={version:/** @type {const} */(1),roomId:entry.roomId,keyId:input.keyId,keyHash:input.keyHash,ownerKey:memberKey,governanceRevision:governanceRevision(entry.governance),assets:input.assets};return parseContentPolicy({...policy,signature:sign(null,Buffer.from(contentPolicyPayload(policy)),privateKey).toString('base64url')});}
  /** @param {string} entryId @returns {void} */
  function remove(entryId) { get(entryId);write({...state,entries:state.entries.filter(entry => entry.id !== entryId)}); }
  function list() { return state.entries.map(entry => ({id:entry.id,roomId:entry.roomId,name:entry.name,mode:entry.connection.mode,role:entry.connection.role,updatedAt:entry.updatedAt,servers:entry.document?.servers || [],conflicts:entry.conflicts.length})); }
  return {get,list,remove,seed,vote,commit,preserveConflict,saveConnection,signServerIdentity,saveServerGovernance,signGovernanceChange,signGovernanceCheckpoint,bindContentRoom,sealContent,signContentPolicy};
}

module.exports={createWorkspaceStore,parseWorkspace};
