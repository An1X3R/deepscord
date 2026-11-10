// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {connectPage,waitForPort} from './cdp.mjs';
import {launch,stop,until,object,string} from './server-ws-helpers.mjs';
import {parseMediaMetadata} from '../public/js/chat-protocol.js';
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {Awaited<ReturnType<typeof connectPage>>} Page */
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const executable=fs.realpathSync(process.env.ELECTRON_TEST_BINARY ?? path.join(root,'node_modules/electron/dist/electron.exe'));
const main=fs.realpathSync(process.env.DESKTOP_TEST_MAIN ?? path.join(root,'desktop/main.js'));
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-personal-inline-'));
const output=path.resolve(process.env.DEEPSCORD_INLINE_OUTPUT ?? path.join(root,'output/playwright/personal-sticker-inline-native'));
fs.mkdirSync(output,{recursive:true});
const backend=await launch(path.join(temporary,'server'),{});
const data=path.join(temporary,'client');fs.mkdirSync(data);
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({serverUrl:backend.origin,autoConnect:false,trustedHosts:[]}));
fs.writeFileSync(path.join(data,'desktop-settings.json'),JSON.stringify({muteShortcut:'Control+Alt+Shift+F9',overlay:{enabled:false,locked:true,x:24,y:80,width:280,height:300,scale:1}}));
const listener=net.createServer();await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',()=>resolve(undefined));});
const address=listener.address();assert(address && typeof address!=='string');const debug=address.port;await new Promise((resolve,reject)=>listener.close(error=>error ? reject(error) : resolve(undefined)));
/** @type {NodeJS.ProcessEnv} */const environment={...process.env,DEEPSCORD_USER_DATA:data};delete environment.ELECTRON_RUN_AS_NODE;
const child=spawn(executable,[path.dirname(main),'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+debug],{cwd:root,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
let clientLog='';child.stdout.on('data',chunk=>{clientLog+=String(chunk);});child.stderr.on('data',chunk=>{clientLog+=String(chunk);});
/** @type {Page[]} */const pages=[];
/** @type {string[]} */const checks=[];
/** @type {JsonValue[]} */const events=[];
/** @param {string} label @returns {void} */function pass(label){checks.push(label);console.log('PASS '+label);}
const pickerUrl=pathToFileURL(path.join(path.dirname(main),'sticker-picker.html')).href;
/** @param {string} prefix @returns {Promise<Page>} */async function attach(prefix){const page=await connectPage(debug,prefix);pages.push(page);await page.send('Runtime.enable',{});await page.send('Network.enable',{});for(const event of ['Network.loadingFailed','Runtime.exceptionThrown','Runtime.consoleAPICalled'])page.on(event,/** @param {JsonValue} details */ details=>events.push({event,url:prefix,details}));return page;}
/** @returns {Promise<number>} */async function pickerCount(){/** @type {JsonValue} */const response=await(await fetch('http://127.0.0.1:'+debug+'/json/list')).json();assert(Array.isArray(response));return response.map(object).filter(target=>target.url===pickerUrl).length;}
/** @returns {{[key:string]:JsonValue}} */function index(){/** @type {JsonValue} */const value=JSON.parse(fs.readFileSync(path.join(data,'mods','stickers','index.json'),'utf8'));return object(value);}
/** @returns {{[key:string]:JsonValue}[]} */function items(){const entries=index().items;assert(Array.isArray(entries));return entries.map(object);}
/** Schedule a real click before its embedded target is destroyed. @param {Page} page @param {string} id @returns {Promise<void>} */async function departingClick(page,id){await page.eval('setTimeout(()=>document.getElementById('+JSON.stringify(id)+').click(),0)');}
/** @param {Page} ui @returns {Promise<Page>} */async function openPicker(ui){const heading=await ui.eval("document.getElementById('emojiPanelBtn').click();document.getElementById('stickerPanelTitle').textContent");assert.equal(heading,'个人收藏','Pending private metadata must not be presented as an empty library');const picker=await attach(pickerUrl);await picker.send('Page.bringToFront',{});await picker.waitFor("document.body.dataset.active==='true' && document.visibilityState==='visible' && !!document.getElementById('personalStickerPicker')",{timeout:15000,interval:50,label:'actual embedded private collection'});return picker;}
/** @param {Page} ui @param {Page} picker @returns {Promise<{preset:string,colors:Record<string,string>}>} */async function palette(ui,picker){
 const input=object(await ui.eval('(async()=>{const {THEME_COLORS}=await import("/js/theme-colors.js");const style=getComputedStyle(document.documentElement);return {preset:document.documentElement.dataset.interfacePreset,colors:Object.fromEntries(THEME_COLORS.map(key=>[key,style.getPropertyValue(key).trim()]))};})()'));
 const preset=string(input.preset),colors=Object.fromEntries(Object.entries(object(input.colors)).map(([key,value])=>{const color=string(value);assert(color.length>0,'Parent theme token is empty: '+key);return [key,color];}));
 const actual=await picker.eval('(()=>{const colors='+JSON.stringify(colors)+';const style=getComputedStyle(document.documentElement);return {preset:document.documentElement.dataset.interfacePreset,colors:Object.fromEntries(Object.keys(colors).map(key=>[key,style.getPropertyValue(key).trim()])),supported:Object.values(colors).every(value=>CSS.supports("color",value))};})()');
 assert.equal(actual.supported,true);assert.equal(actual.preset,preset);assert.deepEqual(actual.colors,colors);return {preset,colors};
}
/** @param {Page} ui @returns {Promise<void>} */async function closed(ui){await ui.waitFor("document.getElementById('stickerPanel').hidden",{timeout:5000,interval:50,label:'parent collection closed'});}
/** @returns {Promise<void>} */async function disposed(){assert.equal(await pickerCount(),1,'Exactly one isolated collection is retained');const picker=await attach(pickerUrl);await picker.waitFor("document.body.dataset.active==='false' && document.getElementById('personalStickerPicker').hidden",{timeout:5000,interval:25,label:'collection suspended with its DOM retained'});picker.close();}
try{
 await waitForPort(debug,20000);
 const workspace=await attach(pathToFileURL(path.join(path.dirname(main),'workspace.html')).href);
 await workspace.waitFor("document.getElementById('workspaceLoading')?.hidden===true",{timeout:12000,interval:50,label:'desktop workspace ready'});
 await workspace.eval("document.getElementById('workspaceAddBtn').click()");
 const connection=await attach(pathToFileURL(path.join(path.dirname(main),'connections.html')).href);
 await connection.waitFor("document.getElementById('connectionChoice')?.hidden===false",{timeout:10000,interval:50,label:'desktop connection chooser'});
 await connection.eval("document.getElementById('chooseJoinBtn').click();document.getElementById('serverMethodBtn').click();document.getElementById('serverUrl').value="+JSON.stringify(backend.origin)+";document.getElementById('serverConnectBtn').click()");
 const ui=await attach('http://127.0.0.1:');
 await ui.waitFor("!!document.getElementById('welcomeNameInput')",{timeout:15000,interval:50,label:'production welcome'});
 await ui.eval("document.getElementById('welcomeNameInput').value='Inline collection acceptance';document.getElementById('welcomeEnterBtn').click()");
 await ui.waitFor("window.echo?.getState().roomReady && !!window.echo.getState().selfKey && !document.querySelector('.modal-backdrop')",{timeout:15000,interval:50,label:'production chat connected'});

 const picker=await openPicker(ui);
 const initialPalette=await palette(ui,picker);
 assert.equal(await picker.eval("document.getElementById('personalStickerPickerTabpersonal').getAttribute('aria-pressed')"),'true');
 assert.equal(await picker.eval("document.querySelectorAll('[data-testid=sticker-cell]').length"),0);
 assert.equal(await ui.eval("document.querySelectorAll('[id*=PersonalOpen]').length"),0);
 await picker.screenshot(path.join(output,'private-empty.png'));
 pass('Opening the room sticker panel directly displays the embedded personal collection');
 const documentNode=await picker.send('DOM.getDocument',{});
 const fileNode=await picker.send('DOM.querySelector',{nodeId:documentNode.root.nodeId,selector:'#personalStickerPickerImportInput'});
 assert(fileNode.nodeId>0);
 await picker.send('DOM.setFileInputFiles',{nodeId:fileNode.nodeId,files:[path.join(root,'test/fixtures/avatar-96.jpg')]});
 await picker.waitFor("document.querySelectorAll('#personalStickerPickerGrid [data-testid=sticker-cell]').length===1 && !document.getElementById('personalStickerPicker').hasAttribute('aria-busy')",{timeout:20000,interval:50,label:'real JPG decoded, encoded to AVIF and stored'});
 await picker.waitFor("document.querySelector('#personalStickerPickerGrid img')?.naturalWidth>0",{timeout:10000,interval:50,label:'actual private AVIF thumbnail'});
 const item=items()[0],itemId=string(item.id),sha256=string(item.sha256);
 const asset=parseMediaMetadata(item);
 assert.equal(asset.animated,false);assert(asset.bytes>0);
 assert.equal(fs.existsSync(path.join(data,'mods','stickers',sha256+'.avif')),true);
 await picker.screenshot(path.join(output,'private-imported.png'));
 pass('The production private collection imports a real JPG, converts it to AVIF and renders the thumbnail');
 await departingClick(picker,'personalStickerPickerItem-personal-'+itemId);
 await disposed();
 await ui.waitFor("!!document.querySelector('[data-testid=chat-attachment]')",{timeout:15000,interval:50,label:'actual sticker sent to backend and rendered in chat'});
 await ui.waitFor("document.querySelector('[data-testid=chat-attachment] img')?.naturalWidth>0",{timeout:10000,interval:50,label:'sent AVIF decoded in real chat'});
 assert.equal(items()[0].useCount,1);
 await until(()=>{const filename=path.join(temporary,'server/store.json');if(!fs.existsSync(filename))return false;/** @type {JsonValue} */const value=JSON.parse(fs.readFileSync(filename,'utf8'));const history=object(object(value).messages);return Object.values(history).some(messages=>Array.isArray(messages)&&messages.some(message=>{const attachment=object(message).attachment;return attachment!==undefined&&attachment!==null&&object(attachment).sha256===sha256;}));},backend.failure,'actual backend persisted the AVIF sticker attachment');
 await ui.screenshot(path.join(output,'private-sent.png'));
 pass('Selecting the private sticker sends its verified AVIF to the real backend and increments persisted use statistics');
 const reopened=await openPicker(ui);
 await reopened.waitFor("document.querySelectorAll('#personalStickerPickerGrid [data-testid=sticker-cell]').length===1",{timeout:10000,interval:50,label:'reopened private collection retains imported sticker'});
 assert.equal(items()[0].useCount,1);
 const saved=await reopened.eval('window.stickerPicker.listPersonalStickers()');assert.equal(saved.items[0].useCount,1);
 await reopened.waitFor("document.querySelector('#personalStickerPickerGrid img')?.naturalWidth>0",{timeout:10000,interval:50,label:'reopened private thumbnail decoded'});
 const repeated=await reopened.eval(`(async()=>{const grid=document.getElementById('personalStickerPickerGrid'),image=grid.querySelector('img'),source=image.src;let changes=0;const observer=new MutationObserver(records=>{changes+=records.length;});observer.observe(grid,{childList:true,subtree:true,attributes:true,attributeFilter:['src']});for(let count=0;count<5;count++)document.getElementById('personalStickerPickerTabpersonal').click();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));observer.disconnect();return {changes,sameImage:grid.querySelector('img')===image,sameSource:image.src===source,decoded:image.naturalWidth>0};})()`);
 assert.deepEqual(repeated,{changes:0,sameImage:true,sameSource:true,decoded:true});
 pass('Reopening does not claim an empty collection; repeated personal-tab clicks retain the same decoded thumbnail without reload');

 await reopened.eval("window.retainedImage=document.querySelector('#personalStickerPickerGrid img');window.retainedSource=window.retainedImage.src;window.retainedOrigin=performance.timeOrigin");
 await reopened.send('Performance.enable',{});await reopened.send('HeapProfiler.collectGarbage',{});
 const before=await reopened.send('Memory.getDOMCounters',{}),beforeMetrics=await reopened.send('Performance.getMetrics',{});
 await reopened.send('Profiler.enable',{});await reopened.send('Profiler.startPreciseCoverage',{callCount:true,detailed:true});
 const timings=[];
 for(let round=0;round<20;round++){
   await departingClick(reopened,'personalStickerPickerTabserver');
   await reopened.waitFor("document.body.dataset.active==='false'",{timeout:5000,interval:10,label:'retained collection hidden'});
   await ui.waitFor("document.getElementById('stickerPanelTabserver').getAttribute('aria-pressed')==='true' && !document.getElementById('stickerPanel').hasAttribute('aria-busy')",{timeout:5000,interval:10,label:'server tab handoff finished'});
   const began=performance.now();await ui.eval("document.getElementById('stickerPanelTabpersonal').click()");
   await reopened.waitFor("document.body.dataset.active==='true'",{timeout:5000,interval:10,label:'same personal collection resumed'});timings.push(performance.now()-began);
   assert.equal(await reopened.eval("document.querySelector('#personalStickerPickerGrid img')===window.retainedImage && window.retainedImage.src===window.retainedSource && window.retainedImage.naturalWidth>0 && performance.timeOrigin===window.retainedOrigin"),true);
 }
 const coverage=await reopened.send('Profiler.takePreciseCoverage',{});await reopened.send('Profiler.stopPreciseCoverage',{});
 assert(coverage.result.some(script=>script.url.endsWith('/sticker-picker.js')&&script.functions.some(fn=>fn.functionName==='activate'&&fn.ranges[0].count>0)),'Coverage must capture real retained-view resume execution');
 const reloads=coverage.result.filter(script=>script.url.endsWith('/media-library.js')||script.url.endsWith('/sticker-picker.js')).flatMap(script=>script.functions.filter(fn=>['load','refresh','loadMedia'].includes(fn.functionName)).map(fn=>({name:fn.functionName,calls:fn.ranges[0].count})));
 assert.equal(reloads.reduce((sum,row)=>sum+row.calls,0),0,'Unchanged tab switching must perform zero metadata reads, image reads or decodes');
 await reopened.send('HeapProfiler.collectGarbage',{});
 const after=await reopened.send('Memory.getDOMCounters',{}),afterMetrics=await reopened.send('Performance.getMetrics',{});
 assert.equal(after.nodes,before.nodes);assert.equal(after.jsEventListeners,before.jsEventListeners);assert.equal(await pickerCount(),1);
 const metrics={rounds:20,resumeMedianMs:[...timings].sort((a,b)=>a-b)[10],resumeMaxMs:Math.max(...timings),reloads,before,after,beforeMetrics,afterMetrics};
 fs.writeFileSync(path.join(output,'retained-performance.json'),JSON.stringify(metrics,null,2));
 pass('Twenty real private/server tab round trips reuse the same view and decoded image with zero library reads and stable DOM/listener counts');
 await departingClick(reopened,'personalStickerPickerTabserver');await disposed();
 await ui.waitFor("document.getElementById('stickerPanelTabserver').getAttribute('aria-pressed')==='true'",{timeout:5000,interval:50,label:'embedded tab returns to room server catalog'});
 assert.equal(await ui.eval("document.getElementById('stickerPanel').hidden"),false);
 await ui.eval("document.getElementById('stickerPanelTabpersonal').click()");
 const closePicker=await attach(pickerUrl);await closePicker.waitFor("document.body.dataset.active==='true'",{timeout:10000,interval:50,label:'private tab reopened'});
 await departingClick(closePicker,'personalStickerPickerCloseBtn');await disposed();await closed(ui);
 const escapePicker=await openPicker(ui);
 await escapePicker.eval("setTimeout(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})),0)");await disposed();await closed(ui);
 const channelPicker=await openPicker(ui);
 const channelId=await ui.eval("window.echo.getState().servers.flatMap(server=>server.channels).find(channel=>channel.type==='text' && channel.id!==window.echo.getState().activeChannelId)?.id");
 assert.equal(typeof channelId,'string','Acceptance needs a second real text channel');
 await ui.eval('document.querySelector('+JSON.stringify('[data-channel-id="'+channelId+'"]')+').click()');await disposed();await closed(ui);channelPicker.close();
 pass('Server tab handoff, close, Escape and changing channels suspend the retained collection');
 const deletion=await openPicker(ui);
 await deletion.waitFor('!!document.getElementById('+JSON.stringify('personalStickerPickerItem-personal-'+itemId)+')',{timeout:10000,interval:50,label:'persisted private item before deletion'});
 await deletion.eval('document.getElementById('+JSON.stringify('personalStickerPickerItem-personal-'+itemId)+').dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:100,clientY:100}))');
 await deletion.eval("document.getElementById('personalStickerPickersticker-delete-personal').click()");
 await deletion.waitFor("document.querySelectorAll('#personalStickerPickerGrid [data-testid=sticker-cell]').length===0 && !document.getElementById('personalStickerPicker').hasAttribute('aria-busy')",{timeout:10000,interval:50,label:'real private item deletion'});
 assert.equal(items().length,0);assert.equal(fs.existsSync(path.join(data,'mods','stickers',sha256+'.avif')),false);
 await deletion.screenshot(path.join(output,'private-deleted.png'));
 await departingClick(deletion,'personalStickerPickerCloseBtn');await disposed();
 const finalPicker=await openPicker(ui);assert.equal(await finalPicker.eval("document.querySelectorAll('#personalStickerPickerGrid [data-testid=sticker-cell]').length"),0);
 const animatedDocument=await finalPicker.send('DOM.getDocument',{}),animatedInput=await finalPicker.send('DOM.querySelector',{nodeId:animatedDocument.root.nodeId,selector:'#personalStickerPickerImportInput'});
 await finalPicker.send('DOM.setFileInputFiles',{nodeId:animatedInput.nodeId,files:[path.join(root,'test/avif-codec-fixtures/transparent-animation.gif')]});
 await finalPicker.waitFor("document.querySelector('#personalStickerPickerGrid img')?.naturalWidth>0 && !document.getElementById('personalStickerPicker').hasAttribute('aria-busy')",{timeout:20000,interval:25,label:'actual animated AVIF import and static poster'});
 assert.equal(items()[0].animated,true);
 await finalPicker.eval("window.posterUrl=document.querySelector('#personalStickerPickerGrid img').src;document.querySelector('#personalStickerPickerGrid [data-testid=sticker-cell]').focus()");
 await finalPicker.waitFor("document.querySelector('#personalStickerPickerGrid img')?.naturalWidth>0 && document.querySelector('#personalStickerPickerGrid img').src!==window.posterUrl",{timeout:10000,interval:25,label:'real AVIF animation activated'});
 await departingClick(finalPicker,'personalStickerPickerTabserver');await disposed();
 assert.equal(await finalPicker.eval("document.querySelector('#personalStickerPickerGrid img').hasAttribute('src')"),false,'Hidden animated media is released');
 await ui.waitFor("!document.getElementById('stickerPanel').hasAttribute('aria-busy')",{timeout:5000,interval:25,label:'animated handoff'});
 await finalPicker.send('Profiler.enable',{});await finalPicker.send('Profiler.startPreciseCoverage',{callCount:true,detailed:true});
 await ui.eval("document.getElementById('stickerPanelTabpersonal').click()");
 await finalPicker.waitFor("document.body.dataset.active==='true' && document.querySelector('#personalStickerPickerGrid img')?.naturalWidth>0",{timeout:10000,interval:25,label:'cached static poster restored'});
 const posterCoverage=await finalPicker.send('Profiler.takePreciseCoverage',{});await finalPicker.send('Profiler.stopPreciseCoverage',{});
 assert.equal(posterCoverage.result.filter(script=>script.url.endsWith('/media-library.js')).flatMap(script=>script.functions.filter(fn=>fn.functionName==='load')).reduce((sum,fn)=>sum+fn.ranges[0].count,0),0,'Cached poster restoration must not read or decode AVIF again');
 pass('Real animated AVIF stops while hidden and resumes with a cached static poster without rereading the file');

 await departingClick(finalPicker,'personalStickerPickerCloseBtn');await disposed();
 pass('Deletion removes the private index entry and final local AVIF while reopening remains empty');
 await ui.eval("document.getElementById('serverMenuBtn').click();document.getElementById('themeCustomizationMenuBtn').click()");
 await ui.waitFor("!!document.getElementById('customizationInterfacePreset') && !document.getElementById('customizationThemeSave').disabled",{timeout:10000,interval:50,label:'actual packaged local theme catalog loaded'});
 await ui.eval("document.getElementById('customizationInterfacePreset').click()");
 const option=await ui.eval("document.querySelector('#customizationInterfacePresetList [data-value=constructivist-open]')?.id");assert.equal(typeof option,'string','Packaged customization catalog must contain the full constructivist theme');
 await ui.eval('document.getElementById('+JSON.stringify(option)+').click()');
 await ui.eval("document.getElementById('customizationThemeSave').click()");
 await ui.waitFor("document.getElementById('customizationSchemeStatus').dataset.state==='saved'",{timeout:10000,interval:50,label:'full constructivist theme saved through production UI'});
 await ui.eval("document.getElementById('customizationClose').click()");
 await ui.waitFor("!!document.getElementById('theme-constructivist') && document.documentElement.dataset.interfacePreset==='constructivist'",{timeout:10000,interval:50,label:'production full constructivist theme active'});
 const themedPicker=await openPicker(ui),constructivistPalette=await palette(ui,themedPicker);assert.equal(constructivistPalette.preset,'constructivist');
 await themedPicker.screenshot(path.join(output,'private-constructivist-palette.png'));await departingClick(themedPicker,'personalStickerPickerCloseBtn');await disposed();
 pass('The packaged offline collection inherits every computed color from both the standard and full constructivist parent themes');
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({checks,asset,initialPalette,constructivistPalette,provenance:{executable,main,workspaceUrl:pathToFileURL(path.join(path.dirname(main),'workspace.html')).href,pickerUrl,serverRoot:process.env.DEEPSCORD_TEST_SERVER_ROOT ?? root},privateIndex:index(),clientLog,serverLog:backend.output()},null,2));
 await ui.eval('setTimeout(()=>window.deepscord.quit(),0)');
 console.log('ARTIFACTS '+output);
}catch(error){const diagnostics=await Promise.allSettled(pages.map((page,i)=>Promise.race([(async()=>{const state=await page.eval("({url:location.href,status:document.getElementById('status')?.textContent,panelStatus:document.getElementById('personalStickerPickerStatus')?.textContent,image:[...document.querySelectorAll('#personalStickerPickerGrid img')].map(image=>({src:image.src,width:image.naturalWidth,complete:image.complete,rect:image.getBoundingClientRect().toJSON()}))})");await page.screenshot(path.join(output,'failure-'+i+'.png'));return state;})(),new Promise((resolve)=>setTimeout(()=>resolve({closedPage:i}),1000))])));fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:error instanceof Error?error.stack:String(error),checks,events,diagnostics,clientLog,serverLog:backend.output()},null,2));throw error;}
finally{for(const page of pages)page.close();if(child.exitCode===null)child.kill();await stop(backend);}
