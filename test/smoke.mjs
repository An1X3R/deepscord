// 后端协议冒烟测试：node test/smoke.mjs
// 依赖 Node >= 22（内置全局 WebSocket）

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const WS_URL = BASE.replace('http', 'ws') + '/ws';

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
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
    ws.addEventListener('error', (e) => reject(new Error('websocket error ' + String(e.message || ''))));
    const api = {
      ws,
      inbox,
      send: (obj) => ws.send(JSON.stringify(obj)),
      opened: new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', rej, { once: true });
      }),
      async wait(type, timeout = 3000, filter = () => true) {
        const existing = inbox.find((m) => m.t === type && filter(m));
        if (existing) return existing;
        return new Promise((res, rej) => {
          const w = {
            pred: (m) => m.t === type && filter(m),
            resolve: res,
          };
          w.timer = setTimeout(() => {
            const idx = waiters.indexOf(w);
            if (idx >= 0) waiters.splice(idx, 1);
            rej(new Error(`等待 ${type} 超时`));
          }, timeout);
          waiters.push(w);
        });
      },
      close: () => ws.close(),
    };
    ws.addEventListener('open', () => resolve(api), { once: true });
  });
}

async function main() {
  console.log('\n=== Deepscord 后端协议测试 ===\n');
  console.log('[1] 静态资源');
  const res = await fetch(BASE + '/');
  const html = await res.text();
  check('GET / 返回 200', res.status === 200);
  check('index.html 内容', /Deepscord/.test(html), `len=${html.length}`);
  const health = await (await fetch(BASE + '/api/health')).json();
  check('健康检查 ok', health.ok === true);

  console.log('\n[2] 握手与用户列表');
  const a = await client('A');
  await a.opened;
  a.send({ t: 'hello', name: '测试甲', color: '#7c6cf5' });
  const wa = await a.wait('welcome');
  check('收到 welcome', !!wa.selfId);
  check('welcome 含频道', Array.isArray(wa.servers) && wa.servers[0].channels.length >= 2);
  check('昵称生效', wa.you.name === '测试甲');

  const b = await client('B');
  await b.opened;
  b.send({ t: 'hello', name: '测试乙' });
  const wb = await b.wait('welcome');
  check('第二个用户收到 welcome', !!wb.selfId);
  check('第二个用户看到 2 人', wb.users.length === 2, `got ${wb.users.length}`);
  const joinNotice = await a.wait('userJoined');
  check('第一个用户收到 userJoined', joinNotice.user.name === '测试乙');

  console.log('\n[3] 文字消息');
  const chat = wa.servers[0].channels.find((c) => c.type === 'text');
  a.send({ t: 'chat', channelId: chat.id, text: '你好，世界 <b>不要被转义</b>' });
  const ma = await a.wait('message', 3000, (m) => m.channelId === chat.id);
  const mb = await b.wait('message', 3000, (m) => m.channelId === chat.id);
  check('发送者收到消息回声', /你好/.test(ma.message.text));
  check('其他客户端收到消息', /你好/.test(mb.message.text));
  check('消息按频道归属', ma.channelId === chat.id);

  console.log('\n[4] 语音状态与信令');
  const voice = wa.servers[0].channels.find((c) => c.type === 'voice');
  a.send({ t: 'joinVoice', channelId: voice.id });
  const peersA = await a.wait('voicePeers');
  check('A 加入语音，无其他成员', Array.isArray(peersA.peers) && peersA.peers.length === 0);

  b.send({ t: 'joinVoice', channelId: voice.id });
  const peersB = await b.wait('voicePeers');
  check('B 加入语音，看到 1 个成员', peersB.peers.length === 1 && peersB.peers[0].name === '测试甲');
  const vsA = await a.wait('voiceState', 3000, (m) => m.userId === wb.selfId);
  check('A 收到 B 的语音状态', vsA.channelId === voice.id);

  b.send({ t: 'signal', to: wa.selfId, data: { type: 'offer', sdp: 'fake-sdp' } });
  const sig = await a.wait('signal', 3000, (m) => m.from === wb.selfId);
  check('信令中继到目标', sig.data.sdp === 'fake-sdp');

  const sysMsg = await a.wait('message', 3000, (m) => m.channelId === voice.id && m.message.system);
  check('语音频道有系统提示', /加入了语音频道/.test(sysMsg.message.text));

  console.log('\n[5] 频道管理（创建 / 人数上限 / 编辑 / 删除）');
  a.send({ t: 'createChannel', serverId: wa.servers[0].id, type: 'voice', name: '测试频道', userLimit: 1 });
  const srvUpdate = await a.wait('servers');
  const created = srvUpdate.servers[0].channels.find((c) => c.name === '测试频道');
  check('创建语音频道成功（含人数上限）', !!created && created.userLimit === 1);

  // 容量限制：A 先进，B 满员被拒
  a.send({ t: 'joinVoice', channelId: created.id });
  const pa = await a.wait('voicePeers', 3000, (m) => m.channelId === created.id);
  check('A 加入受限频道（1/1）', pa.peers.length === 0);
  b.send({ t: 'joinVoice', channelId: created.id });
  const fullErr = await b.wait('error', 3000);
  check('人数已满时拒绝加入', /人数已满/.test(fullErr.message || ''), fullErr.message);

  // 编辑频道：改名 + 提高上限
  a.send({ t: 'updateChannel', channelId: created.id, name: '测试频道-改名', userLimit: 2 });
  const srvUpdate2 = await a.wait(
    'servers',
    3000,
    (m) => m.servers[0].channels.some((c) => c.name === '测试频道-改名')
  );
  const renamed = srvUpdate2.servers[0].channels.find((c) => c.name === '测试频道-改名');
  check('编辑频道名称与人数上限', !!renamed && renamed.userLimit === 2);
  b.send({ t: 'joinVoice', channelId: created.id });
  const pb = await b.wait('voicePeers', 3000, (m) => m.channelId === created.id);
  check('提高上限后 B 可加入', pb.peers.length === 1);

  // 清理
  a.send({ t: 'leaveVoice' });
  b.send({ t: 'leaveVoice' });
  await new Promise((r) => setTimeout(r, 200));
  a.send({ t: 'deleteChannel', channelId: created.id });
  const srvUpdate3 = await a.wait(
    'servers',
    3000,
    (m) => !m.servers[0].channels.some((c) => c.id === created.id)
  );
  check('删除频道成功', !srvUpdate3.servers[0].channels.some((c) => c.id === created.id));

  console.log('\n[6] 断线清理');
  b.close();
  const left = await a.wait('userLeft', 3000);
  check('断线后广播 userLeft', left.id === wb.selfId);
  a.close();

  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  process.exitCode = failed ? 1 : 0;
  // 留一点时间让 WebSocket 关闭帧发完（避免 Windows 上 libuv 退出断言）
  await new Promise((r) => setTimeout(r, 300));
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
