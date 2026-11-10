// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {packager} from '@electron/packager';
import {buildResourceExamples,resourceExampleFiles} from './build-resource-examples.mjs';
import './vendor-radio.cjs';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{path:string,bytes:number,sha256:string}} FileRecord */
/** @typedef {{output:string,zipDirectory:string,baseline:string|null}} BuildInput */

const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const locales=new Set(['zh-CN.pak','zh-TW.pak','en-US.pak']);
const excluded=/^\/(?:mods(?:\/|$)|test-|desktop-test-|capture-(?:analysis|integration|window)|build-test-tone|process-tone-test|native\/(?:screen-relay(?:\/|$)|process-audio\.cpp$|bin\/.*\.(?:obj|pdb)$))/;
const runtimeRequirements=['Deepscord.exe','dxcompiler.dll','resources.pak','icudtl.dat','LICENSES.chromium.html','LICENSE','vk_swiftshader.dll','d3dcompiler_47.dll','ffmpeg.dll','vulkan-1.dll','chrome_200_percent.pak','v8_context_snapshot.bin','chrome_100_percent.pak','electron_wer.dll','snapshot_blob.bin','vk_swiftshader_icd.json','version'];
const appRequirements=['native/bin/screen-relay.exe','native/bin/process-audio.exe','native/bin/screen-relay-NOTICES.txt','node_modules/steamworks.js/LICENSE','node_modules/@types/node/LICENSE','node_modules/undici-types/LICENSE','node_modules/steamworks.js/dist/win64/steam_api64.dll','node_modules/steamworks.js/dist/win64/steamworksjs.win32-x64-msvc.node','app-server/server.js','direct-certificate.ps1'];
appRequirements.push('steam-admission.cjs','server-trust.cjs','room-permissions.cjs','desktop-consent.cjs','desktop-consent.html','desktop-consent.js','desktop-consent.css','desktop-consent-preload.js','sticker-picker.cjs','sticker-picker.html','sticker-picker.js','sticker-picker.css','sticker-picker-preload.js');
appRequirements.push('room-client.cjs','content-vault.cjs','content-service.cjs','app-server/lib/content-crypto.cjs','app-server/lib/content-upgrade.cjs','app-server/public/js/content-client.js','app-server/public/js/content-settings.js','app-server/public/js/screen-encryption.js','app-server/public/vendor/livekit-e2ee-worker.js','app-server/public/vendor/livekit-e2ee-worker.LICENSE','app-server/public/vendor/livekit-e2ee-worker.json');
appRequirements.push('windows-protection.cjs','windows-protection.ps1','client-preferences.cjs','room-credentials.cjs');
appRequirements.push('radio-access.cjs','poke-window-bounds.cjs','poke-window-bounds.ps1','app-server/lib/radio-room.cjs','app-server/public/radio.css','app-server/public/js/radio-client.js','app-server/public/js/radio-ui.js','app-server/public/js/member-permissions.js','radio-metadata.cjs','app-server/public/js/radio-player.js','app-server/public/vendor/hls/hls.mjs','app-server/public/vendor/hls/LICENSE');
appRequirements.push(...['codec.mjs','module.mjs','module.wasm','manifest.json','libavif-LICENSE','libaom-LICENSE','libaom-PATENTS'].map(name=>'app-server/public/vendor/avif/'+name));
appRequirements.push(...['interface.css','js/interface-profile.js','js/customization-files.js','js/developer-guides.js','js/interaction-scene.js','js/interaction-scene-drawing.js','js/interaction-scene-examples.js','assets/interactions/fist.svg','assets/interactions/dollar.svg','customization/interfaces/DEVELOPMENT.md','customization/interactions/DEVELOPMENT.md'].map(name=>'app-server/public/'+name));
appRequirements.push('customization-store.cjs','sticker-embedded.cjs','app-server/public/js/interface-package.js','app-server/public/js/theme-colors.js');
appRequirements.push('resource-location.cjs','resource-pack-store.cjs','resource-manager.cjs','resource-archive.cjs','resource-archive.ps1','resource-manager.html','resource-manager.css','resource-manager.js','resource-manager-preload.js','app-server/public/js/resource-pack.js','app-server/public/js/resource-manager-link.js','app-server/public/customization/RESOURCE_PACKS.md');
appRequirements.push(...['industrial-open.json','constructivist-open.json',...['industrial','constructivist'].flatMap(name=>['layout.html','style.css','script.js'].map(file=>'packages/'+name+'/'+file))].map(name=>'app-server/public/customization/interfaces/'+name));
appRequirements.push(...['js/interface-scheme.js','js/interface-scheme-runtime.js','js/interface-scheme-ui.js','js/interaction-defaults.js','customization/interfaces/industrial.json','customization/interfaces/constructivist.json','customization/interactions/default-bomb.json','customization/interactions/default-poop.json','customization/interactions/playful-fist.json','customization/interactions/dollar-wallet.json'].map(name=>'app-server/public/'+name));

