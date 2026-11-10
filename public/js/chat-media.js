// @ts-check
import {THEME_COLORS} from './theme-colors.js';
import {createAvifCodec} from './avif-codec.js';
import {createPersonalLibrary} from './media-library.js';
import {createStickerPanel} from './sticker-panel.js';
import {createMediaComposer,insertComposerUnicode} from './media-composer.js';
import {parseChatMessage,parseMediaMetadata,parseReactionSelection,mediaObject,mediaInteger} from './chat-protocol.js';
import {canManageServerCatalog} from './customization-protocol.js';
/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('./chat-protocol.js').ChatMessage} ChatMessage */
/** @typedef {import('./chat-protocol.js').MediaMetadata} MediaMetadata */
/** @typedef {import('./chat-protocol.js').ReactionSelection} ReactionSelection */
/** @typedef {import('./sticker-panel.js').StickerItem} StickerItem */
/** @typedef {import('./sticker-panel.js').MediaLease} MediaLease */
/** @typedef {import('./sticker-panel.js').StickerDisplayIntent} StickerDisplayIntent */
/** @typedef {import('./server-governance-ui.js').GovernanceCommand} GovernanceCommand */
/** @typedef {{roomId:string|null,channelId:string|null,domainId:string|null,selfKey:string|null,actorId:string|null,domains:{id:string,name:string}[],policy:import('./server-governance-ui.js').ServerState['policy']|null}} MediaContext */
/** @typedef {{input:HTMLTextAreaElement,form:HTMLFormElement,host:HTMLElement,anchor:HTMLElement,view:ReturnType<typeof import('./chat-view.js').createChatView>,client:ReturnType<typeof import('./chat-media-client.js').createChatMediaClient>,content?:ReturnType<typeof import('./content-client.js').createContentClient>,getContext:()=>MediaContext,submitGovernance:(command:GovernanceCommand,signal:AbortSignal)=>Promise<void>,acceptMessage:(channelId:string,message:ChatMessage)=>void,reportError:(error:Error)=>void}} ChatMediaOptions */
/** @typedef {{useCount:number,lastUsedAt:number}} Usage */
/** @typedef {{bytes:number,run:()=>Promise<void>,abort:()=>void}} CodecJob */
/** @param {string} name @param {number} length @returns {string} */
function label(name,length){const result=name.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,length);if(!result)throw new TypeError('图片名称不能为空');return result;}
/** @param {MediaMetadata} value @returns {MediaMetadata} */
function metadata(value){return parseMediaMetadata(value);}

