// @ts-check
import {isPresentationHidden} from './presentation-visibility.js';
import {MEDIA_LIMITS} from './chat-protocol.js';
/** @typedef {import('./chat-protocol.js').ChatMessage} ChatMessage */
/** @typedef {import('./chat-protocol.js').MediaMetadata} MediaMetadata */
/** @typedef {import('./chat-protocol.js').Attachment} Attachment */
/** @typedef {import('./chat-protocol.js').Reaction} Reaction */
/** @typedef {import('./chat-protocol.js').ReactionSelection} ReactionSelection */
/** @typedef {import('./sticker-panel.js').MediaLease} MediaLease */
/** @typedef {import('./sticker-panel.js').StickerDisplayIntent} StickerDisplayIntent */
/** @typedef {{copies:number,status:'synced'|'waiting'|'unavailable'}} MediaBackupStatus */
/** @typedef {{load:(asset:MediaMetadata,signal:AbortSignal,intent:StickerDisplayIntent)=>Promise<MediaLease>,onFavorite:(message:ChatMessage,signal:AbortSignal)=>Promise<void>,onReact:(message:ChatMessage,anchor:HTMLElement)=>void,onSetReaction:(message:ChatMessage,selection:ReactionSelection,active:boolean)=>Promise<void>,getActorId:()=>string|null,getBackupStatus?:(asset:MediaMetadata)=>MediaBackupStatus|null,reportError:(error:Error)=>void}} ChatMediaAdapter */
/** @typedef {{asset:MediaMetadata,host:HTMLElement,image:HTMLImageElement,status:HTMLElement,visible:boolean,intent:StickerDisplayIntent,state:'idle'|'queued'|'loading'|'ready'|'failed',controller:AbortController|null,lease:MediaLease|null}} MediaCell */
/** @typedef {{node:HTMLButtonElement,count:HTMLElement,selection:ReactionSelection,cell:MediaCell|null}} ReactionPill */
/** @typedef {{message:ChatMessage,body:HTMLElement,actions:HTMLElement,reactions:HTMLElement,pills:Map<string,ReactionPill>,attachment:MediaCell|null,backup:HTMLElement|null,backupLabel:string,attachmentSource:Attachment|undefined,attachmentSignature:string,reactionSource:Reaction[]|undefined,reactionActor:string|null,controllers:Set<AbortController>}} MessageMedia */

/** @param {string} id @param {string} label @param {string} className @returns {HTMLButtonElement} */
function button(id,label,className){const node=document.createElement('button');node.id=id;node.type='button';node.className=className;node.setAttribute('aria-label',label);return node;}
/** @param {string} value @returns {string} */
function identifier(value){return encodeURIComponent(value).replaceAll('%','_');}
/** @param {Reaction} reaction @returns {ReactionSelection} */
function selection(reaction){return reaction.kind==='unicode' ? {kind:'unicode',emoji:reaction.emoji} : {kind:'server',emojiId:reaction.emojiId};}

