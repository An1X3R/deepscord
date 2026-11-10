// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes,timingSafeEqual } = require('node:crypto');
const { createGovernance,createGovernanceVerifier,isGovernanceExtension,governanceRevision,compactGovernance } = require('./server-governance.cjs');
const { writeAtomicFile } = require('./atomic-file.cjs');
const { gzipSync } = require('node:zlib');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('./room-replica.cjs').RoomDescriptor} RoomDescriptor */
/** @typedef {import('./server-governance.cjs').GovernanceJournal} GovernanceJournal */
/** @typedef {import('./server-governance.cjs').GovernanceCommand} GovernanceCommand */

/** @param {string} filename @returns {JsonValue} */
function readJournal(filename) {
  if (fs.statSync(filename).size > 2 * 1024 * 1024) throw new RangeError('Governance file exceeds two MiB: ' + filename);
  return JSON.parse(fs.readFileSync(filename,'utf8'));
}

/** @param {{dataDir:string,descriptor:RoomDescriptor,seed:JsonValue|null,authority:boolean,signAuthority:(payload:string)=>string}} options */
function openGovernanceStore(options) {
  const filename = path.join(options.dataDir,'server-governance.json');
  const claimFile = path.join(options.dataDir,'owner-claim.txt');
  const verifier = createGovernanceVerifier({ maxEntries:4,maxBytes:8 * 1024 * 1024 });
  const existing = fs.existsSync(filename);
  let snapshot = verifier.verify(existing ? readJournal(filename) : createGovernance(options.descriptor),options.descriptor);
  let journal = snapshot.journal;
  let changed = !existing;
  if (options.seed !== null) {
    const candidate = verifier.verify(options.seed,options.descriptor), seed = candidate.journal;
    if (journal.digest===seed.digest && (journal.checkpoint?.revision??0)>=(seed.checkpoint?.revision??0)) { /* Retain the most compact verified representation. */ }
    else if (isGovernanceExtension(journal,seed)) { changed = changed || journal.digest !== seed.digest || journal.checkpoint?.revision!==seed.checkpoint?.revision; snapshot = candidate; journal = seed; }
    else if (!isGovernanceExtension(seed,journal)) throw new TypeError('Saved governance and seed have conflicting signed histories');
  }
  let policy = snapshot.policy;
  /** @param {GovernanceJournal} next @returns {void} */
  function persist(next) {
    const verified = verifier.verify(next,options.descriptor);
    writeAtomicFile(filename,JSON.stringify(next));
    journal = verified.journal;
    policy = verified.policy;
  }
  if (changed) persist(journal);
  if (options.authority && policy.ownerKey === options.descriptor.creatorKey && !fs.existsSync(claimFile)) {
    fs.writeFileSync(claimFile,randomBytes(32).toString('hex') + '\n',{ encoding:'utf8',flag:'wx',mode:0o600 });
    console.info('server_owner_claim_created',{ path:claimFile,roomId:options.descriptor.roomId });
  }
  /** @param {JsonValue} value @returns {boolean} */
  function restore(value) {
    const next = verifier.verify(value,options.descriptor).journal;
    if (next.digest === journal.digest) {
      if ((next.checkpoint?.revision??0) <= (journal.checkpoint?.revision??0)) return false;
      persist(next);return true;
    }
    if (isGovernanceExtension(next,journal)) return false;
    if (!isGovernanceExtension(journal,next)) throw new TypeError('Governance history conflicts with the current signed history');
    persist(next);
    return true;
  }
  /** @param {string} memberKey @param {JsonValue} value @returns {void} */
  function change(memberKey,value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.actorKey !== memberKey) throw new TypeError('Governance event must be signed by this authenticated member');
    persist(verifier.append(journal,value));
  }
  /** @returns {boolean} */
  function claimAvailable() { return options.authority && policy.ownerKey === options.descriptor.creatorKey; }
  /** @param {string} memberKey @param {string} token @returns {void} */
  function claim(memberKey,token) {
    if (!claimAvailable()) throw new TypeError('服主已经确定，不能再次认领');
    const expected = fs.readFileSync(claimFile,'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(expected)) throw new TypeError('Invalid owner claim file: ' + claimFile);
    if (!/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token),Buffer.from(expected))) throw new TypeError('服主认领码不正确，请从独立服务端的 data/owner-claim.txt 读取');
    /** @type {GovernanceCommand} */
    const command = { type:'transferOwner',memberKey };
    const payload = verifier.payload(journal,options.descriptor.creatorKey,command);
    persist(verifier.append(journal,{ revision:governanceRevision(journal) + 1,previousDigest:journal.digest,actorKey:options.descriptor.creatorKey,command,signature:options.signAuthority(payload) }));
    fs.unlinkSync(claimFile);
  }
  /** @param {string} memberKey @param {string} expectedDigest @param {string} signature @returns {void} */
  function compact(memberKey,expectedDigest,signature) {
    if(memberKey!==policy.ownerKey)throw new TypeError('Only the current server owner may attest a compacted policy');
    if(expectedDigest!==journal.digest)throw new TypeError('Governance changed before checkpoint approval; refresh and retry');
    if(journal.events.length===0 && journal.checkpoint?.signature===signature)return;
    const next=compactGovernance(journal,signature),directory=path.join(options.dataDir,'governance-archive');
    fs.mkdirSync(directory,{recursive:true});
    const archived=path.join(directory,String(governanceRevision(journal)).padStart(16,'0')+'-'+journal.digest+'.json.gz');
    writeAtomicFile(archived,gzipSync(JSON.stringify(journal)));
    persist(next);
    const files=fs.readdirSync(directory).filter(name=>/^\d{16}-[a-f0-9]{64}\.json\.gz$/.test(name)).sort().reverse();
    let bytes=0;
    for(const [index,name] of files.entries()){
      const file=path.join(directory,name),stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink())throw new TypeError('Governance archive must contain ordinary files');
      bytes+=stat.size;
      if(index>=32 || bytes>32*1024*1024)fs.unlinkSync(file);
    }
  }
  return { getJournal:()=>structuredClone(journal),getPolicy:()=>structuredClone(policy),restore,change,claim,claimAvailable,compact };
}

module.exports = { openGovernanceStore,readJournal };
