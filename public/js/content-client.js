// @ts-check
import {parseChatMessage,parseAttachment,parseReactions,parseMediaMetadata,mediaHash,mediaInteger,MEDIA_LIMITS,MEDIA_ENCRYPTION_OVERHEAD} from './chat-protocol.js';
import {parseContentPolicy,parseContentMessage,contentKeyId,contentIdentity,mapContentAsset} from './content-protocol.js';
/** @typedef {import('./chat-protocol.js').ChatMessage} ChatMessage */
/** @typedef {import('./chat-protocol.js').MediaMetadata} MediaMetadata */
/** @typedef {import('./chat-protocol.js').MediaKind} MediaKind */
/** @typedef {import('./content-protocol.js').ContentPolicy} ContentPolicy */
/** @typedef {import('./content-protocol.js').ContentAsset} ContentAsset */
/** @typedef {import('./content-protocol.js').SealedMessage} SealedMessage */
/** @typedef {{text:string,attachment?:import('./chat-protocol.js').Attachment,reactions?:import('./chat-protocol.js').Reaction[],reactionRevision?:number}} ContentBody */
/** @typedef {{text:string,attachment?:import('./chat-protocol.js').Attachment,sealed?:SealedMessage}} OutgoingContent */
/** @typedef {{descriptor:import('../../lib/room-replica.cjs').RoomDescriptor,journal:import('../../lib/server-governance.cjs').GovernanceJournal,policy:ContentPolicy|null}} ContentInitialization */
/** @typedef {{keyId:string,key:Uint8Array}} ScreenKey */
/** @typedef {{keyId:string,keyHash:string,roomId:string,creatorKey:string}} PreparedContent */
/** @typedef {{sealContentReaction:(input:{channelId:string,requestId:string,messageId:string,body:{selection:import('./chat-protocol.js').ReactionSelection,active:boolean,emoji?:import('./chat-protocol.js').ServerEmoji}})=>Promise<SealedMessage>,activateContentRoom:(input:ContentInitialization)=>Promise<ScreenKey|null>,prepareContentRoom:()=>Promise<PreparedContent>,signContentPolicy:(input:{assets:ContentAsset[]})=>Promise<ContentPolicy>,sealContentMessage:(input:{channelId:string,requestId:string,body:ContentBody})=>Promise<SealedMessage>,openContentMessage:(input:{channelId:string,message:ChatMessage})=>Promise<ChatMessage>,sealContentMedia:(input:{kind:MediaKind,asset:MediaMetadata,data:string})=>Promise<{asset:MediaMetadata,data:string}>,openContentMedia:(input:{asset:MediaMetadata,data:string})=>Promise<{asset:MediaMetadata,data:string}>}} ContentBridge */

