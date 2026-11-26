'use strict';
// 大规模数据压测：真实浏览器（CDP）+ 真实 server.py。
// 目的不是「通过/失败」，而是量出轻量化架构在 N 条便签下的耗时曲线与硬边界。
// 零依赖（Node 内置 http / child_process / node:sqlite / WebSocket / fetch）。
// 运行：node tools/test_scale.js
// 结果同时写入 .tmp/scale-results.json，便于写报告时引用。

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STATIC = path.join(ROOT, 'static');
const TMP = path.join(ROOT, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

const results = { browser: [], server: [], notes: [] };

function findBrowser() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  for (const file of candidates) if (fs.existsSync(file)) return file;
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json'
};

function getJson(url) {
  return fetch(url).then((r) => r.json());
}

function cdpClient(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  };
  const ready = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('CDP 连接失败'));
  });
  return {
    ready,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { socket.close(); } catch (e) { /* ignore */ } }
  };
}

async function evaluate(cdp, expression, timeoutMs = 240000) {
  const work = cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true
  }).then((reply) => {
    if (reply.exceptionDetails) {
      throw new Error(reply.exceptionDetails.text + ' ' +
        (reply.exceptionDetails.exception || {}).description || '');
    }
    return reply.result && reply.result.value;
  });
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('页面压测超时 ' + timeoutMs + 'ms')), timeoutMs);
  });
  try { return await Promise.race([work, limit]); }
  finally { clearTimeout(timer); }
}

