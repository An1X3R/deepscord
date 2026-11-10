// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import codec from '../lib/avif-codec.cjs';
import {parseGovernance,governanceState} from '../lib/server-governance.cjs';
import {mediaObject,parseServerEmoji} from '../public/js/chat-protocol.js';
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('./chat-media-ui.mjs').Ui & {on:(method:string,callback:(value:JsonValue)=>void)=>()=>void}} Ui */
/** @typedef {{roomId:string,creatorKey:string,emoji:import('../public/js/chat-protocol.js').ServerEmoji,journalDigest:string,file:string,sha256:string,imageMessageId:string,stickerMessageId:string,statuses:JsonValue[]}} SteamMediaEvidence */

/** @param {string} workspaceFile */
function savedGovernance(workspaceFile){
  /** @type {JsonValue} */const input=JSON.parse(fs.readFileSync(workspaceFile,'utf8'));
  const workspace=mediaObject(input,'Actual Steam workspace');assert(Array.isArray(workspace.entries) && workspace.entries.length===1);
  const entry=mediaObject(workspace.entries[0],'Saved Steam room');assert(typeof entry.roomId==='string' && typeof entry.creatorKey==='string' && entry.governance);
  const journal=parseGovernance(entry.governance,{version:1,roomId:entry.roomId,creatorKey:entry.creatorKey});
  return{roomId:entry.roomId,creatorKey:entry.creatorKey,journal,policy:governanceState(journal)};
}

/** @param {Ui} ui @param {string} id @param {string} file @returns {Promise<void>} */
async function upload(ui,id,file){
  const document=mediaObject(await ui.send('DOM.getDocument',{}),'CDP document'),root=mediaObject(document.root,'CDP root');
  const found=mediaObject(await ui.send('DOM.querySelector',{nodeId:root.nodeId ?? null,selector:'#'+id}),'CDP file input');
  assert(typeof found.nodeId==='number' && found.nodeId>0,'Missing actual file input '+id);await ui.send('DOM.setFileInputFiles',{nodeId:found.nodeId,files:[file]});
}

/** @param {Ui} ui @param {string} file @returns {Promise<void>} */
async function verifyBackupLayout(ui,file){
  await ui.waitFor("document.querySelectorAll('[data-testid=message-backup-status]').length===2 && [...document.querySelectorAll('[data-testid=message-backup-status]')].every(status=>{const row=status.closest('[data-msg-id]'),image=document.getElementById('chatAttachment-'+row.dataset.msgId)?.querySelector('img');return image?.complete && image.naturalWidth===64})",{timeout:15000,interval:50,label:'actual backup attachment images decode before measuring layout'});
  const value=await ui.eval("[...document.querySelectorAll('[data-testid=message-backup-status]')].map(status=>{const row=status.closest('[data-msg-id]'),attachment=document.getElementById('chatAttachment-'+row.dataset.msgId),image=attachment.querySelector('img'),picture=attachment.getBoundingClientRect(),caption=status.getBoundingClientRect();return{messageId:row.dataset.msgId,outsideImage:!attachment.contains(status),pictureWidth:picture.width,pictureHeight:picture.height,captionTop:caption.top,pictureBottom:picture.bottom,captionHeight:caption.height,lineHeight:parseFloat(getComputedStyle(status).lineHeight),captionWidth:caption.width,imageComplete:image.complete,naturalWidth:image.naturalWidth,role:status.getAttribute('role')}})");
  assert(Array.isArray(value) && value.length===2);for(const input of value){const row=mediaObject(input,'Actual Steam backup layout');assert.equal(row.outsideImage,true);assert.equal(row.pictureWidth,64);assert.equal(row.pictureHeight,64);assert.equal(row.imageComplete,true);assert.equal(row.naturalWidth,64);assert.equal(row.role,'status');assert(typeof row.captionTop==='number' && typeof row.pictureBottom==='number' && row.captionTop>=row.pictureBottom);assert(typeof row.captionHeight==='number' && typeof row.lineHeight==='number' && row.captionHeight<=row.lineHeight+1);assert(typeof row.captionWidth==='number' && row.captionWidth>64);}
  fs.writeFileSync(file,JSON.stringify(value,null,2));
}

