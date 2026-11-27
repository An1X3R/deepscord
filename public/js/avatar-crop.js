// @ts-check
import {loadAvatarImage,encodeAvatarCrop} from './profile.js';
/** @typedef {{x:number,y:number,zoom:number}} CropPosition */
/** @typedef {{width:number,height:number}} ImageSize */
/** @typedef {{close:()=>void}} Modal */
/** @typedef {(options:{title:string,body:HTMLElement,width:number,footer:HTMLElement[],onClose:()=>void})=>Modal} OpenModal */
/** @param {ImageSize} image @param {CropPosition} position @returns {{x:number,y:number,size:number}} */
export function avatarCropRect(image,position){
  if(!Number.isFinite(image.width)||!Number.isFinite(image.height)||image.width<=0||image.height<=0||!Number.isFinite(position.x)||!Number.isFinite(position.y)||!Number.isFinite(position.zoom)||position.zoom<1||position.zoom>8)throw new RangeError('Invalid avatar crop dimensions or zoom.');
  const size=Math.min(image.width,image.height)/position.zoom;
  return{x:Math.max(0,Math.min(image.width-size,position.x-size/2)),y:Math.max(0,Math.min(image.height-size,position.y-size/2)),size};
}
/** @param {ImageSize} image @param {CropPosition} position @returns {CropPosition} */
function constrain(image,position){const rect=avatarCropRect(image,position);return{x:rect.x+rect.size/2,y:rect.y+rect.size/2,zoom:position.zoom};}
/** @param {File} file @param {OpenModal} openModal @param {AbortSignal} signal @returns {Promise<string|null>} */
export async function cropAvatar(file,openModal,signal){
  signal.throwIfAborted();const bitmap=await loadAvatarImage(file);
  if(signal.aborted){bitmap.close();signal.throwIfAborted();}
  try{return await new Promise((resolve,reject)=>{
    let position={x:bitmap.width/2,y:bitmap.height/2,zoom:1},settled=false;
    /** @type {{id:number,x:number,y:number}|null} */let drag=null;
    const controls=new AbortController(),events={signal:controls.signal};
    const body=document.createElement('div');body.id='avatarCropEditor';body.className='avatar-crop-editor';
    const frame=document.createElement('div');frame.className='avatar-crop-frame';
    const canvas=document.createElement('canvas');canvas.id='avatarCropCanvas';canvas.width=512;canvas.height=512;canvas.tabIndex=0;canvas.setAttribute('aria-label','头像裁剪区域，拖动或按方向键移动图像');
    const drawing=canvas.getContext('2d');if(!drawing)throw new Error('Avatar preview canvas is unavailable.');const context=drawing;
    frame.append(canvas);
    const guide=document.createElement('p');guide.id='avatarCropHint';guide.className='settings-hint';guide.textContent='拖动画面选择区域，滚轮或滑条缩放；方向键微调。';canvas.setAttribute('aria-describedby',guide.id);
    const zoomRow=document.createElement('div');zoomRow.className='avatar-crop-zoom';
    const label=document.createElement('label');label.htmlFor='avatarCropZoom';label.textContent='缩放';
    const zoom=document.createElement('input');zoom.id='avatarCropZoom';zoom.type='range';zoom.min='1';zoom.max='8';zoom.step='0.01';zoom.value='1';
    const value=document.createElement('output');value.id='avatarCropZoomValue';value.htmlFor.add(zoom.id);
    zoomRow.append(label,zoom,value);body.append(frame,guide,zoomRow);
    /** @param {string} id @param {string} text @param {string} css @returns {HTMLButtonElement} */
    function button(id,text,css){const node=document.createElement('button');node.id=id;node.type='button';node.className='btn '+css;node.textContent=text;return node;}
    const reset=button('avatarCropReset','重置','ghost'),cancel=button('avatarCropCancel','取消','ghost'),save=button('avatarCropSave','使用此头像','primary');
    /** @returns {void} */function cleanup(){controls.abort();signal.removeEventListener('abort',abort);drag=null;canvas.width=1;canvas.height=1;}
    /** @param {string|null} result @returns {void} */function finish(result){if(settled)return;settled=true;cleanup();resolve(result);}
    const modal=openModal({title:'选择头像区域',body,width:440,footer:[reset,cancel,save],onClose:()=>finish(null)});
    /** @returns {void} */function abort(){finish(null);modal.close();}
    /** @returns {void} */function render(){
      position=constrain(bitmap,position);const rect=avatarCropRect(bitmap,position);
      context.clearRect(0,0,canvas.width,canvas.height);context.imageSmoothingQuality='high';
      context.drawImage(bitmap,rect.x,rect.y,rect.size,rect.size,0,0,canvas.width,canvas.height);
      zoom.value=String(position.zoom);value.value=Math.round(position.zoom*100)+'%';
    }
    /** @param {number} amount @param {number} u @param {number} v @returns {void} */
    function zoomAt(amount,u,v){const before=avatarCropRect(bitmap,position),after=Math.min(bitmap.width,bitmap.height)/amount;position={x:before.x+before.size*u+(0.5-u)*after,y:before.y+before.size*v+(0.5-v)*after,zoom:amount};render();}
    zoom.addEventListener('input',()=>zoomAt(Number(zoom.value),0.5,0.5),events);
    reset.addEventListener('click',()=>{position={x:bitmap.width/2,y:bitmap.height/2,zoom:1};render();},events);
    cancel.addEventListener('click',()=>{finish(null);modal.close();},events);
    save.addEventListener('click',()=>{try{const result=encodeAvatarCrop(bitmap,avatarCropRect(bitmap,position));finish(result);modal.close();}catch(error){settled=true;cleanup();modal.close();reject(error);}},events);
    canvas.addEventListener('pointerdown',event=>{if(event.button!==0)return;canvas.focus();canvas.setPointerCapture(event.pointerId);drag={id:event.pointerId,x:event.clientX,y:event.clientY};},events);
    canvas.addEventListener('pointermove',event=>{if(!drag||drag.id!==event.pointerId)return;const scale=avatarCropRect(bitmap,position).size/canvas.getBoundingClientRect().width;position={...position,x:position.x-(event.clientX-drag.x)*scale,y:position.y-(event.clientY-drag.y)*scale};drag={id:event.pointerId,x:event.clientX,y:event.clientY};render();},events);
    canvas.addEventListener('lostpointercapture',()=>{drag=null;},events);
    canvas.addEventListener('pointerup',event=>{if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);drag=null;},events);
    canvas.addEventListener('wheel',event=>{event.preventDefault();const rect=canvas.getBoundingClientRect();zoomAt(Math.max(1,Math.min(8,position.zoom*Math.exp(-Math.max(-200,Math.min(200,event.deltaY))*0.002))),(event.clientX-rect.left)/rect.width,(event.clientY-rect.top)/rect.height);},{...events,passive:false});
    canvas.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const step=avatarCropRect(bitmap,position).size*(event.shiftKey?0.1:0.02);position={...position,x:position.x+(event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0),y:position.y+(event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0)};render();},events);
    signal.addEventListener('abort',abort,{once:true});render();canvas.focus();
  });}finally{bitmap.close();}
}
