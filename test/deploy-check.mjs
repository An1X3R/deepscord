// 公网部署验证：访问 https://<服务器IP>/，点击继续自签证书，输入访问口令，验证 wss + 麦克风
// 运行: node test/deploy-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, closeChrome, connectPage, sleep } from './cdp.mjs';

const BASE = process.env.DEPLOY_URL;
if (!BASE) throw new Error('Set DEPLOY_URL to the explicitly chosen test server before running deployment checks');
const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SHOTS = path.join(ROOT, '..', 'docs', 'screenshots');
const TMP = path.join(process.env.TEMP || '/tmp', 'echo-deploy-check-' + Date.now());

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

async function main() {
  const password = readPassword();
  console.log(`\n=== Deepscord · 公网部署验证 ===\n目标: ${BASE}\n口令: ${password ? '(已读取)' : '(缺失)'}\n`);
  if (!password) throw new Error('未找到访问口令，可设置 ECHO_PASSWORD 环境变量');
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });

  await launchChrome({
    port: 9441,
    userDataDir: path.join(TMP, 'deploy'),
    url: BASE,
    extraArgs: ['--ignore-certificate-errors'],
  });
  const page = await connectPage(9441, BASE.replace(/\/$/, ''));
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  const errors = [];
  page.on('Runtime.exceptionThrown', (p) => {
    errors.push('异常: ' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  });
  page.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') {
      errors.push('console.error: ' + (p.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });

  await page.waitFor('!!document.querySelector(".modal-backdrop.open")', { timeout: 15000, label: '欢迎弹窗' });
  check('公网页面成功加载', true);
  check('页面标题正确', (await page.eval('document.title')).includes('Deepscord'));
  const cfg = await page.eval('fetch("/api/config").then(r => r.json())');
  check('服务端要求访问口令', cfg.requirePassword === true);
  check('下发了 STUN 配置', Array.isArray(cfg.iceServers) && cfg.iceServers.length >= 1, JSON.stringify(cfg.iceServers));
  await page.screenshot(path.join(SHOTS, '08-deployed-welcome.png'));
  console.log('  截图: docs/screenshots/08-deployed-welcome.png');

  const fillWelcome = async (name, pwd) => {
    await page.eval(`(() => {
      const inputs = [...document.querySelectorAll('.modal-body .input')];
      const name = inputs[0];
      name.value = ${JSON.stringify(name)};
      name.dispatchEvent(new Event('input', { bubbles: true }));
      if (inputs[1]) {
        inputs[1].value = ${JSON.stringify(pwd)};
        inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.querySelector('.modal-foot .btn.primary').click();
      return true;
    })()`);
  };

  console.log('\n[访问口令]');
  await fillWelcome('远程测试', 'wrong-password');
  await page.waitFor('!!document.querySelector(".welcome-error")', { timeout: 8000, label: '错误提示' });
  const errText = await page.eval('document.querySelector(".welcome-error").textContent');
  check('错误口令被拒绝并提示', /口令/.test(errText), errText);
  check(
    '错误口令不会进入应用',
    (await page.eval('window.echo ? window.echo.getState().selfId : null')) === null
  );

  await page.waitFor('!!document.querySelector(".modal-body .input")', { timeout: 5000 });
  await fillWelcome('远程测试', password);
  await page.waitFor('!!(window.echo && window.echo.getState().selfId)', { timeout: 15000, label: '进入应用' });
  const st = await page.eval('window.echo.getState()');
  check('正确口令进入成功', st.connStatus === 'open' && st.selfName === '远程测试', `${st.connStatus}/${st.selfName}`);
  check('wss 连接正常', (await page.eval('window.echo.getState().latency !== null')) === true);

  console.log('\n[聊天]');
  await page.waitFor("window.echo.getState().servers.length > 0", { timeout: 8000 });
  const textCh = await page.eval(`(() => {
    const st = window.echo.getState();
    const ch = st.servers.flatMap(s => s.channels).find(c => c.type === 'text');
    window.echo.actions.selectChannel(ch.id);
    return ch.name;
  })()`);
  const msg = '公网部署验证消息 ' + Date.now();
  await page.eval(`window.echo.actions.sendMessage(${JSON.stringify(msg)})`);
  await page.waitFor(`document.querySelector("#messages").textContent.includes(${JSON.stringify(msg)})`, {
    timeout: 8000,
    label: '消息回显',
  });
  check(`文字频道「${textCh}」消息收发正常`, true);

  console.log('\n[语音]');
  const voiceId = await page.eval(`(() => {
    const st = window.echo.getState();
    const ch = st.servers.flatMap(s => s.channels).find(c => c.type === 'voice');
    window.echo.actions.enterChannel(ch.id);
    return ch.id;
  })()`);
  await page.waitFor('(() => { const v = window.echo.getVoiceStats(); return v && v.micReady && v.channelId; })()', {
    timeout: 20000,
    label: '麦克风就绪',
  });
  check('自签 HTTPS 下麦克风可用', true);
  check('成功加入语音频道', (await page.eval('window.echo.getVoiceStats().channelId')) === voiceId);
  await page.eval(`window.echo.actions.sendMessage('大家好，这是部署在服务器上的 Deepscord 👋')`);
  await sleep(3800); // 等待错误口令的 Toast 消失，截图更干净
  await page.screenshot(path.join(SHOTS, '09-deployed-voice.png'));
  console.log('  截图: docs/screenshots/09-deployed-voice.png');

  check('页面无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 400));

  await page.eval('window.echo.actions.leaveVoice()');
  await sleep(300);
  await page.close();
  await closeChrome(9441);

  console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===\n`);
  if (failed) {
    console.log('失败项:');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  }
}

main().catch(async (err) => {
  console.error('\n测试异常:', err);
  try {
    await closeChrome(9441);
  } catch (_) {
    /* ignore */
  }
  process.exitCode = 1;
});
