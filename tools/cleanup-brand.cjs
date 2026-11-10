/**
 * 收尾清理：把代码/配置里残留的旧命名统一为 Deepscord
 * 用法: node tools/cleanup-brand.cjs
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function edit(rel, pairs) {
  const file = path.join(root, rel);
  let s = fs.readFileSync(file, 'utf8');
  const before = s;
  for (const [a, b] of pairs) s = s.split(a).join(b);
  if (s !== before) {
    fs.writeFileSync(file, s, 'utf8');
    console.log('updated', rel);
  }
}

edit('server.js', [
  ["icon: '回',", "icon: 'D',"],
  ["userId: 'bot-echo',", "userId: 'bot-deepscord',"],
]);

edit('Dockerfile', [['# 回声 Echo — 生产镜像', '# Deepscord — 生产镜像']]);

edit('enable-lan.bat', [['CN=echo-local', 'CN=deepscord-local']]);

edit('docker-compose.yml', [
  ['container_name: echo\n', 'container_name: deepscord\n'],
  ['  echo:\n', '  deepscord:\n'],
  ['container_name: echo-caddy', 'container_name: deepscord-caddy'],
  ['container_name: echo-turn', 'container_name: deepscord-turn'],
  ['--user=echo:change-me', '--user=deepscord:change-me'],
  ['echo-net', 'deepscord-net'],
]);

edit('deploy/Caddyfile', [['# 回声 Echo · Caddy', '# Deepscord · Caddy'], ['reverse_proxy echo:3000', 'reverse_proxy deepscord:3000']]);
edit('deploy/nginx.conf', [['# 回声 Echo · Nginx', '# Deepscord · Nginx'], ['/opt/echovoice', '/opt/deepscord']]);
edit('deploy/coturn.conf', [['# 回声 Echo · TURN', '# Deepscord · TURN'], ['user=echo:change-me', 'user=deepscord:change-me']]);
edit('deploy/windows/update.ps1', [['# 回声 Echo · Windows', '# Deepscord · Windows']]);

// systemd 单元文件改名
const oldUnit = path.join(root, 'deploy', 'echo.service');
const newUnit = path.join(root, 'deploy', 'deepscord.service');
if (fs.existsSync(oldUnit)) {
  let s = fs.readFileSync(oldUnit, 'utf8');
  const pairs = [
    ['# 回声 Echo · systemd 服务', '# Deepscord · systemd 服务'],
    ['sudo cp -r echovoice /opt/echovoice', 'sudo cp -r deepscord /opt/deepscord'],
    ['sudo useradd -r -s /usr/sbin/nologin echo', 'sudo useradd -r -s /usr/sbin/nologin deepscord'],
    ['sudo chown -R echo:echo /opt/echovoice', 'sudo chown -R deepscord:deepscord /opt/deepscord'],
    ['sudo cp /opt/echovoice/deploy/echo.service', 'sudo cp /opt/deepscord/deploy/deepscord.service'],
    ['Description=Echo voice server', 'Description=Deepscord voice server'],
    ['User=echo', 'User=deepscord'],
    ['Group=echo', 'Group=deepscord'],
    ['WorkingDirectory=/opt/echovoice', 'WorkingDirectory=/opt/deepscord'],
    ['ReadWritePaths=/opt/echovoice/data', 'ReadWritePaths=/opt/deepscord/data'],
  ];
  for (const [a, b] of pairs) s = s.split(a).join(b);
  fs.writeFileSync(newUnit, s, 'utf8');
  fs.unlinkSync(oldUnit);
  console.log('renamed deploy/echo.service -> deploy/deepscord.service');
}

// README 中引用 systemd 单元的地方
edit('README.md', [
  [
    '# 参考 deploy/echo.service：单元文件里的服务名 / 用户 / 路径仍是历史命名，',
    '# 参考 deploy/deepscord.service：按需修改用户 / 路径后安装，',
  ],
  ['sudo cp deploy/echo.service /etc/systemd/system/', 'sudo cp deploy/deepscord.service /etc/systemd/system/'],
  [
    'echovoice\ndeploy',
    'deepscord\ndeploy',
  ],
]);

console.log('cleanup done');
