// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {CHROME,waitForPort,connectPage,closeChrome} from './cdp.mjs';
import {launch,stop,reservePort,connect,authenticate,identity,object,string} from './server-ws-helpers.mjs';
import {parseInterfaceScheme,parseSchemeValues} from '../public/js/interface-scheme.js';
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../public/js/interface-scheme.js').InterfaceSelection} Selection */
/** @typedef {Awaited<ReturnType<typeof connectPage>>} Page */
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const executable=fs.realpathSync(CHROME);
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-interface-package-'));
const output=path.join(root,'output/playwright/interface-package-ui');fs.mkdirSync(output,{recursive:true});
/** @param {string} name @returns {Selection} */
function selection(name){
 const manifest=path.join(root,'public/customization/interfaces',name+'.json');
 /** @type {JsonValue} */const input=JSON.parse(fs.readFileSync(manifest,'utf8'));const row=object(input),files=object(row.files);
 /** @param {string} key @returns {string} */function content(key){const filename=path.resolve(path.dirname(manifest),string(files[key]));assert(filename.startsWith(path.dirname(manifest)+path.sep));return fs.readFileSync(filename,'utf8');}
 const {files:references,...metadata}=row;assert(references);
 const scheme=parseInterfaceScheme({...metadata,presentation:{html:content('html'),css:content('css'),script:content('script')}});
 return {scheme,values:parseSchemeValues(scheme,{})};
}
const industrial=selection('industrial-open'),constructivist=selection('constructivist-open');
/** @type {JsonValue} */const standardInput=JSON.parse(fs.readFileSync(path.join(root,'public/customization/interfaces/industrial.json'),'utf8'));
const standardScheme=parseInterfaceScheme(standardInput),standard={scheme:standardScheme,values:parseSchemeValues(standardScheme,{})};
const backend=await launch(path.join(directory,'server'),{}),port=await reservePort();
const child=spawn(executable,['--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'--user-data-dir='+path.join(directory,'chrome'),'--no-first-run','--no-default-browser-check','--disable-sync','--disable-extensions','--headless=new','--window-size=1440,900','about:blank'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let browserLog='';child.stdout.on('data',chunk=>{browserLog+=String(chunk);});child.stderr.on('data',chunk=>{browserLog+=String(chunk);});
/** @type {Page|null} */let page=null;
/** @type {JsonValue[]} */const errors=[];
/** @type {JsonValue[]} */const consoleEvents=[];
/** @type {string[]} */const checks=[];
/** @param {string} label @returns {void} */function pass(label){checks.push(label);console.log('PASS '+label);}
/** @param {Page} ui @param {string} id @returns {Promise<void>} */async function click(ui,id){const point=await ui.eval('(()=>{const node=document.getElementById('+JSON.stringify(id)+');if(!(node instanceof HTMLElement))throw new Error("Missing theme control");node.scrollIntoView({block:"center"});const bounds=node.getBoundingClientRect();if(bounds.width<=0||bounds.height<=0)throw new Error("Theme control is not visible: '+id+'");return {x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2};})()');await ui.send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});await ui.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});}
/** @param {Page} ui @param {Selection} value @returns {Promise<void>} */async function apply(ui,value){await ui.eval('(async()=>{const runtime=await import("/js/interface-scheme-runtime.js");runtime.applyInterfaceSelection('+JSON.stringify(value)+');})()');}
/** @param {Page} ui @param {string} theme @returns {Promise<void>} */async function mounted(ui,theme){await ui.waitFor('!!document.getElementById('+JSON.stringify('theme-'+theme)+') && document.querySelectorAll("[data-deepscord-slot]").length===7',{timeout:10000,interval:50,label:theme+' full package mounted'});}
/** @param {Page} ui @returns {Promise<void>} */async function preserved(ui){assert.equal(await ui.eval('Object.entries(window.packageAcceptance.nodes).every(([key,value])=>document.querySelector(window.packageAcceptance.selectors[key])===value && value.isConnected)'),true,'All original application and media hosts must retain node identity');}
/** @param {Page} ui @returns {Promise<void>} */async function slots(ui){const result=await ui.eval('Object.fromEntries(["rail","sidebar","topbar","radio","content","members","self"].map(key=>[key,window.packageAcceptance.nodes[key].parentElement===document.querySelector("[data-deepscord-slot="+key+"]")]))');assert.deepEqual(result,{rail:true,sidebar:true,topbar:true,radio:true,content:true,members:true,self:true});await preserved(ui);}
try{
 await waitForPort(port,20000);page=await connectPage(port,'about:blank');const ui=page;
 await ui.send('Page.enable',{});await ui.send('Runtime.enable',{});ui.on('Runtime.consoleAPICalled',/** @param {JsonValue} value */value=>consoleEvents.push(value));ui.on('Runtime.exceptionThrown',/** @param {JsonValue} value */value=>errors.push(value));
 const bootstrap='if(!localStorage.getItem("echo.settings"))localStorage.setItem("echo.settings",JSON.stringify('+JSON.stringify({name:'Theme package member',sounds:false,interfaceSelection:industrial})+'));window.packageAcceptance={selectors:{rail:"#serverRail",sidebar:".sidebar",topbar:".topbar",radio:"#radioStrip",content:".content",members:"#members",self:"#selfPanel",audio:"#audioSinks",stage:"#voiceStage",grid:"#stageGrid",chat:"#chat",composer:"#composerWrap"},nodes:{},parents:{}};const capture=()=>{for(const[key,selector]of Object.entries(window.packageAcceptance.selectors)){const element=document.querySelector(selector);if(element&&!window.packageAcceptance.nodes[key]){window.packageAcceptance.nodes[key]=element;window.packageAcceptance.parents[key]=element.parentNode;}}};const observer=new MutationObserver(capture);observer.observe(document,{childList:true,subtree:true});document.addEventListener("DOMContentLoaded",capture,{once:true});';
 const injected=await ui.send('Page.addScriptToEvaluateOnNewDocument',{source:bootstrap});
 await ui.send('Page.navigate',{url:backend.origin});
 await ui.waitFor('window.echo?.getState().roomReady && !!window.echo.getState().selfKey',{timeout:15000,interval:50,label:'actual app restored persisted full theme snapshot'});
 await mounted(ui,'industrial');await slots(ui);
 assert.equal(await ui.eval('JSON.parse(localStorage.getItem("echo.settings")).interfaceSelection.scheme.id'),'industrial-open');
 assert.equal(await ui.eval('document.querySelectorAll("#deepscordThemeScript").length'),1);
 assert.equal(await ui.eval('document.querySelectorAll("#deepscordThemeStyle").length'),1);
 assert.equal(await ui.eval('document.querySelector("iframe[sandbox]").getAttribute("sandbox")'),'allow-scripts');
 pass('Persisted HTML/CSS/script package automatically mounts seven original application hosts in an opaque script frame');
 for(const [theme,value] of [['industrial',industrial],['constructivist',constructivist]]){
  if(theme==='constructivist'){await ui.eval('(()=>{const settings=JSON.parse(localStorage.getItem("echo.settings"));settings.interfaceSelection='+JSON.stringify(constructivist)+';localStorage.setItem("echo.settings",JSON.stringify(settings));})()');await ui.send('Page.reload',{ignoreCache:true});await ui.waitFor('window.echo?.getState().roomReady && !!window.echo.getState().selfKey',{timeout:15000,interval:50,label:'second persisted package restored in a fresh app document'});}
  await apply(ui,/** @type {Selection} */(value));await mounted(ui,/** @type {string} */(theme));await slots(ui);
  await ui.waitFor('document.getElementById('+JSON.stringify('theme-'+theme+'-server')+').textContent===document.getElementById("connectionServerName").textContent',{timeout:10000,interval:50,label:String(theme)+' script receives real server state'});
  const before=await ui.eval('document.getElementById('+JSON.stringify('theme-'+theme+'-count')+').textContent');
  const peer=await connect(backend,'Theme presence '+theme);await authenticate(peer,identity());
  await ui.waitFor('document.getElementById('+JSON.stringify('theme-'+theme+'-count')+').textContent!=='+JSON.stringify(before)+' && document.getElementById('+JSON.stringify('theme-'+theme+'-count')+').textContent.includes(String(window.echo.getState().users.length))',{timeout:10000,interval:50,label:String(theme)+' script updates real presence count'});
  const density=await ui.eval('document.getElementById('+JSON.stringify('theme-'+theme)+').dataset.density');
  await click(ui,'theme-'+theme+'-density');
  await ui.waitFor('document.getElementById('+JSON.stringify('theme-'+theme)+').dataset.density!=='+JSON.stringify(density),{timeout:5000,interval:50,label:String(theme)+' package density action'});
  for(const width of [1440,390]){
   await ui.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
   await ui.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
   if(width===390){
    if(theme==='industrial')await ui.waitFor('document.getElementById("interfaceChannelIndex").hidden===false',{timeout:5000,interval:50,label:'narrow native directory control visible'});
    const directory=theme==='industrial'?'.theme-workstation-directory':'.theme-newspaper-directory';
    const covered='!!document.elementFromPoint(innerWidth/2,450)?.closest('+JSON.stringify(directory)+')';
    await ui.waitFor('!('+covered+')',{timeout:5000,interval:50,label:String(theme)+' narrow directory starts closed'});
    await click(ui,theme==='industrial'?'interfaceChannelIndex':'theme-constructivist-directory');
    await ui.waitFor(covered,{timeout:5000,interval:50,label:String(theme)+' narrow directory opens through original or theme action'});
    await click(ui,theme==='industrial'?'interfaceChannelIndex':'theme-constructivist-directory');
    await ui.waitFor('!('+covered+')',{timeout:5000,interval:50,label:String(theme)+' narrow directory closes'});
   }
   await ui.screenshot(path.join(output,String(theme)+'-'+width+'.png'));
  }
  await ui.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 }
 pass('Both authored scripts receive server names and live member counts and handle density actions at desktop and narrow widths');
 await apply(ui,industrial);await mounted(ui,'industrial');
 await ui.waitFor('document.getElementById("theme-industrial-server").textContent===document.getElementById("connectionServerName").textContent',{timeout:10000,interval:50,label:'script action bridge ready'});
 await click(ui,'theme-industrial-settings');
 await ui.waitFor('!!document.getElementById("profileName")',{timeout:5000,interval:50,label:'package settings action opens original settings flow'});
 await ui.eval('document.getElementById("audioSettingsDone").click()');
 await ui.waitFor('!document.querySelector(".modal-backdrop")',{timeout:5000,interval:50,label:'original settings closes'});
 pass('Theme action bridge opens the production settings flow');
 for(let cycle=0;cycle<5;cycle++){
  await apply(ui,constructivist);await mounted(ui,'constructivist');await slots(ui);
  assert.equal(await ui.eval('document.querySelectorAll("#deepscordThemeScript").length'),1);
 assert.equal(await ui.eval('document.querySelectorAll("#deepscordThemeStyle").length'),1);
  await apply(ui,standard);
  assert.equal(await ui.eval('document.querySelectorAll("[data-deepscord-slot]").length'),0);
  assert.equal(await ui.eval('document.querySelectorAll("#deepscordThemeScript").length'),0);
  assert.equal(await ui.eval('document.querySelectorAll("#deepscordThemeStyle").length'),0);
  assert.equal(await ui.eval('document.querySelectorAll("#deepscordThemeHost").length'),0);
  assert.equal(await ui.eval('Object.entries(window.packageAcceptance.parents).every(([key,parent])=>window.packageAcceptance.nodes[key].parentNode===parent)'),true,'Clearing the package must restore every original parent');
  await preserved(ui);
 }
 pass('Five package switches restore original parents without replacing media hosts or accumulating script frames');
 await ui.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await apply(ui,constructivist);await mounted(ui,'constructivist');
 await ui.waitFor('document.getAnimations().filter(animation=>animation.playState==="running" && animation.effect?.target?.closest?.("#theme-constructivist")).length===0',{timeout:5000,interval:50,label:'reduced motion stops package animation'});
 const failed={...industrial,scheme:{...industrial.scheme,id:'authored-error-check',presentation:{...industrial.scheme.presentation,html:industrial.scheme.presentation?.html ?? '',css:industrial.scheme.presentation?.css ?? '',script:'throw new Error("Theme package functional error check");'}}};
 await apply(ui,failed);
 await ui.waitFor('document.getElementById("toastRoot").textContent.includes("Theme package functional error check")',{timeout:10000,interval:50,label:'authored script failure produces a clear application toast'});
 const syntax={...failed,scheme:{...failed.scheme,id:'authored-syntax-check',presentation:{...failed.scheme.presentation,script:'const incomplete = ;'}}};
 await apply(ui,syntax);
 await ui.waitFor('document.getElementById("toastRoot").textContent.includes("SyntaxError")',{timeout:10000,interval:50,label:'authored syntax error produces a clear application toast'});
 await apply(ui,standard);await preserved(ui);
 assert.equal(errors.length,0,JSON.stringify(errors));
 pass('Reduced motion and clear authored script error reporting use the supported theme interface');
 await ui.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:injected.identifier});
 await ui.send('Page.reload',{ignoreCache:true});
 await ui.waitFor('window.echo?.getState().roomReady && !!document.getElementById("theme-constructivist")',{timeout:15000,interval:50,label:'real persistent snapshot restores on a new app document'});
 assert.equal(await ui.eval('document.querySelectorAll("#deepscordThemeScript").length'),1);
 assert.equal(await ui.eval('document.querySelectorAll("#deepscordThemeStyle").length'),1);
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({checks,errors,browserLog,serverLog:backend.output()},null,2));
 console.log('ARTIFACTS '+output);
}catch(error){const diagnostic=page?await page.eval('({state:window.echo?.getState(),toast:document.getElementById("toastRoot")?.textContent,welcome:!!document.getElementById("welcomeNameInput"),settings:localStorage.getItem("echo.settings")})'):null;if(page)await page.screenshot(path.join(output,'failure.png'));fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:error instanceof Error?error.stack:String(error),checks,errors,consoleEvents,diagnostic,browserLog,serverLog:backend.output()},null,2));throw error;}
finally{page?.close();const exited=child.exitCode===null?once(child,'exit'):Promise.resolve();await closeChrome(port);if(child.exitCode===null)child.kill();await exited;await stop(backend);}
