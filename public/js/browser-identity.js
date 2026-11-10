// @ts-check
import {parseIdentityChallenge,parseGovernanceCommand} from './server-governance-ui.js';
import {governanceConsent} from './governance-consent.js';
import {parseGovernanceCheckpoint,checkpointPayload,ownerProofPayload,governanceRevision,extendsVerifiedGovernance} from './governance-checkpoint.js';
/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('./server-governance-ui.js').GovernanceJournal} GovernanceJournal */
/** @typedef {import('./server-governance-ui.js').GovernanceCommand} GovernanceCommand */
/** @typedef {{id:string,privateKey:CryptoKey,publicKey:CryptoKey,memberKey:string}} StoredIdentity */
/** @template T @param {IDBRequest<T>} operation @returns {Promise<T>} */
function request(operation){return new Promise((resolve,reject)=>{operation.onsuccess=()=>resolve(operation.result);operation.onerror=()=>reject(operation.error ?? new Error('Browser identity database request failed'));});}
/** @param {IDBTransaction} transaction @returns {Promise<void>} */
function committed(transaction){return new Promise((resolve,reject)=>{transaction.oncomplete=()=>resolve();transaction.onerror=()=>reject(transaction.error ?? new Error('Browser identity transaction failed'));transaction.onabort=()=>reject(transaction.error ?? new DOMException('Browser identity transaction aborted','AbortError'));});}
/** @param {Uint8Array} bytes @returns {string} */
function base64(bytes){return btoa(String.fromCharCode(...bytes));}
/** @param {string} value @param {number} length @returns {Uint8Array<ArrayBuffer>} */
function decoded(value,length){if(typeof value!=='string' || value.length!==Math.ceil(length/3)*4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw new TypeError('Browser identity contains noncanonical base64');const bytes=Uint8Array.from(atob(value),character=>character.charCodeAt(0));if(bytes.length!==length || base64(bytes)!==value)throw new TypeError('Browser identity key or signature has the wrong size');return bytes;}
/** @param {string} text @returns {Promise<string>} */
async function digest(text){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
/** @param {string} memberKey @returns {Promise<CryptoKey>} */
async function publicKey(memberKey){const bytes=decoded(memberKey,44),prefix='302a300506032b6570032100';if([...bytes.slice(0,12)].map(byte=>byte.toString(16).padStart(2,'0')).join('')!==prefix)throw new TypeError('Browser identity requires a canonical Ed25519 public key');return crypto.subtle.importKey('spki',bytes,{name:'Ed25519'},true,['verify']);}
/** @param {StoredIdentity} value @param {string} id @returns {Promise<StoredIdentity>} */
async function checkedIdentity(value,id){if(!value || value.id!==id || !(value.privateKey instanceof CryptoKey) || !(value.publicKey instanceof CryptoKey) || value.privateKey.type!=='private' || value.privateKey.algorithm.name!=='Ed25519' || value.publicKey.type!=='public')throw new TypeError('Persisted browser identity is invalid');const exported=base64(new Uint8Array(await crypto.subtle.exportKey('spki',value.publicKey)));if(value.memberKey!==exported)throw new TypeError('Persisted browser identity does not match its public key');const payload=new TextEncoder().encode('deepscord-browser-key-check-v1'),signature=await crypto.subtle.sign('Ed25519',value.privateKey,payload);if(!await crypto.subtle.verify('Ed25519',await publicKey(exported),signature,payload))throw new TypeError('Persisted browser identity key pair does not match');return{id,privateKey:value.privateKey,publicKey:value.publicKey,memberKey:exported};}

/** @returns {Promise<{signServerIdentity:(value:JsonValue)=>Promise<{t:'identityProof',nonce:string,memberKey:string,signature:string}>,signGovernanceChange:(input:{journal:GovernanceJournal,command:GovernanceCommand})=>Promise<{t:'governanceChange',event:import('../../lib/server-governance.cjs').GovernanceEvent}>,saveServerGovernance:(journal:GovernanceJournal)=>Promise<void>,destroy:()=>void}>} */
export async function createBrowserIdentity(){
  if(!isSecureContext || !crypto.subtle)throw new Error('浏览器身份验证需要 HTTPS 或 localhost 安全连接');
  const operation=indexedDB.open('deepscord-browser-identity-v1',1);operation.onupgradeneeded=()=>{operation.result.createObjectStore('keys',{keyPath:'id'});operation.result.createObjectStore('journals');};const database=await request(operation);let disposed=false;
  /** @type {Map<string,Promise<StoredIdentity>>} */const identities=new Map();
  /** @type {Map<string,string>} */const verified=new Map();
  /** @param {string} roomId @param {string} creatorKey @returns {Promise<StoredIdentity>} */
  async function identity(roomId,creatorKey){
    if(disposed)throw new Error('Browser identity has been closed');const id=roomId+'/'+creatorKey,cached=identities.get(id);if(cached)return cached;
    const task=(async()=>{
      const transaction=database.transaction('keys','readonly'),done=committed(transaction);
      /** @type {IDBRequest<StoredIdentity|undefined>} */const lookup=transaction.objectStore('keys').get(id);const stored=await request(lookup);await done;if(stored)return checkedIdentity(stored,id);
      const keys=await crypto.subtle.generateKey({name:'Ed25519'},false,['sign','verify']),memberKey=base64(new Uint8Array(await crypto.subtle.exportKey('spki',keys.publicKey)));
      const write=database.transaction('keys','readwrite'),saved=committed(write);
      /** @type {IDBRequest<StoredIdentity|undefined>} */const again=write.objectStore('keys').get(id);const existing=await request(again),record=existing ?? {id,privateKey:keys.privateKey,publicKey:keys.publicKey,memberKey};if(!existing)write.objectStore('keys').put(record);await saved;return checkedIdentity(record,id);
    })();identities.set(id,task);try{return await task;}catch(error){identities.delete(id);throw error;}
  }
  /** @param {GovernanceJournal} journal @returns {Promise<void>} */
  async function verifyJournal(journal){
    if(disposed)throw new Error('Browser identity has been closed');const encoded=JSON.stringify(journal);if(new TextEncoder().encode(encoded).length>2*1024*1024 || journal.version!==1 || journal.events.length>2048)throw new RangeError('Browser governance journal exceeds its schema budget');if(verified.get(journal.digest)===encoded)return;
    await publicKey(journal.creatorKey);let previous=await digest(JSON.stringify(['deepscord-governance-genesis-v1',journal.roomId,journal.creatorKey]));
    const checkpoint=journal.checkpoint===undefined?null:parseGovernanceCheckpoint(journal.checkpoint),base=checkpoint?.revision??0;
    if(checkpoint){
      let owner=journal.creatorKey,revision=0;
      for(const event of checkpoint.owners){
        if(event.actorKey!==owner||event.revision<=revision||event.command.type!=='transferOwner')throw new TypeError('Checkpoint owner succession conflicts with its creator');
        if(!await crypto.subtle.verify('Ed25519',await publicKey(owner),decoded(event.signature,64),new TextEncoder().encode(ownerProofPayload(journal,event))))throw new TypeError('Checkpoint owner transfer signature is invalid');
        owner=event.command.memberKey;revision=event.revision;
      }
      if(checkpoint.state.ownerKey!==owner||!await crypto.subtle.verify('Ed25519',await publicKey(owner),decoded(checkpoint.signature,64),new TextEncoder().encode(checkpointPayload(journal,checkpoint))))throw new TypeError('Checkpoint must be signed by its current owner');
      previous=checkpoint.digest;
    }
    for(let index=0;index<journal.events.length;index++){
      const event=journal.events[index],command=parseGovernanceCommand(event.command);if(event.revision!==base+index+1 || event.previousDigest!==previous)throw new TypeError('Browser governance journal has a broken revision chain');
      const payload=JSON.stringify(['deepscord-governance-v1',1,journal.roomId,journal.creatorKey,base+index+1,previous,event.actorKey,command]);
      if(!await crypto.subtle.verify('Ed25519',await publicKey(event.actorKey),decoded(event.signature,64),new TextEncoder().encode(payload)))throw new TypeError('Browser governance event signature is invalid at revision '+event.revision);
      previous=await digest(JSON.stringify(['deepscord-governance-event-v1',journal.roomId,journal.creatorKey,{revision:event.revision,previousDigest:event.previousDigest,actorKey:event.actorKey,command,signature:event.signature}]));
    }
    if(previous!==journal.digest)throw new TypeError('Browser governance digest does not match its signed history');verified.set(journal.digest,encoded);while(verified.size>4){const key=verified.keys().next().value;if(key===undefined)break;verified.delete(key);}
  }
  /** @param {GovernanceJournal} journal @returns {Promise<void>} */
  async function saveServerGovernance(journal){await verifyJournal(journal);const transaction=database.transaction('journals','readwrite'),done=committed(transaction),key=journal.roomId;
    /** @type {IDBRequest<GovernanceJournal|undefined>} */const lookup=transaction.objectStore('journals').get(key);const stored=await request(lookup);
    if(stored && !extendsVerifiedGovernance(stored,journal)){transaction.abort();await done.catch(()=>{});throw new TypeError('服务器签名历史与本浏览器保存的身份锚点冲突');}
    transaction.objectStore('journals').put(journal,key);await done;
  }
  return {
    async signServerIdentity(value){const challenge=parseIdentityChallenge(value),record=await identity(challenge.roomId,challenge.creatorKey),payload=JSON.stringify(['deepscord-identity-v1',challenge.roomId,challenge.creatorKey,challenge.nonce,challenge.userId]);return{t:'identityProof',nonce:challenge.nonce,memberKey:record.memberKey,signature:base64(new Uint8Array(await crypto.subtle.sign('Ed25519',record.privateKey,new TextEncoder().encode(payload))))};},
    async signGovernanceChange(input){
      await verifyJournal(input.journal);
      const journal=input.journal,record=await identity(journal.roomId,journal.creatorKey),command=parseGovernanceCommand(input.command),consent=governanceConsent(command);
      if(consent && !window.confirm(consent.title+'\n\n'+consent.details.map(detail=>detail.label+'：'+detail.value).join('\n')))throw new DOMException('已取消权限修改','AbortError');
      const revision=governanceRevision(journal)+1,payload=JSON.stringify(['deepscord-governance-v1',1,journal.roomId,journal.creatorKey,revision,journal.digest,record.memberKey,command]);
      return{t:'governanceChange',event:{revision,previousDigest:journal.digest,actorKey:record.memberKey,command,signature:base64(new Uint8Array(await crypto.subtle.sign('Ed25519',record.privateKey,new TextEncoder().encode(payload))))}};
    },
    saveServerGovernance,
    destroy(){disposed=true;identities.clear();verified.clear();database.close();}
  };
}
