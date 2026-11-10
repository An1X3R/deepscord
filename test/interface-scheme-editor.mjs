// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {launchChrome,connectPage,closeChrome} from './cdp.mjs';
import {launch,stop,reservePort} from './server-ws-helpers.mjs';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-scheme-editor-'));
const backend=await launch(path.join(directory,'server'),{});
const port=await reservePort();
const {child}=await launchChrome({port,userDataDir:path.join(directory,'chrome'),url:backend.origin,headless:true,extraArgs:[]});
const page=await connectPage(port,backend.origin);
/** @param {string} id @returns {Promise<void>} */
async function click(id){await page.eval(`document.getElementById(${JSON.stringify(id)}).click()`);}
/** @param {string} key @param {string} code @returns {Promise<void>} */
async function key(key,code){await page.send('Input.dispatchKeyEvent',{type:'keyDown',key,code});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key,code});}
try{
  await page.waitFor('!!window.echo',{timeout:10000,interval:50,label:'application boot'});
  await page.eval(`(async()=>{
    const {createInterfaceSchemeEditor}=await import('/js/interface-scheme-ui.js');
    const {parseInterfaceScheme,resolveInterfaceScheme}=await import('/js/interface-scheme.js');
    document.body.replaceChildren();
    const css=document.createElement('link');css.rel='stylesheet';css.href='/customization.css';document.head.append(css);
    const shell=document.createElement('div');shell.id='schemeTestShell';shell.style.cssText='width:min(680px,calc(100vw - 48px));margin:30px auto';document.body.append(shell);
    const editor=createInterfaceSchemeEditor({initialSelection:null,initialPreset:'industrial',
      listSchemes:async()=>({directory:'Browser schemes',schemes:await Promise.all(['industrial','constructivist'].map(async id=>{const response=await fetch('/customization/interfaces/'+id+'.json');if(!response.ok)throw new Error('Scheme HTTP '+response.status);return parseInterfaceScheme(await response.json());}))}),
      openDirectory:async()=>{throw new Error('此浏览器不能打开本机方案目录。');},
      preview:selection=>{const resolved=resolveInterfaceScheme(selection.scheme,selection.values);for(const [name,value] of Object.entries(resolved.variables))document.documentElement.style.setProperty(name,value);document.body.dataset.preview=JSON.stringify(selection);},
      save:async selection=>{localStorage.setItem('scheme-editor-test',JSON.stringify(selection));},
      reportError:error=>{document.body.dataset.error=error.message;}});
    shell.append(editor.element);window.schemeEditorDispose=editor.dispose;
  })()`);
  await page.waitFor('!document.getElementById("customizationThemeSave").disabled',{timeout:3000,interval:50,label:'scheme library loaded'});
  assert.equal(await page.eval('document.getElementById("customizationInterfacePreset").tagName'),'BUTTON');
  assert.equal(await page.eval('document.querySelectorAll("#customizationThemeForm select, #customizationThemeForm input[type=file]").length'),0);
  assert.equal(await page.eval('document.getElementById("customizationInterfacePreset").getBoundingClientRect().width===document.getElementById("customizationThemeForm").getBoundingClientRect().width'),true);
  await click('customizationInterfacePreset');
  assert.equal(await page.eval('document.getElementById("customizationInterfacePresetList").parentElement.matches(":popover-open")'),true);
  assert.equal(await page.eval('document.querySelector("[role=option][aria-selected=true]").dataset.value'),'industrial');
  await page.eval('document.getElementById("customizationInterfacePreset").focus()');
  await key('End','End');await key('Enter','Enter');
  assert.equal(await page.eval('JSON.parse(document.body.dataset.preview).scheme.id'),'constructivist');
  assert.equal(await page.eval('document.getElementById("customizationInterfacePreset").getAttribute("aria-expanded")'),'false');
  await page.eval('const range=document.getElementById("customizationSchemeOption-content-spacing");range.value="20";range.dispatchEvent(new Event("input",{bubbles:true}));');
  assert.equal(await page.eval('document.documentElement.style.getPropertyValue("--scheme-content-spacing")'),'20px');
  assert.equal(await page.eval('localStorage.getItem("scheme-editor-test")'),null);
  await page.eval('window.dispatchEvent(new Event("focus"))');
  await page.waitFor('document.getElementById("customizationSchemeOption-content-spacing").value==="20"',{timeout:3000,interval:50,label:'focus refresh retained draft'});
  await click('customizationThemeSave');
  await page.waitFor('JSON.parse(localStorage.getItem("scheme-editor-test"))?.values["content-spacing"]===20',{timeout:3000,interval:50,label:'explicit scheme snapshot saved'});
  await click('customizationInterfacePreset');await page.screenshot(path.join(directory,'scheme-picker.png'));await key('Escape','Escape');
  assert.equal(await page.eval('document.getElementById("customizationInterfacePreset").getAttribute("aria-expanded")'),'false');
  await click('customizationInterfacePreset');await click('customizationSchemeDirectory');
  await page.waitFor('document.body.dataset.error?.includes("不能打开")',{timeout:3000,interval:50,label:'unsupported directory error visible'});
  assert.equal(await page.eval('document.getElementById("customizationSchemeStatus").getAttribute("role")'),'alert');
  assert.equal(await page.eval('document.getElementById("customizationSchemeStatus").hidden'),false);
  await page.screenshot(path.join(directory,'scheme-editor.png'));
  await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:780,deviceScaleFactor:1,mobile:false});
  assert.equal(await page.eval('document.getElementById("customizationInterfacePreset").getBoundingClientRect().right<=innerWidth'),true);
  await page.eval('window.schemeEditorDispose();document.body.dataset.error="";window.dispatchEvent(new Event("focus"));');
  console.log(JSON.stringify({event:'interface-scheme-editor-passed',keyboard:true,dynamicOptions:true,explicitSave:true,unsavedDraftRefresh:true,unsupportedDirectory:true,narrowLayout:true,screenshot:path.join(directory,'scheme-editor.png')}));
}finally{
  const exited=child.exitCode===null?once(child,'exit'):Promise.resolve();page.close();await closeChrome(port);if(child.exitCode===null)child.kill();await exited;await stop(backend);
}
