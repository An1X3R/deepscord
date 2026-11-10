// @ts-check
import { objectValue } from './network-protocol.js';
import {parseServerEmoji,parseMediaMetadata,checkMediaKind,mediaInteger} from './chat-protocol.js';
import {parseTheme,parseCustomInteraction,parseCustomization} from './customization-protocol.js';
import {mediaId} from './chat-protocol.js';
import {memberRole,memberRoleLabel,roleRank,canManageMember,memberTitles} from './member-permissions.js';
import {parseGovernanceCheckpoint} from './governance-checkpoint.js';

/** @typedef {import('./network-protocol.js').JsonValue} JsonValue */
/** @typedef {import('../../lib/server-governance.cjs').GovernanceCommand} GovernanceCommand */
/** @typedef {import('../../lib/server-governance.cjs').GovernanceJournal} GovernanceJournal */
/** @typedef {import('../../lib/server-governance.cjs').GovernanceState} GovernanceState */
/** @typedef {import('../../lib/server-governance.cjs').GovernanceDomain} GovernanceDomain */
/** @typedef {import('../../lib/server-governance.cjs').DomainPermission} DomainPermission */
/** @typedef {import('../../lib/server-governance.cjs').DomainRole} DomainRole */
/** @typedef {{domainId:string,role:DomainRole,permissions:DomainPermission[],manageRoles:boolean}} Capability */
/** @typedef {{server:{id:string,name:string},journal:GovernanceJournal,policy:GovernanceState,selfKey:string|null,capabilities:Capability[],members:{userId:string,memberKey:string|null}[],ownerClaimAvailable:boolean}} ServerState */
/** @typedef {{title:string,body:HTMLElement,width:number,footer:HTMLElement[]}} ModalOptions */
/** @typedef {{close:()=>void}} ModalView */
/** @typedef {{snapshot:ServerState,domainId:string|null,domainName:string,selectedMemberKey:string|null,users:{id:string,name:string}[],submit:(command:GovernanceCommand)=>Promise<void>,claim:(token:string)=>Promise<void>,modal:(options:ModalOptions)=>ModalView}} PanelOptions */