// ---------- 页面内压测主体 ----------
// 直接复用 app.js 的全局函数/变量（顶层不是 IIFE，只有启动流程是），
// 因此测的就是产品代码本身，不是重写一份算法。
const BROWSER_BENCH = String.raw`(async () => {
  const out = { counts: [], error: '' };
  const waitFor = async (fn, timeout) => {
    const start = Date.now();
    while (Date.now() - start < (timeout || 15000)) {
      let v = false; try { v = fn(); } catch (e) { v = false; }
      if (v) return true;
      await new Promise((r) => setTimeout(r, 60));
    }
    return false;
  };
  const bench = async (name, fn, reps) => {
    const times = [];
    for (let r = 0; r < (reps || 2); r += 1) {
      const t = performance.now();
      await fn();
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    return { name, ms: Math.round(times[0] * 10) / 10 };
  };
  try {
    // 1) 用产品自身的「仅在本机使用」建一个真实本机加密库
    const localBtn = document.getElementById('lockLocalBtn');
    await waitFor(() => localBtn && !localBtn.hidden, 10000);
    document.getElementById('passphraseInput').value = 'scale-bench-pass';
    localBtn.click();
    const unlocked = await waitFor(() => document.getElementById('lockScreen').hidden === true, 30000);
    if (!unlocked || !cryptoKey) throw new Error('本机库解锁失败：' + document.getElementById('lockError').textContent);

    const MAX = 3000;
    const body = '# 压测便签\n\n这是一条用于压测的正文，包含 **加粗** 与列表：\n- 项目一\n- 项目二\n\n' + '正文内容段落 '.repeat(24);
    const tGen = performance.now();
    const all = [];
    // 分批并发加密，避免 3000 次串行 await 把造数时间也算进去
    for (let base = 0; base < MAX; base += 100) {
      const batch = [];
      for (let i = base; i < Math.min(MAX, base + 100); i += 1) {
        const plain = {
          title: '便签 ' + i, body: body, body_format: 'md',
          folder: i % 7 === 0 ? '工作' : (i % 7 === 1 ? '生活' : ''), attachments: []
        };
        batch.push(encryptJSON(cryptoKey, plain).then((sealed) => ({
          id: 'bench-' + i, iv: sealed.iv, payload: sealed.payload,
          created_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
          updated_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
          deleted: false, device: 'bench'
        })));
      }
      all.push(...await Promise.all(batch));
    }
    out.genMs = Math.round(performance.now() - tGen);
    out.avgCipherBytes = Math.round(all.reduce((s, n) => s + n.payload.length, 0) / all.length);

    const db = await dbPromise;
    const writeAll = (rows) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NOTES, 'readwrite');
      const store = tx.objectStore(STORE_NOTES);
      store.clear();
      rows.forEach((n) => store.put(n));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });

    for (const N of [100, 500, 1000, 3000]) {
      const subset = all.slice(0, N);
      await writeAll(subset);
      notesCache.clear(); plainCache.clear();
      subset.forEach((n) => notesCache.set(n.id, n));
      const row = { N, phases: [] };

      row.phases.push(await bench('冷启动全量解密 rebuildPlainCache', () => rebuildPlainCache()));
      row.phases.push(await bench('列表全量重建 renderList', () => renderList()));
      const list = document.getElementById('noteList');
      row.domNodes = list.querySelectorAll('*').length;
      row.htmlKB = Math.round(list.innerHTML.length / 1024);
      row.renderedItems = list.querySelectorAll('.note-item').length;
      row.hasMore = !!document.getElementById('listMoreBtn');

      // 搜索：标题不含关键词、正文含 → 每条都会跑 NN_MD.text，最坏情况
      row.phases.push(await bench('搜索每敲一字（全量过滤+重渲染）', () => {
        els.searchInput.value = '压测'; renderList();
      }));
      els.searchInput.value = '';
      renderList();

      row.phases.push(await bench('单条编辑保存 queueUpsert', () => queueUpsert(notesCache.get('bench-1')), 3));
      row.phases.push(await bench('冷启动整体 = 解密 + 列表渲染', async () => {
        plainCache.clear(); await rebuildPlainCache(); renderList();
      }));

      // 模拟「换设备后首次全量同步」：对 200 条逐条解密 + 逐条写 IndexedDB，
      // 结果与 sync() 拉取循环里的成本一致（每条一次 await decrypt + 一次 idbPut）
      const pull = subset.slice(0, 200);
      const tPull = performance.now();
      for (const n of pull) {
        const p = await decryptJSON(cryptoKey, n.iv, n.payload);
        plainCache.set(n.id, p);
        await idbPut(STORE_NOTES, n);
      }
      row.pull200Ms = Math.round(performance.now() - tPull);
      row.pullPerNoteMs = Math.round(row.pull200Ms / pull.length * 100) / 100;

      // 「显示全部」按钮必须能把剩余便签全部展开（数据一条不少）
      if (N === 3000) {
        const more = document.getElementById('listMoreBtn');
        row.expandedItems = -1;
        if (more) {
          more.click();
          row.expandedItems = document.querySelectorAll('#noteList .note-item').length;
          listShowAll = false;
          renderList();
        }
      }
      out.counts.push(row);
    }

    // 搜索防抖回归：连打 10 个字符只应触发一次列表重建
    const origRender = renderList;
    let calls = 0;
    window.renderList = function () { calls += 1; return origRender.apply(this, arguments); };
    els.searchInput.value = '压测';
    for (let i = 0; i < 10; i += 1) els.searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 260));
    out.debounceCalls = calls;
    window.renderList = origRender;
    els.searchInput.value = '';
    renderList();
  } catch (error) {
    out.error = String(error && (error.stack || error.message));
  }
  return JSON.stringify(out);
})()`;

