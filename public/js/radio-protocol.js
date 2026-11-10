// @ts-check
import {mediaObject,mediaId} from './chat-protocol.js';
/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {{id:string,name:string,url:string}} RadioStation */
/** @typedef {{creatorKey:string,stations:RadioStation[],stationId:string}} RadioConfig */
/** @typedef {{id:string,station:RadioStation,expiresAt:number,eligibleKeys:string[],votedKeys:string[]}} RadioVote */
/** @typedef {{channelId:string,vote:RadioVote|null,reason:string|null}} RadioState */

/** @param {JsonValue|undefined} value @returns {string} */
export function radioUrl(value) {
  if(typeof value!=='string' || value.length>2048 || /[\u0000-\u0020\u007f]/.test(value))throw new TypeError('电台链接必须是有效的 HTTP 或 HTTPS 音频地址');
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password || url.hash)throw new TypeError('电台链接仅支持 HTTP/HTTPS，不能带用户名、密码或锚点');
  return url.href;
}
/** @param {JsonValue|undefined} value @returns {RadioStation} */
export function parseRadioStation(value) {
  const row=mediaObject(value,'Radio payload');
  if(typeof row.name!=='string' || !row.name.trim() || row.name.length>80 || /[\u0000-\u001f\u007f]/.test(row.name))throw new TypeError('电台名称须为 1 至 80 个字符');
  return {id:mediaId(row.id,'Radio station ID'),name:row.name,url:radioUrl(row.url)};
}
/** @param {JsonValue|undefined} value @returns {{stations:RadioStation[],stationId:string}} */
export function parseRadioSelection(value) {
  const row=mediaObject(value,'Radio payload');
  if(!Array.isArray(row.stations) || row.stations.length<1 || row.stations.length>24)throw new TypeError('每个电台频道须保存 1 至 24 个电台');
  const stations=row.stations.map(parseRadioStation),stationId=mediaId(row.stationId,'Current station ID');
  if(new Set(stations.map(station=>station.id)).size!==stations.length || !stations.some(station=>station.id===stationId))throw new TypeError('电台列表存在重复编号或当前电台不存在');
  return {stations,stationId};
}
/** @param {JsonValue|undefined} value @returns {RadioConfig} */
export function parseRadioConfig(value) {
  const row=mediaObject(value,'Radio payload');
  if(typeof row.creatorKey!=='string' || !/^[A-Za-z0-9+/]{59}=$/.test(row.creatorKey))throw new TypeError('电台频道缺少有效的创建者身份');
  return {creatorKey:row.creatorKey,...parseRadioSelection(row)};
}
/** @param {RadioConfig} config @returns {RadioStation} */
export function currentRadioStation(config) {
  const station=config.stations.find(entry=>entry.id===config.stationId);
  if(!station)throw new TypeError('当前电台不在已保存的列表中');
  return station;
}
/** @param {JsonValue} value @returns {RadioState} */
export function parseRadioState(value) {
  const row=mediaObject(value,'Radio payload'),channelId=mediaId(row.channelId,'Radio channel ID');
  const reason=row.reason===null ? null : typeof row.reason==='string' && row.reason.length<=200 ? row.reason : undefined;
  if(reason===undefined)throw new TypeError('Invalid radio vote reason');
  if(row.vote===null)return {channelId,vote:null,reason};
  const vote=mediaObject(row.vote,'Radio vote');
  if(typeof vote.expiresAt!=='number' || !Number.isSafeInteger(vote.expiresAt))throw new TypeError('Invalid radio vote expiry');
  /** @param {JsonValue|undefined} keys @returns {string[]} */
  function memberKeys(keys) {
    if(!Array.isArray(keys) || keys.length>256 || keys.some(key=>typeof key!=='string' || key.length!==60))throw new TypeError('Invalid radio voters');
    return /** @type {string[]} */(keys);
  }
  return {channelId,vote:{id:mediaId(vote.id,'Radio vote ID'),station:parseRadioStation(vote.station),expiresAt:vote.expiresAt,eligibleKeys:memberKeys(vote.eligibleKeys),votedKeys:memberKeys(vote.votedKeys)},reason};
}
