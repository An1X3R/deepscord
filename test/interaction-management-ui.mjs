// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import governance from '../lib/server-governance.cjs';
import {launchChrome,connectPage,closeChrome} from './cdp.mjs';
import {identity,launch,stop,reservePort,connect,authenticate,send,receive,object,journal,change,until} from './server-ws-helpers.mjs';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-interaction-management-'));
const backend=await launch(path.join(directory,'server'),{});
/** @type {{port:number,child:import('node:child_process').ChildProcess,page:Awaited<ReturnType<typeof connectPage>>}[]} */
const browsers=[];
/** @param {string} name @returns {Promise<Awaited<ReturnType<typeof connectPage>>>} */
async function open(name){
  const port=await reservePort(),url=backend.origin+'/?name='+name;
  const {child}=await launchChrome({port,userDataDir:path.join(directory,name),url,headless:true,extraArgs:['--disable-extensions']});
  const page=await connectPage(port,url);browsers.push({port,child,page});
  await page.waitFor('window.echo?.getState().roomReady && !!window.echo.getState().selfKey',{timeout:12000,interval:50,label:'verified interaction manager'});return page;
}
/** @param {Awaited<ReturnType<typeof connectPage>>} page @param {string} id @returns {Promise<void>} */
async function click(page,id){await page.eval('(()=>{const element=document.getElementById('+JSON.stringify(id)+');if(!(element instanceof HTMLElement))throw new Error("Missing stable UI ID: '+id+'");element.click();})()');}
/** @param {Awaited<ReturnType<typeof connectPage>>} page @returns {Promise<void>} */
async function panel(page){await page.waitFor('window.echo.getState().governanceDigest==='+JSON.stringify(saved().digest),{timeout:5000,interval:50,label:'latest signed policy rendered'});await click(page,'serverMenuBtn');await click(page,'interactionCustomizationMenuBtn');await page.waitFor('!!document.querySelector("[data-testid=customization-interaction-list]")',{timeout:5000,interval:50,label:'unified interaction list'});}
/** @returns {import('../lib/server-governance.cjs').GovernanceJournal} */
function saved(){return JSON.parse(fs.readFileSync(path.join(directory,'server/server-governance.json'),'utf8'));}
try{
  const actor=identity(),connection=await connect(backend,'OriginalOwner');await authenticate(connection,actor);
  const cursor=send(connection,{t:'claimOwner',token:fs.readFileSync(path.join(directory,'server/owner-claim.txt'),'utf8').trim()});
  let current=journal(await receive(connection,cursor,message=>message.t==='serverState' && object(message.policy).ownerKey===actor.key,'claim original owner'));
  current=await change(connection,actor,current,{type:'putInteraction',domainId:null,interaction:{id:'kept-global',name:'Existing custom',thumbnail:null,model:'bomb',trajectory:'linear',sound:'none',durationMs:900}});
  const owner=await open('Owner'),local=await open('Local');
  const ownerKey=await owner.eval('window.echo.getState().selfKey'),localKey=await local.eval('window.echo.getState().selfKey');assert.equal(typeof ownerKey,'string');assert.equal(typeof localKey,'string');
  current=await change(connection,actor,current,{type:'transferOwner',memberKey:/** @type {string} */(ownerKey)});
  await owner.waitFor('window.echo.getState().ownerKey===window.echo.getState().selfKey',{timeout:5000,interval:50,label:'owner transfer verified'});
  await until(()=>saved().events.some(event=>event.command.type==='migrateServerCatalog'),backend.failure,'owner catalog initialized before any management entry');
  await panel(owner);
  assert.equal(saved().events.filter(event=>event.command.type==='migrateServerCatalog').length,1,'Verified owner initializes exactly once without opening management');
  assert.equal(saved().events.length,current.events.length+1);
  assert.equal(await owner.eval('document.querySelectorAll("[data-interaction-id]").length'),5);
  assert.equal(await owner.eval('!!document.querySelector("[data-interaction-id=kept-global]")'),true);
  assert.equal(await owner.eval('document.querySelectorAll("[id^=customizationExample-]").length'),0);
  for(const id of ['default-bomb','default-poop','playful-fist','dollar-wallet']){
    await click(owner,'customizationInteractionEdit-'+id);
    await owner.eval('document.getElementById("customizationInteractionName").value='+JSON.stringify('Edited '+id));
    await click(owner,'customizationInteractionSave');
    await owner.waitFor('!!document.querySelector("[data-testid=customization-interaction-list]") && document.getElementById("customizationStatus").dataset.state==="saved"',{timeout:5000,interval:50,label:'signed default edit '+id});
  }
  await click(owner,'customizationInteractionDelete-default-poop');
  await owner.waitFor('!document.querySelector("[data-interaction-id=default-poop]")',{timeout:5000,interval:50,label:'signed default deletion'});
  const deletedDigest=saved().digest;
  await click(owner,'customizationClose');await panel(owner);
  assert.equal(saved().digest,deletedDigest,'Reopening management must not initialize again');
  assert.equal(await owner.eval('!!document.querySelector("[data-interaction-id=default-poop]")'),false);
  await click(owner,'customizationClose');
  await click(owner,'serverMenuBtn');await click(owner,'serverGovernanceMenuBtn');
  await owner.waitFor('!!document.getElementById("governanceMemberSelect")',{timeout:5000,interval:50,label:'owner role management'});
  await owner.eval('document.getElementById("governanceMemberSelect").value='+JSON.stringify(localKey)+';document.getElementById("governanceMemberSelect").dispatchEvent(new Event("change"));document.getElementById("governanceRoleSelect").value="domain-owner";document.getElementById("governanceRoleSelect").dispatchEvent(new Event("change"));');
  await click(owner,'saveMemberPermissionsBtn');
  await owner.waitFor('!document.getElementById("serverGovernancePanel")',{timeout:5000,interval:50,label:'domain owner assignment'});
  await local.waitFor('document.getElementById("serverName").title!==""',{timeout:3000,interval:50,label:'member policy update'});
  await click(local,'serverMenuBtn');
  assert.equal(await local.eval('!!document.getElementById("interactionCustomizationMenuBtn")'),false,'Domain owner cannot manage the shared catalog');
  await local.eval('document.body.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');
  await click(owner,'serverMenuBtn');await click(owner,'serverGovernanceMenuBtn');
  await owner.waitFor('!!document.getElementById("governanceMemberSelect")',{timeout:5000,interval:50,label:'server administrator role management'});
  await owner.eval('document.getElementById("governanceMemberSelect").value='+JSON.stringify(localKey)+';document.getElementById("governanceMemberSelect").dispatchEvent(new Event("change"));document.getElementById("governanceRoleSelect").value="server-admin";document.getElementById("governanceRoleSelect").dispatchEvent(new Event("change"));');
  await click(owner,'saveMemberPermissionsBtn');
  await owner.waitFor('!document.getElementById("serverGovernancePanel")',{timeout:5000,interval:50,label:'server administrator assignment'});
  await local.waitFor('window.echo.getState().roomReady',{timeout:3000,interval:50,label:'administrator policy update'});
  await panel(local);
  assert.equal(await local.eval('!!document.getElementById("customizationScope")'),false,'No domain scope selector remains');
  await local.waitFor('document.getElementById("customizationInteractionDrafts").textContent.includes("Windows 桌面客户端")',{timeout:5000,interval:50,label:'browser explicitly reports native directory requirement'});
  await click(local,'customizationInteractionAdd');
  await local.waitFor('document.getElementById("customizationStatus").dataset.state==="error"',{timeout:5000,interval:50,label:'add requires the actual native directory bridge'});
  assert.equal(await local.eval('!!document.getElementById("customizationInteractionForm")'),false,'New button never opens the old creation form');
  await click(local,'customizationInteractionEdit-default-bomb');
  await local.eval('document.getElementById("customizationInteractionName").value="Server admin bomb";');
  await click(local,'customizationInteractionSave');
  await local.waitFor('!!document.querySelector("[data-testid=customization-interaction-list]") && document.getElementById("customizationStatus").dataset.state==="saved"',{timeout:5000,interval:50,label:'administrator edits shared catalog'});
  const policy=governance.governanceState(saved());
  assert.equal(policy.customization?.find(scope=>scope.domainId===null)?.interactions.find(entry=>entry.id==='default-bomb')?.name,'Server admin bomb');
  assert.equal(policy.interactionCatalogVersion,2);
  assert.equal(saved().events.filter(event=>event.command.type==='migrateServerCatalog').length,1);
  console.log('PASS: owner automatic migration, editable shared defaults, permanent deletion, domain owner denial, server admin edit and explicit desktop directory requirement');
}finally{
  for(const entry of browsers){entry.page.close();await closeChrome(entry.port);if(entry.child.exitCode===null)entry.child.kill();}
  await stop(backend);assert.equal(path.dirname(directory),os.tmpdir());assert(path.basename(directory).startsWith('deepscord-interaction-management-'));fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
