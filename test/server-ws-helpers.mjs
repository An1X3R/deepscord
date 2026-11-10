// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import governance from '../lib/server-governance.cjs';
import identityProtocol from '../lib/server-identity.cjs';
import replica from '../lib/room-replica.cjs';
import steamState from '../lib/steam-state.cjs';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{[key:string]:JsonValue}} Message */
/** @typedef {{key:string,privateKey:import('node:crypto').KeyObject}} Identity */
/** @typedef {import('../lib/server-governance.cjs').GovernanceJournal} Journal */
/** @typedef {import('../lib/server-governance.cjs').GovernanceCommand} Command */
/** @typedef {import('../lib/server-governance.cjs').GovernanceEvent} GovernanceEvent */
/** @typedef {import('../lib/server-identity.cjs').IdentityChallenge} Challenge */
/** @typedef {{socket:WebSocket,messages:Message[],failure:()=>Error|null,closed:Promise<void>,userId:string,challenge:Challenge}} Client */
/** @typedef {{child:import('node:child_process').ChildProcess,origin:string,clients:Client[],output:()=>string,failure:()=>Error|null,exited:Promise<void>}} Backend */

const root = fs.realpathSync(process.env.DEEPSCORD_TEST_SERVER_ROOT ?? fileURLToPath(new URL('../', import.meta.url)));
const executable=fs.realpathSync(process.env.DEEPSCORD_TEST_NODE ?? process.execPath);
const { governancePayload, parseGovernance } = governance;
const { identityPayload, parseIdentityChallenge } = identityProtocol;

/** @param {JsonValue|undefined} value @returns {Message} */
function object(value) { assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected a wire JSON object'); return value; }
/** @param {JsonValue|undefined} value @returns {string} */
function string(value) { assert.equal(typeof value, 'string'); return /** @type {string} */ (value); }
/** @param {number} milliseconds @returns {Promise<void>} */
function delay(milliseconds) { return new Promise(resolve=>setTimeout(resolve, milliseconds)); }
/** @returns {Identity} */
function identity() { const pair = generateKeyPairSync('ed25519'); return { key:pair.publicKey.export({ format:'der', type:'spki' }).toString('base64'), privateKey:pair.privateKey }; }

/** @param {()=>boolean} condition @param {()=>Error|null} failure @param {string} label @returns {Promise<void>} */
async function until(condition, failure, label) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const error = failure(); if (error) throw error;
    if (condition()) return;
    await delay(10);
  }
  throw new Error('Actual server integration timed out: ' + label);
}

/** @returns {Promise<number>} */
async function reservePort() {
  const listener = net.createServer();
  await new Promise((resolve,reject)=>{ listener.once('error',reject); listener.listen(0,'127.0.0.1',()=>resolve(undefined)); });
  const address = listener.address(); assert(address && typeof address !== 'string');
  await new Promise((resolve,reject)=>listener.close(error=>error ? reject(error) : resolve(undefined)));
  return address.port;
}

/** @param {string} directory @param {NodeJS.ProcessEnv} configuration @returns {Promise<Backend>} */
async function launch(directory, configuration) {
  fs.mkdirSync(directory, { recursive:true });
  const port = await reservePort();
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(?:ECHO_|TURN_|STUN_|HTTP_|HTTPS_|PORT$|HISTORY_LIMIT$)/i.test(key)));
  const child = spawn(executable,[path.join(root,'server.js')], { cwd:root, windowsHide:true, stdio:['ignore','pipe','pipe'], env:{ ...inherited, PORT:String(port), HTTP_HOST:'127.0.0.1', HTTPS_PORTS:'0', ECHO_DATA_DIR:directory, ECHO_PASSWORD:'', ECHO_NETWORK_MODE:'server', ECHO_MEDIA_POLICY:'direct', ECHO_SCREEN_MODE:'peer-relay', STUN_URLS:'', ...configuration } });
  let output = '';
  /** @type {Error|null} */ let failure = null;
  const collect = (/** @type {Buffer} */ chunk)=>{ output = (output + chunk.toString('utf8')).slice(-16000); };
  child.stdout?.on('data',collect); child.stderr?.on('data',collect);
  child.on('error', error=>{ failure = error; });
  const exited = new Promise(/** @param {(value:void)=>void} resolve */ resolve=>child.once('exit',()=>resolve()));
  const backend = { child, origin:'http://127.0.0.1:' + port, clients:/** @type {Client[]} */ ([]), output:()=>output, failure:()=>failure, exited };
  try {
    await until(()=>child.exitCode !== null || output.includes('HTTP'),()=>failure,'server startup');
    assert.equal(child.exitCode,null,'Actual server exited: ' + output);
    const response = await fetch(backend.origin + '/api/health');
    assert.equal(response.status,200,'Actual server health failed: ' + output);
    return backend;
  } catch (error) { await stop(backend); throw error; }
}

