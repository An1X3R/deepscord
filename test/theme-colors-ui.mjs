// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {launchChrome,connectPage,closeChrome} from './cdp.mjs';
import {launch,stop,reservePort,identity,connect,authenticate,send,receive,object,structure} from './server-ws-helpers.mjs';
/** @typedef {Awaited<ReturnType<typeof connectPage>>} Page */
const output=fs.mkdtempSync(path.join(process.cwd(),'.qa-tools/theme-colors-'));
const backend=await launch(path.join(output,'server'),{});
const debug=await reservePort();
/** @type {Page|null} */let page=null;
/** @type {Awaited<ReturnType<typeof launchChrome>>|null} */let browser=null;
/** @type {{theme:string,width:number,state:string,colors:Record<string,string>}[]} */const observations=[];
/** @param {Page} target @param {string} expression @param {string} label @returns {Promise<void>} */
async function wait(target,expression,label){await target.waitFor(expression,{timeout:12000,interval:50,label});}
/** @param {Page} target @param {string} id @returns {Promise<void>} */
async function click(target,id){await target.eval(`(()=>{const node=document.getElementById(${JSON.stringify(id)});if(!(node instanceof HTMLElement))throw new Error('Missing stable control: '+${JSON.stringify(id)});node.click();})()`,{awaitPromise:true,userGesture:true});}
/** @param {Page} target @param {string} theme @returns {Promise<void>} */
async function theme(target,theme){await target.eval(`(async()=>{const m=await import('./js/interface-profile.js');m.applyInterfaceProfile(m.INTERFACE_PRESETS[${JSON.stringify(theme)}]);})()`);}
/** @param {Page} target @param {string} name @param {string} preset @param {number} width @param {string[]} selectors @returns {Promise<void>} */
async function capture(target,name,preset,width,selectors){
  await target.eval("Promise.all(document.getAnimations().filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished.catch(error=>{if(error.name!=='AbortError')throw error;})))");
  const colors=await target.eval(`(()=>{const selectors=${JSON.stringify(selectors)},result={};for(const selector of selectors){const node=document.querySelector(selector);if(!(node instanceof HTMLElement))throw new Error('Missing rendered surface: '+selector);const s=getComputedStyle(node);if(s.display==='none'||s.visibility==='hidden')throw new Error('Hidden surface: '+selector);result[selector]=s.color+' / '+s.backgroundColor+' / '+s.borderColor;}return result;})()`);
  assert(colors&&typeof colors==='object'&&!Array.isArray(colors));
  await target.eval("(()=>{const avatars=[...document.querySelectorAll('.msg-avatar[style]')];for(const avatar of avatars){const expected=avatar.style.getPropertyValue('--av-color');if(expected && getComputedStyle(avatar).backgroundColor==='rgba(181, 50, 42, 0.078)')throw new Error('Theme replaced an identity avatar color');}})()");
  if(preset==='constructivist')for(const [selector,value] of Object.entries(colors)){assert.equal(typeof value,'string');assert(!/rgb\((18, 21, 29|21, 25, 27|135, 216, 206|242, 164, 175)\)/.test(String(value)),`${name} ${selector}: default palette leaked: ${value}`);}
  observations.push({theme:preset,width,state:name,colors});
  await target.screenshot(path.join(output,`${preset}-${width}-${name}.png`));
}
try{
  const owner=await connect(backend,'Theme owner'),actor=identity();await authenticate(owner,actor);
  const cursor=send(owner,{t:'claimOwner',token:fs.readFileSync(path.join(output,'server/owner-claim.txt'),'utf8').trim()});
  await receive(owner,cursor,message=>message.t==='serverState'&&object(message.policy).ownerKey===actor.key,'theme test owner');
  const servers=await structure(owner,{t:'createChannel',serverId:'srv-main',type:'radio',name:'Theme radio',radio:{stations:[{id:'audit-station',name:'Audit station',url:backend.origin+'/station.aac'}],stationId:'audit-station'}});
  const radio=servers.find(server=>server.id==='srv-main')?.channels.find(channel=>channel.name==='Theme radio');assert(radio);
  browser=await launchChrome({port:debug,userDataDir:path.join(output,'chrome'),url:backend.origin+'/?name=ThemeAudit',headless:true,windowSize:'1440,1000'});
  page=await connectPage(debug,backend.origin);await wait(page,'window.echo?.getState().roomReady && !!document.getElementById("interfaceChannelIndex")','real app connected');
  const documentNode=await page.send('DOM.getDocument');
  const fileNode=await page.send('DOM.querySelector',{nodeId:documentNode.root.nodeId,selector:'#chatImageFileInput'});
  await page.send('DOM.setFileInputFiles',{nodeId:fileNode.nodeId,files:[path.join(process.cwd(),'test/fixtures/avatar-96.jpg')]});
  await wait(page,"!document.getElementById('mediaComposerPreview').hidden && !document.getElementById('mediaSendBtn').disabled",'real encoded image preview');
  await click(page,'mediaSendBtn');
  await wait(page,"document.getElementById('mediaComposerPreview').hidden && !!document.querySelector('[data-testid=chat-attachment]')",'server accepted actual image');
  const attachmentId=await page.eval("document.querySelector('[data-testid=chat-attachment]').id");assert.equal(typeof attachmentId,'string');
  for(const preset of ['industrial','constructivist'])for(const width of [1440,390]){
    await page.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await theme(page,preset);
    assert.equal(await page.eval('document.documentElement.scrollWidth===innerWidth'),true,'Viewport overflow');
    await capture(page,'chat',preset,width,['.main','.composer']);
    await click(page,'railSettingsBtn');await wait(page,'!!document.getElementById("audioSettingsDone")','real settings');
    await capture(page,'settings',preset,width,['.modal','#profileName','.seg.active']);
    await click(page,'audioSettingsDone');await wait(page,'!document.querySelector(".modal")','settings closed');
    await theme(page,preset);await click(page,'interfaceChannelIndex');
    await click(page,'serverMenuBtn');await capture(page,'menu',preset,width,['.context-menu','#themeCustomizationMenuBtn']);
    await click(page,'themeCustomizationMenuBtn');await wait(page,'!!document.getElementById("customizationSchemePickerTrigger") || !!document.getElementById("customizationThemeSave")','local theme panel');
    await theme(page,preset);await capture(page,'customization',preset,width,['.modal','.scheme-picker-trigger']);
    await click(page,'customizationClose');await wait(page,'!document.querySelector(".modal")','customization closed');await theme(page,preset);
    await click(page,'emojiPanelBtn');await click(page,'stickerPanelTabunicode');await capture(page,'stickers',preset,width,['#stickerPanel','.sticker-cell','.sticker-panel-tabs','.sticker-tab.active']);
    await click(page,'stickerPanelCloseBtn');
    await page.eval(`document.querySelector('[data-channel-id="${radio.id}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:200}))`);
    await click(page,'radioChannelMenuBtn');await wait(page,'!!document.getElementById("radioPanel")','real radio list');await capture(page,'radio',preset,width,['.modal','#radioStationSelect','#radioCloseBtn']);
    await click(page,'radioCloseBtn');await wait(page,'!document.querySelector(".modal")','radio closed');
    await click(page,attachmentId);await wait(page,"document.getElementById('chatMediaPreview').open && !!document.querySelector('#chatMediaPreview img:not([hidden])')",'real decoded media overlay');
    await capture(page,'media-overlay',preset,width,['#chatMediaPreview','#chatMediaPreviewCloseBtn']);await click(page,'chatMediaPreviewCloseBtn');
  }
  fs.writeFileSync(path.join(output,'colors.json'),JSON.stringify(observations,null,2));
  console.log(JSON.stringify({event:'theme-colors-passed',output,states:observations.length}));
}finally{
  if(page)page.close();if(browser){await closeChrome(debug);if(browser.child.exitCode===null)browser.child.kill();}await stop(backend);
}
