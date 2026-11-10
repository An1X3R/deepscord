// @ts-check
/** Schedule reclamation only after playback and decoding have both stopped.
 * @param {{delayMs:number,isBusy:()=>boolean,release:()=>Promise<void>,reportError:(error:Error)=>void}} options */
export function createAudioIdleRelease(options){
  if(!Number.isSafeInteger(options.delayMs)||options.delayMs<1000)throw new RangeError('Audio idle delay must be at least 1000 ms');
  /** @type {ReturnType<typeof setTimeout>|null} */let timer=null;
  /** @returns {void} */
  function cancel(){if(timer!==null)clearTimeout(timer);timer=null;}
  /** @returns {void} */
  function schedule(){
    cancel();if(options.isBusy())return;
    timer=setTimeout(()=>{timer=null;if(!options.isBusy())void options.release().catch(error=>options.reportError(error instanceof Error?error:new Error(String(error))));},options.delayMs);
  }
  return {cancel,schedule};
}