/** @param {Backend} backend @returns {Promise<void>} */
async function stop(backend) {
  for (const client of backend.clients) if (client.socket.readyState < WebSocket.CLOSING) client.socket.close();
  if (backend.child.exitCode !== null || backend.child.signalCode !== null) return;
  backend.child.kill();
  let timer;
  try { await Promise.race([backend.exited,new Promise((resolve,reject)=>{ timer = setTimeout(()=>reject(new Error('Owned server did not exit')),5000); })]); }
  finally { clearTimeout(timer); }
}

/** @param {Client} client @param {Message} message @returns {number} */
function send(client, message) { const cursor = client.messages.length; client.socket.send(JSON.stringify(message)); return cursor; }
/** @param {Client} client @param {number} cursor @param {(message:Message)=>boolean} predicate @param {string} label @returns {Promise<Message>} */
async function receive(client, cursor, predicate, label) {
  await until(()=>client.messages.slice(cursor).some(predicate),client.failure,label + '; recent types=' + client.messages.slice(-8).map(message=>message.t).join(','));
  const message = client.messages.slice(cursor).find(predicate); assert(message); return message;
}

/** @param {Backend} backend @param {Message} hello @returns {Promise<Client>} */
async function connectHello(backend, hello) {
  const socket = new WebSocket(backend.origin.replace('http:','ws:') + '/ws');
  /** @type {Message[]} */ const messages = [];
  /** @type {Error|null} */ let failure = null;
  socket.addEventListener('message',event=>{
    try {
      assert.equal(typeof event.data,'string');
      if (messages.length >= 4096) throw new RangeError('Role integration inbox exceeded 4096 frames');
      messages.push(object(JSON.parse(event.data)));
    } catch (error) { failure = error instanceof Error ? error : new TypeError('Invalid wire response'); }
  });
  socket.addEventListener('error',()=>{ failure = new Error('Role integration WebSocket failed'); });
  const closed = new Promise(/** @param {(value:void)=>void} resolve */ resolve=>socket.addEventListener('close',()=>resolve(),{ once:true }));
  await until(()=>socket.readyState === WebSocket.OPEN,()=>failure,'WebSocket open');
  socket.send(JSON.stringify(hello));
  await until(()=>messages.some(message=>message.t === 'identityChallenge'),()=>failure,'identity challenge');
  const welcome = messages.find(message=>message.t === 'welcome'); assert(welcome);
  const challenge = messages.find(message=>message.t === 'identityChallenge'); assert(challenge);
  const client = { socket, messages, failure:()=>failure, closed, userId:string(welcome.selfId), challenge:parseIdentityChallenge(challenge) };
  backend.clients.push(client);
  return client;
}

/** @param {Backend} backend @param {string} name @returns {Promise<Client>} */
function connect(backend, name) { return connectHello(backend,{ t:'hello', name, color:'#123456', password:'', resumable:false }); }

