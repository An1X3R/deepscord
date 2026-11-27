'use strict';

/**
 * Deepscord — 语音频道服务端
 * 零依赖：HTTP 静态资源 + 自实现 WebSocket（消息/信令/状态同步）
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { WebSocketServer } = require('./lib/ws');
const { openRoomStore } = require('./lib/room-store.cjs');
const { parseTrustedProxies, clientAddress, permittedUpgrade, createMessageBudget, passwordMatches, createAuthLimiter } = require('./lib/connection-policy.cjs');
const { validateAvatar, validateProfileId } = require('./lib/profile-avatar.cjs');
const { readNetworkPolicy, publicNetworkConfig, authenticatedNetworkConfig } = require('./lib/network-policy.cjs');
const { SessionTokenError, issueResumeToken, verifyResumeToken } = require('./lib/session-identity.cjs');
const { parseSteamStore, parseSteamUsers, stableSteamUserId, verifySteamIdentity,createSteamStateReader } = require('./lib/steam-state.cjs');
const steamStateReader = createSteamStateReader({ maxEntries:4,maxBytes:8 * 1024 * 1024 });
const { openRoomReplica, createRoomDocument } = require('./lib/room-replica.cjs');
const { createRoomSync } = require('./lib/room-sync.cjs');
const { openGovernanceStore,readJournal } = require('./lib/governance-store.cjs');
const { verifyIdentityProof } = require('./lib/server-identity.cjs');
const { openMediaStore } = require('./lib/media-store.cjs');
const { createMediaValidator,createEncryptedMediaValidator } = require('./lib/media-validator.cjs');
const { createRoomMedia,MediaError } = require('./lib/room-media.cjs');
const { createSteamMediaBackend } = require('./lib/steam-media-backend.cjs');
const { reactionActor,setMessageReaction,appendSealedReaction } = require('./lib/message-reactions.cjs');
const { collectChatAssets,collectContentAssets,assertChatBudget,policyMedia } = require('./lib/chat-assets.cjs');
const {createContentUpgrade}=require('./lib/content-upgrade.cjs');
const {parseSealedMessage,verifySealedMessage,inspectSealedFile,reactionRequestId}=require('./lib/content-crypto.cjs');
const { parseAttachment,parseChatMessage,parseMediaMetadata,mediaId,checkMediaKind } = require('./public/js/chat-protocol.js');
const {createRadioRoom}=require('./lib/radio-room.cjs');
const {parseRadioConfig}=require('./public/js/radio-protocol.js');
const {roleRank}=require('./public/js/member-permissions.js');
const { stateCanManageDomain,stateDomainRole,stateCanManageDomainRoles,assertStructurePermission,parseGovernanceCommand } = require('./lib/server-governance.cjs');
const { readScreenPolicy, publicScreenConfig, parseScreenRequest, ScreenSfuService, ScreenSfuError, reportScreenError } = require('./lib/screen-sfu.cjs');
const NETWORK_POLICY = readNetworkPolicy(process.env);
const SCREEN_POLICY = readScreenPolicy(process.env);
const screenSfu = SCREEN_POLICY.mode === 'sfu' ? new ScreenSfuService(SCREEN_POLICY, (id) => {
  const user = users.get(id);
  return user && user.conn && user.voiceChannelId ? { userId: user.id, channelId: user.voiceChannelId, sessionId: user.screenSessionId } : null;
}) : null;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.ECHO_DATA_DIR || path.join(ROOT, 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');
const CERT_DIR = path.join(ROOT, 'certs');
const SESSION_KEY_PATH = path.join(DATA_DIR, 'session.key');
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SESSION_KEY_PATH)) fs.writeFileSync(SESSION_KEY_PATH, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
const SESSION_KEY = fs.readFileSync(SESSION_KEY_PATH);
if (SESSION_KEY.length !== 32) throw new Error('Invalid session signing key: expected 32 bytes in session.key');
const SIGNAL_GRACE_MS = 120_000;
const suspendedUsers = new Map();
const STEAM_LOBBY_ID = process.env.ECHO_STEAM_LOBBY_ID || '';
const steamBridgeKey = process.env.ECHO_STEAM_BRIDGE_KEY || '';
if (Boolean(STEAM_LOBBY_ID) !== Boolean(steamBridgeKey) || (steamBridgeKey && (!/^[a-f0-9]{64}$/.test(steamBridgeKey) || !process.send))) throw new Error('Steam backend requires a private IPC channel and a 32-byte bridge key');
if (STEAM_LOBBY_ID) stableSteamUserId(STEAM_LOBBY_ID);
const STEAM_BRIDGE_KEY = steamBridgeKey ? Buffer.from(steamBridgeKey, 'hex') : null;

const HTTP_PORT = Number(process.env.PORT || process.env.HTTP_PORT || 3000);
const HTTP_HOST = process.env.HTTP_HOST || '0.0.0.0';
const HTTPS_PORTS = String(process.env.HTTPS_PORTS || process.env.HTTPS_PORT || 3443)
  .split(',')
  .map((s) => Number(String(s).trim()))
  .filter((n) => Number.isInteger(n) && n > 0);
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 300);
const MAX_TEXT = 2000;
const MAX_NAME = 24;
const MAX_CHANNELS = 40;
// 访问口令：设置了才启用（公网部署建议设置）
const ACCESS_PASSWORD = String(process.env.ECHO_PASSWORD || '');
const authFailures = createAuthLimiter(4096);
const trustedProxies = parseTrustedProxies(process.env.ECHO_TRUSTED_PROXIES || '');
const authSweep = setInterval(()=>authFailures.sweep(Date.now()),60000);
authSweep.unref();

const COLORS = [
  '#7c6cf5', '#4dd4ac', '#ff8a5c', '#4aa8ff', '#f25f8b',
  '#f5c451', '#8f7dff', '#3ecf8e', '#ff6b6b', '#59c7f0',
];

/* -------------------------------------------------------------------- */
/* 工具                                                                  */
/* -------------------------------------------------------------------- */

const now = () => Date.now();
const uid = (prefix) => `${prefix}-${crypto.randomBytes(5).toString('hex')}`;

function pickColor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

function cleanName(raw, fallback) {
  const s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
  return s || fallback;
}

function cleanChannelName(raw, fallback) {
  const s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
  return s || fallback;
}

function cleanText(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, MAX_TEXT);
}

function isColor(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}

/* -------------------------------------------------------------------- */
/* 持久化                                                                */
/* -------------------------------------------------------------------- */

function defaultStore() {
  return {
    version: 1,
    servers: [
      {
        id: 'srv-main',
        name: 'Deepscord',
        icon: 'D',
        color: '#7c6cf5',
        channels: [
          { id: 'ch-lobby', name: '大厅', type: 'voice', userLimit: 0 },
          { id: 'ch-squad', name: '开黑房', type: 'voice', userLimit: 8 },
          { id: 'ch-chat', name: '闲聊', type: 'text', userLimit: 0 },
          { id: 'ch-music', name: '音乐电台', type: 'text', userLimit: 0 },
        ],
      },
      {
        id: 'srv-night',
        name: '深夜电台',
        icon: '夜',
        color: '#3ecf8e',
        channels: [
          { id: 'ch-night-voice', name: '小房间', type: 'voice', userLimit: 0 },
          { id: 'ch-night-text', name: '树洞', type: 'text', userLimit: 0 },
        ],
      },
    ],
    messages: {
      'ch-chat': [
        {
          id: 'seed-1',
          userId: 'bot-deepscord',
          name: 'Deepscord 助手',
          color: '#4dd4ac',
          text: '欢迎来到 Deepscord 👋 点击语音频道加入通话，文字与图片请发到文字频道。',
          ts: now() - 1000 * 60 * 30,
          system: false,
          bot: true,
        },
        {
          id: 'seed-2',
          userId: 'bot-deepscord',
          name: 'Deepscord 助手',
          color: '#4dd4ac',
          text: '小提示：右下角齿轮可以选麦克风/扬声器、切换「语音感应」或「按键说话」。',
          ts: now() - 1000 * 60 * 29,
          system: false,
          bot: true,
        },
      ],
      'ch-night-text': [],
    },
  };
}

const roomStore = openRoomStore({ filename:STORE_PATH, initial:defaultStore() });
const store = roomStore.initial;
const roomReplica = openRoomReplica({ dataDir:DATA_DIR, environment:process.env, servers:store.servers });
const governanceSeedPath = process.env.ECHO_GOVERNANCE_SEED_PATH;
if (governanceSeedPath && !path.isAbsolute(governanceSeedPath)) throw new TypeError('ECHO_GOVERNANCE_SEED_PATH must be absolute');
const governance = openGovernanceStore({ dataDir:DATA_DIR,descriptor:roomReplica.descriptor,seed:governanceSeedPath ? readJournal(governanceSeedPath) : store.governance ?? null,authority:roomReplica.authority,signAuthority:roomReplica.signAuthority });
store.governance = governance.getJournal();
store.servers = roomReplica.getDocument().servers;
const initialChannelIds = new Set(store.servers.flatMap(server=>server.channels.map(channel=>channel.id)));
store.messages = Object.fromEntries(Object.entries(store.messages).filter(([id])=>initialChannelIds.has(id)));
const contentUpgrade=createContentUpgrade(roomReplica.descriptor.roomId);
/** @type {Set<string>} */
const migrationPins=new Set();

