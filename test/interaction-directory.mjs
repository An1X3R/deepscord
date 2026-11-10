// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {initialInteractionCatalog} from '../public/js/interaction-defaults.js';

const require=createRequire(import.meta.url);
const {createCustomizationStore}=/** @type {typeof import('../desktop/customization-store.cjs')} */(require('../desktop/customization-store.cjs'));
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-interaction-directory-'));
const bundled=fileURLToPath(new URL('../public/customization/',import.meta.url));
const roomId='550e8400-e29b-41d4-a716-446655440000',otherRoomId='550e8400-e29b-41d4-a716-446655440001';
try{
  const store=createCustomizationStore(path.join(temporary,'customization'),bundled),initial=store.listServerInteractions(roomId);
  assert.deepEqual(initial.interactions,[],'New server directories must not seed or republish defaults');
  assert.equal(initial.directory,path.join(temporary,'customization','interactions'));
  assert.equal(initial.serverDirectory,path.join(initial.directory,roomId));
  assert.equal(fs.existsSync(path.join(initial.directory,'DEVELOPMENT.md')),true);
  assert.equal(fs.readdirSync(initial.directory).filter(name=>name.endsWith('.json')).length,4,'Legacy root templates must remain available');
  const definition=initialInteractionCatalog()[0],filename=path.join(initial.serverDirectory,'draft.json');
  fs.writeFileSync(filename,JSON.stringify({...definition,extra:'discard'}));
  assert.deepEqual(store.listServerInteractions(roomId).interactions,[definition],'Disk definitions must use the shared parser and strip extra fields');
  assert.deepEqual(store.listServerInteractions(otherRoomId).interactions,[],'Room definitions must not cross server boundaries');
  fs.mkdirSync(path.join(initial.serverDirectory,'nested'));
  fs.writeFileSync(path.join(initial.serverDirectory,'nested','ignored.json'),'{');
  assert.equal(store.listServerInteractions(roomId).interactions.length,1,'Subdirectories must not be scanned');
  fs.writeFileSync(path.join(initial.serverDirectory,'duplicate.json'),JSON.stringify(definition));
  assert.throws(()=>store.listServerInteractions(roomId),/Duplicate interaction ID/);
  fs.unlinkSync(path.join(initial.serverDirectory,'duplicate.json'));
  for(const value of ['{',JSON.stringify({...definition,durationMs:1}),'x'.repeat(256*1024+1)]){
    fs.writeFileSync(filename,value);
    assert.throws(()=>store.listServerInteractions(roomId),/Invalid interaction definition .*draft\.json:/);
  }
  fs.unlinkSync(filename);fs.mkdirSync(filename);
  assert.throws(()=>store.listServerInteractions(roomId),/draft\.json/);
  fs.rmdirSync(filename);
  assert.deepEqual(createCustomizationStore(path.join(temporary,'customization'),bundled).listServerInteractions(roomId).interactions,[],'Deleting local files must survive store recreation');
  for(const invalid of ['../outside',roomId.toUpperCase(),'550e8400-e29b-01d4-a716-446655440000'])assert.throws(()=>store.interactionDirectory(invalid),/canonical lowercase room UUID/);
  for(let index=0;index<97;index++)fs.writeFileSync(path.join(initial.serverDirectory,'extra-'+index+'.json'),'{}');
  assert.throws(()=>store.listServerInteractions(roomId),/at most 96/);
  console.log(JSON.stringify({event:'interaction-directory-passed',realDisk:true,serverIsolation:true,noAutoSeed:true,strictParser:true,boundedDirectory:true}));
}finally{
  const resolved=path.resolve(temporary),parent=path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolved),parent,'Cleanup must remain inside the temporary directory');
  assert.equal(path.basename(resolved).startsWith('deepscord-interaction-directory-'),true);
  fs.rmSync(resolved,{recursive:true,force:true});
}
