// @ts-check
import {createChatMediaView} from './chat-media-view.js';
import {createChatExtras} from './chat-extras.js';
export {parseChatMessage} from './chat-protocol.js';
/** @typedef {import('./chat-protocol.js').ChatMessage} ChatMessage */
/** @typedef {import('./chat-media-view.js').ChatMediaAdapter} ChatMediaAdapter */
/** @typedef {{id:string,name:string,type:'voice'|'text'}} ChatChannel */
/** @typedef {{name:string,color:string,avatar?:string|null,titles?:string[]}} ChatAuthor */
/** @typedef {{escape:(text:string)=>string,body:(text:string)=>string,time:(ts:number)=>string,day:(ts:number)=>string,color:(seed:string)=>string,avatar:(author:ChatAuthor,size:number,className:string)=>string,icon:(name:string,size:number)=>string}} ChatFormatting */
/** @typedef {{message:ChatMessage,author:ChatAuthor,grouped:boolean,titleSignature:string,node:HTMLElement}} CachedRow */
/** @typedef {{channel:ChatChannel|null,messages:readonly ChatMessage[],authors:ReadonlyMap<string,ChatAuthor>,selfKey?:string|null,members?:readonly {memberKey:string,name:string}[]}} ChatSnapshot */

/** @param {string} text @param {(text:string)=>string} format @returns {string} */
export function renderMessageBody(text,format){return format(text);}
/** @param {ChatMessage} left @param {ChatMessage} right @returns {boolean} */
function sameText(left,right){return left.id===right.id && left.replyToId===right.replyToId && left.userId===right.userId && left.authorId===right.authorId && left.name===right.name && left.color===right.color && left.text===right.text && left.ts===right.ts && left.system===right.system && left.bot===right.bot;}

/** @param {HTMLElement} row @param {readonly string[]} titles @returns {void} */
function updateTitles(row,titles){
  const head=row.querySelector('.msg-head');
  if(!head)return;
  head.querySelectorAll('.msg-author-title').forEach(node=>node.remove());
  const time=head.querySelector('.msg-time');
  for(const title of titles){const badge=document.createElement('span');badge.className='badge-bot msg-author-title';badge.textContent=title;head.insertBefore(badge,time);}
}