/** @param {Client} client @param {Identity} member @returns {Message} */
function proof(client, member) { return { t:'identityProof', nonce:client.challenge.nonce, memberKey:member.key, signature:sign(null,Buffer.from(identityPayload(client.challenge)),member.privateKey).toString('base64') }; }
/** @param {Client} client @param {Identity} member @returns {Promise<Message>} */
async function authenticate(client, member) {
  const cursor = send(client,proof(client,member));
  return receive(client,cursor,message=>message.t === 'serverState' && message.selfKey === member.key,'verified member ' + client.userId);
}
/** @param {Client} client @param {Message} command @returns {Promise<Message>} */
async function denied(client, command) {
  const cursor = send(client,command);
  return receive(client,cursor,message=>message.t === 'error' && message.code === 'permission-denied' && message.action === command.t,'permission denial for ' + string(command.t));
}
/** @param {Message} state @returns {Journal} */
function journal(state) { const raw = object(state.journal); return parseGovernance(raw,replica.parseRoomDescriptor(raw)); }
/** @param {Journal} current @param {Identity} actor @param {Command} command @returns {GovernanceEvent} */
function signedEvent(current, actor, command) { return { revision:governance.governanceRevision(current) + 1, previousDigest:current.digest, actorKey:actor.key, command, signature:sign(null,Buffer.from(governancePayload(current,actor.key,command)),actor.privateKey).toString('base64') }; }
/** @param {Client} client @param {Identity} actor @param {Journal} current @param {Command} command @returns {Promise<Journal>} */
async function change(client, actor, current, command) {
  const cursor = send(client,{ t:'governanceChange', event:signedEvent(current,actor,command) });
  return journal(await receive(client,cursor,message=>message.t === 'serverState' && governance.governanceRevision(journal(message)) === governance.governanceRevision(current) + 1,'signed governance change ' + command.type));
}
/** @param {Client} client @param {Message} command @returns {Promise<import('../lib/steam-state.cjs').RoomServer[]>} */
async function structure(client, command) {
  const supported=['createServer','deleteServer','updateDomain','createChannel','updateChannel','deleteChannel'];
  if(!supported.includes(string(command.t)))throw new TypeError('Unsupported structure test command: '+string(command.t));
  const cursor = send(client,command);
  const frame = await receive(client,cursor,message=>{
    if(message.t!=='servers')return false;
    const servers=steamState.parseSteamStore({version:1,servers:message.servers,messages:{}}).servers;
    const channels=servers.flatMap(server=>server.channels);
    // Other peers can still receive earlier broadcasts after this request is sent.
    switch(command.t){
      case 'createServer':return servers.some(server=>server.name===command.name);
      case 'deleteServer':return servers.every(server=>server.id!==command.serverId);
      case 'updateDomain':return servers.some(server=>server.id===command.domainId && server.name===command.name);
      case 'createChannel':return servers.some(server=>server.id===command.serverId && server.channels.some(channel=>channel.name===command.name && channel.type===command.type));
      case 'updateChannel':return channels.some(channel=>channel.id===command.channelId && (command.name===undefined || channel.name===command.name) && (command.userLimit===undefined || channel.userLimit===command.userLimit));
      case 'deleteChannel':return channels.every(channel=>channel.id!==command.channelId);
      default:throw new TypeError('Unsupported structure test command');
    }
  },'structure update ' + string(command.t));
  return steamState.parseSteamStore({ version:1, servers:frame.servers, messages:{} }).servers;
}
/** @param {Client} client @param {string} channelId @returns {Promise<void>} */
async function join(client, channelId) {
  const cursor = send(client,{ t:'joinVoice', channelId, muted:false, deafened:false });
  await receive(client,cursor,message=>message.t === 'voicePeers' && message.channelId === channelId,'join voice ' + channelId);
}
/** @param {Client} client @param {string} channelId @param {string} text @returns {Promise<string>} */
async function chat(client, channelId, text) {
  const cursor = send(client,{ t:'chat', channelId, text });
  const message = await receive(client,cursor,message=>message.t === 'message' && message.channelId === channelId && object(message.message).text === text,'ordinary chat');
  return string(object(message.message).id);
}
/** @param {string} directory @returns {void} */
function cleanup(directory) { assert.equal(path.dirname(directory),os.tmpdir()); assert(path.basename(directory).startsWith('deepscord-roles-')); fs.rmSync(directory,{ recursive:true, force:true }); }

export {object,string,delay,identity,until,reservePort,launch,stop,send,receive,connectHello,connect,proof,authenticate,denied,journal,signedEvent,change,structure,join,chat,cleanup};
