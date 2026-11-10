// @ts-check
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');

/** @typedef {{executable:string,developmentDirectory:string,packaged:boolean,override:string|null}} ResourceLocation */
/** @typedef {{source:string,destination:string,fileCount:number,byteCount:number}} MigrationSource */
/** @typedef {{root:string,legacyUserData:string,status:'migrated'|'complete',fileCount:number,byteCount:number,sources:MigrationSource[]}} MigrationReport */
/** @typedef {{source:string,destination:string,size:number,digest:string}} MigrationFile */
/** @typedef {null|boolean|number|string|JsonValue[]|{[key:string]:JsonValue}} JsonValue */
const MARKER='.portable-migration-v1.json';
const MAX_ENTRIES=20000;
const MAX_BYTES=256*1024*1024;
const MAX_FILE_BYTES=64*1024*1024;

/** @param {string} value @param {string} label @returns {string} */
function absolutePath(value,label){
  if(typeof value!=='string'||!value.trim()||value.includes('\0')||!path.isAbsolute(value))throw new TypeError(label+' must be an absolute filesystem path');
  return path.resolve(value);
}

/** @param {ResourceLocation} options @returns {string} */
function resolveResourceRoot(options){
  if(!options||typeof options!=='object'||typeof options.packaged!=='boolean')throw new TypeError('Resource location requires explicit packaged state');
  const executable=absolutePath(options.executable,'Executable');
  const developmentDirectory=absolutePath(options.developmentDirectory,'Development directory');
  if(options.override!==null)return absolutePath(options.override,'Resource override');
  return path.join(options.packaged?path.dirname(executable):developmentDirectory,'mods');
}

/** @param {string} target @returns {import('node:fs').Stats|undefined} */
function inspect(target){return fs.lstatSync(target,{throwIfNoEntry:false});}

/** @param {string} target @returns {void} */
function requireRealAncestors(target){
  const parent=path.dirname(target);
  if(parent!==target)requireRealAncestors(parent);
  const stat=inspect(target);
  if(stat&&(stat.isSymbolicLink()||!stat.isDirectory()))throw new TypeError('Portable resource path must contain only real directories: '+target);
}

/** @param {string} target @returns {void} */
function ensureDirectory(target){
  requireRealAncestors(target);
  fs.mkdirSync(target,{recursive:true});
  requireRealAncestors(target);
}

/** @param {string} target @returns {string} */
function digestFile(target){
  const stat=fs.lstatSync(target);
  if(stat.isSymbolicLink()||!stat.isFile())throw new TypeError('Portable migration requires a regular file: '+target);
  if(stat.size>MAX_FILE_BYTES)throw new RangeError('Portable migration file exceeds 64 MiB: '+target);
  return createHash('sha256').update(fs.readFileSync(target)).digest('hex');
}

/** @param {string} root @returns {void} */
function verifyWritable(root){
  const probe=path.join(root,'.portable-write-'+randomUUID()+'.tmp');
  try{fs.writeFileSync(probe,'portable resources\n',{flag:'wx'});}
  catch(error){throw new Error('Portable resources directory is not writable: '+root,{cause:error});}
  fs.unlinkSync(probe);
}

/** @param {string} parent @param {string} child @returns {boolean} */
function contains(parent,child){const relative=path.relative(parent,child);return !relative||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));}

/** @param {string} filename @param {string} root @param {string} legacyUserData @returns {MigrationReport} */
function readCompletedReport(filename,root,legacyUserData){
  const stat=fs.lstatSync(filename);
  if(stat.isSymbolicLink()||!stat.isFile()||stat.size>64*1024)throw new TypeError('Invalid portable migration marker: '+filename);
  const data=/** @type {JsonValue} */(JSON.parse(fs.readFileSync(filename,'utf8')));
  if(!data||typeof data!=='object'||Array.isArray(data)||data.version!==1||data.status!=='migrated'||typeof data.root!=='string'||typeof data.legacyUserData!=='string'||!Array.isArray(data.sources)||data.sources.length!==2)throw new TypeError('Portable migration marker does not match resource location schema: '+filename);
  const originalRoot=absolutePath(data.root,'Migration marker root'),originalLegacy=absolutePath(data.legacyUserData,'Migration marker legacy user data');
  /** @type {MigrationSource[]} */
  const sources=[];
  for(const [index,item] of data.sources.entries()){
    if(!item||typeof item!=='object'||Array.isArray(item)||typeof item.source!=='string'||typeof item.destination!=='string'||typeof item.fileCount!=='number'||!Number.isSafeInteger(item.fileCount)||item.fileCount<0||typeof item.byteCount!=='number'||!Number.isSafeInteger(item.byteCount)||item.byteCount<0)throw new TypeError('Invalid portable migration source record: '+filename);
    const expectedSource=path.join(originalLegacy,index===0?'customization':'stickers'),expectedDestination=index===0?originalRoot:path.join(originalRoot,'stickers');
    if(item.source!==expectedSource||item.destination!==expectedDestination)throw new TypeError('Invalid portable migration source paths: '+filename);
    sources.push({source:item.source,destination:index===0?root:path.join(root,'stickers'),fileCount:item.fileCount,byteCount:item.byteCount});
  }
  const fileCount=sources.reduce((total,item)=>total+item.fileCount,0),byteCount=sources.reduce((total,item)=>total+item.byteCount,0);
  if(data.fileCount!==fileCount||data.byteCount!==byteCount||fileCount>MAX_ENTRIES||byteCount>MAX_BYTES)throw new TypeError('Invalid portable migration totals: '+filename);
  return {root,legacyUserData,status:'complete',fileCount,byteCount,sources};
}

