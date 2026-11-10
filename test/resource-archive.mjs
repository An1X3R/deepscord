// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {extractResourceArchive} from '../desktop/resource-archive.cjs';

test('extracts an actual Windows ZIP containing a complete nested theme package',async context=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'deepscord-archive-'));
  context.after(()=>{assert.equal(path.dirname(directory),os.tmpdir());assert(path.basename(directory).startsWith('deepscord-archive-'));fs.rmSync(directory,{recursive:true});});
  const source=path.join(directory,'theme source'),archive=path.join(directory,'theme package.zip'),destination=path.join(directory,'mods','.imports','example');
  fs.mkdirSync(path.join(source,'themes','example','pages'),{recursive:true});fs.mkdirSync(destination,{recursive:true});
  const files=new Map([
    ['pack.json',JSON.stringify({format:1,id:'example-theme',name:'Example theme',version:'1.0',kind:'interfaces',entries:[{file:'themes/example/theme.json',name:'Example'}]})],
    ['themes/example/theme.json',JSON.stringify({files:{html:'pages/layout.html',css:'pages/style.css',script:'pages/script.js'}})],
    ['themes/example/pages/layout.html','<main>便携主题</main>'],
    ['themes/example/pages/style.css','main { color: #abcdef; }'],
    ['themes/example/pages/script.js','document.documentElement.dataset.theme = "example";']
  ]);
  for(const [file,data] of files)fs.writeFileSync(path.join(source,file),data);
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:DEEPSCORD_ZIP_SOURCE, $env:DEEPSCORD_ZIP_ARCHIVE)'],{windowsHide:true,encoding:'utf8',timeout:30000,env:{...process.env,DEEPSCORD_ZIP_SOURCE:source,DEEPSCORD_ZIP_ARCHIVE:archive}});
  await extractResourceArchive({archive,destination,signal:new AbortController().signal});
  for(const [file,data] of files)assert.equal(fs.readFileSync(path.join(destination,file),'utf8'),data);
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination,'pack.json'),'utf8')).id,'example-theme');
  assert(fs.existsSync(archive));
});
