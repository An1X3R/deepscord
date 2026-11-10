// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {buildResourceExamples,verifyResourceExamples,resourceExampleFiles} from '../tools/build-resource-examples.mjs';
import {createResourcePackStore} from '../desktop/resource-pack-store.cjs';
import {createCustomizationStore,readInterfaceFile} from '../desktop/customization-store.cjs';
import {createStickerStore} from '../desktop/sticker-store.cjs';
import codec from '../lib/avif-codec.cjs';
const sourceDirectory=fileURLToPath(new URL('../public/customization/',import.meta.url));
const signal=new AbortController().signal;
/** @param {import('node:test').TestContext} context @returns {string} */
function workspace(context){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-examples-'));context.after(()=>{assert.equal(path.dirname(directory),os.tmpdir());assert(path.basename(directory).startsWith('deepscord-examples-'));fs.rmSync(directory,{recursive:true});});return directory;}

test('builds exactly four clean, self-contained example packs and current guides without private state',async context=>{
  const directory=workspace(context),destination=path.join(directory,'mods');
  const report=await buildResourceExamples({sourceDirectory,destination,signal});
  assert.deepEqual(report.packIds,['industrial-open','constructivist-open','interaction-examples','sticker-example']);
  assert.equal(report.files,20);assert.equal(resourceExampleFiles.length,20);
  assert.deepEqual(fs.readdirSync(destination).sort(),['RESOURCE_PACKS.md','examples','interactions','interfaces']);
  for(const file of ['registry.json','.portable-migration-v1.json','.removed','packs','stickers'])assert.equal(fs.existsSync(path.join(destination,file)),false);
  for(const guide of ['RESOURCE_PACKS.md','interfaces/DEVELOPMENT.md','interactions/DEVELOPMENT.md'])assert.deepEqual(fs.readFileSync(path.join(destination,guide)),fs.readFileSync(path.join(sourceDirectory,guide)));
  assert.deepEqual(await verifyResourceExamples({directory:destination,signal}),report);
  await assert.rejects(buildResourceExamples({sourceDirectory,destination,signal}),/already exists/);
});

test('the authored AVIF sample is reproducible and validates as a real static personal image',async context=>{
  const directory=workspace(context),first=path.join(directory,'first'),second=path.join(directory,'second');
  await buildResourceExamples({sourceDirectory,destination:first,signal});await buildResourceExamples({sourceDirectory,destination:second,signal});
  const filename='examples/sticker-example/original-mark.avif',data=fs.readFileSync(path.join(first,filename));
  assert.deepEqual(data,fs.readFileSync(path.join(second,filename)));
  const media=await codec.validate(data,'personal',signal);
  assert.equal(media.width,48);assert.equal(media.height,48);assert.equal(media.animated,false);assert.equal(media.frames,1);assert(data.length<160*1024);
});

test('all four example folders install through the real resource and personal stores',async context=>{
  const directory=workspace(context),root=path.join(directory,'mods');await buildResourceExamples({sourceDirectory,destination:root,signal});
  const customization=createCustomizationStore(root,sourceDirectory),personal=await createStickerStore({directory:path.join(root,'stickers'),validate:codec.validate});
  try{
    const store=createResourcePackStore({root,readInterfaceFile,listLegacyInterfaces:customization.listInterfaceSchemes,listPersonal:personal.list,importStickers:personal.addBatch,removeStickers:personal.removeBatch,activeThemeId:()=>null});
    for(const name of ['industrial-open','constructivist-open','interaction-examples','sticker-example'])await store.install(path.join(root,'examples',name),null,signal);
    const listed=await store.list(),installed=listed.packs.filter(pack=>pack.source==='package');
    assert.equal(installed.length,4);assert(installed.every(pack=>pack.serverIds.length===0));assert.equal(listed.personal.count,1);
    assert.equal((await store.interfaceSchemes()).filter(scheme=>scheme.id.endsWith('-open')).length,2);
    const serverId='ce2f25a1-b0b4-4259-840a-e9669828ff65';await store.bindServer('interaction-examples',serverId);
    assert.equal((await store.interactionDrafts(serverId)).interactions.length,4);
  }finally{await personal.destroy();}
});
