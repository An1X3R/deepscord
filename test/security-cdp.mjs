// @ts-check
/** @typedef {null|boolean|number|string|JsonValue[]|{[key:string]:JsonValue}} JsonValue */
/** @typedef {{[key:string]:JsonValue}} JsonObject */
/** @typedef {{id:string,type:string,url:string,webSocketDebuggerUrl:string}} Target */
/** @param {number} ms @returns {Promise<void>} */
export function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
/** @param {number} port @returns {Promise<Target[]>} */
export async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Debugger target listing failed: ${response.status}`);
  /** @type {Target[]} */ const result = await response.json();
  if (!Array.isArray(result) || result.some(row => typeof row.id !== 'string' || typeof row.url !== 'string' || typeof row.webSocketDebuggerUrl !== 'string')) throw new TypeError('Invalid debugger target response');
  return result;
}
/** @param {string} url */
export async function connectDebugger(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Debugger connection timed out')), 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(undefined); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Debugger connection failed')); }, { once: true });
  });
  let sequence = 0;
  /** @type {Map<number,{resolve:(result:JsonObject)=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}>} */ const pending = new Map();
  socket.addEventListener('message', event => {
    /** @type {{id?:number,result?:JsonObject,error?:{message:string}}} */ const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result || {});
  });
  socket.addEventListener('close', () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Debugger target closed')); } pending.clear(); });
  /** @param {string} method @param {JsonObject} params @returns {Promise<JsonObject>} */
  function send(method, params) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Debugger command timed out: ${method}`)); }, 12000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  /** @param {string} expression @returns {Promise<JsonValue>} */
  async function evaluate(expression) {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(`Page evaluation failed: ${JSON.stringify(response.exceptionDetails)}`);
    const result = response.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('Debugger evaluation result is missing');
    return result.value ?? null;
  }
  /** @param {string} expression @returns {Promise<void>} */
  async function wait(expression) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await pause(50); }
    throw new Error(`Page condition timed out: ${expression}`);
  }
  return { send, evaluate, wait, close: () => socket.close() };
}
/** @param {number} port @param {string} prefix */
export async function page(port, prefix) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const target = (await targets(port)).find(row => row.type === 'page' && row.url.startsWith(prefix));
    if (target) return connectDebugger(target.webSocketDebuggerUrl);
    await pause(80);
  }
  throw new Error(`Missing debugger page: ${prefix}`);
}
