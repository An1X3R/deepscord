// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {launchChrome,connectPage,closeChrome} from './cdp.mjs';
import {launch,stop,reservePort,object,string} from './server-ws-helpers.mjs';
import {parseInterfaceScheme,parseSchemeValues} from '../public/js/interface-scheme.js';
const root=process.cwd(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-avatar-crop-'));
const output=path.join(root,'output/playwright/avatar-crop');fs.mkdirSync(output,{recursive:true});
const backend=await launch(path.join(directory,'server'),{}),port=await reservePort(),url=backend.origin+'/?name=AvatarReviewer';
const {child}=await launchChrome({port,userDataDir:path.join(directory,'browser'),url,headless:true,extraArgs:['--disable-extensions']});
/** @type {Awaited<ReturnType<typeof connectPage>>|null} */let page=null;
/** @param {string} name @returns {import('../public/js/interface-scheme.js').InterfaceSelection} */
function theme(name){
  const filename=path.join(root,'public/customization/interfaces',name+'.json'),row=object(JSON.parse(fs.readFileSync(filename,'utf8')));
  const files=row.files===undefined?null:object(row.files);
  /** @param {string} key @returns {string} */function read(key){assert(files);const target=path.resolve(path.dirname(filename),string(files[key]));assert(target.startsWith(path.dirname(filename)+path.sep));return fs.readFileSync(target,'utf8');}
  const {files:references,...metadata}=row;
  const scheme=parseInterfaceScheme(files?{...metadata,presentation:{html:read('html'),css:read('css'),script:read('script')}}:metadata);
  return{scheme,values:parseSchemeValues(scheme,{})};
}
try{
  page=await connectPage(port,url);const ui=page;
  await ui.waitFor('window.echo?.getState().roomReady && window.echo.getState().selfKey',{timeout:10000,interval:50,label:'connected local client'});
  const png=await ui.eval('(()=>{const canvas=document.createElement("canvas");canvas.width=600;canvas.height=300;const ctx=canvas.getContext("2d");ctx.fillStyle="rgb(232,30,38)";ctx.fillRect(0,0,300,300);ctx.fillStyle="rgb(24,70,230)";ctx.fillRect(300,0,300,300);return canvas.toDataURL("image/png").split(",")[1];})()');
  const source=path.join(directory,'avatar-regions.png');fs.writeFileSync(source,Buffer.from(png,'base64'));
  /** @returns {Promise<void>} */async function upload(){const doc=await ui.send('DOM.getDocument');const result=await ui.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#profileAvatarFile'});assert(result.nodeId);await ui.send('DOM.setFileInputFiles',{nodeId:result.nodeId,files:[source]});await ui.waitFor('!!document.getElementById("avatarCropCanvas")',{timeout:5000,interval:50,label:'crop step opened'});await ui.waitFor('document.activeElement?.id==="avatarCropZoom"',{timeout:3000,interval:50,label:'crop autofocus settled'});}
  for(const name of ['industrial','constructivist','industrial-open','constructivist-open']){
    const selection=theme(name);
    await ui.eval('(async()=>{const runtime=await import("/js/interface-scheme-runtime.js");runtime.applyInterfaceSelection('+JSON.stringify(selection)+');})()');
    await ui.eval('document.getElementById("railSettingsBtn").click()');
    await ui.waitFor('!!document.getElementById("profileAvatarFile")',{timeout:5000,interval:50,label:'profile settings'});
    const before=await ui.eval('window.echo.getState().settings.avatar');
    await upload();
    await ui.eval('document.getElementById("avatarCropZoom").value="2";document.getElementById("avatarCropZoom").dispatchEvent(new Event("input",{bubbles:true}));');
    assert.equal(await ui.eval('document.getElementById("avatarCropZoomValue").value'),'200%');
    const point=await ui.eval('(()=>{const r=document.getElementById("avatarCropCanvas").getBoundingClientRect();return{x:r.x+r.width*.75,y:r.y+r.height/2,width:r.width};})()');
    await ui.send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
    await ui.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x-point.width*.75,y:point.y,button:'left',buttons:1});
    await ui.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x-point.width*.75,y:point.y,button:'left',clickCount:1});
    const pixel=await ui.eval('Array.from(document.getElementById("avatarCropCanvas").getContext("2d").getImageData(256,256,1,1).data)');assert(pixel[2]>200 && pixel[0]<50,'Dragging selects the blue half');
    await ui.eval('Promise.all(document.getElementById("avatarCropEditor").closest(".modal-backdrop").getAnimations().map(animation=>animation.finished))');
    await ui.screenshot(path.join(output,name+'.png'));
    await ui.send('Emulation.setDeviceMetricsOverride',{width:390,height:780,deviceScaleFactor:1,mobile:false});
    await ui.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.equal(await ui.eval('(()=>{const frame=document.getElementById("avatarCropCanvas").getBoundingClientRect(),save=document.getElementById("avatarCropSave").getBoundingClientRect();return frame.left>=0 && frame.right<=innerWidth && save.right<=innerWidth && save.bottom<=innerHeight;})()'),true,'Narrow crop and save remain visible');
    await ui.screenshot(path.join(output,name+'-narrow.png'));
    await ui.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await ui.eval('document.getElementById("avatarCropCancel").click()');
    await ui.waitFor('!document.getElementById("avatarCropEditor")',{timeout:3000,interval:50,label:'canceled crop removed'});
    assert.equal(await ui.eval('window.echo.getState().settings.avatar'),before,'Cancel preserves prior avatar');
    await upload();
    await ui.eval('document.getElementById("avatarCropZoom").value="2";document.getElementById("avatarCropZoom").dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("avatarCropCanvas").focus();');
    for(let index=0;index<6;index++)await ui.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',modifiers:8});
    await ui.eval('document.getElementById("avatarCropSave").click()');
    await ui.waitFor('!document.getElementById("avatarCropEditor") && !!window.echo.getState().settings.avatar',{timeout:3000,interval:50,label:'crop saved'});
    const saved=await ui.eval('(async()=>{const src=window.echo.getState().settings.avatar;const image=await createImageBitmap(await(await fetch(src)).blob());const canvas=document.createElement("canvas");canvas.width=96;canvas.height=96;const ctx=canvas.getContext("2d");ctx.drawImage(image,0,0);const result={width:image.width,height:image.height,bytes:atob(src.split(",")[1]).length,pixel:Array.from(ctx.getImageData(48,48,1,1).data)};image.close();return result;})()');
    assert.equal(saved.width,96);assert.equal(saved.height,96);assert(saved.bytes<=12288);assert(saved.pixel[2]>200 && saved.pixel[0]<50);
    await ui.eval('document.getElementById("softwareSettingsDone").click()');
    await ui.waitFor('!document.getElementById("profileAvatarFile")',{timeout:3000,interval:50,label:'settings closed'});

  }
  await ui.send('Page.reload',{ignoreCache:true});await ui.waitFor('window.echo?.getState().roomReady && !!window.echo.getState().settings.avatar',{timeout:10000,interval:50,label:'saved avatar survives reload'});
  console.log('PASS four themes: drag, zoom, keyboard crop, cancel/reselect, bounded JPEG, persisted profile');
}finally{await closeChrome(port);page?.close();if(child.exitCode===null)child.kill();await stop(backend);assert(path.dirname(directory)===os.tmpdir() && path.basename(directory).startsWith('deepscord-avatar-crop-'));fs.rmSync(directory,{recursive:true,force:true});}