const mediaRoot=process.env.ECHO_MEDIA_ROOT || path.join(DATA_DIR,'media');
if(!path.isAbsolute(mediaRoot))throw new TypeError('ECHO_MEDIA_ROOT must be an absolute directory');
const mediaValidator=createMediaValidator({maxPending:4});
const encryptedMediaValidator=createEncryptedMediaValidator({roomId:roomReplica.descriptor.roomId});
const mediaStorage=openMediaStore({rootDir:mediaRoot,roomId:roomReplica.descriptor.roomId,validate:mediaValidator.validate,validateEncrypted:async(bytes,kind,signal)=>{
  const expected=store.content?.keyId || contentUpgrade.keyId();
  if(!expected||inspectSealedFile(bytes).header.keyId!==expected)throw new TypeError('Encrypted upload must use the active room content key');
  return encryptedMediaValidator.validate(bytes,kind,signal);
},limits:{rootBytes:512*1024*1024,roomBytes:256*1024*1024,stagingBytes:8*1024*1024,concurrentUploads:4,uploadTtlMs:60000,unpublishedTtlMs:300000}});
let mediaManifest=collectContentAssets(policyMedia(governance.getPolicy()),store.messages,store.content ?? null);
const roomMedia=createRoomMedia({storage:mediaStorage,getReferences:()=>[...new Set([...mediaManifest.assets.map(asset=>asset.sha256),...migrationPins])],getMigrationOwnerKey:()=>contentUpgrade.ownerKey(),canManage:key=>{const policy=governance.getPolicy();return key===policy.ownerKey || policy.serverAdmins?.includes(key)===true;}});
function refreshMediaReferences(){
  const next=collectContentAssets(policyMedia(governance.getPolicy()),store.messages,store.content ?? null);
  for(const asset of store.retainedReactionAssets ?? [])if(!next.assets.some(item=>item.sha256===asset.sha256)){next.assets.push(asset);next.history.push(asset.sha256);}
  mediaStorage.replaceReferences({catalog:next.catalog,history:next.history,backupPins:[...migrationPins]});
  mediaManifest=next;
}
refreshMediaReferences();
if(store.content)mediaStorage.purgeUnreferenced(store.content.assets.map(item=>item.source));
const steamMedia=STEAM_BRIDGE_KEY ? createSteamMediaBackend({key:STEAM_BRIDGE_KEY,storage:mediaStorage,manifest:()=>mediaManifest.assets,send:message=>process.send(message)}) : null;
const mediaGcTimer=setInterval(()=>{
  try{mediaStorage.collectGarbage();}
  catch(error){console.error('media_gc_failed',{roomId:roomReplica.descriptor.roomId,message:error.message});}
},60000);
mediaGcTimer.unref();

let saveTimer = null;
/** @param {import('./lib/steam-state.cjs').RoomStore} next @returns {void} */
function persistContentStore(next){
  roomStore.save(next);
  if(saveTimer){clearTimeout(saveTimer);saveTimer=null;}
}
function saveStoreSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    roomStore.save(store);
  }, 400);
  if (saveTimer.unref) saveTimer.unref();
}

function flushStore() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  roomStore.save(store);
}

/* -------------------------------------------------------------------- */
/* 运行时状态                                                            */
/* -------------------------------------------------------------------- */

/** @type {Map<string, any>} userId -> user */
const users = new Map();
/** @type {Map<any, string>} conn -> userId */
const connUser = new Map();
/** @type {Map<string, any>} channelId -> { [userId]: true } */
const voiceRooms = new Map();
/** @type {Map<string,string>} */
const roomMemberKeys = new Map();
/** @type {Map<string,string>} */
const serverMemberKeys = new Map();
/** Keep public identity for suspended users; only serverMemberKeys grants a live connection authority. @type {Map<string,string>} */
const knownMemberKeys = new Map();
/** @type {Set<string>} */
const voiceModeration = new Set();
/** @type {Map<string,{challenge:import('./lib/server-identity.cjs').IdentityChallenge,expiresAt:number}>} */
const identityChallenges = new Map();
/** @type {Map<string,{count:number,until:number}>} */
const ownerClaimAttempts = new Map();
const roomSync = createRoomSync({
  descriptor:roomReplica.descriptor,
  authority:roomReplica.authority,
  getDocument:roomReplica.getDocument,
  getMembers:()=>[...connUser.values()].map(id=>({ id, memberKey:roomMemberKeys.get(id) ?? null })),
  commit:commitRoomDocument,
  broadcast,
  onError:error=>{ console.error('room_sync_failed', { message:error.message }); broadcast({ t:'error', code:'room-sync-failed', message:error.message }); },
  settleMs:1200,
  validateDocument:(memberKey,document,current)=>{if(contentUpgrade.active())throw new TypeError('History encryption migration freezes room structure');assertStructurePermission(governance.getPolicy(),memberKey,current.servers,document.servers);},
});
let steamSnapshotTimer = null;

function sendSteamSnapshot() {
  if (!STEAM_BRIDGE_KEY || !process.send) return;
  if (steamSnapshotTimer) clearTimeout(steamSnapshotTimer);
  steamSnapshotTimer = null;
  const snapshot = { t: 'steam-state', store: steamStateReader.parseStore(store), users: parseSteamUsers([...users.values()].map(publicUser), store), roomDocument:roomReplica.getDocument() };
  process.send(snapshot, error => {
    if (!error) return;
    console.error('steam_snapshot_ipc_failed', { code: error.code, message: error.message });
    process.exit(1);
  });
}

function queueSteamSnapshot() {
  if (STEAM_BRIDGE_KEY && !steamSnapshotTimer) steamSnapshotTimer = setTimeout(sendSteamSnapshot, 100);
}

function expireSteamMember(steamId) {
  const id = stableSteamUserId(steamId);
  const user = users.get(id);
  if (!user) return;
  if (user.conn) { connUser.delete(user.conn); user.conn.close(1000, 'Steam lobby member left'); }
  roomMemberKeys.delete(id);
  serverMemberKeys.delete(id);
  roomMedia.dropActor(id);
  identityChallenges.delete(id);
  knownMemberKeys.delete(id);
  roomSync.membersChanged();
  if (suspendedUsers.has(id)) clearTimeout(suspendedUsers.get(id));
  suspendedUsers.delete(id);
  users.delete(id);
  const room = voiceRooms.get(user.voiceChannelId);
  if (room) { delete room[id]; if (Object.keys(room).length === 0) voiceRooms.delete(user.voiceChannelId); }
  broadcast({ t: 'userLeft', id, reason: 'lobby-left' });
  queueSteamSnapshot();
}

if (STEAM_BRIDGE_KEY) {
  const restoredPath = path.join(DATA_DIR, 'steam-users.json');
  if (fs.existsSync(restoredPath)) for (const user of parseSteamUsers(JSON.parse(fs.readFileSync(restoredPath, 'utf8')), store)) {
    users.set(user.id, { ...user, conn: null, joinedAt: now(), resumable: true, screenSessionId: crypto.randomBytes(24).toString('hex') });
    if (user.memberKey) knownMemberKeys.set(user.id,user.memberKey);
    if (user.voiceChannelId) { const room = voiceRooms.get(user.voiceChannelId) || {}; room[user.id] = true; voiceRooms.set(user.voiceChannelId, room); }
    const timer = setTimeout(() => expireSteamMember(user.id.slice('u_steam_'.length)), SIGNAL_GRACE_MS);
    timer.unref(); suspendedUsers.set(user.id, timer);
  }
  process.on('message', message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new TypeError('Invalid Steam backend IPC control');
    if (message.t === 'steam-snapshot') sendSteamSnapshot();
    else if(message.t==='steam-media-ready')steamMedia.receive(message);
    else if (message.t === 'steam-departed' && typeof message.steamId === 'string') expireSteamMember(message.steamId);
    else throw new TypeError('Unsupported Steam backend IPC control');
  });
  process.on('disconnect', () => shutdown());
  queueSteamSnapshot();
}

function findChannel(channelId) {
  for (const srv of store.servers) {
    const ch = srv.channels.find((c) => c.id === channelId);
    if (ch) return { server: srv, channel: ch };
  }
  return null;
}

function findServer(serverId) {
  return store.servers.find((s) => s.id === serverId) || null;
}

function isVoiceChannel(channelId) {
  const hit = findChannel(channelId);
  return !!(hit && hit.channel.type !== 'text');
}

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    color: u.color,
    profileId: u.profileId,
    avatar: u.avatar,
    muted: !!u.muted,
    serverMuted: isServerMuted(u),
    deafened: !!u.deafened,
    voiceChannelId: u.voiceChannelId || null,
    signalConnected: !!u.conn,
    memberKey:knownMemberKeys.get(u.id) ?? null,
  };
}

/** @param {{id:string,voiceChannelId:string|null}} user @returns {string|null} */
function voiceModerationKey(user) {
  const domainId=user.voiceChannelId ? findChannel(user.voiceChannelId)?.server.id : null;
  return domainId ? domainId+'\u0000'+(knownMemberKeys.get(user.id) ?? 'session:'+user.id) : null;
}

