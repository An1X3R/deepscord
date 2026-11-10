// @ts-check
import {mediaObject,mediaHash,mediaId,mediaInteger,parseMediaMetadata} from './chat-protocol.js';
/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {{version:1,keyId:string,nonce:string,data:string,memberKey:string,signature:string}} SealedMessage */
/** @typedef {{source:string,asset:import('./chat-protocol.js').MediaMetadata}} ContentAsset */
/** @typedef {{version:1,roomId:string,keyId:string,keyHash:string,ownerKey:string,governanceRevision:number,assets:ContentAsset[],signature:string}} ContentPolicy */
/** @param {JsonValue|undefined} value @param {string} label @param {number} maximum @returns {string} */
function encoded(value,label,maximum){if(typeof value!=='string'||!value.length||value.length>maximum||!/^[A-Za-z0-9_-]+$/.test(value))throw new TypeError(label+' requires bounded base64url');return value;}
/** @param {JsonValue|undefined} value @returns {string} */
export function contentKeyId(value){if(typeof value!=='string'||!/^[a-f0-9]{32}$/.test(value))throw new TypeError('Content key ID must contain 16 bytes');return value;}
/** @param {JsonValue|undefined} value @returns {string} */
export function contentIdentity(value){if(typeof value!=='string'||!/^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/.test(value))throw new TypeError('Content signer must be an Ed25519 public identity');return value;}
/** @param {JsonValue} value @returns {SealedMessage} */
export function parseContentMessage(value){const row=mediaObject(value,'Encrypted message');if(row.version!==1)throw new TypeError('Unsupported encrypted message version');const nonce=encoded(row.nonce,'Content nonce',16),signature=encoded(row.signature,'Content signature',86);if(nonce.length!==16||signature.length!==86)throw new TypeError('Encrypted message nonce or signature has an invalid length');return {version:1,keyId:contentKeyId(row.keyId),nonce,data:encoded(row.data,'Encrypted message',699072),memberKey:contentIdentity(row.memberKey),signature};}
/** @param {JsonValue} value @returns {ContentPolicy} */
export function parseContentPolicy(value){const row=mediaObject(value,'Room encryption');if(row.version!==1||typeof row.roomId!=='string'||!/^[-a-f0-9]{36}$/.test(row.roomId))throw new TypeError('Room encryption requires a supported version and room ID');if(!Array.isArray(row.assets)||row.assets.length>4096)throw new RangeError('Encrypted history mapping permits at most 4096 files');const seen=new Set();const assets=row.assets.map(input=>{const item=mediaObject(input,'Encrypted history asset'),source=mediaHash(item.source);if(seen.has(source)||item.asset===undefined)throw new TypeError('Encrypted history assets must be unique and complete');seen.add(source);const asset=parseMediaMetadata(item.asset);if(asset.encrypted!==true)throw new TypeError('History asset migration requires encrypted media');return {source,asset};}).sort((a,b)=>a.source.localeCompare(b.source));const signature=encoded(row.signature,'Room encryption signature',86);if(signature.length!==86)throw new TypeError('Room encryption signature must contain 64 bytes');return {version:1,roomId:row.roomId,keyId:contentKeyId(row.keyId),keyHash:mediaHash(row.keyHash),ownerKey:contentIdentity(row.ownerKey),governanceRevision:mediaInteger(row.governanceRevision,'Encryption governance revision',0,Number.MAX_SAFE_INTEGER),assets,signature};}
/** @param {Omit<ContentPolicy,'signature'>} policy @returns {string} */
export function contentPolicyPayload(policy){const parsed=parseContentPolicy({...policy,signature:'A'.repeat(86)});return JSON.stringify(['deepscord-content-policy-v1',{version:parsed.version,roomId:parsed.roomId,keyId:parsed.keyId,keyHash:parsed.keyHash,ownerKey:parsed.ownerKey,governanceRevision:parsed.governanceRevision,assets:parsed.assets}]);}
/** @param {ContentPolicy|null} policy @param {import('./chat-protocol.js').MediaMetadata} asset @returns {import('./chat-protocol.js').MediaMetadata} */
export function mapContentAsset(policy,asset){return policy?.assets.find(item=>item.source===asset.sha256)?.asset ?? asset;}
/** @param {JsonValue} value @returns {{channelId:string,requestId:string}} */
export function parseContentContext(value){const row=mediaObject(value,'Content context');return {channelId:mediaId(row.channelId,'Content channel'),requestId:mediaId(row.requestId,'Content request')};}
