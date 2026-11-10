// @ts-check
/** @typedef {import('./sticker-panel.js').MediaLease} MediaLease */
/** @typedef {{kind:'image',name:string,sha256:string,width:number,height:number,animated:boolean,frames:number,durationMs:number,bytes:number,preview:MediaLease,payload:Blob}} PreparedImage */
/** @typedef {{input:HTMLTextAreaElement,form:HTMLFormElement,host:HTMLElement,openStickers:()=>void,prepareImage:(file:File,signal:AbortSignal)=>Promise<PreparedImage>,sendImage:(image:PreparedImage,signal:AbortSignal)=>Promise<void>,reportError:(error:Error)=>void}} MediaComposerOptions */
/** @typedef {'idle'|'preparing'|'staged'|'sending'|'destroyed'} ComposerMediaPhase */

/** @param {string} id @returns {HTMLButtonElement} */
function requiredButton(id){const control=document.getElementById(id);if(!(control instanceof HTMLButtonElement))throw new Error('Missing media composer button: '+id);return control;}
/** @param {string} id @param {string} text @param {string} className @returns {HTMLButtonElement} */
function button(id,text,className){const control=document.createElement('button');control.id=id;control.type='button';control.textContent=text;control.className=className;return control;}
/** @param {File} file @returns {boolean} */
function isImage(file){return file.type.startsWith('image/') || /\.(avif|gif|png|jpe?g|webp|apng|bmp)$/i.test(file.name);}
/** @param {PreparedImage} image @returns {void} */
function validatePreparedImage(image){
  if(image.kind!=='image' || !(image.payload instanceof Blob) || image.payload.type!=='image/avif')throw new TypeError('Image encoder must return a pure AVIF Blob');
  if(typeof image.sha256!=='string' || !/^[a-f0-9]{64}$/.test(image.sha256))throw new TypeError('Image encoder must return a canonical SHA256');
  if(!Number.isSafeInteger(image.width) || image.width<1 || image.width>1920 || !Number.isSafeInteger(image.height) || image.height<1 || image.height>1920)throw new RangeError('Chat image dimensions must be within 1920 × 1920');
  if(image.bytes!==image.payload.size || image.bytes<1 || image.bytes>1572864)throw new RangeError('Chat image must contain at most 1.5 MiB of AVIF data');
  if(!Number.isSafeInteger(image.frames) || image.frames<1 || !Number.isFinite(image.durationMs) || image.durationMs<0 || image.animated!== (image.frames>1))throw new TypeError('Image animation metadata is inconsistent');
  if(!image.preview.url || typeof image.preview.release!=='function')throw new TypeError('Image preview must provide an owned media lease');
}

/** @param {HTMLTextAreaElement} input @param {string} emoji @returns {void} */
export function insertComposerUnicode(input,emoji){const start=input.selectionStart,end=input.selectionEnd;if(input.value.length-(end-start)+emoji.length>input.maxLength && input.maxLength>=0)throw new RangeError('消息已达到输入长度上限');input.setRangeText(emoji,start,end,'end');input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();}

