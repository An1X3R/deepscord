// @ts-check
/** @typedef {import('../../lib/server-governance.cjs').GovernanceState} Policy */
/** @typedef {import('../../lib/server-governance.cjs').DomainRole} Role */

/** @param {Policy} policy @param {string|null} key @param {string|null} domainId @returns {Role} */
export function memberRole(policy, key, domainId) {
  if (!key) return 'member';
  if (key === policy.ownerKey) return 'server-owner';
  if (policy.serverAdmins?.includes(key)) return 'server-admin';
  const domain = policy.domains.find(entry => entry.id === domainId);
  if (key === domain?.ownerKey) return 'domain-owner';
  if (domain?.admins.includes(key)) return 'domain-admin';
  return domain?.members.some(member => member.memberKey === key && member.groupIds.length > 0) ? 'special' : 'member';
}

/** @param {Role} role @returns {number} */
export function roleRank(role) {
  return {'server-owner':5,'server-admin':4,'domain-owner':3,'domain-admin':2,special:1,member:1}[role];
}

/** @param {Policy} policy @param {string|null} actor @param {string|null} target @param {string|null} domainId @returns {boolean} */
export function canManageMember(policy, actor, target, domainId) {
  if (!actor || !target || actor === target) return false;
  const rank = roleRank(memberRole(policy, actor, domainId));
  return rank >= 3 && rank > roleRank(memberRole(policy, target, domainId));
}

/** @param {Role} role @returns {string|null} */
export function memberRoleLabel(role) {
  return {'server-owner':'服主','server-admin':'服务器管理员','domain-owner':'域主','domain-admin':'域管理员',special:null,member:null}[role];
}

/** @param {Policy} policy @param {string|null} memberKey @param {string|null} domainId @returns {string[]} */
export function memberTitles(policy, memberKey, domainId) {
  if (!memberKey) return [];
  const role = memberRoleLabel(memberRole(policy,memberKey,domainId));
  const domain = policy.domains.find(entry => entry.id === domainId);
  const groups = domain?.members.find(entry => entry.memberKey === memberKey)?.groupIds;
  const titles = domain?.groups.filter(group => groups?.includes(group.id)).map(group => group.title ?? group.name) ?? [];
  return [...new Set([...(role ? [role] : []),...titles])];
}