/** @param {{id:string,voiceChannelId:string|null}} user @returns {boolean} */
function isServerMuted(user) {const key=voiceModerationKey(user);return key!==null && voiceModeration.has(key);}

/** @param {{id:string}} user @param {string} targetId */
function requireVoiceModeration(user,targetId) {
  const target=users.get(targetId),hit=target?.voiceChannelId ? findChannel(target.voiceChannelId) : null;
  if(!target || !hit)throw new TypeError('该成员当前没有加入语音频道');
  if(target.id===user.id)throw new TypeError('不能对自己执行管理静音或移出语音');
  requireDomainPermission(user.id,hit.server.id,'moderateVoice');
  const policy=governance.getPolicy(),targetRole=stateDomainRole(policy,knownMemberKeys.get(target.id) ?? null,hit.server.id),actorRole=stateDomainRole(policy,verifiedMember(user.id),hit.server.id);
  if(roleRank(actorRole)>1 ? roleRank(actorRole)<=roleRank(targetRole) : roleRank(targetRole)>1)throw new TypeError('不能管理同级或更高管理身份的语音');
  return target;
}

/** @param {{id:string}} user @param {{userId:string,muted:boolean}} msg @returns {void} */
function onSetVoiceMute(user,msg) {
  const target=requireVoiceModeration(user,msg.userId),key=voiceModerationKey(target);
  if(typeof msg.muted!=='boolean' || key===null)throw new TypeError('管理静音需要明确的成员和布尔状态');
  if(msg.muted)voiceModeration.add(key);else voiceModeration.delete(key);
  broadcast({t:'userUpdated',user:publicUser(target)});
}

/** @param {string} userId @returns {import('./public/js/network-protocol.js').JsonValue} */
function serverState(userId) {
  const policy = governance.getPolicy();
  const selfKey = serverMemberKeys.get(userId) ?? null;
  /** @type {import('./lib/server-governance.cjs').DomainPermission[]} */
  const permissions = ['manageChannels','manageMessages','moderateVoice'];
  return {
    t:'serverState',server:{ id:roomReplica.descriptor.roomId,name:policy.name },
    journal:governance.getJournal(),policy,selfKey,ownerClaimAvailable:governance.claimAvailable(),content:store.content ?? null,contentMigrating:contentUpgrade.active(),
    capabilities:store.servers.map(domain=>({ domainId:domain.id,role:stateDomainRole(policy,selfKey,domain.id),permissions:permissions.filter(permission=>stateCanManageDomain(policy,selfKey,domain.id,permission)),manageRoles:stateCanManageDomainRoles(policy,selfKey,domain.id) })),
    members:[...users.keys()].map(id=>({ userId:id,memberKey:knownMemberKeys.get(id) ?? null })),
  };
}

function broadcastServerState() {
  for (const [connection,id] of connUser) send(connection,serverState(id));
}

function saveGovernance() {
  store.governance = governance.getJournal();
  refreshMediaReferences();
  saveStoreSoon();
  queueSteamSnapshot();
  broadcastServerState();
  roomSync.membersChanged();
}

/** @param {string} userId @returns {string} */
function verifiedMember(userId) {
  const key = serverMemberKeys.get(userId);
  if (!key) throw new TypeError('身份尚未验证，不能进行管理操作，请等待验证完成或重新连接');
  return key;
}

/** @param {string} userId @returns {void} */
function requireServerOwner(userId) {
  const policy=governance.getPolicy(),key=verifiedMember(userId);
  if(key!==policy.ownerKey && !policy.serverAdmins?.includes(key))throw new TypeError('只有服主或服务器管理员可以管理域');
}

/** @param {string} userId @param {string} domainId @param {import('./lib/server-governance.cjs').DomainPermission} permission @returns {void} */
function requireDomainPermission(userId,domainId,permission) {
  if (!stateCanManageDomain(governance.getPolicy(),verifiedMember(userId),domainId,permission)) throw new TypeError('你没有管理此域的权限：' + domainId + ' / ' + permission);
}

function onIdentityProof(user,msg) {
  const pending = identityChallenges.get(user.id);
  if (!pending || pending.expiresAt < Date.now()) throw new TypeError('身份验证已过期或已使用，请重新连接服务器');
  identityChallenges.delete(user.id);
  const memberKey = verifyIdentityProof(pending.challenge,msg);
  if ([...serverMemberKeys].some(([id,key])=>id !== user.id && key === memberKey && users.get(id)?.conn)) throw new TypeError('此身份已在另一个连接中使用');
  if(msg.governance!==undefined)assertChatBudget({...store,governance:msg.governance});
  if (msg.governance !== undefined && governance.restore(msg.governance)) saveGovernance();
  const priorModerationKey=voiceModerationKey(user),wasMuted=isServerMuted(user);
  serverMemberKeys.set(user.id,memberKey);
  knownMemberKeys.set(user.id,memberKey);
  if(wasMuted){const key=voiceModerationKey(user);if(key)voiceModeration.add(key);if(priorModerationKey && priorModerationKey!==key)voiceModeration.delete(priorModerationKey);}
  broadcast({t:'userUpdated',user:publicUser(user)});
  broadcastServerState();
}

function onGovernanceChange(user,msg) {
  const memberKey = verifiedMember(user.id);
  const requestId=msg.requestId===undefined ? null : mediaId(msg.requestId,'Governance request ID');
  if(msg.checkpointSignature!==undefined){
    if(typeof msg.checkpointSignature!=='string'||typeof msg.expectedDigest!=='string')throw new TypeError('Checkpoint approval requires a signature and expected digest');
    governance.compact(verifiedMember(user.id),msg.expectedDigest,msg.checkpointSignature);
    saveGovernance();
    if(requestId)send(user.conn,{t:'governanceResult',requestId,ok:true,result:{digest:governance.getJournal().digest}});
    return;
  }
  const current=governance.getJournal(),applied=current.events.find(event=>event.revision===msg.event?.revision);
  if(requestId && applied && msg.event?.actorKey===memberKey && applied.actorKey===memberKey && applied.signature===msg.event.signature && applied.previousDigest===msg.event.previousDigest && JSON.stringify(applied.command)===JSON.stringify(parseGovernanceCommand(msg.event.command))){
    if(requestId)send(user.conn,{t:'governanceResult',requestId,ok:true,result:{digest:current.digest}});
    return;
  }
  const command = msg.event?.command;
  if (command?.domainId && !findServer(command.domainId)) throw new TypeError('要管理的域已经不存在');
  if (command?.type === 'deleteDomain' && store.servers.length <= 1) throw new TypeError('至少保留一个域');
  if(command?.type==='putEmoji')checkMediaKind(roomMedia.authorizeAttachment({id:user.id,memberKey},command.asset),'server');
  if(command?.type==='putInteraction' && command.interaction?.thumbnail)checkMediaKind(roomMedia.authorizeAttachment({id:user.id,memberKey},command.interaction.thumbnail),'server');
  if(Buffer.byteLength(JSON.stringify(store))+Buffer.byteLength(JSON.stringify(msg.event))+2048>3*1024*1024)throw new RangeError('服务器同步资料达到容量限制，请先清理旧消息');
  governance.change(memberKey,msg.event);
  if (command?.type === 'deleteDomain') commitRoomStructure(store.servers.filter(domain=>domain.id !== command.domainId));
  saveGovernance();
  if(requestId)send(user.conn,{t:'governanceResult',requestId,ok:true,result:{digest:governance.getJournal().digest}});
}

function onClaimOwner(user,msg) {
  const key = verifiedMember(user.id);
  const previous = ownerClaimAttempts.get(key) ?? { count:0,until:0 };
  if (previous.until > Date.now()) throw new TypeError('认领尝试过多，请一分钟后重试');
  if (typeof msg.token !== 'string') throw new TypeError('请填写独立服务端的服主认领码');
  try { governance.claim(key,msg.token); }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const count = previous.count + 1;
    ownerClaimAttempts.set(key,{ count:count >= 5 ? 0 : count,until:count >= 5 ? Date.now() + 60_000 : 0 });
    throw error;
  }
  ownerClaimAttempts.delete(key);
  saveGovernance();
}

function send(conn, payload) {
  if (!conn) return;
  try {
    conn.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  } catch (_) {
    /* ignore */
  }
}

function broadcast(payload, exceptConn = null) {
  const data = JSON.stringify(payload);
  for (const [conn] of connUser) {
    if (conn === exceptConn) continue;
    try {
      conn.send(data);
    } catch (_) {
      /* ignore */
    }
  }
}

/** @param {import('./lib/room-replica.cjs').RoomDocument} document @param {string} reason @returns {void} */
function commitRoomDocument(document, reason) {
  if(contentUpgrade.active())throw new TypeError('History encryption migration freezes room structure');
  const saved = roomReplica.persist(document);
  store.servers = saved.servers;
  const channels = new Set(saved.servers.flatMap(server=>server.channels.map(channel=>channel.id)));
  const voiceChannels = new Set(saved.servers.flatMap(server=>server.channels.filter(channel=>channel.type !== 'text').map(channel=>channel.id)));
  store.messages = Object.fromEntries(Object.entries(store.messages).filter(([id])=>channels.has(id)));
  refreshMediaReferences();
  for (const user of users.values()) if (user.voiceChannelId && !voiceChannels.has(user.voiceChannelId)) leaveVoiceRoom(user, { reason:'room-sync' });
  saveStoreSoon();
  broadcast({ t: 'servers', servers: store.servers });
  broadcast({ t:'roomSyncCommit', document:saved, reason });
  broadcastServerState();
  queueSteamSnapshot();
}
/** @param {import('./lib/steam-state.cjs').RoomServer[]} servers @returns {void} */
function commitRoomStructure(servers) {
  const current = roomReplica.getDocument();
  commitRoomDocument(createRoomDocument(roomReplica.descriptor, current.revision + 1, servers), 'structure-change');
}

