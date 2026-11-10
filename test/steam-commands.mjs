// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { parsePeerSignal } from '../public/js/network-protocol.js';
import steamCommands from '../desktop/steam-commands.cjs';
import replica from '../lib/room-replica.cjs';
import {createGovernance,governancePayload} from '../lib/server-governance.cjs';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
const { cleanClientCommand } = steamCommands;

test('Steam retains canonical radio creation, saved stations and vote commands',()=>{
  const pair=generateKeyPairSync('ed25519');
  const creatorKey=pair.publicKey.export({format:'der',type:'spki'}).toString('base64');
  const station={id:'station-a',name:'Radio A',url:'https://example.com/live.mp3'};
  const selection={stations:[station],stationId:station.id};
  const frames=[
    {t:'createChannel',serverId:'srv-main',type:'radio',name:'Radio',radio:selection},
    {t:'radioChange',channelId:'radio',requestId:'change',radio:{creatorKey,...selection}},
    {t:'radioPropose',channelId:'radio',requestId:'proposal',station},
    {t:'radioApprove',channelId:'radio',requestId:'approval',voteId:'vote-1'},
  ];
  for(const frame of frames)assert.deepEqual(JSON.parse(cleanClientCommand(JSON.stringify({...frame,discarded:true}),parsePeerSignal)),frame);
});

test('Steam transports workspace identity and governance while stripping extra command fields',() => {
  const pair=generateKeyPairSync('ed25519');
  const memberKey=pair.publicKey.export({format:'der',type:'spki'}).toString('base64');
  const journal=createGovernance({version:1,roomId:randomUUID(),creatorKey:memberKey});
  const signature=sign(null,Buffer.from('identity'),pair.privateKey).toString('base64');
  const proof={t:'identityProof',nonce:'a'.repeat(64),memberKey,signature,governance:journal};
  assert.deepEqual(JSON.parse(cleanClientCommand(JSON.stringify({...proof,ignored:'x'.repeat(150001)}),parsePeerSignal)),proof);
  assert.throws(()=>cleanClientCommand(JSON.stringify({...proof,nonce:'invalid'}),parsePeerSignal),/nonce/);
  assert.throws(()=>cleanClientCommand(JSON.stringify({...proof,governance:{...journal,digest:'0'.repeat(64)}}),parsePeerSignal),/digest/);
  const command={type:/** @type {const} */ ('renameServer'),name:'Server'};
  const event={revision:1,previousDigest:journal.digest,actorKey:memberKey,command,signature:sign(null,Buffer.from(governancePayload(journal,memberKey,command)),pair.privateKey).toString('base64')};
  assert.deepEqual(JSON.parse(cleanClientCommand(JSON.stringify({t:'governanceChange',event:{...event,ignored:true}}),parsePeerSignal)),{t:'governanceChange',event});
  assert.deepEqual(JSON.parse(cleanClientCommand(JSON.stringify({t:'deleteMessage',channelId:'ch',messageId:'msg',extra:true}),parsePeerSignal)),{t:'deleteMessage',channelId:'ch',messageId:'msg'});
  assert.deepEqual(JSON.parse(cleanClientCommand(JSON.stringify({t:'disconnectVoice',userId:'u'}),parsePeerSignal)),{t:'disconnectVoice',userId:'u'});
  assert.deepEqual(JSON.parse(cleanClientCommand(JSON.stringify({t:'updateDomain',domainId:'domain',name:'Renamed'}),parsePeerSignal)),{t:'updateDomain',domainId:'domain',name:'Renamed'});
  assert.deepEqual(JSON.parse(cleanClientCommand(JSON.stringify({t:'claimOwner',token:'token',extra:true}),parsePeerSignal)),{t:'claimOwner',token:'token'});
});

