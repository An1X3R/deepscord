// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openRoomStore,readRoomStore} from '../lib/room-store.cjs';
import {parseSteamStore} from '../lib/steam-state.cjs';

test('real room files retain the previous validated snapshot and reopen the latest write',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-store-'));
  const filename=path.join(directory,'store.json');
  try {
    const initial=parseSteamStore({version:1,servers:[{id:'domain',name:'Initial',icon:'D',color:'#123456',channels:[]}],messages:{}});
    const persistence=openRoomStore({filename,initial});
    persistence.save(initial);
    const next={...initial,servers:initial.servers.map(server=>({...server,name:'Saved'}))};
    persistence.save(next);
    assert.deepEqual(readRoomStore(filename),next);
    assert.deepEqual(readRoomStore(filename+'.backup'),initial);
    assert.deepEqual(openRoomStore({filename,initial}).initial,next);
    assert.deepEqual(fs.readdirSync(directory).sort(),['store.json','store.json.backup']);
    fs.writeFileSync(filename,'{"servers":');
    assert.throws(()=>openRoomStore({filename,initial}),/original file retained.*recovery copy/);
    assert.equal(fs.readFileSync(filename,'utf8'),'{"servers":');
    assert.deepEqual(readRoomStore(filename+'.backup'),initial);
  } finally { assert.equal(path.dirname(directory),os.tmpdir());assert(path.basename(directory).startsWith('deepscord-store-'));fs.rmSync(directory,{recursive:true,force:true}); }
});

test('a real failed replacement preserves the previous snapshot and reports failure',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-store-error-'));
  const filename=path.join(directory,'store.json');
  try {
    const initial=parseSteamStore({version:1,servers:[],messages:{}}),persistence=openRoomStore({filename,initial});
    persistence.save(initial);
    fs.unlinkSync(filename);fs.mkdirSync(filename);
    assert.throws(()=>persistence.save(initial),/EPERM|EISDIR|EACCES/);
    assert.deepEqual(readRoomStore(filename+'.backup'),initial);
    assert.deepEqual(fs.readdirSync(directory).sort(),['store.json','store.json.backup']);
  } finally { assert.equal(path.dirname(directory),os.tmpdir());assert(path.basename(directory).startsWith('deepscord-store-error-'));fs.rmSync(directory,{recursive:true,force:true}); }
});