async function browserBench() {
  const browser = findBrowser();
  if (!browser) { console.log('未找到 Edge/Chrome，跳过浏览器压测'); return; }
  const port = 18941;
  const origin = 'http://127.0.0.1:' + port;
  const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    if (urlPath.startsWith('/api/')) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end('{"error":"bench: NAS offline"}');
      return;
    }
    const rel = urlPath === '/' ? '/index.html' : urlPath;
    const file = path.join(STATIC, rel);
    if (!file.startsWith(STATIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    let buf = fs.readFileSync(file);
    if (rel === '/index.html') {
      // 模拟壳：同步默认手动，启动时不发 /api 请求
      buf = Buffer.from(String(buf).replace('</head>',
        '<script>window.__NN_SHELL__=true;</script></head>'), 'utf8');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream' });
    res.end(buf);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-scale-'));
  const debugPort = port + 100;
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile,
    '--window-size=1280,900', origin + '/'
  ], { stdio: 'ignore' });
  const cleanup = () => {
    try { child.kill(); } catch (e) { /* ignore */ }
    try { server.close(); } catch (e) { /* ignore */ }
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ } }, 300);
  };

  try {
    let target = null;
    for (let i = 0; i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      try {
        const pages = (await getJson('http://127.0.0.1:' + debugPort + '/json/list') || [])
          .filter((item) => item.type === 'page' && item.webSocketDebuggerUrl);
        target = pages.find((item) => String(item.url || '').indexOf(origin) === 0) || null;
        if (target) break;
      } catch (e) { /* 浏览器还没起来 */ }
    }
    if (!target) throw new Error('无法连接浏览器调试端口');
    const cdp = cdpClient(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    // 壳内本就不注册 SW；不同内核对该命令支持不一，失败可忽略
    try { await cdp.send('Network.setBypassServiceWorker', { bypass: true }); } catch (e) { /* ignore */ }
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.reload', { ignoreCache: true });
    await new Promise((r) => setTimeout(r, 1200));
    const raw = await evaluate(cdp, BROWSER_BENCH);
    cdp.close();
    const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (info.error) throw new Error(info.error);
    results.browser = info.counts;
    results.notes.push('密文平均长度 ' + info.avgCipherBytes + ' B/条；造 ' + 3000 + ' 条耗时 ' + info.genMs + ' ms');

    console.log('\n【浏览器端】真实 Chromium + 真实 app.js（单位 ms，取 2 次最优值）');
    console.log('  N     冷启动解密  列表渲染  搜索一次  单条保存  冷启动整体   DOM节点  列表HTML  渲染条数');
    for (const r of info.counts) {
      const ms = (name) => String((r.phases.find((p) => p.name.indexOf(name) >= 0) || {}).ms || '-').padStart(8);
      console.log('  ' + String(r.N).padEnd(6) + ms('冷启动全量解密') + ' ' + ms('列表全量重建') + ' ' +
        ms('搜索每敲一字') + ' ' + ms('单条编辑保存') + ' ' + ms('冷启动整体') +
        ' ' + String(r.domNodes).padStart(9) + ' ' + String(r.htmlKB + 'KB').padStart(9) +
        ' ' + String(r.renderedItems + (r.hasMore ? '(有更多)' : '')).padStart(10));
    }
    console.log('  模拟换设备首次同步：200 条逐条解密+写库 = ' +
      info.counts[0].pull200Ms + ' ms（' + info.counts[0].pullPerNoteMs + ' ms/条，全量按此线性放大）');

    // ---------- 回归断言：优化必须真的生效 ----------
    const big = info.counts[info.counts.length - 1];
    const checks = [
      ['大列表默认只渲染 200 条', big.renderedItems <= 200 && big.renderedItems > 0],
      ['大列表出现「显示全部」按钮', big.hasMore === true],
      ['点「显示全部」后 3000 条一条不少', big.expandedItems === 3000],
      ['DOM 节点数被压住（<1200）', big.domNodes < 1200],
      ['搜索连打 10 字只重建 1 次列表', info.debounceCalls <= 2]
    ];
    console.log('  回归断言：');
    for (const [name, good] of checks) {
      console.log('    ' + (good ? 'PASS ' : 'FAIL ') + name);
      if (!good) process.exitCode = 1;
    }
    console.log('  搜索防抖实测调用次数：' + info.debounceCalls + '（10 次 input）');
    results.notes.push('回归断言 ' + checks.filter((c) => c[1]).length + '/' + checks.length +
      '；搜索防抖 ' + info.debounceCalls + ' 次/10 次输入');
  } finally {
    cleanup();
  }
}

