import {governanceRevision} from './governance-checkpoint.js';
// @ts-check

import {mediaObject,mediaId,mediaInteger,parseMediaMetadata,parseChatMessage,parseAttachment,parseReactions} from './chat-protocol.js';
import {parseContentPolicy} from './content-protocol.js';
/** @typedef {import('./chat-protocol.js').MediaMetadata} MediaMetadata */
/** @typedef {import('./chat-protocol.js').Attachment} Attachment */
/** @typedef {import('./content-protocol.js').ContentPolicy} ContentPolicy */
/** @typedef {import('./content-protocol.js').ContentAsset} ContentAsset */
/** @typedef {ReturnType<typeof import('./content-client.js').createContentClient>} ContentClient */
/** @typedef {ReturnType<typeof import('./chat-media-client.js').createChatMediaClient>} ChatMediaClient */
/** @typedef {{content:ContentClient,client:ChatMediaClient,descriptor:import('../../lib/room-replica.cjs').RoomDescriptor,journal:import('../../lib/server-governance.cjs').GovernanceJournal,owner:boolean,emojis:import('./chat-protocol.js').ServerEmoji[],onComplete:(policy:ContentPolicy)=>Promise<void>,onBusy:(busy:boolean)=>void,modal:(input:{title:string,body:HTMLElement,width:number,footer:HTMLButtonElement[],locked:boolean})=>{close:()=>void},reportError:(error:Error)=>void}} ContentSettingsOptions */

