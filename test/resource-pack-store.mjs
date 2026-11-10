// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createResourcePackStore} from '../desktop/resource-pack-store.cjs';
import {createCustomizationStore,readInterfaceFile} from '../desktop/customization-store.cjs';
import {createStickerStore} from '../desktop/sticker-store.cjs';
import codec from '../lib/avif-codec.cjs';
/** @typedef {import('../public/js/resource-pack.js').ResourcePackManifest} Manifest */
const sourceRoot=fileURLToPath(new URL('../public/customization/',import.meta.url));
const room='ce2f25a1-b0b4-4259-840a-e9669828ff65',otherRoom='ce2f25a1-b0b4-4259-840a-e9669828ff66';
const limits={maxBytes:160*1024,maxDimension:360,maxFrames:180,maxDecodedPixels:24*1024*1024,maxDurationMs:10000,timeoutMs:30000};
/** @param {number} seed @returns {Promise<Buffer>} */
async function image(seed){const rgba=new Uint8Array(8*8*4);for(let index=0;index<rgba.length;index++)rgba[index]=(index*seed+seed)%256;return codec.encode({width:8,height:8,timescale:1000,repetitionCount:0,frames:[{rgba,durationTicks:1000}]},{quality:80,speed:10},limits,new AbortController().signal);}
/** @param {string} filename @param {string|Buffer} content @returns {void} */
function write(filename,content){fs.mkdirSync(path.dirname(filename),{recursive:true});fs.writeFileSync(filename,content);}
/** @param {import('node:test').TestContext} context */
async function fixture(context){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-packs-')),root=path.join(directory,'mods');
  const customization=createCustomizationStore(root,sourceRoot),personal=await createStickerStore({directory:path.join(root,'stickers'),validate:codec.validate});
  /** @type {string|null} */let selected=null;
  const options={root,readInterfaceFile,listLegacyInterfaces:customization.listInterfaceSchemes,listPersonal:personal.list,importStickers:personal.addBatch,removeStickers:personal.removeBatch,activeThemeId:()=>selected};
  const store=createResourcePackStore(options);
  context.after(async()=>{await personal.destroy();assert.equal(path.dirname(directory),os.tmpdir());assert(path.basename(directory).startsWith('deepscord-packs-'));fs.rmSync(directory,{recursive:true});});
  return {directory,root,personal,customization,store,options,select:(/** @type {string|null} */ id)=>{selected=id;}};
}
/** @param {string} directory @param {Manifest} manifest @param {{file:string,data:Buffer|string}[]} files @returns {string} */
function pack(directory,manifest,files){const target=path.join(directory,'inputs',manifest.id+'-'+manifest.version);write(path.join(target,'pack.json'),JSON.stringify(manifest));for(const file of files)write(path.join(target,file.file),file.data);return target;}
/** @param {string} id @param {'interfaces'|'interactions'|'stickers'} kind @param {string} file @returns {Manifest} */
function manifest(id,kind,file){return {format:1,id,name:id,version:'1',kind,entries:[{file,name:'Example'}]};}
const signal=new AbortController().signal;
const first=await image(7),second=await image(19);

test('registers legacy themes, protects active selections, backs up only owned files, and persists removal',async context=>{
  const {root,store,select,options}=await fixture(context),initial=await store.list();
  assert(initial.packs.some(pack=>pack.id==='industrial'&&pack.source==='legacy'));
  assert(fs.existsSync(path.join(root,'registry.json')));
  select('industrial');await assert.rejects(store.remove('industrial'),/Switch to another theme/);
  select(null);await store.remove('industrial');
  assert(fs.existsSync(path.join(root,'.removed','industrial','interfaces','industrial.json')));
  assert(fs.existsSync(path.join(root,'interfaces','.seeded-v1')));
  assert(fs.existsSync(path.join(root,'interfaces','DEVELOPMENT.md')));
  assert(!(await createResourcePackStore(options).list()).packs.some(pack=>pack.id==='industrial'));
});