/** @param {JsonValue|undefined} value @param {string} field @param {number} maximum @returns {string} */
function text(value, field, maximum) {
  if (typeof value !== 'string' || !value.length || value.length > maximum) throw new TypeError(field + ' must be a nonempty string of at most ' + maximum + ' characters');
  return value;
}
/** @param {JsonValue|undefined} value @param {string} field @param {number} maximum @returns {JsonValue[]} */
function rows(value, field, maximum) {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(field + ' must be an array of at most ' + maximum + ' entries');
  return value;
}
/** @param {JsonValue|undefined} value @returns {DomainPermission[]} */
function permissions(value) {
  return rows(value, 'Permissions', 3).map(entry => {
    if (entry !== 'manageChannels' && entry !== 'manageMessages' && entry !== 'moderateVoice') throw new TypeError('Unsupported domain permission');
    return entry;
  });
}
/** @param {JsonValue|undefined} value @returns {string[]} */
function keys(value) { return rows(value, 'Member keys', 256).map(entry => text(entry, 'Member key', 1024)); }
/** @param {JsonValue} value @returns {GovernanceCommand} */
export function parseGovernanceCommand(value) {
  const row = objectValue(value);
  const type = row.type;
  if(type==='setMemberAccess'){
    if(row.role!=='server-admin' && row.role!=='domain-owner' && row.role!=='domain-admin' && row.role!=='member')throw new TypeError('Invalid member role');
    const domainId=row.domainId===null?null:text(row.domainId,'Domain ID',80),groupIds=keys(row.groupIds).sort();
    if(groupIds.length>64 || new Set(groupIds).size!==groupIds.length)throw new TypeError('Invalid member groups');
    if(domainId===null && (groupIds.length || row.role==='domain-owner' || row.role==='domain-admin'))throw new TypeError('Domain roles and groups require a domain');
    return {type,domainId,memberKey:text(row.memberKey,'Member key',1024),role:row.role,groupIds};
  }
  if (type === 'renameServer') return {type, name:text(row.name, 'Server name', 80)};
  if (type === 'transferOwner') return {type, memberKey:text(row.memberKey, 'Member key', 1024)};
  if(type==='setServerAdmin'){
    if(typeof row.enabled!=='boolean')throw new TypeError('Server admin enabled must be boolean');
    return {type,memberKey:text(row.memberKey,'Member key',1024),enabled:row.enabled};
  }
  if(type==='setTheme')return {type,domainId:row.domainId===null ? null : mediaId(row.domainId,'Customization domain'),theme:row.theme===null ? null : parseTheme(row.theme)};
  if(type==='initializeInteractionCatalog' || type==='migrateServerCatalog')return {type};
  if(type==='putInteraction')return {type,domainId:row.domainId===null ? null : mediaId(row.domainId,'Customization domain'),interaction:parseCustomInteraction(row.interaction)};
  if(type==='deleteInteraction')return {type,domainId:row.domainId===null ? null : mediaId(row.domainId,'Customization domain'),interactionId:mediaId(row.interactionId,'Interaction ID')};
  const emojiDomain=row.domainId===null ? null : text(row.domainId,'Domain ID',80);
  if(type==='deleteEmoji')return{type,domainId:emojiDomain,emojiId:text(row.emojiId,'Emoji ID',80)};
  if(type==='putEmoji'){
    if(row.asset===undefined)throw new TypeError('Emoji command lacks an asset');
    return{type,domainId:emojiDomain,emojiId:text(row.emojiId,'Emoji ID',80),name:text(row.name,'Emoji name',40),asset:checkMediaKind(parseMediaMetadata(row.asset),'server'),ts:mediaInteger(row.ts,'Emoji time',0,Number.MAX_SAFE_INTEGER)};
  }
  const domainId=text(row.domainId,'Domain ID',80);
  if (type === 'deleteDomain') return {type,domainId};
  if (type === 'setDomainOwner') return {type, domainId, memberKey:text(row.memberKey, 'Member key', 1024)};
  if (type === 'setDomainAdmin') {
    if (typeof row.enabled !== 'boolean') throw new TypeError('Admin enabled must be boolean');
    return {type, domainId, memberKey:text(row.memberKey, 'Member key', 1024), enabled:row.enabled};
  }
  if (type === 'setMemberGroups') return {type,domainId,memberKey:text(row.memberKey,'Member key',1024),groupIds:keys(row.groupIds)};
  const groupId = text(row.groupId, 'Group ID', 80);
  if (type === 'putGroup') return {type,domainId,groupId,name:text(row.name,'Group name',40),...(row.title===undefined ? {} : {title:text(row.title,'Group title',24)}),permissions:permissions(row.permissions)};
  if (type === 'deleteGroup') return {type,domainId,groupId};
  throw new TypeError('Unsupported governance command');
}
/** @param {JsonValue} value @returns {GovernanceJournal} */
function journal(value) {
  const row = objectValue(value);
  if (row.version !== 1) throw new TypeError('Unsupported governance version');
  const events = rows(row.events, 'Governance events', 2048).map(entry => {
    const event = objectValue(entry);
    if (typeof event.revision !== 'number' || !Number.isSafeInteger(event.revision) || event.revision < 1) throw new TypeError('Invalid governance revision');
    return {revision:event.revision,previousDigest:text(event.previousDigest,'Previous digest',64),actorKey:text(event.actorKey,'Actor key',1024),signature:text(event.signature,'Signature',1024),command:parseGovernanceCommand(event.command === undefined ? null : event.command)};
  });
  return {version:1,roomId:text(row.roomId,'Room ID',80),creatorKey:text(row.creatorKey,'Creator key',1024),digest:text(row.digest,'Digest',64),events,...(row.checkpoint===undefined?{}:{checkpoint:parseGovernanceCheckpoint(row.checkpoint)})};
}
/** @param {JsonValue} value @returns {GovernanceDomain} */
function domain(value) {
  const row = objectValue(value);
  return {id:text(row.id,'Domain ID',80),ownerKey:text(row.ownerKey,'Domain owner',1024),admins:keys(row.admins),groups:rows(row.groups,'Groups',64).map(entry=>{
    const group=objectValue(entry);
    return {id:text(group.id,'Group ID',80),name:text(group.name,'Group name',40),...(group.title===undefined ? {} : {title:text(group.title,'Group title',24)}),permissions:permissions(group.permissions)};
  }),members:rows(row.members,'Members',256).map(entry=>{
    const member=objectValue(entry);
    return {memberKey:text(member.memberKey,'Member key',1024),groupIds:keys(member.groupIds)};
  })};
}
/** @param {JsonValue} value @returns {ServerState} */
export function parseServerState(value) {
  const row=objectValue(value), server=objectValue(row.server === undefined ? null : row.server), policy=objectValue(row.policy === undefined ? null : row.policy);
  if (row.t !== 'serverState') throw new TypeError('Expected serverState');
  if (row.selfKey !== null && typeof row.selfKey !== 'string') throw new TypeError('Invalid self member key');
  if (row.ownerClaimAvailable !== undefined && typeof row.ownerClaimAvailable !== 'boolean') throw new TypeError('Invalid owner claim availability');
  if(policy.interactionCatalogVersion!==undefined && policy.interactionCatalogVersion!==1 && policy.interactionCatalogVersion!==2)throw new TypeError('Unsupported interaction catalog version');
  const parsedJournal=journal(row.journal === undefined ? null : row.journal);
  const serverId=text(server.id,'Server ID',80);
  if (parsedJournal.roomId !== serverId) throw new TypeError('Governance journal belongs to a different server');
  return {server:{id:serverId,name:text(server.name,'Server name',80)},journal:parsedJournal,policy:{...(policy.interactionCatalogVersion===1 || policy.interactionCatalogVersion===2 ? {interactionCatalogVersion:policy.interactionCatalogVersion} : {}),ownerKey:text(policy.ownerKey,'Server owner',1024),name:text(policy.name,'Server name',80),domains:rows(policy.domains,'Domains',12).map(domain),...(policy.serverAdmins===undefined ? {} : {serverAdmins:rows(policy.serverAdmins,'Server administrators',64).map(entry=>text(entry,'Member key',1024))}),...(policy.emojis===undefined ? {} : {emojis:rows(policy.emojis,'Server emojis',256).map(parseServerEmoji)}),...(policy.customization===undefined ? {} : {customization:parseCustomization(policy.customization)})},selfKey:row.selfKey,ownerClaimAvailable:row.ownerClaimAvailable === true,capabilities:rows(row.capabilities,'Capabilities',12).map(entry=>{
    const item=objectValue(entry),role=item.role;
    if (role !== 'server-owner' && role !== 'domain-owner' && role !== 'server-admin' && role !== 'domain-admin' && role !== 'special' && role !== 'member') throw new TypeError('Invalid domain role');
    if (typeof item.manageRoles !== 'boolean') throw new TypeError('Invalid role management capability');
    return {domainId:text(item.domainId,'Domain ID',80),role,permissions:permissions(item.permissions),manageRoles:item.manageRoles};
  }),members:rows(row.members,'Online members',256).map(entry=>{
    const member=objectValue(entry);
    if (member.memberKey !== null && typeof member.memberKey !== 'string') throw new TypeError('Invalid member key');
    return {userId:text(member.userId,'User ID',80),memberKey:member.memberKey};
  })};
}
/** @param {JsonValue} value @returns {{t:'identityChallenge',roomId:string,creatorKey:string,nonce:string,userId:string}} */
export function parseIdentityChallenge(value) {
  const row=objectValue(value);
  if(row.t !== 'identityChallenge') throw new TypeError('Expected identityChallenge');
  return {t:'identityChallenge',roomId:text(row.roomId,'Room ID',80),creatorKey:text(row.creatorKey,'Creator key',1024),nonce:text(row.nonce,'Identity nonce',256),userId:text(row.userId,'User ID',80)};
}
/** @param {ServerState|null} snapshot @param {string|null} domainId @param {DomainPermission} permission @returns {boolean} */
export function canPerform(snapshot, domainId, permission) { return Boolean(snapshot?.selfKey && snapshot.capabilities.find(item=>item.domainId===domainId)?.permissions.includes(permission)); }
/** @param {ServerState|null} snapshot @param {string|null} domainId @param {string} userId @returns {boolean} */
export function canModerateMember(snapshot,domainId,userId) {
  if(!snapshot?.selfKey || !canPerform(snapshot,domainId,'moderateVoice'))return false;
  const target=snapshot.members.find(member=>member.userId===userId)?.memberKey;
  if(target===snapshot.selfKey)return false;
  const actorRank=roleRank(memberRole(snapshot.policy,snapshot.selfKey,domainId)),targetRank=roleRank(memberRole(snapshot.policy,target ?? null,domainId));
  return actorRank===1 ? targetRank<=1 : actorRank>targetRank;
}
/** @param {ServerState|null} snapshot @param {string|null} domainId @param {string} userId @returns {string} */
export function roleLabel(snapshot, domainId, userId) {
  const key=snapshot?.members.find(member=>member.userId===userId)?.memberKey;
  if (!snapshot || !key) return '普通成员';
  const role=memberRoleLabel(memberRole(snapshot.policy,key,domainId));
  if(role)return role;
  return memberTitles(snapshot.policy,key,domainId).join(' · ') || '普通成员';
}
/** @param {string} tag @param {string} className @param {string} label @returns {HTMLElement} */
function node(tag,className,label) { const result=document.createElement(tag);result.className=className;result.textContent=label;return result; }
/** @param {string} id @param {string} placeholder @returns {HTMLInputElement} */
function input(id,placeholder) {const result=document.createElement('input');result.className='input';result.id=id;result.placeholder=placeholder;return result;}
/** @param {string} id @param {string} label @param {string} className @returns {HTMLButtonElement} */
function button(id,label,className) {const result=document.createElement('button');result.type='button';result.id=id;result.className='btn '+className;result.textContent=label;return result;}