/** @param {Blob} blob @returns {Promise<string>} */
async function digest(blob){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
/** @param {string} value @returns {Promise<string>} */
async function migrationRequest(value){return 'migration-'+await digest(new Blob([value]));}
/** @param {MediaMetadata} asset @param {Map<string,MediaMetadata>} replacements @returns {MediaMetadata} */
function replacement(asset,replacements){const result=replacements.get(asset.sha256);if(!result)throw new TypeError('历史文件缺少已验证的加密副本：'+asset.sha256);return result;}
/** @param {Attachment} attachment @param {Map<string,MediaMetadata>} replacements @returns {Attachment} */
function mapAttachment(attachment,replacements){return parseAttachment({...replacement(attachment,replacements),kind:attachment.kind,name:attachment.name});}
/** @param {string} text @param {string} className @returns {HTMLParagraphElement} */
function paragraph(text,className){const element=document.createElement('p');element.textContent=text;element.className=className;return element;}
/** @param {string} id @param {string} text @param {string} className @returns {HTMLButtonElement} */
function button(id,text,className){const element=document.createElement('button');element.type='button';element.id=id;element.dataset.testid=id;element.textContent=text;element.className=className+' content-settings-control';return element;}

/** Present room content status and an explicit, reversible staging flow. @param {ContentSettingsOptions} options */
export function openContentSettings(options){
  const body=document.createElement('div');body.className='content-settings';body.dataset.testid='content-settings';body.style.display='grid';body.style.gap='16px';
  const styles=document.createElement('style');styles.textContent='.content-settings [hidden],.content-settings-control[hidden]{display:none!important}';body.append(styles);
  const heading=document.createElement('section');heading.className='settings-section';heading.style.borderLeft='3px solid var(--accent)';heading.style.paddingLeft='16px';
  const eyebrow=document.createElement('h3');eyebrow.textContent='房间内容 · 加密设置';
  const state=paragraph(options.content.encrypted?'已启用端到端加密':'历史记录尚未加密','');state.id='contentEncryptionState';state.style.fontSize='26px';state.style.fontWeight='700';state.style.margin='6px 0 10px';
  const description=paragraph(options.content.encrypted?'已启用的范围包含聊天内容、全部已迁移历史，以及图片和表情文件。房间仍会处理连接成员、频道与文件大小等必要信息。':'启用时会先逐项加密现有历史和文件，确认完整后统一切换。迁移期间，房间会暂时停止聊天、文件变更与语音加入。','settings-hint');
  heading.append(eyebrow,state,description);body.append(heading);
  const notice=paragraph(options.content.encrypted?'新的房间邀请包含解密密钥，请只交给可信成员。加密不能撤回成员已经保存、截图或转发的内容。':'过去已经下载、备份或转发的明文副本无法收回。启用后，需要包含密钥的新邀请才能让新设备读取内容。','dialog-text');body.append(notice);
  const confirmation=document.createElement('section');confirmation.className='settings-section';confirmation.hidden=true;confirmation.dataset.testid='content-migration-confirmation';
  const confirmTitle=document.createElement('h3');confirmTitle.textContent='开始前确认';
  confirmation.append(confirmTitle,paragraph('请让所有成员先退出语音。开始后请保持此窗口和房间连接；提交前可以取消，原历史不会被替换。确认提交后无法切回明文。','dialog-text'));body.append(confirmation);
  const stageList=document.createElement('div');stageList.style.display='grid';stageList.style.gap='8px';stageList.hidden=true;
  const assetStatus=paragraph('01  文件 · 等待开始','settings-hint'),messageStatus=paragraph('02  历史 · 等待开始','settings-hint'),commitStatus=paragraph('03  切换 · 等待验证','settings-hint');
  stageList.append(assetStatus,messageStatus,commitStatus);body.append(stageList);
  const progress=document.createElement('progress');progress.id='contentMigrationProgress';progress.dataset.testid=progress.id;progress.max=1;progress.value=0;progress.hidden=true;progress.style.width='100%';progress.style.accentColor='var(--accent)';progress.setAttribute('aria-label','历史加密迁移进度');body.append(progress);
  const status=paragraph(options.content.encrypted?'房间密钥保存在此设备的 Windows 安全存储中。':options.owner?'仅服主可以发起这次迁移。':'请由服主在 Windows 桌面客户端中启用。','screen-settings-status');status.id='contentMigrationStatus';status.dataset.testid=status.id;status.setAttribute('role','status');status.setAttribute('aria-live','polite');body.append(status);
  const closeButton=button('contentMigrationClose','关闭','btn ghost'),startButton=button('contentMigrationStart','加密全部历史','btn primary'),confirmButton=button('contentMigrationConfirm','确认并开始','btn primary'),cancelButton=button('contentMigrationCancel','取消迁移','btn ghost');
  startButton.hidden=options.content.encrypted || !options.owner;confirmButton.hidden=true;cancelButton.hidden=true;
  let busy=false,cancelRequested=false,beginSent=false,commitSent=false,committed=false,closed=false;
  /** @type {string|null} */let migrationId=null;
  /** @type {AbortController|null} */let controller=null;
  const modalOptions={title:'房间内容加密',body,width:560,footer:[closeButton,cancelButton,startButton,confirmButton],locked:true};
  const dialog=options.modal(modalOptions);
  /** @param {string} text @param {'running'|'error'|'saved'} result @returns {void} */
  function showStatus(text,result){status.textContent=text;status.dataset.state=result;}
  /** @returns {void} */
  function close(){if(busy)throw new DOMException('请等待迁移完成或取消确认后再关闭','InvalidStateError');if(closed)return;closed=true;dialog.close();}
  closeButton.addEventListener('click',close);
  startButton.addEventListener('click',()=>{if(busy)return;confirmation.hidden=false;confirmButton.hidden=false;startButton.hidden=true;closeButton.textContent='暂不迁移';confirmButton.focus();});
  cancelButton.addEventListener('click',()=>{
    if(!busy || commitSent)return;cancelRequested=true;cancelButton.disabled=true;
    showStatus('正在取消，等待服务器确认；原历史尚未切换。','running');
    if(migrationId)controller?.abort(new DOMException('用户取消了历史迁移','AbortError'));
  });
  /** @returns {Promise<void>} */
  async function migrate(){
    if(busy || !options.owner || options.content.encrypted || confirmation.hidden)return;
    busy=true;cancelRequested=false;beginSent=false;commitSent=false;committed=false;migrationId=null;controller=new AbortController();
    const signal=controller.signal;
    closeButton.disabled=true;confirmButton.hidden=true;startButton.hidden=true;cancelButton.hidden=false;cancelButton.disabled=false;confirmation.hidden=true;stageList.hidden=false;progress.hidden=false;body.setAttribute('aria-busy','true');
    try{
      options.onBusy(true);showStatus('正在准备此设备的房间密钥…','running');
      const prepared=await options.content.prepare();
      if(prepared.roomId!==options.descriptor.roomId || prepared.creatorKey!==options.descriptor.creatorKey || options.journal.roomId!==options.descriptor.roomId)throw new TypeError('当前房间身份与密钥准备结果不一致');
      if(cancelRequested)throw new DOMException('用户取消了历史迁移','AbortError');
      showStatus('正在等待服务器冻结历史快照…','running');
      beginSent=true;
      const begun=mediaObject(await options.client.call({t:'contentRequest',op:'begin',keyId:prepared.keyId},signal),'历史迁移快照');
      migrationId=mediaId(begun.migrationId,'历史迁移编号');
      const count=mediaInteger(begun.count,'历史条数',0,144000);
      if(!Array.isArray(begun.assets) || begun.assets.length>4096)throw new RangeError('迁移文件清单超过允许范围');
      const sources=begun.assets.map(parseMediaMetadata);
      if(new Set(sources.map(asset=>asset.sha256)).size!==sources.length)throw new TypeError('迁移文件清单包含重复内容');
      if(cancelRequested)throw new DOMException('用户取消了历史迁移','AbortError');
      /** @type {Map<string,MediaMetadata>} */const replacements=new Map();
      /** @type {ContentAsset[]} */const mapping=[];
      progress.max=Math.max(1,sources.length+count+1);progress.value=0;
      for(let index=0;index<sources.length;index++){
        signal.throwIfAborted();const source=sources[index];if(source.encrypted)throw new TypeError('明文房间清单中出现了未确认的加密文件');
        assetStatus.textContent='01  文件 · '+(index+1)+' / '+sources.length;showStatus('正在加密并回读验证文件 '+(index+1)+' / '+sources.length+'…','running');
        const emoji=options.emojis.find(item=>item.asset.sha256===source.sha256),kind=emoji?'server':'image',domainId=emoji?emoji.domainId:null;
        const original=await options.client.download(source,signal),sealed=await options.content.sealMigrationMedia(original,source,kind);signal.throwIfAborted();
        const uploaded=await options.client.upload(sealed.blob,sealed.asset,kind,domainId,signal);
        if(uploaded.encrypted!==true || uploaded.mediaKind!==kind || uploaded.sha256!==sealed.asset.sha256)throw new TypeError('加密文件上传结果与预期不一致');
        const downloaded=await options.client.download(uploaded,signal),verified=await options.content.verifyMigrationMedia(downloaded,uploaded);signal.throwIfAborted();
        if(verified.asset.sha256!==source.sha256 || verified.blob.size!==source.bytes || await digest(verified.blob)!==source.sha256)throw new TypeError('服务器回读文件解密后与原文件不一致，迁移已停止');
        replacements.set(source.sha256,uploaded);mapping.push({source:source.sha256,asset:uploaded});progress.value=index+1;
      }
      assetStatus.textContent='01  文件 · '+sources.length+' / '+sources.length+' 已验证';
      for(let index=0;index<count;index++){
        signal.throwIfAborted();messageStatus.textContent='02  历史 · '+(index+1)+' / '+count;showStatus('正在加密历史 '+(index+1)+' / '+count+'…','running');
        const entry=mediaObject(await options.client.call({t:'contentRequest',op:'read',migrationId,index},signal),'历史迁移条目');
        const channelId=mediaId(entry.channelId,'历史频道');if(entry.message===undefined)throw new TypeError('历史迁移条目缺少消息');
        const message=parseChatMessage(entry.message),attachment=message.attachment?mapAttachment(message.attachment,replacements):null;
        const reactions=message.reactions?.map(reaction=>reaction.kind==='server'?{...reaction,asset:replacement(reaction.asset,replacements)}:reaction);
        const requestId=await migrationRequest(message.id);
        const sealed=await options.content.sealMigrationMessage(channelId,requestId,{text:message.text,...(attachment?{attachment}:{}),...(reactions?{reactions:parseReactions(reactions)}:{}),...(message.reactionRevision===undefined?{}:{reactionRevision:message.reactionRevision})});signal.throwIfAborted();
        const result=mediaObject(await options.client.call({t:'contentRequest',op:'replace',migrationId,channelId,messageId:message.id,sealed,...(attachment?{attachment:{...attachment,name:'encrypted.avif'}}:{})},signal),'加密历史暂存结果');
        if(result.replaced!==index+1 || result.count!==count)throw new TypeError('服务器历史暂存进度与当前条目不一致');
        progress.value=sources.length+index+1;
      }
      messageStatus.textContent='02  历史 · '+count+' / '+count+' 已暂存';commitStatus.textContent='03  切换 · 正在签署完整清单';
      const policy=await options.content.signPolicy(mapping);signal.throwIfAborted();
      if(policy.roomId!==options.descriptor.roomId || policy.keyId!==prepared.keyId || policy.keyHash!==prepared.keyHash || policy.governanceRevision!==governanceRevision(options.journal))throw new TypeError('加密清单签名与当前房间状态不一致');
      if(cancelRequested)throw new DOMException('用户取消了历史迁移','AbortError');
      commitSent=true;cancelButton.disabled=true;commitStatus.textContent='03  切换 · 等待服务器统一提交';showStatus('正在统一切换加密历史，此阶段请保持连接…','running');
      const result=mediaObject(await options.client.call({t:'contentRequest',op:'commit',migrationId,policy},signal),'历史加密提交结果');
      if(result.content===undefined || JSON.stringify(parseContentPolicy(result.content))!==JSON.stringify(policy))throw new TypeError('服务器没有确认相同的加密策略');
      committed=true;migrationId=null;progress.value=progress.max;commitStatus.textContent='03  切换 · 已提交';
      await options.onComplete(policy);state.textContent='已启用端到端加密';description.textContent='聊天内容、全部已迁移历史，以及图片和表情文件已切换为加密内容。';notice.textContent='新的房间邀请包含解密密钥，请只交给可信成员。过去已经保存或转发的明文副本无法收回。';
      showStatus('全部历史迁移完成；当前设备已启用房间密钥。','saved');
    }catch(error){
      const failure=error instanceof Error?error:new TypeError('历史迁移返回了非错误类型',{cause:error});
      if(committed || 'activated' in failure && failure.activated===true){showStatus('服务器已切换加密，但本机刷新尚未完成。请重新连接，核对加密状态后继续。','error');options.reportError(failure);}
      else if(commitSent){showStatus('提交结果尚未确认。请重新连接核对房间状态；此处不会自动恢复明文。','error');options.reportError(failure);}
      else if(migrationId){
        try{
          const cancelled=mediaObject(await options.client.call({t:'contentRequest',op:'cancel',migrationId},AbortSignal.timeout(90000)),'取消历史迁移');
          if(cancelled.cancelled!==true)throw new TypeError('服务器未确认取消历史迁移');
          migrationId=null;showStatus(cancelRequested?'迁移已取消，原历史保持不变。':'迁移未提交，服务器已取消暂存；原历史保持不变。','error');
        }catch(cancelError){const cancellation=cancelError instanceof Error?cancelError:new TypeError('取消迁移返回了非错误类型',{cause:cancelError});showStatus('取消尚未确认，房间可能仍处于迁移冻结状态。请重新连接核对，原历史尚未确认切换。','error');options.reportError(cancellation);}
        if(!cancelRequested)options.reportError(failure);
      }else if(beginSent){showStatus('服务器尚未确认迁移状态，房间可能仍处于冻结状态。请重新连接核对；此处尚未提交历史切换。','error');options.reportError(failure);}
      else{showStatus(cancelRequested?'迁移已取消，尚未冻结房间。':'迁移未能开始：'+failure.message,'error');if(!cancelRequested)options.reportError(failure);}
    }finally{busy=false;controller=null;cancelButton.hidden=true;closeButton.disabled=false;closeButton.textContent='关闭';body.removeAttribute('aria-busy');options.onBusy(false);}
  }
  confirmButton.addEventListener('click',()=>{void migrate().catch(error=>options.reportError(error instanceof Error?error:new TypeError(String(error))));});
  return {close};
}
