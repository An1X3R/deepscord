// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {launchChrome,closeChrome,connectPage} from './cdp.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const output=fs.mkdtempSync(path.join(root,'.qa-tools/interface-transfer-'));
/** @type {string[]} */const checks=[];
/** @param {number} milliseconds @returns {Promise<void>} */
function delay(milliseconds){return new Promise(resolve=>setTimeout(resolve,milliseconds));}
/** @returns {Promise<number>} */
async function freePort(){const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address==='object');server.close();await once(server,'close');return address.port;}
/** @param {string} label @param {boolean} result @returns {void} */
function check(label,result){assert(result,label);checks.push(label);}
const port=await freePort(),debug=await freePort(),origin=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),HTTP_HOST:'127.0.0.1',HTTPS_PORTS:'0',ECHO_DATA_DIR:path.join(output,'data'),ECHO_PASSWORD:'',ECHO_NETWORK_MODE:'server',ECHO_MEDIA_POLICY:'direct'},stdio:['ignore','pipe','pipe'],windowsHide:true});
let serverLog='';child.stdout.on('data',chunk=>{serverLog+=String(chunk);});child.stderr.on('data',chunk=>{serverLog+=String(chunk);});
/** @type {Awaited<ReturnType<typeof connectPage>>|null} */let page=null;
/** @type {ReturnType<typeof launchChrome> extends Promise<infer T>?T|null:never} */let browser=null;
const secondDebug=await freePort();
/** @type {Awaited<ReturnType<typeof connectPage>>|null} */let secondPage=null;
/** @type {Awaited<ReturnType<typeof launchChrome>>|null} */let secondBrowser=null;
let passed=false;
try{
  let ready=false;
  for(let attempt=0;attempt<100;attempt+=1){try{ready=(await fetch(origin+'/api/health')).ok;}catch(error){if(!(error instanceof TypeError))throw error;}if(ready)break;await delay(100);}
  assert(ready,serverLog);
  const downloads=path.join(output,'downloads');fs.mkdirSync(downloads);
  browser=await launchChrome({port:debug,userDataDir:path.join(output,'source'),url:'about:blank',windowSize:'1440,1000'});
  page=await connectPage(debug,'about:blank');await page.send('Page.enable');await page.send('Runtime.enable');
  await page.send('Page.addScriptToEvaluateOnNewDocument',{source:"if(!localStorage.getItem('echo.settings'))localStorage.setItem('echo.settings',JSON.stringify({name:'界面源客户端',sounds:false}));"});
  await page.send('Page.navigate',{url:origin});
  await page.waitFor("window.echo?.getState().connStatus==='open' && !!window.echo.getState().selfKey",{timeout:15000,interval:100,label:'Source connected'});
  await page.eval("(async()=>{await window.echo.actions.openSettings();document.getElementById('themeCustomizationMenuBtn').click();return true;})()");
  await page.waitFor("!!document.getElementById('customizationInterfacePreset')",{timeout:5000,interval:50,label:'Source interface panel'});
  check('industrial palette controls are editable',await page.eval("!document.getElementById('customizationAccent').disabled&&!document.getElementById('customizationBackground').disabled"));
  await page.eval("(()=>{for(const [id,value]of [['customizationAccent','#55aaff'],['customizationBackground','slate'],['customizationDensity','compact'],['customizationCorners','soft']]){const element=document.getElementById(id);element.value=value;element.dispatchEvent(new Event('change'));}const preset=document.getElementById('customizationInterfacePreset');preset.value='constructivist';preset.dispatchEvent(new Event('change'));for(const[id,value]of [['customizationInterfaceMotion','reduced'],['customizationInterfaceNavigation','rail'],['customizationInterfaceMembers','expanded']]){const element=document.getElementById(id);element.value=value;element.dispatchEvent(new Event('change'));}return true;})()");
  check('constructivist disables palette and displays explanation',await page.eval("document.getElementById('customizationAccent').disabled&&document.getElementById('customizationBackground').disabled&&[...document.querySelectorAll('.customization-description')].some(element=>!element.hidden&&element.textContent.includes('固定的纸色'))"));
  await page.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  await page.eval("document.getElementById('customizationInterfaceExport').click();true");
  let exportPath='';
  for(let attempt=0;attempt<100;attempt+=1){const names=fs.readdirSync(downloads).filter(name=>name.endsWith('.json'));if(names.length===1){exportPath=path.join(downloads,names[0]);break;}await delay(50);}
  assert(exportPath,'Actual export button did not create a JSON download');
  const exported=JSON.parse(fs.readFileSync(exportPath,'utf-8'));
  const expected={version:1,theme:{accent:'#55aaff',background:'slate',density:'compact',corners:'soft'},interfaceProfile:{version:1,preset:'constructivist',motion:'reduced',navigation:'rail',memberPanel:'expanded'}};
  check('actual download contains complete theme and profile',JSON.stringify(exported)===JSON.stringify(expected));
  await page.eval("(()=>{const preset=document.getElementById('customizationInterfacePreset');preset.value='industrial';preset.dispatchEvent(new Event('change'));return true;})()");
  check('industrial restores editable palette controls',await page.eval("!document.getElementById('customizationAccent').disabled&&!document.getElementById('customizationBackground').disabled"));
  await page.eval("document.getElementById('customizationThemeSave').click();true");
  await page.waitFor("window.echo.getState().settings.interfaceProfile.preset==='industrial'",{timeout:5000,interval:50,label:'Source retained industrial profile'});
  const sourceBefore=await page.eval("JSON.stringify({theme:window.echo.getState().settings.localTheme,interfaceProfile:window.echo.getState().settings.interfaceProfile})");
  await page.eval("document.getElementById('customizationClose').click();true");
  secondBrowser=await launchChrome({port:secondDebug,userDataDir:path.join(output,'destination'),url:'about:blank',windowSize:'1440,1000'});
  secondPage=await connectPage(secondDebug,'about:blank');await secondPage.send('Page.enable');await secondPage.send('Runtime.enable');
  await secondPage.send('Page.addScriptToEvaluateOnNewDocument',{source:"if(!localStorage.getItem('echo.settings'))localStorage.setItem('echo.settings',JSON.stringify({name:'界面目标客户端',sounds:false}));"});
  await secondPage.send('Page.navigate',{url:origin});
  await secondPage.waitFor("window.echo?.getState().connStatus==='open' && !!window.echo.getState().selfKey",{timeout:15000,interval:100,label:'Destination connected'});
  await secondPage.eval("(async()=>{await window.echo.actions.openSettings();document.getElementById('themeCustomizationMenuBtn').click();return true;})()");
  await secondPage.waitFor("!!document.getElementById('customizationInterfaceImport')",{timeout:5000,interval:50,label:'Destination file input'});
  const documentNode=await secondPage.send('DOM.getDocument');
  const inputNode=await secondPage.send('DOM.querySelector',{nodeId:documentNode.root.nodeId,selector:'#customizationInterfaceImport'});
  await secondPage.send('DOM.setFileInputFiles',{nodeId:inputNode.nodeId,files:[exportPath]});
  await secondPage.waitFor("document.getElementById('customizationInterfacePreset').value==='constructivist' && !document.getElementById('customizationThemeSave').disabled",{timeout:5000,interval:50,label:'Actual file input parsed'});
  check('import preview restores all five profile fields',await secondPage.eval("document.getElementById('customizationInterfaceMotion').value==='reduced'&&document.getElementById('customizationInterfaceNavigation').value==='rail'&&document.getElementById('customizationInterfaceMembers').value==='expanded'&&document.getElementById('customizationAccent').value==='#55aaff'&&document.getElementById('customizationBackground').value==='slate'&&document.getElementById('customizationDensity').value==='compact'&&document.getElementById('customizationCorners').value==='soft'"));
  await secondPage.eval("document.getElementById('customizationThemeSave').click();true");
  await secondPage.waitFor("window.echo.getState().settings.interfaceProfile.preset==='constructivist'",{timeout:5000,interval:50,label:'Imported profile saved'});
  await secondPage.eval("document.getElementById('customizationClose').click();true");
  await secondPage.eval("window.interfaceTransferReloading=true;true");
  await secondPage.send('Page.reload');
  await secondPage.waitFor("!window.interfaceTransferReloading&&window.echo?.getState().connStatus==='open'&&document.documentElement.dataset.interfacePreset==='constructivist'",{timeout:15000,interval:100,label:'Imported settings survive reload'});
  const destination=await secondPage.eval("({version:1,theme:window.echo.getState().settings.localTheme,interfaceProfile:window.echo.getState().settings.interfaceProfile})");
  check('complete imported profile and theme persist through reload',JSON.stringify(destination)===JSON.stringify(expected));
  check('other client retains original local settings',sourceBefore===await page.eval("JSON.stringify({theme:window.echo.getState().settings.localTheme,interfaceProfile:window.echo.getState().settings.interfaceProfile})"));
  await secondPage.screenshot(path.join(output,'imported-after-reload.png'));
  await page.screenshot(path.join(output,'source-unchanged.png'));
  passed=true;
}finally{
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed,checks,serverLog},null,2));
  if(page)page.close();if(secondPage)secondPage.close();if(browser)await closeChrome(debug);if(secondBrowser)await closeChrome(secondDebug);child.kill();
}
console.log(JSON.stringify({event:'interface-transfer-ui-passed',output,checks:checks.length}));
