/**
 * 把网页端（server.js / lib / public）同步到 desktop/app-server，
 * 供 Electron 内置本机服务器使用，也作为打包输入。
 */
const fs = require('node:fs');
const path = require('node:path');
require('./vendor-radio.cjs');

const root = path.resolve(__dirname, '..');
const dest = path.join(root, 'desktop', 'app-server');

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

fs.copyFileSync(path.join(root, 'server.js'), path.join(dest, 'server.js'));
for (const dir of ['lib', 'public']) {
  fs.cpSync(path.join(root, dir), path.join(dest, dir), { recursive: true });
}
fs.writeFileSync(
  path.join(dest, 'package.json'),
  JSON.stringify({ name: 'deepscord-server', private: true, main: 'server.js' }, null, 2) + '\n',
  'utf8'
);

// 简单统计，便于确认同步结果
function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else n += 1;
  }
  return n;
}
console.log('[app-server] synced ->', dest, '(' + countFiles(dest) + ' files)');
