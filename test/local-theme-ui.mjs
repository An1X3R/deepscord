// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import { launchChrome, connectPage, closeChrome } from './cdp.mjs';
import { identity, launch, stop, reservePort, connect, authenticate, send, receive, object, journal, change } from './server-ws-helpers.mjs';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-local-theme-'));
const artifacts=fs.mkdtempSync(path.join(process.cwd(),'.qa-tools/interface-scheme-app-'));
const backend=await launch(path.join(directory,'server'),{});
/** @type {{port:number,child:import('node:child_process').ChildProcess,page:Awaited<ReturnType<typeof connectPage>>}[]} */
const browsers=[];
/** @param {string} name @returns {Promise<Awaited<ReturnType<typeof connectPage>>>} */
async function open(name){
  const port=await reservePort(),url=backend.origin+'/?name='+name;
  const {child}=await launchChrome({port,userDataDir:path.join(directory,name),url,headless:true,extraArgs:['--disable-extensions']});
  const page=await connectPage(port,url);browsers.push({port,child,page});
  await ready(page);return page;
}
/** @param {Awaited<ReturnType<typeof connectPage>>} page @returns {Promise<void>} */
async function ready(page){await page.waitFor('window.echo?.getState().roomReady && !!window.echo.getState().selfKey',{timeout:12000,interval:50,label:'verified ordinary member connected'});}
/** @param {Awaited<ReturnType<typeof connectPage>>} page @param {string} id @returns {Promise<void>} */
async function click(page,id){await page.eval('(()=>{const target=document.getElementById('+JSON.stringify(id)+');if(!(target instanceof HTMLElement))throw new Error("Missing stable UI ID: '+id+'");target.click();})()');}
/** @param {Awaited<ReturnType<typeof connectPage>>} page @returns {Promise<void>} */
async function panel(page){await ready(page);await page.waitFor('!document.getElementById("customizationPanel")',{timeout:3000,interval:50,label:'previous panel removed'});await page.eval('window.echo.actions.openSettings()');await click(page,'themeCustomizationMenuBtn');await page.waitFor('!!document.getElementById("customizationSchemeOption-content-spacing") && !document.getElementById("customizationThemeSave").disabled',{timeout:3000,interval:50,label:'local theme panel'});}
try{
  const actor=identity(),owner=await connect(backend,'Owner');await authenticate(owner,actor);
  const cursor=send(owner,{t:'claimOwner',token:fs.readFileSync(path.join(directory,'server/owner-claim.txt'),'utf8').trim()});
  let current=journal(await receive(owner,cursor,message=>message.t==='serverState' && object(message.policy).ownerKey===actor.key,'claim owner'));
  current=await change(owner,actor,current,{type:'setTheme',domainId:null,theme:{accent:'#ff0000',background:'midnight',density:'compact',corners:'soft'}});
  current=await change(owner,actor,current,{type:'putInteraction',domainId:null,interaction:{id:'kept-global',name:'Global',thumbnail:null,model:'bomb',trajectory:'arc',sound:'none',durationMs:900}});
  current=await change(owner,actor,current,{type:'putInteraction',domainId:null,interaction:{id:'kept-domain',name:'Domain',thumbnail:null,model:'poop',trajectory:'linear',sound:'none',durationMs:900}});
  const history=fs.readFileSync(path.join(directory,'server/server-governance.json'),'utf8');
  const member=await open('Member'),other=await open('Other');
  assert.equal(await member.eval('window.echo.getState().selfKey===window.echo.getState().ownerKey'),false);
  for(const page of [member,other])assert.equal(await page.eval('document.documentElement.style.getPropertyValue("--accent")'),'#87d8ce','Historical server theme must not apply to a new member');
  await panel(member);
  assert.equal(await member.eval('document.getElementById("customizationInteractionsTab").hidden'),true);
  assert.equal(await member.eval('!!document.getElementById("customizationScope")'),false);
  await member.eval('document.getElementById("customizationSchemeOption-content-spacing").value="20";document.getElementById("customizationSchemeOption-content-spacing").dispatchEvent(new Event("input",{bubbles:true}));');
  assert.equal(await member.eval('getComputedStyle(document.getElementById("stageGrid")).gap'),'20px');
  await click(member,'customizationThemeSave');
  await member.waitFor('JSON.parse(localStorage.getItem("echo.settings")).interfaceSelection?.values["content-spacing"]===20',{timeout:3000,interval:50,label:'theme persisted locally'});
  await click(member,'customizationClose');
  assert.equal(await other.eval('document.documentElement.style.getPropertyValue("--accent")'),'#87d8ce','Another client must keep its own default');
  await member.eval('window.localThemeReloadMarker=true');
  await member.send('Page.reload',{ignoreCache:true});
  await member.waitFor('window.localThemeReloadMarker===undefined && window.echo?.getState().roomReady && document.documentElement.style.getPropertyValue("--scheme-content-spacing")==="20px"',{timeout:12000,interval:50,label:'new document restored local theme'});
  assert.equal(await member.eval('getComputedStyle(document.getElementById("stageGrid")).gap'),'20px');
  await member.eval('document.querySelector("[data-server-id=srv-night]").click()');
  await ready(member);
  assert.equal(await member.eval('document.documentElement.style.getPropertyValue("--scheme-content-spacing")'),'20px','Domain navigation preserves the scheme');
  await panel(member);
  await member.eval('document.getElementById("customizationSchemeOption-content-spacing").value="23";document.getElementById("customizationSchemeOption-content-spacing").dispatchEvent(new Event("input",{bubbles:true}));');
  await click(member,'customizationClose');
  assert.equal(await member.eval('document.documentElement.style.getPropertyValue("--scheme-content-spacing")'),'20px','Closing an unsaved preview restores saved options');
  await panel(member);
  assert.equal(await member.eval('document.querySelectorAll("#customizationThemeForm select, #customizationThemeForm input[type=file]").length'),0);
  assert.equal(await member.eval('["customizationAccent","customizationBackground","customizationDensity","customizationCorners","customizationInterfaceMotion","customizationInterfaceNavigation","customizationInterfaceMembers","customizationInterfaceImport","customizationInterfaceExport"].every(id=>!document.getElementById(id))'),true);
  await click(member,'customizationInterfacePreset');
  assert.equal(await member.eval('document.getElementById("customizationInterfacePresetList").parentElement.matches(":popover-open")'),true);
  await member.screenshot(path.join(artifacts,'scheme-popup.png'));
  await member.eval('document.getElementById("customizationInterfacePreset").focus()');
  await member.send('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End'});
  await member.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter'});
  assert.equal(await member.eval('document.documentElement.dataset.interfacePreset'),'constructivist');
  await member.send('Emulation.setDeviceMetricsOverride',{width:390,height:780,deviceScaleFactor:1,mobile:false});
  assert.equal(await member.eval('document.getElementById("customizationInterfacePreset").getBoundingClientRect().right<=innerWidth'),true);
  await member.screenshot(path.join(artifacts,'scheme-narrow.png'));
  await click(member,'customizationClose');
  assert.equal(await member.eval('document.documentElement.dataset.interfacePreset'),'industrial');
  await member.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  assert.equal(fs.readFileSync(path.join(directory,'server/server-governance.json'),'utf8'),history,'Theme save/reset must leave signed history and both interaction scopes intact');
  const memberKey=await member.eval('window.echo.getState().selfKey');assert.equal(typeof memberKey,'string');
  current=await change(owner,actor,current,{type:'setDomainOwner',domainId:'srv-main',memberKey:/** @type {string} */(memberKey)});
  await member.eval('document.querySelector("[data-server-id=srv-main]").click()');
  await member.waitFor('!!document.querySelector("[data-server-id=srv-main].active")',{timeout:3000,interval:50,label:'managed domain selected'});
  await panel(member);
  assert.equal(await member.eval('document.getElementById("customizationInteractionsTab").hidden'),true,'Domain ownership does not grant shared catalog management');
  await click(member,'customizationThemeSave');
  await member.waitFor('document.getElementById("customizationSchemeStatus").dataset.state==="saved"',{timeout:3000,interval:50,label:'domain owner local theme saved'});
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'server/server-governance.json'),'utf8')).digest,current.digest,'Even domain owners cannot publish themes through the UI');
  await click(member,'customizationClose');
  console.log(JSON.stringify({event:'local-theme-ui-passed',ordinaryMember:true,independentClients:true,reloadPersistence:true,domainNavigation:true,unsavedPreview:true,historicalThemeIgnored:true,interactionHistoryPreserved:true,screenshots:artifacts}));
} finally{
  for(const browser of browsers){const exited=browser.child.exitCode===null ? once(browser.child,'exit') : Promise.resolve();browser.page.close();await closeChrome(browser.port);if(browser.child.exitCode===null)browser.child.kill();await exited;}
  await stop(backend);
  assert.equal(path.dirname(directory),os.tmpdir());assert(path.basename(directory).startsWith('deepscord-local-theme-'));
  fs.rmSync(directory,{recursive:true,maxRetries:5,retryDelay:200});
}

