// @ts-check
/** @typedef {'personal'|'server'} StickerKind */
/** @typedef {{id:string,kind:StickerKind,name:string,sha256:string,domainId:string|null,width:number,height:number,animated:boolean,frames:number,durationMs:number,bytes:number,addedAt:number,useCount:number,lastUsedAt:number,pinned:boolean}} StickerItem */
/** @typedef {{id:string,name:string,canManage:boolean}} StickerDomain */
/** @typedef {{personal:readonly StickerItem[],server:readonly StickerItem[],domains:readonly StickerDomain[],activeDomainId:string|null,canManageServer?:boolean}} StickerCatalog */
/** @typedef {{url:string,release:()=>void}} MediaLease */
/** @typedef {'thumbnail'|'animate'} StickerDisplayIntent */
/** @typedef {{columns:4|5|6|8,sort:'frequency'|'recent'|'added'}} StickerPreferences */
/** @typedef {{kind:'unicode',emoji:string}|{kind:'server',emojiId:string}} ReactionSelection */
/** @typedef {{kind:'composer',sendSticker:(item:StickerItem,signal:AbortSignal)=>Promise<void>,insertUnicode:(emoji:string)=>void}|{kind:'reaction',setReaction:(selection:ReactionSelection,signal:AbortSignal)=>Promise<void>}} StickerSelection */
/** @typedef {{id:string,anchor:HTMLElement,host:HTMLElement,selection:StickerSelection,preferences:StickerPreferences,getCatalog:()=>StickerCatalog,onTabRequest?:(tab:'server'|'unicode')=>void,onDismiss?:()=>void,onTabChange?:(tab:'personal'|'server'|'unicode')=>void,onClose?:()=>void,openPersonalPicker?:((bounds:{x:number,y:number,width:number,height:number},signal:AbortSignal)=>Promise<'server'|'unicode'|null>)|null,loadMedia:(item:StickerItem,signal:AbortSignal,intent:StickerDisplayIntent)=>Promise<MediaLease>,importFiles:(files:readonly File[],target:{kind:StickerKind,domainId:string|null},signal:AbortSignal)=>Promise<void>,favorite:(item:StickerItem,signal:AbortSignal)=>Promise<void>,remove:(item:StickerItem,signal:AbortSignal)=>Promise<void>,pin:(item:StickerItem,active:boolean,signal:AbortSignal)=>Promise<void>,recordUse:(item:StickerItem,signal:AbortSignal)=>Promise<void>,savePreferences:(preferences:StickerPreferences)=>Promise<void>,reportError:(error:Error)=>void}} StickerPanelOptions */
/** @typedef {{item:StickerItem,button:HTMLButtonElement,image:HTMLImageElement,visible:boolean,intent:StickerDisplayIntent,state:'idle'|'queued'|'loading'|'ready'|'failed',controller:AbortController|null,lease:MediaLease|null}} StickerCell */

import {UNICODE_EMOJIS} from './chat-protocol.js';
export {UNICODE_EMOJIS} from './chat-protocol.js';

/** @param {string} tag @param {string} className @param {string} text @returns {HTMLElement} */
function element(tag,className,text){const node=document.createElement(tag);node.className=className;node.textContent=text;return node;}
/** @param {string} id @param {string} label @param {string} className @returns {HTMLButtonElement} */
function button(id,label,className){const node=document.createElement('button');node.id=id;node.type='button';node.className=className;node.textContent=label;return node;}
/** @param {readonly StickerItem[]} items @param {StickerPreferences['sort']} sort @returns {StickerItem[]} */
export function sortStickers(items,sort){return [...items].sort((left,right)=>Number(right.pinned)-Number(left.pinned)||(sort==='frequency' ? right.useCount-left.useCount||right.lastUsedAt-left.lastUsedAt : sort==='recent' ? right.lastUsedAt-left.lastUsedAt : right.addedAt-left.addedAt)||left.id.localeCompare(right.id,'en'));}