/** @param {HTMLElement} container @param {ChatMediaAdapter} adapter */
export function createChatMediaView(container,adapter){
  /** @type {Map<string,MessageMedia>} */const rows=new Map();
  /** @type {Map<Element,MediaCell>} */const cells=new Map();
  /** @type {MediaCell[]} */let queue=[];
  /** @type {MediaCell|null} */let activeAnimation=null;
  /** @type {MediaCell|null} */let previewCell=null;
  /** @type {string|null} */let previewMessageId=null;
  let activeLoads=0,disposed=false;
  const events=new AbortController();
  const preview=document.createElement('dialog');preview.id='chatMediaPreview';preview.className='chat-media-dialog';preview.setAttribute('aria-label','查看图片');
  const previewHead=document.createElement('header'),previewTitle=document.createElement('strong'),previewClose=button('chatMediaPreviewCloseBtn','关闭图片','icon-btn');previewClose.textContent='×';previewHead.append(previewTitle,previewClose);preview.append(previewHead);document.body.append(preview);

  /** @param {Error} error @returns {void} */
  function report(error){adapter.reportError(error);}
  /** @param {MediaCell} cell @returns {void} */
  function release(cell){cell.controller?.abort();cell.controller=null;cell.image.removeAttribute('src');cell.image.hidden=true;cell.lease?.release();cell.lease=null;cell.state='idle';cell.status.hidden=false;cell.status.textContent='加载中…';}
  /** @param {MediaCell} cell @returns {void} */
  function untrack(cell){observer.unobserve(cell.host);cells.delete(cell.host);release(cell);if(activeAnimation===cell)activeAnimation=null;cell.host.remove();}
  /** @param {MediaCell} cell @returns {void} */
  function enqueue(cell){if(disposed || !cell.visible || cell.state!=='idle')return;cell.state='queued';queue.push(cell);pump();}
  /** @param {MediaCell} cell @param {StickerDisplayIntent} intent @returns {void} */
  function changeIntent(cell,intent){if(cell.intent===intent)return;release(cell);cell.intent=intent;enqueue(cell);}
  /** @param {MediaCell} cell @returns {void} */
  function animate(cell){if(!cell.asset.animated || previewCell && previewCell!==cell)return;const previous=activeAnimation;activeAnimation=cell;if(previous && previous!==cell)changeIntent(previous,'thumbnail');changeIntent(cell,'animate');}
  /** @param {MediaCell} cell @returns {void} */
  function stopAnimation(cell){if(document.activeElement===cell.host || cell.host.matches(':hover'))return;if(activeAnimation===cell)activeAnimation=null;changeIntent(cell,'thumbnail');}
  /** @returns {void} */
  function pump(){
    while(!disposed && !isPresentationHidden() && activeLoads<4 && queue.length){
      const cell=queue.shift();if(!cell || !cell.visible || cell.state!=='queued' || !cells.has(cell.host))continue;
      const controller=new AbortController();cell.controller=controller;cell.state='loading';activeLoads+=1;
      adapter.load(cell.asset,controller.signal,cell.intent).then(lease=>{
        if(disposed || controller.signal.aborted || !cell.visible || !cells.has(cell.host)){lease.release();return;}
        cell.controller=null;cell.lease=lease;cell.state='ready';cell.image.src=lease.url;cell.image.hidden=false;cell.status.hidden=true;
      }).catch(error=>{if(controller.signal.aborted)return;cell.state='failed';cell.status.hidden=false;cell.status.textContent='图片读取失败';report(error instanceof Error ? error : new Error(String(error)));}).finally(()=>{activeLoads-=1;pump();});
    }
  }
  /** Release display surfaces while preserving the room cache and message DOM. @returns {void} */
  function visibilityChanged(){
    if(isPresentationHidden()){queue=[];activeAnimation=null;for(const cell of cells.values()){release(cell);cell.intent='thumbnail';}}
    else for(const cell of cells.values())enqueue(cell);
  }
  document.addEventListener('visibilitychange',visibilityChanged,{signal:events.signal});
  document.addEventListener('deepscord:visibility',visibilityChanged,{signal:events.signal});
  const observer=new IntersectionObserver(entries=>{for(const entry of entries){const cell=cells.get(entry.target);if(!cell)continue;cell.visible=entry.isIntersecting;if(!cell.visible){release(cell);cell.intent='thumbnail';if(activeAnimation===cell)activeAnimation=null;}else enqueue(cell);}},{root:container,rootMargin:'240px 0px',threshold:0});
  /** @param {MediaMetadata} asset @param {HTMLElement} host @param {string} name @returns {MediaCell} */
  function createCell(asset,host,name){
    const image=document.createElement('img');image.alt=name;image.width=asset.width;image.height=asset.height;image.decoding='async';image.hidden=true;
    const status=document.createElement('span');status.className='chat-media-status';status.textContent='加载中…';status.setAttribute('role','status');host.append(image,status);
    /** @type {MediaCell} */const cell={asset,host,image,status,visible:false,intent:'thumbnail',state:'idle',controller:null,lease:null};cells.set(host,cell);
    image.addEventListener('error',()=>{if(cell.state!=='ready')return;release(cell);cell.state='failed';status.textContent='图片无法解码';report(new Error('AVIF preview could not be decoded: '+asset.sha256));});
    host.addEventListener('pointerenter',()=>animate(cell));host.addEventListener('pointerleave',()=>stopAnimation(cell));host.addEventListener('focus',()=>animate(cell));host.addEventListener('blur',()=>stopAnimation(cell));
    return cell;
  }
  /** @returns {void} */
  function closePreview(){if(previewCell){untrack(previewCell);previewCell=null;}previewMessageId=null;if(preview.open)preview.close();previewTitle.textContent='';}
  /** @param {string} messageId @param {Attachment} attachment @returns {void} */
  function openPreview(messageId,attachment){
    closePreview();if(activeAnimation){const previous=activeAnimation;activeAnimation=null;changeIntent(previous,'thumbnail');}
    previewMessageId=messageId;previewTitle.textContent=attachment.name;const host=document.createElement('div');host.id='chatMediaPreviewFrame';host.className='chat-media-preview-frame';host.tabIndex=0;host.style.aspectRatio=attachment.width+' / '+attachment.height;
    const cell=createCell(attachment,host,attachment.name);cell.image.id='chatMediaPreviewImage';cell.visible=true;cell.intent=attachment.animated ? 'animate' : 'thumbnail';previewCell=cell;if(attachment.animated)activeAnimation=cell;preview.append(host);preview.showModal();enqueue(cell);
  }
  previewClose.addEventListener('click',closePreview,{signal:events.signal});preview.addEventListener('cancel',event=>{event.preventDefault();closePreview();},{signal:events.signal});preview.addEventListener('close',()=>{if(!preview.open)closePreview();},{signal:events.signal});
  /** @param {MessageMedia} row @param {(signal:AbortSignal)=>Promise<void>} operation @param {HTMLButtonElement} control @returns {Promise<void>} */
  async function perform(row,operation,control){
    if(control.disabled || disposed)return;control.disabled=true;const controller=new AbortController();row.controllers.add(controller);
    try{await operation(controller.signal);}catch(error){if(!controller.signal.aborted)report(error instanceof Error ? error : new Error(String(error)));}
    finally{row.controllers.delete(controller);if(!controller.signal.aborted)control.disabled=false;}
  }
  /** @param {MessageMedia} row @returns {void} */
  function updateAttachment(row){
    const attachment=row.message.attachment;
    const anchor=row.backup?.parentNode===row.body ? row.backup : row.reactions;
    if(attachment===row.attachmentSource){if(row.attachment && (row.attachment.host.parentNode!==row.body || row.attachment.host.nextSibling!==anchor))row.body.insertBefore(row.attachment.host,anchor);return;}
    row.attachmentSource=attachment;const signature=attachment ? JSON.stringify(attachment) : '';
    if(signature===row.attachmentSignature){if(row.attachment && (row.attachment.host.parentNode!==row.body || row.attachment.host.nextSibling!==anchor))row.body.insertBefore(row.attachment.host,anchor);return;}
    if(row.attachment)untrack(row.attachment);row.attachment=null;row.attachmentSignature=signature;
    const favorite=row.actions.querySelector('[data-message-favorite]');favorite?.remove();
    if(!attachment)return;
    const host=button('chatAttachment-'+row.message.id,attachment.kind==='image' ? '查看图片：'+attachment.name : attachment.name,'chat-attachment chat-attachment-'+attachment.kind);host.dataset.testid='chat-attachment';host.dataset.msgAttachment=attachment.sha256;host.dataset.messageId=row.message.id;host.style.width=Math.min(attachment.width,attachment.kind==='sticker' ? MEDIA_LIMITS.personal.target : 640)+'px';host.style.aspectRatio=attachment.width+' / '+attachment.height;
    const cell=createCell(attachment,host,attachment.name);row.attachment=cell;row.body.insertBefore(host,anchor);observer.observe(host);if(attachment.kind==='image')host.addEventListener('click',()=>openPreview(row.message.id,attachment));
    const collect=button('chatFavorite-'+row.message.id,'加入个人收藏','btn small ghost');collect.textContent='收藏';collect.dataset.testid='message-favorite';collect.dataset.messageFavorite=row.message.id;collect.addEventListener('click',()=>void perform(row,signal=>adapter.onFavorite(row.message,signal),collect));row.actions.append(collect);
  }
  /** @param {MessageMedia} row @param {Reaction} reaction @returns {ReactionPill} */
  function createPill(row,reaction){
    const node=button('chatReaction-'+row.message.id+'-'+identifier(reaction.key),reaction.kind==='unicode' ? reaction.emoji : reaction.name,'chat-reaction');node.dataset.testid='message-reaction';node.dataset.reactionKey=reaction.key;
    /** @type {MediaCell|null} */let cell=null;
    if(reaction.kind==='unicode'){const emoji=document.createElement('span');emoji.textContent=reaction.emoji;emoji.className='chat-reaction-unicode';node.append(emoji);}
    else{cell=createCell(reaction.asset,node,reaction.name);observer.observe(node);}
    const count=document.createElement('span');count.className='chat-reaction-count';node.append(count);const picked=selection(reaction);
    node.addEventListener('click',()=>void perform(row,async()=>{const actor=adapter.getActorId();if(!actor)throw new Error('请先完成服务器身份验证后再回应');const current=row.message.reactions?.find(item=>item.key===reaction.key);await adapter.onSetReaction(row.message,picked,!(current?.userIds.includes(actor) ?? false));},node));
    return {node,count,selection:picked,cell};
  }
  /** @param {MessageMedia} row @returns {void} */
  function updateReactions(row){
    const actor=adapter.getActorId();if(row.reactionSource===row.message.reactions && row.reactionActor===actor)return;row.reactionSource=row.message.reactions;row.reactionActor=actor;const reactions=row.message.reactions ?? [];
    const keep=new Set(reactions.map(reaction=>reaction.key));for(const [key,pill] of row.pills){if(keep.has(key))continue;if(pill.cell)untrack(pill.cell);pill.node.remove();row.pills.delete(key);}
    let cursor=row.reactions.firstChild;
    for(const reaction of reactions){let pill=row.pills.get(reaction.key);if(!pill){pill=createPill(row,reaction);row.pills.set(reaction.key,pill);}pill.count.textContent=String(reaction.userIds.length);pill.node.setAttribute('aria-pressed',String(!!actor && reaction.userIds.includes(actor)));pill.node.title=(reaction.kind==='unicode' ? reaction.emoji : reaction.name)+' · '+reaction.userIds.length; if(pill.node===cursor)cursor=cursor.nextSibling;else row.reactions.insertBefore(pill.node,cursor);}
    row.reactions.hidden=!reactions.length;
  }
  /** @param {MessageMedia} row @returns {void} */
  function updateBackup(row){
    const status=row.message.attachment ? adapter.getBackupStatus?.(row.message.attachment) ?? null : null;
    if(!status || !row.attachment){row.backup?.remove();row.backup=null;row.backupLabel='';return;}
    if(!row.backup){row.backup=document.createElement('span');row.backup.className='chat-media-backup';row.backup.id='chatBackup-'+row.message.id;row.backup.dataset.testid='message-backup-status';row.backup.setAttribute('role','status');}
    if(row.backup.parentNode!==row.body || row.backup.nextSibling!==row.reactions)row.body.insertBefore(row.backup,row.reactions);
    const label='Steam 备份 · '+(status.status==='synced' ? '已同步 · '+status.copies+' 份' : status.status==='waiting' ? '等待确认 · '+status.copies+' 份' : '媒体暂不可用');if(row.backupLabel!==label){row.backupLabel=label;row.backup.textContent=label;row.backup.dataset.status=status.status;}
  }
  /** @param {ChatMessage} message @param {HTMLElement} node @returns {void} */
  function update(message,node){
    if(disposed)throw new Error('Chat media view has been destroyed');if(message.system){remove(message.id);return;}
    const body=node.querySelector('.msg-body');if(!(body instanceof HTMLElement))throw new Error('Chat message body is missing: '+message.id);
    let row=rows.get(message.id);
    if(!row){const actions=document.createElement('div');actions.className='chat-message-actions';const react=button('chatReact-'+message.id,'添加回应','btn small ghost');react.textContent='＋回应';react.dataset.testid='message-react';react.addEventListener('click',()=>{const current=rows.get(message.id);if(current)adapter.onReact(current.message,react);});actions.append(react);const reactions=document.createElement('div');reactions.className='chat-reactions';reactions.id='chatReactions-'+message.id;reactions.hidden=true;row={message,body,actions,reactions,pills:new Map(),attachment:null,backup:null,backupLabel:'',attachmentSource:undefined,attachmentSignature:'',reactionSource:undefined,reactionActor:null,controllers:new Set()};rows.set(message.id,row);}
    row.message=message;row.body=body;if(row.actions.parentNode!==node)node.append(row.actions);if(row.reactions.parentNode!==body)body.append(row.reactions);updateAttachment(row);updateReactions(row);updateBackup(row);
  }
  /** @param {string} id @returns {void} */
  function remove(id){const row=rows.get(id);if(!row)return;for(const controller of row.controllers)controller.abort();if(row.attachment)untrack(row.attachment);for(const pill of row.pills.values())if(pill.cell)untrack(pill.cell);row.actions.remove();row.reactions.remove();row.backup?.remove();rows.delete(id);if(previewMessageId===id)closePreview();}
  /** @returns {void} */
  function clear(){for(const id of [...rows.keys()])remove(id);observer.disconnect();queue=[];closePreview();activeAnimation=null;}
  /** @returns {void} */
  function destroy(){if(disposed)return;clear();disposed=true;events.abort();preview.remove();}
  return {update,remove,clear,destroy};
}
