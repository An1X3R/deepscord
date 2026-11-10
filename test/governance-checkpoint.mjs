// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,sign} from 'node:crypto';
import {identity} from './server-ws-helpers.mjs';
import {createGovernance,createGovernanceVerifier,governanceRevision,governanceCheckpointPayload,compactGovernance,isGovernanceExtension,parseGovernance} from '../lib/server-governance.cjs';
/** @typedef {import('../lib/server-governance.cjs').GovernanceJournal} Journal */
/** @typedef {import('../lib/server-governance.cjs').GovernanceCommand} Command */
/** @typedef {ReturnType<typeof identity>} Identity */

test('owner-attested checkpoints retain permissions, ownership proofs and monotonic revisions beyond 2048 changes',{timeout:30000},()=>{
  const creator=identity(),successor=identity(),verifier=createGovernanceVerifier({maxEntries:4,maxBytes:8*1024*1024});
  let journal=createGovernance({version:1,roomId:randomUUID(),creatorKey:creator.key}),actor=creator;
  const initial=journal;
  /** @param {Command} command @returns {void} */
  function change(command){journal=verifier.append(journal,{revision:governanceRevision(journal)+1,previousDigest:journal.digest,actorKey:actor.key,command,signature:sign(null,Buffer.from(verifier.payload(journal,actor.key,command)),actor.privateKey).toString('base64')});}
  /** @param {Identity} signer @returns {Journal} */
  function compact(signer){return compactGovernance(journal,sign(null,Buffer.from(governanceCheckpointPayload(journal)),signer.privateKey).toString('base64'));}
  change({type:'renameServer',name:'Before ownership transfer'});
  const offline=journal;
  change({type:'transferOwner',memberKey:successor.key});actor=successor;
  change({type:'setDomainOwner',domainId:'domain',memberKey:creator.key});
  assert.throws(()=>compact(creator),/current server owner/);
  for(let index=0;index<2200;index++){
    change({type:'renameServer',name:'Room '+index});
    if(journal.events.length>=256){
      const before=journal,policy=verifier.state(journal);journal=compact(actor);
      assert.equal(journal.events.length,0);assert.deepEqual(verifier.state(journal),policy);
      assert(isGovernanceExtension(before,journal));assert(isGovernanceExtension(offline,journal));
    }
  }
  assert.equal(governanceRevision(journal),2203);
  assert.equal(verifier.state(journal).ownerKey,successor.key);
  assert.equal(verifier.state(journal).domains[0].ownerKey,creator.key);
  assert.equal(journal.checkpoint?.owners.length,1);
  assert(!isGovernanceExtension(journal,offline));assert(!isGovernanceExtension(journal,initial));
  const compacted=compact(actor),checkpoint=compacted.checkpoint;assert(checkpoint);
  assert.throws(()=>parseGovernance({...compacted,checkpoint:{...checkpoint,state:{...checkpoint.state,name:'Altered policy'}}},compacted),/signed by its current server owner/);
  const before=journal;journal=offline;actor=creator;change({type:'transferOwner',memberKey:creator.key});
  assert(!isGovernanceExtension(journal,before));
});
