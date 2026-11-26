'use strict';
// 离线库 → 手动接上 NAS 的端到端演练：
//   真实 server.py + 真实浏览器（壳环境 __NN_SHELL__，默认手动同步）
//   1) 完全离线用「仅在本机使用」建库并写便签
//   2) 点状态胶囊 → 输入 NAS 账户 → 手动同步
//   3) 服务端出现 vault 包裹层与 1 条密文便签，本机 outbox 清空
// 零第三方依赖。运行：node tools/test_offline_sync.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const staticDir = path.join(ROOT, 'static');
const PORT = Number(process.env.NN_OFFSYNC_PORT || '18797');
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-offsync-'));

let pass = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  PASS ' + name); }
  else { console.error('  FAIL ' + name + (extra ? '（' + extra + '）' : '')); process.exitCode = 1; }
}

function findBrowser() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  for (const file of candidates) if (fs.existsSync(file)) return file;
  return null;
}

const FLOW = String.raw`(async () => {
  const info = { steps: [] };
  const step = (name, good, extra) => info.steps.push({ name, ok: !!good, extra: extra === undefined ? '' : String(extra) });
  const waitFor = async (fn, timeout) => {
    const start = Date.now();
    while (Date.now() - start < (timeout || 15000)) {
      let value = false;
      try { value = fn(); } catch (error) { value = false; }
      if (value) return true;
      await new Promise((r) => setTimeout(r, 80));
    }
    return false;
  };
  const countOutbox = () => new Promise((resolve) => {
    const req = indexedDB.open('nas-notes-enc');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('outbox', 'readonly').objectStore('outbox').getAll();
      tx.onsuccess = () => resolve(tx.result.length);
      tx.onerror = () => resolve(-1);
    };
    req.onerror = () => resolve(-1);
  });
  const vaultRow = () => new Promise((resolve) => {
    const req = indexedDB.open('nas-notes-enc');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('meta', 'readonly').objectStore('meta').get('vault');
      tx.onsuccess = () => {
        try { resolve(JSON.parse((tx.result || {}).value || '{}')); } catch (error) { resolve({}); }
      };
      tx.onerror = () => resolve({});
    };
    req.onerror = () => resolve({});
  });

  try {
    const localBtn = document.getElementById('lockLocalBtn');
    await waitFor(() => localBtn && !localBtn.hidden, 8000);
    document.getElementById('passphraseInput').value = 'offline-first-2026';
    localBtn.click();
    step('离线建库成功', await waitFor(() => document.getElementById('lockScreen').hidden === true, 25000),
      document.getElementById('lockError').textContent.trim());

    // 写两条便签，模拟攒下来的离线数据
    for (const name of ['离线第一条', '离线第二条']) {
      document.getElementById('newBtn').click();
      await waitFor(() => document.getElementById('deleteBtn').hidden === false, 5000);
      const input = document.getElementById('titleInput');
      input.value = name;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 700));
    }
    await new Promise((r) => setTimeout(r, 600));
    info.pendingBefore = await countOutbox();
    info.vaultBefore = (await vaultRow()).local_only === true;
    step('离线阶段两条都在待同步队列', info.pendingBefore >= 2, 'outbox=' + info.pendingBefore);
    step('本机库标记为「仅本机」', info.vaultBefore);

    // 手动同步：点状态胶囊 → 登录框
    document.getElementById('syncBadge').click();
    const dlg = document.getElementById('syncLoginDialog');
    step('点状态胶囊弹出连接 NAS 对话框', await waitFor(() => dlg.open || dlg.hasAttribute('open'), 5000));
    document.getElementById('syncUser').value = 'admin';
    document.getElementById('syncPass').value = 'admin';
    document.getElementById('syncLoginOk').click();
    const synced = await waitFor(() => /已同步|已连接/.test(document.getElementById('syncBadge').textContent), 30000);
    info.badge = document.getElementById('syncBadge').textContent.trim();
    info.syncLoginError = document.getElementById('syncLoginError').textContent.trim();
    step('手动同步成功', synced, info.badge + ' ' + info.syncLoginError);

    info.pendingAfter = await countOutbox();
    step('同步后待同步队列清空', info.pendingAfter === 0, 'outbox=' + info.pendingAfter);
    const after = await vaultRow();
    step('本机库不再标记「仅本机」', after.local_only !== true, JSON.stringify(after.local_only));
  } catch (error) {
    info.error = String((error && error.message) || error);
  }
  info.ok = info.steps.length > 0 && info.steps.every((s) => s.ok);
  return JSON.stringify(info);
})()`;

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    }).on('error', reject);
  });
}

