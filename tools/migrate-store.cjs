/**
 * 数据迁移：把已有 data/store.json 里的旧品牌改为 Deepscord
 * 用法: node tools/migrate-store.cjs <store.json 路径> [--clean-tests]
 */
const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2];
const cleanTests = process.argv.includes('--clean-tests');
if (!file) {
  console.error('用法: node tools/migrate-store.cjs <store.json> [--clean-tests]');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.log('[migrate] 数据文件不存在，跳过:', file);
  process.exit(0);
}

const store = JSON.parse(fs.readFileSync(file, 'utf8'));
let renamedServers = 0;
let renamedMessages = 0;
let removed = 0;

function fixText(text) {
  if (typeof text !== 'string') return text;
  return text
    .split('回声助手').join('Deepscord 助手')
    .split('回声镇').join('Deepscord')
    .split('回声 Echo').join('Deepscord');
}

for (const srv of store.servers || []) {
  if (srv.name === '回声镇' || srv.name === '回声 Echo') {
    srv.name = 'Deepscord';
    srv.icon = 'D';
    renamedServers += 1;
  }
  for (const ch of srv.channels || []) ch.name = fixText(ch.name);
}

for (const channelId of Object.keys(store.messages || {})) {
  const list = store.messages[channelId];
  if (!Array.isArray(list)) continue;
  const kept = [];
  for (const msg of list) {
    const before = JSON.stringify([msg.name, msg.text]);
    msg.name = fixText(msg.name);
    msg.text = fixText(msg.text);
    if (JSON.stringify([msg.name, msg.text]) !== before) renamedMessages += 1;
    if (cleanTests) {
      const isTestText =
        /公网部署验证消息|部署在服务器上的 Deepscord|端到端测试|你好，世界 <b>/.test(msg.text || '') ||
        /远程测试|桌面测试|本机测试/.test(msg.text || '') ||
        /远程测试|桌面测试|本机测试/.test(msg.name || '');
      if (isTestText) {
        removed += 1;
        continue;
      }
    }
    kept.push(msg);
  }
  store.messages[channelId] = kept;
}

fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8');
console.log(
  `[migrate] 服务器改名 ${renamedServers} 个，消息改名 ${renamedMessages} 条` +
    (cleanTests ? `，清理测试消息 ${removed} 条` : '')
);
