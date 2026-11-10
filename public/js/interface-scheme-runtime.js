// @ts-check
import {parseInterfaceScheme,resolveInterfaceScheme} from './interface-scheme.js';
import {applyCustomizationTheme} from './customization-theme.js';
import {applyInterfacePackage,clearInterfacePackage,interfacePackageMatches} from './interface-package.js';
import {applyInterfaceProfile} from './interface-profile.js';
/** @typedef {import('./interface-scheme.js').InterfaceScheme} InterfaceScheme */
/** @typedef {import('./interface-scheme.js').InterfaceSelection} InterfaceSelection */
/** @typedef {{listInterfaceSchemes:()=>Promise<{directory:string,schemes:InterfaceScheme[]}>}} SchemeBridge */
/** @returns {void} */
export function clearSchemeVariables(){for(const key of Array.from(document.documentElement.style))if(key.startsWith('--scheme-'))document.documentElement.style.removeProperty(key);}
/** @param {InterfaceSelection} selection @returns {void} */
export function applyInterfaceSelection(selection){
  const resolved=resolveInterfaceScheme(selection.scheme,selection.values);
  if(!interfacePackageMatches(selection.scheme.presentation ?? null))clearInterfacePackage();
  clearSchemeVariables();applyCustomizationTheme(resolved.theme);applyInterfaceProfile(resolved.interfaceProfile);
  applyInterfacePackage(selection.scheme.presentation ?? null);
  for(const [key,value] of Object.entries(resolved.variables))document.documentElement.style.setProperty(key,value);
}
/** @param {SchemeBridge|null} bridge @returns {Promise<{directory:string,schemes:InterfaceScheme[]}>} */
export async function listInterfaceSchemes(bridge){
  if(bridge){const result=await bridge.listInterfaceSchemes();return {directory:result.directory,schemes:result.schemes.map(parseInterfaceScheme)};}
  const schemes=await Promise.all(['industrial','constructivist'].map(async id=>{
    const url='customization/interfaces/'+id+'.json',response=await fetch(url);
    if(!response.ok)throw new Error('界面方案读取失败：'+url+' HTTP '+response.status);
    return parseInterfaceScheme(await response.json());
  }));
  return {directory:'public/customization/interfaces',schemes};
}
