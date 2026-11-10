// @ts-check
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
/** @type {typeof import('../public/js/resource-pack.js')} */
const {parseResourcePackManifest,parseResourcePackSummary,resourceRelativePath,resourcePackId,resourceServerId}=require('./app-server/public/js/resource-pack.js');
/** @type {typeof import('../public/js/customization-protocol.js')} */
const {parseCustomInteraction}=require('./app-server/public/js/customization-protocol.js');
/** @type {typeof import('../lib/avif-codec.cjs')} */
const codec=require('./app-server/lib/avif-codec.cjs');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../public/js/resource-pack.js').PackSummary} PackSummary */
/** @typedef {import('../public/js/resource-pack.js').ResourcePackManifest} Manifest */
/** @typedef {import('../public/js/interface-scheme.js').InterfaceScheme} InterfaceScheme */
/** @typedef {import('../public/js/customization-protocol.js').CustomInteraction} CustomInteraction */
/** @typedef {import('../public/js/sticker-panel.js').StickerItem} StickerItem */
/** @typedef {import('../public/js/sticker-panel.js').StickerPreferences} StickerPreferences */
/** @typedef {PackSummary & {files:string[],schemeIds:string[],stickerIds:string[],entryFiles:string[]}} PackRecord */
/** @typedef {{format:1,packs:PackRecord[],managedStickerIds:string[]}} Registry */
/** @typedef {{root:string,readInterfaceFile:(filename:string)=>InterfaceScheme,listLegacyInterfaces:()=>{directory:string,schemes:InterfaceScheme[]},listPersonal:()=>Promise<{items:StickerItem[],preferences:StickerPreferences}>,importStickers:(inputs:{name:string,data:string}[],signal:AbortSignal)=>Promise<{items:StickerItem[],addedIds:string[]}>,removeStickers:(ids:string[])=>Promise<void>,activeThemeId:()=>string|null}} StoreOptions */
/** @param {string} filename @returns {fs.Stats|undefined} */
function stat(filename){return fs.lstatSync(filename,{throwIfNoEntry:false});}
/** @param {string} directory @returns {void} */
function realDirectory(directory){const parent=path.dirname(directory);if(parent!==directory)realDirectory(parent);const info=stat(directory);if(info&&(info.isSymbolicLink()||!info.isDirectory()))throw new TypeError('Resource directory must be a real directory: '+directory);}
/** @param {string} directory @returns {void} */
function mkdir(directory){realDirectory(directory);fs.mkdirSync(directory,{recursive:true});realDirectory(directory);}
/** @param {string} root @param {string} directory @returns {void} */
function requireContainedDirectory(root,directory){
  realDirectory(root);realDirectory(directory);
  const relative=path.relative(fs.realpathSync(root),fs.realpathSync(directory));
  if(!relative||path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))throw new TypeError('Temporary resource cleanup must remain inside its resource root: '+directory);
}
/** @param {string} root @param {string} directory @returns {void} */
function removeOwnedDirectory(root,directory){
  requireContainedDirectory(root,directory);
  let entries=0;
  /** @param {string} current @param {number} depth @returns {void} */
  function validate(current,depth){
    if(depth>36||++entries>4096)throw new RangeError('Owned resource cleanup exceeds its filesystem bounds: '+directory);
    const info=fs.lstatSync(current);
    if(info.isSymbolicLink()||!info.isFile()&&!info.isDirectory())throw new TypeError('Owned resource cleanup requires real files and directories: '+current);
    if(info.isDirectory())for(const name of fs.readdirSync(current))validate(path.join(current,name),depth+1);
  }
  validate(directory,0);
  requireContainedDirectory(root,directory);
  fs.rmSync(directory,{recursive:true});
}
/** @param {string} filename @param {number} maximum @returns {Buffer} */
function read(filename,maximum){realDirectory(path.dirname(filename));const info=fs.lstatSync(filename);if(info.isSymbolicLink()||!info.isFile()||info.size>maximum)throw new TypeError('Resource must be a regular file within '+maximum+' bytes: '+filename);return fs.readFileSync(filename);}
/** @param {string} filename @returns {JsonValue} */
function json(filename){return /** @type {JsonValue} */(JSON.parse(read(filename,2*1024*1024).toString('utf8')));}
/** @param {Buffer} data @returns {string} */
function hash(data){return createHash('sha256').update(data).digest('hex');}
/** @param {string} directory @returns {{file:string,data:Buffer}[]} */
function inventory(directory){
  realDirectory(directory);if(!stat(directory))throw new Error('Resource package directory does not exist: '+directory);
  /** @type {{file:string,data:Buffer}[]} */const files=[];let bytes=0,entries=0;
  /** @param {string} current @param {number} depth @returns {void} */
  function visit(current,depth){
    if(depth>32)throw new RangeError('Resource package exceeds 32 directory levels: '+current);
    for(const name of fs.readdirSync(current).sort()){
      if(++entries>2048)throw new RangeError('Resource package exceeds 2048 filesystem entries');
      const filename=path.join(current,name),info=fs.lstatSync(filename),relative=resourceRelativePath(path.relative(directory,filename).split(path.sep).join('/'));
      if(info.isSymbolicLink())throw new TypeError('Resource package cannot contain filesystem links: '+filename);
      if(info.isDirectory()){visit(filename,depth+1);continue;}
      if(!info.isFile()||files.length>=1024||bytes+info.size>64*1024*1024)throw new RangeError('Resource package exceeds 1024 regular files or 64 MiB: '+filename);
      const data=read(filename,64*1024*1024);bytes+=data.length;files.push({file:relative,data});
    }
  }
  visit(directory,0);return files;
}
/** @param {JsonValue|undefined} value @param {string} label @returns {string[]} */
function strings(value,label){if(!Array.isArray(value)||value.some(item=>typeof item!=='string'))throw new TypeError(label+' must be a string array');return value.map(item=>{if(typeof item!=='string')throw new TypeError(label+' contains a non-string');return item;});}
/** @param {StoreOptions} options */
function createResourcePackStore(options){
  if(!options||typeof options.root!=='string'||!path.isAbsolute(options.root))throw new TypeError('Resource pack root must be an absolute path');
  for(const callback of [options.readInterfaceFile,options.listLegacyInterfaces,options.listPersonal,options.importStickers,options.removeStickers,options.activeThemeId])if(typeof callback!=='function')throw new TypeError('Resource pack store requires all explicit callbacks');
  const root=path.resolve(options.root),registryPath=path.join(root,'registry.json'),packsDirectory=path.join(root,'packs');mkdir(root);mkdir(packsDirectory);
  /** @type {Registry} */let state={format:1,packs:[],managedStickerIds:[]};
  if(stat(registryPath)){
    const value=json(registryPath);
    if(!value||typeof value!=='object'||Array.isArray(value)||value.format!==1||!Array.isArray(value.packs)||value.packs.length>1024)throw new TypeError('Invalid resource registry: '+registryPath);
    state={format:1,managedStickerIds:strings(value.managedStickerIds,'Managed stickers'),packs:value.packs.map(value=>{
      const summary=parseResourcePackSummary(value);if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Invalid pack record');
      return {...summary,files:strings(value.files,'Owned files').map(resourceRelativePath),schemeIds:strings(value.schemeIds,'Scheme IDs'),stickerIds:strings(value.stickerIds,'Sticker IDs'),entryFiles:strings(value.entryFiles,'Entry files').map(resourceRelativePath)};
    })};
    if(new Set(state.packs.map(pack=>pack.id)).size!==state.packs.length)throw new TypeError('Resource registry contains duplicate IDs');
  }
  /** @type {Promise<void>} */let pending=Promise.resolve();
  /** @template T @param {()=>Promise<T>} operation @returns {Promise<T>} */
  function serial(operation){const result=pending.then(operation);pending=result.then(()=>{},()=>{});return result;}
  /** @param {Registry} next @returns {void} */
  function persist(next){
    const temporary=registryPath+'.pending-'+randomUUID();
    /** @type {Error|null} */let failure=null;
    try{const descriptor=fs.openSync(temporary,'wx');try{fs.writeFileSync(descriptor,JSON.stringify(next)+'\n');fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}fs.renameSync(temporary,registryPath);state=next;}
    catch(error){failure=error instanceof Error?error:new Error('Resource registry write threw a non-error value',{cause:error});throw failure;}
    finally{try{if(stat(temporary))fs.unlinkSync(temporary);}catch(cleanup){if(failure)throw new AggregateError([failure,cleanup],'Resource registry write failed and temporary cleanup was incomplete',{cause:failure});throw cleanup;}}
  }
  /** @param {PackRecord} pack @returns {string} */
  function base(pack){return pack.source==='package'?path.join(packsDirectory,pack.id):root;}
  /** @param {PackRecord} pack @returns {InterfaceScheme[]} */
  function schemes(pack){return pack.kind==='interfaces'?pack.entryFiles.map(file=>options.readInterfaceFile(path.join(base(pack),file))):[];}
  /** @param {PackRecord} pack @returns {CustomInteraction[]} */
  function interactions(pack){return pack.kind==='interactions'?pack.entryFiles.map(file=>parseCustomInteraction(json(path.join(base(pack),file)))):[];}
  /** @param {string} filename @returns {string[]} */
  function legacyThemeFiles(filename){
    const value=json(filename),owned=[filename];
    if(value&&typeof value==='object'&&!Array.isArray(value)&&value.files&&typeof value.files==='object'&&!Array.isArray(value.files))for(const field of ['html','css','script']){const relative=resourceRelativePath(value.files[field]);owned.push(path.join(path.dirname(filename),relative));}
    return owned.map(file=>resourceRelativePath(path.relative(root,file).split(path.sep).join('/')));
  }
  /** @returns {void} */
  function refreshLegacy(){
    const legacy=options.listLegacyInterfaces();
    /** @type {PackRecord[]} */const found=[];
    for(const scheme of legacy.schemes){
      const files=fs.readdirSync(legacy.directory).filter(name=>name.endsWith('.json')).map(name=>path.join(legacy.directory,name));
      const filename=files.find(file=>options.readInterfaceFile(file).id===scheme.id);if(!filename)throw new Error('Legacy theme source file is missing: '+scheme.id);
      const owned=legacyThemeFiles(filename),entry=path.relative(root,filename).split(path.sep).join('/');
      found.push({id:resourcePackId(scheme.id),name:scheme.name,version:'legacy',kind:'interfaces',entryCount:1,bytes:owned.reduce((sum,file)=>sum+read(path.join(root,file),256*1024).length,0),serverIds:[],active:false,source:'legacy',pendingRemoval:false,files:owned,entryFiles:[entry],schemeIds:[scheme.id],stickerIds:[]});
    }
    const directory=path.join(root,'interactions');
    if(stat(directory)){
      realDirectory(directory);
      for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
        if(entry.name.startsWith('.')||entry.name==='DEVELOPMENT.md')continue;
        let serverId=null,folder=directory;
        if(entry.isDirectory()){serverId=resourceServerId(entry.name);folder=path.join(directory,entry.name);realDirectory(folder);}
        else if(!entry.name.endsWith('.json'))continue;
        const names=serverId===null?[entry.name]:fs.readdirSync(folder).filter(name=>name.endsWith('.json')).sort();if(!names.length)continue;
        const files=names.map(name=>resourceRelativePath(path.relative(root,path.join(folder,name)).split(path.sep).join('/'))),drafts=files.map(file=>parseCustomInteraction(json(path.join(root,file))));
        const id=serverId===null?'legacy-example-'+hash(Buffer.from(files[0])).slice(0,16):'legacy-'+serverId;
        found.push({id:resourcePackId(id),name:serverId===null?drafts[0].name:'Server '+serverId,version:'legacy',kind:'interactions',entryCount:drafts.length,bytes:files.reduce((sum,file)=>sum+read(path.join(root,file),256*1024).length,0),serverIds:serverId===null?[]:[serverId],active:false,source:'legacy',pendingRemoval:false,files,entryFiles:files,schemeIds:[],stickerIds:[]});
      }
    }
    const retained=state.packs.filter(pack=>pack.source==='package'||pack.pendingRemoval),ids=new Set(retained.map(pack=>pack.id));
    for(const pack of found){if(ids.has(pack.id)){if(!retained.some(existing=>existing.id===pack.id&&existing.pendingRemoval))throw new Error('Legacy and package resource IDs conflict: '+pack.id);continue;}ids.add(pack.id);const previous=state.packs.find(item=>item.id===pack.id);retained.push({...pack,serverIds:[...new Set([...pack.serverIds,...(previous?.serverIds??[])])]});}
    const next={...state,packs:retained};if(JSON.stringify(next)!==JSON.stringify(state))persist(next);
  }
  /** @param {string} id @returns {PackRecord} */
  function find(id){resourcePackId(id);const pack=state.packs.find(pack=>pack.id===id);if(!pack)throw new RangeError('Resource pack is not installed: '+id);return pack;}
  /** @param {string} id @returns {void} */
  function cleanupPackageBackups(id){
    const directory=path.join(root,'.removed',resourcePackId(id));if(!stat(directory))return;
    requireContainedDirectory(root,directory);
    for(const name of fs.readdirSync(directory))if(/^(?:package|update)-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name))removeOwnedDirectory(root,path.join(directory,name));
    if(!fs.readdirSync(directory).length)fs.rmdirSync(directory);
  }
  /** @returns {Promise<{packs:PackSummary[],personal:{count:number,bytes:number,directory:string}}>} */
  function list(){return serial(async()=>{refreshLegacy();const personal=await options.listPersonal();return {packs:state.packs.map(pack=>({id:pack.id,name:pack.name,version:pack.version,kind:pack.kind,entryCount:pack.entryCount,bytes:pack.bytes,serverIds:[...pack.serverIds],active:pack.kind==='interfaces'&&pack.schemeIds.includes(options.activeThemeId()??''),source:pack.source,pendingRemoval:pack.pendingRemoval})),personal:{count:personal.items.length,bytes:personal.items.reduce((sum,item)=>sum+item.bytes,0),directory:path.join(root,'stickers')}};});}
  /** @param {string} directory @param {string|null} serverId @param {AbortSignal} signal @returns {Promise<void>} */
  function install(directory,serverId,signal){return serial(async()=>{
    signal.throwIfAborted();if(typeof directory!=='string'||!path.isAbsolute(directory))throw new TypeError('Resource package directory must be absolute');if(serverId!==null)resourceServerId(serverId);
    refreshLegacy();const files=inventory(directory),manifestFile=files.find(file=>file.file==='pack.json');
    if(!manifestFile)throw new TypeError('Resource package requires pack.json at its root');
    const manifest=parseResourcePackManifest(/** @type {JsonValue} */(JSON.parse(manifestFile.data.toString('utf8')))),previous=state.packs.find(pack=>pack.id===manifest.id);
    if(previous?.pendingRemoval)throw new Error('Finish removing this resource pack before installing it again: '+manifest.id);
    if(previous&&previous.kind!==manifest.kind)throw new TypeError('Resource pack update cannot change kind: '+manifest.id);
    const stage=path.join(root,'.install-'+randomUUID());mkdir(stage);
    /** @type {string[]} */let addedIds=[];
    /** @type {{source:string,destination:string}[]} */const moved=[];
    let published=false,committed=false;
    /** @type {Error|null} */let failure=null;
    const destination=path.join(packsDirectory,manifest.id),backup=previous?.source==='package'?path.join(root,'.removed',manifest.id,'update-'+randomUUID()):path.join(root,'.removed',randomUUID());
    try{
      for(const file of files){signal.throwIfAborted();const target=path.join(stage,file.file);mkdir(path.dirname(target));fs.writeFileSync(target,file.data,{flag:'wx'});if(!read(target,64*1024*1024).equals(file.data))throw new Error('Resource package copy verification failed: '+file.file);}
      const entryFiles=manifest.entries.map(entry=>entry.file);
      /** @type {InterfaceScheme[]} */const definitions=[];
      /** @type {CustomInteraction[]} */const drafts=[];
      /** @type {{name:string,data:string}[]} */const inputs=[];
      for(const entry of manifest.entries){
        signal.throwIfAborted();const filename=path.join(stage,entry.file);
        if(manifest.kind==='interfaces'){if(!entry.file.endsWith('.json'))throw new TypeError('Interface entry must be JSON: '+entry.file);definitions.push(options.readInterfaceFile(filename));}
        else if(manifest.kind==='interactions'){
          if(!entry.file.endsWith('.json'))throw new TypeError('Interaction entry must be JSON: '+entry.file);const draft=parseCustomInteraction(json(filename));drafts.push(draft);
          if(draft.thumbnail){const data=read(path.join(stage,'assets',draft.thumbnail.sha256+'.avif'),96*1024);if(data.length!==draft.thumbnail.bytes||hash(data)!==draft.thumbnail.sha256)throw new TypeError('Interaction thumbnail bytes do not match metadata: '+entry.file);const actual=await codec.validate(data,'server',signal);for(const field of /** @type {const} */(['width','height','frames','animated','durationMs']))if(actual[field]!==draft.thumbnail[field])throw new TypeError('Interaction thumbnail decode differs from metadata: '+entry.file);}
        }else{if(!entry.file.toLowerCase().endsWith('.avif'))throw new TypeError('Sticker entries must be AVIF: '+entry.file);inputs.push({name:entry.name,data:read(filename,160*1024).toString('base64')});}
      }
      const schemeIds=definitions.map(scheme=>scheme.id),draftIds=drafts.map(draft=>draft.id);
      if(new Set(schemeIds).size!==schemeIds.length||new Set(draftIds).size!==draftIds.length)throw new TypeError('Resource pack contains duplicate definition IDs');
      for(const pack of state.packs)if(pack.id!==manifest.id&&pack.schemeIds.some(id=>schemeIds.includes(id)))throw new TypeError('Theme ID is already owned by another resource pack: '+pack.id);
      const serverIds=[...new Set([...(previous?.serverIds??[]),...(manifest.kind==='interactions'&&serverId!==null?[serverId]:[])])];
      for(const pack of state.packs)if(pack.id!==manifest.id&&!pack.pendingRemoval&&pack.serverIds.some(id=>serverIds.includes(id))&&interactions(pack).some(draft=>draftIds.includes(draft.id)))throw new TypeError('Interaction ID is already bound to the same server by resource pack: '+pack.id);
      let stickerIds=previous?.stickerIds??[];
      if(inputs.length){const imported=await options.importStickers(inputs,signal);addedIds=imported.addedIds;stickerIds=[...new Set([...stickerIds,...imported.items.map(item=>item.id)])];}
      signal.throwIfAborted();
      if(previous){
        mkdir(backup);
        const shared=new Set(state.packs.filter(pack=>pack.id!==previous.id&&pack.source==='legacy').flatMap(pack=>pack.files));
        const owned=previous.source==='package'?[{source:destination,destination:path.join(backup,'package')}]:previous.files.filter(file=>!shared.has(file)).map(file=>({source:path.join(root,file),destination:path.join(backup,file)}));
        for(const item of owned){mkdir(path.dirname(item.destination));fs.renameSync(item.source,item.destination);moved.push(item);}
      }else if(stat(destination))throw new Error('Unregistered resource package directory already exists: '+destination);
      fs.renameSync(stage,destination);published=true;
      /** @type {PackRecord} */const record={id:manifest.id,name:manifest.name,version:manifest.version,kind:manifest.kind,entryCount:manifest.entries.length,bytes:files.reduce((sum,file)=>sum+file.data.length,0),serverIds,active:false,source:'package',pendingRemoval:false,files:files.map(file=>file.file),schemeIds,stickerIds,entryFiles};
      persist({...state,packs:[...state.packs.filter(pack=>pack.id!==manifest.id),record],managedStickerIds:[...new Set([...state.managedStickerIds,...addedIds])]});committed=true;
    }catch(error){
      /** @type {Error[]} */const rollbackErrors=[];
      try{if(published)fs.renameSync(destination,stage);for(const item of [...moved].reverse()){mkdir(path.dirname(item.source));fs.renameSync(item.destination,item.source);}}catch(rollback){rollbackErrors.push(rollback instanceof Error?rollback:new Error(String(rollback)));}
      try{if(addedIds.length)await options.removeStickers(addedIds);}catch(rollback){rollbackErrors.push(rollback instanceof Error?rollback:new Error(String(rollback)));}
      const original=error instanceof Error?error:new Error('Resource installation threw a non-error value',{cause:error});
      failure=rollbackErrors.length?new AggregateError([original,...rollbackErrors],'Resource installation failed and rollback was incomplete',{cause:original}):original;
      throw failure;
    }finally{
      try{if(stat(stage))removeOwnedDirectory(root,stage);if(!committed&&stat(backup)&&!fs.readdirSync(backup).length)fs.rmdirSync(backup);if(committed&&previous?.source==='package')cleanupPackageBackups(manifest.id);}
      catch(cleanup){if(failure)throw new AggregateError([failure,cleanup],'Resource installation failed and temporary cleanup was incomplete',{cause:failure});throw new Error('Resource pack update was committed but old package cleanup failed: '+manifest.id,{cause:cleanup});}
    }
  });}
  /** @param {string} id @returns {Promise<void>} */
  function remove(id){return serial(async()=>{
    refreshLegacy();let pack=find(id);
    if(pack.kind==='interfaces'&&pack.schemeIds.includes(options.activeThemeId()??''))throw new Error('Switch to another theme before removing this resource pack: '+pack.name);
    if(!pack.pendingRemoval){pack={...pack,pendingRemoval:true};persist({...state,packs:state.packs.map(item=>item.id===id?pack:item)});}
    const backup=path.join(root,'.removed',id);mkdir(backup);
    try{
      if(pack.source==='package'){const source=base(pack);if(stat(source)){const target=path.join(backup,'package-'+randomUUID());fs.renameSync(source,target);}cleanupPackageBackups(id);}
      else for(const file of pack.files){if(state.packs.some(item=>item.id!==id&&item.source==='legacy'&&item.files.includes(file)))continue;const source=path.join(root,file);if(stat(source)){const target=path.join(backup,file);mkdir(path.dirname(target));if(stat(target))throw new Error('Legacy removal backup already exists: '+target);fs.renameSync(source,target);}}
      const others=state.packs.filter(item=>item.id!==id),referenced=new Set(others.flatMap(item=>item.stickerIds)),removed=pack.stickerIds.filter(item=>state.managedStickerIds.includes(item)&&!referenced.has(item));
      if(removed.length)await options.removeStickers(removed);
      persist({...state,packs:others,managedStickerIds:state.managedStickerIds.filter(item=>!removed.includes(item))});
    }catch(error){throw new Error('Resource pack removal is incomplete; retry Remove for '+id,{cause:error});}
  });}
  /** @param {string} id @param {string} serverId @returns {Promise<void>} */
  function bindServer(id,serverId){return serial(async()=>{resourceServerId(serverId);refreshLegacy();const pack=find(id);if(pack.kind!=='interactions'||pack.pendingRemoval)throw new TypeError('Only installed interaction packs can be bound to a server');const ids=new Set(interactions(pack).map(draft=>draft.id));for(const other of state.packs)if(other.id!==id&&!other.pendingRemoval&&other.serverIds.includes(serverId)&&interactions(other).some(draft=>ids.has(draft.id)))throw new TypeError('Interaction ID is already bound to the same server by resource pack: '+other.id);persist({...state,packs:state.packs.map(item=>item.id===id?{...item,serverIds:[...new Set([...item.serverIds,serverId])]}:item)});});}
  /** @returns {Promise<InterfaceScheme[]>} */
  function interfaceSchemes(){return serial(async()=>{refreshLegacy();return state.packs.filter(pack=>!pack.pendingRemoval).flatMap(schemes);});}
  /** @param {string} serverId @returns {Promise<{interactions:CustomInteraction[]}>} */
  function interactionDrafts(serverId){return serial(async()=>{resourceServerId(serverId);refreshLegacy();const drafts=state.packs.filter(pack=>!pack.pendingRemoval&&pack.serverIds.includes(serverId)).flatMap(interactions);if(new Set(drafts.map(draft=>draft.id)).size!==drafts.length)throw new TypeError('Bound interaction packs contain duplicate interaction IDs for server: '+serverId);return {interactions:drafts};});}
  /** @param {PackRecord} pack @param {string} sha256 @returns {Buffer|null} */
  function asset(pack,sha256){if(!/^[a-f0-9]{64}$/.test(sha256))throw new TypeError('Interaction asset requires a SHA256');if(pack.source==='legacy'||pack.kind!=='interactions'||pack.pendingRemoval||!interactions(pack).some(draft=>draft.thumbnail?.sha256===sha256))return null;const data=read(path.join(base(pack),'assets',sha256+'.avif'),96*1024);if(hash(data)!==sha256)throw new TypeError('Stored interaction asset hash differs: '+sha256);return data;}
  /** @param {string} id @param {string} sha256 @returns {Promise<Buffer|null>} */
  function interactionAsset(id,sha256){return serial(async()=>asset(find(id),sha256));}
  /** @param {string} serverId @param {string} interactionId @param {string} sha256 @returns {Promise<Buffer|null>} */
  function interactionAssetForServer(serverId,interactionId,sha256){return serial(async()=>{resourceServerId(serverId);refreshLegacy();const matches=state.packs.filter(pack=>!pack.pendingRemoval&&pack.serverIds.includes(serverId)&&interactions(pack).some(draft=>draft.id===interactionId&&draft.thumbnail?.sha256===sha256));if(matches.length>1)throw new TypeError('Duplicate bound interaction asset ownership: '+interactionId);return matches.length?asset(matches[0],sha256):null;});}
  /** @param {string} id @returns {Promise<string>} */
  function packDirectory(id){return serial(async()=>{refreshLegacy();const pack=find(id);return pack.source==='package'?base(pack):path.dirname(path.join(root,pack.entryFiles[0]));});}
  return {list,install,remove,bindServer,interfaceSchemes,interactionDrafts,interactionAsset,interactionAssetForServer,packDirectory};
}
module.exports={createResourcePackStore};
