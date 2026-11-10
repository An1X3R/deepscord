// 访问口令与限流测试：自己拉起一个带口令的服务实例
// 运行: node test/auth.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 3311;
const Password = 'test-pass-123';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(os.tmpdir(), 'echo-auth-' + Date.now());
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.error(`  ✗ ${name} ${extra}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) return;
    } catch (_) {
      /* retry */
    }
    await sleep(150);
  }
  throw new Error('测试服务启动超时');
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
    const inbox = [];
    const waiters = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      inbox.push(msg);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i].pred(msg)) {
          const w = waiters.splice(i, 1)[0];
          clearTimeout(w.timer);
          w.resolve(msg);
        }
      }
    });
    ws.addEventListener('open', () => {
      resolve({
        ws,
        send: (obj) => ws.send(JSON.stringify(obj)),
        clear: () => {
          inbox.length = 0;
        },
        async wait(type, timeout = 3000, filter = () => true) {
          const existing = inbox.find((m) => m.t === type && filter(m));
          if (existing) return existing;
          return new Promise((res, rej) => {
            const w = { pred: (m) => m.t === type && filter(m), resolve: res };
            w.timer = setTimeout(() => {
              const idx = waiters.indexOf(w);
              if (idx >= 0) waiters.splice(idx, 1);
              rej(new Error(`等待 ${type} 超时`));
            }, timeout);
            waiters.push(w);
          });
        },
        close: () => ws.close(),
      });
    }, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

async function main() {
  console.log('\n=== Deepscord · 访问口令测试 ===\n');
  const child = spawn(process.execPath, [path.join(ROOT, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HTTPS_PORT: '0',
      ECHO_PASSWORD: Password,
      ECHO_DATA_DIR: DATA_DIR,
    },
    stdio: 'ignore',
  });

  try {
    await waitHealth();
    console.log('[1] 配置接口');
    const cfg = await (await fetch(BASE + '/api/config')).json();
    check('requirePassword = true', cfg.requirePassword === true);
    check('未登录不返回 ICE 凭据', !Object.hasOwn(cfg, 'iceServers'));

    console.log('\n[2] 无口令 / 错口令');
    const c1 = await connect();
    c1.send({ t: 'hello', name: '无口令' });
    const fail1 = await c1.wait('authFailed');
    check('无口令被拒绝', /口令/.test(fail1.message), fail1.message);
    check(
      '被拒绝后不会收到 welcome',
      !(await c1.wait('welcome', 500).then(() => true).catch(() => false))
    );

    c1.send({ t: 'hello', name: '错口令', password: 'wrong-pass' });
    const fail2 = await c1.wait('authFailed');
    check('错口令被拒绝', /口令/.test(fail2.message));

    console.log('\n[3] 正确口令');
    c1.send({ t: 'hello', name: '正确口令', password: Password });
    const welcome = await c1.wait('welcome', 4000);
    check('正确口令进入成功', !!welcome.selfId);
    check('welcome 携带 requirePassword', welcome.config.requirePassword === true);
    check('登录后获取 ICE 配置', Array.isArray(welcome.config.iceServers));
    check('拿到频道数据', Array.isArray(welcome.servers) && welcome.servers.length > 0);
    const chatCh = welcome.servers[0].channels.find((c) => c.type === 'text');
    c1.send({ t: 'chat', channelId: chatCh.id, text: '口令测试消息' });
    const msg = await c1.wait('message', 3000, (m) => m.channelId === chatCh.id);
    check('通过口令后可以正常聊天', /口令测试消息/.test(msg.message.text));
    c1.close();

    console.log('\n[4] 暴力尝试限流');
    const c2 = await connect();
    let blocked = false;
    for (let i = 1; i <= 6; i += 1) {
      c2.clear();
      c2.send({ t: 'hello', name: '爆破' + i, password: 'bad' + i });
      try {
        const res = await c2.wait('authFailed', 2000);
        if (/尝试次数|一分钟/.test(res.message)) blocked = true;
      } catch (_) {
        /* 服务端可能直接关闭连接 */
      }
      await sleep(60);
    }
    check('连续失败后触发限流', blocked);
    c2.close();
  } finally {
    child.kill();
    await sleep(300);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===\n`);
  if (failed) {
    console.log('失败项:');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exitCode = 1;
});
