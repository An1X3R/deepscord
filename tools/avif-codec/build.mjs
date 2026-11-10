// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

/** @typedef {import('../../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{version:string,url:string,filename:string,bytes:number,sha256:string}} Dependency */
/** @typedef {{path:string,bytes:number,gitBlob:string,sha256:string}} SourceFile */
const root=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
const own=path.join(root,'tools/avif-codec');

/** @param {string} parent @param {string} target @returns {string} */
function inside(parent,target) {
  const absolute=path.resolve(target),relative=path.relative(fs.realpathSync(parent),absolute);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)) throw new TypeError('AVIF build target must be strictly inside '+parent+': '+absolute);
  if(fs.existsSync(absolute)&&fs.realpathSync(absolute)!==absolute) throw new TypeError('AVIF build refuses a redirected path: '+absolute);
  return absolute;
}

/** @param {JsonValue|undefined} value @param {string} name @returns {{[key:string]:JsonValue}} */
function object(value,name) { if(!value||typeof value!=='object'||Array.isArray(value)) throw new TypeError(name+' must be an object');return value; }
/** @param {JsonValue|undefined} value @param {string} name @returns {string} */
function string(value,name) { if(typeof value!=='string'||!value.length) throw new TypeError(name+' must be a nonempty string');return value; }
/** @param {JsonValue|undefined} value @param {string} name @returns {number} */
function number(value,name) { if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1) throw new TypeError(name+' must be a positive integer');return value; }
/** @param {string} filename @returns {string} */
function hash(filename) { return createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); }

/** @param {string[]} argv @returns {Map<string,string>} */
function argumentsMap(argv) {
  const allowed=new Set(['--cache','--python','--cmake','--ninja','--perl','--jobs']);
  /** @type {Map<string,string>} */ const result=new Map();
  for(let index=0;index<argv.length;index+=2) {
    const name=argv[index],value=argv[index+1];
    if(!name||!value||!allowed.has(name)||result.has(name)) throw new TypeError('Required build arguments: --cache PATH --python PATH --cmake PATH --ninja PATH --perl PATH --jobs INTEGER');
    result.set(name,value);
  }
  if(result.size!==allowed.size) throw new TypeError('Every AVIF build argument must be provided explicitly');
  return result;
}

/** @param {Dependency} dependency @param {string} cache @returns {Promise<string>} */
async function download(dependency,cache) {
  const target=inside(cache,path.join(cache,dependency.filename));
  if(fs.existsSync(target)&&fs.statSync(target).size===dependency.bytes&&hash(target)===dependency.sha256) return target;
  for(let attempt=1;attempt<=3;attempt++) {
    try {
      const response=await fetch(dependency.url,{signal:AbortSignal.timeout(600000)});
      if(!response.ok) throw new Error(JSON.stringify({url:dependency.url,status:response.status,body:await response.text()}));
      if(!response.body) throw new Error('AVIF dependency download returned no body: '+dependency.url);
      const descriptor=fs.openSync(target,'w');
      try { for await(const chunk of response.body) fs.writeSync(descriptor,chunk); }
      finally { fs.closeSync(descriptor); }
      if(fs.statSync(target).size!==dependency.bytes||hash(target)!==dependency.sha256) throw new Error('AVIF dependency size or SHA256 mismatch: '+dependency.url);
      return target;
    } catch(error) {
      console.warn(JSON.stringify({event:'avif-dependency-retry',url:dependency.url,attempt,error:String(error)}));
      if(attempt===3) throw error;
    }
  }
  throw new Error('AVIF dependency download did not complete');
}