function appendMessage(channelId, message) {
  const list=[...(store.messages[channelId] || []),message].slice(-Math.min(300,HISTORY_LIMIT));
  const messages={...store.messages,[channelId]:list};
  assertChatBudget({...store,messages});
  collectContentAssets(policyMedia(governance.getPolicy()),messages,store.content ?? null);
  store.messages=messages;
  refreshMediaReferences();
  saveStoreSoon();
  queueSteamSnapshot();
  broadcast({ t: 'message', channelId, message });
}

function systemMessage(channelId, text) {
  if(store.content||contentUpgrade.active())return null;
  if (!findChannel(channelId)) return null;
  const msg = {
    id: uid('msg'),
    userId: 'system',
    name: '系统',
    color: '#8b90a0',
    text,
    ts: now(),
    system: true,
  };
  appendMessage(channelId, msg);
  return msg;
}

/* -------------------------------------------------------------------- */
/* WebSocket 事件                                                        */
/* -------------------------------------------------------------------- */

const radioRoom=createRadioRoom({
  getContext:()=>({
    channels:store.servers.flatMap(domain=>domain.channels.filter(channel=>channel.type==='radio').map(channel=>({channelId:channel.id,domainId:domain.id,radio:channel.radio}))),
    members:[...users.values()].filter(user=>user.conn && serverMemberKeys.has(user.id)).map(user=>({userId:user.id,memberKey:serverMemberKeys.get(user.id),channelId:user.voiceChannelId})),
    policy:governance.getPolicy(),
  }),
  commit:(channelId,radio)=>commitRoomStructure(store.servers.map(domain=>({...domain,channels:domain.channels.map(channel=>channel.id===channelId?{...channel,radio}:channel)}))),
  broadcast:state=>broadcast({t:'radioState',...state}),now:()=>Date.now(),
});
const radioVoteTimer=setInterval(()=>radioRoom.reconcile(),1000);
radioVoteTimer.unref();

const wss = new WebSocketServer();

wss.on('connection', (conn, req) => {
  conn._req = req;
  conn._joinedAt = now();
  conn._messageBudget = createMessageBudget(now());
  conn._helloTimer = setTimeout(()=>{if(!connUser.has(conn))conn.close(1008,'Room handshake timed out');},15000);
  conn._helloTimer.unref();
  conn.once('close',()=>clearTimeout(conn._helloTimer));

  conn.on('message', (data, isBinary) => {
    if (!conn._messageBudget.accept(Buffer.byteLength(data),now())) {
      console.warn('room_message_budget_exceeded',{userId:connUser.get(conn) ?? null});
      conn.close(1008,'Room message traffic exceeds its bounded budget');return;
    }
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (_) {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    const action = msg.t==='chat'||msg.t==='setReaction' ? 'chat' : ['governanceChange','claimOwner','createChannel','updateChannel','deleteChannel','createServer','deleteServer'].includes(msg.t) ? 'management' : null;
    if (action && !conn._messageBudget.action(action,now())) {
      const error=new RangeError('操作过于频繁，请稍后再试');
      if(['chat','setReaction','governanceChange'].includes(msg.t))chatFailure(conn,msg.t==='chat'?'chatResult':msg.t==='setReaction'?'reactionResult':'governanceResult',msg,error);
      else send(conn,{t:'error',code:'rate-limited',action:msg.t,message:error.message});
      return;
    }
    try {
      handleMessage(conn, msg);
    } catch (err) {
      console.error('room_command_failed',{ action:msg.t,userId:connUser.get(conn) ?? null,message:err.message });
      send(conn, { t: 'error',code:'server-command-failed',action:msg.t,message:'服务器执行 ' + msg.t + ' 失败：' + err.message });
    } finally {
      if (!['ping', 'signal', 'refreshNetwork'].includes(msg.t)) queueSteamSnapshot();
    }
  });

  conn.on('close', () => handleDisconnect(conn));
});

function handleDisconnect(conn) {
  queueSteamSnapshot();
  const userId = connUser.get(conn);
  connUser.delete(conn);
  if (!userId) return;
  if(contentUpgrade.drop(userId)){migrationPins.clear();refreshMediaReferences();broadcastServerState();}
  roomMemberKeys.delete(userId);
  serverMemberKeys.delete(userId);
  roomMedia.dropActor(userId);
  identityChallenges.delete(userId);
  if (!shuttingDown) roomSync.membersChanged();
  const user = users.get(userId);
  if (!user) return;
  if (user.conn !== conn) return;
  revokeScreenUser(userId);
  if (user.resumable) {
    user.conn = null;
    broadcast({ t: 'userConnection', id: userId, connected: false });
    const timer = setTimeout(() => {
      suspendedUsers.delete(userId);
      if (user.conn) return;
      users.delete(userId);
      knownMemberKeys.delete(userId);
      const room = voiceRooms.get(user.voiceChannelId);
      if (room) {
        delete room[userId];
        if (Object.keys(room).length === 0) voiceRooms.delete(user.voiceChannelId);
      }
      broadcast({ t: 'userLeft', id: userId, reason: 'signal-timeout' });
    }, SIGNAL_GRACE_MS);
    timer.unref();
    suspendedUsers.set(userId, timer);
    return;
  }
  users.delete(userId);
  knownMemberKeys.delete(userId);

  if (user.voiceChannelId) {
    leaveVoiceRoom(user, { reason: 'disconnect' });
  }
  broadcast({ t: 'userLeft', id: userId });
  console.log(`[ws] 离线 ${user.name} (${userId})`);
}

function requireUser(conn) {
  const id = connUser.get(conn);
  return id ? users.get(id) : null;
}

function handleMessage(conn, msg) {
  switch (msg.t) {
    case 'hello':
      return onHello(conn, msg);
    case 'ping':
      return send(conn, { t: 'pong', ts: msg.ts });
    default:
      break;
  }

  const user = requireUser(conn);
  if (!user) {
    send(conn, { t: 'error', message: '尚未完成握手' });
    return;
  }
  if(msg.t==='contentRequest')return onContentRequest(user,msg);
  if(contentUpgrade.active()&&!['mediaRequest','refreshNetwork','leaveVoice'].includes(msg.t)){
    const error=new TypeError('历史正在原地加密，请等待迁移完成后再操作');
    if(['chat','setReaction','governanceChange'].includes(msg.t))return chatFailure(conn,msg.t==='chat'?'chatResult':msg.t==='setReaction'?'reactionResult':'governanceResult',msg,error);
    send(conn,{t:'error',code:'content-migration-active',action:msg.t,message:error.message});return;
  }
  if(msg.t==='mediaRequest')return onMediaRequest(user,msg);
  if(['radioChange','radioPropose','radioApprove'].includes(msg.t)) {
    try {
      if(roomSync.pending())throw new TypeError('频道副本正在核对，请稍后再操作电台');
      const channelId=mediaId(msg.channelId,'Radio channel ID'),requestId=mediaId(msg.requestId,'Radio request ID');
      if(msg.t==='radioChange')radioRoom.change(user.id,channelId,msg.radio);
      else if(msg.t==='radioPropose')radioRoom.propose(user.id,channelId,msg.station);
      else radioRoom.approve(user.id,channelId,mediaId(msg.voteId,'Radio vote ID'));
      send(conn,{t:'radioResult',requestId,ok:true});
    } catch(error) {
      if(!(error instanceof TypeError) && !(error instanceof RangeError))throw error;
      console.warn('radio_action_rejected',{userId:user.id,action:msg.t,message:error.message});
      send(conn,{t:'radioResult',requestId:typeof msg.requestId==='string'?msg.requestId:'',ok:false,error:error.message});
    }
    return;
  }
  if(msg.t==='chat' || msg.t==='setReaction'){
    try{return msg.t==='chat' ? onChat(user,msg) : onSetReaction(user,msg);}
    catch(error){return chatFailure(user.conn,msg.t==='chat' ? 'chatResult' : 'reactionResult',msg,error);}
  }
  if (['identityProof','governanceChange','claimOwner','updateDomain','deleteMessage','disconnectVoice','setVoiceMute','createChannel','updateChannel','deleteChannel','createServer','deleteServer'].includes(msg.t)) {
    try {
      if (msg.t === 'identityProof') return onIdentityProof(user,msg);
      if (msg.t === 'governanceChange') return onGovernanceChange(user,msg);
      if (msg.t === 'claimOwner') return onClaimOwner(user,msg);
      if (msg.t === 'createServer' || msg.t === 'deleteServer') requireServerOwner(user.id);
      else if (msg.t === 'updateDomain') {
        const role = stateDomainRole(governance.getPolicy(),verifiedMember(user.id),String(msg.domainId || ''));
        if (role !== 'server-owner' && role !== 'server-admin' && role !== 'domain-owner') throw new TypeError('只有服主或此域的域主可以修改域名称');
      } else if (msg.t === 'disconnectVoice' || msg.t === 'setVoiceMute') {
        requireVoiceModeration(user,msg.userId);
        if(msg.t==='setVoiceMute' && typeof msg.muted!=='boolean')throw new TypeError('管理静音状态必须是布尔值');
      } else {
        const domain = msg.t === 'createChannel' ? findServer(String(msg.serverId || '')) : findChannel(String(msg.channelId || ''))?.server;
        if (!domain) throw new TypeError('要管理的域或频道已经不存在');
        requireDomainPermission(user.id,domain.id,msg.t === 'deleteMessage' ? 'manageMessages' : 'manageChannels');
        if(msg.t==='createChannel') {
          if(!['voice','text','radio'].includes(msg.type))throw new TypeError('频道类型必须为语音、文字或电台');
          if(msg.type==='radio')parseRadioConfig({...msg.radio,creatorKey:verifiedMember(user.id)});
        }
      }
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof RangeError) && !(error instanceof MediaError)) throw error;
      if(msg.t==='governanceChange' && msg.requestId!==undefined)return chatFailure(conn,'governanceResult',msg,error);
      console.warn('server_action_rejected',{ userId:user.id,action:msg.t,message:error.message });
      send(conn,{ t:'error',code:'permission-denied',action:msg.t,message:error.message });
      return;
    }
  }
  if (msg.t === 'roomSyncVote' || msg.t === 'roomSyncChoose') {
    try {
      if (msg.t === 'roomSyncVote') roomMemberKeys.set(user.id, roomSync.vote(user.id, msg));
      else roomSync.choose(user.id, msg);
    } catch (error) {
      console.warn('room_sync_input_rejected', { userId:user.id, type:msg.t, message:error.message });
      send(conn, { t:'error', code:'room-sync-rejected', message:error.message });
    }
    return;
  }
  if (roomSync.pending() && ['createChannel','updateChannel','deleteChannel','createServer','deleteServer','updateDomain'].includes(msg.t)) {
    send(conn, { t:'error', code:'room-sync-pending', message:'频道副本正在核对，请完成副本选择后再修改频道' });
    return;
  }

  switch (msg.t) {
    case 'rename':
      return onRename(user, msg);
    case 'joinVoice':
      return onJoinVoice(user, msg);
    case 'leaveVoice':
      return onLeaveVoice(user);
    case 'micState':
      return onMicState(user, msg);
    case 'signal':
      return onSignal(user, msg);
    case 'refreshNetwork':
      return send(conn, { t: 'networkConfig', config: clientConfig(user.id), resumeToken: issueResumeToken(SESSION_KEY, user.id, Math.floor(Date.now() / 1000)) });
    case 'screenSfuToken':
    case 'screenSfuRelease':
      return handleScreenSfu(user, msg);
    case 'chat':
      return onChat(user, msg);
    case 'createChannel':
      return onCreateChannel(user, msg);
    case 'updateChannel':
      return onUpdateChannel(user, msg);
    case 'deleteChannel':
      return onDeleteChannel(user, msg);
    case 'createServer':
      return onCreateServer(user, msg);
    case 'deleteServer':
      return onDeleteServer(user, msg);
    case 'updateDomain':
      return onUpdateDomain(user,msg);
    case 'deleteMessage':
      return onDeleteMessage(user,msg);
    case 'disconnectVoice':
      return leaveVoiceRoom(users.get(msg.userId),{ reason:'moderation' });
    case 'setVoiceMute':
      return onSetVoiceMute(user,msg);
    default:
      send(conn, { t: 'error', message: `未知消息类型: ${msg.t}` });
  }
}

