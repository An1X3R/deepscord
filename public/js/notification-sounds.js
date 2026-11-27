// @ts-check
/** @typedef {'join'|'leave'} SoundKind */
/** @typedef {{name:string,data:string}} SoundRecord */
/** @typedef {{readNotificationSound:(kind:SoundKind)=>Promise<SoundRecord|null>,chooseNotificationSound:(kind:SoundKind)=>Promise<{token:string,record:SoundRecord}|null>,saveNotificationSound:(input:{token:string})=>Promise<void>,resetNotificationSound:(kind:SoundKind)=>Promise<void>}} SoundBridge */
/** @typedef {{record:SoundRecord,url:string,audio:HTMLAudioElement}} LoadedSound */
const MAX_BYTES=2*1024*1024;
/** @param {SoundKind} kind @returns {void} */
function validateKind(kind){if(kind!=='join'&&kind!=='leave')throw new TypeError('提示音类型必须为加入或离开');}
/** @param {SoundRecord} record @returns {Uint8Array<ArrayBuffer>} */
function soundBytes(record){
  if(!record||typeof record!=='object'||typeof record.name!=='string'||!record.name.length||record.name.length>255||typeof record.data!=='string'||!record.data.length||record.data.length>Math.ceil(MAX_BYTES/3)*4)throw new TypeError('本机提示音记录损坏，请重新选择音频或恢复默认');
  let text;try{text=atob(record.data);}catch(error){throw new TypeError('本机提示音编码损坏，请重新选择音频或恢复默认',{cause:error});}if(text.length>MAX_BYTES)throw new RangeError('提示音文件不能超过 2 MiB');return Uint8Array.from(text,char=>char.charCodeAt(0));
}
/** @returns {Promise<IDBDatabase>} */
function openDatabase(){return new Promise((resolve,reject)=>{const request=indexedDB.open('deepscord-notification-sounds',1);request.onupgradeneeded=()=>request.result.createObjectStore('sounds');request.onerror=()=>reject(request.error);request.onsuccess=()=>resolve(request.result);});}
/** @param {SoundKind} kind @returns {Promise<SoundRecord|null>} */
async function readBrowser(kind){const db=await openDatabase();try{return await new Promise((resolve,reject)=>{const transaction=db.transaction('sounds','readonly'),request=transaction.objectStore('sounds').get(kind);request.onsuccess=()=>resolve(request.result===undefined?null:request.result);transaction.onerror=()=>reject(transaction.error);});}finally{db.close();}}
/** @param {SoundKind} kind @param {SoundRecord|null} record @returns {Promise<void>} */
async function writeBrowser(kind,record){const db=await openDatabase();try{await new Promise((resolve,reject)=>{const transaction=db.transaction('sounds','readwrite'),store=transaction.objectStore('sounds');if(record===null)store.delete(kind);else store.put(record,kind);transaction.oncomplete=()=>resolve(undefined);transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);});}finally{db.close();}}
/** @param {AbortSignal} signal @returns {Promise<SoundRecord|null>} */
function chooseBrowser(signal){return new Promise((resolve,reject)=>{
  const input=document.createElement('input');input.type='file';input.accept='.mp3,.wav,.ogg,.m4a,.flac,audio/*';
  /** @returns {void} */function cleanup(){signal.removeEventListener('abort',abort);input.remove();}
  /** @returns {void} */function abort(){cleanup();reject(new Error('本机提示音选择已取消：播放器已关闭'));}
  signal.addEventListener('abort',abort,{once:true});
  input.addEventListener('cancel',()=>{cleanup();resolve(null);},{once:true});
  input.addEventListener('change',async()=>{try{const file=input.files?.[0];if(!file){resolve(null);return;}if(file.size<1||file.size>MAX_BYTES)throw new RangeError('提示音文件必须为 1 字节至 2 MiB');const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));resolve({name:file.name,data:btoa(binary)});}catch(error){reject(error);}finally{cleanup();}},{once:true});
  input.hidden=true;document.body.append(input);input.click();
});}
/** @param {HTMLAudioElement} audio @param {AbortSignal} signal @returns {Promise<void>} */
function readMetadata(audio,signal){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>finish(new Error('提示音读取超时，请选择可播放的音频')),10000);
/** @param {Error|null} error */
function finish(error){clearTimeout(timer);signal.removeEventListener('abort',abort);audio.onloadedmetadata=null;audio.onerror=null;if(error)reject(error);else resolve();}function abort(){finish(new Error('本机提示音读取已取消：播放器已关闭'));}signal.addEventListener('abort',abort,{once:true});if(signal.aborted){abort();return;}audio.onloadedmetadata=()=>finish(null);audio.onerror=()=>finish(new Error('提示音格式损坏或当前客户端不支持，请选择 MP3、WAV、OGG、M4A 或 FLAC'));audio.load();});}
/** @param {SoundRecord} record @param {AbortSignal} signal @returns {Promise<LoadedSound>} */
async function loadSound(record,signal){
  const bytes=soundBytes(record),url=URL.createObjectURL(new Blob([bytes])),audio=new Audio(url);audio.preload='metadata';
  try{
    await readMetadata(audio,signal);if(!Number.isFinite(audio.duration)||audio.duration<=0||audio.duration>10)throw new RangeError('提示音时长必须大于 0 且不超过 10 秒');
    const context=new AudioContext();
    try{const decoded=await context.decodeAudioData(bytes.buffer);if(decoded.duration>10||decoded.numberOfChannels>2||decoded.length*decoded.numberOfChannels*4>16*1024*1024)throw new RangeError('提示音解码后超过 10 秒、双声道或 16 MiB 限制');}finally{await context.close();}
    audio.preload='auto';return {record,url,audio};
  }catch(error){audio.removeAttribute('src');audio.load();URL.revokeObjectURL(url);throw error instanceof RangeError?error:new Error('无法解码提示音，请重新选择有效的音频文件',{cause:error});}
}
/** @param {LoadedSound} loaded @returns {void} */
function release(loaded){loaded.audio.pause();loaded.audio.removeAttribute('src');loaded.audio.load();URL.revokeObjectURL(loaded.url);}
/** @param {{reportError:(error:Error)=>void}} options */
export function createNotificationSounds({reportError}){
  const bridge=/** @type {Window & {deepscord?:SoundBridge}} */(window).deepscord;
  /** @type {Map<SoundKind,Promise<LoadedSound|null>>} */const cache=new Map();
  /** @type {Map<SoundKind,LoadedSound>} */const loadedSounds=new Map();
  const lifetime=new AbortController();
  let destroyed=false,busy=false,playSequence=0;
  /** @returns {void} */function assertAlive(){if(destroyed)throw new Error('本机提示音播放器已关闭');}
  /** @param {SoundKind} kind @returns {Promise<LoadedSound|null>} */
  function get(kind){validateKind(kind);assertAlive();const saved=cache.get(kind);if(saved)return saved;
    /** @type {Promise<LoadedSound|null>} */
    let promise=Promise.resolve(null);promise=(async()=>{const record=bridge?await bridge.readNotificationSound(kind):await readBrowser(kind);if(record===null)return null;const loaded=await loadSound(record,lifetime.signal);if(destroyed||cache.get(kind)!==promise){release(loaded);assertAlive();return get(kind);}install(kind,loaded);return loaded;})();cache.set(kind,promise);return promise;}
  /** @param {SoundKind} kind @returns {void} */
  function discard(kind){playSequence++;const loaded=loadedSounds.get(kind);if(loaded)release(loaded);loadedSounds.delete(kind);cache.delete(kind);}
  /** @param {SoundKind} kind @returns {Promise<string|null>} */
  async function choose(kind){validateKind(kind);assertAlive();if(busy)throw new Error('请等待当前提示音设置完成');busy=true;let candidate=null;
    try{const selected=bridge?await bridge.chooseNotificationSound(kind):null;const record=bridge?selected?.record??null:await chooseBrowser(lifetime.signal);if(record===null)return null;assertAlive();candidate=await loadSound(record,lifetime.signal);assertAlive();if(bridge&&selected)await bridge.saveNotificationSound({token:selected.token});else await writeBrowser(kind,record);assertAlive();discard(kind);install(kind,candidate);cache.set(kind,Promise.resolve(candidate));candidate=null;return record.name;}finally{if(candidate)release(candidate);busy=false;}}
  /** @param {SoundKind} kind @param {{volume:number,outputDeviceId:string}} options @returns {Promise<boolean>} */
  async function play(kind,{volume,outputDeviceId}){
    assertAlive();if(!Number.isFinite(volume)||volume<0||volume>1||typeof outputDeviceId!=='string'||!outputDeviceId.length)throw new RangeError('提示音输出设备或音量无效');
    const sequence=++playSequence,loaded=await get(kind);if(!loaded)return false;if(destroyed||sequence!==playSequence)return true;
    for(const sound of loadedSounds.values())sound.audio.pause();
    const audio=/** @type {HTMLAudioElement & {setSinkId?:(id:string)=>Promise<void>}} */(loaded.audio);
    if(audio.setSinkId)await audio.setSinkId(outputDeviceId);else if(outputDeviceId!=='default')throw new Error('当前客户端不支持选择提示音输出设备');
    if(destroyed||sequence!==playSequence)return true;audio.currentTime=0;audio.volume=volume;
    try{await audio.play();}catch(error){if((destroyed||sequence!==playSequence)&&error instanceof DOMException&&error.name==='AbortError')return true;throw error;}return true;
  }
  /** @param {SoundKind} kind @returns {Promise<void>} */
  async function reset(kind){validateKind(kind);assertAlive();if(busy)throw new Error('请等待当前提示音设置完成');busy=true;try{if(bridge)await bridge.resetNotificationSound(kind);else await writeBrowser(kind,null);discard(kind);}finally{busy=false;}}
  /** @returns {void} */function destroy(){if(destroyed)return;destroyed=true;lifetime.abort();playSequence++;for(const loaded of loadedSounds.values())release(loaded);loadedSounds.clear();cache.clear();}
  /** @param {SoundKind} kind @param {LoadedSound} loaded @returns {void} */
  function install(kind,loaded){loaded.audio.addEventListener('error',()=>{if(!destroyed&&loadedSounds.get(kind)===loaded)reportError(new Error('本机提示音播放失败，请重新选择音频或恢复默认'));});loadedSounds.set(kind,loaded);}
  return {choose,play,reset,destroy};
}