/** @param {Ui} ui @param {string} directory @param {string} userData @returns {Promise<SteamMediaEvidence>} */
export async function createSteamMedia(ui,directory,userData){
  await ui.waitFor('!!window.echo.getState().selfKey && window.echo.getState().ownerKey===window.echo.getState().selfKey',{timeout:15000,interval:50,label:'actual Steam creator signed governance proof'});
  const rgba=new Uint8Array(64*64*4);for(let y=0;y<64;y++)for(let x=0;x<64;x++){const offset=(y*64+x)*4;rgba[offset]=135;rgba[offset+1]=216;rgba[offset+2]=206;rgba[offset+3]=x<12 || y<12 || x>51 || y>51 ? 0 : 255;}
  const bytes=await codec.encode({width:64,height:64,timescale:1000,repetitionCount:0,frames:[{rgba,durationTicks:100}]},{quality:90,speed:10},codec.limitsForKind('server'),new AbortController().signal);
  const decoded=await codec.decode(bytes,codec.limitsForKind('server'),new AbortController().signal);assert.equal(decoded.frames[0].rgba[3],0);assert.equal(decoded.frames[0].rgba[(32*64+32)*4+3],255);
  const fixture=path.join(directory,'transparent-steam-media.avif');fs.writeFileSync(fixture,bytes);const sha256=createHash('sha256').update(bytes).digest('hex');
  /** @type {JsonValue[]} */const statuses=[];
  await ui.send('Network.enable',{});
  const stop=ui.on('Network.webSocketFrameReceived',input=>{
    const event=mediaObject(input,'Actual WebSocket event'),response=mediaObject(event.response,'Actual WebSocket response');if(typeof response.payloadData!=='string')return;
    /** @type {JsonValue} */const payload=JSON.parse(response.payloadData);if(payload && typeof payload==='object' && !Array.isArray(payload) && payload.t==='mediaStatus')statuses.push(payload);
  });
  try{
    await upload(ui,'chatImageFileInput',fixture);await ui.waitFor("!document.getElementById('mediaComposerPreview').hidden && !document.getElementById('mediaSendBtn').disabled",{timeout:30000,interval:50,label:'actual transparent AVIF staged in Steam room'});
    await ui.screenshot(path.join(directory,'steam-image-staged.png'));await ui.eval("document.getElementById('mediaSendBtn').click()");
    await ui.waitFor("document.getElementById('mediaComposerPreview').hidden && !!document.querySelector('[data-testid=message-backup-status][data-status=waiting]')",{timeout:30000,interval:50,label:'Steam one-member image durable backup waiting'});
    const imageMessageId=await ui.eval("[...document.querySelectorAll('#messages [data-msg-id]')].at(-1).dataset.msgId");assert(typeof imageMessageId==='string');
    assert.match(String(await ui.eval('document.getElementById('+JSON.stringify('chatBackup-'+imageMessageId)+').textContent')),/1 份/);
    await ui.eval("document.getElementById('emojiPanelBtn').click();document.getElementById('stickerPanelTabserver').click()");await upload(ui,'stickerPanelImportInput',fixture);
    await ui.waitFor("document.querySelectorAll('#stickerPanelGrid [data-sticker-id]').length===1 && !document.getElementById('stickerPanel').hasAttribute('aria-busy')",{timeout:30000,interval:50,label:'Steam shared emoji signed catalog import'});
    const saved=savedGovernance(path.join(userData,'workspace.json'));assert(saved.policy.emojis);assert.equal(saved.policy.emojis.length,1);const emoji=parseServerEmoji(saved.policy.emojis[0]);assert.equal(emoji.asset.sha256,sha256);
    await ui.screenshot(path.join(directory,'steam-server-sticker-catalog.png'));await ui.eval('document.getElementById('+JSON.stringify('stickerPanelItem-server-'+emoji.id)+').click()');
    await ui.waitFor("!document.getElementById('stickerPanel').hasAttribute('aria-busy') && document.querySelectorAll('[data-testid=message-backup-status][data-status=waiting]').length===2",{timeout:15000,interval:50,label:'Steam shared sticker accepted with one durable copy'});
    await ui.eval("document.getElementById('stickerPanelCloseBtn').click()");const stickerMessageId=await ui.eval("[...document.querySelectorAll('#messages [data-msg-id]')].at(-1).dataset.msgId");assert(typeof stickerMessageId==='string');
    assert(statuses.some(input=>{const status=mediaObject(input,'Real media status');return Array.isArray(status.items) && status.items.some(value=>{const item=mediaObject(value,'Real asset replica');return item.sha256===sha256 && item.status==='waiting' && item.copies===1;});}),'A real room socket must deliver waiting/copies=1');
    const roomDirectory=path.join(userData,'chat-media',saved.roomId),file=path.join(roomDirectory,'objects',sha256+'.avif');assert(fs.readdirSync(path.join(roomDirectory,'objects')).length>=1);assert.deepEqual(fs.readFileSync(file),Buffer.from(bytes));
    await verifyBackupLayout(ui,path.join(directory,'steam-backup-layout-initial.json'));await ui.screenshot(path.join(directory,'steam-media-waiting-one-copy.png'));return{roomId:saved.roomId,creatorKey:saved.creatorKey,emoji,journalDigest:saved.journal.digest,file,sha256,imageMessageId,stickerMessageId,statuses};
  }finally{stop();}
}

