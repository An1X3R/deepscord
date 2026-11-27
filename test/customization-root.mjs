// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import storage from '../desktop/customization-store.cjs';
import {initialInteractionCatalog} from '../public/js/interaction-defaults.js';

const bundled=fileURLToPath(new URL('../public/customization/',import.meta.url));
test('explicit customization roots seed and reopen themes, package files, interaction definitions and guides directly',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-customization-root-')),root=path.join(temporary,'mods');
  try{
    const store=storage.createCustomizationStore(root,bundled),initial=store.listInterfaceSchemes();
    assert.equal(initial.directory,path.join(root,'interfaces'));assert.equal(initial.schemes.length,5);assert.equal(fs.existsSync(path.join(root,'customization')),false);
    assert.equal(fs.readFileSync(path.join(initial.directory,'DEVELOPMENT.md'),'utf8'),fs.readFileSync(path.join(bundled,'interfaces','DEVELOPMENT.md'),'utf8'));
    const manifest=path.join(initial.directory,'industrial-open.json'),snapshot=storage.readInterfaceFile(manifest);
    assert(snapshot.presentation);assert.deepEqual(snapshot,initial.schemes.find(entry=>entry.id==='industrial-open'));
    const stylesheet=path.join(initial.directory,'packages','industrial','style.css');fs.writeFileSync(stylesheet,'main { color: gold; }');
    assert.equal(storage.readInterfaceFile(manifest).presentation?.css,'main { color: gold; }');assert.notEqual(snapshot.presentation.css,'main { color: gold; }');
    const roomId='550e8400-e29b-41d4-a716-446655440000',interactions=store.listServerInteractions(roomId);
    assert.equal(interactions.directory,path.join(root,'interactions'));assert.equal(interactions.serverDirectory,path.join(root,'interactions',roomId));assert.deepEqual(interactions.interactions,[]);
    assert.equal(fs.readFileSync(path.join(interactions.directory,'DEVELOPMENT.md'),'utf8'),fs.readFileSync(path.join(bundled,'interactions','DEVELOPMENT.md'),'utf8'));
    const definition=initialInteractionCatalog()[0],filename=path.join(interactions.serverDirectory,'local.json');fs.writeFileSync(filename,JSON.stringify(definition));
    assert.deepEqual(store.listServerInteractions(roomId).interactions,[definition]);
    const reopened=storage.createCustomizationStore(root,bundled);assert.deepEqual(reopened.listServerInteractions(roomId).interactions,[definition]);assert.equal(reopened.listInterfaceSchemes().schemes.find(entry=>entry.id==='industrial-open')?.presentation?.css,'main { color: gold; }');
    fs.unlinkSync(filename);fs.unlinkSync(path.join(initial.directory,'constructivist.json'));
    const afterDeletion=storage.createCustomizationStore(root,bundled);assert.deepEqual(afterDeletion.listServerInteractions(roomId).interactions,[]);assert.equal(afterDeletion.listInterfaceSchemes().schemes.some(entry=>entry.id==='constructivist'),false);
    fs.writeFileSync(path.join(initial.directory,'DEVELOPMENT.md'),'Outdated guide');afterDeletion.directory('interfaces');assert.equal(fs.readFileSync(path.join(initial.directory,'DEVELOPMENT.md'),'utf8'),fs.readFileSync(path.join(bundled,'interfaces','DEVELOPMENT.md'),'utf8'));
  }finally{
    assert.equal(path.dirname(temporary),path.resolve(os.tmpdir()));assert(path.basename(temporary).startsWith('deepscord-customization-root-'));fs.rmSync(temporary,{recursive:true,force:true});
  }
});

test('V2 installations gain Lanart once while preserving customized files and later removal',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-customization-root-')),root=path.join(temporary,'mods'),directory=path.join(root,'interfaces');
  try{
    fs.mkdirSync(path.join(directory,'packages','lanart'),{recursive:true});
    fs.writeFileSync(path.join(directory,'.seeded-v1'),'1\n');fs.writeFileSync(path.join(directory,'.seeded-v2'),'2\n');
    const stylesheet=path.join(directory,'packages','lanart','style.css');fs.writeFileSync(stylesheet,'main { color: gold; }');
    const store=storage.createCustomizationStore(root,bundled),upgraded=store.listInterfaceSchemes();
    assert.deepEqual(upgraded.schemes.map(scheme=>scheme.id),['lanart-open']);
    assert.equal(upgraded.schemes[0].presentation?.css,'main { color: gold; }');
    assert.equal(fs.readFileSync(path.join(directory,'.seeded-v3'),'utf8'),'3\n');
    fs.unlinkSync(path.join(directory,'lanart-open.json'));fs.unlinkSync(stylesheet);
    assert.deepEqual(storage.createCustomizationStore(root,bundled).listInterfaceSchemes().schemes,[]);
    assert.equal(fs.existsSync(stylesheet),false);
  }finally{
    assert.equal(path.dirname(temporary),path.resolve(os.tmpdir()));assert(path.basename(temporary).startsWith('deepscord-customization-root-'));fs.rmSync(temporary,{recursive:true,force:true});
  }
});