async function api(method, urlPath, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Token'] = token;
  const res = await fetch(BASE + urlPath, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = {};
  try { json = await res.json(); } catch (error) { /* empty */ }
  return { status: res.status, body: json };
}

(async () => {
  const browser = findBrowser();
  if (!browser) {
    console.log('  SKIP 离线同步演练（未找到 Edge/Chrome）');
    console.log('\nOffline sync tests: 0 pass');
    return;
  }

  const PY = process.env.NN_PYTHON || 'python';
  const server = spawn(PY, [path.join(ROOT, 'server.py')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: DATA, STATIC_DIR: staticDir }),
    stdio: 'ignore'
  });

  let child = null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-offsync-prof-'));
  const debugPort = PORT + 100;

  const cleanup = () => {
    try { if (child) child.kill(); } catch (error) { /* ignore */ }
    try { server.kill(); } catch (error) { /* ignore */ }
    setTimeout(() => {
      for (const dir of [profile, DATA]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) { /* ignore */ }
      }
    }, 400);
  };

  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) {
      try {
        const res = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(800) });
        up = res.ok;
      } catch (error) { await new Promise((r) => setTimeout(r, 250)); }
    }
    if (!up) throw new Error('server.py 没有启动（检查 python 是否在 PATH）');

    child = spawn(browser, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking',
      '--remote-debugging-port=' + debugPort,
      '--user-data-dir=' + profile,
      BASE + '/'
    ], { stdio: 'ignore' });

    let target = null;
    for (let i = 0; i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      try {
        const list = await getJson('http://127.0.0.1:' + debugPort + '/json/list');
        const pages = (list || []).filter((item) => item.type === 'page' && item.webSocketDebuggerUrl);
        target = pages.find((item) => String(item.url || '').indexOf(BASE) === 0) || null;
        if (target) break;
      } catch (error) { /* 还没起来 */ }
    }
    if (!target) throw new Error('无法连接浏览器调试端口');

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error('CDP 连接失败'));
    });

    let seq = 0;
    const pending = new Map();
    socket.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (error) { return; }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    const send = (method, params) => new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });

    // 让页面以「安卓壳」身份启动：默认手动同步、跳过 Service Worker。
    // 页面本身由真实 server.py 提供，所以 /api 直接走同源网络（等价壳里的原生桥）。
    await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__NN_SHELL__ = true;'
    });
    await send('Page.reload');

    let stable = 0;
    for (let i = 0; i < 150; i += 1) {
      const state = await send('Runtime.evaluate', {
        expression: 'document.readyState + "|" + (window.__NN_SHELL__ === true)',
        returnByValue: true
      });
      const value = state.result && state.result.result && state.result.result.value;
      stable = value === 'complete|true' ? stable + 1 : 0;
      if (stable >= 2) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    let reply = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      reply = await send('Runtime.evaluate', { expression: FLOW, awaitPromise: true, returnByValue: true });
      const err = reply && reply.error && reply.error.message;
      if (!err || !/context was destroyed/i.test(err)) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (reply && reply.error) throw new Error('CDP 调用失败：' + reply.error.message);
    const raw = reply && reply.result && reply.result.result && reply.result.result.value;
    if (!raw) throw new Error('页面没有返回结果：' + JSON.stringify(reply).slice(0, 400));

    const info = JSON.parse(raw);
    (info.steps || []).forEach((item) => ok(item.name, item.ok, item.extra));
    if (info.error) ok('离线同步流程未中断', false, info.error);

    // ---------- 服务端侧的独立核验 ----------
    const login = await api('POST', '/api/login', { username: 'admin', password: 'admin' });
    const token = login.body.token || '';
    const meta = (await api('GET', '/api/meta', undefined, token)).body;
    ok('服务器已接管本机加密库（vault 已上传）', meta.initialized === true && Boolean(meta.wrapped));
    const notes = (await api('GET', '/api/notes', undefined, token)).body.notes || [];
    const live = notes.filter((note) => !note.deleted);
    ok('服务器收到 2 条便签密文', live.length === 2, 'notes=' + live.length);
    ok('服务端只存密文（无明文标题）', live.every((note) => note.payload && JSON.stringify(note).indexOf('离线第') < 0));

    socket.close();
  } finally {
    cleanup();
  }
  console.log('\nOffline sync tests: ' + pass + ' pass');
})().catch((error) => {
  console.error('  FAIL 离线同步演练：' + (error && error.message ? error.message : error));
  process.exitCode = 1;
  console.log('\nOffline sync tests: ' + pass + ' pass');
});