/** @param {StickerPanelOptions} options */
export function createStickerPanel(options){
  const panel=element('section','sticker-panel','');panel.id=options.id;panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label',options.selection.kind==='reaction' ? '选择表情回应' : '表情与收藏');
  const head=element('header','sticker-panel-head',''),title=element('strong','sticker-panel-title','');title.id=options.id+'Title';
  const importButton=button(options.id+'ImportBtn','＋ 导入','btn small ghost');importButton.dataset.testid='sticker-import-btn';
  const settingsButton=button(options.id+'SettingsBtn','设置','btn small ghost');settingsButton.dataset.testid='sticker-settings-btn';
  const closeButton=button(options.id+'CloseBtn','×','icon-btn');closeButton.setAttribute('aria-label','关闭表情面板');
  head.append(title,importButton,settingsButton,closeButton);
  const settings=element('div','sticker-settings','');settings.hidden=true;
  const columns=document.createElement('select');columns.className='select';columns.id=options.id+'ColumnsSelect';columns.setAttribute('aria-label','每行表情数');
  for(const value of [4,5,6,8]){const option=document.createElement('option');option.value=String(value);option.textContent=value+' 列';columns.append(option);}
  const sorting=document.createElement('select');sorting.className='select';sorting.id=options.id+'SortSelect';sorting.setAttribute('aria-label','表情排序');
  for(const [value,label] of [['frequency','使用频率'],['recent','最近使用'],['added','加入时间']]){const option=document.createElement('option');option.value=value;option.textContent=label;sorting.append(option);}
  settings.append(columns,sorting);
  const status=element('p','sticker-panel-status','');status.id=options.id+'Status';status.setAttribute('role','status');status.hidden=true;
  const grid=element('div','sticker-panel-grid','');grid.id=options.id+'Grid';grid.setAttribute('aria-label','表情列表');
  const tabs=element('nav','sticker-panel-tabs','');tabs.setAttribute('aria-label','表情分类');
  /** @type {Map<'personal'|'server'|'unicode',HTMLButtonElement>} */const tabButtons=new Map();
  /** @type {['personal'|'server'|'unicode',string][]} */const tabRows=[['personal','个人收藏'],['server','服务器表情'],['unicode','经典 Emoji']];
  for(const [kind,label] of tabRows){if(kind==='personal' && options.selection.kind==='reaction')continue;const control=button(options.id+'Tab'+kind,label,'sticker-tab');control.dataset.testid='sticker-tab-'+(kind==='unicode' ? 'emoji' : kind);control.setAttribute('aria-pressed','false');control.addEventListener('click',()=>{if(tab===kind||actionPending)return;if(kind!=='personal'&&options.onTabRequest){options.onTabRequest(kind);return;}tab=kind;render();options.onTabChange?.(tab);if(tab==='personal')showPersonal();});tabButtons.set(kind,control);tabs.append(control);}
  const fileInput=document.createElement('input');fileInput.id=options.id+'ImportInput';fileInput.type='file';fileInput.accept='image/*,.avif,.gif,.png,.jpg,.jpeg,.webp,.apng';fileInput.multiple=true;fileInput.hidden=true;
  panel.append(head,settings,status,grid,tabs,fileInput);options.host.append(panel);
  /** @type {'personal'|'server'|'unicode'} */let tab=options.selection.kind==='reaction' ? 'server' : 'personal';
  let preferences={...options.preferences};let opened=false;let destroyed=false;let generation=0;let activeLoads=0;let actionPending=false;
  let renderedCatalog='';
  /** @type {AbortController|null} */let actionController=null;
  /** @type {Map<Element,StickerCell>} */const cells=new Map();
  /** @type {StickerCell[]} */let queue=[];
  /** @type {HTMLElement|null} */let context=null;
  /** @type {StickerCell|null} */let activeAnimation=null;
  let preferencePending=false;
  const events=new AbortController();

  /** @param {Error} error @returns {void} */
  function report(error){status.textContent=error.message;status.hidden=false;status.setAttribute('role','alert');options.reportError(error);}
  /** @param {StickerCell} cell @returns {void} */
  function releaseCell(cell){cell.controller?.abort();cell.controller=null;cell.image.removeAttribute('src');cell.lease?.release();cell.lease=null;cell.state='idle';}
  /** @returns {void} */
  function clearMedia(){observer.disconnect();for(const cell of cells.values())releaseCell(cell);cells.clear();queue=[];activeAnimation=null;}
  /** @param {StickerCell} cell @param {StickerDisplayIntent} intent @returns {void} */
  function changeIntent(cell,intent){if(cell.intent===intent)return;releaseCell(cell);cell.intent=intent;if(cell.visible){cell.state='queued';queue.push(cell);}pump();}
  /** @param {StickerCell} cell @returns {void} */
  function animate(cell){if(!cell.item.animated)return;const previous=activeAnimation;activeAnimation=cell;if(previous && previous!==cell)changeIntent(previous,'thumbnail');changeIntent(cell,'animate');}
  /** @param {StickerCell} cell @returns {void} */
  function stopAnimation(cell){if(document.activeElement===cell.button || cell.button.matches(':hover'))return;if(activeAnimation===cell)activeAnimation=null;changeIntent(cell,'thumbnail');}
  /** @returns {void} */
  function closeContext(){context?.remove();context=null;}
  /** @returns {void} */
  function position(){if(!opened)return;const anchor=options.anchor.getBoundingClientRect(),bounds=panel.getBoundingClientRect();panel.style.left=Math.max(8,Math.min(anchor.left,innerWidth-bounds.width-8))+'px';panel.style.top=Math.max(8,Math.min(anchor.top-bounds.height-8,innerHeight-bounds.height-8))+'px';}
  /** @returns {void} */
  function pump(){
    while(opened && activeLoads<4 && queue.length){const cell=queue.shift();if(!cell || !cell.visible || cell.state!=='queued' || !cells.has(cell.button))continue;
      const controller=new AbortController(),version=generation;cell.controller=controller;cell.state='loading';activeLoads+=1;
      options.loadMedia(cell.item,controller.signal,cell.intent).then(lease=>{
        if(controller.signal.aborted || !opened || version!==generation || !cell.visible || !cells.has(cell.button)){lease.release();return;}
        cell.controller=null;cell.lease=lease;cell.image.src=lease.url;cell.state='ready';
      }).catch(error=>{if(controller.signal.aborted)return;cell.state='failed';cell.button.classList.add('load-failed');cell.image.alt='读取失败';report(error instanceof Error ? error : new Error(String(error)));}).finally(()=>{activeLoads-=1;pump();});
    }
  }
  const observer=new IntersectionObserver(entries=>{for(const entry of entries){const cell=cells.get(entry.target);if(!cell)continue;cell.visible=entry.isIntersecting;if(!cell.visible){releaseCell(cell);cell.intent='thumbnail';if(activeAnimation===cell)activeAnimation=null;continue;}if(cell.state==='idle'){cell.state='queued';queue.push(cell);}}pump();},{root:grid,rootMargin:'48px 0px',threshold:0});
  /** @param {(signal:AbortSignal)=>Promise<void>} operation @returns {Promise<void>} */
  async function perform(operation){if(actionPending || !opened)return;actionPending=true;const controller=new AbortController();actionController=controller;panel.setAttribute('aria-busy','true');status.hidden=true;
    try{await operation(controller.signal);if(opened && !controller.signal.aborted)render();}
    catch(error){if(!controller.signal.aborted)report(error instanceof Error ? error : new Error(String(error)));}
    finally{if(actionController===controller){actionPending=false;actionController=null;panel.removeAttribute('aria-busy');}}
  }
  /** @param {StickerItem} item @param {AbortSignal} signal @returns {Promise<void>} */
  async function activate(item,signal){const selection=options.selection;if(selection.kind==='reaction'){if(item.kind!=='server')throw new TypeError('Personal stickers cannot be used for reactions');await selection.setReaction({kind:'server',emojiId:item.id},signal);}else await selection.sendSticker(item,signal);if(!signal.aborted)await options.recordUse(item,signal);}
  /** @param {StickerItem} item @param {MouseEvent} event @returns {void} */
  function showContext(item,event){
    event.preventDefault();if(options.selection.kind==='reaction')return;closeContext();context=element('div','sticker-context','');context.id=options.id+'Context';context.setAttribute('role','menu');
    /** @param {string} id @param {string} label @param {(signal:AbortSignal)=>Promise<void>} action @returns {void} */
    function choice(id,label,action){const control=button(options.id+id,label,'menu-item');control.dataset.testid=id;control.addEventListener('click',()=>{closeContext();void perform(action);});context?.append(control);}
    if(item.kind==='personal'){choice('sticker-delete-personal','删除表情',signal=>options.remove(item,signal));choice('sticker-pin-personal',item.pinned ? '取消置顶' : '移到最前',signal=>options.pin(item,!item.pinned,signal));}
    else{choice('sticker-favorite','添加到我的个人表情',async signal=>{if(options.getCatalog().personal.length>=300)throw new RangeError('个人表情已达到 300 个上限');await options.favorite(item,signal);});if(options.getCatalog().canManageServer)choice('sticker-delete-server','从服务器删除',signal=>options.remove(item,signal));}
    options.host.append(context);const bounds=context.getBoundingClientRect();context.style.left=Math.max(8,Math.min(event.clientX,innerWidth-bounds.width-8))+'px';context.style.top=Math.max(8,Math.min(event.clientY,innerHeight-bounds.height-8))+'px';
  }
  /** @param {StickerItem} item @returns {void} */
  function addCell(item){
    const control=button(options.id+'Item-'+item.kind+'-'+item.id,'','sticker-cell');control.dataset.stickerId=item.id;control.dataset.testid='sticker-cell';control.setAttribute('aria-label',item.name);control.title=item.name+(item.animated ? ' · 动图' : '');
    const image=document.createElement('img');image.alt=item.name;image.decoding='async';image.width=item.width;image.height=item.height;
    const caption=element('span','sticker-cell-name',item.name);control.append(image,caption);if(item.pinned)control.append(element('span','sticker-pinned','置顶'));
    /** @type {StickerCell} */const cell={item,button:control,image,visible:false,intent:'thumbnail',state:/** @type {'idle'} */('idle'),controller:null,lease:null};cells.set(control,cell);grid.append(control);observer.observe(control);
    image.addEventListener('error',()=>{if(cell.state!=='ready')return;releaseCell(cell);cell.state='failed';control.classList.add('load-failed');image.alt='读取失败';report(new Error('表情预览无法解码：'+item.name));});
    control.addEventListener('click',()=>void perform(signal=>activate(item,signal)));control.addEventListener('contextmenu',event=>showContext(item,event));
    control.addEventListener('pointerenter',()=>animate(cell));control.addEventListener('pointerleave',()=>stopAnimation(cell));control.addEventListener('focus',()=>animate(cell));control.addEventListener('blur',()=>stopAnimation(cell));
  }
  /** @returns {void} */
  function render(){
    if(!opened)return;const catalog=options.getCatalog();
    if(catalog.personal.length>300 || catalog.server.length>256)throw new RangeError('Sticker catalog exceeds the personal or room limit');
    const privatePicker=tab==='personal'&&!!options.openPersonalPicker;
    const nextCatalog=JSON.stringify([tab,preferences,privatePicker,catalog.canManageServer,tab==='personal'&&!privatePicker?catalog.personal:tab==='server'?catalog.server:[]]);
    if(renderedCatalog===nextCatalog){position();return;}
    renderedCatalog=nextCatalog;generation+=1;clearMedia();closeContext();grid.replaceChildren();
    panel.style.setProperty('--sticker-grid-cols',String(preferences.columns));columns.value=String(preferences.columns);sorting.value=preferences.sort;
    for(const [kind,control] of tabButtons){control.classList.toggle('active',kind===tab);control.setAttribute('aria-pressed',String(kind===tab));}
    title.textContent=privatePicker ? '个人收藏' : tab==='personal' ? '个人收藏 · '+catalog.personal.length+'/300' : tab==='server' ? '服务器表情 · '+catalog.server.length+'/256' : '经典 Emoji';
    settingsButton.hidden=privatePicker;if(privatePicker)settings.hidden=true;
    importButton.hidden=privatePicker || tab==='unicode' || options.selection.kind==='reaction';
    importButton.disabled=tab==='server' ? !catalog.canManageServer||catalog.server.length>=256 : catalog.personal.length>=300;
    if(tab==='unicode'){for(const emoji of UNICODE_EMOJIS){const control=button(options.id+'Unicode-'+emoji.codePointAt(0),emoji,'sticker-cell unicode-cell');control.dataset.testid='sticker-unicode';control.setAttribute('aria-label',emoji);control.addEventListener('click',()=>{const selection=options.selection;if(selection.kind==='composer')selection.insertUnicode(emoji);else void perform(signal=>selection.setReaction({kind:'unicode',emoji},signal));});grid.append(control);}}
    else if(tab==='personal'&&options.openPersonalPicker)grid.append(element('p','sticker-empty','正在读取个人收藏…'));
    else for(const item of sortStickers(tab==='personal'?catalog.personal:catalog.server,preferences.sort))addCell(item);
    if(!grid.childElementCount)grid.append(element('p','sticker-empty',tab==='server' ? '此服务器还没有共享表情。服主或服务器管理员可上传，全服各域共用。' : '收藏常用表情，或一次导入最多 20 张图片。'));
    position();
  }
  /** @returns {void} */
  function showPersonal(){
    const picker=options.openPersonalPicker;if(!picker)return;
    const bounds=panel.getBoundingClientRect();
    void perform(async signal=>{const selected=await picker({x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height},signal);signal.throwIfAborted();if(selected)tab=selected;else close();});
  }
  /** @returns {void} */
  function open(){if(destroyed)throw new Error('Sticker panel has been destroyed');if(opened)return;opened=true;panel.hidden=false;options.anchor.setAttribute('aria-expanded','true');status.hidden=true;render();for(const cell of cells.values())observer.observe(cell.button);tabButtons.get(tab)?.focus();if(tab==='personal')showPersonal();}
  /** @returns {void} */
  function suspend(){
    if(!opened)return;opened=false;generation+=1;observer.disconnect();queue=[];
    actionController?.abort();actionController=null;actionPending=false;panel.removeAttribute('aria-busy');
    for(const cell of cells.values()){if(cell.state!=='ready'||cell.intent==='animate'){releaseCell(cell);cell.intent='thumbnail';}}
    activeAnimation=null;closeContext();panel.hidden=true;
  }
  /** @returns {void} */
  function dismiss(){if(options.onDismiss)options.onDismiss();else close();}
  /** @returns {void} */
  function close(){if(!opened)return;opened=false;renderedCatalog='';generation+=1;panel.hidden=true;options.anchor.setAttribute('aria-expanded','false');actionController?.abort();actionController=null;actionPending=false;panel.removeAttribute('aria-busy');clearMedia();closeContext();options.anchor.focus();options.onClose?.();}
  /** @returns {void} */
  function destroy(){close();clearMedia();destroyed=true;observer.disconnect();events.abort();panel.remove();}
  settingsButton.addEventListener('click',()=>{settings.hidden=!settings.hidden;position();});closeButton.addEventListener('click',dismiss);importButton.addEventListener('click',()=>fileInput.click());
  fileInput.addEventListener('change',()=>{const files=[...(fileInput.files ?? [])];fileInput.value='';if(!files.length)return;void perform(async signal=>{const catalog=options.getCatalog();if(files.length>20)throw new RangeError('每次最多导入 20 张表情，请分批导入');const kind=tab==='personal' ? 'personal' : 'server';if(kind==='server' && !catalog.canManageServer)throw new Error('只有服主或服务器管理员可以上传服务器表情');const remaining=kind==='personal' ? 300-catalog.personal.length : 256-catalog.server.length;if(files.length>remaining)throw new RangeError('表情库还可加入 '+remaining+' 个，本次选择了 '+files.length+' 个');await options.importFiles(files,{kind,domainId:null},signal);});});
  /** @returns {Promise<void>} */
  async function changePreferences(){
    if(preferencePending)return;
    const pickedColumns=Number(columns.value),pickedSort=sorting.value;
    if((pickedColumns!==4 && pickedColumns!==5 && pickedColumns!==6 && pickedColumns!==8)||(pickedSort!=='frequency' && pickedSort!=='recent' && pickedSort!=='added'))throw new TypeError('Unsupported sticker layout preference');
    /** @type {StickerPreferences} */
    const next={columns:pickedColumns,sort:pickedSort};
    preferencePending=true;columns.disabled=true;sorting.disabled=true;
    try{await options.savePreferences(next);preferences=next;render();}
    catch(error){columns.value=String(preferences.columns);sorting.value=preferences.sort;report(error instanceof Error ? error : new Error(String(error)));}
    finally{preferencePending=false;columns.disabled=false;sorting.disabled=false;}
  }
  columns.addEventListener('change',()=>void changePreferences());sorting.addEventListener('change',()=>void changePreferences());
  document.addEventListener('pointerdown',event=>{const target=event.target;if(target instanceof Node && !panel.contains(target) && !context?.contains(target) && !options.anchor.contains(target))dismiss();else if(context && target instanceof Node && !context.contains(target))closeContext();},{signal:events.signal});
  document.addEventListener('keydown',event=>{if(opened && event.key==='Escape'){event.preventDefault();dismiss();}},{signal:events.signal});
  window.addEventListener('resize',position,{signal:events.signal});
  return {open,close,suspend,toggle:()=>{if(opened)close();else open();},refresh:render,destroy,isOpen:()=>opened};
}