function onHello(conn, msg) {
  if (connUser.has(conn)) return;
  if(contentUpgrade.active()){send(conn,{t:'error',code:'content-migration-active',message:'历史正在原地加密，请迁移完成后再加入'});conn.close(1013,'History encryption migration in progress');return;}
  if(store.content&&msg.contentVersion!==1){send(conn,{t:'error',code:'content-client-unsupported',message:'此房间已启用内容加密，请使用支持加密的 Windows 客户端'});conn.close(1008,'Encrypted room requires a supported client');return;}
  let profileId = null;
  let avatar = null;
  try {
    if (msg.profileId !== undefined) profileId = validateProfileId(msg.profileId);
    if (msg.avatar !== undefined) avatar = validateAvatar(msg.avatar);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    send(conn, { t: 'error', code: 'invalid-profile', message: error.message });
    return;
  }

  // ---- 访问口令校验 ----
  if (ACCESS_PASSWORD) {
    const ip = clientAddress(conn._req,trustedProxies);
    if (authFailures.blocked(ip,now())) {
      send(conn, { t: 'authFailed', message: '尝试次数过多，请一分钟后再试' });
      conn.close(1008, 'too many attempts');
      return;
    }
    if (!passwordMatches(ACCESS_PASSWORD,String(msg.password || ''))) {
      authFailures.failure(ip,now());
      send(conn, { t: 'authFailed', message: '访问口令不正确' });
      return;
    }
    authFailures.success(ip);
  }

  if (msg.resumable !== undefined && typeof msg.resumable !== 'boolean') {
    send(conn, { t: 'error', code: 'invalid-hello', message: 'resumable must be a boolean' });
    return;
  }
  let id = uid('u');
  if (STEAM_BRIDGE_KEY) {
    try { id = verifySteamIdentity(msg.steamIdentity, STEAM_BRIDGE_KEY, STEAM_LOBBY_ID); }
    catch (error) { console.warn('steam_backend_identity_rejected', { message: error.message }); send(conn, { t: 'authFailed', message: 'Steam 原生身份验证失败，请重新加入房间' }); conn.close(1008, 'Invalid Steam identity'); return; }
  } else if (msg.steamIdentity !== undefined) {
    send(conn, { t: 'authFailed', message: 'This server does not accept Steam bridge identities' }); return;
  } else if (msg.resumeToken !== undefined) {
    try {
      id = verifyResumeToken(SESSION_KEY, msg.resumeToken, Math.floor(Date.now() / 1000));
    } catch (error) {
      if (!(error instanceof SessionTokenError)) throw error;
      send(conn, { t: 'resumeRejected', code: error.code, message: '无法恢复原会话，请退出通话后重新加入' });
      return;
    }
  }
  const previous = users.get(id);
  if (previous && previous.conn) {
    send(conn, { t: 'resumeRejected', code: 'session_active', message: '该会话仍在另一条连接上使用，请稍后重试' });
    conn.close(1013, 'session still active');
    return;
  }
  if (suspendedUsers.has(id)) {
    clearTimeout(suspendedUsers.get(id));
    suspendedUsers.delete(id);
  }
  const name = cleanName(msg.name, `游客${crypto.randomInt(1000, 9999)}`);
  const color = isColor(msg.color) ? msg.color : pickColor(id);
  const user = {
    id,
    name,
    color,
    profileId,
    avatar,
    muted: previous ? previous.muted : false,
    deafened: previous ? previous.deafened : false,
    voiceChannelId: previous ? previous.voiceChannelId : null,
    joinedAt: now(),
    conn,
    resumable: msg.resumable === true,
    contentVersion:msg.contentVersion===1 ? 1 : 0,
    screenSessionId: crypto.randomBytes(24).toString('hex'),
  };
  users.set(id, user);
  connUser.set(conn, id);
  clearTimeout(conn._helloTimer);
  roomMemberKeys.delete(id);
  serverMemberKeys.delete(id);

  send(conn, {
    t: 'welcome',
    selfId: id,
    you: publicUser(user),
    users: [...users.values()].map(publicUser),
    servers: store.servers,
    roomDocument:roomReplica.getDocument(),
    messages: store.messages,
    content:store.content ?? null,
    governance:governance.getJournal(),
    config: clientConfig(id),
    resumeToken: issueResumeToken(SESSION_KEY, id, Math.floor(Date.now() / 1000)),
  });

  if (previous) broadcast({ t: 'userConnection', id, connected: true }, conn);
  broadcast({ t: 'userJoined', user: publicUser(user) }, conn);
  const challenge = { roomId:roomReplica.descriptor.roomId,creatorKey:roomReplica.descriptor.creatorKey,nonce:crypto.randomBytes(32).toString('hex'),userId:id };
  identityChallenges.set(id,{ challenge,expiresAt:Date.now() + 60_000 });
  send(conn,{ t:'identityChallenge',...challenge });
  broadcastServerState();
  for(const radioState of radioRoom.snapshot())send(conn,{t:'radioState',...radioState});
  console.log(`[ws] 上线 ${name} (${id})`);
  roomSync.membersChanged();
}

function onRename(user, msg) {
  const name = cleanName(msg.name, user.name);
  let avatar = user.avatar;
  let profileId = user.profileId;
  try {
    if (msg.avatar !== undefined) avatar = validateAvatar(msg.avatar);
    if (msg.profileId !== undefined) profileId = validateProfileId(msg.profileId);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    send(user.conn, { t: 'error', code: 'invalid-profile', message: error.message });
    return;
  }
  const color = isColor(msg.color) ? msg.color : user.color;
  if (name === user.name && color === user.color && avatar === user.avatar && profileId === user.profileId) return;
  user.name = name;
  user.color = color;
  user.avatar = avatar;
  user.profileId = profileId;
  broadcast({ t: 'userUpdated', user: publicUser(user) });
}

