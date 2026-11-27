// @ts-check
import {messageSummary} from './chat-extras.js';
/** @typedef {{channelId:string,messageId:string}} ReplyDraft */
/** @param {HTMLElement} host @param {HTMLTextAreaElement} input */
export function createReplyComposer(host,input){
  const bar=document.createElement('div');bar.id='replyComposer';bar.className='reply-composer';bar.hidden=true;bar.setAttribute('role','status');
  const label=document.createElement('span');label.id='replyComposerLabel';
  const cancel=document.createElement('button');cancel.id='replyCancelBtn';cancel.type='button';cancel.className='btn small ghost';cancel.textContent='×';cancel.setAttribute('aria-label','取消回复');bar.append(label,cancel);host.prepend(bar);
  /** @type {ReplyDraft|null} */let draft=null;
  const events=new AbortController();
  /** @returns {void} */function clear(){draft=null;bar.hidden=true;label.textContent='';}
  cancel.addEventListener('click',()=>{clear();input.focus();},{signal:events.signal});
  input.addEventListener('keydown',event=>{if(event.key==='Escape'&&draft){event.preventDefault();clear();}},{signal:events.signal});
  /** @param {string} channelId @param {import('./chat-protocol.js').ChatMessage} message @param {string} author @returns {void} */
  function select(channelId,message,author){draft={channelId,messageId:message.id};label.textContent='正在回复 @'+author+' · '+messageSummary(message);bar.hidden=false;input.focus();}
  return {select,clear,get:()=>draft,clearSent:(/** @type {ReplyDraft|null} */ sent)=>{if(sent===draft)clear();},destroy:()=>{events.abort();bar.remove();draft=null;}};
}
