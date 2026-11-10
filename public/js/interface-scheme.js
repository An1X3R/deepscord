// @ts-check
import {mediaObject} from './chat-protocol.js';
import {parseTheme} from './customization-protocol.js';
import {parseInterfaceProfile} from './interface-profile.js';

/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {string|number|boolean} SchemeValue */
/** @typedef {{id:string,label:string,cssVariable:string}} OptionBase */
/** @typedef {{value:string,label:string,cssValue:string}} SchemeChoice */
/** @typedef {OptionBase & {type:'select',default:string,choices:SchemeChoice[]}} SelectOption */
/** @typedef {OptionBase & {type:'range',default:number,min:number,max:number,step:number,unit:'px'|'rem'|'%'|''}} RangeOption */
/** @typedef {OptionBase & {type:'toggle',default:boolean,on:string,off:string}} ToggleOption */
/** @typedef {SelectOption|RangeOption|ToggleOption} SchemeOption */
/** @typedef {{html:string,css:string,script:string}} InterfacePresentation */
/** @typedef {{version:1,id:string,name:string,description:string,theme:import('./customization-protocol.js').Theme|null,interfaceProfile:import('./interface-profile.js').InterfaceProfile,options:SchemeOption[],presentation?:InterfacePresentation}} InterfaceScheme */
/** @typedef {{scheme:InterfaceScheme,values:Record<string,SchemeValue>}} InterfaceSelection */