/** @param {ChatMediaOptions} options */
export async function createChatMedia(options){
  const codec=createAvifCodec();
  /** @type {CodecJob[]} */let jobs=[];let codecActive=false,disposed=false,queuedImageBytes=0,activeImageBytes=0;
  /** @returns {void} */
  function startJob(){if(codecActive || disposed)return;const job=jobs.shift();if(!job)return;queuedImageBytes-=job.bytes;activeImageBytes=job.bytes;codecActive=true;void job.run().finally(()=>{codecActive=false;activeImageBytes=0;startJob();});}
  /** @template T @param {()=>Promise<T>} operation @param {AbortSignal} signal @param {number} bytes @returns {Promise<T>} */
  function runCodec(operation,signal,bytes){signal.throwIfAborted();if(disposed)return Promise.reject(new Error('Chat media has been closed'));if(!Number.isSafeInteger(bytes) || bytes<1 || bytes>32*1024*1024)return Promise.reject(new RangeError('Image source must contain at most 32 MiB'));if(jobs.length>=16 || codecActive && queuedImageBytes+bytes>16*1024*1024)return Promise.reject(new RangeError('图片处理等待队列达到 16 项或 16 MiB 上限'));return new Promise((resolve,reject)=>{let started=false,settled=false;const job={bytes,run:async()=>{started=true;try{signal.throwIfAborted();const result=await operation();signal.throwIfAborted();if(!settled){settled=true;resolve(result);}}catch(error){if(!settled){settled=true;reject(error);}}finally{signal.removeEventListener('abort',abort);}},abort:()=>{if(settled)return;settled=true;if(!started){queuedImageBytes-=bytes;jobs=jobs.filter(candidate=>candidate!==job);}reject(new DOMException('Image operation was cancelled','AbortError'));if(!started)signal.removeEventListener('abort',abort);}},abort=job.abort;signal.addEventListener('abort',abort,{once:true});jobs.push(job);queuedImageBytes+=bytes;startJob();});}
  /** @type {Window & {deepscord?:{cancelPersonalStickerRequest?:()=>Promise<void>,choosePersonalSticker?:(input:{bounds:{x:number,y:number,width:number,height:number},preset:string,colors:Record<string,string>})=>Promise<{item:StickerItem,data:string}|{tab:'server'|'unicode'}|null>,savePersonalSticker?:(input:{name:string,data:string})=>Promise<boolean>}}} */const desktopWindow=/** @type {typeof desktopWindow} */(window);
  const desktop=desktopWindow.deepscord;
  if(desktop&&(!desktop.choosePersonalSticker||!desktop.savePersonalSticker))throw new Error('桌面客户端需要更新以使用安全的个人表情库');
  const library=desktop ? null : await createPersonalLibrary({validate:(blob,signal)=>runCodec(()=>codec.inspect(blob,'personal',signal),signal,blob.size)});
  let context=options.getContext(),lifetime=new AbortController();
  let contentEpoch=options.content?.policy?.keyId ?? null;
  /** @type {Map<string,string>} */const drafts=new Map();
  /** @type {Map<string,import('./content-client.js').OutgoingContent>} */const draftContent=new Map();
  /** @type {Map<string,Usage>} */let usage=new Map();let usageRoom='';
  /** @type {Set<()=>void>} */const releases=new Set();
  /** @type {Map<string,import('./chat-media-view.js').MediaBackupStatus>} */const backups=new Map();
  /** @type {Set<()=>void>} */const identityWaiters=new Set();
  /** @type {ReturnType<typeof createStickerPanel>|null} */let reactionPanel=null;
  /** @returns {MediaContext & {roomId:string,channelId:string}} */
  function connected(){const value=options.getContext();if(!value.roomId || !value.channelId || !value.selfKey)throw new Error('请等待服务器身份验证完成后再发送媒体');return {...value,roomId:value.roomId,channelId:value.channelId};}
  /** @param {AbortSignal} signal @returns {AbortSignal} */
  function scoped(signal){return AbortSignal.any([signal,lifetime.signal]);}
  /** @param {AbortSignal} signal @returns {Promise<void>} */
  function authenticated(signal){signal.throwIfAborted();if(options.getContext().selfKey)return Promise.resolve();if(identityWaiters.size>=32)return Promise.reject(new RangeError('Too many media reads are awaiting identity verification'));return new Promise((resolve,reject)=>{const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);identityWaiters.delete(ready);},ready=()=>{finish();resolve();},abort=()=>{finish();reject(new DOMException('Identity wait was cancelled','AbortError'));},timer=setTimeout(()=>{finish();reject(new Error('服务器身份验证未完成，无法读取共享媒体'));},15000);identityWaiters.add(ready);signal.addEventListener('abort',abort,{once:true});});}
  /** @param {Blob} blob @returns {MediaLease} */
  function lease(blob){const url=URL.createObjectURL(blob);let released=false;const release=()=>{if(released)return;released=true;URL.revokeObjectURL(url);releases.delete(release);};releases.add(release);return{url,release};}
  /** @param {StickerItem} item @param {AbortSignal} signal @returns {Promise<Blob>} */
  async function personalBlob(item,signal){if(!library)throw new Error('Personal library bytes require the local picker');const owned=await library.load(item,signal);try{const response=await fetch(owned.url,{signal});if(!response.ok)throw new Error('无法读取个人 AVIF 内容：HTTP '+response.status);return new Blob([await response.arrayBuffer()],{type:'image/avif'});}finally{owned.release();}}
  /** @param {MediaMetadata} asset @param {Blob} blob @param {AbortSignal} signal @param {StickerDisplayIntent} intent @returns {Promise<MediaLease>} */
  async function display(asset,blob,signal,intent){
    signal.throwIfAborted();if(!asset.animated || intent==='animate')return lease(blob);
    if(options.content?.encrypted)return lease(await runCodec(()=>codec.poster(blob,signal),signal,blob.size));
    const existing=options.client.getPoster(asset.sha256);if(existing)return lease(existing);
    const poster=await runCodec(()=>codec.poster(blob,signal),signal,blob.size);signal.throwIfAborted();options.client.cachePoster(asset.sha256,poster);return lease(poster);
  }
  /** @param {MediaMetadata} asset @param {AbortSignal} signal @param {StickerDisplayIntent} intent @returns {Promise<MediaLease>} */
  async function loadAsset(asset,signal,intent){const operationSignal=scoped(signal);await authenticated(operationSignal);operationSignal.throwIfAborted();if(asset.animated && intent==='thumbnail' && !options.content?.encrypted){const poster=options.client.getPoster(asset.sha256);if(poster)return lease(poster);}const opened=await downloadMedia(asset,operationSignal);return display(opened.asset,opened.blob,operationSignal,intent);}
  /** @param {MediaMetadata} asset @param {AbortSignal} signal @returns {Promise<{asset:MediaMetadata,blob:Blob}>} */
  async function downloadMedia(asset,signal){const blob=await options.client.download(asset,signal);signal.throwIfAborted();const result=options.content?await options.content.openMedia(blob,asset):{asset,blob};signal.throwIfAborted();return result;}
  /** @param {Blob} blob @param {MediaMetadata} asset @param {import('./chat-protocol.js').MediaKind} kind @param {string|null} domainId @param {AbortSignal} signal @returns {Promise<MediaMetadata>} */
  async function uploadMedia(blob,asset,kind,domainId,signal){signal.throwIfAborted();const sealed=options.content?await options.content.sealMedia(blob,asset,kind):{blob,asset};signal.throwIfAborted();return options.client.upload(sealed.blob,sealed.asset,kind,domainId,signal);}
  /** @param {File} file @param {string|null} domainId @param {AbortSignal} signal @returns {Promise<MediaMetadata>} */
  async function prepareInteractionThumbnail(file,domainId,signal) {
    const current=options.getContext(),operationSignal=scoped(signal);
    if(!current.policy || !canManageServerCatalog(current.policy,current.selfKey))throw new Error('当前身份不能管理此范围的互动表情');
    if(domainId!==null)throw new TypeError('互动表情仅支持服务器范围');
    const prepared=await runCodec(()=>codec.prepare(file,file.name,'server',operationSignal),operationSignal,file.size);
    if(prepared.metadata.animated)throw new TypeError('互动表情缩略图请使用静态图片');
    const latest=options.getContext();
    if(latest.roomId!==current.roomId || !latest.policy || !canManageServerCatalog(latest.policy,latest.selfKey))throw new Error('服务器或管理权限已变化，请重新打开自定义面板');
    return uploadMedia(prepared.blob,prepared.metadata,'server',null,operationSignal);
  }
  /** @returns {void} */
  function loadUsage(){const value=options.getContext();if((value.roomId ?? '')===usageRoom)return;usageRoom=value.roomId ?? '';usage=new Map();if(!usageRoom)return;const saved=localStorage.getItem('deepscord.sticker-usage.'+usageRoom);if(saved===null)return;
    /** @type {JsonValue} */const parsed=JSON.parse(saved);const entries=mediaObject(parsed,'Sticker usage');if(Object.keys(entries).length>256)throw new RangeError('Server sticker usage exceeds its room limit');for(const [id,input] of Object.entries(entries)){const row=mediaObject(input,'Sticker use');usage.set(id,{useCount:mediaInteger(row.useCount,'Sticker usage count',0,Number.MAX_SAFE_INTEGER),lastUsedAt:mediaInteger(row.lastUsedAt,'Sticker usage time',0,Number.MAX_SAFE_INTEGER)});}}
  /** @returns {import('./sticker-panel.js').StickerCatalog} */
  function getCatalog(){loadUsage();const value=options.getContext(),policy=value.policy;return{personal:library?.list() ?? [],server:(policy?.emojis ?? []).map(emoji=>({...emoji.asset,id:emoji.id,kind:'server',domainId:emoji.domainId,name:emoji.name,addedAt:emoji.ts,pinned:false,useCount:usage.get(emoji.id)?.useCount ?? 0,lastUsedAt:usage.get(emoji.id)?.lastUsedAt ?? 0})),domains:[],activeDomainId:null,canManageServer:!!policy&&canManageServerCatalog(policy,value.selfKey)};}
  /** @param {StickerItem} item @param {AbortSignal} signal @returns {Promise<void>} */
  async function recordUse(item,signal){signal.throwIfAborted();if(item.kind==='personal'){if(!library)throw new Error('Personal sticker use belongs to the local picker');await library.recordUse(item.id);return;}loadUsage();const previous=usage.get(item.id),count=previous?.useCount ?? 0;if(count===Number.MAX_SAFE_INTEGER)throw new RangeError('Sticker usage count is exhausted');usage.set(item.id,{useCount:count+1,lastUsedAt:Date.now()});const valid=new Set(options.getContext().policy?.emojis?.map(emoji=>emoji.id) ?? []);usage=new Map([...usage].filter(([id])=>valid.has(id)));localStorage.setItem('deepscord.sticker-usage.'+usageRoom,JSON.stringify(Object.fromEntries(usage)));}
  /** @param {string} channelId @param {string} text @param {import('./chat-protocol.js').Attachment|null} attachment @param {AbortSignal} signal @returns {Promise<void>} */
  async function sendMessage(channelId,text,attachment,signal){
    const value=options.getContext();if(!value.roomId)throw new Error('房间连接尚未就绪');const key=JSON.stringify([value.roomId,channelId,text,attachment?.sha256 ?? null]),requestId=drafts.get(key) ?? crypto.randomUUID();drafts.set(key,requestId);while(drafts.size>32){const oldest=drafts.keys().next().value;if(oldest===undefined)break;drafts.delete(oldest);draftContent.delete(oldest);}
    const body={text,...(attachment?{attachment}:{})},outgoing=draftContent.get(key) ?? (options.content?await options.content.sealMessage(channelId,requestId,body):body);draftContent.set(key,outgoing);scoped(signal).throwIfAborted();
    const result=mediaObject(await options.client.call({t:'chat',requestId,channelId,...outgoing},scoped(signal)),'Chat acknowledgement');if(result.message===undefined)throw new TypeError('Chat acknowledgement has no accepted message');const accepted=parseChatMessage(result.message);if(accepted.clientRequestId!==requestId)throw new TypeError('Chat acknowledgement belongs to another submitted message');const message=options.content?await options.content.openMessage(channelId,accepted):accepted;scoped(signal).throwIfAborted();drafts.delete(key);draftContent.delete(key);options.acceptMessage(channelId,message);
  }
  /** @param {StickerItem} item @param {AbortSignal} signal @returns {Promise<void>} */
  async function sendSticker(item,signal){const value=connected(),operationSignal=scoped(signal);let asset=parseMediaMetadata(item);if(item.kind==='personal')asset=await uploadMedia(await personalBlob(item,operationSignal),asset,'personal',null,operationSignal);await sendMessage(value.channelId,'',{...asset,kind:'sticker',name:label(item.name,80)},operationSignal);}
  /** @param {Blob} blob @param {string} name @param {AbortSignal} signal @returns {Promise<void>} */
  async function savePersonal(blob,name,signal){signal.throwIfAborted();if(library){await library.add(blob,name,signal);return;}if(!desktop?.savePersonalSticker)throw new Error('Trusted sticker save is unavailable');const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));signal.throwIfAborted();await desktop.savePersonalSticker({name,data:btoa(binary)});signal.throwIfAborted();}
  /** @param {{x:number,y:number,width:number,height:number}} bounds @param {AbortSignal} signal @returns {Promise<'server'|'unicode'|null>} */
  async function choosePersonal(bounds,signal){
    const operationSignal=scoped(signal),current=connected();if(!desktop?.choosePersonalSticker)throw new Error('Trusted sticker picker is unavailable');
    const cancel=()=>cancelPicker();operationSignal.addEventListener('abort',cancel,{once:true});
    try{
      const computed=getComputedStyle(document.documentElement),colors=Object.fromEntries(THEME_COLORS.map(key=>[key,computed.getPropertyValue(key).trim()]));
      const selected=await desktop.choosePersonalSticker({bounds,preset:document.documentElement.dataset.interfacePreset??'industrial',colors});operationSignal.throwIfAborted();if(!selected)return null;if('tab' in selected)return selected.tab;
      const original=parseMediaMetadata(selected.item),binary=atob(selected.data),blob=new Blob([Uint8Array.from(binary,char=>char.charCodeAt(0))],{type:'image/avif'}),asset=await uploadMedia(blob,original,'personal',null,operationSignal);
      await sendMessage(current.channelId,'',{...asset,kind:'sticker',name:label(selected.item.name,80)},operationSignal);return null;
    }finally{operationSignal.removeEventListener('abort',cancel);}
  }
  /** @param {StickerItem} item @param {AbortSignal} signal @returns {Promise<void>} */
  async function favorite(item,signal){const operationSignal=scoped(signal),opened=await downloadMedia(parseMediaMetadata(item),operationSignal);await savePersonal(opened.blob,label(item.name,80),operationSignal);}
  /** @param {ChatMessage} message @param {AbortSignal} signal @returns {Promise<void>} */
  async function favoriteMessage(message,signal){if(!message.attachment)throw new TypeError('Message has no attachment to favorite');const operationSignal=scoped(signal),opened=await downloadMedia(message.attachment,operationSignal),blob=opened.blob,prepared=await runCodec(()=>codec.prepare(blob,label(message.attachment?.name ?? '',80),'personal',operationSignal),operationSignal,blob.size);await savePersonal(prepared.blob,message.attachment.name,operationSignal);panel.refresh();}
  /** @param {ChatMessage} message @param {ReactionSelection} selection @param {boolean} active @param {AbortSignal} signal @returns {Promise<void>} */
  async function setReaction(message,selection,active,signal){
    const value=connected(),choice=parseReactionSelection(selection),operationSignal=scoped(signal),requestId=crypto.randomUUID();
    const emoji=choice.kind==='server'?value.policy?.emojis?.find(item=>item.id===choice.emojiId):undefined;
    /** @type {{[key:string]:JsonValue}} */const payload=options.content?.encrypted?{sealed:await options.content.sealReaction(value.channelId,requestId,message.id,{selection:choice,active,...(emoji?{emoji}:{})})}:{selection:choice,active};
    operationSignal.throwIfAborted();const result=mediaObject(await options.client.call({t:'setReaction',requestId,channelId:value.channelId,messageId:message.id,...payload},operationSignal),'Reaction acknowledgement');if(result.message===undefined)throw new TypeError('Reaction acknowledgement has no accepted message');const accepted=parseChatMessage(result.message),opened=options.content?await options.content.openMessage(value.channelId,accepted):accepted;operationSignal.throwIfAborted();options.acceptMessage(value.channelId,opened);
  }
  /** @param {ChatMessage} message @param {HTMLElement} anchor @returns {void} */
  function openReactions(message,anchor){
    reactionPanel?.destroy();const current=connected(),messageChannel=current.channelId;
    reactionPanel=createStickerPanel({...panelOptions,id:'reactionPicker',anchor,selection:{kind:'reaction',setReaction:async(selection,signal)=>{if(options.getContext().channelId!==messageChannel)throw new DOMException('Channel changed during reaction selection','AbortError');await setReaction(message,selection,true,signal);reactionPanel?.close();}}});reactionPanel.open();
  }
  /** @type {Omit<import('./sticker-panel.js').StickerPanelOptions,'id'|'anchor'|'selection'>} */
  const panelOptions={host:document.body,preferences:library?.getPreferences() ?? {columns:6,sort:'frequency'},getCatalog,openPersonalPicker:desktop ? choosePersonal : null,loadMedia:async(item,signal,intent)=>{if(item.kind!=='personal')return loadAsset(parseMediaMetadata(item),signal,intent);const operationSignal=scoped(signal),asset=parseMediaMetadata(item),opened={asset,blob:await personalBlob(item,operationSignal)};return display(opened.asset,opened.blob,operationSignal,intent);},
    importFiles:async(files,target,signal)=>{if(files.length>20)throw new RangeError('每次最多导入 20 张表情');const operationSignal=scoped(signal);for(const file of files){operationSignal.throwIfAborted();const prepared=await runCodec(()=>codec.prepare(file,file.name,target.kind,operationSignal),operationSignal,file.size);if(target.kind==='personal')await savePersonal(prepared.blob,label(file.name,80),operationSignal);else{connected();if(target.domainId!==null || !getCatalog().canManageServer)throw new Error('当前身份不能管理服务器表情');const asset=await uploadMedia(prepared.blob,prepared.metadata,'server',target.domainId,operationSignal);await options.submitGovernance({type:'putEmoji',domainId:target.domainId,emojiId:'emoji_'+crypto.randomUUID().replaceAll('-',''),name:label(file.name,40),asset,ts:Date.now()},operationSignal);}}},favorite,remove:async(item,signal)=>{if(item.kind==='personal'){if(!library)throw new Error('Personal deletion requires local picker');await library.remove(item.id);}else{await options.submitGovernance({type:'deleteEmoji',domainId:null,emojiId:item.id},scoped(signal));}},pin:async(item,active)=>{if(item.kind!=='personal')throw new TypeError('Only personal sticker pins are writable');if(!library)throw new Error('Personal pinning requires local picker');if(library.list().find(row=>row.id===item.id)?.pinned!==active)await library.pin(item.id);},recordUse,savePreferences:async preferences=>{if(library)await library.setPreferences(preferences);},reportError:options.reportError};
  const panel=createStickerPanel({...panelOptions,id:'stickerPanel',anchor:options.anchor,selection:{kind:'composer',sendSticker,insertUnicode:emoji=>insertComposerUnicode(options.input,emoji)}});
  const composer=createMediaComposer({input:options.input,form:options.form,host:options.host,openStickers:()=>panel.toggle(),prepareImage:async(file,signal)=>{const operationSignal=scoped(signal),prepared=await runCodec(()=>codec.prepare(file,file.name,'image',operationSignal),operationSignal,file.size);return{...prepared.metadata,kind:'image',name:label(file.name,80),payload:prepared.blob,preview:lease(prepared.blob)};},sendImage:async(image,signal)=>{const current=connected(),operationSignal=scoped(signal),asset=await uploadMedia(image.payload,metadata(image),'image',null,operationSignal);await sendMessage(current.channelId,'',{...asset,kind:'image',name:image.name},operationSignal);},reportError:options.reportError});
  options.view.setMedia({load:loadAsset,onFavorite:favoriteMessage,onReact:(message,anchor)=>{try{openReactions(message,anchor);}catch(error){options.reportError(error instanceof Error ? error : new Error(String(error)));}},onSetReaction:(message,selection,active)=>setReaction(message,selection,active,lifetime.signal),getActorId:()=>options.getContext().actorId,getBackupStatus:asset=>backups.get(asset.sha256) ?? null,reportError:options.reportError});
  /** @param {JsonValue} value @returns {void} */
  function receiveStatus(value){const frame=mediaObject(value,'Steam media status');if(frame.t!=='mediaStatus' || !Array.isArray(frame.items) || frame.items.length>4096)throw new TypeError('Steam media status must contain at most 4096 assets');/** @type {Map<string,import('./chat-media-view.js').MediaBackupStatus>} */const next=new Map();for(const input of frame.items){const item=mediaObject(input,'Steam media backup'),copies=mediaInteger(item.copies,'Durable media copies',0,256);if(typeof item.sha256!=='string' || !/^[a-f0-9]{64}$/.test(item.sha256) || item.status!=='synced' && item.status!=='waiting' && item.status!=='unavailable' || item.status==='synced' && copies<2)throw new TypeError('Steam backup status requires a valid hash and two durable copies before synced');if(next.has(item.sha256))throw new TypeError('Steam backup status contains duplicate assets');next.set(item.sha256,{copies,status:item.status});}backups.clear();for(const [key,status] of next)backups.set(key,status);}
  /** @returns {void} */
  function cancelPicker(){if(desktop?.cancelPersonalStickerRequest)void desktop.cancelPersonalStickerRequest().catch(error=>options.reportError(error instanceof Error?error:new Error(String(error))));}
  /** @returns {void} */
  function reset(){cancelPicker();lifetime.abort();lifetime=new AbortController();panel.close();reactionPanel?.destroy();reactionPanel=null;composer.cancel();options.view.clearMedia();for(const release of [...releases])release();drafts.clear();draftContent.clear();backups.clear();options.client.reset();}
  /** @returns {void} */
  function refresh(){const next=options.getContext(),epoch=options.content?.policy?.keyId ?? null;if(context.roomId!==null && next.roomId!==context.roomId || epoch!==contentEpoch){reset();usageRoom='';}else if(next.channelId!==context.channelId){cancelPicker();lifetime.abort();lifetime=new AbortController();panel.close();reactionPanel?.destroy();reactionPanel=null;composer.cancel();}context=next;contentEpoch=epoch;if(next.selfKey)for(const ready of [...identityWaiters])ready();panel.refresh();reactionPanel?.refresh();}
  /** @returns {void} */
  function destroy(){if(disposed)return;reset();disposed=true;for(const job of [...jobs])job.abort();jobs=[];composer.destroy();panel.destroy();codec.destroy();library?.destroy();}
  /** @param {string} channelId @param {string} text @param {AbortSignal} signal @returns {Promise<void>} */
  function sendText(channelId,text,signal){return sendMessage(channelId,text,null,signal);}
  return{sendText,favoriteMessage,receiveStatus,refresh,reset,destroy,prepareInteractionThumbnail,loadInteractionThumbnail:(/** @type {MediaMetadata} */ asset,/** @type {AbortSignal} */ signal)=>loadAsset(asset,signal,'thumbnail'),stats:()=>({...options.client.stats(),ownedUrls:releases.size,codec:codec.stats(),queuedImages:jobs.length,queuedImageBytes,activeImageBytes,identityWaiters:identityWaiters.size})};
}