/** @param {string} executable @param {string[]} args @param {NodeJS.ProcessEnv} environment @returns {string} */
function command(executable,args,environment) {
  const result=spawnSync(executable,args,{cwd:root,env:environment,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
  if(result.error) throw result.error;
  if(result.status!==0) throw new Error(JSON.stringify({event:'avif-build-command-failed',executable,args,status:result.status,stdout:result.stdout,stderr:result.stderr}));
  return result.stdout+result.stderr;
}

/** @param {string} archive @param {string} destination @param {string[]} extractionArgs @returns {void} */
function extract(archive,destination,extractionArgs) {
  fs.mkdirSync(destination,{recursive:true});
  inside(root,destination);
  for(const entry of command('tar.exe',['-tf',archive],process.env).split(/\r?\n/).filter(Boolean)) {
    if(path.isAbsolute(entry)||entry.split(/[\\/]/).includes('..')) throw new TypeError('Unsafe dependency archive entry: '+entry);
  }
  command('tar.exe',['-xf',archive,'-C',destination,...extractionArgs],process.env);
}

const args=argumentsMap(process.argv.slice(2));
const cache=inside(root,path.resolve(string(args.get('--cache'),'--cache')));
fs.mkdirSync(cache,{recursive:true});
const python=fs.realpathSync(string(args.get('--python'),'--python'));
const cmake=fs.realpathSync(string(args.get('--cmake'),'--cmake'));
const ninja=fs.realpathSync(string(args.get('--ninja'),'--ninja'));
const perl=fs.realpathSync(string(args.get('--perl'),'--perl'));
const jobs=Number(string(args.get('--jobs'),'--jobs'));
if(!Number.isInteger(jobs)||jobs<1||jobs>64) throw new RangeError('--jobs must be from 1 through 64');
if(!command(cmake,['--version'],process.env).startsWith('cmake version 3.31.6-msvc6')) throw new TypeError('AVIF build requires CMake 3.31.6-msvc6');
if(command(ninja,['--version'],process.env).trim()!=='1.12.1') throw new TypeError('AVIF build requires Ninja 1.12.1');
if(command(perl,['-e','print $^V'],process.env).trim()!=='v5.36.0') throw new TypeError('AVIF build requires Perl 5.36.0');
const raw=object(JSON.parse(fs.readFileSync(path.join(own,'dependencies.json'),'utf8')),'dependencies');
/** @param {string} key @returns {Dependency} */
function dependency(key) {
  const entry=object(raw[key],key);
  return {version:string(entry.version,key+'.version'),url:string(entry.url,key+'.url'),filename:string(entry.filename,key+'.filename'),bytes:number(entry.bytes,key+'.bytes'),sha256:string(entry.sha256,key+'.sha256')};
}
const sdkArchive=await download(dependency('emscripten'),cache),aomArchive=await download(dependency('libaom'),cache);
const sdk=inside(cache,path.join(cache,'sdk/install')),aom=inside(cache,path.join(cache,'aom')),source=inside(cache,path.join(cache,'libavif-files'));
if(!fs.existsSync(path.join(sdk,'emscripten/emcc.exe'))) extract(sdkArchive,path.dirname(sdk),[]);
if(!fs.existsSync(path.join(aom,'CMakeLists.txt'))) extract(aomArchive,aom,['--strip-components','1']);
const sourceManifest=object(JSON.parse(fs.readFileSync(path.join(own,'libavif-files.json'),'utf8')),'libavif sources');
const commit=string(sourceManifest.commit,'libavif.commit');
if(!Array.isArray(sourceManifest.files)) throw new TypeError('libavif sources must contain a file array');
/** @type {SourceFile[]} */ const files=sourceManifest.files.map(value=>{
  const entry=object(value,'source file');
  return {path:string(entry.path,'source.path'),bytes:number(entry.bytes,'source.bytes'),gitBlob:string(entry.gitBlob,'source.gitBlob'),sha256:string(entry.sha256,'source.sha256')};
});
fs.mkdirSync(source,{recursive:true});
for(let offset=0;offset<files.length;offset+=12) await Promise.all(files.slice(offset,offset+12).map(async file=>{
  const target=inside(source,path.join(source,file.path));
  if(fs.existsSync(target)&&fs.statSync(target).size===file.bytes&&hash(target)===file.sha256) return;
  const url='https://cdn.jsdelivr.net/gh/AOMediaCodec/libavif@'+commit+'/'+file.path;
  for(let attempt=1;attempt<=3;attempt++) {
    try {
      const response=await fetch(url,{signal:AbortSignal.timeout(30000)});
      if(!response.ok) throw new Error(JSON.stringify({url,status:response.status,body:await response.text()}));
      const bytes=Buffer.from(await response.arrayBuffer());
      if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256) throw new Error('libavif source SHA256 mismatch: '+file.path);
      fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);return;
    } catch(error) {console.warn(JSON.stringify({event:'avif-source-retry',url,attempt,error:String(error)}));if(attempt===3) throw error;}
  }
}));
const config=inside(cache,path.join(cache,'emscripten-config.py'));
fs.writeFileSync(config,'LLVM_ROOT = '+JSON.stringify(path.join(sdk,'bin'))+'\nBINARYEN_ROOT = '+JSON.stringify(sdk)+'\nNODE_JS = ['+JSON.stringify(process.execPath)+']\n');
const environment={...process.env,EM_CONFIG:config,EMSDK_PYTHON:python,PATH:path.dirname(cmake)+path.delimiter+path.dirname(ninja)+path.delimiter+process.env.PATH};
const compiler=path.join(sdk,'emscripten/emcc.exe');
if(!command(compiler,['--version'],environment).includes('6.0.12-git')) throw new TypeError('AVIF build requires Emscripten 6.0.12');
const flags='-Os -flto -msimd128';
const shared=['-G','Ninja','-DCMAKE_MAKE_PROGRAM='+ninja,'-DCMAKE_TOOLCHAIN_FILE='+path.join(sdk,'emscripten/cmake/Modules/Platform/Emscripten.cmake'),'-DCMAKE_BUILD_TYPE=MinSizeRel','-DCMAKE_C_FLAGS='+flags,'-DCMAKE_CXX_FLAGS='+flags+' -fno-exceptions -fno-rtti'];
const aomBuild=inside(cache,path.join(cache,'build-aom'));
console.log(JSON.stringify({event:'avif-build',component:'libaom',jobs}));
command(cmake,['-S',aom,'-B',aomBuild,...shared,'-DPERL_EXECUTABLE='+perl,'-DAOM_TARGET_CPU=generic','-DENABLE_DOCS=0','-DENABLE_EXAMPLES=0','-DENABLE_TESTDATA=0','-DENABLE_TESTS=0','-DENABLE_TOOLS=0','-DCONFIG_RUNTIME_CPU_DETECT=0','-DCONFIG_WEBM_IO=0','-DCONFIG_AV1_DECODER=1','-DCONFIG_AV1_ENCODER=1','-DCONFIG_MULTITHREAD=0','-DCONFIG_AV1_HIGHBITDEPTH=1','-DCONFIG_DENOISE=0','-DBUILD_SHARED_LIBS=0'],environment);
command(cmake,['--build',aomBuild,'--target','aom','--parallel',String(jobs)],environment);
const prefix=inside(cache,path.join(cache,'prefix'));
fs.mkdirSync(path.join(prefix,'lib'),{recursive:true});fs.mkdirSync(path.join(prefix,'include'),{recursive:true});
fs.copyFileSync(path.join(aomBuild,'libaom.a'),path.join(prefix,'lib/libaom.a'));
fs.cpSync(path.join(aom,'aom'),path.join(prefix,'include/aom'),{recursive:true});
const avifBuild=inside(cache,path.join(cache,'build-avif'));
console.log(JSON.stringify({event:'avif-build',component:'libavif'}));
command(cmake,['-S',source,'-B',avifBuild,...shared,'-DCMAKE_PREFIX_PATH='+prefix,'-DCMAKE_FIND_ROOT_PATH='+prefix,'-DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=BOTH','-DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=BOTH','-DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=BOTH','-DBUILD_SHARED_LIBS=OFF','-DAVIF_CODEC_AOM=SYSTEM','-DAVIF_CODEC_AOM_ENCODE=ON','-DAVIF_CODEC_AOM_DECODE=ON','-DAVIF_LIBYUV=OFF','-DAVIF_LIBSHARPYUV=OFF','-DAVIF_BUILD_APPS=OFF','-DAVIF_BUILD_TESTS=OFF','-DAVIF_BUILD_EXAMPLES=OFF'],environment);
command(cmake,['--build',avifBuild,'--parallel',String(jobs)],environment);
const output=inside(root,path.join(root,'public/vendor/avif'));fs.mkdirSync(output,{recursive:true});
const exported=['dc_source_decoder_create','dc_probe_create','dc_probe_frame_ticks','dc_error','dc_version','dc_alloc','dc_free','dc_encoder_create','dc_encoder_add','dc_encoder_finish','dc_encoder_data','dc_encoder_size','dc_encoder_destroy','dc_decoder_create','dc_decoder_next','dc_decoder_rgba','dc_decoder_width','dc_decoder_height','dc_decoder_frames','dc_decoder_timescale','dc_decoder_duration','dc_decoder_frame_ticks','dc_decoder_repetitions','dc_decoder_alpha','dc_decoder_depth','dc_decoder_destroy'].map(name=>'_'+name);
command(compiler,[path.join(own,'bridge.c'),path.join(avifBuild,'libavif.a'),path.join(prefix,'lib/libaom.a'),'-I'+path.join(source,'include'),'-Os','-flto','-msimd128','--no-entry','-sMODULARIZE=1','-sEXPORT_ES6=1','-sENVIRONMENT=web,worker','-sFILESYSTEM=0','-sALLOW_MEMORY_GROWTH=1','-sMAXIMUM_MEMORY=268435456','-sINITIAL_MEMORY=16777216','-sSTACK_SIZE=1048576','-sMALLOC=emmalloc','-sDYNAMIC_EXECUTION=0','-sASSERTIONS=0','-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]','-sINCOMING_MODULE_JS_API=["wasmBinary"]','-sEXPORTED_FUNCTIONS='+JSON.stringify(exported),'-o',path.join(output,'module.mjs')],environment);
const generated=path.join(output,'module.mjs');
fs.writeFileSync(generated,'// @ts-nocheck\n/** @param {{wasmBinary:Uint8Array}} moduleArg @returns {Promise<import("./codec.mjs").NativeModule>} */\n'+fs.readFileSync(generated,'utf8'));
fs.copyFileSync(path.join(source,'LICENSE'),path.join(output,'libavif-LICENSE'));
fs.copyFileSync(path.join(aom,'LICENSE'),path.join(output,'libaom-LICENSE'));
fs.copyFileSync(path.join(aom,'PATENTS'),path.join(output,'libaom-PATENTS'));
const included=['module.mjs','module.wasm','codec.mjs','libavif-LICENSE','libaom-LICENSE','libaom-PATENTS'].map(name=>({path:name,bytes:fs.statSync(path.join(output,name)).size,sha256:hash(path.join(output,name))}));
const inputs=['bridge.c','build.mjs','dependencies.json','libavif-files.json'].map(name=>({path:'tools/avif-codec/'+name,bytes:fs.statSync(path.join(own,name)).size,sha256:hash(path.join(own,name))}));
fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify({libavif:'1.4.2',libavifCommit:commit,libaom:'3.15.2',emscripten:'6.0.12',memoryLimitBytes:268435456,cmake:{version:'3.31.6-msvc6',sha256:hash(cmake)},ninja:{version:'1.12.1',sha256:hash(ninja)},perl:{version:'5.36.0',sha256:hash(perl)},inputs,files:included},null,2)+'\n');
console.log(JSON.stringify({event:'avif-build-complete',output,files:included}));