function onJoinVoice(user, msg) {
  const channelId = String(msg.channelId || '');
  const hit = findChannel(channelId);
  if (!hit || hit.channel.type === 'text') {
    send(user.conn, { t: 'error', action: 'joinVoice', channelId, message: '语音频道不存在' });
    return;
  }
  if (user.voiceChannelId === channelId) {
    send(user.conn, { t: 'voicePeers', channelId, peers: roomPeers(channelId, user.id), serverMuted:isServerMuted(user) });
    return;
  }

  // 容量校验（userLimit 0 = 不限）
  const limit = Number(hit.channel.userLimit) || 0;
  const roomBefore = voiceRooms.get(channelId) || {};
  const current = Object.keys(roomBefore).filter((id) => users.has(id)).length;
  if (limit > 0 && current >= limit) {
    send(user.conn, { t: 'error', action: 'joinVoice', channelId, message: `「${hit.channel.name}」人数已满（${current}/${limit}）` });
    return;
  }

  if (user.voiceChannelId) {
    leaveVoiceRoom(user, { reason: 'switch' });
  }

  user.voiceChannelId = channelId;
  user.muted = !!msg.muted;
  user.deafened = !!msg.deafened;

  const room = voiceRooms.get(channelId) || {};
  room[user.id] = true;
  voiceRooms.set(channelId, room);

  const peers = roomPeers(channelId, user.id);
  const channelName = hit.channel.name;

  systemMessage(channelId, `${user.name} 加入了语音频道`);
  broadcast({ t: 'voiceState', userId: user.id, channelId, muted: user.muted, deafened: user.deafened, serverMuted:isServerMuted(user) });
  send(user.conn, { t: 'voicePeers', channelId, peers, serverMuted:isServerMuted(user) });
  console.log(`[voice] ${user.name} 加入「${channelName}」，已有 ${peers.length} 人`);
}

function roomPeers(channelId, excludeId) {
  const room = voiceRooms.get(channelId) || {};
  return Object.keys(room)
    .filter((id) => id !== excludeId && users.has(id))
    .map((id) => publicUser(users.get(id)));
}

function onLeaveVoice(user) {
  if (!user.voiceChannelId) return;
  leaveVoiceRoom(user, { reason: 'leave' });
  broadcast({ t: 'voiceState', userId: user.id, channelId: null, serverMuted:false });
}

function leaveVoiceRoom(user, opts = {}) {
  const channelId = user.voiceChannelId;
  if (!channelId) return;
  revokeScreenUser(user.id);
  const room = voiceRooms.get(channelId);
  if (room) {
    delete room[user.id];
    if (Object.keys(room).length === 0) voiceRooms.delete(channelId);
  }
  user.voiceChannelId = null;
  if (opts.reason !== 'disconnect') {
    systemMessage(channelId, `${user.name} 离开了语音频道`);
  }
  broadcast({ t: 'voiceState', userId: user.id, channelId: null, serverMuted:false });
}

function revokeScreenUser(userId) {
  if (screenSfu) screenSfu.revokeUser(userId).catch((error) => reportScreenError(error, 'revoke-membership'));
}

async function handleScreenSfu(user, msg) {
  const connection = user.conn;
  const response = { t: msg.t, requestId: typeof msg.requestId === 'string' ? msg.requestId.slice(0, 80) : '', channelId: typeof msg.channelId === 'string' ? msg.channelId : '', sourceUserId: typeof msg.sourceUserId === 'string' ? msg.sourceUserId : '' };
  try {
    const request = parseScreenRequest(msg);
    if (!screenSfu) throw new ScreenSfuError('sfu-disabled', 'This room server uses peer-relay screens', 409);
    if (msg.t === 'screenSfuRelease') {
      await screenSfu.release(user.id, request);
      if (user.conn === connection) send(connection, { ...response, ok: true });
    } else {
      const credential = await screenSfu.issue(user.id, request);
      if (user.conn === connection) send(connection, { ...response, ...credential });
    }
  } catch (error) {
    reportScreenError(error, msg.t);
    if (user.conn === connection) send(connection, { ...response, error: { code: error instanceof ScreenSfuError ? error.code : 'sfu-service-failed', message: error instanceof ScreenSfuError ? error.message : 'The private screen media service failed; contact the room administrator' } });
  }
}

function onMicState(user, msg) {
  let changed = false;
  if (typeof msg.muted === 'boolean' && user.muted !== msg.muted) {
    user.muted = msg.muted;
    changed = true;
  }
  if (typeof msg.deafened === 'boolean' && user.deafened !== msg.deafened) {
    user.deafened = msg.deafened;
    changed = true;
  }
  if (changed) broadcast({ t: 'userUpdated', user: publicUser(user) });
}

function onSignal(user, msg) {
  const to = String(msg.to || '');
  const target = users.get(to);
  if (!target || !target.voiceChannelId) return;
  // 只允许同一语音频道内互发信令
  if (target.voiceChannelId !== user.voiceChannelId) return;
  send(target.conn, { t: 'signal', from: user.id, data: msg.data });
}

function onChat(user, msg) {
  const channelId = mediaId(msg.channelId,'Chat channel');
  const hit = findChannel(channelId);
  if (!hit || hit.channel.type!=='text') throw new TypeError('消息只能发送到文字频道');
  const requestId=msg.requestId===undefined ? null : mediaId(msg.requestId,'Chat request ID');
  const authorId=requestId ? reactionActor(verifiedMember(user.id)) : null;
  if(store.content && msg.replyToId!==undefined)throw new TypeError('Encrypted chat cannot contain an outer reply message ID');
  const replyToId=msg.replyToId===undefined ? undefined : mediaId(msg.replyToId,'Reply message ID');
  const previous=requestId ? (store.messages[channelId] || []).find(message=>message.clientRequestId===requestId && message.authorId===authorId) : null;
  if(previous){send(user.conn,{t:'chatResult',requestId,ok:true,result:{message:previous}});return;}
  const text = cleanText(msg.text);
  const sealed=msg.sealed===undefined?null:parseSealedMessage(msg.sealed);
  if(store.content){
    if(!sealed||!requestId||sealed.keyId!==store.content.keyId||sealed.memberKey!==verifiedMember(user.id)||text||msg.replyToId!==undefined)throw new TypeError('加密房间的消息必须由当前身份使用房间密钥签名且不能携带明文');
    verifySealedMessage({roomId:roomReplica.descriptor.roomId,channelId,requestId},sealed);
  }else if(sealed)throw new TypeError('请先完成历史迁移后再发送加密消息');
  const attachment=msg.attachment===undefined ? null : parseAttachment(msg.attachment);
  if(attachment&&Boolean(store.content)!==(attachment.encrypted===true))throw new TypeError('附件的加密状态必须与房间一致');
  if(attachment)roomMedia.authorizeAttachment({id:user.id,memberKey:serverMemberKeys.get(user.id) ?? null},attachment);
  if (!text && !attachment && !sealed) throw new TypeError('消息需要文字或图片');
  const message = {
    id: uid('msg'),
    userId: user.id,
    name: user.name,
    color: user.color,
    text,
    ts: now(),
    system: false,
    ...(attachment ? {attachment:{...attachment,...(store.content?{name:'encrypted.avif'}:{})}} : {}),
    ...(sealed?{sealed}:{}),
    ...(replyToId===undefined?{}:{replyToId}),
    ...(requestId ? {clientRequestId:requestId,authorId} : {}),
  };
  appendMessage(channelId, message);
  if(requestId)send(user.conn,{t:'chatResult',requestId,ok:true,result:{message}});
}

