// @ts-check
import {createInterfaceSchemeEditor} from './interface-scheme-ui.js';
import {readCustomizationFile,downloadCustomization} from './customization-files.js';
import {resourceManagerLink} from './resource-manager-link.js';
import { canManageServerCatalog, parseCustomInteraction } from './customization-protocol.js';

/** @typedef {import('./customization-protocol.js').Theme} Theme */
/** @typedef {import('./customization-protocol.js').CustomInteraction} CustomInteraction */
/** @typedef {import('./chat-protocol.js').MediaMetadata} MediaMetadata */
/** @typedef {import('../../lib/server-governance.cjs').GovernanceState} GovernanceState */
/** @typedef {import('../../lib/server-governance.cjs').GovernanceCommand} GovernanceCommand */
/** @typedef {{policy:GovernanceState,selfKey:string,serverName:string,domains:{id:string,name:string}[],domainId:string|null,roomId:string}} Context */
/** @typedef {{close:()=>void}} PanelView */
/** @typedef {{getContext:()=>Context,listInteractionDrafts:()=>Promise<{directory:string,serverDirectory:string,interactions:CustomInteraction[]}>,openInteractionDirectory:()=>Promise<void>,openResourceManager:()=>Promise<void>,getInterfaceProfile:()=>import('./interface-profile.js').InterfaceProfile,getInterfaceSelection:()=>import('./interface-scheme.js').InterfaceSelection|null,listSchemes:()=>Promise<{directory:string,schemes:import('./interface-scheme.js').InterfaceScheme[]}>,openSchemeDirectory:()=>Promise<void>,saveInterfaceSelection:(selection:import('./interface-scheme.js').InterfaceSelection)=>Promise<void>,previewInterfaceSelection:(selection:import('./interface-scheme.js').InterfaceSelection)=>void,initialTab:'theme'|'interactions',modal:(options:{title:string,body:HTMLElement,width:number,footer:HTMLElement[],onClose:()=>void})=>PanelView,submit:(command:GovernanceCommand,signal:AbortSignal)=>Promise<void>,prepareThumbnail:(file:File,domainId:string|null,signal:AbortSignal)=>Promise<MediaMetadata>,loadThumbnail:(asset:MediaMetadata,signal:AbortSignal)=>Promise<{url:string,release:()=>void}>,previewTheme:(theme:Theme|null)=>void,restoreTheme:()=>void,previewInteraction:(entry:CustomInteraction)=>void,cancelPreview:()=>void}} PanelOptions */


/** @template {keyof HTMLElementTagNameMap} T @param {T} tag @param {string} className @param {string} text @returns {HTMLElementTagNameMap[T]} */
function node(tag,className,text) {
  const element=document.createElement(tag);element.className=className;element.textContent=text;return element;
}
/** @param {string} id @param {string} text @param {string} className @returns {HTMLButtonElement} */
function button(id,text,className) {
  const element=node('button','btn '+className,text);element.type='button';element.id=id;element.dataset.testid=id;return element;
}
/** @param {string} id @param {string} value @param {'text'|'color'|'number'|'file'} type @returns {HTMLInputElement} */
function input(id,value,type) {
  const element=node('input','input','');element.id=id;element.dataset.testid=id;element.type=type;element.value=value;return element;
}
/** @param {string} id @param {string[][]} choices @param {string} value @returns {HTMLSelectElement} */
function select(id,choices,value) {
  const element=node('select','input','');element.id=id;element.dataset.testid=id;
  for(const [key,label] of choices){const option=node('option','',label);option.value=key;element.append(option);}
  element.value=value;return element;
}
/** @param {string} text @param {HTMLInputElement|HTMLSelectElement} control @returns {HTMLLabelElement} */
function field(text,control) {
  const label=node('label','customization-field','');label.htmlFor=control.id;label.append(node('span','',text),control);return label;
}

