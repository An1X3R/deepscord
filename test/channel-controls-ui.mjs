// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {launchChrome,connectPage,closeChrome} from './cdp.mjs';
import {launch,stop,reservePort,connect,authenticate,identity,send,receive,journal,change,object,string} from './server-ws-helpers.mjs';
import {parseInterfaceScheme,parseSchemeValues} from '../public/js/interface-scheme.js';
const root=process.cwd(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-channel-controls-'));
const output=path.join(root,'output/playwright/channel-controls');fs.mkdirSync(output,{recursive:true});
const backend=await launch(path.join(directory,'server'),{}),port=await reservePort();
const url=backend.origin+'/?name=ChannelReviewer';
const {child}=await launchChrome({port,userDataDir:path.join(directory,'browser'),url,headless:true,extraArgs:['--disable-extensions']});
/** @type {Awaited<ReturnType<typeof connectPage>>|null} */let page=null;
/** @type {Awaited<ReturnType<typeof connect>>|null} */let owner=null;
/** @param {string} name @returns {import('../public/js/interface-scheme.js').InterfaceSelection} */
function theme(name){
  const filename=path.join(root,'public/customization/interfaces',name+'.json');
  const row=object(JSON.parse(fs.readFileSync(filename,'utf8'))),files=object(row.files);
  /** @param {string} key @returns {string} */function read(key){const target=path.resolve(path.dirname(filename),string(files[key]));assert(target.startsWith(path.dirname(filename)+path.sep));return fs.readFileSync(target,'utf8');}
  const {files:references,...metadata}=row;assert(references);
  const scheme=parseInterfaceScheme({...metadata,presentation:{html:read('html'),css:read('css'),script:read('script')}});
  return{scheme,values:parseSchemeValues(scheme,{})};
}
try{
  page=await connectPage(port,url);const ui=page;
  await ui.waitFor('window.echo?.getState().roomReady && window.echo.getState().selfKey',{timeout:10000,interval:50,label:'connected member identity'});
  const button='channel-settings-ch-lobby';
  await ui.eval('document.getElementById('+JSON.stringify(button)+').click()');
  assert.equal(await ui.eval('!!document.getElementById("channelShareMenuBtn") && !document.getElementById("channelEditMenuBtn") && !document.getElementById("channelDeleteMenuBtn")'),true);
  const actor=identity();owner=await connect(backend,'Owner');await authenticate(owner,actor);
  const cursor=send(owner,{t:'claimOwner',token:fs.readFileSync(path.join(directory,'server/owner-claim.txt'),'utf8').trim()});
  let current=journal(await receive(owner,cursor,message=>message.t==='serverState' && object(message.policy).ownerKey===actor.key,'owner claim'));
  const memberKey=await ui.eval('window.echo.getState().selfKey');assert.equal(typeof memberKey,'string');
  current=await change(owner,actor,current,{type:'setDomainAdmin',domainId:'srv-main',memberKey,enabled:true});
  await ui.waitFor('document.querySelector("[data-create=voice]")?.disabled===false',{timeout:5000,interval:50,label:'domain admin channel permission'});
  for(const name of ['industrial','constructivist','industrial-open','constructivist-open','lanart-open']){
    const selection=name.endsWith('-open')?theme(name):(()=>{const scheme=parseInterfaceScheme(JSON.parse(fs.readFileSync(path.join(root,'public/customization/interfaces',name+'.json'),'utf8')));return{scheme,values:parseSchemeValues(scheme,{})};})();
    await ui.eval('(async()=>{const runtime=await import("/js/interface-scheme-runtime.js");runtime.applyInterfaceSelection('+JSON.stringify(selection)+');await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()');
    if(name==='constructivist')await ui.eval('document.getElementById("interfaceChannelIndex").click();Promise.all(document.getAnimations().map(animation=>animation.finished))');
    const point=await ui.eval('(()=>{const button=document.getElementById('+JSON.stringify(button)+');const r=button.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,visible:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest("[data-channel-settings]")===button};})()');
    assert(point.width>=28 && point.height>=28 && point.visible,name+' channel control remains reachable');
    await ui.send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
    await ui.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});
    assert.equal(await ui.eval('!!document.getElementById("channelEditMenuBtn")'),true);
    await ui.eval('Promise.all(document.querySelector(".context-menu").getAnimations().map(animation=>animation.finished))');
    await ui.screenshot(path.join(output,name+'.png'));
    await ui.eval('document.getElementById("channelEditMenuBtn").click()');
    await ui.eval('document.getElementById("editChannelLimitInput").value="4";document.getElementById("editChannelSaveBtn").click()');
    await ui.waitFor('document.querySelector("[data-channel-id=ch-lobby] .ch-count")?.textContent==="00/4"',{timeout:5000,interval:50,label:'persisted channel capacity'});
    await ui.waitFor('!document.querySelector(".modal-backdrop")',{timeout:3000,interval:50,label:'editor removed'});
  }
  await ui.eval('window.retainedChannel=document.getElementById('+JSON.stringify(button)+');window.retainedChannel.focus();window.retainedSidebar=document.getElementById("channelScroll");');
  current=await change(owner,actor,current,{type:'renameServer',name:'Updated room'});
  await ui.waitFor('document.getElementById("connectionServerName").textContent==="Updated room"',{timeout:5000,interval:50,label:'room state rerender'});
  assert.equal(await ui.eval('document.getElementById('+JSON.stringify(button)+')===window.retainedChannel && document.activeElement===window.retainedChannel'),true,'Unchanged channel node and focus survive state updates');
  await ui.eval('document.querySelector("[data-server-id=srv-night]").click();document.getElementById("channel-settings-ch-night-text").click()');
  assert.equal(await ui.eval('!!document.getElementById("channelShareMenuBtn") && !document.getElementById("channelEditMenuBtn")'),true,'Domain admin cannot edit another domain');
  console.log('PASS channel actions, scoped permissions, capacity save, five themes, retained focus');
}finally{
  owner?.socket.close();await closeChrome(port);page?.close();if(child.exitCode===null)child.kill();await stop(backend);
  assert(path.dirname(directory)===os.tmpdir() && path.basename(directory).startsWith('deepscord-channel-controls-'));fs.rmSync(directory,{recursive:true,force:true});
}
