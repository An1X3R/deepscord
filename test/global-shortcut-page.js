// @ts-check
import { createFeatureSettings } from '../public/js/feature-settings.js';
/** @typedef {import('../public/js/feature-settings.js').DesktopSettings} DesktopSettings */
const bridge = /** @type {Window & {deepscord?:{getDesktopSettings:()=>Promise<DesktopSettings>,setDesktopSettings:(settings:DesktopSettings)=>Promise<DesktopSettings>,onMuteShortcut:(callback:()=>void)=>()=>void}}} */ (window).deepscord;
if (!bridge) throw new Error('Actual desktop preload bridge is required');
/** @type {string[]} */ const errors = [];
/** @type {{type:string,code:string,control:boolean,alt:boolean,shift:boolean}[]} */ const keys = [];
for (const type of ['keydown','keyup']) window.addEventListener(type, event => { if (event instanceof KeyboardEvent) keys.push({ type, code:event.code, control:event.ctrlKey, alt:event.altKey, shift:event.shiftKey }); }, true);
let mutes = 0;
bridge.onMuteShortcut(() => { mutes += 1; });
const fixture = document.getElementById('fixture');
if (!fixture) throw new Error('Shortcut fixture is missing');
fixture.append(createFeatureSettings(await bridge.getDesktopSettings(), async settings => { await bridge.setDesktopSettings(settings); }, error => { errors.push(error.message); }));
Object.assign(window, { shortcutEvidence:()=>({ mutes, errors:[...errors], keys:[...keys] }), shortcutReady:true });
