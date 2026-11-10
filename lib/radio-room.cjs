// @ts-check
'use strict';
const {randomUUID}=require('node:crypto');
const {parseRadioConfig,parseRadioStation,currentRadioStation}=require('../public/js/radio-protocol.js');
const {stateCanManageDomain}=require('./server-governance.cjs');
/** @typedef {import('../public/js/radio-protocol.js').RadioConfig} RadioConfig */
/** @typedef {import('../public/js/radio-protocol.js').RadioStation} RadioStation */
/** @typedef {import('../public/js/radio-protocol.js').RadioState} RadioState */
/** @typedef {import('../public/js/network-protocol.js').JsonValue} JsonValue */
/** @typedef {{userId:string,memberKey:string,channelId:string|null}} RadioMember */
/** @typedef {{channelId:string,domainId:string,radio:RadioConfig}} RadioChannel */
/** @typedef {{channels:RadioChannel[],members:RadioMember[],policy:import('./server-governance.cjs').GovernanceState}} RadioContext */
/** @typedef {{getContext:()=>RadioContext,commit:(channelId:string,radio:RadioConfig)=>void,broadcast:(state:RadioState)=>void,now:()=>number}} RadioOptions */
/** @typedef {{id:string,station:RadioStation,expiresAt:number,eligibleKeys:string[],votedKeys:string[],baseline:string}} PendingVote */

/** @param {RadioContext} context @param {RadioChannel} channel @param {string} memberKey @returns {boolean} */
function canEditRadio(context,channel,memberKey) {
  return memberKey===channel.radio.creatorKey || stateCanManageDomain(context.policy,memberKey,channel.domainId,'manageChannels');
}
/** @param {RadioContext} context @param {RadioChannel} channel @returns {string[]} */
function listeners(context,channel) {
  return [...new Set(context.members.filter(member=>member.channelId===channel.channelId).map(member=>member.memberKey))].sort();
}
/** @param {RadioOptions} options */
function createRadioRoom(options) {
  /** @type {Map<string,PendingVote>} */const votes=new Map();
  /** @param {string} channelId @param {string|null} reason @returns {RadioState} */
  function state(channelId,reason) {
    const vote=votes.get(channelId);
    return {channelId,vote:vote ? {id:vote.id,station:{...vote.station},expiresAt:vote.expiresAt,eligibleKeys:[...vote.eligibleKeys],votedKeys:[...vote.votedKeys]} : null,reason};
  }
  /** @param {string} channelId @param {string} reason @returns {void} */
  function cancel(channelId,reason) {votes.delete(channelId);options.broadcast(state(channelId,reason));}
  /** @returns {void} */
  function reconcile() {
    if(!votes.size)return;
    const context=options.getContext();
    for(const [id,vote] of votes) {
      const channel=context.channels.find(entry=>entry.channelId===id);
      if(!channel)cancel(id,'电台频道已移除');
      else if(context.members.some(member=>canEditRadio(context,channel,member.memberKey)))cancel(id,'电台创建者或管理人员已上线，本次投票取消');
      else if(JSON.stringify(channel.radio)!==vote.baseline)cancel(id,'电台配置已改变，本次投票取消');
      else if(JSON.stringify(listeners(context,channel))!==JSON.stringify(vote.eligibleKeys))cancel(id,'听众发生变化，请重新发起投票');
      else if(options.now()>=vote.expiresAt)cancel(id,'换台投票未在 60 秒内获得过半赞成');
    }
  }
  /** @param {string} userId @param {string} channelId @returns {{context:RadioContext,channel:RadioChannel,member:RadioMember}} */
  function requireChannel(userId,channelId) {
    reconcile();
    const context=options.getContext(),channel=context.channels.find(entry=>entry.channelId===channelId),member=context.members.find(entry=>entry.userId===userId);
    if(!channel)throw new TypeError('电台频道已不存在');
    if(!member)throw new TypeError('请等待成员身份验证完成后再操作电台');
    return {context,channel,member};
  }
  /** @param {string} userId @param {string} channelId @param {JsonValue} input @returns {void} */
  function change(userId,channelId,input) {
    const {context,channel,member}=requireChannel(userId,channelId);
    if(!canEditRadio(context,channel,member.memberKey))throw new TypeError('只有电台创建者或有频道管理权限的成员可以直接更换和管理电台');
    const radio=parseRadioConfig(input);
    if(radio.creatorKey!==channel.radio.creatorKey)throw new TypeError('电台创建者身份不可修改');
    options.commit(channelId,radio);
    if(votes.has(channelId))cancel(channelId,'管理人员已更新电台');
  }
  /** @param {string} channelId @param {PendingVote} vote @returns {void} */
  function settle(channelId,vote) {
    if(vote.votedKeys.length<=vote.eligibleKeys.length/2) {options.broadcast(state(channelId,null));return;}
    const channel=options.getContext().channels.find(entry=>entry.channelId===channelId);
    if(!channel)throw new TypeError('投票的电台频道已不存在');
    const existing=channel.radio.stations.find(entry=>entry.id===vote.station.id);
    const stations=existing ? channel.radio.stations : [...channel.radio.stations,vote.station];
    options.commit(channelId,parseRadioConfig({...channel.radio,stations,stationId:vote.station.id}));
    cancel(channelId,'投票已过半，正在切换电台');
  }
  /** @param {string} userId @param {string} channelId @param {JsonValue} input @returns {void} */
  function propose(userId,channelId,input) {
    const {context,channel,member}=requireChannel(userId,channelId);
    if(member.channelId!==channelId)throw new TypeError('加入此电台频道后才能发起换台投票');
    if(context.members.some(entry=>canEditRadio(context,channel,entry.memberKey)))throw new TypeError('电台创建者或管理人员在线，请由他们更换电台');
    if(votes.has(channelId))throw new TypeError('当前已有换台投票，请等待结束');
    const station=parseRadioStation(input),existing=channel.radio.stations.find(entry=>entry.id===station.id);
    if(existing && JSON.stringify(existing)!==JSON.stringify(station))throw new TypeError('已保存的电台配置已变化，请重新选择');
    if(!existing && channel.radio.stations.length>=24)throw new RangeError('已保存 24 个电台，请由管理人员清理后再添加');
    if(currentRadioStation(channel.radio).url===station.url)throw new TypeError('当前已在收听此电台');
    const vote={id:randomUUID(),station,expiresAt:options.now()+60000,eligibleKeys:listeners(context,channel),votedKeys:[member.memberKey],baseline:JSON.stringify(channel.radio)};
    votes.set(channelId,vote);settle(channelId,vote);
  }
  /** @param {string} userId @param {string} channelId @param {string} voteId @returns {void} */
  function approve(userId,channelId,voteId) {
    const {member}=requireChannel(userId,channelId),vote=votes.get(channelId);
    if(!vote || vote.id!==voteId)throw new TypeError('此换台投票已结束');
    if(member.channelId!==channelId || !vote.eligibleKeys.includes(member.memberKey))throw new TypeError('你不是本次换台投票的听众');
    if(vote.votedKeys.includes(member.memberKey))throw new TypeError('你已经投过赞成票');
    const next={...vote,votedKeys:[...vote.votedKeys,member.memberKey]};votes.set(channelId,next);settle(channelId,next);
  }
  /** @returns {RadioState[]} */
  function snapshot() {reconcile();return [...votes.keys()].map(id=>state(id,null));}
  return {change,propose,approve,reconcile,snapshot};
}
module.exports={createRadioRoom,canEditRadio};