/** @param {string} destination @param {Buffer} data @returns {void} */
function publishFile(destination,data){
  const temporary=path.join(path.dirname(destination),'.portable-copy-'+randomUUID()+'.tmp');
  try{
    fs.writeFileSync(temporary,data,{flag:'wx'});
    const descriptor=fs.openSync(temporary,'r+');
    try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
    if(!fs.readFileSync(temporary).equals(data))throw new Error('Portable migration temporary file verification failed: '+temporary);
    fs.linkSync(temporary,destination);
  }finally{if(inspect(temporary))fs.unlinkSync(temporary);}
}

/** @param {{root:string,legacyUserData:string}} options @returns {MigrationReport} */
function initializePortableResources(options){
  if(!options||typeof options!=='object')throw new TypeError('Portable resources require root and legacyUserData paths');
  const root=absolutePath(options.root,'Resource root'),legacyUserData=absolutePath(options.legacyUserData,'Legacy user data');
  const legacySources=[path.join(legacyUserData,'customization'),path.join(legacyUserData,'stickers')];
  if(contains(root,legacyUserData)||legacySources.some(source=>contains(source,root)||contains(root,source)))throw new TypeError('Portable resource root and migrated legacy sources must not overlap: '+root+'; '+legacyUserData);
  ensureDirectory(root);verifyWritable(root);
  const marker=path.join(root,MARKER);
  if(inspect(marker))return readCompletedReport(marker,root,legacyUserData);
  requireRealAncestors(legacyUserData);
  /** @type {MigrationFile[]} */
  const files=[];
  /** @type {string[]} */
  const directories=[];
  /** @type {MigrationSource[]} */
  const sources=[];
  /** @type {Map<string,MigrationFile>} */
  const destinations=new Map();
  let entries=0,byteCount=0;
  /** @param {string} source @param {string} destination @param {number} depth @returns {void} */
  function collect(source,destination,depth){
    entries+=1;
    if(entries>MAX_ENTRIES)throw new RangeError('Portable migration exceeds 20000 entries at: '+source);
    if(depth>64)throw new RangeError('Portable migration exceeds 64 directory levels at: '+source);
    const stat=fs.lstatSync(source);
    if(stat.isSymbolicLink())throw new TypeError('Portable migration does not follow filesystem links: '+source);
    if(destination===marker)throw new TypeError('Legacy resource conflicts with portable migration metadata: '+source);
    if(stat.isDirectory()){
      requireRealAncestors(destination);directories.push(destination);
      for(const name of fs.readdirSync(source).sort())collect(path.join(source,name),path.join(destination,name),depth+1);
      return;
    }
    if(!stat.isFile())throw new TypeError('Portable migration requires a file or directory: '+source);
    const relative=path.relative(root,destination).split(path.sep).join('/');
    if(['RESOURCE_PACKS.md','interfaces/DEVELOPMENT.md','interactions/DEVELOPMENT.md'].includes(relative))return;
    byteCount+=stat.size;
    if(byteCount>MAX_BYTES)throw new RangeError('Portable migration exceeds 256 MiB at: '+source);
    requireRealAncestors(path.dirname(destination));
    const digest=digestFile(source),existing=inspect(destination);
    const planned=destinations.get(destination);
    if(planned&&(planned.size!==stat.size||planned.digest!==digest))throw new Error('Portable migration sources conflict at destination: '+planned.source+'; '+source+' -> '+destination);
    if(existing&&(existing.isSymbolicLink()||!existing.isFile()||existing.size!==stat.size||digestFile(destination)!==digest))throw new Error('Portable migration file conflict; original and destination preserved: '+source+' -> '+destination);
    const file={source,destination,size:stat.size,digest};
    destinations.set(destination,file);files.push(file);
  }
  for(const mapping of [{source:path.join(legacyUserData,'customization'),destination:root},{source:path.join(legacyUserData,'stickers'),destination:path.join(root,'stickers')}]){
    const before=files.length,beforeBytes=byteCount,stat=inspect(mapping.source);
    if(stat){
      if(stat.isSymbolicLink()||!stat.isDirectory())throw new TypeError('Legacy resource root must be a real directory: '+mapping.source);
      collect(mapping.source,mapping.destination,0);
    }
    sources.push({...mapping,fileCount:files.length-before,byteCount:byteCount-beforeBytes});
  }
  for(const directory of directories)ensureDirectory(directory);
  for(const file of files){
    if(digestFile(file.source)!==file.digest)throw new Error('Legacy resource changed during migration: '+file.source);
    if(!inspect(file.destination))publishFile(file.destination,fs.readFileSync(file.source));
    if(digestFile(file.destination)!==file.digest)throw new Error('Portable migration destination verification failed: '+file.source+' -> '+file.destination);
  }
  const report={root,legacyUserData,status:/** @type {const} */('migrated'),fileCount:files.length,byteCount,sources};
  publishFile(marker,Buffer.from(JSON.stringify({version:1,...report})+'\n'));
  return report;
}

module.exports={resolveResourceRoot,initializePortableResources};
