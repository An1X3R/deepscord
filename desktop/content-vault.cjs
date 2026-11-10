// @ts-check
'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {generateContentKey,contentDigest}=require('./app-server/lib/content-crypto.cjs');
const {parseRoomDescriptor}=require('./app-server/lib/room-replica.cjs');
const {contentKeyId,parseContentPolicy}=require('./app-server/public/js/content-protocol.js');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../public/js/content-protocol.js').ContentPolicy} ContentPolicy */
/** @typedef {{roomId:string,keyId:string,keyHash:string,digest:string}} PinnedPolicy */
/** @typedef {import('../lib/room-replica.cjs').RoomDescriptor} Descriptor */
/** @typedef {{roomId:string,creatorKey:string,keyId:string,key:string,prefix:string,reserved:number,policy:PinnedPolicy|null}} Record */
/** @typedef {{version:1,rooms:Record[]}} Vault */
/** @typedef {Pick<import('electron').SafeStorage,'isAsyncEncryptionAvailable'|'encryptStringAsync'|'decryptStringAsync'>} Protection */
/** @param {JsonValue|undefined} value @returns {{[key:string]:JsonValue}} */
function object(value){if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Room key record must be an object');return value;}
/** @param {JsonValue|undefined} value @param {number} length @returns {string} */
function bytes(value,length){if(typeof value!=='string'||!value.length||value.length>256)throw new TypeError('Room key encoding is invalid');const data=Buffer.from(value,'base64url');if(data.length!==length||data.toString('base64url')!==value)throw new TypeError('Room key has an invalid byte length');return value;}
/** @param {JsonValue|undefined} value @returns {string} */
function hash(value){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new TypeError('Pinned content policy requires canonical SHA256 hashes');return value;}
/** @param {JsonValue|undefined} value @returns {PinnedPolicy} */
function parsePinnedPolicy(value){const row=object(value);if(typeof row.roomId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.roomId))throw new TypeError('Pinned content policy requires a canonical room UUID');return {roomId:row.roomId,keyId:contentKeyId(row.keyId),keyHash:hash(row.keyHash),digest:hash(row.digest)};}
/** @param {ContentPolicy} input @returns {PinnedPolicy} */
function pinPolicy(input){const policy=parseContentPolicy(input);return {roomId:policy.roomId,keyId:policy.keyId,keyHash:policy.keyHash,digest:contentDigest(Buffer.from(JSON.stringify(policy)))};}
/** @param {JsonValue} value @returns {Record} */
function parseRecord(value){const row=object(value),descriptor=parseRoomDescriptor({version:1,roomId:row.roomId,creatorKey:row.creatorKey});if(typeof row.reserved!=='number'||!Number.isSafeInteger(row.reserved)||row.reserved<0||row.reserved>4294967296)throw new RangeError('Content nonce reservation is invalid');const policy=row.policy===null?null:parsePinnedPolicy(row.policy);const result={roomId:descriptor.roomId,creatorKey:descriptor.creatorKey,keyId:contentKeyId(row.keyId),key:bytes(row.key,32),prefix:bytes(row.prefix,8),reserved:row.reserved,policy};if(policy&&(policy.roomId!==result.roomId||policy.keyId!==result.keyId||policy.keyHash!==contentDigest(Buffer.from(result.key,'base64url'))))throw new TypeError('Saved encryption policy differs from its room key');return result;}
/** @param {JsonValue} value @returns {Vault} */
function parseVault(value){const row=object(value);if(row.version!==1||!Array.isArray(row.rooms)||row.rooms.length>128)throw new TypeError('Unsupported room key vault or room count');const rooms=row.rooms.map(parseRecord);if(new Set(rooms.map(room=>room.roomId)).size!==rooms.length)throw new TypeError('Room key vault contains duplicate room identities');return{version:1,rooms};}
/** @param {Record} record @returns {{roomId:string,creatorKey:string,keyId:string,keyHash:string}} */
function describe(record){return{roomId:record.roomId,creatorKey:record.creatorKey,keyId:record.keyId,keyHash:contentDigest(Buffer.from(record.key,'base64url'))};}
/** @param {{directory:string,protection:Protection}} options */
async function openContentVault(options){
  if(!await options.protection.isAsyncEncryptionAvailable())throw new Error('Windows 安全存储不可用，无法保存房间密钥；加密房间未启用');
  const filename=path.join(options.directory,'content-keys.dpapi');
  /** @type {Vault} */let state={version:1,rooms:[]};
  /** @type {Map<string,{next:number,end:number}>} */const reservations=new Map();
  /** @type {Promise<void>} */let pending=Promise.resolve();
  /** @param {Vault} next @returns {Promise<void>} */
  async function persist(next){const serialized=JSON.stringify(next);if(Buffer.byteLength(serialized)>1024*1024)throw new RangeError('Serialized room key vault exceeds its 1 MiB size budget');const protectedBytes=await options.protection.encryptStringAsync(serialized);if(protectedBytes.length>1024*1024)throw new RangeError('Protected room key vault exceeds its 1 MiB size budget');await fs.mkdir(options.directory,{recursive:true});const temporary=filename+'.pending';const file=await fs.open(temporary,'w',0o600);try{await file.writeFile(protectedBytes);await file.sync();}finally{await file.close();}await fs.rename(temporary,filename);state=next;}
  try{const stored=await fs.readFile(filename);if(stored.length>1024*1024)throw new RangeError('Room key vault exceeds its 1 MiB size budget');const decoded=await options.protection.decryptStringAsync(stored);if(Buffer.byteLength(decoded.result)>1024*1024)throw new RangeError('Decoded room key vault exceeds its 1 MiB size budget');state=parseVault(JSON.parse(decoded.result));if(decoded.shouldReEncrypt)await persist(state);}
  catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT')throw error;}
  /** @template T @param {()=>Promise<T>} operation @returns {Promise<T>} */
  function serialize(operation){const result=pending.then(operation);pending=result.then(()=>{},()=>{});return result;}
  /** @param {Descriptor} input @returns {Record|null} */
  function find(input){const descriptor=parseRoomDescriptor(input),record=state.rooms.find(row=>row.roomId===descriptor.roomId)??null;if(record&&record.creatorKey!==descriptor.creatorKey)throw new Error('房间创建者与已保存密钥不一致，拒绝使用旧密钥');return record;}
  /** @param {Descriptor} descriptor @returns {Record} */
  function requireRecord(descriptor){const record=find(descriptor);if(!record)throw new Error('此设备没有房间密钥，请使用包含加密密钥的新邀请加入');return record;}
  /** @param {Record} next @returns {Promise<void>} */
  async function put(next){if(!state.rooms.some(room=>room.roomId===next.roomId)&&state.rooms.length>=128)throw new RangeError('本机已保存 128 个房间密钥');await persist({...state,rooms:[...state.rooms.filter(room=>room.roomId!==next.roomId),next]});}
  /** @param {Descriptor} descriptor */
  function prepare(descriptor){return serialize(async()=>{const previous=find(descriptor);if(previous)return describe(previous);const generated=generateContentKey(),record={roomId:descriptor.roomId,creatorKey:descriptor.creatorKey,keyId:generated.id,key:generated.key.toString('base64url'),prefix:randomBytes(8).toString('base64url'),reserved:0,policy:null};generated.key.fill(0);await put(record);return describe(record);});}
  /** @param {string} token */
  function importSecret(token){return serialize(async()=>{if(typeof token!=='string'||token.length>1024||!/^[A-Za-z0-9_-]+$/.test(token))throw new TypeError('加密邀请中的密钥格式不正确');const raw=Buffer.from(token,'base64url');if(raw.toString('base64url')!==token)throw new TypeError('加密邀请编码不正确');const row=object(JSON.parse(raw.toString('utf8')));if(row.version!==1)throw new TypeError('加密邀请版本不受支持');const descriptor=parseRoomDescriptor({version:1,roomId:row.roomId,creatorKey:row.creatorKey}),keyId=contentKeyId(row.keyId),key=bytes(row.key,32),previous=find(descriptor);if(previous){if(previous.keyId!==keyId||previous.key!==key)throw new Error('邀请密钥与本机保存的房间密钥不同，原密钥已保留');return describe(previous);}const record={roomId:descriptor.roomId,creatorKey:descriptor.creatorKey,keyId,key,prefix:randomBytes(8).toString('base64url'),reserved:0,policy:null};await put(record);return describe(record);});}
  /** @param {Descriptor} descriptor @param {ContentPolicy|null} policy */
  function activate(descriptor,policy){return serialize(async()=>{const record=find(descriptor);if(!policy){if(record?.policy)throw new Error('此房间已启用端到端加密，但服务器返回了明文状态；连接已停止');return null;}const current=requireRecord(descriptor),pinned=pinPolicy(policy);if(pinned.roomId!==descriptor.roomId||pinned.keyId!==current.keyId||pinned.keyHash!==describe(current).keyHash)throw new Error('服务器的加密配置与邀请密钥不一致');if(current.policy&&current.policy.digest!==pinned.digest)throw new Error('服务器更改了已固定的房间加密配置');if(!current.policy)await put({...current,policy:pinned});return {keyId:current.keyId,key:new Uint8Array(Buffer.from(current.key,'base64url'))};});}
  /** @param {Descriptor} descriptor @returns {Promise<{keyId:string,key:Buffer,nonce:Buffer}>} */
  function allocate(descriptor){return serialize(async()=>{let record=requireRecord(descriptor);let reservation=reservations.get(record.roomId);if(!reservation||reservation.next===reservation.end){if(record.reserved>=4294967296)throw new RangeError('房间密钥的加密次数已达上限，必须换发密钥后才能继续');reservation={next:record.reserved,end:Math.min(4294967296,record.reserved+1024)};record={...record,reserved:reservation.end};await put(record);reservations.set(record.roomId,reservation);}const nonce=Buffer.alloc(12);Buffer.from(record.prefix,'base64url').copy(nonce);nonce.writeUInt32BE(reservation.next,8);reservation.next++;return{keyId:record.keyId,key:Buffer.from(record.key,'base64url'),nonce};});}
  /** @param {Descriptor} descriptor @param {string} keyId @returns {Buffer} */
  function readKey(descriptor,keyId){const record=requireRecord(descriptor);if(record.keyId!==contentKeyId(keyId))throw new Error('消息使用了本机没有保存的房间密钥');return Buffer.from(record.key,'base64url');}
  /** @param {Descriptor} descriptor @returns {string|null} */
  function exportSecret(descriptor){const record=find(descriptor);if(!record?.policy)return null;return Buffer.from(JSON.stringify({version:1,roomId:record.roomId,creatorKey:record.creatorKey,keyId:record.keyId,key:record.key})).toString('base64url');}
  /** @param {Descriptor} descriptor @returns {PinnedPolicy|null} */
  function policy(descriptor){return structuredClone(find(descriptor)?.policy??null);}
  return{prepare,importSecret,activate,allocate,readKey,exportSecret,policy};
}
module.exports={openContentVault};