/** @param {Ui} ui @param {string} directory @param {string} userData @param {SteamMediaEvidence} evidence @returns {Promise<void>} */
export async function verifyReopenedSteamMedia(ui,directory,userData,evidence){
  await ui.waitFor('!!window.echo.getState().selfKey',{timeout:15000,interval:50,label:'reopened Steam signed identity'});
  const saved=savedGovernance(path.join(userData,'workspace.json'));assert.equal(saved.roomId,evidence.roomId);assert.equal(saved.creatorKey,evidence.creatorKey);assert.equal(saved.journal.digest,evidence.journalDigest);assert.deepEqual(saved.policy.emojis,[evidence.emoji]);
  assert.equal(createHash('sha256').update(fs.readFileSync(evidence.file)).digest('hex'),evidence.sha256);
  await ui.eval("window.echo.actions.selectChannel('ch-chat');document.getElementById('emojiPanelBtn').click();document.getElementById('stickerPanelTabserver').click()");
  await ui.waitFor('document.getElementById('+JSON.stringify('stickerPanelItem-server-'+evidence.emoji.id)+')?.querySelector("img")?.getAttribute("src")',{timeout:30000,interval:50,label:'reopened signed server emoji loads its actual AVIF'});
  await ui.screenshot(path.join(directory,'steam-reopened-signed-catalog.png'));await ui.eval('document.getElementById('+JSON.stringify('stickerPanelItem-server-'+evidence.emoji.id)+').click()');
  await ui.waitFor("!document.getElementById('stickerPanel').hasAttribute('aria-busy') && !!document.querySelector('[data-testid=message-backup-status][data-status=waiting]')",{timeout:15000,interval:50,label:'reopened durable catalog sticker sends through actual room socket'});
  const exported=path.join(directory,'reopened-durable-media.avif');fs.copyFileSync(evidence.file,exported);
  await ui.eval("document.getElementById('stickerPanelCloseBtn').click()");await upload(ui,'chatImageFileInput',exported);
  await ui.waitFor("!document.getElementById('mediaComposerPreview').hidden && !document.getElementById('mediaSendBtn').disabled",{timeout:30000,interval:50,label:'reopened durable AVIF actual image read'});await ui.eval("document.getElementById('mediaSendBtn').click()");
  await ui.waitFor("document.getElementById('mediaComposerPreview').hidden && document.querySelectorAll('[data-testid=chat-attachment] img').length===2 && [...document.querySelectorAll('[data-testid=chat-attachment] img')].every(image=>image.complete && image.naturalWidth===64)",{timeout:30000,interval:50,label:'reopened durable AVIF image accepted and decoded'});
  assert.equal(await ui.eval("window.echo.getState().users.length"),1);await ui.waitFor("document.querySelectorAll('[data-testid=message-backup-status][data-status=waiting]').length===2",{timeout:15000,interval:50,label:'reopened single-member durable backup remains waiting'});
  await verifyBackupLayout(ui,path.join(directory,'steam-backup-layout-reopened.json'));await ui.screenshot(path.join(directory,'steam-reopened-media.png'));
}