test('room synchronization commands strip fields, verify real Ed25519 proofs and retain separate byte limits', () => {
  const pair = generateKeyPairSync('ed25519');
  const memberKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const descriptor = { version: /** @type {const} */ (1), roomId: randomUUID(), creatorKey: memberKey };
  const document = replica.createRoomDocument(descriptor, 0, [{ id: 'srv-main', name: 'Friends', icon: 'D', color: '#123abc', channels: [{ id: 'ch-voice', name: 'Lounge', type: 'voice', userLimit: 8 }] }]);
  const roundId = randomUUID();
  const signature = sign(null, Buffer.from(replica.roomVotePayload(roundId, memberKey, document, false)), pair.privateKey).toString('base64');
  const vote = { t: 'roomSyncVote', roundId, memberKey, document, signature, fresh: false };
  assert.deepEqual(JSON.parse(cleanClientCommand(JSON.stringify({ ...vote, padding: 'x'.repeat(150001) }), parsePeerSignal)), vote);
  assert.deepEqual(JSON.parse(cleanClientCommand(JSON.stringify({ t: 'roomSyncChoose', roundId, digest: document.digest, secret: 'strip' }), parsePeerSignal)), { t: 'roomSyncChoose', roundId, digest: document.digest });
  assert.throws(() => cleanClientCommand(JSON.stringify({ ...vote, fresh: true }), parsePeerSignal), /signature/);
  assert.throws(() => cleanClientCommand(JSON.stringify({ ...vote, roundId: randomUUID() }), parsePeerSignal), /signature/);
  assert.throws(() => cleanClientCommand(JSON.stringify({ ...vote, document: { ...document, roomId: randomUUID() } }), parsePeerSignal), /signature/);
  assert.throws(() => cleanClientCommand(JSON.stringify({ t: 'roomSyncChoose', roundId, digest: 'INVALID' }), parsePeerSignal), /digest/);
  assert.throws(() => cleanClientCommand(JSON.stringify({ ...vote, padding: 'x'.repeat(1024 * 1024) }), parsePeerSignal), /1048576-byte/);
  assert.throws(() => cleanClientCommand(JSON.stringify({ t: 'ping', ts: 1, padding: 'x'.repeat(150001) }), parsePeerSignal), /150000-byte/);
});

test('cleans every supported client command to its schema fields', () => {
  /** @type {Array<[string, JsonValue]>} */
  const commands = [
    ['{"t":"hello","name":"Pilot","color":"#12abEF","password":"","resumable":true,"extra":"drop"}',
      { t: 'hello', name: 'Pilot', color: '#12abEF', password: '', resumable: true }],
    ['{"t":"hello","name":"Pilot","color":"#12abEF","password":""}',
      { t: 'hello', name: 'Pilot', color: '#12abEF', password: '' }],
    ['{"t":"ping","ts":1700000000000,"extra":true}', { t: 'ping', ts: 1700000000000 }],
    ['{"t":"rename","name":"Pilot","color":"#12abEF","ignored":1}',
      { t: 'rename', name: 'Pilot', color: '#12abEF' }],
    ['{"t":"joinVoice","channelId":"ch-main","muted":false,"deafened":true,"extra":1}',
      { t: 'joinVoice', channelId: 'ch-main', muted: false, deafened: true }],
    ['{"t":"leaveVoice","extra":1}', { t: 'leaveVoice' }],
    ['{"t":"micState","muted":false,"deafened":true,"extra":1}',
      { t: 'micState', muted: false, deafened: true }],
    ['{"t":"refreshNetwork","extra":1}', { t: 'refreshNetwork' }],
    ['{"t":"chat","channelId":"ch-main","text":"hello","extra":1}',
      { t: 'chat', channelId: 'ch-main', text: 'hello' }],
    ['{"t":"createChannel","serverId":"srv-main","type":"voice","name":"Lounge","userLimit":8,"extra":1}',
      { t: 'createChannel', serverId: 'srv-main', type: 'voice', name: 'Lounge', userLimit: 8 }],
    ['{"t":"updateChannel","channelId":"ch-main","name":"Lounge","userLimit":8,"extra":1}',
      { t: 'updateChannel', channelId: 'ch-main', name: 'Lounge', userLimit: 8 }],
    ['{"t":"deleteChannel","channelId":"ch-main","extra":1}', { t: 'deleteChannel', channelId: 'ch-main' }],
    ['{"t":"createServer","name":"Friends","extra":1}', { t: 'createServer', name: 'Friends' }],
    ['{"t":"deleteServer","serverId":"srv-main","extra":1}', { t: 'deleteServer', serverId: 'srv-main' }],
  ];
  for (const [text, expected] of commands) {
    assert.deepEqual(JSON.parse(cleanClientCommand(text, parsePeerSignal)), expected);
  }
});

