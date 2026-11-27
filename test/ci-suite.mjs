// @ts-check
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
/** @type {string[]} */
const portableTests=[
  'room-store','connection-policy','governance-checkpoint',
  'content-upgrade','chat-reply','chat-unread','static-assets',
  'network-policy','session-identity','network-session',
  'server-governance','server-roles','owner-continuity',
  'workspace-store','room-replica-compat',
  'steam-wire','steam-commands','steam-admission','steam-state','steam-continuity','steam-backend',
  'screen-plan','peer-stats','profile',
  'interaction-scene','interaction-audio-preferences','radio-metadata',
];
// Certificate generation in these suites uses Windows PowerShell.
/** @type {string[]} */
const platformTests=process.platform==='win32' ? ['direct-host','room-client','chat-unread-store'] : [];

/** @param {string[]} argumentsList @returns {void} */
function execute(argumentsList){
  const result=spawnSync(process.execPath,argumentsList,{cwd:root,stdio:'inherit',timeout:600000,windowsHide:true});
  if(result.error)throw result.error;
  if(result.signal)throw new Error('CI process terminated by '+result.signal+': '+JSON.stringify(argumentsList));
  if(result.status===null)throw new Error('CI process completed without an exit status: '+JSON.stringify(argumentsList));
  if(result.status!==0)process.exit(result.status);
}

execute(['tools/sync-appserver.cjs']);
execute(['--test','--test-concurrency=1',...portableTests.concat(platformTests).map(name=>'test/'+name+'.mjs')]);