function chatFailure(conn,type,msg,error){
  if(!(error instanceof Error))throw new TypeError('Chat operation raised a non-error failure',{cause:error});
  console.warn('chat_operation_rejected',{operation:msg.t,requestId:msg.requestId,code:error instanceof MediaError ? error.code : 'media-invalid',message:error.message,cause:error.cause instanceof Error ? error.cause.message : null});
  send(conn,{t:type,requestId:typeof msg.requestId==='string' ? msg.requestId.slice(0,80) : '',ok:false,code:error instanceof MediaError ? error.code : 'media-invalid',message:error.message,retryAfterMs:error instanceof MediaError ? error.retryAfterMs : null});
}
function onContentRequest(user,msg){
  const requestId=mediaId(msg.requestId,'Content request');
  try{
    requireServerOwner(user.id);
    let result;
    if(msg.op==='begin'){
      if([...users.values()].some(member=>member.voiceChannelId))throw new TypeError('请所有成员先退出语音后再迁移历史');
      if(roomSync.pending())throw new TypeError('请等待频道副本核对完成后再迁移历史');
      if(mediaStorage.stats().activeUploads||mediaStorage.stats().validations)throw new TypeError('请等待当前文件上传完成后再迁移历史');
      result=contentUpgrade.begin({ownerId:user.id,ownerKey:verifiedMember(user.id),keyId:msg.keyId,store,assets:mediaManifest.assets});
      try{persistContentStore(store);}
      catch(error){contentUpgrade.cancel(user.id,result.migrationId);throw error;}
      broadcastServerState();
    }else{
      const migrationId=mediaId(msg.migrationId,'Content migration');
      if(msg.op==='read')result=contentUpgrade.read(user.id,migrationId,msg.index);
      else if(msg.op==='replace'){
        if(msg.attachment!==undefined)roomMedia.authorizeAttachment({id:user.id,memberKey:verifiedMember(user.id)},msg.attachment);
        result=contentUpgrade.replace(user.id,{migrationId,channelId:mediaId(msg.channelId,'Content channel'),messageId:mediaId(msg.messageId,'Content message'),sealed:msg.sealed,...(msg.attachment===undefined?{}:{attachment:msg.attachment})});
      }else if(msg.op==='cancel'){
        contentUpgrade.cancel(user.id,migrationId);migrationPins.clear();refreshMediaReferences();broadcastServerState();result={cancelled:true};
      }else if(msg.op==='commit'){
        const previousHashes=mediaManifest.assets.map(asset=>asset.sha256);
        const next=contentUpgrade.prepare(user.id,migrationId,msg.policy,verifiedMember(user.id),asset=>{
          const actual=mediaStorage.metadata(asset.sha256);
          if(!actual||JSON.stringify(parseMediaMetadata(actual))!==JSON.stringify(asset))throw new TypeError('Encrypted history file is missing or its metadata differs from the signed policy');
          const chunks=[];
          for(let offset=0;offset<asset.bytes;offset+=16384)chunks.push(mediaStorage.readRange(asset.sha256,offset,Math.min(16384,asset.bytes-offset)));
          const envelope=inspectSealedFile(Buffer.concat(chunks));
          if(envelope.header.roomId!==roomReplica.descriptor.roomId||envelope.header.keyId!==contentUpgrade.keyId())throw new TypeError('Encrypted history file uses another room or key');
        });
        const parsed=parseSteamStore(next);assertChatBudget(parsed);
        collectContentAssets(policyMedia(governance.getPolicy()),parsed.messages,parsed.content);
        persistContentStore(parsed);
        Object.assign(store,parsed);
        contentUpgrade.cancel(user.id,migrationId);migrationPins.clear();refreshMediaReferences();
        queueSteamSnapshot();broadcastServerState();
        mediaStorage.purgeUnreferenced(previousHashes);
        result={content:store.content};
      }else throw new TypeError('Unsupported history encryption migration operation');
    }
    send(user.conn,{t:'contentResult',requestId,ok:true,result});
    if(msg.op==='commit')for(const [connection,id] of connUser){
      if(users.get(id)?.contentVersion!==1){send(connection,{t:'error',code:'content-client-unsupported',message:'历史加密已启用，请使用支持内容加密的 Windows 客户端重新加入'});connection.close(1008,'Encrypted room requires a supported client');}
    }
  }catch(error){
    if(!(error instanceof Error))throw new TypeError('History encryption migration raised a non-error failure',{cause:error});
    console.warn('content_upgrade_rejected',{operation:msg.op,requestId,message:error.message,activated:Boolean(store.content)});
    send(user.conn,{t:'contentResult',requestId,ok:false,code:'content-upgrade-failed',message:error.message,activated:Boolean(store.content)});
  }
}
async function onMediaRequest(user,msg){
  try{
    if(contentUpgrade.active()&&!['info','read'].includes(msg.op)&&contentUpgrade.ownerId()!==user.id)throw new TypeError('迁移期间只有服主可以上传加密替换文件');
    if(msg.op==='begin'&&Boolean(store.content||contentUpgrade.active())!==(msg.encrypted===true))throw new TypeError('上传文件的加密状态必须与房间一致');
    let result;
    try{result=await roomMedia.execute({id:user.id,memberKey:serverMemberKeys.get(user.id) ?? null},msg);}
    catch(error){
      if(!(error instanceof MediaError) || error.code!=='media-unavailable' || !steamMedia || !['info','read'].includes(msg.op))throw error;
      try{await steamMedia.ensure(msg.sha256);}
      catch(cause){throw new MediaError('media-unavailable','此图片的保存副本暂时不可用，请等待持有副本的成员上线',null,cause instanceof Error ? cause : null);}
      result=await roomMedia.execute({id:user.id,memberKey:serverMemberKeys.get(user.id) ?? null},msg);
    }
    if(contentUpgrade.ownerId()===user.id&&result.asset?.encrypted===true){migrationPins.add(result.asset.sha256);refreshMediaReferences();}
    if(user.conn)send(user.conn,{t:'mediaResult',requestId:msg.requestId,ok:true,result});
  }catch(error){chatFailure(user.conn,'mediaResult',msg,error);}
}
function onSetReaction(user,msg){
  const requestId=mediaId(msg.requestId,'Reaction request'),channelId=mediaId(msg.channelId,'Reaction channel'),messageId=mediaId(msg.messageId,'Reaction message');
  const entries=store.messages[channelId] || [],old=entries.find(message=>message.id===messageId);
  if(!old)throw new TypeError('这条消息已不存在');
  let next;
  if(store.content){
    if(msg.selection!==undefined||msg.active!==undefined)throw new TypeError('Encrypted reactions cannot contain plaintext choices');
    const sealed=parseSealedMessage(msg.sealed);
    if(sealed.memberKey!==verifiedMember(user.id)||sealed.keyId!==store.content.keyId)throw new TypeError('Encrypted reaction identity or key differs from its room');
    verifySealedMessage({roomId:roomReplica.descriptor.roomId,channelId,requestId:reactionRequestId(messageId,requestId)},sealed);
    next=appendSealedReaction(parseChatMessage(old),{requestId,sealed});
  }else{if(msg.sealed!==undefined)throw new TypeError('Plain room does not accept encrypted reactions');next=setMessageReaction(parseChatMessage(old),{memberKey:verifiedMember(user.id),selection:msg.selection,active:msg.active},governance.getPolicy().emojis ?? []);}
  const changed=JSON.stringify(next)!==JSON.stringify(old);
  if(changed){
    const messages={...store.messages,[channelId]:entries.map(message=>message.id===messageId ? next : message)};
    const retainedReactionAssets=store.content?[...new Map([...(store.retainedReactionAssets ?? []),...(governance.getPolicy().emojis ?? []).map(emoji=>store.content.assets.find(item=>item.source===emoji.asset.sha256)?.asset ?? emoji.asset)].map(asset=>[asset.sha256,asset])).values()]:undefined;
    if(retainedReactionAssets&&retainedReactionAssets.length>4096)throw new RangeError('Encrypted reaction media retention reached 4096 files');
    assertChatBudget({...store,messages,...(retainedReactionAssets?{retainedReactionAssets}:{})});collectChatAssets(policyMedia(governance.getPolicy()),messages);
    if(retainedReactionAssets)store.retainedReactionAssets=retainedReactionAssets;
    store.messages=messages;refreshMediaReferences();saveStoreSoon();queueSteamSnapshot();
    broadcast(store.content?{t:'messageReactions',channelId,messageId,message:next}:{t:'messageReactions',channelId,messageId,reactions:next.reactions ?? [],revision:next.reactionRevision ?? 0});
  }
  send(user.conn,{t:'reactionResult',requestId,ok:true,result:{message:next}});
}

function onCreateChannel(user, msg) {
  const server = findServer(String(msg.serverId || ''));
  if (!server) return;
  const type = msg.type;
  if (server.channels.length >= MAX_CHANNELS) {
    send(user.conn, { t: 'error', message: '频道数量已达上限' });
    return;
  }
  const name = cleanChannelName(msg.name, type==='radio' ? '新电台频道' : type === 'voice' ? '新语音频道' : '新文字频道');
  let userLimit = 0;
  if (type !== 'text' && msg.userLimit != null) {
    const n = Number(msg.userLimit);
    if (Number.isFinite(n)) userLimit = Math.max(0, Math.min(100, Math.floor(n)));
  }
  const channel = {id:uid('ch'),name,type,userLimit,...(type==='radio'?{radio:parseRadioConfig({...msg.radio,creatorKey:verifiedMember(user.id)})}:{})};
  const channels = [...server.channels];
  if (type !== 'text') {
    const idx = channels.findIndex((c) => c.type === 'text');
    if (idx === -1) channels.push(channel);
    else channels.splice(idx, 0, channel);
  } else {
    channels.push(channel);
  }
  commitRoomStructure(store.servers.map(entry=>entry.id === server.id ? { ...entry, channels } : entry));
  console.log(`[频道] ${user.name} 创建「${name}」(${type}${userLimit ? '，上限 ' + userLimit + ' 人' : ''})`);
}

function onUpdateChannel(user, msg) {
  const channelId = String(msg.channelId || '');
  const hit = findChannel(channelId);
  if (!hit) return;
  const channel = hit.channel;
  const prevName = channel.name;
  const nextName = msg.name != null ? cleanChannelName(msg.name, channel.name) : channel.name;
  let nextLimit = Number(channel.userLimit) || 0;
  if (channel.type !== 'text' && msg.userLimit != null) {
    const n = Number(msg.userLimit);
    if (Number.isFinite(n)) nextLimit = Math.max(0, Math.min(100, Math.floor(n)));
  }
  if (nextName === channel.name && nextLimit === (Number(channel.userLimit) || 0)) return;
  commitRoomStructure(store.servers.map(server=>({ ...server, channels:server.channels.map(entry=>entry.id === channelId ? { ...entry, name:nextName, userLimit:nextLimit } : entry) })));
  console.log(`[频道] ${user.name} 编辑「${prevName}」→「${nextName}」${nextLimit ? '，上限 ' + nextLimit + ' 人' : ''}`);
}

