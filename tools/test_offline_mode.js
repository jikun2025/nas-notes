'use strict';
// 离线优先回归：安卓端必须是「独立的本机便签 App」，同步只能手动触发。
// 静态断言 + 真实浏览器（CDP）跑完整流程：
//   仅本机使用建库 → 新建便签 → 校验只写密文 → 锁定 → 离线解锁 → 数据仍在
//   → 点状态胶囊才要求连接 NAS → 全程零 /api 请求
// 零依赖（Node 内置 http/child_process/WebSocket）。运行：node tools/test_offline_mode.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const STATIC = path.join(ROOT, 'static');
const read = (name) => fs.readFileSync(path.join(STATIC, name), 'utf8');
const html = read('index.html');
const css = read('style.css');
const app = read('app.js');
const sw = read('sw.js');
const bridge = fs.readFileSync(path.join(ROOT, 'android/app/src/main/assets/_bridge.js'), 'utf8');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (error) { console.error('  FAIL ' + name + ': ' + error.message); process.exitCode = 1; }
}

// ---------- 静态结构：离线独立 ----------
ok('锁屏提供「仅在本机使用」入口（不连 NAS 也能开始）', () => {
  assert.match(html, /id="lockLocalBtn"[^>]*hidden>仅在本机使用（不连接 NAS）</);
  assert.match(app, /els\.lockLocalBtn\.addEventListener\('click'/);
  assert.match(app, /function createLocalVault\(passphrase\)/);
  assert.match(app, /local_only: true/);
});

ok('本机缓存包裹层，离线可解锁', () => {
  assert.match(app, /async function readLocalVault\(\)/);
  assert.match(app, /async function saveLocalVault\(meta\)/);
  assert.match(app, /async function unlockWithLocalVault\(passphrase\)/);
  // 本地解锁分支不出现登录请求
  const block = app.slice(app.indexOf('async function unlockWithLocalVault'), app.indexOf('async function createLocalVault'));
  assert.doesNotMatch(block, /fetch\(|\/api\//);
});

ok('解锁先走本机，失败才联网', () => {
  const block = app.slice(app.indexOf('async function handleUnlock()'), app.indexOf('async function checkLegacyVerifier'));
  const localAt = block.indexOf('unlockWithLocalVault');
  const onlineAt = block.indexOf('unlockOnline');
  assert.ok(localAt > 0 && onlineAt > 0, '两个分支都应存在');
  assert.ok(localAt < onlineAt, '本机解锁必须排在联网之前');
});

ok('安卓壳默认手动同步，启动不联网', () => {
  assert.match(app, /const IS_SHELL = Boolean\(window\.__NN_SHELL__\)/);
  assert.match(app, /const DEFAULT_SYNC_MODE = IS_SHELL \? 'manual' : 'auto'/);
  assert.match(app, /localStorage\.getItem\('nn-sync-mode'\) \|\| DEFAULT_SYNC_MODE/);
  // 启动阶段只有自动模式才刷新会话
  assert.match(app, /if \(sessionToken && syncMode === 'auto'\) \{\s*\n\s*try \{\s*\n\s*await fetchMeta\(\)/);
});

ok('手动模式下编辑不触发同步请求', () => {
  assert.match(app, /function triggerSync\(delay = 300\) \{\s*\n\s*if \(syncMode !== 'auto' \|\| !cryptoKey \|\| !sessionToken\) return;/);
});

ok('状态胶囊是手动同步入口，且手机可见', () => {
  assert.match(html, /<button id="syncBadge" class="badge sync-chip" type="button"/);
  assert.match(app, /els\.syncBadge\.addEventListener\('click', doManualSync\)/);
  assert.match(app, /async function doManualSync\(\)/);
  assert.match(css, /button\.sync-chip/);
  // 手机端侧栏是隐藏的，胶囊必须在列表头部
  assert.match(html, /<div class="note-pane-title">[\s\S]{0,120}id="syncBadge"/);
});

ok('同步前先校验两边是同一套加密库', () => {
  assert.match(app, /async function readServerVault\(\)/);
  assert.match(app, /vaultMeta\.salt !== meta\.salt/);
  assert.match(app, /async function uploadLocalVault\(\)/);
  assert.match(app, /SYNC_ERR_VAULT/);
});

ok('同步失败不回锁屏（不丢正在编辑的内容）', () => {
  const block = app.slice(app.indexOf('function handleSessionExpired()'), app.indexOf('function syncFail('));
  assert.match(block, /if \(cryptoKey && offlineReady\)/);
  assert.match(block, /return;/);
});

ok('锁定不再撤销会话、不发 /api/logout', () => {
  const block = app.slice(app.indexOf('async function lockApp()'), app.indexOf('// ---------- 本地写入'));
  assert.doesNotMatch(block, /fetch\([^)]*(logout|\/api\/)/);
  assert.doesNotMatch(block, /sessionToken = ''/);
});

ok('导入备份纯本机写入，离线也能恢复', () => {
  const block = app.slice(app.indexOf('async function importBackup(file)'), app.indexOf('// ---------- 事件绑定'));
  assert.doesNotMatch(block, /fetch\('\/api\//);
  assert.match(block, /STORE_OUT/);
});

ok('设置 → 同步有本机状态卡片与立即同步', () => {
  assert.match(html, /id="syncLocalState"/);
  assert.match(html, /id="syncPendingCount"/);
  assert.match(html, /id="syncLastAt"/);
  assert.match(html, /id="syncNowSettings"/);
  assert.match(app, /els\.syncNowSettings\.addEventListener\('click', doManualSync\)/);
});

ok('壳内 NAS 地址放在同步面板里', () => {
  assert.match(bridge, /\.settings-panel\[data-panel="sync"\]/);
  assert.match(bridge, /nn-server-row/);
});

ok('Service Worker 缓存已升版', () => {
  const cached = Number((/const CACHE = 'nas-notes-v(\d+)'/.exec(sw) || [0, '0'])[1]);
  assert.ok(cached >= 22, 'CACHE 版本需 >= 22，当前 ' + cached);
});

// ---------- 真实浏览器：完整离线流程 ----------
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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

// 页面里跑的完整流程。返回 { steps: [{ name, ok, extra }], ... }
const FLOW = String.raw`(async () => {
  const info = { steps: [] };
  const step = (name, good, extra) => info.steps.push({ name, ok: !!good, extra: extra === undefined ? '' : String(extra) });
  const waitFor = async (fn, timeout) => {
    const start = Date.now();
    while (Date.now() - start < (timeout || 10000)) {
      let value = false;
      try { value = fn(); } catch (error) { value = false; }
      if (value) return true;
      await new Promise((r) => setTimeout(r, 60));
    }
    return false;
  };
  const openDb = () => new Promise((resolve, reject) => {
    const req = indexedDB.open('nas-notes-enc');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const all = (db, name) => new Promise((resolve, reject) => {
    const req = db.transaction(name, 'readonly').objectStore(name).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const one = (db, name, key) => new Promise((resolve, reject) => {
    const req = db.transaction(name, 'readonly').objectStore(name).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  try {
    const lock = document.getElementById('lockScreen');
    const localBtn = document.getElementById('lockLocalBtn');
    await waitFor(() => localBtn && !localBtn.hidden, 6000);
    info.lockTitle = document.getElementById('lockTitle').textContent.trim();
    step('本机无库时出现「仅在本机使用」', localBtn && !localBtn.hidden);

    document.getElementById('passphraseInput').value = 'test-pass-123';
    localBtn.click();
    const unlocked = await waitFor(() => lock.hidden === true, 20000);
    info.lockError = document.getElementById('lockError').textContent.trim();
    step('不联网即可创建本机加密库并进入', unlocked, info.lockError);
    if (!unlocked) throw new Error('离线建库失败');

    document.getElementById('newBtn').click();
    const editing = await waitFor(() => document.getElementById('deleteBtn').hidden === false, 5000);
    step('能新建便签', editing);
    const title = '离线测试便签';
    const titleInput = document.getElementById('titleInput');
    titleInput.value = title;
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    const rich = document.getElementById('richEditor');
    rich.innerHTML = '<p>断网也能写，这是本机数据</p>';
    rich.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));

    const db = await openDb();
    const notes = await all(db, 'notes');
    const outbox = await all(db, 'outbox');
    const vaultRow = await one(db, 'meta', 'vault');
    const vault = vaultRow && vaultRow.value ? JSON.parse(vaultRow.value) : {};
    info.noteCount = notes.length;
    info.outboxCount = outbox.length;
    info.localOnly = !!vault.local_only;
    info.hasWrapped = !!vault.wrapped;

    const dump = JSON.stringify({ notes, outbox, meta: vaultRow });
    step('便签以密文落盘（库内找不到明文）', notes.length >= 1 && dump.indexOf(title) < 0 && dump.indexOf('断网也能写') < 0);
    step('本机保存了包裹层（离线解锁凭据）', info.hasWrapped);
    step('修改进入待同步队列', outbox.length >= 1, 'outbox=' + outbox.length);

    info.badge = document.getElementById('syncBadge').textContent.trim();
    step('状态胶囊提示待同步', /待同步/.test(info.badge), info.badge);

    // 壳内默认手动：打开设置看同步方式
    document.getElementById('settingsBtn').click();
    const settingsOpen = await waitFor(() => {
      const d = document.getElementById('settingsDialog');
      return d.open || d.hasAttribute('open');
    }, 4000);
    if (settingsOpen) {
      info.syncModeValue = document.getElementById('syncMode').value;
      info.syncLocalState = document.getElementById('syncLocalState').textContent.trim();
      info.syncServerAddr = document.getElementById('syncServerAddr').textContent.trim();
    }
    step('壳内同步方式默认为「手动」', info.syncModeValue === 'manual', info.syncModeValue);
    step('同步设置展示本机状态', /加密/.test(info.syncLocalState || ''), info.syncLocalState);
    document.getElementById('settingsClose').click();
    await new Promise((r) => setTimeout(r, 200));

    // 锁定 → 只用本机密码解锁
    document.getElementById('lockBtn').click();
    const locked = await waitFor(() => lock.hidden === false, 4000);
    info.lockHintAfterLock = document.getElementById('lockHint').textContent.trim();
    step('可锁定并回到解锁页', locked);
    document.getElementById('passphraseInput').value = 'test-pass-123';
    document.getElementById('unlockBtn').click();
    const reopened = await waitFor(() => lock.hidden === true, 20000);
    step('离线输入密码即可重新解锁', reopened, document.getElementById('lockError').textContent.trim());
    const listText = document.getElementById('noteList').innerText || '';
    step('解锁后离线便签仍在列表', listText.indexOf(title) >= 0);

    // 点状态胶囊：没有会话 → 先要求连接 NAS（不发请求）
    document.getElementById('syncBadge').click();
    const dlg = document.getElementById('syncLoginDialog');
    const askLogin = await waitFor(() => dlg.open || dlg.hasAttribute('open'), 4000);
    step('手动同步时才要求连接 NAS', askLogin);
    info.apiCallsAfterAsk = window.__apiCalls.slice();
    step('点同步不等同于自动上传（尚未发请求）', info.apiCallsAfterAsk.length === 0, JSON.stringify(info.apiCallsAfterAsk));
    document.getElementById('syncLoginCancel').click();
    await new Promise((r) => setTimeout(r, 250));
    step('取消连接后仍在本机工作', lock.hidden === true);

    info.apiCalls = window.__apiCalls.slice();
    step('全程零 /api 请求', info.apiCalls.length === 0, JSON.stringify(info.apiCalls));
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
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function runBrowserFlow() {
  const browser = findBrowser();
  if (!browser) {
    console.log('  SKIP 浏览器离线流程（未找到 Edge/Chrome）');
    return;
  }

  const port = 19280 + Math.floor(Math.random() * 60);
  const origin = 'http://127.0.0.1:' + port;
  const apiHits = [];

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath.startsWith('/api/')) {
      apiHits.push(req.method + ' ' + urlPath);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end('{"error":"offline test: NAS unreachable"}');
      return;
    }
    const rel = urlPath === '/' ? '/index.html' : urlPath;
    const file = path.join(STATIC, rel);
    if (!file.startsWith(STATIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    let body = fs.readFileSync(file);
    if (rel === '/index.html') {
      // 在 app.js 之前统计所有 /api/ 请求，并模拟安卓壳环境
      const probe = '<script>window.__NN_SHELL__=true;window.__apiCalls=[];' +
        '(function(){var orig=window.fetch;window.fetch=function(input,init){' +
        'var u=typeof input==="string"?input:(input&&input.url)||"";' +
        'if(String(u).indexOf("/api/")>=0)window.__apiCalls.push(String(u));' +
        'return orig.apply(this,arguments);};})();</script>';
      body = Buffer.from(String(body).replace('</head>', probe + '</head>'), 'utf8');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream' });
    res.end(body);
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-offline-'));
  const debugPort = port + 100;
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + profile,
    origin + '/'
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { child.kill(); } catch (error) { /* ignore */ }
    try { server.close(); } catch (error) { /* ignore */ }
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (error) { /* ignore */ } }, 300);
  };

  try {
    let target = null;
    for (let i = 0; i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      try {
        const list = await getJson('http://127.0.0.1:' + debugPort + '/json/list');
        const pages = (list || []).filter((item) => item.type === 'page' && item.webSocketDebuggerUrl);
        // 优先取已经导航到测试页的 target；about:blank 会在导航时被销毁
        target = pages.find((item) => String(item.url || '').indexOf(origin) === 0) || pages[0] || null;
        if (target && String(target.url || '').indexOf(origin) === 0) break;
      } catch (error) { /* 浏览器还没起来 */ }
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
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    const send = (method, params) => new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });

    // 等页面稳定：连续两次 readyState=complete 才算导航结束（否则上下文会被销毁）
    let stable = 0;
    for (let i = 0; i < 120; i += 1) {
      const state = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      const value = state.result && state.result.result && state.result.result.value;
      if (value === 'complete') stable += 1; else stable = 0;
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
    const detail = reply.result || {};
    if (detail.exceptionDetails) {
      throw new Error('页面脚本异常：' + JSON.stringify(detail.exceptionDetails).slice(0, 400));
    }
    const raw = detail.result && detail.result.value;
    if (!raw) throw new Error('页面没有返回结果：' + JSON.stringify(reply).slice(0, 600));

    const info = JSON.parse(raw);
    (info.steps || []).forEach((item) => {
      if (item.ok) { pass += 1; console.log('  PASS ' + item.name); }
      else {
        console.error('  FAIL ' + item.name + (item.extra ? '（' + item.extra + '）' : ''));
        process.exitCode = 1;
      }
    });
    if (info.error) {
      console.error('  FAIL 离线流程中断：' + info.error);
      process.exitCode = 1;
    }
    if (apiHits.length) {
      console.error('  FAIL 服务端收到了 /api 请求（离线模式不该发）：' + JSON.stringify(apiHits.slice(0, 5)));
      process.exitCode = 1;
    }
    socket.close();
  } finally {
    cleanup();
  }
}

runBrowserFlow().catch((error) => {
  console.error('  FAIL 浏览器离线流程：' + (error && error.message ? error.message : error));
  process.exitCode = 1;
}).finally(() => {
  console.log('\nOffline mode tests: ' + pass + ' pass');
});