/** @param {ContentBody} input @returns {ContentBody} */
function body(input){
  if(typeof input.text!=='string'||input.text.length>2000||input.text.includes('\u0000'))throw new TypeError('Message content requires text of at most 2000 characters');
  return {text:input.text,...(input.attachment?{attachment:parseAttachment(input.attachment)}:{}),...(input.reactions?{reactions:parseReactions(input.reactions)}:{}),...(input.reactionRevision===undefined?{}:{reactionRevision:mediaInteger(input.reactionRevision,'Content reaction revision',0,Number.MAX_SAFE_INTEGER)})};
}
/** @param {Blob} blob @returns {Promise<string>} */
async function encode(blob){
  if(blob.size<1||blob.size>MEDIA_LIMITS.image.bytes+MEDIA_ENCRYPTION_OVERHEAD)throw new RangeError('Content media exceeds its transfer budget');
  const bytes=new Uint8Array(await blob.arrayBuffer());
  try{let text='';for(let offset=0;offset<bytes.length;offset+=8192)text+=String.fromCharCode(...bytes.subarray(offset,offset+8192));return btoa(text);}finally{bytes.fill(0);}
}
/** @param {string} data @param {MediaMetadata} asset @returns {Blob} */
function decode(data,asset){
  if(typeof data!=='string'||data.length>Math.ceil((MEDIA_LIMITS.image.bytes+MEDIA_ENCRYPTION_OVERHEAD)/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))throw new TypeError('Content IPC media requires bounded canonical base64');
  const bytes=Uint8Array.from(atob(data),character=>character.charCodeAt(0));
  try{if(bytes.length!==asset.bytes)throw new TypeError('Content IPC media length differs from its descriptor');let encoded='';for(let offset=0;offset<bytes.length;offset+=8192)encoded+=String.fromCharCode(...bytes.subarray(offset,offset+8192));if(btoa(encoded)!==data)throw new TypeError('Content IPC media encoding is not canonical');return new Blob([bytes],{type:asset.encrypted?'application/octet-stream':'image/avif'});}finally{bytes.fill(0);}
}
/** @param {Partial<ContentBridge>|null|undefined} bridge */
export function createContentClient(bridge){
  /** @type {ContentPolicy|null} */let policy=null;
  let initialized=false,generation=0;
  /** @returns {ContentBridge} */
  function requireBridge(){
    if(!bridge||!['activateContentRoom','prepareContentRoom','signContentPolicy','sealContentReaction','sealContentMessage','openContentMessage','sealContentMedia','openContentMedia'].every(name=>typeof bridge[/** @type {keyof ContentBridge} */(name)]==='function'))throw new Error('加密房间需要更新后的 Windows 桌面客户端及本机安全密钥存储');
    return /** @type {ContentBridge} */(bridge);
  }
  /** @returns {void} */
  function requireInitialized(){if(!initialized)throw new Error('房间内容加密尚未完成验证，请等待连接完成');}
  /** @param {number} version @returns {void} */
  function requireGeneration(version){if(version!==generation||!initialized)throw new DOMException('Room changed during content encryption','AbortError');}
  /** @param {ContentInitialization} input @returns {Promise<ScreenKey|null>} */
  async function initialize(input){
    const version=++generation;initialized=false;policy=null;
    const next=input.policy===null?null:parseContentPolicy(input.policy);
    if(next&&next.roomId!==input.descriptor.roomId)throw new TypeError('Room encryption policy belongs to another room');
    if(next)requireBridge();
    const key=typeof bridge?.activateContentRoom==='function'?await bridge.activateContentRoom({...input,policy:next}):null;
    if(version!==generation){key?.key.fill(0);throw new DOMException('Room changed during content activation','AbortError');}
    if(next&&(!key||!(key.key instanceof Uint8Array)||key.key.byteLength!==32||contentKeyId(key.keyId)!==next.keyId))throw new TypeError('Protected room activation did not return its verified screen key');
    if(!next&&key!==null)throw new TypeError('Plain room activation unexpectedly returned an encryption key');
    policy=next;initialized=true;return key?{keyId:key.keyId,key:key.key}:null;
  }
  /** @param {string} channelId @param {string} requestId @param {ContentBody} input @returns {Promise<OutgoingContent>} */
  async function sealMessage(channelId,requestId,input){
    requireInitialized();const content=body(input);if(!policy)return content;
    const version=generation;
    if(content.attachment?.encrypted!==true&&content.attachment)throw new TypeError('Encrypted message attachment must be uploaded as ciphertext');
    const sealed=await sealMigrationMessage(channelId,requestId,content);requireGeneration(version);
    if(sealed.keyId!==policy?.keyId)throw new TypeError('Encrypted message uses a different room key');
    return {text:'',sealed,...(content.attachment?{attachment:{...content.attachment,name:'encrypted.avif'}}:{})};
  }
  /** @param {string} channelId @param {ChatMessage} message @returns {Promise<ChatMessage>} */
  async function openMessage(channelId,message){
    requireInitialized();const parsed=parseChatMessage(message);if(!policy){if(parsed.sealed)throw new Error('Encrypted message arrived without a verified room encryption policy');return parsed;}
    const version=generation,result=await requireBridge().openContentMessage({channelId,message:parsed});requireGeneration(version);const opened=parseChatMessage(result);return {...opened,...(opened.attachment?{attachment:{...opened.attachment,...mapContentAsset(policy,opened.attachment)}}:{}),...(opened.reactions?{reactions:opened.reactions.map(reaction=>reaction.kind==='server'?{...reaction,asset:mapContentAsset(policy,reaction.asset)}:reaction)}:{})};
  }
  /** @param {string} channelId @param {string} requestId @param {string} messageId @param {{selection:import('./chat-protocol.js').ReactionSelection,active:boolean,emoji?:import('./chat-protocol.js').ServerEmoji}} body @returns {Promise<SealedMessage>} */
  async function sealReaction(channelId,requestId,messageId,body){requireInitialized();if(!policy)throw new TypeError('Encrypted reaction requires an encrypted room');const version=generation,service=requireBridge();if(typeof service.sealContentReaction!=='function')throw new Error('请更新桌面客户端以发送加密回应');const sealed=parseContentMessage(await service.sealContentReaction({channelId,requestId,messageId,body}));requireGeneration(version);if(sealed.keyId!==policy.keyId)throw new TypeError('Encrypted reaction uses a different room key');return sealed;}
  /** @param {Blob} blob @param {MediaMetadata} input @param {MediaKind} kind @returns {Promise<{blob:Blob,asset:MediaMetadata}>} */
  async function sealMedia(blob,input,kind){
    requireInitialized();const asset=parseMediaMetadata(input);if(!policy){if(asset.encrypted)throw new Error('Encrypted media cannot be uploaded to an unencrypted room');return {blob,asset};}
    return sealMigrationMedia(blob,asset,kind);
  }
  /** @param {Blob} blob @param {MediaMetadata} input @returns {Promise<{blob:Blob,asset:MediaMetadata}>} */
  async function openMedia(blob,input){
    requireInitialized();const asset=parseMediaMetadata(input);if(!policy){if(asset.encrypted)throw new Error('Encrypted media arrived without a verified room encryption policy');return {blob,asset};}
    return verifyMigrationMedia(blob,asset);
  }
  /** Seal an explicitly requested migration while the server policy is still plain.
   * @param {string} channelId @param {string} requestId @param {ContentBody} input @returns {Promise<SealedMessage>} */
  async function sealMigrationMessage(channelId,requestId,input){requireInitialized();const version=generation,sealed=parseContentMessage(await requireBridge().sealContentMessage({channelId,requestId,body:body(input)}));requireGeneration(version);return sealed;}
  /** @param {Blob} blob @param {MediaMetadata} input @param {MediaKind} kind @returns {Promise<{blob:Blob,asset:MediaMetadata}>} */
  async function sealMigrationMedia(blob,input,kind){requireInitialized();const asset=parseMediaMetadata(input);if(asset.encrypted)throw new TypeError('Media is already encrypted');const version=generation,result=await requireBridge().sealContentMedia({kind,asset,data:await encode(blob)});requireGeneration(version);const stored=parseMediaMetadata(result.asset);if(stored.encrypted!==true||stored.mediaKind!==kind)throw new TypeError('Content IPC did not seal the requested media kind');return {asset:stored,blob:decode(result.data,stored)};}
  /** @param {Blob} blob @param {MediaMetadata} input @returns {Promise<{blob:Blob,asset:MediaMetadata}>} */
  async function verifyMigrationMedia(blob,input){requireInitialized();const asset=parseMediaMetadata(input);if(asset.encrypted!==true)throw new TypeError('Room media has not been migrated to ciphertext');const version=generation,result=await requireBridge().openContentMedia({asset,data:await encode(blob)});requireGeneration(version);const opened=parseMediaMetadata(result.asset);if(opened.encrypted)throw new TypeError('Content IPC did not decrypt the media');return {asset:opened,blob:decode(result.data,opened)};}
  /** @returns {Promise<PreparedContent>} */
  async function prepare(){requireInitialized();const version=generation,result=await requireBridge().prepareContentRoom();requireGeneration(version);if(typeof result.roomId!=='string'||!/^[a-f0-9-]{36}$/.test(result.roomId))throw new TypeError('Prepared room encryption descriptor is invalid');return {keyId:contentKeyId(result.keyId),keyHash:mediaHash(result.keyHash),roomId:result.roomId,creatorKey:contentIdentity(result.creatorKey)};}
  /** @param {ContentAsset[]} assets @returns {Promise<ContentPolicy>} */
  async function signPolicy(assets){requireInitialized();const version=generation,result=await requireBridge().signContentPolicy({assets});requireGeneration(version);return parseContentPolicy(result);}
  return {initialize,sealReaction,sealMessage,openMessage,sealMedia,openMedia,prepare,signPolicy,sealMigrationMessage,sealMigrationMedia,verifyMigrationMedia,get encrypted(){return policy!==null;},get policy(){return policy;}};
}
