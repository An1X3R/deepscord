// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {launchChrome,connectPage,closeChrome} from './cdp.mjs';
import {launch,stop,reservePort} from './server-ws-helpers.mjs';
import {createChatDropProxy} from './chat-drop-proxy.mjs';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-composer-'));
const output=path.join(process.cwd(),'output/playwright/chat-composer');fs.mkdirSync(output,{recursive:true});
const backend=await launch(path.join(directory,'server'),{});
const transport=await createChatDropProxy(backend.origin);
/** @type {{port:number,child:import('node:child_process').ChildProcess,page:Awaited<ReturnType<typeof connectPage>>}[]} */const clients=[];
/** @type {{requestId:string,text:string,replyToId?:string,attachment?:{kind:string,sha256:string}}[]} */const frames=[];
/** @param {string} name @returns {Promise<Awaited<ReturnType<typeof connectPage>>>} */
async function open(name){const port=await reservePort(),url=transport.origin+'/?name='+name;const {child}=await launchChrome({port,userDataDir:path.join(directory,name),url,headless:true,extraArgs:['--disable-extensions']});const page=await connectPage(port,url);clients.push({port,child,page});await page.waitFor('window.echo?.getState().roomReady && !!window.echo.getState().selfKey && !!window.echo.getState().chatMedia',{timeout:12000,interval:50,label:'real '+name+' chat ready'});return page;}
try{
  const sender=await open('CaptionSender'),reader=await open('CaptionReader');
  const channel=await sender.eval('window.echo.getState().servers.flatMap(server=>server.channels).find(channel=>channel.type==="text").id');assert.equal(typeof channel,'string');
  for(const page of [sender,reader])await page.eval('window.echo.actions.selectChannel('+JSON.stringify(channel)+')');
  await sender.eval('window.echo.actions.sendMessage("Source for image reply")');
  await sender.waitFor('document.getElementById("msgInput").value==="" && !document.getElementById("sendBtn").disabled',{timeout:10000,interval:25,label:'source accepted'});
  const sourceId=await sender.eval('document.querySelector("#messages [data-msg-id]:last-child").dataset.msgId');assert.equal(typeof sourceId,'string');
  await sender.eval('document.querySelector('+JSON.stringify('#messages [data-msg-id="'+sourceId+'"] [data-testid="message-reply"]')+').click()');
  await sender.send('Network.enable');
  sender.on('Network.webSocketFrameSent',event=>{const data=JSON.parse(event.response.payloadData);if(data.t==='chat')frames.push(data);});
  await sender.eval(`(async()=>{const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;const context=canvas.getContext('2d');context.fillStyle='#87d8ce';context.fillRect(0,0,256,256);context.fillStyle='#f2556b';context.fillRect(32,32,192,192);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));window.composerActualFile=new File([blob],'caption-source.png',{type:'image/png'});const transfer=new DataTransfer();transfer.items.add(window.composerActualFile);const input=document.getElementById('msgInput');input.value='Image caption stays while preparing';input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`);
  await sender.waitFor('!document.getElementById("sendBtn").disabled && !document.getElementById("mediaSendBtn").disabled',{timeout:30000,interval:25,label:'actual PNG encoded after rejected premature Enter'});
  assert.equal(frames.length,0,'Preparing an image must reject premature Enter without sending a separate text message');
  assert.equal(await sender.eval('document.getElementById("msgInput").value'),'Image caption stays while preparing');
  assert.equal(await sender.eval('document.getElementById("mediaComposerPreview").hidden'),false);
  await sender.eval('document.getElementById("msgInput").dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true,data:"原"}));document.getElementById("msgInput").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing:true,keyCode:229,bubbles:true,cancelable:true}));document.getElementById("msgInput").dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"原"}))');
  assert.equal(frames.length,0,'IME confirmation Enter must not send staged image or caption');
  assert.equal(await sender.eval('document.getElementById("msgInput").value'),'Image caption stays while preparing');
  transport.dropNextChatAcknowledgement();
  await sender.eval('document.getElementById("msgInput").value="原子图文回复";document.getElementById("msgInput").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))');
  await sender.waitFor('window.echo.getState().roomReady && !!window.echo.getState().selfKey && !document.getElementById("sendBtn").disabled && !document.getElementById("mediaSendBtn").disabled',{timeout:15000,interval:25,label:'real connection resumes after accepted chat loses acknowledgement'});
  assert.equal(transport.dropped(),1);assert.equal(transport.failure(),null);
  assert.equal(await sender.eval('document.getElementById("msgInput").value'),'原子图文回复');assert.equal(await sender.eval('document.getElementById("mediaComposerPreview").hidden'),false);assert.equal(await sender.eval('document.getElementById("replyComposer").hidden'),false);
  assert.equal(frames.length,1);
  await sender.eval('document.getElementById("msgInput").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))');
  await sender.waitFor('document.getElementById("msgInput").value==="" && document.getElementById("mediaComposerPreview").hidden && !document.getElementById("sendBtn").disabled',{timeout:20000,interval:25,label:'one acknowledged image caption reply clears both drafts'});
  assert.equal(frames.length,2);assert.equal(frames[0].text,'原子图文回复');assert.equal(frames[0].replyToId,sourceId);assert.equal(frames[0].attachment?.kind,'image');assert.deepEqual(frames[1],frames[0],'Retry must reuse request ID and the exact attachment descriptor');
  await reader.waitFor('document.querySelectorAll("#messages [data-testid=chat-attachment]").length===1 && document.querySelector("#messages [data-testid=message-reference]")?.dataset.chatReference==='+JSON.stringify(sourceId),{timeout:20000,interval:50,label:'second real client sees one image with reply'});
  assert.equal(await reader.eval('[...document.querySelectorAll("#messages [data-msg-id] .msg-text")].filter(node=>node.textContent==="原子图文回复").length'),1);
  await reader.screenshot(path.join(output,'atomic-image-reply.png'));
  const baseline=await sender.eval('window.echo.getState().chatMedia.ownedUrls');
  await sender.eval(`(()=>{const transfer=new DataTransfer();transfer.items.add(window.composerActualFile);document.getElementById('msgInput').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));document.getElementById('mediaCancelBtn').click();})()`);
  await sender.waitFor('window.echo.getState().chatMedia.queuedImages===0 && window.echo.getState().chatMedia.activeImageBytes===0',{timeout:10000,interval:25,label:'real cancelled codec job settles'});
  assert.equal(await sender.eval('document.getElementById("mediaComposerPreview").hidden'),true);
  assert.equal(await sender.eval('window.echo.getState().chatMedia.ownedUrls'),baseline,'Cancelled preparation must release its preview lease');
  assert.equal(frames.length,2,'Cancelling preparation must not send another message');
  const objectDirectories=fs.readdirSync(path.join(directory,'server','media'),{withFileTypes:true}).filter(entry=>entry.isDirectory());let objects=0;for(const entry of objectDirectories){const folder=path.join(directory,'server','media',entry.name,'objects');if(fs.existsSync(folder))objects+=fs.readdirSync(folder).filter(name=>name.endsWith('.avif')).length;}assert.equal(objects,1,'Actual storage must contain one uploaded image after retry');
  console.log('PASS two real clients: premature/IME Enter preserved, accepted chat ACK dropped by real transport disconnect, unchanged image/caption/reply retry deduplicated, one stored asset and cancelled preview released');
}catch(error){for(const [index,client] of clients.entries())await client.page.screenshot(path.join(output,'failure-'+index+'.png'));throw error;}
finally{for(const client of clients){await closeChrome(client.port);client.page.close();if(client.child.exitCode===null)client.child.kill();}await transport.close();await stop(backend);assert.equal(path.dirname(directory),os.tmpdir());fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