function onDeleteChannel(user, msg) {
  const channelId = String(msg.channelId || '');
  for (const srv of store.servers) {
    const idx = srv.channels.findIndex((c) => c.id === channelId);
    if (idx === -1) continue;
    if (srv.channels.length <= 1) {
      send(user.conn, { t: 'error', message: '至少保留一个频道' });
      return;
    }
    const removed = srv.channels[idx];
    commitRoomStructure(store.servers.map(server=>server.id === srv.id ? { ...server, channels:server.channels.filter(channel=>channel.id !== channelId) } : server));
    console.log(`[频道] ${user.name} 删除「${removed.name}」`);
    return;
  }
}

function onCreateServer(user, msg) {
  if (store.servers.length >= 12) {
    send(user.conn, { t: 'error', message: '域数量已达上限' });
    return;
  }
  const name = cleanChannelName(msg.name, '新域');
  const server = {
    id: uid('srv'),
    name,
    icon: [...name][0] || '新',
    color: COLORS[crypto.randomInt(0, COLORS.length)],
    channels: [
      { id: uid('ch'), name: '大厅', type: 'voice', userLimit: 0 },
      { id: uid('ch'), name: '闲聊', type: 'text', userLimit: 0 },
    ],
  };
  commitRoomStructure([...store.servers, server]);
  console.log(`[服务器] ${user.name} 创建「${name}」`);
}

function onDeleteServer(user, msg) {
  const serverId = String(msg.serverId || '');
  if (governance.getPolicy().domains.some(domain=>domain.id === serverId)) {
    send(user.conn,{ t:'error',code:'signed-domain-delete-required',message:'此域包含权限配置，请使用新版“删除域”操作同时撤销其权限资料' });
    return;
  }
  if (store.servers.length <= 1) {
    send(user.conn, { t: 'error', message: '至少保留一个域' });
    return;
  }
  const idx = store.servers.findIndex((s) => s.id === serverId);
  if (idx === -1) return;
  const removed = store.servers[idx];
  commitRoomStructure(store.servers.filter(server=>server.id !== serverId));
  console.log(`[服务器] ${user.name} 删除「${removed.name}」`);
}

function onUpdateDomain(user,msg) {
  const domain = findServer(String(msg.domainId || ''));
  if (!domain) return;
  const name = cleanChannelName(msg.name,domain.name);
  commitRoomStructure(store.servers.map(item=>item.id === domain.id ? { ...item,name,icon:[...name][0] } : item));
}

function onDeleteMessage(user,msg) {
  const channelId = String(msg.channelId || '');
  const messages = store.messages[channelId] || [];
  if (!messages.some(message=>message.id === msg.messageId)) return;
  store.messages[channelId] = messages.filter(message=>message.id !== msg.messageId);
  refreshMediaReferences();
  saveStoreSoon();
  queueSteamSnapshot();
  broadcast({ t:'messageDeleted',channelId,messageId:msg.messageId });
}

/* -------------------------------------------------------------------- */
/* 静态资源 + HTTP API                                                   */
/* -------------------------------------------------------------------- */

const MIME = {
  '.avif':'image/avif',
  '.wasm':'application/wasm',
  '.wav': 'audio/wav',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function publicConfig() {
  return { ...publicNetworkConfig(NETWORK_POLICY), screen: publicScreenConfig(SCREEN_POLICY), requirePassword: !!ACCESS_PASSWORD };
}

function clientConfig(userId) {
  return {
    ...authenticatedNetworkConfig(NETWORK_POLICY, userId, Math.floor(Date.now() / 1000)),
    screen: publicScreenConfig(SCREEN_POLICY),
    requirePassword: !!ACCESS_PASSWORD,
  };
}

function serveStatic(req, res) {
  if(req.url==='/api/steam-media' && steamMedia){steamMedia.handle(req,res).catch(error=>{console.error('steam_media_http_failed',{message:error.message});res.destroy();});return;}
  if (screenSfu && screenSfu.isGateway(req)) {
    screenSfu.handleHttp(req, res).catch((error) => { reportScreenError(error, 'signal-http'); res.destroy(); });
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (_) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ok: true,
        networkMode: NETWORK_POLICY.networkMode,
        instanceId: process.env.ECHO_INSTANCE_ID || null,
        users: users.size,
        voiceRooms: voiceRooms.size,
        uptime: Math.round(process.uptime()),
      })
    );
    return;
  }
  if (pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(publicConfig()));
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath)
      .on('error', () => {
        try {
          res.destroy();
        } catch (_) {
          /* ignore */
        }
      })
      .pipe(res);
  });
}

function attachWebSocket(server) {
  server.on('upgrade', (req, socket, head) => {
    if (screenSfu && screenSfu.isGateway(req)) {
      screenSfu.handleUpgrade(req, socket, head).catch((error) => { reportScreenError(error, 'signal-upgrade'); socket.destroy(); });
      return;
    }
    try {
      if (!permittedUpgrade(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
      wss.handleUpgrade(req, socket, head);
    } catch (err) {
      console.error('[ws] 升级失败:', err.message);
      try {
        socket.destroy();
      } catch (_) {
        /* ignore */
      }
    }
  });
}

function networkUrls(protocol, port) {
  const urls = [`${protocol}://localhost:${port}`];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) {
        urls.push(`${protocol}://${info.address}:${port}`);
      }
    }
  }
  return urls;
}

/* -------------------------------------------------------------------- */
/* 启动                                                                  */
/* -------------------------------------------------------------------- */

const httpServer = http.createServer(serveStatic);
attachWebSocket(httpServer);

const certPath = path.join(CERT_DIR, 'server.crt');
const keyPath = path.join(CERT_DIR, 'server.key');
let httpsError = null;
let certOptions = null;
const httpsServers = [];

if (process.env.ECHO_TLS_PFX_PATH) {
  certOptions = {
    pfx: fs.readFileSync(process.env.ECHO_TLS_PFX_PATH),
    passphrase: process.env.ECHO_TLS_PFX_PASSWORD || '',
  };
} else if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  try {
    certOptions = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    };
  } catch (err) {
    httpsError = err.message;
  }
}

if (certOptions) {
  for (const port of HTTPS_PORTS) {
    const srv = https.createServer(certOptions, serveStatic);
    attachWebSocket(srv);
    httpsServers.push({ port, server: srv });
  }
}

httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log('');
  console.log('  Deepscord · 语音频道服务器已启动');
  console.log('  ------------------------------------');
  console.log('  HTTP:');
  for (const url of networkUrls('http', HTTP_PORT)) console.log(`    ${url}`);
  if (HTTP_HOST !== '0.0.0.0') console.log(`    (仅监听 ${HTTP_HOST}，外部请走 HTTPS)`);
  console.log('');
  if (httpsServers.length) {
    console.log('  HTTPS（麦克风需要）:');
    for (const { port, server } of httpsServers) {
      server.listen(port, process.env.HTTPS_HOST || '0.0.0.0', () => {
        for (const url of networkUrls('https', port)) console.log(`    ${url}`);
        if (port === httpsServers[httpsServers.length - 1].port) {
          console.log('');
          console.log('  提示: 自签证书首次打开会有安全警告，点「继续访问」即可。');
          console.log('');
        }
      });
      server.on('error', (err) => {
        console.error('HTTPS listener failed', { port, code: err.code, message: err.message });
        process.exit(1);
      });
    }
  } else {
    if (httpsError) console.log(`  HTTPS 未启用（证书读取失败: ${httpsError}）`);
    else console.log('  使用麦克风需要 HTTPS：运行 enable-lan.bat 生成证书后重启。');
    console.log('');
  }
  console.log('  按 Ctrl+C 停止服务');
  console.log('');
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${HTTP_PORT} 已被占用，请设置环境变量 PORT 换一个端口。`);
  } else {
    console.error('HTTP 服务启动失败:', err.message);
  }
  process.exit(1);
});

let shuttingDown = false;
function shutdown() {
  clearInterval(authSweep);
  clearInterval(radioVoteTimer);
  if (shuttingDown) return;
  shuttingDown = true;
  roomSync.dispose();
  clearInterval(mediaGcTimer);
  for(const id of connUser.values())roomMedia.dropActor(id);
  steamMedia?.close();
  mediaValidator.close();
  encryptedMediaValidator.close();
  mediaStorage.close();
  console.log('\n正在保存数据并退出…');
  flushStore();
  const screenShutdown = screenSfu ? screenSfu.revokeAll() : Promise.resolve();
  wss.closeAll(1001, 'server shutdown');
  screenShutdown.then(() => httpServer.close(() => process.exit(0))).catch((error) => { reportScreenError(error, 'shutdown'); process.exit(1); });
  for (const { server } of httpsServers) {
    try {
      server.close();
    } catch (_) {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(screenSfu ? 1 : 0), screenSfu ? 20000 : 800).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
