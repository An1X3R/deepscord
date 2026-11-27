// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {parseInterfaceScheme,parseInterfaceSelection} from '../public/js/interface-scheme.js';
const require=createRequire(import.meta.url);
const {createCustomizationStore}=/** @type {typeof import('../desktop/customization-store.cjs')} */(require('../desktop/customization-store.cjs'));
const bundled=fileURLToPath(new URL('../public/customization/',import.meta.url));
const original=JSON.parse(fs.readFileSync(path.join(bundled,'interfaces/industrial.json'),'utf8'));
const presentation={html:'<main>Theme</main>',css:'main { color: red; }',script:'window.example = 1;'};
const inline=parseInterfaceScheme({...original,presentation:{...presentation,extra:'strip'}});
assert.deepEqual(inline.presentation,presentation);
assert.deepEqual(parseInterfaceSelection({scheme:inline,values:{}}).scheme.presentation,presentation);
for(const invalid of [null,{}, {...presentation,script:1},{html:presentation.html,css:presentation.css}])assert.throws(()=>parseInterfaceScheme({...original,presentation:invalid}),TypeError);
for(const field of ['html','css','script'])assert.throws(()=>parseInterfaceScheme({...original,presentation:{...presentation,[field]:'x'.repeat(128*1024+1)}}),/128 KiB/);
assert.throws(()=>parseInterfaceScheme({...original,presentation:{...presentation,html:'界'.repeat(44000)}}),/128 KiB/,'String budgets must count UTF-8 bytes');
assert.throws(()=>parseInterfaceScheme({...original,presentation:{html:'\u0000'.repeat(100000),css:'',script:''}}),/512 KiB/,'Escaped JSON snapshots must respect their own aggregate budget');
assert.throws(()=>parseInterfaceScheme({...original,files:{html:'a.html',css:'a.css',script:'a.js'}}),/local directory loader/);
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-interface-package-'));
try{
  const store=createCustomizationStore(path.join(temporary,'customization'),bundled),initial=store.listInterfaceSchemes();
  assert.equal(initial.schemes.length,5);
  for(const id of ['industrial-open','constructivist-open','lanart-open']){
    const scheme=initial.schemes.find(entry=>entry.id===id);assert(scheme?.presentation?.html&&scheme.presentation.css&&scheme.presentation.script);
    assert.equal(Object.hasOwn(scheme,'files'),false,'Disk paths must not enter a runtime snapshot');
  }
  const manifestFile=path.join(initial.directory,'package-test.json'),assets=path.join(initial.directory,'test-assets');fs.mkdirSync(assets);
  for(const [name,value] of Object.entries({html:presentation.html,css:presentation.css,js:presentation.script}))fs.writeFileSync(path.join(assets,'entry.'+name),value);
  const files={html:'test-assets/entry.html',css:'test-assets/entry.css',script:'test-assets/entry.js'};
  const manifest={...original,id:'package-test',files};
  fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  const snapshot=store.listInterfaceSchemes().schemes.find(entry=>entry.id==='package-test');assert.deepEqual(snapshot?.presentation,presentation);
  fs.writeFileSync(path.join(assets,'entry.css'),'main { color: blue; }');
  assert.equal(snapshot?.presentation?.css,presentation.css,'An existing snapshot must not mutate when source files change');
  assert.equal(store.listInterfaceSchemes().schemes.find(entry=>entry.id==='package-test')?.presentation?.css,'main { color: blue; }');
  for(const html of ['../outside.html','/outside.html','C:\\outside.html','test-assets/../entry.html','test-assets//entry.html','test-assets/entry.js','test-assets/entry.html:stream']){
    fs.writeFileSync(manifestFile,JSON.stringify({...manifest,files:{...files,html}}));assert.throws(()=>store.listInterfaceSchemes(),/package-test\.json/);
  }
  fs.writeFileSync(manifestFile,JSON.stringify({...manifest,presentation}));assert.throws(()=>store.listInterfaceSchemes(),/cannot combine/);
  fs.writeFileSync(manifestFile,JSON.stringify({...manifest,files:{html:files.html,css:files.css}}));assert.throws(()=>store.listInterfaceSchemes(),/explicit html, css and script/);
  fs.writeFileSync(manifestFile,JSON.stringify(manifest));fs.writeFileSync(path.join(assets,'entry.css'),'x'.repeat(128*1024+1));assert.throws(()=>store.listInterfaceSchemes(),/128 KiB/);
  fs.unlinkSync(manifestFile);
  const link=path.join(initial.directory,'linked-assets');fs.symlinkSync(assets,link,'junction');
  try{fs.writeFileSync(manifestFile,JSON.stringify({...manifest,files:{...files,html:'linked-assets/entry.html'}}));assert.throws(()=>store.listInterfaceSchemes(),/real directory/);}finally{fs.unlinkSync(manifestFile);fs.rmdirSync(link);}
  const customContent=path.join(initial.directory,'packages/industrial/style.css');fs.writeFileSync(customContent,'main { color: gold; }');
  assert.equal(createCustomizationStore(path.join(temporary,'customization'),bundled).listInterfaceSchemes().schemes.find(entry=>entry.id==='industrial-open')?.presentation?.css,'main { color: gold; }','Seed upgrades must preserve user package content');
  const removed=path.join(initial.directory,'constructivist-open.json');fs.unlinkSync(removed);createCustomizationStore(path.join(temporary,'customization'),bundled).directory('interfaces');assert.equal(fs.existsSync(removed),false,'Deleted package manifests must not be resurrected');
  fs.unlinkSync(customContent);createCustomizationStore(path.join(temporary,'customization'),bundled).directory('interfaces');assert.equal(fs.existsSync(customContent),false,'Deleted package assets must not be resurrected');
  const legacy=path.join(temporary,'legacy'),legacyInterfaces=path.join(legacy,'customization/interfaces');fs.mkdirSync(legacyInterfaces,{recursive:true});fs.writeFileSync(path.join(legacyInterfaces,'.seeded-v1'),'1\n');
  fs.writeFileSync(path.join(legacyInterfaces,'industrial-open.json'),JSON.stringify({...original,id:'industrial-open',name:'Existing user package'}));
  const upgraded=createCustomizationStore(path.join(legacy,'customization'),bundled).listInterfaceSchemes();assert.equal(upgraded.schemes.length,3);assert.equal(upgraded.schemes.find(entry=>entry.id==='industrial-open')?.name,'Existing user package','V2 upgrade must preserve existing user manifests');assert.equal(fs.existsSync(path.join(legacyInterfaces,'industrial.json')),false,'V2 package upgrade must not restore deleted V1 templates');
  console.log(JSON.stringify({event:'interface-package-passed',realDisk:true,hydratedSnapshot:true,boundedUtf8:true,pathContainment:true,junctionRejected:true,noResurrection:true,legacyUpgradePreservesFiles:true}));
}finally{
  const resolved=path.resolve(temporary);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert(path.basename(resolved).startsWith('deepscord-interface-package-'));fs.rmSync(resolved,{recursive:true,force:true});
}