/** @param {JsonValue|undefined} value @param {string} field @returns {{[key:string]:JsonValue}} */
function object(value,field) {
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new TypeError(field+' must be a JSON object');
  return value;
}

/** @param {JsonValue|undefined} value @param {string} field @returns {string} */
function version(value,field) {
  if(typeof value!=='string' || !/^\d+\.\d+\.\d+$/.test(value)) throw new TypeError(field+' must be an exact release version');
  return value;
}

/** @param {string} filename @returns {{[key:string]:JsonValue}} */
function readObject(filename) { return object(JSON.parse(fs.readFileSync(filename,'utf8')),filename); }

/** @param {string} parent @param {string} target @returns {string} */
function within(parent,target) {
  const absolute=path.resolve(target),relative=path.relative(path.resolve(parent),absolute);
  if(!relative || relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) throw new TypeError('Path must be strictly inside its owned directory: '+absolute);
  return absolute;
}

/** @param {string} parent @param {string} target @returns {string} */
function owned(parent,target) {
  const absolute=within(parent,target);
  const resolved=fs.realpathSync(absolute);
  within(fs.realpathSync(parent),resolved);
  if(path.resolve(resolved).toLowerCase()!==absolute.toLowerCase()) throw new TypeError('Refusing redirected build path: '+absolute);
  return absolute;
}

/** @param {string[]} args @returns {BuildInput} */
function parseArguments(args) {
  /** @type {Map<string,string>} */
  const fields=new Map();
  for(let index=0;index<args.length;index+=2) {
    const name=args[index],value=args[index+1];
    if(!['--output','--electron-zip-dir','--baseline'].includes(name) || !value || value.startsWith('--') || fields.has(name)) throw new TypeError('Usage: node tools/build-desktop.mjs --output dist/<new-directory> --electron-zip-dir <cached-zip-directory> [--baseline <prior-package-directory>]');
    fields.set(name,value);
  }
  const output=fields.get('--output'),zipDirectory=fields.get('--electron-zip-dir');
  if(!output || !zipDirectory) throw new TypeError('--output and --electron-zip-dir are required');
  const baseline=fields.get('--baseline');
  return {output:within(path.join(root,'dist'),path.resolve(root,output)),zipDirectory:fs.realpathSync(path.resolve(root,zipDirectory)),baseline:baseline===undefined ? null : fs.realpathSync(path.resolve(root,baseline))};
}

/** @param {string} directory @returns {FileRecord[]} */
function inventory(directory) {
  /** @param {string} current @returns {FileRecord[]} */
  function walk(current) {
    return fs.readdirSync(current,{withFileTypes:true}).flatMap(entry=>{
      const filename=path.join(current,entry.name);
      if(entry.isSymbolicLink()) throw new TypeError('Release inputs must not contain symbolic links: '+filename);
      if(entry.isDirectory()) return walk(filename);
      if(!entry.isFile()) throw new TypeError('Unsupported release entry: '+filename);
      const bytes=fs.readFileSync(filename);
      return [{path:path.relative(directory,filename).split(path.sep).join('/'),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}];
    });
  }
  return walk(directory).sort((left,right)=>left.path.localeCompare(right.path,'en'));
}

/** @param {FileRecord[]} records @returns {number} */
function totalBytes(records) { return records.reduce((total,record)=>total+record.bytes,0); }

/** @param {string} owner @param {string} target @returns {void} */
function removeOwned(owner,target) {
  const absolute=owned(owner,target);
  fs.rmSync(absolute,{recursive:true,force:false});
}

/** @param {string} output @param {string} stagedApp @returns {void} */
function stageSources(output,stagedApp) {
  within(output,stagedApp);
  const desktop=path.join(root,'desktop');
  fs.cpSync(desktop,stagedApp,{recursive:true,errorOnExist:true,force:false,filter:filename=>{
    const relative=path.relative(desktop,filename).split(path.sep).join('/');
    return relative!=='app-server' && !relative.startsWith('app-server/') && !excluded.test('/'+relative);
  }});
  const server=path.join(stagedApp,'app-server');
  fs.mkdirSync(server);
  fs.copyFileSync(path.join(root,'server.js'),path.join(server,'server.js'),fs.constants.COPYFILE_EXCL);
  for(const name of ['lib','public']) fs.cpSync(path.join(root,name),path.join(server,name),{recursive:true,errorOnExist:true,force:false,filter:filename=>{
    const relative=path.relative(path.join(root,'public','vendor'),filename);
    return relative.startsWith('..'+path.sep) || path.isAbsolute(relative) || !/\.d\.(?:ts|mts)$/.test(filename);
  }});
  fs.writeFileSync(path.join(server,'package.json'),JSON.stringify({name:'deepscord-server',private:true,main:'server.js'})+'\n',{flag:'wx'});
  inventory(stagedApp);
}