/** @param {MediaComposerOptions} options */
export function createMediaComposer(options){
  const emoji=requiredButton('emojiPanelBtn'),upload=requiredButton('imageUploadBtn');
  const picker=document.createElement('input');picker.id='chatImageFileInput';picker.type='file';picker.accept='image/*,.avif,.gif,.png,.jpg,.jpeg,.webp,.apng';picker.hidden=true;
  const preview=document.createElement('section');preview.id='mediaComposerPreview';preview.className='media-composer-preview';preview.hidden=true;preview.setAttribute('aria-label','待发送图片');
  const image=document.createElement('img');image.id='mediaComposerImage';image.alt='待发送图片预览';image.decoding='async';
  const info=document.createElement('div');info.className='media-composer-info';
  const title=document.createElement('strong');title.id='mediaComposerName';
  const status=document.createElement('p');status.id='mediaComposerStatus';status.setAttribute('role','status');
  info.append(title,status);
  const send=button('mediaSendBtn','发送图片','btn primary small'),cancel=button('mediaCancelBtn','取消','btn ghost small');
  preview.append(image,info,send,cancel);options.host.insertBefore(preview,options.form);options.host.append(picker);
  const events=new AbortController();
  /** @type {ComposerMediaPhase} */let phase='idle';
  /** @type {PreparedImage|null} */let prepared=null;
  /** @type {AbortController|null} */let operation=null;
  let generation=0;

  /** @param {Error} error @returns {void} */
  function report(error){status.textContent=error.message;status.setAttribute('role','alert');options.reportError(error);}
  /** @returns {void} */
  function release(){image.removeAttribute('src');prepared?.preview.release();prepared=null;}
  /** @returns {void} */
  function reset(){generation+=1;operation?.abort();operation=null;release();phase='idle';preview.hidden=true;send.disabled=true;upload.disabled=false;options.host.classList.remove('media-drop-active');}
  /** @param {readonly File[]} files @returns {Promise<void>} */
  async function stageFiles(files){
    if(phase==='destroyed')throw new Error('Media composer has been destroyed');
    if(files.length!==1){report(new RangeError('图片每次只能发送 1 张；批量表情请使用表情库导入'));return;}
    if(phase!=='idle'){report(new Error('请先发送或取消当前暂存图片'));return;}
    const file=files[0];if(!isImage(file)){report(new TypeError('请选择图片文件'));return;}
    phase='preparing';const controller=new AbortController(),version=++generation;operation=controller;
    preview.hidden=false;send.disabled=true;upload.disabled=true;image.hidden=true;title.textContent=file.name;status.textContent='正在编码为 AVIF…';status.setAttribute('role','status');
    try{
      const result=await options.prepareImage(file,controller.signal);
      if(controller.signal.aborted || version!==generation){result.preview.release();return;}
      try{validatePreparedImage(result);}catch(error){result.preview.release();throw error;}
      prepared=result;phase='staged';operation=null;image.src=result.preview.url;image.hidden=false;image.width=result.width;image.height=result.height;
      title.textContent=result.name;status.textContent=result.width+' × '+result.height+' · '+Math.ceil(result.bytes/1024)+' KiB'+(result.animated ? ' · '+result.frames+' 帧动图' : ' · 静态图片');send.disabled=false;
    }catch(error){if(controller.signal.aborted)return;phase='idle';operation=null;upload.disabled=false;report(error instanceof Error ? error : new Error(String(error)));}
  }
  emoji.setAttribute('aria-expanded','false');emoji.addEventListener('click',options.openStickers,{signal:events.signal});upload.addEventListener('click',()=>picker.click(),{signal:events.signal});
  picker.addEventListener('change',()=>{const files=[...(picker.files ?? [])];picker.value='';if(files.length)void stageFiles(files);},{signal:events.signal});
  send.addEventListener('click',async()=>{
    if(phase!=='staged' || !prepared)return;phase='sending';send.disabled=true;const controller=new AbortController(),version=generation;operation=controller;status.textContent='正在发送图片…';status.setAttribute('role','status');
    try{await options.sendImage(prepared,controller.signal);if(!controller.signal.aborted && version===generation)reset();}
    catch(error){if(controller.signal.aborted)return;phase='staged';operation=null;send.disabled=false;report(error instanceof Error ? error : new Error(String(error)));}
  },{signal:events.signal});
  cancel.addEventListener('click',reset,{signal:events.signal});
  image.addEventListener('error',()=>{if(phase==='staged'){send.disabled=true;report(new Error('AVIF 预览无法解码，请取消后检查图片'));}},{signal:events.signal});
  options.input.addEventListener('paste',event=>{const files=[...(event.clipboardData?.files ?? [])].filter(isImage);if(!files.length)return;event.preventDefault();void stageFiles(files);},{signal:events.signal});
  options.host.addEventListener('dragover',event=>{if(!event.dataTransfer?.types.includes('Files'))return;event.preventDefault();options.host.classList.add('media-drop-active');},{signal:events.signal});
  options.host.addEventListener('dragleave',event=>{if(event.relatedTarget instanceof Node && options.host.contains(event.relatedTarget))return;options.host.classList.remove('media-drop-active');},{signal:events.signal});
  options.host.addEventListener('drop',event=>{options.host.classList.remove('media-drop-active');const files=[...(event.dataTransfer?.files ?? [])].filter(isImage);if(!files.length)return;event.preventDefault();void stageFiles(files);},{signal:events.signal});
  /** @returns {void} */
  function destroy(){if(phase==='destroyed')return;reset();phase='destroyed';events.abort();preview.remove();picker.remove();}
  return {stageFiles,cancel:()=>{if(phase!=='destroyed')reset();},destroy,getPhase:()=>phase};
}
