// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
if(process.argv.length!==4||process.argv[2]!=='--output')throw new TypeError('Usage: node tools/avif-codec/fetch-fixtures.mjs --output PATH');
const output=path.resolve(process.argv[3]),relative=path.relative(root,output);
if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new TypeError('Fixture output must be inside the project');
fs.mkdirSync(output,{recursive:true});if(fs.realpathSync(output)!==output)throw new TypeError('Fixture output cannot be redirected');
const commit='c5240fc79fe5c2407e10afd35f5505ef6333ea49';
const files=[
  {name:'abc_color_irot_alpha_irot.avif',bytes:10597,gitBlob:'e5f8141cfa06ac705f3bcbec89d0e6470788bb6b'},
  {name:'clap_irot_imir_non_essential.avif',bytes:653,gitBlob:'bcbe87dd30d567a7e74473ac91f5849f24a7f14c'},
  {name:'paris_icc_exif_xmp.avif',bytes:21132,gitBlob:'c66de3a5ae2a663ce2c08a5ae67166ed4c7db52c'},
  {name:'colors_hdr_srgb.avif',bytes:28030,gitBlob:'ad596ddd22365d829487a6f9135a981190789bcd'},
  {name:'seine_hdr_gainmap_small_srgb.avif',bytes:102004,gitBlob:'929f4e4fda01efa4744e25003f6f12aed4d8286c'}
];
/** @param {Buffer} bytes @returns {string} */
function blobHash(bytes){return createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');}
const manifest=[];
for(const file of files){
  const filename=path.join(output,file.name),url='https://cdn.jsdelivr.net/gh/AOMediaCodec/libavif@'+commit+'/tests/data/'+file.name;
  let bytes=fs.existsSync(filename)?fs.readFileSync(filename):Buffer.alloc(0);
  if(bytes.length!==file.bytes||blobHash(bytes)!==file.gitBlob)for(let attempt=1;attempt<=3;attempt++){
    try{const response=await fetch(url,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('Fixture HTTP '+response.status+' from '+url);bytes=Buffer.from(await response.arrayBuffer());if(bytes.length!==file.bytes||blobHash(bytes)!==file.gitBlob)throw new Error('Upstream fixture integrity mismatch: '+file.name);fs.writeFileSync(filename,bytes);break;}
    catch(error){console.warn('avif_fixture_download_retry',{url,attempt,message:error instanceof Error?error.message:String(error)});if(attempt===3)throw error;}
  }
  manifest.push({...file,url,sha256:createHash('sha256').update(bytes).digest('hex')});
}
fs.copyFileSync(path.join(root,'public/vendor/avif/libavif-LICENSE'),path.join(output,'LICENSE'));
fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify({commit,license:'LICENSE',source:'https://github.com/AOMediaCodec/libavif/blob/'+commit+'/tests/data/README.md',files:manifest},null,2)+'\n');
