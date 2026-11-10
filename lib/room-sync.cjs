// @ts-check
'use strict';
const { randomUUID } = require('node:crypto');
const { createRoomDocument, verifyRoomVote } = require('./room-replica.cjs');
/** @typedef {import('./room-replica.cjs').RoomDescriptor} RoomDescriptor */
/** @typedef {import('./room-replica.cjs').RoomDocument} RoomDocument */
/** @typedef {import('./room-replica.cjs').RoomVote} RoomVote */
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{id:string,memberKey:string|null}} SyncMember */
/** @typedef {{id:string,vote:RoomVote}} MemberVote */
/** @typedef {{status:'commit',document:RoomDocument,reason:'authority'|'creator'|'majority'}|{status:'conflict',reason:'creator-missing'|'no-majority',candidates:RoomDocument[]}} SyncDecision */

/** @param {RoomDocument[]} documents @returns {RoomDocument[]} */
function uniqueDocuments(documents) {
  /** @type {Map<string,RoomDocument>} */ const digests = new Map();
  for (const document of documents) { const previous = digests.get(document.digest); if (!previous || document.revision > previous.revision) digests.set(document.digest, document); }
  const result = [...digests.values()].map(document=>structuredClone(document));
  if (result.length > 24 || Buffer.byteLength(JSON.stringify(result), 'utf8') > 1048576) throw new RangeError('Room conflict candidates exceed the 24-document or one MiB transport limit');
  return result;
}
/** Resolve only previously validated votes from distinct current connections and keys. @param {{descriptor:RoomDescriptor,current:RoomDocument,members:SyncMember[],votes:MemberVote[],authority:boolean}} options @returns {SyncDecision} */
function resolveRoomVotes(options) {
  if (options.authority) return { status:'commit', document:structuredClone(options.current), reason:'authority' };
  const creator = options.votes.find(entry=>entry.vote.memberKey === options.descriptor.creatorKey);
  if (creator) return { status:'commit', document:structuredClone(creator.vote.document), reason:'creator' };
  if (options.members.some(member=>member.memberKey === options.descriptor.creatorKey)) return { status:'conflict', reason:'creator-missing', candidates:uniqueDocuments([options.current, ...options.votes.map(entry=>entry.vote.document)]) };
  const existing = options.votes.filter(entry=>!entry.vote.fresh);
  /** @type {Map<string,{count:number,document:RoomDocument}>} */ const groups = new Map();
  for (const entry of existing) {
    const group = groups.get(entry.vote.document.digest);
    if (group) { group.count += 1; if (entry.vote.document.revision > group.document.revision) group.document = entry.vote.document; }
    else groups.set(entry.vote.document.digest, { count:1, document:entry.vote.document });
  }
  const majority = [...groups.values()].find(group=>group.count > options.members.length / 2);
  if (majority) return { status:'commit', document:structuredClone(majority.document), reason:'majority' };
  return { status:'conflict', reason:'no-majority', candidates:uniqueDocuments([options.current, ...options.votes.map(entry=>entry.vote.document)]) };
}