/** @param {PanelOptions} options @returns {PanelView} */
export function openCustomizationPanel(options) {
  const context=options.getContext();
  const interactionsAllowed=canManageServerCatalog(context.policy,context.selfKey);
  if(options.initialTab==='interactions' && !interactionsAllowed)throw new Error('只有服主或服务器管理员可以管理互动表情。');
  const domainId=null;
  let tab=options.initialTab;
  let closed=false;
  let busy=false;
  let draftRefreshEpoch=0;
  let controller=new AbortController();
  /** @type {(()=>void)[]} */
  let releases=[];
  const body=node('div','customization-panel','');body.id='customizationPanel';body.dataset.testid='customization-panel';
  const intro=node('header','customization-intro','');
  intro.append(node('p','customization-kicker','DEEPSCORD / PERSONALIZATION'),node('h3','',context.serverName),node('p','customization-description','界面主题仅保存在本机，适用于此客户端的所有服务器。互动表情由服主或服务器管理员统一发布，全服共享。'));
  const tabs=node('div','customization-tabs','');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','自定义类别');
  const themeTab=button('customizationThemeTab','界面自定义','ghost');
  const interactionsTab=button('customizationInteractionsTab','互动表情管理','ghost');
  interactionsTab.hidden=!interactionsAllowed;
  for(const control of [themeTab,interactionsTab]){control.setAttribute('role','tab');control.setAttribute('aria-controls','customizationContent');}
  tabs.append(themeTab,interactionsTab);
  const status=node('p','customization-status','');status.id='customizationStatus';status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.hidden=true;
  const content=node('section','customization-content','');content.id='customizationContent';content.setAttribute('role','tabpanel');
  const controls=node('fieldset','customization-controls','');controls.append(tabs,content);
  const resources=resourceManagerLink({openResourceManager:options.openResourceManager},error=>notify(error.message,'error'));
  intro.append(resources);body.append(intro,status,controls);
  const closeButton=button('customizationClose','关闭','ghost');
  /** @returns {void} */
  function releasePage(){draftRefreshEpoch+=1;options.cancelPreview();controller.abort();for(const release of releases)release();releases=[];controller=new AbortController();}
  /** @returns {void} */
  function cleanup(){if(closed)return;closed=true;window.removeEventListener('focus',refreshDraftsOnFocus);releasePage();controller.abort();options.restoreTheme();}
  const view=options.modal({title:'界面与互动自定义',body,width:760,footer:[closeButton],onClose:cleanup});
  /** @returns {void} */
  function close(){cleanup();view.close();}
  closeButton.addEventListener('click',close);
  /** @param {string} message @param {'error'|'saved'|'working'} state @returns {void} */
  function notify(message,state){if(closed)return;status.textContent=message;status.dataset.state=state;status.hidden=false;status.setAttribute('role',state==='error'?'alert':'status');}
  /** @returns {Context} */
  function assertPermission(){const current=options.getContext();if(closed || current.roomId!==context.roomId || !canManageServerCatalog(current.policy,current.selfKey))throw new Error('管理权限已变化，请关闭面板后重新打开。');return current;}
  /** @param {()=>Promise<void>} action @returns {Promise<void>} */
  async function run(action){
    if(busy || closed)return;busy=true;controls.disabled=true;notify('正在处理…','working');
    try{await action();}
    catch(error){if(!closed && !controller.signal.aborted)notify(error instanceof Error?error.message:String(error),'error');}
    finally{busy=false;controls.disabled=false;}
  }
  /** @param {CustomInteraction} entry @param {HTMLElement} target @returns {void} */
  function thumbnail(entry,target){
    const image=node('img','customization-thumbnail','');image.alt=entry.name;image.width=52;image.height=52;
    const asset=entry.thumbnail;
    if(!asset){if(entry.model==='thumbnail'){target.append(node('span','customization-thumbnail','图'));return;}image.src='assets/interactions/'+(entry.scene?.actors[0].model==='fist'?'fist':entry.scene?.actors.some(actor=>actor.model==='dollar' || actor.model==='wallet')?'dollar':entry.model)+'.svg';target.append(image);return;}
    const signal=controller.signal;target.append(image);
    options.loadThumbnail(asset,signal).then(lease=>{
      if(signal.aborted || closed){lease.release();return;}releases.push(lease.release);image.src=lease.url;
    }).catch(error=>{if(!signal.aborted && !closed)notify('缩略图读取失败：'+(error instanceof Error?error.message:String(error)),'error');});
  }
  /** @returns {void} */
  function renderTheme(){
    const editor=createInterfaceSchemeEditor({initialSelection:options.getInterfaceSelection(),initialPreset:options.getInterfaceProfile().preset,listSchemes:options.listSchemes,openDirectory:options.openResourceManager,preview:options.previewInterfaceSelection,save:async selection=>{await options.saveInterfaceSelection(selection);options.restoreTheme();notify('界面方案已保存到本机。','saved');},reportError:error=>notify(error.message,'error')});
    const guide=button('customizationSchemeGuide','界面方案目录与开发指南','ghost');guide.addEventListener('click',()=>{void run(options.openSchemeDirectory);});
    content.append(editor.element,guide);releases.push(editor.dispose);
  }
  /** @param {CustomInteraction|null} original @returns {void} */
  function renderInteractionForm(original){
    if(!original)throw new TypeError('新增互动请通过资源管理器安装，然后明确上传。');
    const editor=node('form','customization-form customization-editor','');editor.id='customizationInteractionForm';
    editor.append(node('h4','',original ? '编辑互动表情' : '新增互动表情'));
    const name=input('customizationInteractionName',original?.name ?? '','text');name.maxLength=24;name.required=true;name.placeholder='最多 24 个字符';
    const model=select('customizationInteractionModel',[['bomb','炸弹模型'],['poop','便便模型'],['thumbnail','使用缩略图投掷']],original?.model ?? 'bomb');
    const trajectory=select('customizationInteractionTrajectory',[['arc','弧线'],['linear','直线']],original?.trajectory ?? 'arc');
    const duration=input('customizationInteractionDuration',String(original?.durationMs ?? 1000),'number');duration.min='300';duration.max='4000';duration.step='1';duration.required=true;
    const sound=select('customizationInteractionSound',[['none','无音效'],['bomb-1','炸弹 1'],['bomb-2','炸弹 2'],['bomb-3','炸弹 3'],['bomb-4','炸弹 4'],['poop','便便']],original?.sound ?? 'none');
    const file=input('customizationInteractionThumbnail','','file');file.accept='image/png,image/jpeg,image/webp,image/gif,image/avif';
    const grid=node('div','customization-grid','');grid.append(field('名称',name),field('投掷模型',model),field('飞行轨迹',trajectory),field('投掷时长（毫秒）',duration),field('内置音效',sound),field('缩略图（可选）',file));
    const thumbnailNote=node('p','customization-description',original?.thumbnail ? '已保存缩略图；不选择文件会继续使用。' : '请选择静态图片。缩略图用于表情列表；选择“使用缩略图投掷”时必须提供图片。音效从 5 个内置声音中选择。');
    const advanced=node('details','customization-scene-editor','');advanced.open=Boolean(original?.scene);
    advanced.append(node('summary','','动画编排与导入导出'));
    const scene=node('textarea','input','');scene.id='customizationInteractionScene';scene.setAttribute('aria-label','动画编排 JSON');scene.rows=12;scene.spellcheck=false;scene.value=original?.scene?JSON.stringify(original.scene,null,2):'';
    advanced.append(node('p','customization-description','留空使用普通投掷（300–2000 毫秒）。填写编排后由各模型关键帧控制路径（300–4000 毫秒），下方普通模型与轨迹暂停使用。可设置使用者/目标锚点、位置、旋转、缩放和透明度。'),scene);
    /** @returns {void} */
    function syncSceneControls(){const active=scene.value.trim().length>0;model.disabled=active;trajectory.disabled=active;duration.max=active?'4000':'2000';}
    scene.addEventListener('input',syncSceneControls);syncSceneControls();
    const importFile=input('customizationInteractionImport','','file');importFile.accept='.json,application/json';const exportFile=button('customizationInteractionExport','导出互动定义','ghost');
    advanced.append(field('导入互动定义',importFile),exportFile);editor.append(advanced);
    const actions=node('div','customization-actions','');const save=button('customizationInteractionSave',original?'保存更改':'创建互动','primary');save.type='submit';
    const preview=button('customizationInteractionPreview','本地试投','ghost');const cancel=button('customizationInteractionCancel','取消编辑','ghost');
    const clearThumbnail=button('customizationInteractionClearThumbnail','移除缩略图','ghost');
    const thumbnailPreview=node('div','customization-thumbnail-preview','');thumbnailPreview.id='customizationInteractionThumbnailPreview';
    if(original?.thumbnail)thumbnail(original,thumbnailPreview);
    actions.append(save,preview,cancel);editor.append(grid,thumbnailNote,thumbnailPreview,clearThumbnail);
    const previewArea=node('div','customization-preview-area','');previewArea.dataset.testid='customization-preview-area';
    const previewFrom=node('span','customization-preview-avatar','预览');previewFrom.id='customizationPreviewFrom';
    const previewTo=node('span','customization-preview-avatar','目标');previewTo.id='customizationPreviewTo';
    previewArea.append(previewFrom,node('span','customization-description','仅在本地播放'),previewTo);editor.append(previewArea,actions);content.append(editor);
    /** @type {MediaMetadata|null} */
    let asset=original?.thumbnail ?? null;
    /** @type {File|null} */
    let preparedFile=null;
    /** @type {(()=>void)|null} */
    let releaseSelected=null;
    file.addEventListener('change',()=>{
      releaseSelected?.();releaseSelected=null;thumbnailPreview.replaceChildren();
      const selected=file.files?.[0];
      if(!selected){if(original?.thumbnail && asset)thumbnail(original,thumbnailPreview);return;}
      const url=URL.createObjectURL(selected);const image=node('img','customization-thumbnail','');image.alt='所选缩略图';image.src=url;thumbnailPreview.append(image);
      let released=false;
      releaseSelected=()=>{if(released)return;released=true;URL.revokeObjectURL(url);};releases.push(releaseSelected);
      thumbnailNote.textContent='已选择 '+selected.name+'，试投或保存时会校验并上传静态缩略图。';
    });
    clearThumbnail.addEventListener('click',()=>{releaseSelected?.();releaseSelected=null;asset=null;preparedFile=null;file.value='';thumbnailPreview.replaceChildren();thumbnailNote.textContent='缩略图已移除，保存后生效。';});
    const id=original?.id ?? crypto.randomUUID();
    /** @returns {Promise<CustomInteraction>} */
    async function draft(){
      if(scene.value.length>65536)throw new RangeError('动画编排不能超过 64 KiB');
      const selected=file.files?.[0];
      if(selected && selected!==preparedFile){assertPermission();asset=await options.prepareThumbnail(selected,domainId,controller.signal);preparedFile=selected;assertPermission();}
      return parseCustomInteraction({id,name:name.value.trim(),model:model.value,trajectory:trajectory.value,durationMs:Number(duration.value),sound:sound.value,thumbnail:asset,...(scene.value.trim()?{scene:JSON.parse(scene.value)}:{})});
    }
    importFile.addEventListener('change',()=>{const file=importFile.files?.[0];if(!file)return;void run(async()=>{const entry=parseCustomInteraction(await readCustomizationFile(file));if(closed)return;releasePage();content.replaceChildren();renderInteractionForm({...entry,id:original?.id ?? crypto.randomUUID()});notify('已导入互动定义，试投确认后保存。','saved');});});
    exportFile.addEventListener('click',()=>{void run(async()=>downloadCustomization(await draft(),'Deepscord-interaction.json'));});
    preview.addEventListener('click',()=>{if(!editor.reportValidity())return;void run(async()=>{const entry=await draft();assertPermission();options.previewInteraction(entry);notify('正在本地试投，尚未发布。','saved');});});
    editor.addEventListener('submit',event=>{event.preventDefault();void run(async()=>{const interaction=await draft();assertPermission();await options.submit({type:'putInteraction',domainId,interaction},controller.signal);render();notify('互动表情已保存。','saved');});});
    cancel.addEventListener('click',render);
    name.focus();
  }
  /** @returns {void} */
  function renderInteractions(){
    const current=assertPermission();const entries=current.policy.customization?.find(item=>item.domainId===null)?.interactions ?? [];
    const heading=node('div','customization-section-heading','');heading.append(node('h4','','全服互动表情'),node('span','customization-count',String(entries.length)+' / 96 项'));
    const add=button('customizationInteractionAdd','+ 安装互动包','primary');
    const guide=button('customizationInteractionGuide','互动定义目录与开发指南','ghost');guide.addEventListener('click',()=>{void run(options.openInteractionDirectory);});
    heading.append(add,guide);content.append(heading,node('p','customization-description','在资源管理器中安装互动包，返回后选择上传；明确上传后才会发布给全服。最多 96 项。'));
    const list=node('div','customization-interaction-list','');list.dataset.testid='customization-interaction-list';
    for(const entry of entries){
      const row=node('article','customization-interaction-row','');row.dataset.interactionId=entry.id;thumbnail(entry,row);
      const copy=node('div','customization-interaction-copy','');copy.append(node('strong','',entry.name),node('span','',`${entry.scene?'多模型编排':entry.trajectory==='arc'?'弧线':'直线'} · ${entry.durationMs} ms · ${entry.sound==='none'?'无音效':'内置音效'}`));
      const edit=button('customizationInteractionEdit-'+entry.id,'编辑','ghost');edit.dataset.testid='customization-interaction-edit';
      const remove=button('customizationInteractionDelete-'+entry.id,'删除','ghost danger');remove.dataset.testid='customization-interaction-delete';
      row.append(copy,edit,remove);list.append(row);
      edit.addEventListener('click',()=>{releasePage();content.replaceChildren();renderInteractionForm(entry);});
      remove.addEventListener('click',()=>{void run(async()=>{assertPermission();await options.submit({type:'deleteInteraction',domainId:null,interactionId:entry.id},controller.signal);render();notify('互动表情已删除。','saved');});});
    }
    if(entries.length===0)list.append(node('p','customization-empty','当前没有已发布互动。'));
    const drafts=node('section','customization-builtins','');drafts.id='customizationInteractionDrafts';content.append(list,drafts);
    add.addEventListener('click',()=>{void run(async()=>{assertPermission();await options.openResourceManager();assertPermission();notify('资源管理器已打开，安装互动包后返回此处选择上传。','saved');});});
    void refreshDrafts(drafts);
  }
  /** @param {HTMLElement} target @returns {Promise<void>} */
  async function refreshDrafts(target){
    const signal=controller.signal,epoch=++draftRefreshEpoch;
    target.replaceChildren(node('h4','','本机待上传定义'),node('p','customization-description','正在读取当前服务器目录…'));
    try{
      assertPermission();const local=await options.listInteractionDrafts();
      if(closed || signal.aborted || epoch!==draftRefreshEpoch || !target.isConnected)return;
      const current=assertPermission(),published=current.policy.customization?.find(scope=>scope.domainId===null)?.interactions ?? [];
      target.replaceChildren(node('h4','','本机待上传定义'),node('p','customization-description',local.serverDirectory));
      if(local.interactions.length===0)target.append(node('p','customization-empty','当前服务器目录没有待上传定义。'));
      for(const draft of local.interactions){
        const entry=parseCustomInteraction(draft),exists=published.some(item=>item.id===entry.id);
        const row=node('article','customization-interaction-row','');row.dataset.draftId=entry.id;
        const copy=node('div','customization-interaction-copy','');copy.append(node('strong','',entry.name),node('span','',entry.id));
        const upload=button('customizationInteractionUpload-'+entry.id,exists?'更新上传':'上传到服务器','primary small');upload.disabled=!exists && published.length>=96;
        row.append(copy,upload);target.append(row);
        upload.addEventListener('click',()=>{void run(async()=>{assertPermission();await options.submit({type:'putInteraction',domainId:null,interaction:entry},controller.signal);render();notify('互动定义已上传到当前服务器。','saved');});});
      }
    }catch(error){if(!closed && !signal.aborted && epoch===draftRefreshEpoch && target.isConnected){target.replaceChildren(node('h4','','本机待上传定义'),node('p','governance-error',error instanceof Error?error.message:String(error)));}}
  }
  /** @returns {void} */
  function refreshDraftsOnFocus(){const target=document.getElementById('customizationInteractionDrafts');if(!closed && !busy && tab==='interactions' && target)void refreshDrafts(target);}
  window.addEventListener('focus',refreshDraftsOnFocus);
  /** @returns {void} */
  function render(){
    if(closed)return;releasePage();options.restoreTheme();content.replaceChildren();
    themeTab.setAttribute('aria-selected',String(tab==='theme'));interactionsTab.setAttribute('aria-selected',String(tab==='interactions'));
    content.setAttribute('aria-labelledby',tab==='theme'?themeTab.id:interactionsTab.id);
    try{if(tab==='theme')renderTheme();else renderInteractions();}catch(error){notify(error instanceof Error?error.message:String(error),'error');}
  }
  themeTab.addEventListener('click',()=>{tab='theme';status.hidden=true;render();});
  interactionsTab.addEventListener('click',()=>{tab='interactions';status.hidden=true;render();});
  render();
  return {close};
}
