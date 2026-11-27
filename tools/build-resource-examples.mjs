// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import {parseInterfaceScheme} from '../public/js/interface-scheme.js';
import {parseResourcePackManifest} from '../public/js/resource-pack.js';
import {parseCustomInteraction} from '../public/js/customization-protocol.js';
import codec from '../lib/avif-codec.cjs';
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../public/js/resource-pack.js').ResourcePackManifest} Manifest */
/** @typedef {{packIds:string[],files:number,bytes:number}} ExampleReport */
const themeNames=['industrial','constructivist','lanart'];
const interactionNames=['default-bomb','default-poop','playful-fist','dollar-wallet'];
const guideNames=['RESOURCE_PACKS.md','interfaces/DEVELOPMENT.md','interactions/DEVELOPMENT.md'];
export const resourceExampleFiles=Object.freeze([
  ...guideNames,
  ...themeNames.flatMap(name=>['pack.json',name+'-open.json',...['layout.html','style.css','script.js'].map(file=>'packages/'+name+'/'+file)].map(file=>'examples/'+name+'-open/'+file)),
  ...['pack.json',...interactionNames.map(name=>name+'.json')].map(file=>'examples/interaction-examples/'+file),
  'examples/sticker-example/pack.json','examples/sticker-example/original-mark.avif'
]);
/** @param {string} value @param {string} label @returns {string} */
function absolute(value,label){if(typeof value!=='string'||!path.isAbsolute(value))throw new TypeError(label+' must be an absolute path');return path.resolve(value);}
/** @param {string} directory @returns {void} */
function realDirectory(directory){const parent=path.dirname(directory);if(parent!==directory)realDirectory(parent);const info=fs.lstatSync(directory,{throwIfNoEntry:false});if(info&&(info.isSymbolicLink()||!info.isDirectory()))throw new TypeError('Example resource path must contain real directories: '+directory);}
/** @param {string} filename @returns {Buffer} */
function read(filename){realDirectory(path.dirname(filename));const info=fs.lstatSync(filename);if(info.isSymbolicLink()||!info.isFile()||info.size>256*1024)throw new TypeError('Example source must be a regular file within 256 KiB: '+filename);return fs.readFileSync(filename);}
/** @param {string} filename @returns {JsonValue} */
function json(filename){return /** @type {JsonValue} */(JSON.parse(read(filename).toString('utf8')));}
/** @param {string} directory @param {string} name @returns {import('../public/js/interface-scheme.js').InterfaceScheme} */
function authoredTheme(directory,name){
  const value=json(path.join(directory,name+'-open.json'));
  if(!value||typeof value!=='object'||Array.isArray(value)||!value.files||typeof value.files!=='object'||Array.isArray(value.files))throw new TypeError('Authored theme requires its relative HTML, CSS and JS files: '+name);
  /** @type {Record<'html'|'css'|'script',string>} */const files={html:'packages/'+name+'/layout.html',css:'packages/'+name+'/style.css',script:'packages/'+name+'/script.js'};
  /** @type {Record<'html'|'css'|'script',string>} */const presentation={html:'',css:'',script:''};
  for(const kind of /** @type {const} */(['html','css','script'])){if(value.files[kind]!==files[kind])throw new TypeError('Authored theme references an unexpected content path: '+name);const data=read(path.join(directory,files[kind]));if(data.length>128*1024)throw new RangeError('Authored theme presentation file exceeds 128 KiB: '+files[kind]);presentation[kind]=data.toString('utf8');}
  const {files:references,...scheme}=value;
  return parseInterfaceScheme({...scheme,presentation});
}
/** @returns {Uint8Array} */
function originalPixels(){
  const rgba=new Uint8Array(48*48*4);
  for(let y=0;y<48;y++)for(let x=0;x<48;x++){
    const index=(y*48+x)*4,inside=x>=6&&x<42&&y>=6&&y<42,slash=inside&&Math.abs(x+y-47)<5;
    const color=slash?[242,185,66]:inside?[75,173,156]:[27,36,43];
    rgba[index]=color[0];rgba[index+1]=color[1];rgba[index+2]=color[2];rgba[index+3]=255;
  }
  return rgba;
}
/** @param {{directory:string,signal:AbortSignal}} options @returns {Promise<ExampleReport>} */
export async function verifyResourceExamples(options){
  const directory=absolute(options.directory,'Example resource directory');realDirectory(directory);options.signal.throwIfAborted();
  /** @type {string[]} */const found=[];
  /** @param {string} current @returns {void} */
  function collect(current){for(const name of fs.readdirSync(current)){const filename=path.join(current,name),info=fs.lstatSync(filename);if(info.isSymbolicLink())throw new TypeError('Example resources must not contain links: '+filename);if(info.isDirectory())collect(filename);else{read(filename);found.push(path.relative(directory,filename).split(path.sep).join('/'));}}}
  collect(directory);
  if(found.length!==resourceExampleFiles.length||found.some(file=>!resourceExampleFiles.includes(file)))throw new Error('Example resources must contain exactly the authored guides and declared uninstalled packs');
  let bytes=0;
  for(const file of found){const data=read(path.join(directory,file));bytes+=data.length;if(!file.endsWith('.avif')){const text=data.toString('utf8');if(/(?<![a-z])[a-z]:[\\/]|\\\\[a-z0-9]/i.test(text)||/(?:^|[\s"'`(])\/(?:Users|home|mnt)\/[^/\s]+/m.test(text))throw new TypeError('Example resources contain a machine-specific path: '+file);}}
  /** @type {string[]} */const packIds=[];
  for(const example of [...themeNames.map(name=>name+'-open'),'interaction-examples','sticker-example']){
    options.signal.throwIfAborted();const base=path.join(directory,'examples',example),manifest=parseResourcePackManifest(json(path.join(base,'pack.json')));
    if(manifest.id!==example)throw new TypeError('Unexpected example pack identity: '+example);packIds.push(manifest.id);
    if(manifest.kind==='interfaces')for(const entry of manifest.entries){const name=example.slice(0,-'-open'.length);if(entry.file!==example+'.json')throw new TypeError('Example theme entry must reference its authored manifest');const scheme=authoredTheme(base,name);if(scheme.id!==manifest.id)throw new TypeError('Example theme pack must match its legacy scheme identity');}
    else if(manifest.kind==='interactions')for(const entry of manifest.entries){const draft=parseCustomInteraction(json(path.join(base,entry.file)));if(draft.thumbnail!==null)throw new TypeError('Authored interaction examples must not reference personal thumbnail assets');}
    else for(const entry of manifest.entries)await codec.validate(read(path.join(base,entry.file)),'personal',options.signal);
  }
  for(const kind of ['interfaces','interactions'])if([...read(path.join(directory,kind,'DEVELOPMENT.md')).toString('utf8').matchAll(/```json\r?\n/g)].length!==2)throw new TypeError('Development guides must each retain exactly two complete JSON examples: '+kind);
  return {packIds,files:found.length,bytes};
}
/** @param {{sourceDirectory:string,destination:string,signal:AbortSignal}} options @returns {Promise<ExampleReport>} */
export async function buildResourceExamples(options){
  const source=absolute(options.sourceDirectory,'Example source directory'),destination=absolute(options.destination,'Example destination');options.signal.throwIfAborted();realDirectory(source);realDirectory(path.dirname(destination));
  if(fs.lstatSync(destination,{throwIfNoEntry:false}))throw new Error('Example destination already exists; personal resource folders must never be copied or overwritten: '+destination);
  fs.mkdirSync(destination);
  /** @param {string} relative @param {Buffer|string} data @returns {void} */
  function write(relative,data){options.signal.throwIfAborted();const target=path.join(destination,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,data,{flag:'wx'});}
  /** @param {string} directory @param {Manifest} manifest @returns {void} */
  function writeManifest(directory,manifest){const parsed=parseResourcePackManifest(manifest);write('examples/'+directory+'/pack.json',JSON.stringify(parsed,null,2)+'\n');}
  for(const guide of guideNames)write(guide,read(path.join(source,guide)));
  for(const name of themeNames){
    const filename=name+'-open.json',scheme=authoredTheme(path.join(source,'interfaces'),name);
    writeManifest(scheme.id,{format:1,id:scheme.id,name:scheme.name,version:'1.0.0',kind:'interfaces',entries:[{file:filename,name:scheme.name}]});
    for(const file of [filename,...['layout.html','style.css','script.js'].map(file=>'packages/'+name+'/'+file)])write('examples/'+scheme.id+'/'+file,read(path.join(source,'interfaces',file)));
  }
  const entries=interactionNames.map(name=>{const file=name+'.json',data=read(path.join(source,'interactions',file)),draft=parseCustomInteraction(/** @type {JsonValue} */(JSON.parse(data.toString('utf8'))));write('examples/interaction-examples/'+file,data);return {file,name:draft.name};});
  writeManifest('interaction-examples',{format:1,id:'interaction-examples',name:'互动动画开发示例',version:'1.0.0',kind:'interactions',entries});
  const sample=await codec.encode({width:48,height:48,timescale:1000,repetitionCount:0,frames:[{rgba:originalPixels(),durationTicks:1000}]},{quality:80,speed:10},{maxBytes:160*1024,maxDimension:360,maxFrames:1,maxDecodedPixels:360*360,maxDurationMs:10000,timeoutMs:30000},options.signal);
  write('examples/sticker-example/original-mark.avif',sample);
  writeManifest('sticker-example',{format:1,id:'sticker-example',name:'原创几何图片表情示例',version:'1.0.0',kind:'stickers',entries:[{file:'original-mark.avif',name:'几何标记'}]});
  return verifyResourceExamples({directory:destination,signal:options.signal});
}
