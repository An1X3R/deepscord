// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {page,pause} from './security-cdp.mjs';
import {waitForPort} from './cdp.mjs';
import {launch,stop,reservePort,connect,authenticate,identity,send,receive,journal,change,object} from './server-ws-helpers.mjs';
import {appendGovernance} from '../lib/server-governance.cjs';
const root=process.cwd(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-governance-consent-'));
const data=path.join(directory,'client');fs.mkdirSync(data);
const backend=await launch(path.join(directory,'server'),{}),debug=await reservePort();
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({serverUrl:backend.origin,autoConnect:true,trustedHosts:[]}));
const actor=identity(),owner=await connect(backend,'Owner');await authenticate(owner,actor);
const cursor=send(owner,{t:'claimOwner',token:fs.readFileSync(path.join(directory,'server/owner-claim.txt'),'utf8').trim()});
let current=journal(await receive(owner,cursor,message=>message.t==='serverState' && object(message.policy).ownerKey===actor.key,'owner claim'));
/** @type {NodeJS.ProcessEnv} */const env={...process.env,DEEPSCORD_USER_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
const client=spawn(path.join(root,'node_modules/electron/dist/electron.exe'),[path.join(root,'desktop'),'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+debug],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='';client.stdout.on('data',chunk=>{log+=String(chunk);});client.stderr.on('data',chunk=>{log+=String(chunk);});
/** @type {Awaited<ReturnType<typeof page>>|null} */let ui=null;
try{
  await waitForPort(debug,15000);
  const workspace=await page(debug,pathToFileURL(path.join(root,'desktop/workspace.html')).href);
  await workspace.wait('!!window.deepscord?.connect');
  await workspace.evaluate('void window.deepscord.connect('+JSON.stringify(backend.origin)+').catch(error=>{window.connectionError=error.message;});');
  ui=await page(debug,'http://127.0.0.1:');workspace.close();
  await ui.wait('!!document.getElementById("welcomeNameInput")');
  await ui.evaluate('document.getElementById("welcomeNameInput").value="Permission reviewer";document.getElementById("welcomeEnterBtn").click();');
  await ui.wait('window.echo?.getState().roomReady && window.echo.getState().selfKey');
  const memberKey=await ui.evaluate('window.echo.getState().selfKey');assert(typeof memberKey==='string');
  current=await change(owner,actor,current,{type:'setDomainOwner',domainId:'srv-main',memberKey});
  await ui.wait('window.echo.getState().governanceDigest==='+JSON.stringify(current.digest));
  const command={type:'putGroup',domainId:'srv-main',groupId:'operators',name:'Operators',permissions:['manageChannels']};
  const request={journal:current,command};
  const start='window.consentOutcome="pending";void window.deepscord.signGovernanceChange('+JSON.stringify(request)+').then(value=>{window.consentOutcome=value;},error=>{window.consentOutcome={error:error.message};});';
  await ui.evaluate(start);
  const confirmation=pathToFileURL(path.join(root,'desktop/desktop-consent.html')).href;
  let dialog=await page(debug,confirmation);await dialog.wait('document.getElementById("consentAccept")?.disabled===false');
  assert.equal(await dialog.evaluate('document.getElementById("consentTitle").textContent'),'修改权限组');
  assert.equal(await ui.evaluate('window.consentOutcome'),'pending');
  await dialog.evaluate('document.getElementById("consentDeny").click()');dialog.close();
  await ui.wait('window.consentOutcome.error');
  assert.equal(await ui.evaluate('window.consentOutcome.error'),'Error invoking remote method \'workspace:governance-sign\': Error: 已取消权限修改');
  await ui.evaluate(start);dialog=await page(debug,confirmation);await dialog.wait('document.getElementById("consentAccept")?.disabled===false');
  await dialog.evaluate('document.getElementById("consentAccept").click()');dialog.close();await ui.wait('window.consentOutcome.event');
  const result=object(await ui.evaluate('window.consentOutcome'));assert(result.event);
  const applied=appendGovernance(current,/** @type {import('../lib/server-governance.cjs').GovernanceEvent} */(result.event));
  assert.equal(applied.events.at(-1)?.command.type,'putGroup');
  assert.equal(applied.events.at(-1)?.actorKey,memberKey);
  console.log('PASS native permission confirmation: deny returns no signature, accept returns verified signature');
}catch(error){fs.mkdirSync(path.join(root,'.qa-tools/results'),{recursive:true});fs.writeFileSync(path.join(root,'.qa-tools/results/governance-consent-native.log'),log);throw error;}
finally{
  ui?.close();owner.socket.close();if(client.exitCode===null){const ended=once(client,'exit');client.kill();await ended;}await stop(backend);
  await pause(200);assert(path.dirname(directory)===os.tmpdir() && path.basename(directory).startsWith('deepscord-governance-consent-'));fs.rmSync(directory,{recursive:true,force:true});
}
