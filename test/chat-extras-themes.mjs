// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {launchChrome,connectPage,closeChrome} from './cdp.mjs';
import {launch,stop,reservePort,object,string} from './server-ws-helpers.mjs';
import {parseInterfaceScheme,parseSchemeValues} from '../public/js/interface-scheme.js';

const root=process.cwd(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-chat-themes-'));
const output=path.join(root,'output/playwright/chat-extras-themes');fs.mkdirSync(output,{recursive:true});
/** @param {string} name @returns {import('../public/js/interface-scheme.js').InterfaceSelection} */
function selection(name){
  const filename=path.join(root,'public/customization/interfaces',name+'.json');
  /** @type {import('../public/js/network-protocol.js').JsonValue} */const input=JSON.parse(fs.readFileSync(filename,'utf8'));
  const row=object(input);
  let scheme;
  if(row.files){const files=object(row.files);/** @param {string} key */const read=key=>{const target=path.resolve(path.dirname(filename),string(files[key]));assert(target.startsWith(path.dirname(filename)+path.sep));return fs.readFileSync(target,'utf8');};const {files:references,...metadata}=row;assert(references);scheme=parseInterfaceScheme({...metadata,presentation:{html:read('html'),css:read('css'),script:read('script')}});}
  else scheme=parseInterfaceScheme(input);
  return {scheme,values:parseSchemeValues(scheme,{})};
}
const backend=await launch(path.join(directory,'server'),{}),port=await reservePort(),url=backend.origin+'/?name=ThemeReader';
/** @type {import('node:child_process').ChildProcess|null} */let browser=null;
/** @type {Awaited<ReturnType<typeof connectPage>>|null} */let page=null;
/** @type {{theme:string,components:Record<string,{color:string,background:string,radius:string,width:number,height:number}>}[]} */const observations=[];
try{
  browser=(await launchChrome({port,userDataDir:path.join(directory,'chrome'),url,headless:true,windowSize:'1440,1000',extraArgs:['--disable-extensions']})).child;page=await connectPage(port,url);
  await page.waitFor('window.echo?.getState().roomReady && !!window.echo.getState().selfKey && !!window.echo.getState().chatMedia',{timeout:12000,interval:50,label:'actual theme client ready'});
  const text='```js\nconst answer = 42;\n```\nBV1xx411c7mD https://music.163.com/#/song?id=123456';
  await page.eval('window.echo.actions.sendMessage('+JSON.stringify(text)+')');
  await page.waitFor('document.getElementById("msgInput").value==="" && !document.getElementById("sendBtn").disabled',{timeout:10000,interval:25,label:'source code and links accepted'});
  const source=await page.eval('document.querySelector("#messages [data-msg-id]:last-child").dataset.msgId');assert.equal(typeof source,'string');
  const replySelector='#messages [data-msg-id="'+source+'"] [data-testid="message-reply"]';
  await page.eval('document.querySelector('+JSON.stringify(replySelector)+').click();window.echo.actions.sendMessage("引用回复 · 主题适配验证")');
  await page.waitFor('document.getElementById("msgInput").value==="" && !document.getElementById("sendBtn").disabled',{timeout:10000,interval:25,label:'reference reply accepted'});
  await page.eval('document.querySelector('+JSON.stringify(replySelector)+').click()');
  for(const theme of ['constructivist','industrial-open','constructivist-open','lanart-open']){
    await page.eval('(async()=>{const runtime=await import("/js/interface-scheme-runtime.js");runtime.applyInterfaceSelection('+JSON.stringify(selection(theme))+');})()');
    if(theme.endsWith('-open'))await page.waitFor('document.documentElement.dataset.interfacePackage==="true" && !!document.querySelector("[data-deepscord-slot=content]")',{timeout:5000,interval:25,label:theme+' mounted'});
    await page.eval('document.getElementById("messages").scrollTop=document.getElementById("messages").scrollHeight');
    const components=await page.eval('Object.fromEntries(["#replyComposer",".chat-reference",".code-copy",".chat-link-card"].map(selector=>{const node=document.querySelector(selector);if(!(node instanceof HTMLElement))throw new Error("Missing new component: "+selector);const css=getComputedStyle(node),box=node.getBoundingClientRect();if(css.display==="none"||box.width===0||box.height===0)throw new Error("Hidden new component: "+selector);return [selector,{color:css.color,background:css.backgroundColor,radius:css.borderRadius,width:box.width,height:box.height}];}))');
    observations.push({theme,components});
    if(theme.startsWith('constructivist'))for(const component of Object.values(components))assert.equal(component.radius,'0px');
    await page.screenshot(path.join(output,theme+'.png'));
  }
  fs.writeFileSync(path.join(output,'components.json'),JSON.stringify(observations,null,2));
  console.log('PASS actual message/reply composer with four production theme loaders: built-in constructivist and industrial, constructivist, lanart full packages');
}catch(error){if(page)await page.screenshot(path.join(output,'failure.png'));throw error;}
finally{await closeChrome(port);page?.close();if(browser?.exitCode===null)browser.kill();await stop(backend);assert.equal(path.dirname(directory),os.tmpdir());fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
