// 端到端测试：启动两个独立 Chrome（假麦克风），加入同一语音频道，验证 WebRTC 连通与聊天
// 运行: node test/e2e.mjs
import fs from 'node:fs';
import path from 'node:path';
import {
  launchChrome,
  closeChrome,
  connectPage,
  waitForPort,
  sleep,
} from './cdp.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SHOTS = path.join(ROOT, '..', 'docs', 'screenshots');
const TMP = path.join(process.env.TEMP || '/tmp', 'echo-e2e-' + Date.now());

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

function logSection(title) {
  console.log(`\n[${title}]`);
}

async function main() {
  console.log('\n=== Deepscord · 端到端测试 ===');
  console.log(`服务地址: ${BASE}`);
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });

  const health = await (await fetch(BASE + '/api/health')).json();
  if (!health.ok) throw new Error('服务器未启动，请先运行 node server.js');
  console.log(`服务在线（当前用户 ${health.users}）`);

  logSection('启动浏览器');
  const aliceDir = path.join(TMP, 'alice');
  const bobDir = path.join(TMP, 'bob');
  const alice = await launchChrome({ port: 9411, userDataDir: aliceDir, url: `${BASE}/?name=Alice` });
  const bob = await launchChrome({ port: 9412, userDataDir: bobDir, url: `${BASE}/?name=Bob` });
  console.log('  Chrome 已启动 (Alice/9411, Bob/9412)');

  const pageA = await connectPage(9411, BASE);
  const pageB = await connectPage(9412, BASE);

  const errorsA = [];
  const errorsB = [];
  const warnings = [];
  for (const [page, list] of [[pageA, errorsA], [pageB, errorsB]]) {
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    page.on('Runtime.exceptionThrown', (p) => {
      list.push('异常: ' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
    });
    page.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (p.type === 'error') list.push('console.error: ' + text);
      else if (p.type === 'warning') warnings.push(text);
    });
  }

  logSection('页面加载与初始渲染');
  await pageA.waitFor('!!(window.echo && window.echo.getState().selfId)', { timeout: 15000, label: 'Alice 身份' });
  await pageB.waitFor('!!(window.echo && window.echo.getState().selfId)', { timeout: 15000, label: 'Bob 身份' });

  const initA = await pageA.eval('window.echo.getState()');
  check('Alice 昵称正确', initA.selfName === 'Alice', initA.selfName);
  check('WebSocket 已连接', initA.connStatus === 'open', initA.connStatus);
  check('默认服务器与频道已加载', initA.servers.length >= 1 && initA.servers[0].channels.length >= 4);
  check(
    '浏览器标题正确',
    (await pageA.eval('document.title')).includes('Deepscord')
  );
  const channelCount = await pageA.eval("document.querySelectorAll('#channelScroll .channel').length");
  check('频道栏渲染出频道', channelCount >= 4, `count=${channelCount}`);
  check(
    '服务器栏渲染出服务器',
    (await pageA.eval("document.querySelectorAll('#serverList .rail-item').length")) >= 2
  );
  const initialShot = await pageA.screenshot(path.join(SHOTS, '01-home.png'));
  console.log('  截图:', initialShot);

  logSection('加入语音频道（WebRTC mesh）');
  const voiceChannelId = await pageA.eval(`(() => {
    const st = window.echo.getState();
    const ch = st.servers.flatMap(s => s.channels).find(c => c.type === 'voice' && c.name === '大厅');
    window.echo.actions.enterChannel(ch.id);
    return ch.id;
  })()`);
  await pageA.waitFor('(() => { const v = window.echo.getVoiceStats(); return v && v.micReady && v.channelId; })()', {
    timeout: 15000,
    label: 'Alice 麦克风就绪',
  });
  check('Alice 成功加入语音频道', true);
  check(
    '服务端记录 Alice 在语音中',
    await pageA.eval(`window.echo.getState().users.find(u => u.name === 'Alice').voiceChannelId === '${voiceChannelId}'`)
  );

  await pageB.eval(`(() => {
    const st = window.echo.getState();
    const ch = st.servers.flatMap(s => s.channels).find(c => c.id === '${voiceChannelId}');
    window.echo.actions.enterChannel(ch.id);
    return ch.id;
  })()`);
  await pageB.waitFor('(() => { const v = window.echo.getVoiceStats(); return v && v.micReady && v.channelId; })()', {
    timeout: 15000,
    label: 'Bob 麦克风就绪',
  });

  const connectedExpr = (side) => `(() => {
    const v = window.echo.getVoiceStats();
    if (!v) return false;
    const peers = Object.values(v.peers);
    return peers.length === 1 && peers.every(p => p.pcState === 'connected' && p.hasAudio);
  })()`;

  await pageA.waitFor(connectedExpr(), { timeout: 20000, label: 'Alice 侧 P2P 连通' });
  await pageB.waitFor(connectedExpr(), { timeout: 20000, label: 'Bob 侧 P2P 连通' });
  check('Alice ↔ Bob WebRTC 连接建立', true);

  const statsA = await pageA.eval('window.echo.getVoiceStats()');
  const statsB = await pageB.eval('window.echo.getVoiceStats()');
  check('Alice 侧 1 个对端且 audio 已挂载', Object.keys(statsA.peers).length === 1 && Object.values(statsA.peers)[0].hasAudio);
  check('Bob 侧 1 个对端且 audio 已挂载', Object.keys(statsB.peers).length === 1);

  await pageA.waitFor("document.querySelectorAll('#stageGrid .tile').length === 2", { timeout: 5000 });
  await pageB.waitFor("document.querySelectorAll('#stageGrid .tile').length === 2", { timeout: 5000 });
  check('两人都渲染出两个语音成员卡片', true);

  const inVoice = await pageA.eval(`window.echo.getState().users.filter(u => u.voiceChannelId === '${voiceChannelId}').length`);
  check('语音频道成员数 = 2', inVoice === 2, `got ${inVoice}`);

  const sideMembers = await pageA.eval("document.querySelectorAll('#channelScroll .ch-members .ch-member').length");
  check('频道栏语音频道下方展开 2 名成员', sideMembers === 2, `got ${sideMembers}`);

  logSection('文字聊天');
  const msg = '端到端测试：大家好，我是 Alice ' + Date.now();
  await pageA.eval(`window.echo.actions.sendMessage(${JSON.stringify(msg)})`);
  await pageB.waitFor(
    `document.querySelector('#messages').textContent.includes(${JSON.stringify(msg)})`,
    { timeout: 8000, label: 'Bob 收到 Alice 消息' }
  );
  check('Bob 实时收到 Alice 的消息', true);
  const msgB = 'Bob 收到！这条是回复。';
  await pageB.eval(`window.echo.actions.sendMessage(${JSON.stringify(msgB)})`);
  await pageA.waitFor(
    `document.querySelector('#messages').textContent.includes(${JSON.stringify(msgB)})`,
    { timeout: 8000, label: 'Alice 收到 Bob 消息' }
  );
  check('Alice 实时收到 Bob 的回复', true);

  logSection('静音状态同步');
  await pageA.eval('window.echo.actions.toggleMute()');
  await pageB.waitFor(
    `window.echo.getState().users.find(u => u.name === 'Alice').muted === true`,
    { timeout: 6000, label: 'Bob 看到 Alice 静音' }
  );
  check('静音状态同步到其他成员', true);
  check(
    'Bob 端 Alice 卡片显示已静音',
    await pageB.eval(`(() => {
      const el = document.querySelector('[data-status-for]');
      const tiles = [...document.querySelectorAll('#stageGrid .tile')];
      const aliceTile = tiles.find(t => t.textContent.includes('Alice'));
      return !!aliceTile && aliceTile.textContent.includes('已静音');
    })()`)
  );
  await pageA.eval('window.echo.actions.toggleMute()');
  await pageB.waitFor(
    `window.echo.getState().users.find(u => u.name === 'Alice').muted === false`,
    { timeout: 6000, label: 'Alice 取消静音' }
  );
  check('取消静音同步', true);

  logSection('界面截图');
  await sleep(1500);
  const shotVoice = await pageB.screenshot(path.join(SHOTS, '02-voice-channel.png'));
  console.log('  截图:', shotVoice);
  const shotA = await pageA.screenshot(path.join(SHOTS, '03-alice-view.png'));
  console.log('  截图:', shotA);

  const speaking = await pageB.eval("document.querySelectorAll('#stageGrid .tile.speaking').length");
  console.log(`  （信息）说话高亮卡片数: ${speaking}`);

  logSection('控制台健康检查');
  check('Alice 页面无脚本错误', errorsA.length === 0, errorsA.join(' | ').slice(0, 400));
  check('Bob 页面无脚本错误', errorsB.length === 0, errorsB.join(' | ').slice(0, 400));
  if (warnings.length) {
    console.log('  （信息）控制台警告 ' + warnings.length + ' 条: ' + warnings.slice(0, 3).join(' | ').slice(0, 300));
  }

  logSection('离开语音频道');
  await pageA.eval('window.echo.actions.leaveVoice()');
  await pageB.waitFor(
    `window.echo.getState().users.find(u => u.name === 'Alice').voiceChannelId === null`,
    { timeout: 6000, label: 'Bob 看到 Alice 离开' }
  );
  check('离开语音频道状态同步', true);
  await pageB.waitFor(
    "document.querySelectorAll('#stageGrid .tile').length === 1",
    { timeout: 5000, label: 'Bob 侧卡片减少为 1' }
  );
  check('离开后对端卡片移除', true);

  logSection('清理');
  await pageA.close();
  await pageB.close();
  await closeChrome(9411);
  await closeChrome(9412);
  await sleep(600);

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
    await closeChrome(9411);
    await closeChrome(9412);
  } catch (_) {
    /* ignore */
  }
  process.exitCode = 1;
});
