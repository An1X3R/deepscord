// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {resolveResourceRoot,initializePortableResources} from '../desktop/resource-location.cjs';

/** @param {import('node:test').TestContext} context */
function workspace(context){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-portable-'));
  context.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  return {directory,root:path.join(directory,'app','mods'),legacyUserData:path.join(directory,'legacy')};
}

/** @param {string} filename @param {string|Buffer} content */
function write(filename,content){fs.mkdirSync(path.dirname(filename),{recursive:true});fs.writeFileSync(filename,content);}

test('resources resolve beside the executable, in development, or at an explicit override',context=>{
  const {directory}=workspace(context);
  const options={executable:path.join(directory,'release','Deepscord.exe'),developmentDirectory:path.join(directory,'desktop'),packaged:true,override:null};
  assert.equal(resolveResourceRoot(options),path.join(directory,'release','mods'));
  assert.equal(resolveResourceRoot({...options,packaged:false}),path.join(directory,'desktop','mods'));
  assert.equal(resolveResourceRoot({...options,override:path.join(directory,'library')}),path.join(directory,'library'));
  assert.throws(()=>resolveResourceRoot({...options,override:'relative'}),/absolute filesystem path/);
});

test('migrates actual themes, interactions, seeding markers and private sticker files without removing originals',context=>{
  const options=workspace(context);
  /** @type {[string,string|Buffer][]} */
  const entries=[['customization/interfaces/personal.json','{"name":"personal"}'],['customization/interfaces/packages/theme/layout.html','<main>Theme</main>'],['customization/interfaces/.seeded-v2','2\n'],['customization/interactions/personal.json','{"id":"personal"}'],['stickers/catalog.json','{"favorites":["one"]}'],['stickers/assets/one.avif',Buffer.from([0,1,2,3])]];
  for(const [name,content] of entries)write(path.join(options.legacyUserData,name),content);
  fs.mkdirSync(path.join(options.legacyUserData,'customization','interfaces','empty'),{recursive:true});
  const report=initializePortableResources(options);
  assert.equal(report.status,'migrated');assert.equal(report.fileCount,entries.length);
  assert.equal(report.byteCount,entries.reduce((total,[,data])=>total+Buffer.byteLength(data),0));
  assert.equal(report.sources[0].destination,options.root);
  assert.equal(report.sources[1].destination,path.join(options.root,'stickers'));
  for(const [name,content] of entries){
    const relative=name.replace(/^customization\//,'');
    assert.deepEqual(fs.readFileSync(path.join(options.root,relative)),Buffer.from(content));
    assert.deepEqual(fs.readFileSync(path.join(options.legacyUserData,name)),Buffer.from(content));
  }
  assert.equal(fs.statSync(path.join(options.root,'interfaces','empty')).isDirectory(),true);
});

test('keeps bundled application guides while migrating user resources beside example packs',context=>{
  const options=workspace(context);
  for(const file of ['RESOURCE_PACKS.md','interfaces/DEVELOPMENT.md','interactions/DEVELOPMENT.md']){
    write(path.join(options.legacyUserData,'customization',file),'Old generated guide');
    write(path.join(options.root,file),'Current bundled guide');
  }
  write(path.join(options.root,'examples','sample','pack.json'),'Bundled example');
  write(path.join(options.legacyUserData,'customization','interfaces','user.json'),'User theme');
  const report=initializePortableResources(options);assert.equal(report.fileCount,1);
  for(const file of ['RESOURCE_PACKS.md','interfaces/DEVELOPMENT.md','interactions/DEVELOPMENT.md']){
    assert.equal(fs.readFileSync(path.join(options.root,file),'utf8'),'Current bundled guide');
    assert.equal(fs.readFileSync(path.join(options.legacyUserData,'customization',file),'utf8'),'Old generated guide');
  }
  assert.equal(fs.readFileSync(path.join(options.root,'examples','sample','pack.json'),'utf8'),'Bundled example');
  assert.equal(fs.readFileSync(path.join(options.root,'interfaces','user.json'),'utf8'),'User theme');
});

test('resumes an interrupted migration with identical existing destinations',context=>{
  const options=workspace(context);
  write(path.join(options.legacyUserData,'customization','interfaces','one.json'),'one');
  write(path.join(options.legacyUserData,'customization','interfaces','two.json'),'two');
  write(path.join(options.root,'interfaces','one.json'),'one');
  write(path.join(options.root,'unrelated.json'),'keep');
  assert.equal(initializePortableResources(options).fileCount,2);
  assert.equal(fs.readFileSync(path.join(options.root,'interfaces','two.json'),'utf8'),'two');
  assert.equal(fs.readFileSync(path.join(options.root,'unrelated.json'),'utf8'),'keep');
});

test('completed migration does not inspect or import the legacy location again',context=>{
  const options=workspace(context);
  write(path.join(options.legacyUserData,'stickers','one.avif'),'image');
  const report=initializePortableResources(options);
  fs.rmSync(options.legacyUserData,{recursive:true});
  write(options.legacyUserData,'legacy root has been replaced by a regular file');
  const repeated=initializePortableResources(options);
  assert.deepEqual(repeated,{...report,status:'complete'});
});

test('reports a precise conflict before copying and can resume after the conflict is resolved',context=>{
  const options=workspace(context);
  const source=path.join(options.legacyUserData,'customization','interfaces','a.json');
  const destination=path.join(options.root,'interfaces','a.json');
  write(source,'legacy');write(destination,'edited');
  write(path.join(options.legacyUserData,'stickers','new.avif'),'new');
  assert.throws(()=>initializePortableResources(options),error=>error instanceof Error&&error.message.includes('conflict')&&error.message.includes(source)&&error.message.includes(destination));
  assert.equal(fs.readFileSync(source,'utf8'),'legacy');
  assert.equal(fs.readFileSync(destination,'utf8'),'edited');
  assert.equal(fs.existsSync(path.join(options.root,'stickers','new.avif')),false);
  assert.equal(fs.existsSync(path.join(options.root,'.portable-migration-v1.json')),false);
  fs.unlinkSync(destination);
  assert.equal(initializePortableResources(options).fileCount,2);
});

test('accepts a full private library plus themes within the migration budget',context=>{
  const options=workspace(context);
  const data=Buffer.alloc(48*1024*1024,31);
  write(path.join(options.legacyUserData,'stickers','library.bin'),data);
  write(path.join(options.legacyUserData,'customization','interfaces','theme.json'),'theme');
  const report=initializePortableResources(options);
  assert.equal(report.byteCount,data.length+5);
  assert.deepEqual(fs.readFileSync(path.join(options.root,'stickers','library.bin')),data);
});

test('initializes a clean install once and rejects malformed completion metadata',context=>{
  const options=workspace(context);
  assert.equal(initializePortableResources(options).fileCount,0);
  assert.equal(initializePortableResources(options).status,'complete');
  write(path.join(options.root,'.portable-migration-v1.json'),'{}');
  assert.throws(()=>initializePortableResources(options),/marker does not match/);
});

test('rejects unavailable resource directories and overlapping migration roots explicitly',context=>{
  const options=workspace(context);
  write(options.root,'file blocks the resource directory');
  assert.throws(()=>initializePortableResources(options),/real directories/);
  assert.throws(()=>initializePortableResources({...options,root:path.join(options.legacyUserData,'customization','mods')}),/must not overlap/);
  assert.throws(()=>initializePortableResources({...options,root:path.join(options.legacyUserData,'stickers','mods')}),/must not overlap/);
  assert.throws(()=>initializePortableResources({...options,root:options.legacyUserData}),/must not overlap/);
});

test('migrates legacy sources into sibling data/mods and never scans the sources after completion',context=>{
  const {directory}=workspace(context),legacyUserData=path.join(directory,'data'),root=path.join(legacyUserData,'mods'),options={root,legacyUserData};
  const source=path.join(legacyUserData,'customization'),stickers=path.join(legacyUserData,'stickers');
  write(path.join(source,'interfaces','theme.json'),'theme');write(path.join(stickers,'favorite.avif'),'favorite');
  const report=initializePortableResources(options);assert.equal(report.fileCount,2);
  assert.equal(fs.readFileSync(path.join(root,'interfaces','theme.json'),'utf8'),'theme');
  assert.equal(fs.readFileSync(path.join(root,'stickers','favorite.avif'),'utf8'),'favorite');
  fs.rmSync(source,{recursive:true});write(source,'Legacy source is no longer a directory');
  fs.rmSync(stickers,{recursive:true});write(stickers,'Legacy source is no longer a directory');
  assert.deepEqual(initializePortableResources(options),{...report,status:'complete'});
});

test('completed portable resources follow the moved app and ignore a different computer profile',context=>{
  const options=workspace(context);
  write(path.join(options.legacyUserData,'customization','interfaces','theme.json'),'migrated theme');
  const report=initializePortableResources(options),movedRoot=path.join(options.directory,'moved-app','mods');
  fs.mkdirSync(path.dirname(movedRoot),{recursive:true});fs.renameSync(options.root,movedRoot);
  const otherProfile=path.join(options.directory,'other-profile');
  write(path.join(otherProfile,'customization'),'This profile has incompatible legacy contents');
  const moved=initializePortableResources({root:movedRoot,legacyUserData:otherProfile});
  assert.equal(moved.status,'complete');assert.equal(moved.fileCount,report.fileCount);assert.equal(moved.root,movedRoot);
  assert.equal(moved.legacyUserData,otherProfile);assert.equal(moved.sources[0].destination,movedRoot);
  assert.equal(moved.sources[1].destination,path.join(movedRoot,'stickers'));
  assert.equal(fs.readFileSync(path.join(movedRoot,'interfaces','theme.json'),'utf8'),'migrated theme');
});
