// @ts-check
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
/** @type {typeof import('../public/js/screen-preferences.js')} */
const {parseScreenPreferences,getScreenPreferences}=require('./app-server/public/js/screen-preferences.js');
const {mediaId}=require('./app-server/public/js/chat-protocol.js');
/** @type {typeof import('../public/js/interface-profile.js')} */
const {parseInterfaceProfile,INTERFACE_PRESETS}=require('./app-server/public/js/interface-profile.js');
/** @type {typeof import('../public/js/customization-protocol.js')} */
const {parseTheme}=require('./app-server/public/js/customization-protocol.js');
/** @type {typeof import('../public/js/interface-scheme.js')} */
const {parseInterfaceSelection,resolveInterfaceScheme}=require('./app-server/public/js/interface-scheme.js');
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{interfaceSelection:import('../public/js/interface-scheme.js').InterfaceSelection|null,peerVolumes:Record<string,number>,color:string,inputDeviceId:string,outputDeviceId:string,micVolume:number,outVolume:number,radioVolume:number,interfaceProfile:import('../public/js/interface-profile.js').InterfaceProfile,mode:'vad'|'ptt',pttKey:string,vadThreshold:number,echoCancellation:boolean,noiseSuppression:boolean,autoGainControl:boolean,monitor:boolean,sounds:boolean,interactionSounds:boolean,interactionVolume:number,membersOpen:boolean,screenPreferences:import('../public/js/screen-preferences.js').ScreenPreferences,localTheme:import('../public/js/customization-protocol.js').Theme|null}} ClientSettings */
/** @typedef {{serverId:string,channelId:string}} LastChannel */
/** @typedef {{settings:ClientSettings|null,lastChannel:LastChannel|null}} Preferences */
/** @param {JsonValue|undefined} input @param {string} label @returns {{[key:string]:JsonValue}} */
function object(input,label){if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError(label+' must be an object');return input;}
/** @param {JsonValue|undefined} input @param {string} label @param {number} maximum @returns {string} */
function text(input,label,maximum){if(typeof input!=='string'||!input.length||input.length>maximum||/[\u0000-\u001f\u007f]/.test(input))throw new TypeError(label+' must contain 1–'+maximum+' printable characters');return input;}
/** @param {JsonValue|undefined} input @param {string} label @param {number} minimum @param {number} maximum @returns {number} */
function number(input,label,minimum,maximum){if(typeof input!=='number'||!Number.isFinite(input)||input<minimum||input>maximum)throw new RangeError(label+' must be between '+minimum+' and '+maximum);return input;}
/** @param {JsonValue|undefined} input @param {string} label @returns {boolean} */
function boolean(input,label){if(typeof input!=='boolean')throw new TypeError(label+' must be boolean');return input;}
/** @param {JsonValue|undefined} input @returns {Record<string,number>} */
function peerVolumes(input){const entries=Object.entries(object(input,'Peer volumes'));if(entries.length>512)throw new RangeError('Peer volumes permit at most 512 saved members');return Object.fromEntries(entries.map(([key,value])=>[text(key,'Peer volume identity',256),number(value,'Peer volume',0,200)]));}
/** @param {JsonValue} input @returns {ClientSettings} */
function settings(input){
  const row=object(input,'Client preferences'),color=text(row.color,'Avatar color',7);
  const interfaceSelection=row.interfaceSelection===undefined||row.interfaceSelection===null?null:parseInterfaceSelection(row.interfaceSelection);
  const resolved=interfaceSelection===null?null:resolveInterfaceScheme(interfaceSelection.scheme,interfaceSelection.values);
  if(!/^#[a-f0-9]{6}$/i.test(color))throw new TypeError('Avatar color must contain six hexadecimal digits');
  if(row.mode!=='vad'&&row.mode!=='ptt')throw new TypeError('Input mode must be vad or ptt');
  if(row.screenPreferences===undefined)throw new TypeError('Client preferences require explicit screen preferences');
  return {interfaceSelection,interfaceProfile:resolved?resolved.interfaceProfile:row.interfaceProfile===undefined?parseInterfaceProfile(INTERFACE_PRESETS.industrial):parseInterfaceProfile(row.interfaceProfile),peerVolumes:peerVolumes(row.peerVolumes),color,inputDeviceId:text(row.inputDeviceId,'Input device',512),outputDeviceId:text(row.outputDeviceId,'Output device',512),micVolume:number(row.micVolume,'Microphone volume',0,200),outVolume:number(row.outVolume,'Output volume',0,100),radioVolume:number(row.radioVolume,'Radio volume',0,100),mode:row.mode,pttKey:text(row.pttKey,'Push-to-talk key',64),vadThreshold:number(row.vadThreshold,'Voice activation threshold',-70,-20),echoCancellation:boolean(row.echoCancellation,'Echo cancellation'),noiseSuppression:boolean(row.noiseSuppression,'Noise suppression'),autoGainControl:boolean(row.autoGainControl,'Automatic gain'),monitor:boolean(row.monitor,'Microphone monitor'),sounds:boolean(row.sounds,'Interface sounds'),interactionSounds:boolean(row.interactionSounds,'Interaction sounds'),interactionVolume:number(row.interactionVolume,'Interaction volume',0,100),membersOpen:boolean(row.membersOpen,'Member panel'),screenPreferences:parseScreenPreferences(row.screenPreferences),localTheme:resolved?resolved.theme:row.localTheme===undefined || row.localTheme===null ? null : parseTheme(row.localTheme)};
}
/** @param {JsonValue} input @returns {ClientSettings} */
function savedSettings(input){
  const row=object(input,'Saved client preferences');
  if(row.screenPreferences===undefined)throw new TypeError('Saved client preferences require explicit screen preferences');
  return settings({...row,radioVolume:row.radioVolume===undefined?10:row.radioVolume,interactionSounds:row.interactionSounds===undefined?true:row.interactionSounds,interactionVolume:row.interactionVolume===undefined?20:row.interactionVolume,screenPreferences:getScreenPreferences(row,true)});
}
/** @param {JsonValue} input @returns {LastChannel} */
function lastChannel(input){const row=object(input,'Last channel');return {serverId:mediaId(row.serverId,'Last server'),channelId:mediaId(row.channelId,'Last channel')};}
/** @param {string} userData */
function createClientPreferences(userData){
  const filename=path.join(userData,'client-preferences.json');
  /** @returns {Preferences} */
  function read(){
    if(!fs.existsSync(filename))return {settings:null,lastChannel:null};
    const stat=fs.lstatSync(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw new RangeError('Client preference file must be a regular file of at most 1 MiB: '+filename);
    const row=object(/** @type {JsonValue} */(JSON.parse(fs.readFileSync(filename,'utf8'))),'Saved client preferences');
    if(row.version!==1||row.settings===undefined||row.lastChannel===undefined)throw new TypeError('Saved client preferences require version 1 and explicit settings and last channel');
    return {settings:row.settings===null?null:savedSettings(row.settings),lastChannel:row.lastChannel===null?null:lastChannel(row.lastChannel)};
  }
  /** @param {Preferences} next @returns {void} */
  function write(next){
    const serialized=JSON.stringify({version:1,...next});if(Buffer.byteLength(serialized)>1024*1024)throw new RangeError('Client preferences exceed their 1 MiB file budget');
    fs.mkdirSync(userData,{recursive:true});
    const temporary=filename+'.'+randomUUID()+'.tmp',descriptor=fs.openSync(temporary,'wx',0o600);
    try{try{fs.writeFileSync(descriptor,serialized,'utf8');fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}fs.renameSync(temporary,filename);}
    catch(error){if(fs.existsSync(temporary))fs.unlinkSync(temporary);throw error;}
  }
  /** @param {JsonValue} input @returns {void} */
  function saveSettings(input){const parsed=settings(input);write({...read(),settings:parsed});}
  /** @param {JsonValue} input @returns {void} */
  function saveLastChannel(input){const parsed=lastChannel(input);write({...read(),lastChannel:parsed});}
  return {read,saveSettings,saveLastChannel};
}
module.exports={createClientPreferences};

