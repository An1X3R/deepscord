// @ts-check
import {mediaObject} from './app-server/public/js/chat-protocol.js';
import {parseTheme} from './app-server/public/js/customization-protocol.js';
import {applyCustomizationTheme} from './app-server/public/js/customization-theme.js';
import {applyInterfaceProfile,parseInterfaceProfile,INTERFACE_PRESETS} from './app-server/public/js/interface-profile.js';
import {parseInterfaceSelection,resolveInterfaceScheme} from './app-server/public/js/interface-scheme.js';
import {baseVariables,validateCss} from './app-server/public/js/interface-package.js';

/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{getLocalInterface:()=>Promise<JsonValue>}} LocalInterfaceApi */
/** @param {LocalInterfaceApi} api @returns {Promise<void>} */
export async function loadLocalInterface(api) {
  try {
    const input=await api.getLocalInterface();
    const saved=input===null?null:mediaObject(input,'Local interface');
    const selection=saved?.selection==null?null:parseInterfaceSelection(saved.selection);
    const resolved=selection?resolveInterfaceScheme(selection.scheme,selection.values):null;
    const theme=resolved?resolved.theme:saved?.theme==null?null:parseTheme(saved.theme);
    const profile=resolved?resolved.interfaceProfile:saved?parseInterfaceProfile(saved.profile):INTERFACE_PRESETS.industrial;
    applyCustomizationTheme(theme);
    applyInterfaceProfile(profile);
    const presentation=selection?.scheme.presentation;
    if(presentation){
      validateCss(presentation.css);
      const style=document.createElement('style');
      style.id='localInterfaceStyle';
      style.textContent=presentation.css;
      document.head.append(style);
      document.documentElement.dataset.interfacePackage='true';
      for(const key of baseVariables)document.documentElement.style.removeProperty(key);
    }
    for(const [key,value] of Object.entries(resolved?.variables??{}))document.documentElement.style.setProperty(key,value);
    document.documentElement.dataset.localScheme=selection?.scheme.id??profile.preset;
  } finally {
    document.documentElement.dataset.localInterface='ready';
  }
}
