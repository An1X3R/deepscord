// @ts-check
/** @typedef {{openResourceManager:()=>Promise<void>}} ResourceManagerLinkBridge */

/** @param {ResourceManagerLinkBridge|null} bridge @param {(error:Error)=>void} reportError @returns {HTMLButtonElement} */
export function resourceManagerLink(bridge, reportError) {
  const button = document.createElement('button');
  button.id = 'resourceManagerOpen';
  button.type = 'button';
  button.className = 'btn ghost';
  button.textContent = '资源管理（主题与表情）';
  button.disabled = bridge === null;
  if (!bridge) button.title = '资源管理需要使用 Windows 客户端';
  button.addEventListener('click', () => {
    if (!bridge) return;
    button.disabled = true;
    void bridge.openResourceManager().catch(error => reportError(error instanceof Error ? error : new Error(String(error)))).finally(() => { button.disabled = false; });
  });
  return button;
}
