// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {encryptStringAsync,decryptStringAsync} from '../desktop/windows-protection.cjs';

/** @param {'protect'|'unprotect'} operation @param {Buffer} input @returns {Promise<Buffer>} */
function legacy(operation,input){
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('desktop/windows-protection.ps1'),operation],{windowsHide:true,stdio:'pipe'});
    let output='',diagnostic='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('Legacy protection compatibility test timed out'));},10000);
    child.once('error',reject);child.stdin.once('error',reject);
    child.stdout.on('data',chunk=>{output+=String(chunk);});child.stderr.on('data',chunk=>{diagnostic+=String(chunk);});
    child.once('close',code=>{clearTimeout(timer);if(code!==0)reject(new Error('Legacy protection failed: '+diagnostic));else resolve(Buffer.from(output,'base64'));});
    child.stdin.end(input.toString('base64'));
  });
}

test('native DPAPI and legacy CurrentUser protection read each other without changing the DSDP001 envelope',{timeout:60000},async()=>{
  const cases=['','Public compatibility sample · 中文 · 🙂','public payload '.repeat(4096)];
  for(const text of cases){
    const old=await legacy('protect',Buffer.from(text));
    assert.deepEqual(await decryptStringAsync(Buffer.concat([Buffer.from('DSDP001\0'),old])),{result:text,shouldReEncrypt:false});
    const native=await encryptStringAsync(text);
    assert.equal(native.subarray(0,8).toString(),'DSDP001\0');
    assert.equal((await legacy('unprotect',native.subarray(8))).toString('utf8'),text);
  }
  const ciphertext=await encryptStringAsync('public corruption check');ciphertext[ciphertext.length-1]^=1;
  await assert.rejects(decryptStringAsync(ciphertext),/unprotect failed/);
  await assert.rejects(encryptStringAsync('x'.repeat(4*1024*1024+1)),/budget/);
});
