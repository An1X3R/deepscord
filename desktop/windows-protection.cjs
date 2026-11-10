// @ts-check
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const MAGIC=Buffer.from('DSDP001\0');
const MAX_BYTES=4*1024*1024;
/** @returns {string} */
function executable(){if(process.platform!=='win32'||!process.env.SystemRoot)throw new Error('Room key protection requires Windows');const filename=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');if(!fs.statSync(filename).isFile())throw new Error('Windows DPAPI helper is unavailable');return filename;}
/** @param {'protect'|'unprotect'} operation @param {Buffer} input @returns {Promise<Buffer>} */
function invoke(operation,input){
  if(input.length>MAX_BYTES+65536)throw new RangeError('Windows protection input exceeds its storage budget');
  const child=spawn(executable(),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'windows-protection.ps1'),operation],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  return new Promise((resolve,reject)=>{
    /** @type {Buffer[]} */const chunks=[];let bytes=0,errors='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('Windows DPAPI operation timed out'));},30000);
    child.once('error',reject);child.stdin.once('error',reject);
    child.stdout.on('data',(/** @type {Buffer} */chunk)=>{bytes+=chunk.length;if(bytes>8*1024*1024){child.kill();reject(new RangeError('Windows DPAPI response exceeds its storage budget'));}else chunks.push(chunk);});
    child.stderr.on('data',(/** @type {Buffer} */chunk)=>{errors=(errors+chunk.toString('utf8')).slice(0,8192);});
    child.once('close',code=>{clearTimeout(timer);if(code!==0){reject(new Error('Windows DPAPI '+operation+' failed',{cause:new Error(JSON.stringify({exitCode:code,diagnostic:errors}))}));return;}const text=Buffer.concat(chunks).toString('ascii'),result=Buffer.from(text,'base64');if(result.length>MAX_BYTES+65536||result.toString('base64')!==text){reject(new TypeError('Windows DPAPI response has an invalid encoding'));return;}resolve(result);});
    child.stdin.end(input.toString('base64'));
  });
}
/** @returns {Promise<boolean>} */
async function isAsyncEncryptionAvailable(){executable();return true;}
/** @param {string} text @returns {Promise<Buffer>} */
async function encryptStringAsync(text){if(typeof text!=='string'||Buffer.byteLength(text)>MAX_BYTES)throw new RangeError('Protected text exceeds its storage budget');const bytes=Buffer.from(text);try{return Buffer.concat([MAGIC,await invoke('protect',bytes)]);}finally{bytes.fill(0);}}
/** @param {Buffer} input @returns {Promise<{result:string,shouldReEncrypt:boolean}>} */
async function decryptStringAsync(input){if(!Buffer.isBuffer(input)||!input.subarray(0,MAGIC.length).equals(MAGIC))throw new TypeError('Unsupported Windows room key protection format');const bytes=await invoke('unprotect',input.subarray(MAGIC.length));try{const result=bytes.toString('utf8');if(!Buffer.from(result).equals(bytes))throw new TypeError('Windows protected text is not UTF-8');return {result,shouldReEncrypt:false};}finally{bytes.fill(0);}}
module.exports={isAsyncEncryptionAvailable,encryptStringAsync,decryptStringAsync};