/** @typedef {{descriptor:RoomDescriptor,authority:boolean,getDocument:()=>RoomDocument,getMembers:()=>SyncMember[],commit:(document:RoomDocument,reason:string)=>void,broadcast:(message:JsonValue)=>void,onError:(error:Error)=>void,settleMs:number,validateDocument?:(memberKey:string,document:RoomDocument,current:RoomDocument)=>void}} RoomSyncOptions */
/** Coordinate a bounded collection round without interfering with media signaling. @param {RoomSyncOptions} options */
function createRoomSync(options) {
  if (!Number.isInteger(options.settleMs) || options.settleMs < 1 || options.settleMs > 10000) throw new RangeError('Room sync collection interval must be 1..10000 ms');
  /** @type {{id:string,members:SyncMember[],current:RoomDocument,votes:Map<string,RoomVote>,candidates:RoomDocument[],status:'collecting'|'conflict'}|null} */ let round = null;
  /** @type {NodeJS.Timeout|null} */ let timer = null;
  let disposed = false;
  /** @param {RoomDocument} chosen @param {string} reason @returns {void} */
  function apply(chosen, reason) {
    const current = options.getDocument();
    const next = createRoomDocument(options.descriptor, Math.max(current.revision, chosen.revision) + 1, chosen.servers);
    options.commit(next, reason);
    round = null;
    if (timer) clearTimeout(timer); timer = null;
  }
  /** @returns {void} */
  function settle() {
    timer = null;
    if (!round || disposed) return;
    const currentRound = round;
    try {
      const decision = resolveRoomVotes({ descriptor:options.descriptor, current:currentRound.current, members:currentRound.members, votes:[...currentRound.votes].map(([id,vote])=>({id,vote})), authority:options.authority });
      if (decision.status === 'commit') { apply(decision.document, decision.reason); return; }
      currentRound.status = 'conflict'; currentRound.candidates = decision.candidates;
      options.broadcast({ t:'roomSyncConflict', roundId:currentRound.id, candidates:decision.candidates, reason:decision.reason, authenticatedConnections:currentRound.members.length, validVotes:currentRound.votes.size, existingVotes:[...currentRound.votes.values()].filter(vote=>!vote.fresh).length });
    } catch (error) { options.onError(error instanceof Error ? error : new TypeError('Room sync settlement rejected with a non-error')); }
  }
  /** @returns {void} */
  function membersChanged() {
    if (disposed) throw new Error('Room sync coordinator has been disposed');
    if (timer) clearTimeout(timer); timer = null;
    const members = options.getMembers();
    if (!members.length) { round = null; return; }
    if (options.authority) { apply(options.getDocument(), 'authority'); return; }
    round = { id:randomUUID(), members:structuredClone(members), current:options.getDocument(), votes:new Map(), candidates:[], status:'collecting' };
    options.broadcast({ t:'roomSyncOffer', roundId:round.id, descriptor:options.descriptor, document:round.current, settleMs:options.settleMs });
    timer = setTimeout(settle, options.settleMs);
  }
  /** @param {string} id @param {JsonValue} input @returns {string} */
  function vote(id, input) {
    const active = round;
    if (!active || active.status !== 'collecting') throw new Error('Room vote requires an active collection round');
    const member = active.members.find(member=>member.id === id);
    if (!member) throw new Error('Room vote connection is not a member of the current round');
    const parsed = verifyRoomVote(input, options.descriptor, active.id);
    if (member.memberKey && member.memberKey !== parsed.memberKey) throw new TypeError('Room vote cannot change this connection\'s verified member identity');
    if (active.votes.has(id)) throw new TypeError('A connection can submit only one vote per room round');
    if ([...active.votes.values()].some(vote=>vote.memberKey === parsed.memberKey) || active.members.some(entry=>entry.id !== id && entry.memberKey === parsed.memberKey)) throw new TypeError('A room member public key can vote from only one current connection');
    if (parsed.fresh && (parsed.document.digest !== active.current.digest || parsed.document.revision !== active.current.revision)) throw new TypeError('A fresh vote must reference the exact offered document');
    options.validateDocument?.(parsed.memberKey,parsed.document,active.current);
    member.memberKey = parsed.memberKey;
    active.votes.set(id, parsed);
    return parsed.memberKey;
  }
  /** @param {string} id @param {JsonValue} input @returns {void} */
  function choose(id, input) {
    const active = round;
    if (!active || active.status !== 'conflict') throw new Error('Room choice requires an unresolved conflict round');
    if (!active.members.some(member=>member.id === id)) throw new Error('Room choice connection is not a member of the current round');
    if (active.members.some(member=>member.memberKey === options.descriptor.creatorKey) && !active.members.some(member=>member.id === id && member.memberKey === options.descriptor.creatorKey)) throw new Error('The verified creator is online; only that creator can resolve this pending room conflict');
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.roundId !== active.id || typeof input.digest !== 'string') throw new TypeError('Room choice must reference the active round and a candidate digest');
    const candidate = active.candidates.find(candidate=>candidate.digest === input.digest);
    if (!candidate) throw new TypeError('Room choice digest is not a valid candidate in the active round');
    if (candidate.digest !== active.current.digest && options.validateDocument) {
      const source = [...active.votes.values()].find(vote=>vote.document.digest === candidate.digest);
      if (!source) throw new TypeError('Room choice has no authorized source');
      options.validateDocument(source.memberKey,candidate,options.getDocument());
    }
    apply(candidate, 'explicit-choice');
  }
  /** @returns {void} */
  function dispose() { disposed = true; if (timer) clearTimeout(timer); timer = null; round = null; }
  return { membersChanged, vote, choose, pending:()=>round !== null, dispose };
}
module.exports = { resolveRoomVotes, createRoomSync };