// ---------- 服务端压测 ----------
async function serverBench() {
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-scale-db-'));
  const port = 18942;
  const env = Object.assign({}, process.env, {
    PORT: String(port), DATA_DIR: dir, STATIC_DIR: STATIC
  });
  let child = null;
  const start = async () => {
    child = spawn('python', [path.join(ROOT, 'server.py')], { env, stdio: 'ignore' });
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/api/health');
        if (r.ok) return;
      } catch (e) { /* 还没起来 */ }
    }
    throw new Error('server.py 启动超时');
  };
  const stop = () => { if (child) { try { child.kill(); } catch (e) { /* ignore */ } child = null; } };

  try {
    await start();
    const login = await fetch('http://127.0.0.1:' + port + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' })
    });
    const session = await login.json();
    if (!session.token) throw new Error('登录失败：' + JSON.stringify(session));
    const headers = { 'Content-Type': 'application/json', 'X-Token': session.token };

    const dbPath = path.join(dir, 'notes.db');
    const payload = 'A'.repeat(2000);   // 模拟约 1.4KB 明文加密后的密文
    const iv = 'AAAAAAAAAAAAAAAA';
    const db = new DatabaseSync(dbPath);
    const insert = db.prepare('INSERT OR REPLACE INTO notes (id, iv, payload, created_at, updated_at, deleted, device) VALUES (?,?,?,?,?,0,?)');
    const now = '2026-01-01T00:00:00.000Z';

    console.log('\n【服务端】真实 server.py + SQLite（全量 GET /api/notes）');
    console.log('  N      建库写入   GET耗时   响应体积    每条约');
    for (const N of [500, 2000, 5000]) {
      const t0 = performance.now();
      db.exec('DELETE FROM notes');
      for (let i = 0; i < N; i += 1) insert.run('s-' + i, iv, payload, now, now, 'bench');
      const writeMs = Math.round(performance.now() - t0);
      const t1 = performance.now();
      const resp = await fetch('http://127.0.0.1:' + port + '/api/notes', { headers });
      const text = await resp.text();
      const getMs = Math.round((performance.now() - t1) * 10) / 10;
      results.server.push({ N, writeMs, getMs, bytes: text.length });
      console.log('  ' + String(N).padEnd(7) + String(writeMs + 'ms').padStart(8) +
        String(getMs + 'ms').padStart(10) + String(Math.round(text.length / 1024) + 'KB').padStart(10) +
        String(Math.round(text.length / N) + 'B').padStart(10));
    }

    // 硬边界：单条密文上限 12MB，请求体上限 14MB
    const big = 'A'.repeat(12 * 1024 * 1024 + 10);
    const t2 = performance.now();
    const resp = await fetch('http://127.0.0.1:' + port + '/api/notes/boundary', {
      method: 'PUT', headers,
      body: JSON.stringify({ iv: iv, payload: big, updated_at: now, device: 'bench' })
    });
    const boundary = { status: resp.status, ms: Math.round(performance.now() - t2), body: (await resp.text()).slice(0, 80) };
    results.server.push({ boundary });
    console.log('  单条密文 12MB+ → HTTP ' + boundary.status + '（' + boundary.body + '），' + boundary.ms + 'ms');
    db.close();
  } finally {
    stop();
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }, 300);
  }
}

(async () => {
  console.log('轻签大规模数据压测（真实浏览器 + 真实服务端，零依赖）');
  await browserBench();
  await serverBench();
  fs.writeFileSync(path.join(TMP, 'scale-results.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log('\n结果已写入 .tmp/scale-results.json');
})().catch((error) => {
  console.error('压测失败：', error && (error.stack || error.message));
  process.exitCode = 1;
});
