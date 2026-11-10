// @ts-check
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {execFile}=require('node:child_process');
/** @typedef {{archive:string,destination:string,signal:AbortSignal}} ResourceArchiveOptions */
/** @param {string} directory @returns {void} */
function requireRealDirectory(directory){
  const parent=path.dirname(directory);if(parent!==directory)requireRealDirectory(parent);
  const info=fs.lstatSync(directory);
  if(info.isSymbolicLink()||!info.isDirectory())throw new TypeError('Resource archive path requires real directories: '+directory);
}
/** @param {string} value @param {string} label @returns {string} */
function absolute(value,label){if(typeof value!=='string'||!path.isAbsolute(value)||value.includes('\0'))throw new TypeError(label+' must be an absolute path');return path.resolve(value);}
/** @param {ResourceArchiveOptions} options @returns {Promise<void>} */
async function extractResourceArchive(options){
  if(!options||typeof options!=='object'||!(options.signal instanceof AbortSignal))throw new TypeError('Resource archive extraction requires archive, destination and AbortSignal');
  options.signal.throwIfAborted();
  if(process.platform!=='win32')throw new Error('Resource archive extraction requires Windows PowerShell and .NET ZipArchive');
  const archive=absolute(options.archive,'Resource archive'),destination=absolute(options.destination,'Extraction destination');
  requireRealDirectory(path.dirname(archive));requireRealDirectory(destination);
  const info=fs.lstatSync(archive);
  if(info.isSymbolicLink()||!info.isFile()||info.size>64*1024*1024)throw new TypeError('Resource archive must be a regular ZIP file within 64 MiB: '+archive);
  if(path.basename(path.dirname(destination))!=='.imports'||fs.readdirSync(destination).length)throw new TypeError('Extraction destination must be a new empty directory directly under .imports: '+destination);
  await new Promise((resolve,reject)=>{
    execFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'resource-archive.ps1'),'-Archive',archive,'-Destination',destination],{windowsHide:true,encoding:'utf8',signal:options.signal,timeout:120000,maxBuffer:64*1024},(error,stdout,stderr)=>{
      if(error){if(options.signal.aborted){reject(error);return;}reject(new Error('Resource ZIP extraction failed: archive='+archive+'; destination='+destination+'; exit='+String(error.code)+'; stderr='+stderr.trim()+'; stdout='+stdout.trim(),{cause:error}));return;}
      resolve(undefined);
    });
  });
}
module.exports={extractResourceArchive};
