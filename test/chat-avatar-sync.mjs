// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {launchChrome,connectPage,closeChrome} from './cdp.mjs';
import {launch,stop,reservePort} from './server-ws-helpers.mjs';

const root=process.cwd(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-chat-avatar-'));
const output=path.join(root,'output/playwright/chat-avatar');fs.mkdirSync(output,{recursive:true});
const backend=await launch(path.join(directory,'server'),{});
/** @type {{port:number,child:import('node:child_process').ChildProcess,page:Awaited<ReturnType<typeof connectPage>>}[]} */const clients=[];
/** @type {string[]} */const errors=[];
/** @param {string} name @returns {Promise<Awaited<ReturnType<typeof connectPage>>>} */
async function open(name){
  const port=await reservePort(),url=backend.origin+'/?name='+name;
  const {child}=await launchChrome({port,userDataDir:path.join(directory,name),url,headless:true,extraArgs:['--disable-extensions']});
  const page=await connectPage(port,url);clients.push({port,child,page});
  page.on('Runtime.exceptionThrown',event=>errors.push(JSON.stringify(event.exceptionDetails)));await page.send('Runtime.enable');
  await page.waitFor('window.echo?.getState().roomReady && !!window.echo.getState().selfKey',{timeout:12000,interval:50,label:name+' authenticated'});
  return page;
}
try{
  const alice=await open('AvatarAlice'),bob=await open('AvatarBob');
  const authorId=await alice.eval('window.echo.getState().selfId');assert.equal(typeof authorId,'string');
  const channelId=await alice.eval('window.echo.getState().servers.flatMap(domain=>domain.channels).find(channel=>channel.type==="text").id');
  for(const page of [alice,bob])await page.eval('window.echo.actions.selectChannel('+JSON.stringify(channelId)+')');
  const before=await alice.eval('window.echo.getState().messageCounts['+JSON.stringify(channelId)+']');
  await alice.eval('window.echo.actions.sendMessage("Avatar synchronization regression")');
  for(const page of [alice,bob])await page.waitFor('window.echo.getState().messageCounts['+JSON.stringify(channelId)+']==='+String(before+1),{timeout:5000,interval:50,label:'existing message received'});
  const id=await alice.eval('document.querySelector("#messages [data-msg-id]:last-child").dataset.msgId');assert.equal(typeof id,'string');
  const selector='#messages [data-msg-id="'+id+'"]';
  for(const page of [alice,bob])await page.eval('(()=>{const row=document.querySelector('+JSON.stringify(selector)+');window.avatarMessageNodes={row,body:row.querySelector(".msg-body"),text:row.querySelector(".msg-text"),actions:row.querySelector(".chat-message-actions")};})()');
  await alice.eval('window.echo.actions.openSettings()');
  const document=await alice.send('DOM.getDocument');const input=await alice.send('DOM.querySelector',{nodeId:document.root.nodeId,selector:'#profileAvatarFile'});assert(input.nodeId);
  await alice.send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[path.join(root,'test/fixtures/avatar-96.jpg')]});
  await alice.waitFor('!!document.getElementById("avatarCropSave")',{timeout:5000,interval:50,label:'real avatar crop'});
  await alice.eval('document.getElementById("avatarCropSave").click()');
  await alice.waitFor('!!window.echo.getState().settings.avatar',{timeout:5000,interval:50,label:'new local avatar saved'});
  const avatar=await alice.eval('window.echo.getState().settings.avatar');assert.equal(typeof avatar,'string');
  /** @param {string|null} expected @returns {Promise<void>} */
  async function verify(expected){
    for(const page of [alice,bob]){
      await page.waitFor('window.echo.getState().users.find(user=>user.id==='+JSON.stringify(authorId)+')?.avatar==='+JSON.stringify(expected),{timeout:5000,interval:50,label:'profile reaches both clients'});
      await page.waitFor('(()=>{const image=document.querySelector('+JSON.stringify(selector+' .msg-avatar img')+');return '+(expected===null?'!image':'image?.getAttribute("src")==='+JSON.stringify(expected))+';})()',{timeout:3000,interval:50,label:'existing chat avatar matches live member profile'});
      assert.equal(await page.eval('(()=>{const saved=window.avatarMessageNodes,row=document.querySelector('+JSON.stringify(selector)+');return saved.row===row && saved.body===row.querySelector(".msg-body") && saved.text===row.querySelector(".msg-text") && saved.actions===row.querySelector(".chat-message-actions");})()'),true,'Profile refresh retains message content and media controls');
    }
  }
  await verify(avatar);
  await alice.eval('document.getElementById("softwareSettingsDone").click()');await alice.waitFor('!document.querySelector(".modal-backdrop")',{timeout:3000,interval:50,label:'settings closed'});
  await bob.screenshot(path.join(output,'remote-chat-avatar.png'));
  const voiceId=await bob.eval('window.echo.getState().servers.flatMap(domain=>domain.channels).find(channel=>channel.type==="voice").id');
  await bob.eval('window.echo.actions.selectChannel('+JSON.stringify(voiceId)+');window.echo.actions.selectChannel('+JSON.stringify(channelId)+')');
  assert.equal(await bob.eval('document.querySelector('+JSON.stringify(selector+' .msg-avatar img')+')?.getAttribute("src")'),avatar,'Rebuilt chat rows retain the current avatar');
  await bob.eval('window.avatarReloadMarker=true');await bob.send('Page.reload',{ignoreCache:true});await bob.waitFor('!window.avatarReloadMarker && window.echo?.getState().roomReady && !!window.echo.getState().selfKey',{timeout:10000,interval:50,label:'reader reconnects in new document'});
  await bob.eval('window.echo.actions.selectChannel('+JSON.stringify(channelId)+')');
  await bob.waitFor('document.querySelector('+JSON.stringify(selector+' .msg-avatar img')+')?.getAttribute("src")==='+JSON.stringify(avatar),{timeout:5000,interval:50,label:'history resolves current author avatar after reload'});
  for(const page of [alice,bob])await page.eval('(()=>{const row=document.querySelector('+JSON.stringify(selector)+');window.avatarMessageNodes={row,body:row.querySelector(".msg-body"),text:row.querySelector(".msg-text"),actions:row.querySelector(".chat-message-actions")};})()');
  await alice.eval('window.echo.actions.openSettings()');await alice.eval('document.getElementById("profileAvatarClear").click()');await verify(null);
  assert.deepEqual(errors,[]);console.log('PASS two real local clients: avatar crop, existing chat update, retained message nodes, channel switch, reader reload and avatar removal');
}catch(error){for(const [index,client] of clients.entries())await client.page.screenshot(path.join(output,'failure-'+index+'.png'));throw error;}
finally{for(const client of clients){await closeChrome(client.port);client.page.close();if(client.child.exitCode===null)client.child.kill();}await stop(backend);assert(path.dirname(directory)===os.tmpdir()&&path.basename(directory).startsWith('deepscord-chat-avatar-'));fs.rmSync(directory,{recursive:true,force:true});}