test('installs, updates and reopens real interface manifests while rejecting duplicate theme ownership',async context=>{
  const {directory,store,options}=await fixture(context);
  const original=JSON.parse(fs.readFileSync(path.join(sourceRoot,'interfaces','industrial.json'),'utf8'));
  const scheme={...original,id:'custom-theme',name:'Custom theme'},input=manifest('custom-pack','interfaces','theme.json');
  await store.install(pack(directory,input,[{file:'theme.json',data:JSON.stringify(scheme)}]),null,signal);
  assert((await store.interfaceSchemes()).some(scheme=>scheme.id==='custom-theme'));
  await store.install(pack(directory,{...input,version:'2'},[{file:'theme.json',data:JSON.stringify({...scheme,name:'Updated'})}]),null,signal);
  assert.equal((await createResourcePackStore(options).list()).packs.find(pack=>pack.id==='custom-pack')?.version,'2');
  await assert.rejects(store.install(pack(directory,{...input,id:'duplicate-pack'},[{file:'theme.json',data:JSON.stringify(scheme)}]),null,signal),/already owned/);
});

test('replaces a legacy theme by matching ID after validation and preserves its old files',async context=>{
  const {directory,root,store}=await fixture(context);
  await store.list();
  const original=fs.readFileSync(path.join(root,'interfaces','industrial.json'),'utf8');
  await store.install(pack(directory,manifest('industrial','interfaces','theme.json'),[{file:'theme.json',data:original}]),null,signal);
  assert.equal((await store.list()).packs.find(pack=>pack.id==='industrial')?.source,'package');
  assert.equal(fs.existsSync(path.join(root,'interfaces','industrial.json')),false);
  const legacyBackup=fs.readdirSync(path.join(root,'.removed')).find(name=>fs.existsSync(path.join(root,'.removed',name,'interfaces','industrial.json')));assert(legacyBackup);
  await store.remove('industrial');
  assert.equal(fs.readFileSync(path.join(root,'.removed',legacyBackup,'interfaces','industrial.json'),'utf8'),original);
});

test('validates actual interaction thumbnails and restricts assets to bound definitions',async context=>{
  const {directory,store}=await fixture(context),sha256=createHash('sha256').update(first).digest('hex'),actual=await codec.validate(first,'server',signal);
  const draft={id:'custom-interaction',name:'Custom',model:'thumbnail',trajectory:'arc',sound:'none',durationMs:1000,thumbnail:{...actual,sha256,bytes:first.length}};
  const input=manifest('interaction-pack','interactions','interaction.json');
  await store.install(pack(directory,input,[{file:'interaction.json',data:JSON.stringify(draft)},{file:'assets/'+sha256+'.avif',data:first}]),room,signal);
  assert.equal((await store.interactionDrafts(room)).interactions[0].id,draft.id);
  assert.deepEqual(await store.interactionAssetForServer(room,draft.id,sha256),first);
  assert.equal(await store.interactionAssetForServer(otherRoom,draft.id,sha256),null);
  assert.equal(await store.interactionAssetForServer(room,'different-id',sha256),null);
  await store.bindServer(input.id,otherRoom);
  assert.deepEqual(await store.interactionAssetForServer(otherRoom,draft.id,sha256),first);
  await assert.rejects(store.install(pack(directory,{...input,id:'missing-thumbnail'},[{file:'interaction.json',data:JSON.stringify(draft)}]),room,signal),/ENOENT/);
});

test('merges legacy room drafts and persists bindings for legacy examples',async context=>{
  const {root,store,customization,options}=await fixture(context);customization.directory('interactions');
  const draft=JSON.parse(fs.readFileSync(path.join(sourceRoot,'interactions','default-bomb.json'),'utf8'));
  write(path.join(root,'interactions',room,'custom.json'),JSON.stringify({...draft,id:'legacy-personal'}));
  const listed=await store.list(),example=listed.packs.find(pack=>pack.kind==='interactions'&&!pack.serverIds.length);
  assert(example);await store.bindServer(example.id,room);
  const reopened=createResourcePackStore(options);
  assert((await reopened.list()).packs.find(pack=>pack.id===example.id)?.serverIds.includes(room));
  const drafts=await reopened.interactionDrafts(room);assert(drafts.interactions.some(draft=>draft.id==='legacy-personal'));assert(drafts.interactions.length>=2);
});