/** @param {JsonValue|undefined} value @param {string} label @param {number} maximum @returns {string} */
function text(value,label,maximum){if(typeof value!=='string'||!value.length||value.length>maximum||/[\u0000-\u001f\u007f]/.test(value))throw new TypeError(label+' requires 1–'+maximum+' printable characters');return value;}
/** @param {JsonValue|undefined} value @param {string} label @returns {string} */
function identifier(value,label){const parsed=text(value,label,64);if(!/^[a-z][a-z0-9-]*$/.test(parsed))throw new TypeError(label+' requires lowercase letters, digits and hyphens');return parsed;}
/** @param {JsonValue|undefined} value @param {string} label @returns {number} */
function finite(value,label){if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>10000)throw new RangeError(label+' requires a finite number between -10000 and 10000');return value;}
/** @param {JsonValue|undefined} value @param {string} label @returns {string} */
function css(value,label){const parsed=text(value,label,128);if(!/^(?:#[a-f0-9]{3,8}|-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|%|deg|ms|s)?|[a-z][a-z0-9-]*)(?: (?:-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|%|deg|ms|s)?|[a-z][a-z0-9-]*))*$/i.test(parsed))throw new TypeError(label+' requires a simple CSS literal without functions or declarations');return parsed;}
/** @param {JsonValue} input @returns {SchemeOption} */
function option(input){
  const row=mediaObject(input,'Scheme option'),id=identifier(row.id,'Option ID'),label=text(row.label,'Option label',80),cssVariable=text(row.cssVariable,'Option CSS variable',80);
  if(!/^--scheme-[a-z][a-z0-9-]*$/.test(cssVariable))throw new TypeError('Option CSS variable must begin with --scheme-');
  const base={id,label,cssVariable};
  if(row.type==='select'){
    if(!Array.isArray(row.choices)||!row.choices.length||row.choices.length>24)throw new RangeError('Select option requires 1–24 choices');
    const choices=row.choices.map(value=>{const choice=mediaObject(value,'Scheme choice');return {value:identifier(choice.value,'Choice value'),label:text(choice.label,'Choice label',80),cssValue:css(choice.cssValue,'Choice CSS value')};});
    if(new Set(choices.map(choice=>choice.value)).size!==choices.length)throw new TypeError('Select option contains duplicate choice values');
    const initial=text(row.default,'Select default',64);if(!choices.some(choice=>choice.value===initial))throw new TypeError('Select default must match a choice');
    return {...base,type:'select',default:initial,choices};
  }
  if(row.type==='range'){
    const min=finite(row.min,'Range minimum'),max=finite(row.max,'Range maximum'),step=finite(row.step,'Range step'),initial=finite(row.default,'Range default');
    if(min>=max||step<=0||step>max-min)throw new RangeError('Range requires min < max and 0 < step <= max-min');
    if(row.unit!==''&&row.unit!=='px'&&row.unit!=='rem'&&row.unit!=='%')throw new TypeError('Range unit must be px, rem, % or empty');
    /** @type {RangeOption} */
    const parsed={...base,type:'range',default:initial,min,max,step,unit:row.unit};rangeValue(parsed,initial);return parsed;
  }
  if(row.type==='toggle'){if(typeof row.default!=='boolean')throw new TypeError('Toggle default requires a boolean');return {...base,type:'toggle',default:row.default,on:css(row.on,'Toggle on CSS'),off:css(row.off,'Toggle off CSS')};}
  throw new TypeError('Scheme option type must be select, range or toggle');
}
/** @param {RangeOption} entry @param {JsonValue|undefined} value @returns {number} */
function rangeValue(entry,value){const parsed=finite(value,'Range value for '+entry.id),steps=(parsed-entry.min)/entry.step;if(parsed<entry.min||parsed>entry.max||Math.abs(steps-Math.round(steps))>1e-7)throw new RangeError('Range value for '+entry.id+' must be within '+entry.min+'–'+entry.max+' in steps of '+entry.step);return parsed;}
/** @param {JsonValue|undefined} input @returns {InterfacePresentation} */
function presentation(input){
  const row=mediaObject(input,'Interface presentation');
  /** @param {JsonValue|undefined} value @param {string} label @returns {string} */
  function content(value,label){if(typeof value!=='string')throw new TypeError('Interface presentation '+label+' must be an explicit string');if(new TextEncoder().encode(value).byteLength>128*1024)throw new RangeError('Interface presentation '+label+' exceeds its 128 KiB UTF-8 budget');return value;}
  return {html:content(row.html,'html'),css:content(row.css,'css'),script:content(row.script,'script')};
}

/** @param {JsonValue|undefined} input @returns {InterfaceScheme} */
export function parseInterfaceScheme(input){
  const row=mediaObject(input,'Interface scheme');if(row.version!==1)throw new TypeError('Interface scheme requires version 1');
  if(row.files!==undefined)throw new TypeError('Interface scheme files must be resolved by the local directory loader before parsing a presentation snapshot');
  if(!Array.isArray(row.options)||row.options.length>16)throw new RangeError('Interface scheme permits at most 16 options');
  const options=row.options.map(option);
  if(new Set(options.map(entry=>entry.id)).size!==options.length||new Set(options.map(entry=>entry.cssVariable)).size!==options.length)throw new TypeError('Interface scheme requires unique option IDs and CSS variables');
  /** @type {InterfaceScheme} */
  const parsed={version:1,id:identifier(row.id,'Scheme ID'),name:text(row.name,'Scheme name',80),description:text(row.description,'Scheme description',512),theme:row.theme===null?null:parseTheme(row.theme),interfaceProfile:parseInterfaceProfile(row.interfaceProfile),options,...(row.presentation===undefined?{}:{presentation:presentation(row.presentation)})};
  if(new TextEncoder().encode(JSON.stringify(parsed)).byteLength>512*1024)throw new RangeError('Interface scheme snapshot exceeds its 512 KiB serialized UTF-8 budget, including JSON escapes');
  return parsed;
}
/** @param {InterfaceScheme} scheme @param {JsonValue|undefined} input @returns {Record<string,SchemeValue>} */
export function parseSchemeValues(scheme,input){
  const row=mediaObject(input,'Scheme values');
  return Object.fromEntries(scheme.options.map(entry=>{
    const value=Object.hasOwn(row,entry.id)?row[entry.id]:entry.default;
    if(entry.type==='range')return [entry.id,rangeValue(entry,value)];
    if(entry.type==='toggle'){if(typeof value!=='boolean')throw new TypeError('Toggle value for '+entry.id+' requires a boolean');return [entry.id,value];}
    if(typeof value!=='string'||!entry.choices.some(choice=>choice.value===value))throw new TypeError('Select value for '+entry.id+' must match a choice');return [entry.id,value];
  }));
}
/** @param {InterfaceScheme} input @param {JsonValue|undefined} inputValues @returns {{theme:import('./customization-protocol.js').Theme|null,interfaceProfile:import('./interface-profile.js').InterfaceProfile,variables:Record<string,string>,values:Record<string,SchemeValue>}} */
export function resolveInterfaceScheme(input,inputValues){
  const scheme=parseInterfaceScheme(input),values=parseSchemeValues(scheme,inputValues);
  const variables=Object.fromEntries(scheme.options.map(entry=>{
    const value=values[entry.id];
    if(entry.type==='range')return [entry.cssVariable,String(value)+entry.unit];
    if(entry.type==='toggle')return [entry.cssVariable,value?entry.on:entry.off];
    const choice=entry.choices.find(choice=>choice.value===value);if(!choice)throw new TypeError('Missing validated choice for '+entry.id);return [entry.cssVariable,choice.cssValue];
  }));
  return {theme:scheme.theme,interfaceProfile:scheme.interfaceProfile,variables,values};
}
/** @param {JsonValue|undefined} input @returns {InterfaceSelection} */
export function parseInterfaceSelection(input){const row=mediaObject(input,'Interface selection'),scheme=parseInterfaceScheme(row.scheme);return {scheme,values:parseSchemeValues(scheme,row.values)};}
