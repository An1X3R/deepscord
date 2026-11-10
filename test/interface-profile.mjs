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
const output=fs.mkdtempSync(path.join(root,'.qa-tools/interface-profile-'));
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
let passed=false;
try{
  let ready=false;
  for(let attempt=0;attempt<100;attempt+=1){try{ready=(await fetch(origin+'/api/health')).ok;}catch(error){if(!(error instanceof TypeError))throw error;}if(ready)break;await delay(100);}
  assert(ready,serverLog);
  browser=await launchChrome({port:debug,userDataDir:path.join(output,'profile'),url:'about:blank',windowSize:'1440,1000'});
  page=await connectPage(debug,'about:blank');
  await page.send('Page.enable');await page.send('Runtime.enable');
  await page.send('Page.addScriptToEvaluateOnNewDocument',{source:"localStorage.setItem('echo.settings',JSON.stringify({name:'界面验收',sounds:false,membersOpen:true}));"});
  await page.send('Page.navigate',{url:origin});
  await page.waitFor("window.echo?.getState().connStatus==='open' && !!document.getElementById('interfaceChannelIndex')",{timeout:15000,interval:100,label:'Real app connected'});
  await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await page.eval("(async()=>{window.interfaceTestModule=await import('./js/interface-profile.js');window.interfaceOriginalNodes=['app','voiceStage','stageGrid','audioSinks','chat','selfPanel'].map(id=>document.getElementById(id));return true;})()");
  check('industrial baseline has stationary rail',await page.eval("document.documentElement.dataset.interfacePreset==='industrial' && getComputedStyle(document.getElementById('serverRail')).flexDirection==='column'"));
  await page.screenshot(path.join(output,'industrial-wide.png'));
  await page.eval("document.getElementById('serverMenuBtn').click();true");
  await page.eval("document.getElementById('themeCustomizationMenuBtn').click();true");
  await page.waitFor("!!document.querySelector('#customizationInterfacePresetList [data-value=constructivist]')&&!document.getElementById('customizationThemeSave').disabled",{timeout:5000,interval:50,label:'Local interface settings'});
  await page.eval("document.getElementById('customizationInterfacePreset').click();document.querySelector('#customizationInterfacePresetList [data-value=constructivist]').click();document.getElementById('customizationThemeSave').click();true");
  await page.waitFor("window.echo.getState().settings.interfaceProfile.preset==='constructivist'",{timeout:5000,interval:50,label:'Persist local profile'});
  await page.eval("document.getElementById('customizationClose').click();true");
  await delay(350);
  check('constructivist has horizontal domains and hidden index',await page.eval("getComputedStyle(document.getElementById('serverRail')).flexDirection==='row' && getComputedStyle(document.querySelector('.sidebar')).visibility==='hidden' && !document.getElementById('interfaceChannelIndex').hidden"));
  await page.screenshot(path.join(output,'constructivist-wide.png'));
  await page.eval("document.getElementById('interfaceChannelIndex').click();true");
  check('index disclosure opens and focuses channel',await page.eval("document.getElementById('interfaceChannelIndex').getAttribute('aria-expanded')==='true' && document.activeElement.matches('[data-channel-id]')"));
  await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
  check('channel index supports arrow navigation',await page.eval("document.activeElement.matches('[data-channel-id]')"));
  await delay(270);
  await page.screenshot(path.join(output,'constructivist-index.png'));
  await page.eval("document.querySelector('[data-channel-type=voice]').click();true");
  check('index selects an actual voice channel',await page.eval("document.getElementById('voiceStage').hidden===false"));
  await page.screenshot(path.join(output,'constructivist-voice.png'));
  await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  check('Escape closes index and restores trigger focus',await page.eval("document.activeElement.id==='interfaceChannelIndex' && document.documentElement.dataset.interfaceIndexOpen==='false'"));
  await delay(330);
  await page.screenshot(path.join(output,'constructivist-voice-closed.png'));
  await page.eval("for(let n=0;n<24;n+=1)window.interfaceTestModule.applyInterfaceProfile(window.interfaceTestModule.INTERFACE_PRESETS[n%2?'constructivist':'industrial']);true");
  check('rapid profile replacement leaves only one header animation',await page.eval("document.getAnimations().filter(a=>a.effect?.target?.id==='topbarName').length<=1"));
  await page.eval("document.getAnimations().filter(a=>a.effect?.target?.id==='topbarName').forEach(a=>{a.pause();a.currentTime=140;});true");
  await page.screenshot(path.join(output,'constructivist-motion-midpoint.png'));
  await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await delay(100);
  check('system reduced motion cancels active header motion',await page.eval("document.documentElement.dataset.interfaceReduced==='true' && document.getAnimations().filter(a=>a.effect?.target?.id==='topbarName').length===0"));
  for(const preset of ['industrial','constructivist']){
    await page.eval(`window.interfaceTestModule.applyInterfaceProfile(window.interfaceTestModule.INTERFACE_PRESETS.${preset});true`);
    await page.send('Emulation.setDeviceMetricsOverride',{width:640,height:900,deviceScaleFactor:1,mobile:false});await delay(120);
    check(preset+' narrow has no horizontal overflow',await page.eval("document.documentElement.scrollWidth===innerWidth && document.querySelector('.app').getBoundingClientRect().right<=innerWidth"));
    check(preset+' narrow retains visible self controls',await page.eval("(()=>{const r=document.getElementById('selfPanel').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&getComputedStyle(document.getElementById('selfPanel')).visibility==='visible';})()"));
    await page.eval("document.getElementById('interfaceChannelIndex').click();true");
    check(preset+' narrow index stays within viewport',await page.eval("(()=>{const r=document.querySelector('.sidebar').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<innerHeight;})()"));
    await page.screenshot(path.join(output,preset+'-narrow.png'));
    await page.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true");
  }
  await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await page.eval("window.interfaceTestModule.applyInterfaceProfile(window.interfaceTestModule.INTERFACE_PRESETS.industrial);true");
  await page.screenshot(path.join(output,'industrial-voice.png'));
  check('profile switches preserve communication nodes',await page.eval("window.interfaceOriginalNodes.every(node=>node===document.getElementById(node.id))"));
  await page.eval("(async()=>{window.interfaceThemeModule=await import('./js/customization-theme.js');return true;})()");
  for(const preset of ['industrial','constructivist']){
    await page.eval(`window.interfaceTestModule.applyInterfaceProfile(window.interfaceTestModule.INTERFACE_PRESETS.${preset});window.interfaceThemeModule.applyCustomizationTheme({accent:'#d1b04f',background:'charcoal',density:'comfortable',corners:'soft'});true`);
    check(preset+' soft controls have real rounded geometry',await page.eval("getComputedStyle(document.getElementById('interfaceChannelIndex')).borderRadius==='12px' && getComputedStyle(document.getElementById('sendBtn')).borderRadius==='12px'"));
    if(preset==='industrial')check('industrial brand and stage border follow edited accent',await page.eval("getComputedStyle(document.querySelector('.rail-brand')).backgroundColor==='rgb(209, 176, 79)' && getComputedStyle(document.getElementById('voiceStage')).borderLeftColor==='rgb(209, 176, 79)'"));
    await page.screenshot(path.join(output,preset+'-soft-controls.png'));
    await page.eval("window.interfaceThemeModule.applyCustomizationTheme({accent:'#d1b04f',background:'charcoal',density:'comfortable',corners:'square'});true");
    check(preset+' square controls change geometry back',await page.eval("getComputedStyle(document.getElementById('sendBtn')).borderRadius!=='12px'"));
  }
  check('profiles reject executable and malformed customization',await page.eval("(()=>{const m=window.interfaceTestModule;let rejected=0;for(const value of [{...m.INTERFACE_PRESETS.industrial,version:2},{...m.INTERFACE_PRESETS.industrial,preset:'remote'},{...m.INTERFACE_PRESETS.industrial,motion:'loop'}]){try{m.parseInterfaceProfile(value);}catch(error){if(error instanceof TypeError)rejected+=1;else throw error;}}return rejected===3&&!('script' in m.parseInterfaceProfile({...m.INTERFACE_PRESETS.industrial,script:'alert(1)'}));})()"));
  passed=true;
}finally{
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed,checks,serverLog},null,2));
  if(page)page.close();if(browser)await closeChrome(debug);child.kill();
}
console.log(JSON.stringify({event:'interface-profile-ui-passed',output,checks:checks.length}));