test('real sticker installs preserve preexisting favorites and shared package references',async context=>{
  const {directory,store,personal}=await fixture(context);
  const preexisting=await personal.add({name:'Favorite',data:first.toString('base64')},signal);await personal.pin(preexisting.id);
  const a=manifest('stickers-a','stickers','one.avif'),b=manifest('stickers-b','stickers','two.avif');
  await store.install(pack(directory,a,[{file:'one.avif',data:first}]),null,signal);
  await store.remove(a.id);assert.equal((await personal.list()).items[0].pinned,true);
  await store.install(pack(directory,b,[{file:'two.avif',data:second}]),null,signal);
  const c=manifest('stickers-c','stickers','two.avif');await store.install(pack(directory,c,[{file:'two.avif',data:second}]),null,signal);
  await store.remove(b.id);assert.equal((await personal.list()).items.length,2);
  await store.remove(c.id);assert.deepEqual((await personal.list()).items.map(item=>item.id),[preexisting.id]);
});

test('invalid AVIF batches leave the real private library unchanged',async context=>{
  const {directory,store,personal}=await fixture(context),input={...manifest('invalid-stickers','stickers','one.avif'),entries:[{file:'one.avif',name:'Valid'},{file:'two.avif',name:'Invalid'}]};
  await assert.rejects(store.install(pack(directory,input,[{file:'one.avif',data:first},{file:'two.avif',data:'Not AVIF'}]),null,signal));
  assert.equal((await personal.list()).items.length,0);assert(!(await store.list()).packs.some(pack=>pack.id===input.id));
});

test('registry write failure rolls back only transaction-created sticker IDs and package files',async context=>{
  const {directory,root,store,personal}=await fixture(context);await store.list();
  const favorite=await personal.add({name:'Favorite',data:first.toString('base64')},signal);
  const registry=path.join(root,'registry.json'),saved=registry+'.saved';fs.renameSync(registry,saved);fs.mkdirSync(registry);
  try{await assert.rejects(store.install(pack(directory,manifest('blocked-stickers','stickers','two.avif'),[{file:'two.avif',data:second}]),null,signal));assert.deepEqual((await personal.list()).items.map(item=>item.id),[favorite.id]);assert.equal(fs.existsSync(path.join(root,'packs','blocked-stickers')),false);}
  finally{fs.rmdirSync(registry);fs.renameSync(saved,registry);}
});

test('an incomplete legacy removal remains listed and completes after resolving the filesystem conflict',async context=>{
  const {root,store}=await fixture(context);await store.list();
  const blocking=path.join(root,'.removed','industrial-open','interfaces','packages','industrial','style.css');write(blocking,'Backup location is occupied');
  await assert.rejects(store.remove('industrial-open'),/removal is incomplete; retry/);
  const pending=(await store.list()).packs.find(pack=>pack.id==='industrial-open');assert.equal(pending?.pendingRemoval,true);
  fs.renameSync(blocking,blocking+'.saved');await store.remove('industrial-open');
  assert(!(await store.list()).packs.some(pack=>pack.id==='industrial-open'));
  assert(fs.existsSync(path.join(root,'interfaces','.seeded-v2')));
});

test('repeated package updates and removal do not retain old managed package copies',async context=>{
  const {directory,root,store}=await fixture(context);
  const original=JSON.parse(fs.readFileSync(path.join(sourceRoot,'interfaces','industrial.json'),'utf8'));
  const input=manifest('managed-theme','interfaces','theme.json');
  for(const version of ['1','2','3','4']){
    const current={...input,version},scheme={...original,id:'managed-theme-scheme',name:'Version '+version};
    await store.install(pack(directory,current,[{file:'theme.json',data:JSON.stringify(scheme)},{file:'extras/version-'+version+'.txt',data:version}]),null,signal);
    assert.equal((await store.list()).packs.find(pack=>pack.id===input.id)?.version,version);
    assert.deepEqual(fs.readdirSync(path.join(root,'packs',input.id,'extras')),['version-'+version+'.txt']);
    if(fs.existsSync(path.join(root,'.removed')))assert.deepEqual(fs.readdirSync(path.join(root,'.removed')),[]);
  }
  await store.remove(input.id);
  assert.equal(fs.existsSync(path.join(root,'packs',input.id)),false);
  assert.deepEqual(fs.readdirSync(path.join(root,'.removed')),[]);
  assert(!(await store.list()).packs.some(pack=>pack.id===input.id));
});
