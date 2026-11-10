// @ts-check
/** @typedef {'interfaces'|'interactions'} GuideKind */
/** @typedef {{openCustomizationDirectory:(kind:GuideKind)=>Promise<void>}} DirectoryBridge */
const GUIDES={interfaces:'界面方案目录与开发指南',interactions:'互动定义目录与开发指南'};
/** @param {GuideKind} kind @param {DirectoryBridge|null} bridge @returns {Promise<void>} */
export async function openCustomizationDirectory(kind,bridge){
  if(!bridge)throw new Error('打开本机自定义目录需要使用 Windows 客户端。');
  await bridge.openCustomizationDirectory(kind);
}
/** @param {GuideKind} kind @param {DirectoryBridge|null} bridge @param {(error:Error)=>void} reportError @returns {HTMLAnchorElement} */
export function developerGuideLink(kind,bridge,reportError){
  const link=document.createElement('a');link.id='developerGuide-'+kind;link.className='developer-guide-link';link.href='#customization-'+kind;link.textContent=GUIDES[kind];
  link.addEventListener('click',event=>{event.preventDefault();void openCustomizationDirectory(kind,bridge).catch(error=>reportError(error instanceof Error?error:new Error(String(error))));});
  return link;
}
