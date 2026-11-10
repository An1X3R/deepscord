// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import codec from '../lib/avif-codec.cjs';
import {mediaObject,parseServerEmoji} from '../public/js/chat-protocol.js';
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{eval:(expression:string)=>Promise<JsonValue>,send:(method:string,params:JsonValue)=>Promise<JsonValue>,waitFor:(expression:string,options:{timeout:number,interval:number,label:string})=>Promise<JsonValue>,screenshot:(filename:string)=>Promise<string>}} Ui */
/** @typedef {{ui:Ui,temporary:string,output:string,pass:(label:string)=>void,openPersonalPicker:()=>Promise<Ui & {close:()=>void}>,savedGovernance:()=>import('../lib/server-governance.cjs').GovernanceState}} TestOptions */
/** @param {Ui} ui @param {string} id @param {string[]} files @returns {Promise<void>} */
async function uploadFiles(ui,id,files){const document=mediaObject(await ui.send('DOM.getDocument',{}),'CDP document'),root=mediaObject(document.root,'CDP root'),found=mediaObject(await ui.send('DOM.querySelector',{nodeId:root.nodeId ?? null,selector:'#'+id}),'CDP file input');assert(typeof found.nodeId==='number' && found.nodeId>0,'Missing stable file input '+id);await ui.send('DOM.setFileInputFiles',{nodeId:found.nodeId,files});}
/** @param {TestOptions} options @returns {Promise<void>} */
export async function runChatMediaUi(options){
  const {ui,pass}=options;
  await ui.waitFor('!!window.echo.getState().selfKey && !!window.echo.getState().chatMedia',{timeout:10000,interval:50,label:'actual chat media and identity ready'});
  const pngData=await ui.eval("(()=>{const canvas=document.createElement('canvas');canvas.width=96;canvas.height=64;const ctx=canvas.getContext('2d');ctx.fillStyle='#87d8ce';ctx.fillRect(8,8,80,48);ctx.fillStyle='#f2556b';ctx.fillRect(28,20,40,24);return canvas.toDataURL('image/png')})()");assert(typeof pngData==='string' && pngData.startsWith('data:image/png;base64,'));
  const pngFile=path.join(options.temporary,'actual-composer-source.png'),animatedFile=path.join(options.temporary,'actual-sticker-animation.avif');fs.writeFileSync(pngFile,Buffer.from(pngData.slice('data:image/png;base64,'.length),'base64'));
  const frames=Array.from({length:3},(_,frame)=>{const rgba=new Uint8Array(64*64*4);for(let index=0;index<rgba.length;index+=4){rgba[index]=frame*80;rgba[index+1]=180;rgba[index+2]=240-frame*60;rgba[index+3]=index%20===0 ? 0 : 255;}return{rgba,durationTicks:100};});
  fs.writeFileSync(animatedFile,await codec.encode({width:64,height:64,timescale:1000,repetitionCount:0,frames},{quality:80,speed:10},codec.limitsForKind('personal'),new AbortController().signal));
  const channelId=await ui.eval('window.echo.getState().activeChannelId');assert(typeof channelId==='string');
  await ui.eval("document.getElementById('msgInput').value='草稿光标';document.getElementById('msgInput').setSelectionRange(2,2);document.getElementById('emojiPanelBtn').click();document.getElementById('stickerPanelTabunicode').click();document.getElementById('stickerPanelUnicode-128077').click()");
  assert.equal(await ui.eval("document.getElementById('msgInput').value"),'草稿👍光标');
  const initialCount=await ui.eval('window.echo.getState().messageCounts['+JSON.stringify(channelId)+'] || 0');assert(typeof initialCount==='number');
  await ui.eval("document.getElementById('stickerPanelTabpersonal').click();document.getElementById('stickerPanelNativePicker').click()");
  assert.equal(await ui.eval("document.querySelectorAll('#stickerPanelGrid [data-sticker-id]').length"),0,'Remote room must not receive the desktop library');
  const personalPicker=await options.openPersonalPicker();
  await personalPicker.waitFor("document.body.dataset.ready==='true' && !document.getElementById('import').disabled",{timeout:10000,interval:25,label:'trusted local picker ready'});
  await uploadFiles(personalPicker,'import',[pngFile,animatedFile]);
  try{await personalPicker.waitFor("document.querySelectorAll('#grid .cell').length===2 && !document.body.hasAttribute('aria-busy')",{timeout:30000,interval:50,label:'actual PNG and animated AVIF local import'});}catch(error){console.error('native_picker_import_diagnostic',await personalPicker.eval("JSON.stringify({ready:document.body.dataset.ready,busy:document.body.getAttribute('aria-busy'),status:document.getElementById('status')?.textContent,error:document.getElementById('error')?.textContent,cells:document.querySelectorAll('#grid .cell').length})"));await personalPicker.screenshot(path.join(options.output,'sticker-picker-import-failure.png'));throw error;}
  assert.equal(await personalPicker.eval("document.getElementById('status').textContent"),'');
  await personalPicker.eval("document.getElementById('columns').value='4';document.getElementById('columns').dispatchEvent(new Event('change'))");
  await personalPicker.waitFor("document.querySelectorAll('#grid .cell').length===2 && !document.body.hasAttribute('aria-busy') && document.getElementById('grid').style.getPropertyValue('--columns')==='4'",{timeout:10000,interval:50,label:'local persisted columns'});
  await personalPicker.eval("document.getElementById('sort').value='added';document.getElementById('sort').dispatchEvent(new Event('change'))");
  await personalPicker.waitFor("document.querySelectorAll('#grid .cell').length===2 && !document.body.hasAttribute('aria-busy')",{timeout:10000,interval:50,label:'local sort refresh'});
  const personalId=await personalPicker.eval("document.querySelector('#grid .cell>button').id.slice('choose-'.length)");assert(typeof personalId==='string');
  await personalPicker.eval('document.getElementById('+JSON.stringify('pin-'+personalId)+').click()');
  await personalPicker.waitFor('document.getElementById('+JSON.stringify('pin-'+personalId)+')?.textContent==="取消置顶" && document.querySelectorAll("#grid .cell").length===2',{timeout:10000,interval:50,label:'actual local personal pin'});
  await personalPicker.screenshot(path.join(options.output,'sticker-personal-import.png'));
  await personalPicker.eval('document.getElementById('+JSON.stringify('choose-'+personalId)+').click();document.getElementById("confirm").click()');personalPicker.close();
  await ui.waitFor('(window.echo.getState().messageCounts['+JSON.stringify(channelId)+'] || 0)==='+String(initialCount+1),{timeout:20000,interval:50,label:'real personal sticker upload and accepted chat'});
  await ui.waitFor("!document.getElementById('stickerPanel').hasAttribute('aria-busy')",{timeout:10000,interval:50,label:'sticker send completion'});
  assert.equal(await ui.eval("document.getElementById('msgInput').value"),'草稿👍光标');
  pass('Real personal PNG/animated AVIF import, persisted layout, right-click pin and immediate sticker send retain the text draft');
  await ui.eval("document.getElementById('stickerPanelCloseBtn').click();document.getElementById('msgInput').value='服务器确认后清空';document.getElementById('composer').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))");
  await ui.waitFor("document.getElementById('msgInput').value===''",{timeout:10000,interval:50,label:'text clears after actual chat acknowledgement'});
  assert.equal(await ui.eval('window.echo.getState().messageCounts['+JSON.stringify(channelId)+']'),initialCount+2,'Broadcast and acknowledgement must produce one message per send');
  pass('Acknowledged text sends clear the submitted draft and broadcast/ACK deduplicate by accepted message ID');
  await ui.eval("document.getElementById('emojiPanelBtn').click();document.getElementById('stickerPanelTabserver').click()");await uploadFiles(ui,'stickerPanelImportInput',[pngFile,animatedFile]);
  await ui.waitFor("document.querySelectorAll('#stickerPanelGrid [data-sticker-id]').length===2 && !document.getElementById('stickerPanel').hasAttribute('aria-busy')",{timeout:30000,interval:50,label:'serial signed server sticker import'});
  const emojis=(options.savedGovernance().emojis ?? []).map(parseServerEmoji);assert.equal(emojis.length,2);const animated=emojis.find(emoji=>emoji.asset.animated);assert(animated);
  await ui.screenshot(path.join(options.output,'sticker-server-domains.png'));
  await ui.eval('document.getElementById('+JSON.stringify('stickerPanelItem-server-'+animated.id)+').click()');await ui.waitFor('window.echo.getState().messageCounts['+JSON.stringify(channelId)+']==='+String(initialCount+3),{timeout:20000,interval:50,label:'accepted shared server sticker send'});
  await ui.waitFor("!document.getElementById('stickerPanel').hasAttribute('aria-busy')",{timeout:5000,interval:50,label:'shared sticker send settled'});await ui.eval("document.getElementById('stickerPanelCloseBtn').click()");
  const messageId=await ui.eval("[...document.querySelectorAll('#messages [data-msg-id]')].at(-1).dataset.msgId");assert(typeof messageId==='string');
  await ui.eval('document.getElementById('+JSON.stringify('chatReact-'+messageId)+').click()');assert.equal(await ui.eval("!!document.getElementById('reactionPickerTabpersonal')"),false);
  await ui.eval("document.getElementById('reactionPickerTabunicode').click();document.getElementById('reactionPickerUnicode-128077').click()");
  const unicodePill='chatReaction-'+messageId+'-u_3A_F0_9F_91_8D';
  await ui.waitFor('document.getElementById('+JSON.stringify(unicodePill)+')?.getAttribute("aria-pressed")==="true"',{timeout:10000,interval:50,label:'idempotent Unicode reaction add'});
  await ui.eval('document.getElementById('+JSON.stringify(unicodePill)+').click()');await ui.waitFor('!document.getElementById('+JSON.stringify(unicodePill)+')',{timeout:10000,interval:50,label:'explicit reaction active=false'});
  await ui.eval('document.getElementById('+JSON.stringify('chatReact-'+messageId)+').click();document.getElementById("reactionPickerTabserver").click();document.getElementById('+JSON.stringify('reactionPickerItem-server-'+animated.id)+').click()');
  const serverPill='chatReaction-'+messageId+'-e_3A'+animated.id;
  await ui.waitFor('document.getElementById('+JSON.stringify(serverPill)+')?.getAttribute("aria-pressed")==="true"',{timeout:10000,interval:50,label:'actual shared emoji reaction'});
  await ui.screenshot(path.join(options.output,'chat-sticker-reactions.png'));
  pass('Domain-grouped shared sticker import uses signed governance and real Unicode/server reaction ACKs set explicit active states');
  await ui.eval("document.getElementById('emojiPanelBtn').click();document.getElementById('stickerPanelTabserver').click()");
  await ui.eval('document.getElementById('+JSON.stringify('stickerPanelItem-server-'+animated.id)+').dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:460,clientY:420}));document.getElementById("stickerPanelsticker-delete-server").click()');
  await ui.waitFor("document.querySelectorAll('#stickerPanelGrid [data-sticker-id]').length===1 && !document.getElementById('stickerPanel').hasAttribute('aria-busy')",{timeout:15000,interval:50,label:'actual server sticker deletion'});
  assert(!options.savedGovernance().emojis?.some(emoji=>emoji.id===animated.id));assert.equal(await ui.eval('!!document.getElementById('+JSON.stringify(serverPill)+')'),true,'Existing reactions retain immutable media after catalog deletion');await ui.eval("document.getElementById('stickerPanelCloseBtn').click()");
  await ui.eval('document.getElementById('+JSON.stringify('chatAttachment-'+messageId)+').dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:460,clientY:420}))');
  assert.equal(await ui.eval("!!document.getElementById('favoriteMessageMenuBtn') && !!document.getElementById('deleteMessageMenuBtn')"),true);await ui.eval("document.getElementById('favoriteMessageMenuBtn').click()");
  const favoritePicker=await options.openPersonalPicker();await favoritePicker.waitFor("document.getElementById('preview')?.hidden===false && !document.getElementById('confirm').disabled",{timeout:10000,interval:50,label:'trusted favorite preview'});await favoritePicker.eval("document.getElementById('confirm').click()");favoritePicker.close();
  pass('Server catalog deletion preserves historical reactions and attachment context menus retain both favorite and moderation actions');
  await uploadFiles(ui,'chatImageFileInput',[pngFile]);await ui.waitFor("!document.getElementById('mediaComposerPreview').hidden && !document.getElementById('mediaSendBtn').disabled",{timeout:30000,interval:50,label:'actual image staging preview'});
  assert.equal(await ui.eval('window.echo.getState().messageCounts['+JSON.stringify(channelId)+']'),initialCount+3);await ui.screenshot(path.join(options.output,'image-composer-confirmation.png'));await ui.eval("document.getElementById('mediaSendBtn').click()");
  await ui.waitFor("document.getElementById('mediaComposerPreview').hidden && window.echo.getState().messageCounts["+JSON.stringify(channelId)+']==='+String(initialCount+4),{timeout:20000,interval:50,label:'explicit staged image confirmation and chat ACK'});
  const imageMessage=await ui.eval("[...document.querySelectorAll('#messages [data-msg-id]')].at(-1).dataset.msgId");assert(typeof imageMessage==='string');await ui.eval('document.getElementById('+JSON.stringify('chatAttachment-'+imageMessage)+').click()');
  await ui.waitFor("document.getElementById('chatMediaPreview').open && !!document.getElementById('chatMediaPreviewImage').getAttribute('src')",{timeout:10000,interval:50,label:'actual image same-page preview'});await ui.screenshot(path.join(options.output,'image-message-preview.png'));await ui.eval("document.getElementById('chatMediaPreviewCloseBtn').click()");
  await ui.waitFor('window.echo.getState().chatMedia.requests===0 && window.echo.getState().chatMedia.downloads===0 && window.echo.getState().chatMedia.codec.active===0 && window.echo.getState().chatMedia.queuedImages===0',{timeout:15000,interval:50,label:'media queues settle after accepted sends'});
  const stats=mediaObject(await ui.eval('window.echo.getState().chatMedia'),'Actual client media stats');assert(typeof stats.queuedImageBytes==='number' && stats.queuedImageBytes<=16*1024*1024);fs.writeFileSync(path.join(options.output,'chat-media-stats.json'),JSON.stringify(stats,null,2));
  assert.equal(await ui.eval("document.querySelectorAll('[data-testid=message-backup-status]').length"),0,'An ordinary server must not display invented Steam backup status');
  pass('A real image stays staged until explicit confirmation, commits once after ACK, and opens a lease-owned same-page preview');
}

