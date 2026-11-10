// @ts-check
'use strict';
/** @typedef {{stationId:string,format:'audio'|'hls',urls:Set<string>}} RadioGrant */
/** @typedef {{id:number,url:string,webContentsId?:number,method:string,resourceType:string}} RadioRequest */
/** @typedef {ReturnType<typeof createRadioAccess>} RadioAccess */

/** @param {string} value @returns {string} */
function resourceUrl(value) {
  if(typeof value!=='string' || value.length>4096)throw new TypeError('Radio resource URL exceeds its limit');
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password)throw new TypeError('Radio resources require HTTP(S) without embedded credentials');
  url.hash='';return url.href;
}
/** @param {string} value @returns {void} */
function stationId(value) {if(typeof value!=='string' || !/^[A-Za-z0-9-]{1,80}$/.test(value))throw new TypeError('Invalid radio playback session');}

/** Keep network grants at the trusted desktop connector, scoped to one active station. */
function createRadioAccess() {
  /** @type {Map<number,RadioGrant>} */const grants=new Map();
  /** @type {Map<number,{owner:number,stationId:string,count:number}>} */const redirects=new Map();
  /** @param {number} owner @returns {void} */
  function clear(owner) {grants.delete(owner);for(const [id,request] of redirects)if(request.owner===owner)redirects.delete(id);}
  /** @param {number} owner @param {string} id @param {string} url @param {'audio'|'hls'} format @returns {void} */
  function grant(owner,id,url,format) {
    stationId(id);const resource=resourceUrl(url);
    if(!Number.isSafeInteger(owner) || owner<1 || format!=='audio' && format!=='hls')throw new TypeError('Invalid radio network grant');
    clear(owner);grants.set(owner,{stationId:id,format,urls:new Set([resource])});
  }
  /** @param {RadioGrant} current @param {string} url @returns {void} */
  function remember(current,url) {
    current.urls.delete(url);current.urls.add(url);
    while(current.urls.size>256){const oldest=current.urls.values().next().value;if(oldest===undefined)throw new Error('Radio network grant accounting failed');current.urls.delete(oldest);}
  }
  /** @param {number} owner @param {string} id @param {string} url @returns {void} */
  function authorize(owner,id,url) {
    stationId(id);const resource=resourceUrl(url),current=grants.get(owner);
    if(!current || current.stationId!==id || current.format!=='hls')throw new TypeError('HLS resource belongs to an inactive radio station');
    remember(current,resource);
  }
  /** @param {number} owner @param {string} id @returns {void} */
  function release(owner,id) {stationId(id);if(grants.get(owner)?.stationId===id)clear(owner);}
  /** @param {RadioRequest} request @returns {boolean} */
  function permits(request) {
    const current=request.webContentsId===undefined?null:grants.get(request.webContentsId);
    if((redirects.get(request.id)?.count ?? 0)>4 || redirects.size>=256 && !redirects.has(request.id))return false;
    if(!current || request.method!=='GET' || !(request.resourceType==='media' || current.format==='hls' && request.resourceType==='xhr'))return false;
    const url=new URL(request.url);url.hash='';
    return current.urls.has(url.href);
  }
  /** @param {Electron.OnBeforeRedirectListenerDetails} request @returns {void} */
  function redirect(request) {
    if(!permits(request) || request.webContentsId===undefined)return;
    const current=grants.get(request.webContentsId);if(!current)return;
    const count=(redirects.get(request.id)?.count ?? 0)+1;
    redirects.set(request.id,{owner:request.webContentsId,stationId:current.stationId,count});
    if(count>4){console.warn('radio_redirect_limit',{owner:request.webContentsId,requestId:request.id,count});return;}
    const target=new URL(request.redirectURL);
    if(!['http:','https:'].includes(target.protocol) || target.username || target.password)return;
    remember(current,resourceUrl(target.href));
  }
  /** @param {{id:number}} request @returns {void} */
  function complete(request) {redirects.delete(request.id);}
  return {grant,authorize,release,clear,permits,redirect,complete};
}
module.exports={createRadioAccess};
