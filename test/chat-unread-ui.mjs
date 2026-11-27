// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {launchChrome,connectPage,closeChrome} from './cdp.mjs';
import {launch,stop,reservePort,object,string} from './server-ws-helpers.mjs';
import {parseInterfaceScheme,parseSchemeValues} from '../public/js/interface-scheme.js';

/** @typedef {Awaited<ReturnType<typeof connectPage>>} Page */
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{id:string,channels:{id:string,type:'text'|'voice'|'radio'}[]}} Domain */
const root=process.cwd(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-unread-ui-'));
const output=path.join(root,'output/playwright/chat-unread');fs.mkdirSync(output,{recursive:true});
const backend=await launch(path.join(directory,'server'),{});
/** @type {{port:number,child:import('node:child_process').ChildProcess,page:Page}[]} */const clients=[];
/** @type {string[]} */const errors=[];
/** @type {string[]} */const checks=[];

/** @param {string} name @returns {Promise<Page>} */
async function open(name){
  const port=await reservePort(),url=backend.origin+'/?name='+name;
  const {child}=await launchChrome({port,userDataDir:path.join(directory,name),url,headless:true});
  const page=await connectPage(port,url);clients.push({port,child,page});
  page.on('Runtime.exceptionThrown',(/** @type {{exceptionDetails:JsonValue}} */event)=>errors.push(JSON.stringify(event.exceptionDetails)));
  await page.send('Runtime.enable');await page.send('Network.enable');
  await ready(page,name);return page;
}
/** @param {Page} page @param {string} label @returns {Promise<void>} */
async function ready(page,label){await page.waitFor('window.echo?.getState().roomReady && !!window.echo.getState().selfKey && !!window.echo.getState().chatMedia && !!localStorage.getItem("deepscord.chat-unread.v1")',{timeout:15000,interval:50,label});}
/** @param {Page} page @param {string} channelId @returns {Promise<void>} */
async function select(page,channelId){await page.eval('window.echo.actions.selectChannel('+JSON.stringify(channelId)+')');}
/** @param {Page} page @param {string} text @returns {Promise<string>} */
async function post(page,text){
  await page.eval('window.echo.actions.sendMessage('+JSON.stringify(text)+')');
  await page.waitFor('document.getElementById("msgInput").value==="" && !document.getElementById("sendBtn").disabled',{timeout:10000,interval:25,label:'real chat send acknowledged'});
  const id=await page.eval('document.querySelector("#messages [data-msg-id]:last-child").dataset.msgId');assert.equal(typeof id,'string');return id;
}
/** @param {string} channelId @returns {string} */
function channelSelector(channelId){return '[data-channel-id="'+channelId+'"]';}
/** @param {Page} page @param {string} channelId @param {{unread:boolean,mentions:number,muted:boolean}} expected @returns {Promise<void>} */
async function status(page,channelId,expected){
  const selector=JSON.stringify(channelSelector(channelId));
  await page.waitFor(`(()=>{const channel=document.querySelector(${selector});return !!channel && channel.classList.contains('has-unread')===${expected.unread} && channel.classList.contains('is-muted')===${expected.muted} && (channel.querySelector('.chat-mention-count')?.textContent ?? '')===${JSON.stringify(expected.mentions?'@'+expected.mentions:'')};})()`,{timeout:7000,interval:25,label:'channel unread state '+JSON.stringify(expected)});
}
/** @param {Page} page @param {string} channelId @param {'channelMarkReadMenuBtn'|'channelMuteMenuBtn'} item @returns {Promise<void>} */
async function menu(page,channelId,item){
  await page.eval('document.getElementById('+JSON.stringify('channel-settings-'+channelId)+').click();document.getElementById('+JSON.stringify(item)+').click()');
}
/** @param {string} name @returns {import('../public/js/interface-scheme.js').InterfaceSelection} */
function theme(name){
  const filename=path.join(root,'public/customization/interfaces',name+'.json');
  if(!name.endsWith('-open')){const scheme=parseInterfaceScheme(JSON.parse(fs.readFileSync(filename,'utf8')));return {scheme,values:parseSchemeValues(scheme,{})};}
  const row=object(JSON.parse(fs.readFileSync(filename,'utf8'))),files=object(row.files);
  /** @param {string} key @returns {string} */function read(key){const target=path.resolve(path.dirname(filename),string(files[key]));assert(target.startsWith(path.dirname(filename)+path.sep));return fs.readFileSync(target,'utf8');}
  const {files:references,...metadata}=row;assert(references);
  const scheme=parseInterfaceScheme({...metadata,presentation:{html:read('html'),css:read('css'),script:read('script')}});
  return {scheme,values:parseSchemeValues(scheme,{})};
}
try{
  const sender=await open('UnreadSender'),reader=await open('UnreadReader');
  /** @type {Domain[]} */const domains=await reader.eval('window.echo.getState().servers');
  const first=domains.find(domain=>domain.channels.some(channel=>channel.type==='text'));
  assert(first,'Real default room must contain a text domain');
  const second=domains.find(domain=>domain.id!==first.id && domain.channels.some(channel=>channel.type==='text'));
  assert(second,'Real default room must contain two text domains');
  const homeChannel=first.channels.find(channel=>channel.type==='text'),targetChannel=second.channels.find(channel=>channel.type==='text'),idleChannel=second.channels.find(channel=>channel.type!=='text');
  assert(homeChannel && targetChannel && idleChannel,'Real default room must contain both text channels and an inactive voice channel');
  const home=homeChannel.id,target=targetChannel.id;
  /** @type {string} */const memberKey=await reader.eval('window.echo.getState().selfKey');assert.match(memberKey,/^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/);
  await select(reader,home);await select(sender,target);
  const source=await post(sender,'Unread ordinary message');
  await select(reader,target);await status(reader,target,{unread:false,mentions:0,muted:false});
  await select(reader,home);
  await post(sender,'Inactive domain message');
  await reader.waitFor('document.querySelector('+JSON.stringify('[data-server-id="'+second.id+'"]')+')!==null',{timeout:3000,interval:25,label:'domain rail available'});
  await select(reader,target);await status(reader,target,{unread:false,mentions:0,muted:false});
  await select(reader,home);
  await post(sender,'<@'+memberKey+'> stable identity mention');
  await select(reader,home);
  await reader.waitFor('document.querySelector('+JSON.stringify('[data-server-id="'+second.id+'"] .chat-mention-count')+')?.textContent==="@1"',{timeout:7000,interval:25,label:'inactive domain mention rail'});
  checks.push('inactive-domain-live-mention-uses-persistent-member-key-and-rail-badge');
  await select(reader,target);await status(reader,target,{unread:false,mentions:0,muted:false});
  await select(reader,home);
  await post(sender,'Unmuted ordinary unread');
  await select(reader,idleChannel.id);
  await status(reader,target,{unread:true,mentions:0,muted:false});
  checks.push('inactive-text-channel-shows-ordinary-unread-dot');
  await reader.screenshot(path.join(output,'ordinary-unread.png'));
  await menu(reader,target,'channelMuteMenuBtn');
  await status(reader,target,{unread:false,mentions:0,muted:true});
  await post(sender,'Muted ordinary message');
  await post(sender,'<@'+memberKey+'> muted mention remains visible');
  await status(reader,target,{unread:false,mentions:1,muted:true});
  checks.push('muting-hides-ordinary-dot-and-keeps-mention-badge');
  for(const name of ['industrial','constructivist','industrial-open','constructivist-open']){
    await reader.eval('(async()=>{const runtime=await import("/js/interface-scheme-runtime.js");runtime.applyInterfaceSelection('+JSON.stringify(theme(name))+');await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()');
    if(name==='constructivist')await reader.eval('document.getElementById("interfaceChannelIndex").click();Promise.all(document.getAnimations().map(animation=>animation.finished))');
    await status(reader,target,{unread:false,mentions:1,muted:true});
    const badge=await reader.eval(`(()=>{const node=document.querySelector(${JSON.stringify(channelSelector(target)+' .chat-mention-count')});const style=getComputedStyle(node),box=node.getBoundingClientRect();return {width:box.width,height:box.height,color:style.color,background:style.backgroundColor};})()`);
    assert(badge.width>8 && badge.height>8,name+' mention badge remains visible');assert.notEqual(badge.color,badge.background);
    await reader.screenshot(path.join(output,name+'.png'));
  }
  checks.push('four-bundled-interface-options-retain-readable-unread-badges');
  await reader.eval('(async()=>{const runtime=await import("/js/interface-scheme-runtime.js");runtime.applyInterfaceSelection('+JSON.stringify(theme('industrial'))+');})()');
  await menu(reader,target,'channelMarkReadMenuBtn');await status(reader,target,{unread:false,mentions:0,muted:true});
  await menu(reader,target,'channelMuteMenuBtn');await status(reader,target,{unread:false,mentions:0,muted:false});
  checks.push('manual-mark-read-clears-inactive-channel-and-domain-mention');
  await post(sender,'<@'+memberKey+'> reload pending');await status(reader,target,{unread:true,mentions:1,muted:false});
  await reader.eval('window.unreadBeforeReload=true');await reader.send('Page.reload',{ignoreCache:true});
  await reader.waitFor('!window.unreadBeforeReload && document.readyState==="complete"',{timeout:10000,interval:25,label:'fresh reload context'});
  await ready(reader,'reloaded actual browser identity and unread state');
  assert.equal(await reader.eval('window.echo.getState().selfKey'),memberKey);
  await select(reader,idleChannel.id);await status(reader,target,{unread:true,mentions:1,muted:false});
  checks.push('inactive-channel-pending-mention-survives-reload-with-same-identity');
  await menu(reader,target,'channelMarkReadMenuBtn');await status(reader,target,{unread:false,mentions:0,muted:false});
  await reader.send('Network.enable');
  /** @type {(value:void)=>void} */let resolveReaction=()=>{throw new Error('Reaction acknowledgement listener is not initialized');};
  const reactionReceived=new Promise(/** @param {(value:void)=>void} resolve */resolve=>{resolveReaction=resolve;});
  const unsubscribe=reader.on('Network.webSocketFrameReceived',(/** @type {{response:{payloadData:string}}} */event)=>{const row=object(JSON.parse(event.response.payloadData));if(row.t==='messageReactions')resolveReaction();});
  await sender.eval('document.querySelector('+JSON.stringify('[data-msg-id="'+source+'"] [data-testid=message-react]')+').click()');
  await sender.waitFor('!!document.querySelector("#reactionPicker [data-testid=sticker-tab-emoji]")',{timeout:5000,interval:25,label:'real reaction picker ready'});
  await sender.eval('document.querySelector("#reactionPicker [data-testid=sticker-tab-emoji]").click()');
  await sender.waitFor('!!document.querySelector("#reactionPicker [data-testid=sticker-unicode]")',{timeout:5000,interval:25,label:'real unicode reaction choices'});
  await sender.eval('document.querySelector("#reactionPicker [data-testid=sticker-unicode]").click()');
  await sender.waitFor('document.querySelector('+JSON.stringify('[data-msg-id="'+source+'"] [data-testid=message-reaction]')+')!==null',{timeout:7000,interval:25,label:'real reaction accepted'});
  /** @type {ReturnType<typeof setTimeout>|null} */let reactionTimer=null;
  try{await Promise.race([reactionReceived,new Promise((resolve,reject)=>{reactionTimer=setTimeout(()=>reject(new Error('Second actual client did not receive the reaction update')),7000);})]);}
  finally{if(reactionTimer)clearTimeout(reactionTimer);unsubscribe();}
  await status(reader,target,{unread:false,mentions:0,muted:false});checks.push('reaction-update-does-not-recreate-unread');
  await post(sender,Array.from({length:45},(_,index)=>'Scroll checkpoint '+index+' — preserve unread while reading earlier messages.').join('\n'));
  await select(reader,target);await reader.send('Page.bringToFront');
  await reader.eval('document.getElementById("messages").scrollTop=document.getElementById("messages").scrollHeight');await status(reader,target,{unread:false,mentions:0,muted:false});
  assert.equal(await reader.eval('document.hasFocus() && !document.hidden'),true);
  await reader.eval('document.getElementById("messages").scrollTop=0');
  await reader.waitFor('document.getElementById("messages").scrollHeight-document.getElementById("messages").clientHeight>300',{timeout:3000,interval:25,label:'real overflowing chat history'});
  await post(sender,'<@'+memberKey+'> while reading earlier messages');await status(reader,target,{unread:true,mentions:1,muted:false});
  await reader.eval('document.getElementById("messages").scrollTop=document.getElementById("messages").scrollHeight');await status(reader,target,{unread:false,mentions:0,muted:false});
  checks.push('focused-channel-retains-unread-above-bottom-and-clears-after-scrolling-bottom');
  const background=await reader.send('Target.createTarget',{url:'about:blank'});
  await reader.send('Target.activateTarget',{targetId:background.targetId});
  await reader.waitFor('document.hidden || !document.hasFocus()',{timeout:5000,interval:25,label:'actual background browser tab'});
  await post(sender,'<@'+memberKey+'> background active-channel mention');await status(reader,target,{unread:true,mentions:1,muted:false});
  await reader.send('Page.bringToFront');await status(reader,target,{unread:false,mentions:0,muted:false});
  await reader.send('Target.closeTarget',{targetId:background.targetId});checks.push('background-tab-retains-unread-and-focus-at-bottom-clears-it');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks,output},null,2));
}catch(error){for(const [index,client] of clients.entries())await client.page.screenshot(path.join(output,'failure-'+index+'.png'));throw error;}
finally{for(const client of clients){await closeChrome(client.port);client.page.close();if(client.child.exitCode===null)client.child.kill();}await stop(backend);assert(path.dirname(directory)===os.tmpdir() && path.basename(directory).startsWith('deepscord-unread-ui-'));fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
