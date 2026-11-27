// @ts-check
/** @typedef {import('./chat-protocol.js').ChatMessage} ChatMessage */
/** @typedef {import('./chat-view.js').ChatAuthor} ChatAuthor */
/** @typedef {{onReply:(message:ChatMessage)=>void,onUnavailable:()=>void,reportError:(error:Error)=>void}} ChatActions */
/** @param {ChatMessage} message @returns {string} */
export function messageSummary(message){return (message.text.trim()||('['+(message.attachment?.kind==='sticker'?'表情':'图片')+']')).replace(/\s+/g,' ').slice(0,100);}
/** @param {string} text @returns {{label:string,url:string}[]} */
export function localLinkCards(text){
  /** @type {Map<string,{label:string,url:string}>} */const links=new Map();
  for(const match of text.matchAll(/\bBV[A-Za-z0-9]{10}\b/g))links.set('https://www.bilibili.com/video/'+match[0],{label:'哔哩哔哩 · '+match[0],url:'https://www.bilibili.com/video/'+match[0]});
  for(const match of text.matchAll(/https?:\/\/music\.163\.com\/[^\s<>"）)]*/g)){
    const url=new URL(match[0]);
    const location=url.hash.startsWith('#/')?new URL(url.hash.slice(1),url.origin):url;
    const id=location.searchParams.get('id');
    if(location.pathname!=='/song'||!id||!/^\d{1,20}$/.test(id))continue;
    const target='https://music.163.com/#/song?id='+id;links.set(target,{label:'网易云音乐 · 单曲 '+id,url:target});
  }
  return [...links.values()].slice(0,3);
}
/** @param {HTMLElement} container */
export function createChatExtras(container){
  /** @type {ChatActions|null} */let actions=null;
  /** @type {Map<string,ChatMessage>} */let messages=new Map();
  /** @type {ReadonlyMap<string,ChatAuthor>} */let authors=new Map();
  const events=new AbortController();
  /** @type {Map<HTMLButtonElement,ReturnType<typeof setTimeout>>} */const timers=new Map();
  /** @param {Event} event @returns {Promise<void>} */
  async function click(event){
    const target=event.target instanceof Element?event.target.closest('button'):null;
    if(!(target instanceof HTMLButtonElement))return;
    if(target.dataset.chatReply){const message=messages.get(target.dataset.chatReply);if(message)actions?.onReply(message);}
    if(target.dataset.chatReference){
      const row=[...container.querySelectorAll('[data-msg-id]')].find(node=>node instanceof HTMLElement&&node.dataset.msgId===target.dataset.chatReference);
      if(!row){actions?.onUnavailable();return;}
      const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
      row.scrollIntoView({block:'center',behavior:reduced?'instant':'smooth'});
      if(!reduced){for(const animation of row.getAnimations())animation.cancel();row.animate([{backgroundColor:'var(--accent-soft)'},{backgroundColor:'transparent'}],{duration:1200});}
    }
    if(target.dataset.codeCopy!==undefined){
      const code=target.parentElement?.querySelector('pre code');if(!code)throw new Error('代码块已移除，请重新打开消息');
      await navigator.clipboard.writeText(code.textContent??'');
      if(!target.isConnected)return;
      const previous=timers.get(target);if(previous)clearTimeout(previous);
      target.textContent='已复制 ✓';
      timers.set(target,setTimeout(()=>{target.textContent='复制';timers.delete(target);},1600));
    }
  }
  container.addEventListener('click',event=>{void click(event).catch(error=>{if(actions)actions.reportError(error instanceof Error?error:new Error(String(error)));else console.error('chat_action_failed',{message:String(error)});});},{signal:events.signal});
  /** @param {HTMLElement} row @param {ChatMessage} message @returns {void} */
  function update(row,message){
    if(message.system)return;
    const body=row.querySelector('.msg-body');if(!body)return;
    if(actions){
      const toolbars=[...row.querySelectorAll('.chat-message-actions')];
      let toolbar=toolbars.at(-1);
      if(!toolbar){toolbar=document.createElement('div');toolbar.className='chat-message-actions';row.append(toolbar);}
      for(const extra of toolbars)if(extra!==toolbar){toolbar.append(...extra.childNodes);extra.remove();}
      if(!toolbar.querySelector('[data-chat-reply]')){const reply=document.createElement('button');reply.type='button';reply.className='btn small ghost';reply.dataset.chatReply=message.id;reply.dataset.testid='message-reply';reply.textContent='回复';toolbar.append(reply);}
    }
    let reference=body.querySelector('.chat-reference');
    if(message.replyToId){
      if(!reference){reference=document.createElement('button');reference.className='chat-reference';body.prepend(reference);}
      const button=/** @type {HTMLButtonElement} */(reference);button.type='button';button.dataset.chatReference=message.replyToId;button.dataset.testid='message-reference';
      const original=messages.get(message.replyToId),author=original?authors.get(original.authorId??original.userId):null;
      button.textContent=original?(author?.name??original.name)+' · '+messageSummary(original):'原消息暂不可用';
    }else reference?.remove();
    for(const pre of body.querySelectorAll('.msg-text pre')){
      if(pre.parentElement?.classList.contains('message-code'))continue;
      const wrapper=document.createElement('div');wrapper.className='message-code';pre.replaceWith(wrapper);wrapper.append(pre);
      const copy=document.createElement('button');copy.type='button';copy.className='code-copy';copy.dataset.codeCopy='';copy.dataset.testid='code-copy';copy.textContent='复制';wrapper.append(copy);
    }
    const text=body.querySelector('.msg-text');
    if(text&&!body.querySelector('.chat-link-cards')){
      const cards=localLinkCards(message.text.replace(/```[\s\S]*?```|`[^`\n]+`/g,''));
      if(cards.length){const group=document.createElement('div');group.className='chat-link-cards';for(const card of cards){const link=document.createElement('a');link.className='chat-link-card';link.href=card.url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=card.label+' ↗';group.append(link);}text.after(group);}
    }
    for(const [button,timer] of timers)if(!button.isConnected){clearTimeout(timer);timers.delete(button);}
  }
  return {update,setActions:(/** @type {ChatActions} */ value)=>{if(typeof value.onReply!=='function'||typeof value.onUnavailable!=='function'||typeof value.reportError!=='function')throw new TypeError('Chat actions require reply, unavailable and error handlers');actions=value;},setSnapshot:(/** @type {readonly ChatMessage[]} */ value,/** @type {ReadonlyMap<string,ChatAuthor>} */ people)=>{messages=new Map(value.map(message=>[message.id,message]));authors=people;},destroy:()=>{events.abort();for(const timer of timers.values())clearTimeout(timer);timers.clear();messages.clear();authors=new Map();}};
}
