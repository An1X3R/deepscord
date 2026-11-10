// 极简 CDP 客户端（零依赖，Node >= 22 内置 WebSocket）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

export async function waitForPort(port, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const info = await fetchJson(`http://127.0.0.1:${port}/json/version`);
      if (info && info.webSocketDebuggerUrl) return info;
    } catch (err) {
      lastErr = err;
    }
    await sleep(200);
  }
  throw new Error(`Chrome 调试端口 ${port} 未就绪: ${lastErr && lastErr.message}`);
}

export async function launchChrome({ port, userDataDir, url, headless = true, windowSize = '1440,900', extraArgs = [] }) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--disable-sync',
    '--disable-features=Translate,OptimizationHints',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    `--window-size=${windowSize}`,
    '--no-sandbox',
    ...extraArgs,
  ];
  if (headless) args.push('--headless=new');
  args.push(url);
  const child = spawn(CHROME, args, { stdio: 'ignore', detached: false });
  child.on('error', (err) => console.error('[chrome] 启动失败', err.message));
  const info = await waitForPort(port);
  return { child, port, info };
}

export async function closeChrome(port) {
  try {
    const info = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    if (info && info.webSocketDebuggerUrl) {
      const ws = new WebSocket(info.webSocketDebuggerUrl);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        ws.addEventListener('open', () => {
          ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
          setTimeout(() => {
            clearTimeout(timer);
            resolve();
          }, 300);
        });
        ws.addEventListener('error', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  } catch (_) {
    /* ignore */
  }
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this._id = 0;
    this._pending = new Map();
    this._listeners = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      if (msg.id && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result || {});
        return;
      }
      if (msg.method) {
        for (const cb of this._listeners.get(msg.method) || []) {
          try {
            cb(msg.params || {});
          } catch (_) {
            /* ignore */
          }
        }
      }
    });
  }

  static async connect(wsUrl, timeout = 10000) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeout);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.addEventListener('error', (err) => {
        clearTimeout(timer);
        reject(new Error('CDP 连接失败: ' + err.message));
      }, { once: true });
    });
    return new CDP(ws);
  }

  on(method, cb) {
    if (!this._listeners.has(method)) this._listeners.set(method, []);
    this._listeners.get(method).push(cb);
    return () => {
      const arr = this._listeners.get(method) || [];
      const idx = arr.indexOf(cb);
      if (idx >= 0) arr.splice(idx, 1);
    };
  }

  send(method, params = {}) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  async eval(expression, { awaitPromise = true, userGesture = true } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture,
    });
    if (res.exceptionDetails) {
      const detail = res.exceptionDetails;
      const msg =
        (detail.exception && (detail.exception.description || detail.exception.value)) ||
        detail.text ||
        'unknown';
      throw new Error('页面脚本异常: ' + String(msg).slice(0, 600));
    }
    return res.result ? res.result.value : undefined;
  }

  async waitFor(expression, { timeout = 10000, interval = 100, label = '' } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try {
        const v = await this.eval(expression);
        if (v) return v;
        last = v;
      } catch (err) {
        last = err.message;
      }
      await sleep(interval);
    }
    throw new Error(`等待条件超时${label ? ' [' + label + ']' : ''}: ${expression} (最后值: ${JSON.stringify(last)})`);
  }

  async screenshot(filePath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(res.data, 'base64'));
    return filePath;
  }

  close() {
    try {
      this.ws.close();
    } catch (_) {
      /* ignore */
    }
  }
}

/** 找到指定端口上匹配 URL 前缀的页面 target，并建立页面级 CDP 连接 */
export async function connectPage(port, urlPrefix) {
  const deadline = Date.now() + 15000;
  let targets = [];
  while (Date.now() < deadline) {
    targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    const page = targets.find((t) => t.type === 'page' && t.url.startsWith(urlPrefix));
    if (page) {
      const cdp = await CDP.connect(page.webSocketDebuggerUrl);
      cdp.target = page;
      return cdp;
    }
    await sleep(200);
  }
  throw new Error(`未找到页面 target: ${urlPrefix} (targets: ${targets.map((t) => t.url).join(', ')})`);
}