/** @param {string} temporary @param {import('@electron/packager').HookFunctionArgs} input @returns {Promise<void>} */
async function pruneLocales(temporary,input) {
  const build=owned(temporary,input.buildPath);
  if(input.platform!=='win32' || input.arch!=='x64') throw new TypeError('Only Windows x64 packaging is supported');
  const directory=owned(build,path.join(build,'locales'));
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
    if(!entry.isFile() || !entry.name.endsWith('.pak')) throw new TypeError('Unexpected Electron locale entry: '+entry.name);
    if(!locales.has(entry.name)) fs.unlinkSync(owned(directory,path.join(directory,entry.name)));
  }
}

/** @param {string} temporary @param {import('@electron/packager').HookFunctionArgs} input @returns {Promise<void>} */
async function pruneApp(temporary,input) {
  const app=owned(temporary,input.buildPath);
  for(const name of ['linux64','osx']) removeOwned(app,path.join(app,'node_modules','steamworks.js','dist',name));
  fs.unlinkSync(owned(app,path.join(app,'node_modules','steamworks.js','dist','win64','steam_api64.lib')));
  for(const name of ['@types/node','undici-types']) {
    const directory=owned(app,path.join(app,'node_modules',name));
    for(const entry of fs.readdirSync(directory)) if(entry!=='LICENSE') removeOwned(directory,path.join(directory,entry));
  }
  const steam=owned(app,path.join(app,'node_modules','steamworks.js'));
  for(const entry of fs.readdirSync(steam)) if(entry.endsWith('.d.ts') || entry==='README.md') fs.unlinkSync(owned(steam,path.join(steam,entry)));
}

