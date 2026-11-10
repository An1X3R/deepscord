// @ts-check
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {app,BrowserWindow}=require('electron');

/** @returns {Promise<void>} */
async function main(){
  const results=path.resolve(__dirname,'../.qa-tools/results');fs.mkdirSync(results,{recursive:true});
  const directory=fs.mkdtempSync(path.join(results,'sticker-layout-'));app.setPath('userData',directory);
  await app.whenReady();
  const window=new BrowserWindow({show:false,width:980,height:780,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  try{
    await window.loadFile(path.join(__dirname,'../public/index.html'));
    const source=pathToFileURL(path.join(__dirname,'../public/js/sticker-panel.js')).href;
    const bytes=fs.readFileSync(path.join(__dirname,'avif-codec-fixtures/transparent-animation.avif')).toString('base64');
    const measurements=await window.webContents.executeJavaScript(`(async()=>{
      const {createStickerPanel}=await import(${JSON.stringify(source)});
      document.body.replaceChildren();const anchor=document.createElement('button');anchor.id='layoutAnchor';document.body.append(anchor);
      const catalog={personal:[],server:Array.from({length:96},(_,index)=>({id:'emoji-'+index,kind:'server',name:'Sticker '+index,sha256:'a'.repeat(64),domainId:'domain',width:240,height:240,animated:false,frames:1,durationMs:0,bytes:100,addedAt:index,useCount:0,lastUsedAt:0,pinned:false})),domains:[{id:'domain',name:'Domain',canManage:false}],activeDomainId:'domain'};
      const noop=async()=>{};const panel=createStickerPanel({id:'layoutPicker',anchor,host:document.body,selection:{kind:'reaction',setReaction:noop},preferences:{columns:8,sort:'added'},getCatalog:()=>catalog,loadMedia:async()=>{const blob=new Blob([Uint8Array.from(atob(${JSON.stringify(bytes)}),c=>c.charCodeAt(0))],{type:'image/avif'}),url=URL.createObjectURL(blob);return {url,release:()=>URL.revokeObjectURL(url)};},importFiles:noop,favorite:noop,remove:noop,pin:noop,recordUse:noop,savePreferences:noop,reportError:error=>{throw error;}});panel.open();
      document.getElementById('layoutPickerSettingsBtn').click();const result=[];
      for(const width of [980,360]){document.getElementById('layoutPicker').style.width=Math.min(420,width-24)+'px';for(const columns of [4,5,6,8]){const select=document.getElementById('layoutPickerColumnsSelect');select.value=String(columns);select.dispatchEvent(new Event('change'));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const cells=[...document.querySelectorAll('#layoutPickerGrid .sticker-cell')],rects=cells.map(cell=>cell.getBoundingClientRect()),first=rects[0],second=rects[columns],grid=document.getElementById('layoutPickerGrid');result.push({width,columns,count:cells.length,cellWidth:first.width,cellHeight:first.height,rowStride:second.top-first.top,overlap:second.top<first.bottom-0.5,withinWidth:rects.every(rect=>rect.left>=grid.getBoundingClientRect().left&&rect.right<=grid.getBoundingClientRect().right),scrolls:grid.scrollHeight>grid.clientHeight});}}
      panel.destroy();return result;
    })()`);
    for(const item of measurements){assert.equal(item.count,96);assert.equal(item.overlap,false,JSON.stringify(item));assert.equal(item.withinWidth,true,JSON.stringify(item));assert.equal(item.scrolls,true);assert(Math.abs(item.cellHeight-item.cellWidth)<1,JSON.stringify(item));}
    console.log(JSON.stringify({event:'sticker_grid_layout_verified',measurements}));
    const chatSource=pathToFileURL(path.join(__dirname,'../public/js/chat-view.js')).href;
    const identityAndNumbers=await window.webContents.executeJavaScript(`(async()=>{
      const {createStickerPanel}=await import(${JSON.stringify(source)});
      const {createChatView}=await import(${JSON.stringify(chatSource)});
      const check=(condition,label)=>{if(!condition)throw new Error(label);};
      document.body.replaceChildren();const anchor=document.createElement('button');anchor.id='numericAnchor';document.body.append(anchor);
      const choices=['0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'],selected=[];
      const unused=async()=>{throw new Error('Unicode selection must not access sticker media');};
      const panel=createStickerPanel({id:'numericPicker',anchor,host:document.body,selection:{kind:'reaction',setReaction:async selection=>{check(selection.kind==='unicode','Expected Unicode selection');selected.push(selection.emoji);}},preferences:{columns:6,sort:'added'},getCatalog:()=>({personal:[],server:[],domains:[],activeDomainId:null}),loadMedia:unused,importFiles:unused,favorite:unused,remove:unused,pin:unused,recordUse:unused,savePreferences:unused,reportError:error=>{throw error;}});panel.open();
      document.getElementById('numericPickerTabunicode').click();
      for(const emoji of choices){const button=document.getElementById('numericPickerUnicode-'+emoji.codePointAt(0));check(button instanceof HTMLButtonElement,'Missing numeric emoji '+emoji);check(button.textContent===emoji,'Numeric emoji encoding mismatch');button.click();await Promise.resolve();await Promise.resolve();}
      check(JSON.stringify(selected)===JSON.stringify(choices),'Numeric picker callbacks did not preserve all emoji');panel.destroy();
      const container=document.createElement('main');container.id='identityMessages';document.body.append(container);
      const escape=text=>{const node=document.createElement('span');node.textContent=text;return node.innerHTML;};
      const view=createChatView(container,{escape,body:escape,time:()=>'',day:()=>'',color:()=>'#ffffff',avatar:()=>'',icon:()=>''});
      const messages=[{id:'author-a',userId:'recycled-session',authorId:'a',name:'Historical A',color:'#ffffff',text:'A',ts:1,system:false,bot:false},{id:'author-b',userId:'recycled-session',authorId:'b',name:'Historical B',color:'#ffffff',text:'B',ts:2,system:false,bot:false},{id:'author-b-rejoined',userId:'new-session',authorId:'b',name:'Historical B',color:'#ffffff',text:'B again',ts:3,system:false,bot:false},{id:'author-unresolved',userId:'recycled-session',authorId:'unresolved',name:'Archived author',color:'#ffffff',text:'Archive',ts:4,system:false,bot:false}];
      const authors=new Map([['a',{name:'Author A',color:'#ffffff',titles:['服主']}],['b',{name:'Author B',color:'#ffffff',titles:['域管理员','Architect <b>']}],['recycled-session',{name:'Wrong current user',color:'#ffffff',titles:['Wrong title']}]]);
      const render=()=>view.render({channel:{id:'identity-channel',name:'Identity',type:'text'},messages,authors});render();
      const row=id=>{const node=container.querySelector('[data-msg-id="'+id+'"]');check(node instanceof HTMLElement,'Missing stable message row '+id);return node;};
      check(row('author-a').querySelector('.msg-author-title')?.textContent==='服主','Owner title missing');
      check(row('author-b').querySelector('.msg-author')?.textContent==='Author B','Recycled session grouped distinct identities');
      check(row('author-b').querySelectorAll('.msg-author-title').length===2,'Custom group title missing');
      check(!row('author-b').querySelector('.msg-author-title b'),'Custom group title was interpreted as markup');
      check(!row('author-b-rejoined').querySelector('.msg-head'),'Reconnected stable author was not grouped');
      check(row('author-unresolved').querySelector('.msg-author')?.textContent==='Archived author','Unresolved historical author inherited current session name');
      check(!row('author-unresolved').querySelector('.msg-author-title'),'Unresolved historical author inherited current session titles');
      const retained=row('author-b');authors.set('b',{name:'Author B',color:'#ffffff',titles:['域主']});render();
      check(row('author-b')===retained,'Title refresh replaced message row');check(row('author-b').querySelector('.msg-author-title')?.textContent==='域主','Role change did not refresh title');
      authors.set('b',{name:'Author B',color:'#ffffff',titles:[]});render();check(!row('author-b').querySelector('.msg-author-title'),'Removed role left stale title');view.destroy();
      return {numericChoices:selected,stableIdentityGrouping:true,historicalNames:true,safeTitles:true,titleUpdates:true};
    })()`);
    console.log(JSON.stringify({event:'chat_titles_numeric_picker_verified',...identityAndNumbers}));
  }finally{window.destroy();console.log(JSON.stringify({event:'sticker_layout_profile_retained',directory}));}
}
main().then(()=>app.quit(),error=>{console.error(error);app.exit(1);});
