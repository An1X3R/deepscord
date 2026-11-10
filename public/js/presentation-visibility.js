// @ts-check
/** @typedef {{getWindowVisibility:()=>Promise<boolean>,onWindowVisibility:(handler:(visible:boolean)=>void)=>(()=>void)}} VisibilityBridge */
/** @returns {boolean} */
export function isPresentationHidden(){return document.hidden||document.documentElement.dataset.uiHidden==='true';}
/** Desktop media timers remain live, so native window visibility is authoritative.
 * @param {VisibilityBridge|null} bridge @param {()=>void} restored @param {(error:Error)=>void} reportError @returns {()=>void} */
export function installPresentationVisibility(bridge,restored,reportError){
  let nativeVisible=true,closed=false,revision=0;
  /** @returns {void} */
  function update(){
    if(closed)return;
    const wasHidden=document.documentElement.dataset.uiHidden==='true',hidden=!nativeVisible||document.hidden;
    document.documentElement.dataset.uiHidden=String(hidden);
    document.dispatchEvent(new Event('deepscord:visibility'));
    if(wasHidden&&!hidden)restored();
  }
  /** @param {boolean} visible @returns {void} */
  function receive(visible){if(typeof visible!=='boolean')throw new TypeError('Native window visibility must be boolean');nativeVisible=visible;revision+=1;update();}
  const unsubscribe=bridge?.onWindowVisibility(receive);
  document.addEventListener('visibilitychange',update);update();
  if(bridge){const current=revision;void bridge.getWindowVisibility().then(visible=>{if(!closed&&revision===current)receive(visible);}).catch(error=>{if(!closed)reportError(error instanceof Error?error:new Error(String(error)));});}
  return ()=>{closed=true;unsubscribe?.();document.removeEventListener('visibilitychange',update);};
}