test('validates and canonicalizes actual WebRTC signals under the direct policy', () => {
  const offer = JSON.stringify({
    t: 'signal', to: 'u_target', extra: 'drop',
    data: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0\r\n' }, extra: 'drop' },
  });
  assert.deepEqual(JSON.parse(cleanClientCommand(offer, parsePeerSignal)), {
    t: 'signal', to: 'u_target', data: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0\r\n' } },
  });
  const ice = JSON.stringify({
    t: 'signal', to: 'u_target',
    data: { type: 'ice', candidate: { candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0, ignored: 'drop' } },
  });
  assert.deepEqual(JSON.parse(cleanClientCommand(ice, parsePeerSignal)), {
    t: 'signal', to: 'u_target',
    data: { type: 'ice', candidate: { candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } },
  });
  assert.throws(() => cleanClientCommand(JSON.stringify({
    t: 'signal', to: 'u_target',
    data: { type: 'ice', candidate: { candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ relay', sdpMid: '0', sdpMLineIndex: 0 } },
  }), parsePeerSignal), TypeError);
});

test('rejects malformed commands, invalid field types, and boundary overflow', () => {
  const invalid = [
    'null', '[]', '{', '{"t":"unknown"}', '{"t":"ping","ts":"123"}',
    '{"t":"hello","name":"Pilot","color":"red","password":""}',
    JSON.stringify({ t: 'hello', name: 'x'.repeat(25), color: '#123456', password: '' }),
    '{"t":"joinVoice","channelId":"room","muted":"false"}',
    '{"t":"micState","muted":false,"deafened":0}',
    '{"t":"signal","to":"u_target"}',
    JSON.stringify({ t: 'chat', channelId: 'ch', text: 'x'.repeat(2001) }),
    '{"t":"createChannel","serverId":"srv","type":"video","name":"Lounge"}',
    '{"t":"updateChannel","channelId":"ch"}',
    '{"t":"deleteServer"}',
  ];
  for (const text of invalid) assert.throws(() => cleanClientCommand(text, parsePeerSignal));
  assert.throws(() => cleanClientCommand(' '.repeat(150001), parsePeerSignal), /150000-byte/);
  assert.throws(() => cleanClientCommand('"😀"'.repeat(40000), parsePeerSignal), /150000-byte/);
});

test('enforces identifier and token bounds while allowing optional hello fields to be absent', () => {
  const hello = cleanClientCommand('{"t":"hello","name":"","color":"#123456","password":""}', parsePeerSignal);
  assert.deepEqual(JSON.parse(hello), { t: 'hello', name: '', color: '#123456', password: '' });
  const maxPassword = 'p'.repeat(256);
  assert.equal(JSON.parse(cleanClientCommand(JSON.stringify({
    t: 'hello', name: 'Pilot', color: '#123456', password: maxPassword,
  }), parsePeerSignal)).password, maxPassword);
  assert.throws(() => cleanClientCommand(JSON.stringify({ t: 'deleteServer', serverId: 'x'.repeat(81) }), parsePeerSignal));
  assert.throws(() => cleanClientCommand(JSON.stringify({
    t: 'hello', name: 'Pilot', color: '#123456', password: '', resumeToken: 'x'.repeat(257),
  }), parsePeerSignal));
  assert.throws(() => cleanClientCommand(JSON.stringify({
    t: 'hello', name: 'Pilot', color: '#123456', password: '', resumable: 'true',
  }), parsePeerSignal));
  assert.throws(() => cleanClientCommand(JSON.stringify({
    t: 'hello', name: 'Pilot', color: '#123456', password: 'p'.repeat(257),
  }), parsePeerSignal));
});
