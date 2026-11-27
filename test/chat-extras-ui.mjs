// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {launchChrome,connectPage,closeChrome} from './cdp.mjs';
import {launch,stop,reservePort} from './server-ws-helpers.mjs';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-chat-extras-'));
const output=path.join(process.cwd(),'output/playwright/chat-extras');fs.mkdirSync(output,{recursive:true});
const backend=await launch(path.join(directory,'server'),{}),port=await reservePort(),url=backend.origin+'/?name=ExtrasReader';
/** @type {import('node:child_process').ChildProcess|null} */let browser=null;
/** @type {Awaited<ReturnType<typeof connectPage>>|null} */let page=null;
/** @type {string[]} */const externalRequests=[];
try{
  browser=(await launchChrome({port,userDataDir:path.join(directory,'chrome'),url,headless:true,extraArgs:['--disable-extensions']})).child;
  page=await connectPage(port,url);
  await page.waitFor('window.echo?.getState().roomReady && !!window.echo.getState().selfKey',{timeout:12000,interval:50,label:'real backend authenticated'});
  await page.send('Network.enable');
  page.on('Network.requestWillBeSent',event=>{const request=event.request;if(request && /^https?:/.test(request.url) && !request.url.startsWith(backend.origin))externalRequests.push(request.url);});
  await page.send('Browser.grantPermissions',{origin:backend.origin,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
  const code='const raw = "**literal** https://example.invalid";\n<@'+await page.eval('window.echo.getState().selfKey')+'>\n';
  const source='```js\n'+code+'```\nBV1xx411c7mD https://music.163.com/#/song?id=123456';
  const setup=await page.eval(`(async()=>{
    const {createChatView}=await import('/js/chat-view.js');
    const {parseChatMessage}=await import('/js/chat-protocol.js');
    const {localLinkCards}=await import('/js/chat-extras.js');
    const util=await import('/js/util.js');const {icon}=await import('/js/icons.js');
    const host=document.createElement('section');host.id='chatExtrasFixture';host.setAttribute('style','position:fixed;inset:20px;z-index:2000;padding:20px;background:var(--bg);overflow:auto');document.body.append(host);
    const view=createChatView(host,{escape:util.esc,body:util.renderText,time:util.fmtTime,day:util.fmtDay,color:util.colorFor,avatar:(author,size,className)=>'<span class="'+className+'">'+util.esc(util.initials(author.name))+'</span>',icon});
    const data=(id,text,ts)=>parseChatMessage({id,userId:'reader',name:'Source author',color:'#56cfc3',text,ts,system:false,bot:false});
    const original=data('original','Original message before reply',1000);
    const reply={...data('reply',${JSON.stringify(source)},2000),replyToId:'original'};
    const unavailable={...data('missing','Reply with unavailable source',3000),replyToId:'unavailable'};
    const identity=window.echo.getState().selfKey;
    const snapshot={channel:{id:'fixture',name:'聊天交互验证',type:'text'},messages:[original,reply,unavailable],authors:new Map([['reader',{name:'Live author',color:'#56cfc3'}]]),selfKey:identity,members:[{memberKey:identity,name:'ExtrasReader'}]};
    window.chatExtrasFixture={view,snapshot,replies:[],unavailable:0,errors:[]};
    view.setActions({onReply:message=>window.chatExtrasFixture.replies.push(message.id),onUnavailable:()=>window.chatExtrasFixture.unavailable++,reportError:error=>window.chatExtrasFixture.errors.push(error.message)});
    view.render(snapshot);
    return {code:host.querySelector('[data-msg-id="reply"] pre code').textContent,codeLinks:host.querySelectorAll('pre a,pre strong,pre br,pre .chat-mention').length,refs:host.querySelectorAll('[data-testid="message-reference"]').length,cards:host.querySelectorAll('.chat-link-card').length,canonical:localLinkCards('BV1xx411c7mD BV1xx411c7mD https://music.163.com/song?id=1 https://music.163.com/#/song?id=1'),inline:util.renderText(${JSON.stringify('**bold** `https://example.invalid **raw**`')})};
  })()`);
  assert.equal(setup.code,code);assert.equal(setup.codeLinks,0);assert.equal(setup.refs,2);assert.equal(setup.cards,2);assert.equal(setup.canonical.length,2);assert(setup.inline.includes('<strong>bold</strong>'));assert(setup.inline.includes('<code>https://example.invalid **raw**</code>'));
  await page.eval('document.querySelector("#chatExtrasFixture [data-msg-id=reply] [data-testid=message-reply]").click();document.querySelector("#chatExtrasFixture [data-msg-id=missing] [data-testid=message-reference]").click();document.querySelector("#chatExtrasFixture [data-msg-id=reply] [data-testid=code-copy]").click()');
  await page.waitFor('document.querySelector("#chatExtrasFixture [data-testid=code-copy]").textContent==="已复制 ✓"',{timeout:3000,interval:20,label:'real clipboard write'});
  assert.equal((await page.eval('navigator.clipboard.readText()')).replace(/\r\n/g,'\n'),code);
  assert.deepEqual(await page.eval('window.chatExtrasFixture.replies'),['reply']);assert.equal(await page.eval('window.chatExtrasFixture.unavailable'),1);
  const changed=await page.eval(`(()=>{const fixture=window.chatExtrasFixture;const old=document.querySelector('#chatExtrasFixture [data-msg-id=reply]');fixture.snapshot={...fixture.snapshot,messages:fixture.snapshot.messages.map(message=>message.id==='original'?{...message,text:'Updated source text'}:message)};fixture.view.render(fixture.snapshot);return {same:old===document.querySelector('#chatExtrasFixture [data-msg-id=reply]'),text:old.querySelector('[data-testid=message-reference]').textContent,copy:old.querySelectorAll('[data-testid=code-copy]').length,reply:old.querySelectorAll('[data-testid=message-reply]').length};})()`);
  assert(changed.same);assert(changed.text.includes('Updated source text'));assert.equal(changed.copy,1);assert.equal(changed.reply,1);
  const toolbar=await page.eval(`(()=>{const row=document.querySelector('#chatExtrasFixture [data-msg-id=reply]'),toolbar=document.createElement('div'),button=document.createElement('button');toolbar.className='chat-message-actions';button.dataset.testid='existing-toolbar-action';button.addEventListener('click',()=>button.dataset.clicked='true');toolbar.append(button);row.append(toolbar);window.chatExtrasFixture.view.render(window.chatExtrasFixture.snapshot);button.click();return {bars:row.querySelectorAll('.chat-message-actions').length,replies:row.querySelectorAll('[data-testid=message-reply]').length,clicked:button.dataset.clicked};})()`);
  assert.deepEqual(toolbar,{bars:1,replies:1,clicked:'true'});
  await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await page.eval('document.querySelector("#chatExtrasFixture [data-msg-id=reply] [data-testid=message-reference]").click()');
  assert.equal(await page.eval('document.querySelector("#chatExtrasFixture [data-msg-id=original]").getAnimations().length'),0);
  await page.screenshot(path.join(output,'chat-extras.png'));
  assert.deepEqual(externalRequests,[]);assert.deepEqual(await page.eval('window.chatExtrasFixture.errors'),[]);
  const removed=await page.eval('(()=>{const fixture=window.chatExtrasFixture;fixture.snapshot={...fixture.snapshot,messages:fixture.snapshot.messages.map(message=>message.id==="reply"?{...message,replyToId:undefined}:message)};fixture.view.render(fixture.snapshot);const references=document.querySelectorAll("#chatExtrasFixture [data-msg-id=reply] .chat-reference").length;fixture.view.destroy();return {references,children:document.getElementById("chatExtrasFixture").childElementCount};})()');
  assert.deepEqual(removed,{references:0,children:0});
  console.log('PASS real Chrome/backend: reply action, live quote preview, unavailable target, reduced motion, literal code clipboard, local cards without third-party requests and teardown');
}catch(error){if(page)await page.screenshot(path.join(output,'failure.png'));throw error;}
finally{await closeChrome(port);page?.close();if(browser?.exitCode===null)browser.kill();await stop(backend);assert.equal(path.dirname(directory),os.tmpdir());fs.rmSync(directory,{recursive:true,force:true});}
