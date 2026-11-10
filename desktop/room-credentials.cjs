// @ts-check
'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {connectionOrigin}=require('./server-trust.cjs');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {Pick<import('electron').SafeStorage,'isAsyncEncryptionAvailable'|'encryptStringAsync'|'decryptStringAsync'>} Protection */
/** @typedef {{origin:string,password:string}} Credential */
/** @param {string} input @returns {string} */
function origin(input){if(typeof input!=='string'||input.length>2048||connectionOrigin(input)!==input||new URL(input).href!==input+'/')throw new TypeError('Room credentials require an exact HTTPS origin or loopback HTTP origin');return input;}
/** @param {string} input @returns {string} */
function password(input){if(typeof input!=='string'||input.length>256)throw new TypeError('Room access password must contain at most 256 characters');return input;}
/** @param {JsonValue} input @returns {Credential[]} */
function parse(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||input.version!==1||!Array.isArray(input.rooms)||input.rooms.length>128)throw new TypeError('Room credentials require version 1 and at most 128 rooms');
  const rooms=input.rooms.map(value=>{if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.origin!=='string'||typeof value.password!=='string')throw new TypeError('Saved room credentials require an origin and password');return {origin:origin(value.origin),password:password(value.password)};});
  if(new Set(rooms.map(room=>room.origin)).size!==rooms.length)throw new TypeError('Saved room credentials contain duplicate origins');
  return rooms;
}
/** @param {{directory:string,protection:Protection}} options */
async function openRoomCredentials(options){
  if(!await options.protection.isAsyncEncryptionAvailable())throw new Error('Windows 安全存储不可用，无法保存房间访问口令');
  const filename=path.join(options.directory,'room-credentials.dpapi');
  /** @type {Credential[]} */let rooms=[];
  /** @type {Promise<void>} */let queue=Promise.resolve();
  /** @param {Credential[]} next @returns {Promise<void>} */
  async function persist(next){
    const protectedBytes=await options.protection.encryptStringAsync(JSON.stringify({version:1,rooms:next}));
    if(protectedBytes.length>256*1024)throw new RangeError('Encrypted room credentials exceed their 256 KiB storage budget');
    await fs.mkdir(options.directory,{recursive:true});
    const temporary=filename+'.'+randomUUID()+'.tmp',file=await fs.open(temporary,'wx',0o600);
    try{try{await file.writeFile(protectedBytes);await file.sync();}finally{await file.close();}await fs.rename(temporary,filename);rooms=next;}
    catch(error){await fs.rm(temporary,{force:true});throw error;}
  }
  try{
    const stat=await fs.lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024)throw new RangeError('Room credential storage must be a regular file of at most 256 KiB');
    const result=await options.protection.decryptStringAsync(await fs.readFile(filename));
    rooms=parse(/** @type {JsonValue} */(JSON.parse(result.result)));
    if(result.shouldReEncrypt)await persist(rooms);
  }catch(error){if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT')throw error;}
  /** @param {string} address @returns {string|null} */
  function read(address){const bound=origin(address);return rooms.find(room=>room.origin===bound)?.password??null;}
  /** @param {string} address @param {string} secret @returns {Promise<void>} */
  function save(address,secret){
    const bound=origin(address),validated=password(secret);
    const operation=queue.then(async()=>{
      const next=[...rooms.filter(room=>room.origin!==bound),...(validated?[{origin:bound,password:validated}]:[])];
      if(next.length>128)throw new RangeError('This device already has access passwords for 128 rooms');
      await persist(next);
    });
    queue=operation.then(()=>{},()=>{});
    return operation;
  }
  return {read,save};
}
module.exports={openRoomCredentials};