/** @param {PanelOptions} options @returns {void} */
export function openGovernancePanel(options) {
  const {snapshot,domainId}=options;
  const isOwner=Boolean(snapshot.selfKey && snapshot.selfKey===snapshot.policy.ownerKey);
  const isServerAdmin=Boolean(snapshot.selfKey && snapshot.policy.serverAdmins?.includes(snapshot.selfKey));
  const policy=snapshot.policy.domains.find(item=>item.id===domainId);
  const managesRoles=Boolean(snapshot.selfKey && (isOwner || isServerAdmin || snapshot.capabilities.find(item=>item.domainId===domainId)?.manageRoles));
  const body=node('div','governance-panel','');
  body.id='serverGovernancePanel';
  body.append(node('p','governance-kicker','服务器 / 域 / 成员'),node('h3','',snapshot.server.name),node('p','governance-summary',domainId ? '当前域 · '+options.domainName : '此服务器尚未创建域'));
  const error=node('p','governance-error','');error.setAttribute('role','alert');error.hidden=true;body.append(error);
  const close=button('closeGovernanceBtn','关闭','ghost');
  const view=options.modal({title:'服务器与域管理',body,width:620,footer:[close]});
  close.addEventListener('click',()=>view.close());
  /** @param {HTMLButtonElement} control @param {()=>Promise<void>} action @returns {void} */
  function bind(control,action) {
    control.addEventListener('click',async()=>{
      control.disabled=true;error.hidden=true;
      try {await action();view.close();}
      catch(failure) {error.textContent=failure instanceof Error ? failure.message : String(failure);error.hidden=false;control.disabled=false;}
    });
  }
  if (!snapshot.selfKey) body.append(node('p','governance-summary','普通成员模式：请使用桌面客户端验证身份后申请管理权限。'));
  if(snapshot.ownerClaimAvailable && snapshot.selfKey) {
    const token=input('ownerClaimToken','服务器管理令牌');token.type='password';token.autocomplete='off';
    const claim=button('claimOwnerBtn','认领服主','primary');
    body.append(node('p','governance-summary','令牌位于服务器数据目录 owner-claim.txt，与房间访问口令独立。'),token,claim);
    bind(claim,async()=>{if(!token.value.trim())throw new TypeError('请输入服务器管理令牌');await options.claim(token.value.trim());});
  }
  if(isOwner || isServerAdmin) {
    const name=input('governanceServerName','服务器名称');name.value=snapshot.server.name;name.maxLength=80;
    const rename=button('renameConnectionServerBtn','保存服务器名称','primary');body.append(name,rename);
    bind(rename,()=>options.submit({type:'renameServer',name:text(name.value.trim(),'服务器名称',80)}));
  }
  if(!managesRoles) {body.append(node('p','governance-summary','服主任命服务器管理员；服务器管理员管理各域；域主管理本域管理员与权限组。'));return;}
  const selectedDomain=domainId;
  const members=document.createElement('select');members.className='input';members.id='governanceMemberSelect';members.setAttribute('aria-label','选择成员');
  const assignedKeys=[snapshot.policy.ownerKey,...(snapshot.policy.serverAdmins ?? []),policy?.ownerKey,...(policy?.admins ?? []),...(policy?.members.map(member=>member.memberKey) ?? []),...snapshot.members.map(member=>member.memberKey)].filter(key=>typeof key==='string');
  for(const key of new Set(assignedKeys)) {
    if(!key || !canManageMember(snapshot.policy,snapshot.selfKey,key,domainId))continue;
    const online=snapshot.members.find(member=>member.memberKey===key);
    const user=options.users.find(user=>user.id===online?.userId);
    const option=document.createElement('option');option.value=key;option.textContent=user ? user.name : '离线成员 · '+key.slice(-12);members.append(option);
  }
  if(options.selectedMemberKey && [...members.options].some(option=>option.value===options.selectedMemberKey))members.value=options.selectedMemberKey;
  const selected=node('section','governance-section','');selected.append(node('h4','','成员权限'),members);body.append(selected);
  if(!members.options.length){members.hidden=true;selected.append(node('p','governance-summary','当前没有可管理的下级成员。成员上线后可在此分配权限。'));}
  const role=document.createElement('select');role.className='input';role.id='governanceRoleSelect';role.setAttribute('aria-label','成员身份');
  const roleLabel=node('label','governance-summary','成员身份');roleLabel.setAttribute('for',role.id);
  /** @type {[import('../../lib/server-governance.cjs').MemberAccessCommand['role'],string][]} */
  const roles=[['member','普通成员']];
  if(selectedDomain)roles.push(['domain-admin','域管理员']);
  if(selectedDomain && (isOwner || isServerAdmin))roles.push(['domain-owner','域主']);
  if(isOwner)roles.push(['server-admin','服务器管理员']);
  for(const [value,label] of roles){const option=document.createElement('option');option.value=value;option.textContent=label;role.append(option);}
  const scope=node('p','governance-summary','');scope.id='governanceRoleScope';
  selected.append(roleLabel,role,scope);role.disabled=!members.options.length;
  const membership=node('div','governance-group-membership','');
  if(selectedDomain){selected.append(node('h4','','自定义权限组'),membership);if(!policy?.groups.length)membership.append(node('p','governance-summary','暂无权限组，可在下方创建。'));}
  /** @type {{id:string,input:HTMLInputElement}[]} */ const checks=[];
  for(const group of policy?.groups ?? []) {
    const check=document.createElement('input');check.type='checkbox';check.id='member-group-'+group.id;check.disabled=!members.options.length;
    const label=node('label','governance-check','');label.append(check,document.createTextNode(group.title?group.name+' · '+group.title:group.name));membership.append(label);checks.push({id:group.id,input:check});
  }
  const assign=button('saveMemberPermissionsBtn','保存成员权限','primary');selected.append(assign);assign.disabled=!members.options.length;
  bind(assign,()=>options.submit(parseGovernanceCommand({type:'setMemberAccess',domainId:selectedDomain,memberKey:members.value,role:role.value,groupIds:checks.filter(item=>item.input.checked).map(item=>item.id)})));
  /** @returns {void} */ function refreshScope(){
    scope.textContent=role.value==='server-admin'?'管理服务器内的全部域。':role.value==='domain-owner'?'管理当前域，并任命域管理员、设置权限组。':role.value==='domain-admin'?'管理当前域的频道、消息和语音。':'通过自定义权限组获得额外权限。';
    if(policy?.ownerKey===members.value && role.value!=='domain-owner')scope.textContent+=' 此成员不再担任本域域主，本域将由服主管理。';
  }
  /** @returns {void} */ function refreshMember(){
    const current=memberRole(snapshot.policy,members.value,selectedDomain);role.value=current==='special'?'member':current;
    const ids=policy?.members.find(member=>member.memberKey===members.value)?.groupIds ?? [];for(const check of checks)check.input.checked=ids.includes(check.id);
    refreshScope();
  }
  members.addEventListener('change',refreshMember);role.addEventListener('change',refreshScope);refreshMember();
  if(!selectedDomain)return;
  const groups=node('section','governance-section','');groups.append(node('h4','','自定义权限组'));body.append(groups);
  const picker=document.createElement('select');picker.className='input';picker.id='governanceGroupSelect';picker.setAttribute('aria-label','选择权限组');
  const empty=document.createElement('option');empty.value='';empty.textContent='新建权限组';picker.append(empty);
  for(const group of policy?.groups ?? []) {const option=document.createElement('option');option.value=group.id;option.textContent=group.name;picker.append(option);}
  const groupName=input('governanceGroupName','权限组名称');groupName.maxLength=40;
  const groupTitle=input('governanceGroupTitle','展示头衔（可选，最多 24 字）');groupTitle.maxLength=24;groups.append(picker,groupName,groupTitle);
  /** @type {{permission:DomainPermission,input:HTMLInputElement}[]} */ const grants=[];
  /** @type {[DomainPermission,string][]} */ const labels=[['manageChannels','管理频道'],['manageMessages','管理消息'],['moderateVoice','管理语音']];
  for(const [permission,label] of labels) {const check=document.createElement('input');check.type='checkbox';check.id='grant-'+permission;const line=node('label','governance-check','');line.append(check,document.createTextNode(label));groups.append(line);grants.push({permission,input:check});}
  const save=button('saveGovernanceGroupBtn','保存权限组','primary'),remove=button('deleteGovernanceGroupBtn','删除权限组','danger');groups.append(save,remove);
  picker.addEventListener('change',()=>{const group=policy?.groups.find(group=>group.id===picker.value);groupName.value=group?.name ?? '';groupTitle.value=group?.title ?? '';for(const grant of grants)grant.input.checked=group?.permissions.includes(grant.permission) ?? false;remove.disabled=!group;});remove.disabled=true;
  bind(save,()=>options.submit({type:'putGroup',domainId:selectedDomain,groupId:picker.value || crypto.randomUUID(),name:text(groupName.value.trim(),'权限组名称',40),...(groupTitle.value.trim() ? {title:text(groupTitle.value.trim(),'展示头衔',24)} : {}),permissions:grants.filter(item=>item.input.checked).map(item=>item.permission)}));
  bind(remove,()=>options.submit({type:'deleteGroup',domainId:selectedDomain,groupId:text(picker.value,'权限组',80)}));
}
