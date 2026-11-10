// @ts-check
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
/** @type {typeof import('../public/js/interface-scheme.js')} */
const {parseInterfaceScheme}=require('./app-server/public/js/interface-scheme.js');
/** @type {typeof import('../public/js/customization-protocol.js')} */
const {parseCustomInteraction}=require('./app-server/public/js/customization-protocol.js');
/** @typedef {'interfaces'|'interactions'} CustomizationKind */
/** @typedef {import('../public/js/interface-scheme.js').InterfaceScheme} InterfaceScheme */
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../public/js/customization-protocol.js').CustomInteraction} CustomInteraction */
/** @typedef {{directory:string,serverDirectory:string}} InteractionDirectory */

/** @param {string} directory @returns {void} */
function requireDirectory(directory){const stat=fs.lstatSync(directory);if(stat.isSymbolicLink()||!stat.isDirectory())throw new TypeError('Customization directory must be a real directory: '+directory);}
/** @param {string} filename @returns {Buffer} */
function readFile(filename){const stat=fs.lstatSync(filename);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>256*1024)throw new RangeError('Customization file must be a regular file of at most 256 KiB: '+filename);return fs.readFileSync(filename);}
/** @param {string} filename @param {string} relative @param {'.html'|'.css'|'.js'} extension @returns {string} */
function readPresentationFile(filename,relative,extension){
  if(typeof relative!=='string'||!relative.length||relative.length>512||path.isAbsolute(relative)||path.win32.isAbsolute(relative))throw new TypeError('Theme package file requires a relative path: '+filename);
  const segments=relative.split(/[\\/]/);
  if(segments.some(segment=>!segment||segment==='.'||segment==='..'||segment.trim()!==segment||segment.endsWith('.')||/[<>:"|?*\u0000-\u001f]/.test(segment))||path.extname(relative).toLowerCase()!==extension)throw new TypeError('Theme package path must be contained and end with '+extension+': '+relative+' in '+filename);
  const base=path.dirname(filename);let target=base;
  for(const [index,segment] of segments.entries()){target=path.join(target,segment);if(index<segments.length-1)requireDirectory(target);}
  const resolved=path.relative(fs.realpathSync(base),fs.realpathSync(target));
  if(!resolved||resolved==='..'||resolved.startsWith('..'+path.sep)||path.isAbsolute(resolved))throw new TypeError('Theme package file escapes its scheme directory: '+target);
  const stat=fs.lstatSync(target);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>128*1024)throw new RangeError('Theme package file must be a regular file of at most 128 KiB: '+target);
  return fs.readFileSync(target,'utf8');
}
/** @param {string} filename @returns {InterfaceScheme} */
function readInterfaceFile(filename){
  const input=/** @type {JsonValue} */(JSON.parse(readFile(filename).toString('utf8')));
  if(!input||typeof input!=='object'||Array.isArray(input)||input.files===undefined)return parseInterfaceScheme(input);
  if(input.presentation!==undefined)throw new TypeError('Theme package cannot combine files with an inline presentation: '+filename);
  const files=input.files;if(!files||typeof files!=='object'||Array.isArray(files))throw new TypeError('Theme package files must contain html, css and script paths: '+filename);
  if(typeof files.html!=='string'||typeof files.css!=='string'||typeof files.script!=='string')throw new TypeError('Theme package requires explicit html, css and script file paths: '+filename);
  const {files:references,...scheme}=input;
  return parseInterfaceScheme({...scheme,presentation:{html:readPresentationFile(filename,files.html,'.html'),css:readPresentationFile(filename,files.css,'.css'),script:readPresentationFile(filename,files.script,'.js')}});
}
/** @param {string} customizationRoot @param {string} bundledRoot */
function createCustomizationStore(customizationRoot,bundledRoot){
  const root=customizationRoot;
  /** @type {Record<CustomizationKind,string[]>} */
  const templates={interfaces:['industrial.json','constructivist.json'],interactions:['default-bomb.json','default-poop.json','playful-fist.json','dollar-wallet.json']};
  const themePackages=['industrial-open.json','constructivist-open.json',...['industrial','constructivist'].flatMap(name=>['layout.html','style.css','script.js'].map(file=>'packages/'+name+'/'+file))];
  /** @param {CustomizationKind} kind @returns {string} */
  function directory(kind){
    if(kind!=='interfaces'&&kind!=='interactions')throw new TypeError('Customization directory must be interfaces or interactions');
    fs.mkdirSync(root,{recursive:true});requireDirectory(root);
    const target=path.join(root,kind),source=path.join(bundledRoot,kind);
    if(!fs.existsSync(target))fs.mkdirSync(target);requireDirectory(target);requireDirectory(source);
    const marker=path.join(target,'.seeded-v1');
    if(fs.existsSync(marker)){
      if(readFile(marker).toString('utf8')!=='1\n')throw new TypeError('Invalid customization initialization marker: '+marker);
    }else{
      for(const name of templates[kind]){
        const from=path.join(source,name),to=path.join(target,name),data=readFile(from);
        if(fs.existsSync(to))readFile(to);else fs.writeFileSync(to,data,{flag:'wx'});
      }
      const temporary=marker+'.'+randomUUID()+'.tmp';
      fs.writeFileSync(temporary,'1\n',{flag:'wx'});
      fs.renameSync(temporary,marker);
    }
    if(kind==='interfaces'){
      const packageMarker=path.join(target,'.seeded-v2');
      if(fs.existsSync(packageMarker)){if(readFile(packageMarker).toString('utf8')!=='2\n')throw new TypeError('Invalid theme package initialization marker: '+packageMarker);}
      else{
        for(const name of themePackages){
          const segments=name.split('/'),from=path.join(source,...segments),to=path.join(target,...segments),data=readFile(from);let parent=target;
          for(const segment of segments.slice(0,-1)){parent=path.join(parent,segment);if(!fs.existsSync(parent))fs.mkdirSync(parent);requireDirectory(parent);}
          if(fs.existsSync(to))readFile(to);else fs.writeFileSync(to,data,{flag:'wx'});
        }
        fs.writeFileSync(packageMarker,'2\n',{flag:'wx'});
      }
    }
    const guide=path.join(target,'DEVELOPMENT.md'),data=readFile(path.join(source,'DEVELOPMENT.md'));
    if(fs.existsSync(guide)){if(!readFile(guide).equals(data))fs.writeFileSync(guide,data);}
    else fs.writeFileSync(guide,data,{flag:'wx'});
    return target;
  }
  /** @returns {{directory:string,schemes:InterfaceScheme[]}} */
  function listInterfaceSchemes(){
    const target=directory('interfaces'),entries=fs.readdirSync(target,{withFileTypes:true});
    const files=entries.filter(entry=>entry.name.endsWith('.json'));
    if(files.length>64)throw new RangeError('Interface directory permits at most 64 schemes: '+target);
    const schemes=files.map(entry=>{
      const filename=path.join(target,entry.name);
      try{return readInterfaceFile(filename);}
      catch(error){if(error instanceof SyntaxError||error instanceof TypeError||error instanceof RangeError)throw new TypeError('Invalid interface scheme '+filename+': '+error.message,{cause:error});throw error;}
    });
    const ids=new Set();for(const scheme of schemes){if(ids.has(scheme.id))throw new TypeError('Duplicate interface scheme ID '+scheme.id+' in '+target);ids.add(scheme.id);}
    return {directory:target,schemes};
  }
  /** @param {string} roomId @returns {InteractionDirectory} */
  function interactionDirectory(roomId){
    if(typeof roomId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(roomId))throw new TypeError('Interaction directory requires a canonical lowercase room UUID');
    const target=directory('interactions'),serverDirectory=path.join(target,roomId);
    if(!fs.existsSync(serverDirectory))fs.mkdirSync(serverDirectory);requireDirectory(serverDirectory);
    return {directory:target,serverDirectory};
  }
  /** @param {string} roomId @returns {InteractionDirectory & {interactions:CustomInteraction[]}} */
  function listServerInteractions(roomId){
    const target=interactionDirectory(roomId),entries=fs.readdirSync(target.serverDirectory,{withFileTypes:true});
    const files=entries.filter(entry=>entry.name.endsWith('.json')).sort((left,right)=>left.name.localeCompare(right.name));
    if(files.length>96)throw new RangeError('Server interaction directory permits at most 96 definitions: '+target.serverDirectory);
    const interactions=files.map(entry=>{
      const filename=path.join(target.serverDirectory,entry.name);
      try{return parseCustomInteraction(/** @type {JsonValue} */(JSON.parse(readFile(filename).toString('utf8'))));}
      catch(error){if(error instanceof SyntaxError||error instanceof TypeError||error instanceof RangeError)throw new TypeError('Invalid interaction definition '+filename+': '+error.message,{cause:error});throw error;}
    });
    /** @type {Set<string>} */
    const ids=new Set();for(const interaction of interactions){if(ids.has(interaction.id))throw new TypeError('Duplicate interaction ID '+interaction.id+' in '+target.serverDirectory);ids.add(interaction.id);}
    return {...target,interactions};
  }
  return {directory,listInterfaceSchemes,interactionDirectory,listServerInteractions};
}
module.exports={createCustomizationStore,readInterfaceFile};
