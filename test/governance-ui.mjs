// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchChrome, connectPage, closeChrome } from './cdp.mjs';
import { identity, launch, stop, reservePort, connect, authenticate, receive, send, object } from './server-ws-helpers.mjs';
import {parseGovernanceCommand} from '../public/js/server-governance-ui.js';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-governance-ui-'));
const backend=await launch(path.join(directory,'server'),{});
/** @type {{port:number,child:import('node:child_process').ChildProcess,page:Awaited<ReturnType<typeof connectPage>>}[]} */
const browsers=[];
/** @param {string} name @returns {Promise<Awaited<ReturnType<typeof connectPage>>>} */
async function open(name){
  const port=await reservePort(),url=backend.origin+'/?name='+name;
  const {child}=await launchChrome({port,userDataDir:path.join(directory,name),url,headless:true,extraArgs:['--disable-extensions']});
  const page=await connectPage(port,url);browsers.push({port,child,page});
  await page.waitFor('window.echo?.getState().roomReady && !!window.echo.getState().selfKey',{timeout:12000,interval:50,label:'verified member connected'});return page;
}
/** @param {Awaited<ReturnType<typeof connectPage>>} page @param {string} id @returns {Promise<void>} */
async function click(page,id){await page.eval('(()=>{const target=document.getElementById('+JSON.stringify(id)+');if(!(target instanceof HTMLElement))throw new Error("Missing stable UI ID: '+id+'");target.click();})()');}
/** @param {Awaited<ReturnType<typeof connectPage>>} page @returns {Promise<void>} */
async function panel(page){await click(page,'serverName');await click(page,'serverGovernanceMenuBtn');await page.waitFor('!!document.getElementById("serverGovernancePanel")',{timeout:3000,interval:50,label:'governance panel'});}
/** @returns {import('../lib/server-governance.cjs').GovernanceJournal} */
function saved(){return JSON.parse(fs.readFileSync(path.join(directory,'server/server-governance.json'),'utf8'));}
/** @param {Awaited<ReturnType<typeof connectPage>>} page @returns {Promise<string[]>} */
async function choices(page){return page.eval('[...document.getElementById("governanceMemberSelect").options].map(option=>option.value)');}
/** @param {Awaited<ReturnType<typeof connectPage>>} page @returns {Promise<string[]>} */
async function roleChoices(page){return page.eval('[...document.getElementById("governanceRoleSelect").options].map(option=>option.value)');}
/** @param {Awaited<ReturnType<typeof connectPage>>} page @param {import('../lib/server-governance.cjs').MemberAccessCommand} command @returns {Promise<void>} */
async function saveAccess(page,command){
  const count=saved().events.length;
  await click(page,'saveMemberPermissionsBtn');
  await page.waitFor('!document.getElementById("serverGovernancePanel")',{timeout:5000,interval:50,label:'atomic member access confirmed'});
  const journal=saved();assert.equal(journal.events.length,count+1,'One unified save must append exactly one signed event');assert.deepEqual(journal.events.at(-1)?.command,command);
}
try{
  const actor=identity(),connection=await connect(backend,'Regular');await authenticate(connection,actor);
  const owner=await open('Owner'),admin=await open('Admin'),domainOwner=await open('DomainOwner');
  const ownerKey=await owner.eval('window.echo.getState().selfKey'),adminKey=await admin.eval('window.echo.getState().selfKey'),domainKey=await domainOwner.eval('window.echo.getState().selfKey');
  assert.equal(typeof ownerKey,'string');assert.equal(typeof adminKey,'string');assert.equal(typeof domainKey,'string');
  await panel(owner);
  await owner.eval('document.getElementById("ownerClaimToken").value='+JSON.stringify(fs.readFileSync(path.join(directory,'server/owner-claim.txt'),'utf8').trim()));
  await click(owner,'claimOwnerBtn');
  await owner.waitFor('window.echo.getState().ownerKey===window.echo.getState().selfKey',{timeout:5000,interval:50,label:'owner claimed'});
  await panel(owner);assert(!(await choices(owner)).includes(/** @type {string} */(ownerKey)));
  assert.deepEqual(await roleChoices(owner),['member','domain-admin','domain-owner','server-admin']);
  await owner.eval('document.getElementById("governanceMemberSelect").value='+JSON.stringify(adminKey)+';document.getElementById("governanceMemberSelect").dispatchEvent(new Event("change"));document.getElementById("governanceRoleSelect").value="server-admin";document.getElementById("governanceRoleSelect").dispatchEvent(new Event("change"));');
  await saveAccess(owner,{type:'setMemberAccess',domainId:'srv-main',memberKey:/** @type {string} */(adminKey),role:'server-admin',groupIds:[]});
  await panel(admin);
  assert.deepEqual(await roleChoices(admin),['member','domain-admin','domain-owner']);
  const adminChoices=await choices(admin);assert(!adminChoices.includes(/** @type {string} */(ownerKey)));assert(!adminChoices.includes(/** @type {string} */(adminKey)));
  await admin.eval('document.getElementById("governanceMemberSelect").value='+JSON.stringify(domainKey)+';document.getElementById("governanceMemberSelect").dispatchEvent(new Event("change"));document.getElementById("governanceRoleSelect").value="domain-owner";document.getElementById("governanceRoleSelect").dispatchEvent(new Event("change"));');
  await saveAccess(admin,{type:'setMemberAccess',domainId:'srv-main',memberKey:/** @type {string} */(domainKey),role:'domain-owner',groupIds:[]});
  await panel(domainOwner);
  assert.deepEqual(await roleChoices(domainOwner),['member','domain-admin']);
  assert.deepEqual(await choices(domainOwner),[actor.key],'Domain owner may only select the regular member');
  await domainOwner.eval('document.getElementById("governanceGroupName").value="Builders";document.getElementById("governanceGroupTitle").value="Rail Engineer";document.getElementById("grant-manageChannels").checked=true;');
  await click(domainOwner,'saveGovernanceGroupBtn');
  await domainOwner.waitFor('!document.getElementById("serverGovernancePanel")',{timeout:5000,interval:50,label:'group title saved'});
  const groupCommand=saved().events.at(-1)?.command;assert.equal(groupCommand?.type,'putGroup');assert(groupCommand?.type==='putGroup');assert.equal(groupCommand.title,'Rail Engineer');
  await panel(domainOwner);
  await domainOwner.eval('document.getElementById("governanceMemberSelect").value='+JSON.stringify(actor.key)+';document.getElementById("governanceMemberSelect").dispatchEvent(new Event("change"));document.getElementById("governanceRoleSelect").value="domain-admin";document.getElementById("governanceRoleSelect").dispatchEvent(new Event("change"));document.getElementById('+JSON.stringify('member-group-'+groupCommand.groupId)+').checked=true;');
  await domainOwner.waitFor('getComputedStyle(document.getElementById("serverGovernancePanel").closest(".modal-backdrop")).opacity==="1"',{timeout:3000,interval:50,label:'member permissions dialog fully visible before screenshot'});
  await domainOwner.screenshot(path.resolve('.qa-tools/results/member-permissions-20261108.png'));
  await saveAccess(domainOwner,{type:'setMemberAccess',domainId:'srv-main',memberKey:actor.key,role:'domain-admin',groupIds:[groupCommand.groupId]});
  const policy=(await receive(connection,0,message=>message.t==='serverState' && object(message.journal).digest===saved().digest,'latest signed combined access policy')).policy;
  const titles=await domainOwner.eval('(async()=>{const {memberTitles}=await import("/js/member-permissions.js");return memberTitles('+JSON.stringify(policy)+','+JSON.stringify(actor.key)+',"srv-main");})()');
  assert.deepEqual(titles,['域管理员','Rail Engineer']);
  const cursor=send(connection,{t:'chat',channelId:'ch-chat',text:'Unified access title acceptance',requestId:'unified-title-acceptance'});
  const response=await receive(connection,cursor,message=>message.t==='chatResult' && message.requestId==='unified-title-acceptance','real chat title acceptance');assert.equal(response.ok,true);
  const message=object(object(response.result).message);assert.equal(typeof message.id,'string');
  const badgeExpression='[...document.querySelectorAll('+JSON.stringify('[data-msg-id="'+message.id+'"] .msg-author-title')+')].map(node=>node.textContent)';
  await domainOwner.waitFor('JSON.stringify('+badgeExpression+')==='+JSON.stringify(JSON.stringify(['域管理员','Rail Engineer'])),{timeout:5000,interval:50,label:'combined role and group badges on real chat author'});
  const legacy={type:'putGroup',domainId:'srv-main',groupId:'legacy',name:'Old',permissions:['manageChannels']};
  assert.deepEqual(parseGovernanceCommand(legacy),legacy,'Legacy signed command must not receive a new optional title');
  assert.throws(()=>parseGovernanceCommand({...legacy,title:'x'.repeat(25)}),TypeError);
  console.log(JSON.stringify({event:'governance-ui-passed',serverAdminAppointment:true,domainOwnerAppointment:true,strictMemberFiltering:true,actorFilteredRoleChoices:true,atomicMemberSaves:true,combinedChatTitles:true,groupTitle:true,signedHistoryCompatibility:true}));
} finally{
  for(const browser of browsers){browser.page.close();await closeChrome(browser.port);if(browser.child.exitCode===null)browser.child.kill();}
  await stop(backend);
  assert.equal(path.dirname(directory),os.tmpdir());assert(path.basename(directory).startsWith('deepscord-governance-ui-'));
  fs.rmSync(directory,{recursive:true,maxRetries:5,retryDelay:200});
}
