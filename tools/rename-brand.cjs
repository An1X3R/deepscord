// 一次性品牌重命名脚本：回声 Echo / 回声镇 → Deepscord
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const skip = new Set(['node_modules', '.git', 'data', 'certs', 'dist', 'docs']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!skip.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (/\.(js|mjs|html|css|json|md|bat|ps1|yml|conf|txt)$/.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const reps = [
  ['回声 Echo', 'Deepscord'],
  ['回声镇', 'Deepscord'],
  ['回声助手', 'Deepscord 助手'],
  ['回声服务端', 'Deepscord 服务端'],
  ['部署在服务器上的回声', '部署在服务器上的 Deepscord'],
  ['欢迎来到回声', '欢迎来到 Deepscord'],
  ["includes('回声')", "includes('Deepscord')"],
  ['/回声|Echo/', '/Deepscord/'],
  ['C:\\echovoice', 'C:\\Deepscord'],
  ['/opt/echovoice', '/opt/deepscord'],
  ['├─ echovoice/', '├─ deepscord/'],
  ['echovoice-server.zip', 'Deepscord-server.zip'],
  ['"name": "echovoice"', '"name": "deepscord"'],
  ['回声 Echo · 局域网语音频道', 'Deepscord · 语音频道'],
  ['局域网语音频道', '语音频道'],
  ['echo.service', 'deepscord.service'],
  ['EchoVoice', 'Deepscord'],
  ['run-echo.bat', 'run-deepscord.bat'],
  ['EchoTLS', 'DeepscordTLS'],
];

const changed = [];
for (const f of walk(root)) {
  let s = fs.readFileSync(f, 'utf8');
  const orig = s;
  for (const [a, b] of reps) s = s.split(a).join(b);
  if (s !== orig) {
    fs.writeFileSync(f, s, 'utf8');
    changed.push(path.relative(root, f));
  }
}
console.log('changed files:');
changed.forEach((f) => console.log('  ' + f));
