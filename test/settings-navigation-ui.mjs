// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {launchChrome,connectPage,closeChrome} from './cdp.mjs';
import {launch,stop,reservePort,object,string} from './server-ws-helpers.mjs';
import {parseInterfaceScheme,parseSchemeValues} from '../public/js/interface-scheme.js';

const root=process.cwd(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-settings-navigation-'));
const output=path.join(root,'output/playwright/settings-navigation');fs.mkdirSync(output,{recursive:true});
const wave=Buffer.alloc(44+6400);wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(16000,24);wave.writeUInt32LE(32000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(6400,40);
const soundFile=path.join(directory,'notification.wav');fs.writeFileSync(soundFile,wave);
const backend=await launch(path.join(directory,'server'),{}),port=await reservePort(),url=backend.origin+'/?name=SettingsReviewer';
const {child}=await launchChrome({port,userDataDir:path.join(directory,'browser'),url,headless:true,extraArgs:['--disable-extensions']});
/** @type {Awaited<ReturnType<typeof connectPage>>|null} */let page=null;
/** @type {string[]} */const errors=[];
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
  ui.on('Runtime.exceptionThrown',event=>errors.push(JSON.stringify(event.exceptionDetails)));
  await ui.send('Runtime.enable');await ui.send('Page.enable');
  await ui.waitFor('window.echo?.getState().roomReady && window.echo.getState().selfKey',{timeout:10000,interval:50,label:'connected local client'});
  /** @param {string} id @returns {Promise<void>} */async function click(id){
    await ui.eval('document.getElementById('+JSON.stringify(id)+').scrollIntoView({block:"center",behavior:"instant"})');
    await ui.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const point=await ui.eval('(()=>{const button=document.getElementById('+JSON.stringify(id)+'),r=button.getBoundingClientRect();if(!button.checkVisibility()||button.disabled||r.width<20||r.height<20)throw new Error("Control unavailable: "+button.id);return{x:r.x+r.width/2,y:r.y+r.height/2};})()');
    await ui.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
    await ui.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
  }
  /** @returns {Promise<void>} */async function settled(){await ui.eval('Promise.all(document.getElementById("modalRoot").getAnimations({subtree:true}).filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished))');}
  for(const name of ['industrial','constructivist','industrial-open','constructivist-open','lanart-open']){
    await ui.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await ui.eval('(async()=>{const runtime=await import("/js/interface-scheme-runtime.js");runtime.applyInterfaceSelection('+JSON.stringify(theme(name))+');})()');
    const entry=name.endsWith('-open')?'theme-'+name.replace('-open','')+'-settings':'railSettingsBtn';
    await ui.waitFor('document.getElementById('+JSON.stringify(entry)+')?.checkVisibility()',{timeout:5000,interval:50,label:'visible software entry'});
    if(name.endsWith('-open'))await ui.waitFor('document.getElementById('+JSON.stringify('theme-'+name.replace('-open','')+'-server')+').textContent===document.getElementById("connectionServerName").textContent',{timeout:5000,interval:50,label:'theme script ready'});
    assert.equal(await ui.eval('[...document.querySelectorAll("#railSettingsBtn,[data-theme-action=settings]")].filter(button=>button.checkVisibility()).length'),1,'One visible software settings entry in '+name);
    await click(entry);await ui.waitFor('!!document.getElementById("softwareSettingsPanel")',{timeout:5000,interval:50,label:'software settings'});await settled();
    assert.equal(await ui.eval('!!document.getElementById("profileName") && !document.getElementById("audioInputDevice") && !document.getElementById("screenTransmissionSettings")'),true,'Software settings do not initialize voice controls');
    assert.equal(await ui.eval('(()=>{const ids=["themeCustomizationMenuBtn","notificationJoinSoundMenuBtn","notificationLeaveSoundMenuBtn","notificationResetSoundsMenuBtn"],rows=ids.map(id=>document.getElementById(id).closest(".setting-row"));return rows.every((row,index)=>!index||rows[index-1].nextElementSibling===row);})()'),true,'Local theme followed by notification controls');
    if(name==='industrial'){
      await ui.send('Page.setInterceptFileChooserDialog',{enabled:true});
      for(const id of ['notificationJoinSoundMenuBtn','notificationLeaveSoundMenuBtn']){
        /** @type {Promise<{backendNodeId:number}>} */const chooser=new Promise((resolve,reject)=>{
          const timeout=setTimeout(()=>{unsubscribe();reject(new Error('Notification file chooser did not open'));},5000);
          const unsubscribe=ui.on('Page.fileChooserOpened',event=>{clearTimeout(timeout);unsubscribe();resolve(event);});
        });
        const [,chosen]=await Promise.all([click(id),chooser]);
        await ui.send('DOM.setFileInputFiles',{backendNodeId:chosen.backendNodeId,files:[soundFile]});
        await ui.waitFor('!document.getElementById('+JSON.stringify(id)+').disabled',{timeout:5000,interval:50,label:'notification selected and previewed'});
      }
      const keys='new Promise((resolve,reject)=>{const request=indexedDB.open("deepscord-notification-sounds",1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,read=db.transaction("sounds","readonly").objectStore("sounds").getAllKeys();read.onsuccess=()=>{db.close();resolve(read.result);};read.onerror=()=>{db.close();reject(read.error);};};})';
      assert.deepEqual(await ui.eval(keys),['join','leave'],'Relocated buttons save both sounds');
      await click('notificationResetSoundsMenuBtn');await ui.waitFor('!document.getElementById("notificationResetSoundsMenuBtn").disabled',{timeout:3000,interval:50,label:'notification defaults restored'});
      assert.deepEqual(await ui.eval(keys),[],'Restore clears both local sound preferences');
    }
    await ui.eval('document.getElementById("themeCustomizationMenuBtn").scrollIntoView({block:"center"})');await ui.screenshot(path.join(output,name+'-software.png'));
    await ui.send('Emulation.setDeviceMetricsOverride',{width:390,height:780,deviceScaleFactor:1,mobile:false});
    await ui.eval('document.getElementById("notificationLeaveSoundMenuBtn").scrollIntoView({block:"center"})');
    assert.equal(await ui.eval('(()=>{const panel=document.getElementById("softwareSettingsPanel"),button=document.getElementById("notificationLeaveSoundMenuBtn").getBoundingClientRect();return panel.scrollWidth<=panel.clientWidth && button.left>=0 && button.right<=innerWidth;})()'),true,'Narrow settings controls fit');
    await ui.screenshot(path.join(output,name+'-software-narrow.png'));
    await ui.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await click('softwareSettingsDone');await ui.waitFor('!document.querySelector(".modal-backdrop")',{timeout:3000,interval:50,label:'software closed'});
    await click('voiceSettingsBtn');await ui.waitFor('!!document.getElementById("voiceSettingsPanel")',{timeout:3000,interval:50,label:'voice settings'});await settled();
    assert.equal(await ui.eval('!!document.getElementById("audioInputDevice") && !!document.getElementById("screenTransmissionSettings") && !document.getElementById("profileName") && !document.getElementById("themeCustomizationMenuBtn")'),true,'Self panel opens only voice and screen controls');
    await ui.screenshot(path.join(output,name+'-voice.png'));await click('audioSettingsDone');await ui.waitFor('!document.querySelector(".modal-backdrop")',{timeout:3000,interval:50,label:'voice closed'});
    await ui.eval('document.getElementById("serverMenuBtn").click()');
    assert.equal(await ui.eval('!!document.getElementById("serverGovernanceMenuBtn") && ["themeCustomizationMenuBtn","notificationJoinSoundMenuBtn","notificationLeaveSoundMenuBtn","notificationResetSoundsMenuBtn"].every(id=>!document.getElementById(id))'),true,'Domain menu contains no local preferences');
    await ui.screenshot(path.join(output,name+'-domain-menu.png'));await ui.eval('document.body.click()');
  }
  await click('theme-lanart-settings');await ui.waitFor('!!document.getElementById("themeCustomizationMenuBtn")',{timeout:5000,interval:50,label:'local theme entry'});await settled();await click('themeCustomizationMenuBtn');
  await ui.waitFor('!!document.getElementById("customizationPanel") && !document.getElementById("softwareSettingsPanel")',{timeout:5000,interval:50,label:'local customization replaces software panel'});
  assert.deepEqual(errors,[]);console.log('PASS five themes: one software entry, separate voice settings, local preferences moved, narrow layouts and theme navigation');
}catch(error){fs.writeFileSync(path.join(output,'errors.json'),JSON.stringify(errors,null,2));if(page)await page.screenshot(path.join(output,'failure.png'));throw error;}
finally{await closeChrome(port);page?.close();if(child.exitCode===null)child.kill();await stop(backend);assert(path.dirname(directory)===os.tmpdir()&&path.basename(directory).startsWith('deepscord-settings-navigation-'));fs.rmSync(directory,{recursive:true,force:true});}