/** @param {HTMLElement} container @param {ChatFormatting} format */
export function createChatView(container,format){
  const extras=createChatExtras(container);
  /** @type {Map<string,CachedRow>} */let rows=new Map();
  /** @type {Map<string,HTMLElement>} */let dividers=new Map();
  /** @type {string|null} */let channelId=null;
  let introSignature='',mentionSignature='';
  /** @type {readonly {memberKey:string,name:string}[]} */let mentionMembers=[];
  /** @type {string|null} */let mentionSelf=null;
  /** @type {HTMLElement|null} */let intro=null;
  /** @type {HTMLElement|null} */let empty=null;
  /** @type {ReturnType<typeof createChatMediaView>|null} */let media=null;

  /** @param {string} text @returns {string} */
  function mentionPlain(text){const expression=/<@(MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=)>/g;let output='',offset=0;for(const match of text.matchAll(expression)){output+=format.body(text.slice(offset,match.index));const member=mentionMembers.find(item=>item.memberKey===match[1]);output+=member?'<span class="chat-mention'+(member.memberKey===mentionSelf?' self':'')+'">@'+format.escape(member.name)+'</span>':format.body(match[0]);offset=match.index+match[0].length;}return output+format.body(text.slice(offset));}
  /** @param {string} text @returns {string} */
  function mentionBody(text){let output='',offset=0;for(const match of text.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)){output+=mentionPlain(text.slice(offset,match.index))+format.body(match[0]);offset=match.index+match[0].length;}return output+mentionPlain(text.slice(offset));}
  /** @param {ChatMessage} message @param {ChatAuthor} author @param {boolean} grouped @returns {HTMLElement} */
  function messageNode(message,author,grouped){
    const node=document.createElement('div');node.className=message.system ? 'msg system' : 'msg';
    if(!message.system)node.dataset.msgId=message.id;
    const body=message.text.trim() ? `<div class="msg-text">${mentionBody(message.text)}</div>` : '';
    if(message.system)node.innerHTML=`<span class="system-ico">${format.icon('signal',14)}</span><span class="system-text">${format.escape(message.text)}</span><span class="system-time">${format.time(message.ts)}</span>`;
    else if(grouped)node.innerHTML=`<div class="msg-gutter"><span class="msg-time">${format.time(message.ts)}</span></div><div class="msg-body">${body}</div>`;
    else {
      node.innerHTML=`${format.avatar(author,40,'msg-avatar')}<div class="msg-body"><div class="msg-head"><span class="msg-author" style="color:${format.escape(author.color)}">${format.escape(author.name)}</span>${message.bot ? '<span class="badge-bot">BOT</span>' : ''}<span class="msg-time">${format.time(message.ts)}</span></div>${body}</div>`;
    }
    return node;
  }

  /** @param {HTMLElement} node @param {ChatAuthor} author @returns {void} */
  function updateAuthor(node,author){
    const avatar=node.querySelector('.msg-avatar');
    if(avatar)avatar.outerHTML=format.avatar(author,40,'msg-avatar');
    const name=node.querySelector('.msg-author');
    if(name instanceof HTMLElement){name.textContent=author.name;name.style.color=author.color;}
  }

  /** @param {ChatSnapshot} snapshot @returns {void} */
  function render(snapshot){
    const {channel}=snapshot;
    extras.setSnapshot(snapshot.messages,snapshot.authors);
    const nextMentionSignature=JSON.stringify([snapshot.selfKey,snapshot.members]);const mentionsChanged=nextMentionSignature!==mentionSignature;mentionSignature=nextMentionSignature;mentionMembers=snapshot.members ?? [];mentionSelf=snapshot.selfKey ?? null;
    if(!channel){
      media?.clear();
      if(!empty){empty=document.createElement('div');empty.className='empty-hint';empty.textContent='选择一个频道开始聊天';container.replaceChildren(empty);}
      rows.clear();dividers.clear();intro=null;introSignature='';channelId=null;return;
    }
    const switched=channel.id!==channelId;
    const nearBottom=container.scrollHeight-container.scrollTop-container.clientHeight<120;
    const oldScroll=container.scrollTop;
    const top=container.getBoundingClientRect().top;
    const anchor=switched || nearBottom ? null : [...rows.values()].map(row=>row.node).find(node=>node.getBoundingClientRect().bottom>=top);
    const anchorTop=anchor?.getBoundingClientRect().top ?? 0;
    if(switched){media?.clear();rows=new Map();dividers=new Map();intro=null;container.replaceChildren();}
    channelId=channel.id;empty=null;
    const signature=JSON.stringify([channel.id,channel.name,channel.type]);
    if(!intro || signature!==introSignature){
      const voice=channel.type==='voice';
      const next=document.createElement('div');next.className='channel-intro'+(voice ? ' compact' : '');
      next.innerHTML=`<div class="intro-ico">${format.icon(voice ? 'volume' : 'hash',voice ? 20 : 28)}</div><h2>欢迎来到 ${voice ? '' : '#'}${format.escape(channel.name)}</h2><p>${voice ? '这些是分离前保留的文字记录，仅供查看；新消息请前往文字频道。' : '这是这个频道的开始，说点什么吧。'}</p>`;
      intro?.remove();intro=next;introSignature=signature;
    }
    /** @type {HTMLElement[]} */const desired=[intro];
    /** @type {Map<string,CachedRow>} */const nextRows=new Map();
    /** @type {Map<string,HTMLElement>} */const nextDividers=new Map();
    /** @type {ChatMessage|null} */let previous=null;
    let previousDay='';
    for(const message of snapshot.messages.slice(-200)){
      const day=format.day(message.ts);
      if(day!==previousDay){
        const key=day+'\u0000'+message.id;
        let divider=dividers.get(key);
        if(!divider){divider=document.createElement('div');divider.className='day-divider';const label=document.createElement('span');label.textContent=day;divider.append(label);}
        desired.push(divider);nextDividers.set(key,divider);previousDay=day;
      }
      const grouped=Boolean(!message.system && previous && (previous.authorId ?? previous.userId)===(message.authorId ?? message.userId) && message.ts-previous.ts<5*60*1000 && format.day(previous.ts)===day);
      const profile=message.bot || message.system ? undefined : snapshot.authors.get(message.authorId ?? message.userId);
      const author={name:profile?.name ?? message.name,color:profile?.color || message.color || format.color(message.name),avatar:profile?.avatar ?? null};
      const titles=profile?.titles ?? [];
      const titleSignature=JSON.stringify(titles);
      const cached=rows.get(message.id);
      let row=cached;
      if(!row)row={message,author,grouped,titleSignature:'',node:messageNode(message,author,grouped)};
      else if(mentionsChanged || !sameText(row.message,message) || row.grouped!==grouped){
        const content=messageNode(message,author,grouped);
        row.node.className=content.className;row.node.replaceChildren(...content.childNodes);
        row={message,author,grouped,titleSignature:'',node:row.node};
      }
      else if(row.message!==message)row={...row,message};
      if(row.author.name!==author.name || row.author.color!==author.color || row.author.avatar!==author.avatar){updateAuthor(row.node,author);row={...row,author};}
      if(row.titleSignature!==titleSignature){updateTitles(row.node,titles);row={...row,titleSignature};}
      media?.update(message,row.node);
      extras.update(row.node,message);
      desired.push(row.node);nextRows.set(message.id,row);previous=message.system ? null : message;
    }
    const keep=new Set(desired);
    for(const id of rows.keys())if(!nextRows.has(id))media?.remove(id);
    for(const child of [...container.children])if(!keep.has(/** @type {HTMLElement} */(child)))child.remove();
    let cursor=container.firstChild;
    for(const node of desired){if(node===cursor)cursor=cursor.nextSibling;else container.insertBefore(node,cursor);}
    rows=nextRows;dividers=nextDividers;
    if(nearBottom)container.scrollTop=container.scrollHeight;
    else if(anchor?.isConnected)container.scrollTop+=anchor.getBoundingClientRect().top-anchorTop;
    else container.scrollTop=oldScroll;
  }
  /** @param {ChatMediaAdapter} adapter @returns {void} */
  function setMedia(adapter){media?.destroy();media=createChatMediaView(container,adapter);for(const row of rows.values()){media.update(row.message,row.node);extras.update(row.node,row.message);}}
  /** @param {import('./chat-extras.js').ChatActions} actions @returns {void} */
  function setActions(actions){extras.setActions(actions);for(const row of rows.values())extras.update(row.node,row.message);}
  /** @returns {void} */
  function destroy(){extras.destroy();media?.destroy();media=null;rows.clear();dividers.clear();intro=null;empty=null;introSignature='';channelId=null;container.replaceChildren();}
  return {render,setMedia,setActions,clearMedia:()=>media?.clear(),destroy};
}