/** @param {Ui} ui @param {(label:string)=>void} pass @returns {Promise<void>} */
export async function runBrowserIdentityUi(ui,pass){
  assert.equal(await ui.eval("typeof window.deepscord?.signServerIdentity"),'undefined','This page must use the actual browser identity implementation');
  await ui.waitFor("!!document.getElementById('welcomeNameInput')",{timeout:10000,interval:50,label:'ordinary browser welcome'});await ui.eval("document.getElementById('welcomeNameInput').value='浏览器持久身份';document.getElementById('welcomeEnterBtn').click()");
  await ui.waitFor('window.echo?.getState().roomReady && !!window.echo.getState().selfKey',{timeout:15000,interval:50,label:'actual browser Ed25519 server proof'});
  const key=await ui.eval('window.echo.getState().selfKey');assert(typeof key==='string' && Buffer.from(key,'base64').length===44);
  await ui.eval("document.getElementById('emojiPanelBtn').click();document.getElementById('stickerPanelTabserver').click()");assert.equal(await ui.eval("document.getElementById('stickerPanelImportBtn').disabled"),true,'An ordinary verified member cannot manage server stickers');await ui.eval("document.getElementById('stickerPanelCloseBtn').click()");
  await ui.eval('window.__identityReloadSentinel=true');await ui.send('Page.reload',{});await ui.waitFor("!window.__identityReloadSentinel && document.readyState==='complete'",{timeout:10000,interval:50,label:'browser reload completes with saved profile'});
  await ui.waitFor('window.echo?.getState().roomReady && !!window.echo.getState().selfKey',{timeout:15000,interval:50,label:'persisted browser signing key after reload'});assert.equal(await ui.eval('window.echo.getState().selfKey'),key);
  await ui.eval("window.echo.actions.sendMessage('浏览器身份真实确认消息')");await ui.waitFor("document.getElementById('msgInput').value==='' && document.getElementById('sendBtn').disabled===false",{timeout:10000,interval:50,label:'ordinary browser actual signed actor chat acknowledgement'});
  pass('A preload-free browser persists real Ed25519 identity across reload, receives chat ACKs, and keeps server import permission disabled');
}
