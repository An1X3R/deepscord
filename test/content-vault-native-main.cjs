// @ts-check
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createCipheriv,createDecipheriv,createHash,generateKeyPairSync,randomUUID,sign,verify}=require('node:crypto');
const {app}=require('electron');
const protection=require('../desktop/windows-protection.cjs');
const {openContentVault}=require('../desktop/content-vault.cjs');
const {contentPolicyPayload,parseContentPolicy}=require('../public/js/content-protocol.js');
const {mediaObject,mediaHash,mediaInteger}=require('../public/js/chat-protocol.js');
const {parseRoomDescriptor}=require('../lib/room-replica.cjs');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../lib/room-replica.cjs').RoomDescriptor} Descriptor */
/** @typedef {import('../public/js/content-protocol.js').ContentPolicy} ContentPolicy */
/** @typedef {{descriptor:Descriptor,policy:ContentPolicy,nonces:string[],cloneNonces:string[],ciphertext:string,tag:string,keyHash:string,generation:number}} Evidence */

/** @param {Buffer|Uint8Array} bytes @returns {string} */
function digest(bytes){return createHash('sha256').update(bytes).digest('hex');}
/** @param {JsonValue|undefined} value @param {number} maximum @returns {string} */
function encoded(value,maximum){if(typeof value!=='string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length>maximum || Buffer.from(value,'base64url').toString('base64url')!==value)throw new TypeError('Native evidence requires bounded canonical base64url');return value;}
/** @param {JsonValue|undefined} value @returns {string[]} */
function nonces(value){if(!Array.isArray(value) || value.length<1 || value.length>4)throw new TypeError('Native evidence requires 1..4 nonces');return value.map(input=>{const nonce=encoded(input,16);assert.equal(Buffer.from(nonce,'base64url').length,12);return nonce;});}
/** @param {JsonValue} value @returns {Evidence} */
function parseEvidence(value){
  const row=mediaObject(value,'Native vault evidence');
  if(row.descriptor===undefined || row.policy===undefined)throw new TypeError('Native evidence requires its public room descriptor and policy');
  return {descriptor:parseRoomDescriptor(row.descriptor),policy:parseContentPolicy(row.policy),nonces:nonces(row.nonces),cloneNonces:nonces(row.cloneNonces),ciphertext:encoded(row.ciphertext,1024),tag:encoded(row.tag,22),keyHash:mediaHash(row.keyHash),generation:mediaInteger(row.generation,'Native evidence generation',1,3)};
}
/** @param {string} directory @param {Buffer} secret @returns {Promise<void>} */
async function protectedDisk(directory,secret){
  const data=await fs.readFile(path.join(directory,'content-keys.dpapi'));
  assert(data.length>secret.length);
  for(const encoding of [secret,Buffer.from(secret.toString('base64url')),Buffer.from(secret.toString('base64')),Buffer.from(secret.toString('hex'))])assert.equal(data.includes(encoding),false,'The persisted DPAPI bytes must conceal the room key');
  assert.deepEqual((await fs.readdir(directory)).sort(),['content-keys.dpapi']);
}
/** @param {Buffer} key @param {Buffer} nonce @param {Buffer} ciphertext @param {Buffer} tag @returns {Buffer} */
function decrypt(key,nonce,ciphertext,tag){const decipher=createDecipheriv('aes-256-gcm',key,nonce);decipher.setAuthTag(tag);return Buffer.concat([decipher.update(ciphertext),decipher.final()]);}
/** @returns {Promise<void>} */
async function main(){
  const directory=process.env.CONTENT_VAULT_TEST_DIRECTORY,generationText=process.env.CONTENT_VAULT_TEST_GENERATION;
  if(!directory || !path.isAbsolute(directory) || !generationText || !/^[123]$/.test(generationText))throw new TypeError('Native vault test requires an explicit isolated directory and generation 1..3');
  const generation=Number(generationText),filename=path.join(directory,'evidence.json'),aDirectory=path.join(directory,'vault-a'),bDirectory=path.join(directory,'vault-b');
  app.setPath('userData',path.join(directory,'electron-profile'));app.commandLine.appendSwitch('disable-background-networking');
  await app.whenReady();
  assert.equal(process.platform,'win32');assert.equal(await protection.isAsyncEncryptionAvailable(),true);
  const a=await openContentVault({directory:aDirectory,protection});
  const b=await openContentVault({directory:bDirectory,protection});
  const plaintext=Buffer.from('Native DPAPI vault round trip across process generations');
  /** @type {Evidence} */let evidence;
  if(generation===1){
    const identity=generateKeyPairSync('ed25519');
    /** @type {Descriptor} */const descriptor={version:1,roomId:randomUUID(),creatorKey:identity.publicKey.export({format:'der',type:'spki'}).toString('base64')};
    const prepared=await a.prepare(descriptor);assert.equal(a.exportSecret(descriptor),null);
    const [first,second]=await Promise.all([a.allocate(descriptor),a.allocate(descriptor)]);
    assert.equal(first.nonce.readUInt32BE(8),0);assert.equal(second.nonce.readUInt32BE(8),1);assert.equal(first.nonce.equals(second.nonce),false);
    assert.equal(digest(first.key),prepared.keyHash);
    /** @type {Omit<ContentPolicy,'signature'>} */const unsigned={version:1,roomId:descriptor.roomId,keyId:prepared.keyId,keyHash:prepared.keyHash,ownerKey:descriptor.creatorKey,governanceRevision:0,assets:[]};
    const payload=Buffer.from(contentPolicyPayload(unsigned)),signature=sign(null,payload,identity.privateKey);
    assert.equal(verify(null,payload,identity.publicKey,signature),true);
    const policy=parseContentPolicy({...unsigned,signature:signature.toString('base64url')});
    const activated=await a.activate(descriptor,policy);assert(activated);assert.equal(digest(activated.key),prepared.keyHash);
    const invitation=a.exportSecret(descriptor);assert.equal(typeof invitation,'string');if(typeof invitation!=='string')throw new TypeError('Activated vault must export an encryption invitation');
    assert.deepEqual(await b.importSecret(invitation),prepared);assert.equal(b.exportSecret(descriptor),null);
    const cloneActivation=await b.activate(descriptor,policy);assert(cloneActivation);assert.equal(digest(cloneActivation.key),prepared.keyHash);
    const clone=await b.allocate(descriptor);assert.equal(clone.nonce.subarray(0,8).equals(first.nonce.subarray(0,8)),false);
    const cipher=createCipheriv('aes-256-gcm',first.key,first.nonce),ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]),tag=cipher.getAuthTag();
    assert.deepEqual(decrypt(b.readKey(descriptor,prepared.keyId),first.nonce,ciphertext,tag),plaintext);
    await protectedDisk(aDirectory,first.key);await protectedDisk(bDirectory,first.key);
    evidence={descriptor,policy,nonces:[first.nonce.toString('base64url'),second.nonce.toString('base64url')],cloneNonces:[clone.nonce.toString('base64url')],ciphertext:ciphertext.toString('base64url'),tag:tag.toString('base64url'),keyHash:prepared.keyHash,generation};
    first.key.fill(0);second.key.fill(0);clone.key.fill(0);activated.key.fill(0);cloneActivation.key.fill(0);
  }else{
    evidence=parseEvidence(JSON.parse(await fs.readFile(filename,'utf8')));
    assert.equal(evidence.generation,generation-1);
    const descriptor=evidence.descriptor,prepared=await a.prepare(descriptor),cloned=await b.prepare(descriptor);
    assert.equal(prepared.keyHash,evidence.keyHash);assert.deepEqual(cloned,prepared);
    const expectedPin={roomId:evidence.policy.roomId,keyId:evidence.policy.keyId,keyHash:evidence.policy.keyHash,digest:digest(Buffer.from(JSON.stringify(evidence.policy)))};
    assert.deepEqual(a.policy(descriptor),expectedPin);assert.deepEqual(b.policy(descriptor),expectedPin);
    const activated=await a.activate(descriptor,evidence.policy),cloneActivation=await b.activate(descriptor,evidence.policy);assert(activated);assert(cloneActivation);
    const first=await a.allocate(descriptor),clone=await b.allocate(descriptor);
    assert.equal(first.nonce.readUInt32BE(8),(generation-1)*1024);assert.equal(clone.nonce.readUInt32BE(8),(generation-1)*1024);
    assert.equal(evidence.nonces.includes(first.nonce.toString('base64url')),false);assert.equal(evidence.cloneNonces.includes(clone.nonce.toString('base64url')),false);
    assert.deepEqual(first.nonce.subarray(0,8),Buffer.from(evidence.nonces[0],'base64url').subarray(0,8));
    assert.deepEqual(clone.nonce.subarray(0,8),Buffer.from(evidence.cloneNonces[0],'base64url').subarray(0,8));
    assert.deepEqual(decrypt(clone.key,Buffer.from(evidence.nonces[0],'base64url'),Buffer.from(evidence.ciphertext,'base64url'),Buffer.from(evidence.tag,'base64url')),plaintext);
    assert.equal(typeof a.exportSecret(descriptor),'string');assert.equal(typeof b.exportSecret(descriptor),'string');
    await protectedDisk(aDirectory,first.key);await protectedDisk(bDirectory,clone.key);
    evidence={...evidence,nonces:[...evidence.nonces,first.nonce.toString('base64url')],cloneNonces:[...evidence.cloneNonces,clone.nonce.toString('base64url')],generation};
    first.key.fill(0);clone.key.fill(0);activated.key.fill(0);cloneActivation.key.fill(0);
  }
  await fs.writeFile(filename,JSON.stringify(evidence),{flag:'w',mode:0o600});
  await fs.writeFile(path.join(directory,'generation-'+generation+'.json'),JSON.stringify({generation,electron:process.versions.electron,platform:process.platform,asyncProtection:true,keyId:evidence.policy.keyId,keyHash:evidence.keyHash,nonceCounters:evidence.nonces.map(nonce=>Buffer.from(nonce,'base64url').readUInt32BE(8)),cloneNonceCounters:evidence.cloneNonces.map(nonce=>Buffer.from(nonce,'base64url').readUInt32BE(8)),policyRetained:true,clonedKeyDecrypts:true,persistedKeyConcealed:true}));
}
void main().then(()=>app.exit(0),error=>{console.error(error instanceof Error?error.stack:String(error));app.exit(1);});
