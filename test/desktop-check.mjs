// Electron 桌面客户端验证（需先以 --remote-debugging-port=9331 启动桌面端）
// 运行: node test/desktop-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { CDP, sleep } from './cdp.mjs';

const PORT = Number(process.env.DESKTOP_CDP_PORT || 9331);
const REMOTE = process.env.DEPLOY_URL;
if (!REMOTE) throw new Error('Set DEPLOY_URL to the explicitly chosen test server before running desktop checks');
const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SHOTS = path.join(ROOT, '..', 'docs', 'screenshots');

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

async function pageTarget() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch (_) {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error('未找到 Electron 页面 target（桌面端是否已启动？）');
}

function readPassword() {
  const candidates = [
    path.join(process.env.TEMP || '/tmp', 'echo-deploy', 'access-password.txt'),
    path.join(ROOT, '..', 'access-password.txt'),
  ];
  for (const p of candidates) {
    try {
      return fs.readFileSync(p, 'utf8').trim();
    } catch (_) {
      /* next */
    }
  }
  return process.env.ECHO_PASSWORD || '';
}

/** 处理首次进入的欢迎页（昵称 + 可选访问口令） */
async function enterApp(page, name, password, { timeout = 20000 } = {}) {
  const expr = `(!!(window.echo && window.echo.getState().selfId)) || !!document.querySelector('.modal-backdrop.open')`;
  await page.waitFor(expr, { timeout, label: '页面就绪' });
  const welcome = await page.eval("!!document.querySelector('.modal-backdrop.open')");
  if (welcome) {
    const inputs = await page.eval(
      "[...document.querySelectorAll('.modal-body .input')].map(i => ({len: i.value.length, type: i.type}))"
    );
    await page.eval(`(() => {
      const inputs = [...document.querySelectorAll('.modal-body .input')];
      inputs[0].value = ${JSON.stringify(name)};
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      if (inputs[1]) {
        inputs[1].value = ${JSON.stringify(password || '')};
        inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.querySelector('.modal-foot .btn.primary').click();
      return true;
    })()`);
    await page.waitFor('!!(window.echo && window.echo.getState().selfId)', { timeout: 15000, label: '登录完成' });
    return { welcome: true, inputs };
  }
  return { welcome: false };
}

async function main() {
  console.log('\n=== Deepscord 桌面客户端验证 ===\n');
  fs.mkdirSync(SHOTS, { recursive: true });

  const target = await pageTarget();
  const page = await CDP.connect(target.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');

  const errors = [];
  page.on('Runtime.exceptionThrown', (p) => {
    errors.push('异常: ' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  });
  page.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') {
      errors.push('console.error: ' + (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
    }
  });

  console.log('[远程服务器模式]');
  const password = readPassword();
  const entered = await enterApp(page, '桌面测试', password);
  check('首次进入显示欢迎页（桌面端独立会话）', entered.welcome === true);
  await page.waitFor('!!(window.echo && window.echo.getState().selfId)', { timeout: 15000, label: '远程页面就绪' });
  const st = await page.eval('window.echo.getState()');
  check('桌面端已加载远程 Deepscord 页面', (await page.eval('document.title')).includes('Deepscord'));
  check('已通过 wss 连接服务器', st.connStatus === 'open', st.connStatus);
  check('preload API 已注入', (await page.eval("typeof window.deepscord === 'object'")) === true);
  const cfg = await page.eval('window.deepscord.getConfig()');
  check('读取到指定服务器配置', typeof cfg.serverUrl === 'string' && new URL(cfg.serverUrl).origin === new URL(REMOTE).origin, cfg.serverUrl);
  const canvas = await page.eval(`(() => {
    const el = document.querySelector('#channelScroll');
    return !!(el && el.querySelectorAll('.channel').length >= 4);
  })()`);
  check('频道列表渲染正常', canvas === true);
  await page.screenshot(path.join(SHOTS, '10-desktop-remote.png'));
  console.log('  截图: docs/screenshots/10-desktop-remote.png');

  console.log('\n[服务器切换页]');
  // back() 会触发页面跳转，等待回包可能永远不返回：点火后忽略结果
  page
    .send('Runtime.evaluate', { expression: 'window.deepscord.back()', userGesture: true })
    .catch(() => {});
  await page.waitFor('location.protocol === "file:"', { timeout: 8000, label: '启动页' });
  const bootTitle = await page.eval('document.querySelector("h1").textContent');
  check('启动页品牌为 Deepscord', bootTitle === 'Deepscord', bootTitle);
  const inputVal = await page.eval('document.getElementById("server").value');
  check('启动页预填上次指定的服务器地址', new URL(inputVal).origin === new URL(REMOTE).origin, inputVal);
  await page.screenshot(path.join(SHOTS, '11-desktop-launcher.png'));
  console.log('  截图: docs/screenshots/11-desktop-launcher.png');

  console.log('\n[内置本机服务器模式]');
  page
    .send('Runtime.evaluate', {
      expression: 'document.getElementById("localBtn").click()',
      userGesture: true,
    })
    .catch(() => {});
  await page.waitFor('location.port === "38480"', { timeout: 25000, label: '本机服务器页面' });
  const localEntered = await enterApp(page, '本机测试', '');
  check('本机模式首次进入欢迎页（独立数据）', localEntered.welcome === true);
  const localState = await page.eval('window.echo.getState()');
  check('本机服务器启动并加载页面', (await page.eval('document.title')).includes('Deepscord'));
  check('本机模式 wss/ws 已连接', localState.connStatus === 'open', localState.connStatus);
  check('本机服务器有默认频道', localState.servers.length >= 1 && localState.servers[0].channels.length >= 4);
  const health = await (await fetch('http://127.0.0.1:38480/api/health')).json();
  check('本机服务器健康检查 OK', health.ok === true);
  await page.screenshot(path.join(SHOTS, '12-desktop-local.png'));
  console.log('  截图: docs/screenshots/12-desktop-local.png');

  check('桌面端无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 400));

  page.close();
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