/** @param {FileRecord[]} records @returns {void} */
function verifyContents(records) {
  const names=new Set(records.map(record=>record.path));
  for(const filename of [...runtimeRequirements,...appRequirements.map(name=>'resources/app/'+name),...resourceExampleFiles.map(name=>'mods/'+name),...[...locales].map(name=>'locales/'+name)]) if(!names.has(filename)) throw new Error('Required runtime or feature file is missing: '+filename);
  for(const record of records) {
    const filename=record.path;
    if(filename.startsWith('locales/') && !locales.has(path.posix.basename(filename))) throw new Error('Unexpected locale shipped: '+filename);
    if(/^resources\/app\/node_modules\/steamworks.js\/dist\/(linux64|osx)\//.test(filename) || filename.endsWith('.d.ts') || filename.endsWith('.lib') || filename.endsWith('.obj') || filename.endsWith('.pdb')) throw new Error('Development or foreign-platform payload shipped: '+filename);
    if(filename.startsWith('resources/app/') && excluded.test('/'+filename.slice('resources/app/'.length))) throw new Error('Excluded development input shipped: '+filename);
    if(filename.startsWith('mods/')&&!resourceExampleFiles.includes(filename.slice('mods/'.length)))throw new Error('Unregistered or personal resource state shipped: '+filename);
  }
}

/** @param {FileRecord[]} records @param {FileRecord[]} baseline */
function compareBaseline(records,baseline) {
  const current=new Map(records.map(record=>[record.path,record]));
  const previous=new Map(baseline.map(record=>[record.path,record]));
  const protectedFiles=baseline.filter(record=>!record.path.includes('/') || record.path.startsWith('resources/app/native/bin/') || /(?:LICENSE|NOTICE)/i.test(record.path) || /^resources\/app\/node_modules\/steamworks.js\/dist\/win64\/.*\.(?:dll|node)$/.test(record.path) || record.path.startsWith('locales/') && locales.has(path.posix.basename(record.path)));
  for(const record of protectedFiles) if(current.get(record.path)?.sha256!==record.sha256) throw new Error('Protected runtime, native helper or license changed from baseline: '+record.path);
  return {bytes:totalBytes(baseline),savedBytes:totalBytes(baseline)-totalBytes(records),protectedFiles:protectedFiles.map(record=>record.path),removed:baseline.filter(record=>!current.has(record.path)),added:records.filter(record=>!previous.has(record.path)),changed:records.filter(record=>previous.has(record.path) && previous.get(record.path)?.sha256!==record.sha256)};
}

/** @param {string} directory @returns {void} */
function verifyNativeModule(directory) {
  const app=path.join(directory,'resources','app');
  const expression='const steam=require('+JSON.stringify(path.join(app,'node_modules','steamworks.js'))+');if(typeof steam.init!=="function")throw new TypeError("Packaged Steam module does not expose init");process.stdout.write("packaged_steam_module_loaded");';
  const result=spawnSync(path.join(directory,'Deepscord.exe'),['-e',expression],{cwd:app,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,encoding:'utf8',timeout:15000});
  if(result.error) throw result.error;
  if(result.status!==0 || result.stdout!=='packaged_steam_module_loaded') throw new Error('Packaged Electron could not load its actual Windows Steam native module: '+JSON.stringify({status:result.status,signal:result.signal,stdout:result.stdout,stderr:result.stderr}));
}

/** @param {BuildInput} input @returns {Promise<void>} */
async function build(input) {
  if(fs.existsSync(input.output)) throw new Error('Output already exists; choose a new directory: '+input.output);
  const dist=fs.realpathSync(path.join(root,'dist'));
  const parent=fs.realpathSync(path.dirname(input.output));
  if(parent!==dist) within(dist,parent);
  const lock=readObject(path.join(root,'package-lock.json'));
  const electronVersion=version(object(object(lock.packages,'Lock packages')['node_modules/electron'],'Locked Electron').version,'Locked Electron version');
  const appVersion=version(readObject(path.join(root,'desktop','package.json')).version,'Desktop version');
  const zip=path.join(input.zipDirectory,`electron-v${electronVersion}-win32-x64.zip`);
  if(!fs.statSync(zip).isFile()) throw new TypeError('Electron cache must contain the pinned Windows x64 ZIP: '+zip);
  for(const filename of appRequirements.filter(name=>!name.startsWith('app-server/'))) if(!fs.statSync(path.join(root,'desktop',filename)).isFile()) throw new TypeError('Prepare local desktop dependencies and native helpers before packaging: '+filename);
  const baseline=input.baseline===null ? null : inventory(input.baseline);
  fs.mkdirSync(input.output);
  const stagedApp=path.join(input.output,'.source-app'),temporary=path.join(input.output,'.packager-temp'),packaged=path.join(input.output,'.packaged');
  fs.mkdirSync(temporary);
  stageSources(input.output,stagedApp);
  const outputs=await packager({dir:stagedApp,name:'Deepscord',executableName:'Deepscord',platform:'win32',arch:'x64',electronVersion,electronZipDir:input.zipDirectory,out:packaged,tmpdir:temporary,overwrite:false,asar:false,prune:true,junk:true,icon:path.join(root,'desktop','assets','icon.ico'),appVersion,ignore:excluded,afterExtract:[args=>pruneLocales(temporary,args)],afterPrune:[args=>pruneApp(temporary,args)]});
  if(outputs.length!==1) throw new Error('Expected exactly one Windows x64 package; received '+outputs.length);
  const destination=path.join(input.output,'Deepscord-win32-x64');
  fs.renameSync(owned(input.output,outputs[0]),destination);
  const resourceExamples=await buildResourceExamples({sourceDirectory:path.join(root,'public','customization'),destination:path.join(destination,'mods'),signal:new AbortController().signal});
  const records=inventory(destination);
  verifyContents(records);
  const comparison=baseline===null ? null : compareBaseline(records,baseline);
  verifyNativeModule(destination);
  const manifest={version:1,platform:'win32',arch:'x64',electronVersion,appVersion,asar:false,locales:[...locales],packageDirectory:'Deepscord-win32-x64',bytes:totalBytes(records),fileCount:records.length,resourceExamples,checks:{requiredRuntimeFiles:true,expectedLocales:true,excludedPayloadAbsent:true,shareableResourceExamplesValidated:true,personalResourceStateAbsent:true,packagedSteamNativeModuleLoaded:true,baselineProtectedHashesMatched:baseline!==null},electronZip:{path:zip,sha256:createHash('sha256').update(fs.readFileSync(zip)).digest('hex')},baseline:input.baseline,comparison,files:records};
  fs.writeFileSync(path.join(input.output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  removeOwned(input.output,stagedApp);
  removeOwned(input.output,temporary);
  removeOwned(input.output,packaged);
  console.log(JSON.stringify({event:'desktop_package_complete',directory:destination,bytes:manifest.bytes,fileCount:manifest.fileCount,savedBytes:comparison?.savedBytes ?? null,manifest:path.join(input.output,'manifest.json')}));
}

await build(parseArguments(process.argv.slice(2)));
