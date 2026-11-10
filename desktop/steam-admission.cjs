// @ts-check
'use strict';
const {randomBytes,createHmac,timingSafeEqual}=require('node:crypto');
/** @typedef {import('./steam-wire.cjs').SteamInvitation} Invitation */
/** @typedef {{nonce:string,remote:string,authorized:boolean,started:number,sent:number,attempts:number}} Peer */
const PREFIX=Buffer.from('DSAD4:');
const ADMISSION_WINDOW_MS=30000;
const RETRY_INTERVAL_MS=2000;
const MAX_CHALLENGE_ATTEMPTS=15;
/** @param {Invitation} invitation @param {string} selfId @param {(peer:string,packet:Buffer)=>void} send @param {(peer:string)=>void} admitted @param {()=>number} clock */
function createSteamAdmission(invitation,selfId,send,admitted,clock){
  /** @type {Map<string,Peer>} */const peers=new Map();
  const key=Buffer.from(invitation.token,'base64url');
  if(key.length!==32 || key.toString('base64url')!==invitation.token)throw new TypeError('Invalid Steam admission key');
  /** @param {string} sender @param {string} recipient @param {string} kind @param {string} nonce @param {string} challenge @returns {string} */
  function mac(sender,recipient,kind,nonce,challenge){return createHmac('sha256',key).update(JSON.stringify(['deepscord-admission',4,invitation.appId,invitation.lobbyId,sender,recipient,kind,nonce,challenge])).digest('hex');}
  /** @param {string} peer @param {Peer} state @param {'challenge'|'proof'} kind @param {string} challenge @returns {void} */
  function emit(peer,state,kind,challenge){
    send(peer,Buffer.concat([PREFIX,Buffer.from(JSON.stringify({kind,nonce:state.nonce,challenge,mac:mac(selfId,peer,kind,state.nonce,challenge)}))]));
  }
  /** @param {string[]} members @returns {void} */
  function update(members){
    if(members.length>10 || new Set(members).size!==members.length)throw new RangeError('Steam admission requires at most ten unique members');
    for(const peer of peers.keys())if(!members.includes(peer))peers.delete(peer);
    for(const peer of members)if(peer!==selfId && !peers.has(peer))peers.set(peer,{nonce:randomBytes(32).toString('hex'),remote:'',authorized:false,started:clock(),sent:Number.NEGATIVE_INFINITY,attempts:0});
    tick();
  }
  /** @returns {void} */
  function tick(){
    const now=clock();
    for(const [peer,state] of peers){
      if(state.authorized || state.attempts>=MAX_CHALLENGE_ATTEMPTS || now-state.started>ADMISSION_WINDOW_MS || now-state.sent<RETRY_INTERVAL_MS)continue;
      state.sent=now;state.attempts+=1;
      if(state.attempts>1)console.warn('steam_admission_retry',{peerId:peer,attempt:state.attempts});
      emit(peer,state,'challenge','');
    }
  }
  /** @param {Buffer} packet @returns {boolean} */
  function isPacket(packet){return packet.subarray(0,PREFIX.length).equals(PREFIX);}
  /** @param {string} peer @param {Buffer} packet @returns {boolean} */
  function matches(peer,packet){
    if(!isPacket(packet) || packet.length>512)return false;
    /** @type {import('./steam-wire.cjs').JsonValue} */let value;
    try{value=JSON.parse(packet.subarray(PREFIX.length).toString('utf8'));}
    catch(error){if(error instanceof SyntaxError)return false;throw error;}
    if(!value || typeof value!=='object' || Array.isArray(value) || (value.kind!=='challenge' && value.kind!=='proof') || typeof value.nonce!=='string' || !/^[a-f0-9]{64}$/.test(value.nonce) || typeof value.challenge!=='string' || typeof value.mac!=='string' || !/^[a-f0-9]{64}$/.test(value.mac))return false;
    return timingSafeEqual(Buffer.from(value.mac,'hex'),Buffer.from(mac(peer,selfId,value.kind,value.nonce,value.challenge),'hex'));
  }
  /** @param {string} peer @param {Buffer} packet @returns {void} */
  function receive(peer,packet){
    const state=peers.get(peer);
    if(!state || !isPacket(packet) || packet.length>512)throw new TypeError('Invalid Steam admission sender or packet size');
    /** @type {import('./steam-wire.cjs').JsonValue} */const value=JSON.parse(packet.subarray(PREFIX.length).toString('utf8'));
    if(!value || typeof value!=='object' || Array.isArray(value) || (value.kind!=='challenge' && value.kind!=='proof') || typeof value.nonce!=='string' || !/^[a-f0-9]{64}$/.test(value.nonce) || typeof value.challenge!=='string' || typeof value.mac!=='string' || !/^[a-f0-9]{64}$/.test(value.mac))throw new TypeError('Malformed Steam admission packet');
    if(!timingSafeEqual(Buffer.from(value.mac,'hex'),Buffer.from(mac(peer,selfId,value.kind,value.nonce,value.challenge),'hex')))throw new Error('Steam invitation proof failed');
    if(value.kind==='challenge'){
      if(value.challenge!=='')throw new TypeError('Steam challenge must not contain a response');
      state.remote=value.nonce;
      emit(peer,state,'proof',value.nonce);
      return;
    }
    if(value.challenge!==state.nonce || (!state.authorized && clock()-state.started>ADMISSION_WINDOW_MS))throw new Error('Stale Steam invitation proof');
    state.remote=value.nonce;
    if(!state.authorized){
      state.authorized=true;
      // Deliver our reciprocal proof before any confidential application frames.
      emit(peer,state,'proof',value.nonce);
      admitted(peer);
    }
  }
  /** @param {string} peer @returns {boolean} */
  function authorized(peer){return peers.get(peer)?.authorized===true;}
  /** @param {string} peer @returns {void} */
  function requireAuthorized(peer){if(!authorized(peer))throw new Error('Steam peer has not proved the invitation');}
  /** @param {string} peer @param {Buffer} packet @returns {void} */
  function sendAuthorized(peer,packet){requireAuthorized(peer);send(peer,packet);}
  /** @param {string} peer @returns {void} */
  function remove(peer){peers.delete(peer);}
  return{update,tick,isPacket,matches,receive,authorized,requireAuthorized,sendAuthorized,remove};
}
module.exports={createSteamAdmission};
