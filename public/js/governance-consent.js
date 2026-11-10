// @ts-check
/** @typedef {{title:string,message:string,details:{label:string,value:string}[],acceptLabel:string}} ConsentDetails */
/** @param {import('../../lib/server-governance.cjs').GovernanceCommand} command @returns {ConsentDetails|null} */
export function governanceConsent(command){
  const names={transferOwner:'转让服务器所有权',setServerAdmin:'修改服务器管理员',setMemberAccess:'修改成员身份与权限组',setDomainOwner:'转让域所有权',setDomainAdmin:'修改域管理员',setMemberGroups:'修改成员权限组',putGroup:'修改权限组',deleteGroup:'删除权限组',deleteDomain:'删除域'};
  if(!(command.type in names))return null;
  const title=names[/** @type {keyof typeof names} */(command.type)];
  /** @type {{label:string,value:string}[]} */const details=[];
  if('domainId' in command)details.push({label:'域 ID',value:String(command.domainId)});
  if('memberKey' in command)details.push({label:'成员身份公钥',value:command.memberKey});
  if('enabled' in command)details.push({label:'管理员身份',value:command.enabled?'授予':'移除'});
  if('role' in command)details.push({label:'新身份',value:command.role});
  if('groupId' in command)details.push({label:'权限组 ID',value:command.groupId});
  if('groupIds' in command)details.push({label:'权限组 ID',value:command.groupIds.join('、') || '无'});
  if('name' in command)details.push({label:'名称',value:command.name});
  if('permissions' in command)details.push({label:'权限',value:command.permissions.join('、') || '无'});
  return{title,message:'此操作将修改服务器权限或删除域。请核对实际操作对象；此确认窗口不受界面主题控制。',details,acceptLabel:'确认'+title};
}
