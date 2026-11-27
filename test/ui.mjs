// 界面与交互测试：首次进入欢迎页、设置面板、改名、PTT 按键、频道/服务器增删、HTTPS 连接
// 运行: node test/ui.mjs
import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, closeChrome, connectPage, sleep } from './cdp.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const HTTPS_BASE = process.env.HTTPS_BASE || 'https://localhost:3443';
const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SHOTS = path.join(ROOT, '..', 'docs', 'screenshots');
const TMP = path.join(process.env.TEMP || '/tmp', 'echo-ui-' + Date.now());
// 每次运行使用唯一名称，避免历史数据干扰
const SUFFIX = String(Date.now()).slice(-6);
const CHANNEL_NAME = `测试房间-${SUFFIX}`;
const SERVER_NAME = `测试服务器-${SUFFIX}`;

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

const section = (t) => console.log(`\n[${t}]`);

async function main() {
  console.log('\n=== Deepscord · 界面/交互测试 ===');
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });

  section('首次进入（欢迎页）');
  const dirA = path.join(TMP, 'ui-a');
  await launchChrome({ port: 9421, userDataDir: dirA, url: `${BASE}/` });
  const page = await connectPage(9421, BASE);
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

  await page.waitFor("!!document.querySelector('.modal-backdrop.open')", { timeout: 8000, label: '欢迎弹窗' });
  const welcomeTitle = await page.eval("document.querySelector('.modal-head h2').textContent");
  check('首次进入显示欢迎页', welcomeTitle.includes('欢迎来到 Deepscord'), welcomeTitle);
  check(
    '欢迎页有关闭按钮被隐藏（强制设置昵称）',
    (await page.eval("document.querySelectorAll('.modal-close').length")) === 0
  );
  await page.screenshot(path.join(SHOTS, '04-welcome.png'));
  console.log('  截图: docs/screenshots/04-welcome.png');

  section('进入主界面');
  await page.eval(`(() => {
    const input = document.querySelector('.modal-body .input');
    input.value = '林小满';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.modal-foot .btn.primary').click();
    return true;
  })()`);
  await page.waitFor('!!(window.echo && window.echo.getState().selfId)', { timeout: 12000, label: '进入应用' });
  const st = await page.eval('window.echo.getState()');
  check('昵称写入并连接成功', st.selfName === '林小满' && st.connStatus === 'open', st.selfName + '/' + st.connStatus);
  await page.waitFor("document.querySelectorAll('.modal-backdrop').length === 0", { timeout: 3000, label: '欢迎弹窗关闭' });
  check('欢迎弹窗已关闭', true);
  check(
    '昵称已持久化到 localStorage',
    (await page.eval("JSON.parse(localStorage.getItem('echo.settings')).name")) === '林小满'
  );

  section('设置面板');
  await page.eval('window.echo.actions.openVoiceSettings()');
  await page.waitFor("!!document.querySelector('.modal-backdrop.open')", { timeout: 5000, label: '设置弹窗' });
  check('设置弹窗打开', true);
  const settingTitles = await page.eval(
    "[...document.querySelectorAll('.modal-body .settings-section h3')].map(h => h.textContent)"
  );
  check('设置分组齐全', ['语音设备', '音量', '输入模式'].every((t) => settingTitles.includes(t)), settingTitles.join('/'));
  check('有输入/输出设备下拉', (await page.eval("document.querySelectorAll('.modal-body select').length")) === 2);

  // 测试麦克风（触发权限 + 电平条）
  await page.eval(`(() => {
    const btns = [...document.querySelectorAll('.modal-body .btn')];
    const test = btns.find(b => b.textContent.includes('测试麦克风'));
    test.click();
    return true;
  })()`);
  await page.waitFor('(() => { const v = window.echo.getVoiceStats(); return v && v.micReady; })()', {
    timeout: 12000,
    label: '测试麦克风就绪',
  });
  await sleep(600);
  const level = await page.eval('window.echo.getVoiceStats() && window.echo.getVoiceStats().micReady');
  check('测试麦克风按钮能打开麦克风', level === true);

  // 麦克风监听（自听）
  await page.eval(`(() => {
    const row = [...document.querySelectorAll('.setting-row')].find(r => r.textContent.includes('监听麦克风'));
    const cb = row && row.querySelector('input[type="checkbox"]');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await page.waitFor('window.echo.getVoiceStats().monitor === true', { timeout: 6000, label: '麦克风监听开启' });
  await sleep(900);
  const monitorLevel = await page.eval('window.echo.getVoiceStats().localLevel');
  check('设置里可开启麦克风监听', true);
  check('监听开启后麦克风电平有输入', monitorLevel > 0.0005, 'level=' + monitorLevel);
  await page.screenshot(path.join(SHOTS, '05-settings.png'));
  console.log('  截图: docs/screenshots/05-settings.png');
  await page.eval(`(() => {
    const row = [...document.querySelectorAll('.setting-row')].find(r => r.textContent.includes('监听麦克风'));
    const cb = row && row.querySelector('input[type="checkbox"]');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await page.waitFor('window.echo.getVoiceStats().monitor === false', { timeout: 6000, label: '关闭麦克风监听' });

  section('修改昵称');
  await page.eval(`(() => {
    const input = document.querySelector('.modal-body .input');
    input.value = '小满';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await page.waitFor("window.echo.getState().selfName === '小满'", { timeout: 5000, label: '改名生效' });
  check('设置里改名实时同步', true);

  section('按键说话设置');
  await page.eval(`(() => {
    const seg = [...document.querySelectorAll('.modal-body .seg')].find(b => b.textContent.includes('按键说话'));
    seg.click();
    return true;
  })()`);
  await page.waitFor("window.echo.getState().settings.mode === 'ptt'", { timeout: 3000, label: '切换到 PTT' });
  await page.eval(`(() => {
    document.querySelector('.key-capture').click();
    return true;
  })()`);
  await sleep(200);
  await page.eval(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', key: 'b', bubbles: true, cancelable: true }));
    return true;
  })()`);
  const pttKey = await page.eval("JSON.parse(localStorage.getItem('echo.settings')).pttKey");
  check('按键捕获成功设为 KeyB', pttKey === 'KeyB', pttKey);
  const captureLabel = await page.eval("document.querySelector('.key-capture').textContent.trim()");
  check('按键显示为 B', captureLabel === 'B', captureLabel);
  // 恢复语音感应
  await page.eval(`(() => {
    const seg = [...document.querySelectorAll('.modal-body .seg')].find(b => b.textContent.includes('语音感应'));
    seg.click();
    return true;
  })()`);
  await page.eval(`(() => {
    const done = [...document.querySelectorAll('.modal-foot .btn')].find(b => b.textContent.includes('完成'));
    done.click();
    return true;
  })()`);
  await page.waitFor("document.querySelectorAll('.modal-backdrop').length === 0", { timeout: 3000 });

  section('双击进入语音 / 侧栏成员列表');
  const lobbyId = await page.eval(`(() => {
    const st = window.echo.getState();
    const ch = st.servers.flatMap(s => s.channels).find(c => c.type === 'voice' && c.name === '大厅');
    return ch.id;
  })()`);
  await page.eval(`(() => {
    const row = [...document.querySelectorAll('#channelScroll .channel')].find(c => c.textContent.includes('大厅'));
    row.click();
    return true;
  })()`);
  await sleep(350);
  check('单击语音频道只选中、不加入', (await page.eval('window.echo.getVoiceStats().channelId')) === null);
  // 模拟真实双击：两次单击（sidebar 会在第一次点击后重渲染，用连击计数进入）
  await page.eval(`(() => {
    const row = [...document.querySelectorAll('#channelScroll .channel')].find(c => c.textContent.includes('大厅'));
    row.click();
    return true;
  })()`);
  await sleep(120);
  await page.eval(`(() => {
    const row = [...document.querySelectorAll('#channelScroll .channel')].find(c => c.textContent.includes('大厅'));
    row.click();
    return true;
  })()`);
  await page.waitFor(`window.echo.getVoiceStats().channelId === '${lobbyId}'`, {
    timeout: 15000,
    label: '双击加入语音',
  });
  check('双击语音频道加入语音', true);
  await page.waitFor("document.querySelectorAll('.ch-members .ch-member').length >= 1", {
    timeout: 5000,
    label: '侧栏成员列表',
  });
  check('语音频道下方展开成员列表', true);
  check(
    '频道栏显示人数/上限比例（开黑房 00/8）',
    await page.eval(
      `[...document.querySelectorAll('.ch-count.ratio')].some(el => el.textContent.trim() === '00/8')`
    )
  );
  await page.screenshot(path.join(SHOTS, '13-channel-members.png'));
  console.log('  截图: docs/screenshots/13-channel-members.png');
  await page.eval('window.echo.actions.leaveVoice()');
  await page.waitFor('window.echo.getVoiceStats().channelId === null', { timeout: 5000, label: '离开语音' });

  section('频道管理');
  const beforeChannels = await page.eval("window.echo.getState().servers.flatMap(s => s.channels).length");
  await page.eval(`(() => {
    document.querySelector('.group-add[data-create="voice"]').click();
    return true;
  })()`);
  await page.waitFor("!!document.querySelector('.modal-backdrop.open')", { timeout: 3000, label: '创建频道弹窗' });
  await page.eval(`(() => {
    const input = document.querySelector('.modal-body .input');
    input.value = '${CHANNEL_NAME}';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.modal-foot .btn.primary').click();
    return true;
  })()`);
  await page.waitFor(`window.echo.getState().servers.flatMap(s => s.channels).some(c => c.name === '${CHANNEL_NAME}')`, {
    timeout: 5000,
    label: '频道创建',
  });
  check('通过界面创建语音频道', true);
  check(
    '频道列表渲染新频道',
    await page.eval(`[...document.querySelectorAll('#channelScroll .channel')].some(c => c.textContent.includes('${CHANNEL_NAME}'))`)
  );
  await page.screenshot(path.join(SHOTS, '06-create-channel.png'));

  // 等创建弹窗完全关闭，避免选到旧弹窗
  await page.waitFor("document.querySelectorAll('.modal-backdrop').length === 0", { timeout: 3000, label: '创建弹窗关闭' });

  // 右键编辑频道（名称 + 人数上限）
  await page.eval(`(() => {
    const row = [...document.querySelectorAll('#channelScroll .channel')].find(c => c.textContent.includes('${CHANNEL_NAME}'));
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 30, clientY: rect.top + 12 }));
    return true;
  })()`);
  await page.waitFor("!!document.querySelector('.context-menu')", { timeout: 3000, label: '右键菜单' });
  await page.eval(`(() => {
    const item = [...document.querySelectorAll('.context-menu .menu-item')].find(b => b.textContent.includes('编辑频道'));
    item.click();
    return true;
  })()`);
  await page.waitFor(
    "document.querySelectorAll('.modal-backdrop').length === 1 && document.querySelector('.modal-head h2').textContent.includes('编辑语音频道')",
    { timeout: 3000, label: '编辑频道弹窗' }
  );
  const EDITED_NAME = CHANNEL_NAME + '-改名';
  await page.eval(`(() => {
    const root = document.querySelector('.modal-backdrop:last-child');
    const inputs = [...root.querySelectorAll('.modal-body .input')];
    inputs[0].value = '${EDITED_NAME}';
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    inputs[1].value = '3';
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector('.modal-foot .btn.primary').click();
    return true;
  })()`);
  await page.waitFor(
    `window.echo.getState().servers.flatMap(s => s.channels).some(c => c.name === '${EDITED_NAME}' && c.userLimit === 3)`,
    { timeout: 5000, label: '频道编辑' }
  );
  check('右键编辑频道名称与人数上限', true);
  check(
    '频道栏显示人数/上限（00/3）',
    await page.eval(`(() => {
      const row = [...document.querySelectorAll('#channelScroll .channel')].find(c => c.textContent.includes('${EDITED_NAME}'));
      return !!row && row.textContent.includes('00/3');
    })()`)
  );
  await page.screenshot(path.join(SHOTS, '14-edit-channel.png'));
  console.log('  截图: docs/screenshots/14-edit-channel.png');
  await page.waitFor("document.querySelectorAll('.modal-backdrop').length === 0", { timeout: 3000, label: '编辑弹窗关闭' });

  // 右键删除频道
  await page.eval(`(() => {
    const row = [...document.querySelectorAll('#channelScroll .channel')].find(c => c.textContent.includes('${EDITED_NAME}'));
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 30, clientY: rect.top + 12 }));
    return true;
  })()`);
  await page.waitFor("!!document.querySelector('.context-menu')", { timeout: 3000, label: '右键菜单' });
  await page.eval(`(() => { document.querySelector('.context-menu .menu-item.danger').click(); return true; })()`);
  await page.waitFor("!!document.querySelector('.modal .btn.danger')", { timeout: 3000, label: '删除确认' });
  await page.eval(`(() => { document.querySelector('.modal .btn.danger').click(); return true; })()`);
  await page.waitFor(`!window.echo.getState().servers.flatMap(s => s.channels).some(c => c.name === '${EDITED_NAME}')`, {
    timeout: 5000,
    label: '频道删除',
  });
  const afterChannels = await page.eval("window.echo.getState().servers.flatMap(s => s.channels).length");
  check('右键菜单删除频道', afterChannels === beforeChannels, `${beforeChannels} -> ${afterChannels}`);

  section('服务器管理');
  const beforeServers = await page.eval('window.echo.getState().servers.length');
  await page.eval("document.querySelector('#addServerBtn').click()");
  await page.waitFor("!!document.querySelector('.modal-backdrop.open')", { timeout: 3000, label: '创建服务器弹窗' });
  await page.eval(`(() => {
    const input = document.querySelector('.modal-body .input');
    input.value = '${SERVER_NAME}';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.modal-foot .btn.primary').click();
    return true;
  })()`);
  await page.waitFor(`window.echo.getState().servers.some(s => s.name === '${SERVER_NAME}')`, { timeout: 5000, label: '服务器创建' });
  check('创建服务器成功', (await page.eval('window.echo.getState().servers.length')) === beforeServers + 1);
  check(
    '服务器栏渲染新服务器',
    (await page.eval("document.querySelectorAll('#serverList .rail-item').length")) === beforeServers + 1
  );

  // 切换到新服务器（右键菜单里的“删除服务器”删的是当前服务器）
  await page.eval(`(() => {
    const item = [...document.querySelectorAll('#serverList .rail-item')].find(i => i.title === '${SERVER_NAME}');
    item.click();
    return true;
  })()`);
  await page.waitFor(`window.echo.getState().servers.find(s => s.name === '${SERVER_NAME}').id === window.echo.getState().activeServerId`, {
    timeout: 4000,
    label: '切换到新服务器',
  });
  check('点击服务器栏可切换服务器', true);

  await page.eval("document.querySelector('#serverMenuBtn').click()");
  await page.waitFor("!!document.querySelector('.context-menu')", { timeout: 3000, label: '服务器菜单' });
  await page.eval(`(() => {
    const item = [...document.querySelectorAll('.context-menu .menu-item')].find(b => b.textContent.includes('删除服务器'));
    item.click();
    return true;
  })()`);
  await page.waitFor("!!document.querySelector('.modal .btn.danger')", { timeout: 3000, label: '删除服务器确认' });
  await page.eval("document.querySelector('.modal .btn.danger').click()");
  await page.waitFor(`!window.echo.getState().servers.some(s => s.name === '${SERVER_NAME}')`, {
    timeout: 5000,
    label: '服务器删除',
  });
  check('删除服务器成功', (await page.eval('window.echo.getState().servers.length')) === beforeServers);

  section('HTTPS / wss 连接');
  const voiceChannelId = await page.eval(`(() => {
    const st = window.echo.getState();
    const ch = st.servers.flatMap(s => s.channels).find(c => c.type === 'voice' && c.name === '大厅');
    window.echo.actions.enterChannel(ch.id);
    return ch.id;
  })()`);
  await page.waitFor('(() => { const v = window.echo.getVoiceStats(); return v && v.micReady && v.channelId; })()', {
    timeout: 15000,
    label: 'Alice(HTTP) 加入语音',
  });

  await launchChrome({
    port: 9422,
    userDataDir: path.join(TMP, 'ui-b'),
    url: `${HTTPS_BASE}/?name=安全连接`,
    extraArgs: ['--ignore-certificate-errors'],
  });
  const pageHttps = await connectPage(9422, HTTPS_BASE);
  await pageHttps.send('Runtime.enable');
  await pageHttps.send('Page.enable');
  const httpsErrors = [];
  pageHttps.on('Runtime.exceptionThrown', (p) => {
    httpsErrors.push('异常: ' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  });
  await pageHttps.waitFor('!!(window.echo && window.echo.getState().selfId)', { timeout: 15000, label: 'HTTPS 页面加载' });
  check('HTTPS 页面加载并连接 wss', (await pageHttps.eval('window.echo.getState().connStatus')) === 'open');
  await pageHttps.eval(`(() => {
    const st = window.echo.getState();
    const ch = st.servers.flatMap(s => s.channels).find(c => c.id === '${voiceChannelId}');
    window.echo.actions.enterChannel(ch.id);
    return ch.id;
  })()`);
  await pageHttps.waitFor('(() => { const v = window.echo.getVoiceStats(); return v && v.micReady && v.channelId; })()', {
    timeout: 15000,
    label: 'HTTPS 用户加入语音',
  });
  const crossExpr = `(() => {
    const v = window.echo.getVoiceStats();
    if (!v) return false;
    const peers = Object.values(v.peers);
    return peers.length === 1 && peers.every(p => p.pcState === 'connected');
  })()`;
  await page.waitFor(crossExpr, { timeout: 20000, label: 'HTTPS↔HTTP P2P 连通' });
  await pageHttps.waitFor(crossExpr, { timeout: 20000, label: 'HTTPS 侧 P2P 连通' });
  check('HTTP 页面与 HTTPS 页面可以互通语音', true);
  await pageHttps.screenshot(path.join(SHOTS, '07-https-view.png'));
  console.log('  截图: docs/screenshots/07-https-view.png');

  section('控制台健康检查');
  check('HTTP 页面无脚本错误', errors.length === 0, errors.join(' | ').slice(0, 400));
  check('HTTPS 页面无脚本错误', httpsErrors.length === 0, httpsErrors.join(' | ').slice(0, 400));

  section('清理');
  // 把测试写入的聊天/频道数据恢复干净：此处仅提示，数据在 data/store.json
  await page.eval('window.echo.actions.leaveVoice()');
  await pageHttps.eval('window.echo.actions.leaveVoice()');
  await sleep(400);
  await page.close();
  await pageHttps.close();
  await closeChrome(9421);
  await closeChrome(9422);

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
    await closeChrome(9421);
    await closeChrome(9422);
  } catch (_) {
    /* ignore */
  }
  process.exitCode = 1;
});
