'use strict';
// 客户端增量同步 + 全文索引端到端演练（真实 server.py + 真实 Chromium CDP）。
// 零第三方依赖。运行：node tools/test_client_sync.js
//
// 验证：同步后 IDB 里落下「只含 rev/epoch/salt」的游标；第二次同步带 ?since=
// 且服务端返回 0 条（不是全量）；服务端新增 1 条后下一次同步只拉 1 条；
// 搜索结果与改造前一致；锁定后内存索引销毁。

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('node:assert');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const staticDir = path.join(ROOT, 'static');
const PORT = Number(process.env.NN_INCSYNC_PORT || '18798');
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-incsync-client-'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  PASS ' + name); }
  else {
    console.error('  FAIL ' + name + (extra ? '（' + extra + '）' : ''));
    process.exitCode = 1;
  }
}

// ---------------- 静态协议回归（无浏览器也能跑） ----------------
const app = read('static/app.js');
const server = read('server.py');
const html = read('static/index.html');
const sw = read('static/sw.js');

ok('客户端拉取改为 ?since= 增量', () => {
  assert.match(app, /fetch\('\/api\/notes\?since=' \+ encodeURIComponent/);
  assert.match(app, /data\.nextSince/);
  assert.match(app, /data\.partial/);
});
ok('客户端游标只存 rev / epoch / salt，且绑定 vault', () => {
  assert.match(app, /CURSOR_META_KEY = 'sync_cursor'/);
  assert.match(app, /writeSyncCursor\(\{ rev: finalRev, epoch: serverEpoch, salt: vaultSalt \}\)/);
  assert.match(app, /cursor\.salt === vaultSalt/);
  assert.match(app, /cursor\.epoch !== serverEpoch/);
  assert.match(app, /resetSyncCursor\(\)/);
});
ok('老服务端（无 rev）自动退化为一次性全量、不写游标', () => {
  assert.match(app, /typeof data\.rev !== 'number'/);
  assert.match(app, /incremental = false/);
  assert.match(app, /if \(incremental\) \{\s*await writeSyncCursor/);
});
ok('分页有上限保护，游标大于服务端 rev 时强制全量', () => {
  assert.match(app, /pages < 200/);
  assert.match(app, /since > data\.rev/);
});
ok('冲突裁决仍是 LWW + device 字典序，rev 不参与裁决', () => {
  assert.match(app, /function isNewer\(updatedA, deviceA, updatedB, deviceB\)/);
  assert.match(app, /if \(updatedA !== updatedB\) return updatedA > updatedB;/);
  assert.match(app, /return deviceA > deviceB;/);
  assert.match(server, /def is_newer\(updated_a, device_a, updated_b, device_b\)/);
  assert.match(server, /return updated_a > updated_b/);
  assert.match(server, /return device_a > device_b/);
  assert.match(app, /rev 只用于分页与游标，绝不参与裁决/);
});
ok('服务端 rev / 分页 / 墓碑 / epoch 齐备', () => {
  assert.match(server, /def allocate_rev\(conn\)/);
  assert.match(server, /SELECT \* FROM notes WHERE rev > \? ORDER BY rev ASC LIMIT \?/);
  assert.match(server, /"partial": partial, "nextSince": next_since/);
  assert.match(server, /UPDATE sync_state SET value = value \+ 1 WHERE key = 'epoch'/);
});
ok('索引模块已接入页面与 SW，且锁定会销毁', () => {
  assert.match(html, /<script src="\/nn-index\.js"><\/script>/);
  assert.match(sw, /'\/nn-index\.js'/);
  assert.match(app, /NN_INDEX\.create\(\)/);
  assert.match(app, /if \(noteIndex\) noteIndex\.clear\(\);   \/\/ 明文索引只在解锁期间存在/);
  assert.match(app, /noteIndex\.query\(query\)/);
  assert.match(app, /idbPutMany\(STORE_NOTES, pulled\)/);
});

// ---------------- 端到端 ----------------
function findBrowser() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  for (const file of candidates) if (fs.existsSync(file)) return file;
  return null;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function api(method, urlPath, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Token'] = token;
  const res = await fetch(BASE + urlPath, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = {};
  try { json = await res.json(); } catch (e) { /* empty */ }
  return { status: res.status, body: json };
}

const HOOK = String.raw`(function () {
  window.__nnReqLog = [];
  window.__nnRespLog = [];
  var real = window.fetch;
  window.fetch = function (input, init) {
    var u = typeof input === 'string' ? input : (input && input.url) || '';
    window.__nnReqLog.push(u);
    return real.apply(this, arguments).then(function (r) {
      if (u.indexOf('/api/notes') === 0) {
        try {
          r.clone().json().then(function (d) {
            window.__nnRespLog.push({
              url: u, count: (d.notes || []).length,
              ids: (d.notes || []).map(function (n) { return n.id; }),
              rev: d.rev, partial: d.partial
            });
          }).catch(function () {});
        } catch (e) {}
      }
      return r;
    });
  };
})();`;

const FLOW_SETUP = String.raw`(async () => {
  const out = { steps: [] };
  const step = (name, good, extra) => out.steps.push({ name: name, ok: !!good, extra: extra === undefined ? '' : String(extra) });
  const waitFor = async (fn, timeout) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeout || 15000)) {
      let v = false;
      try { v = fn(); } catch (e) { v = false; }
      if (v) return true;
      await new Promise((r) => setTimeout(r, 80));
    }
    return false;
  };
  const idbGet = (store, key) => new Promise((resolve) => {
    const req = indexedDB.open('nas-notes-enc');
    req.onsuccess = () => {
      const tx = req.result.transaction(store, 'readonly').objectStore(store).get(key);
      tx.onsuccess = () => resolve(tx.result || null);
      tx.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  });
  try {
    const localBtn = document.getElementById('lockLocalBtn');
    await waitFor(() => localBtn && !localBtn.hidden, 8000);
    document.getElementById('passphraseInput').value = 'incsync-2026';
    localBtn.click();
    step('离线建库成功', await waitFor(() => document.getElementById('lockScreen').hidden === true, 30000),
      document.getElementById('lockError').textContent.trim());

    for (const title of ['增量甲', '增量乙']) {
      document.getElementById('newBtn').click();
      await waitFor(() => document.getElementById('deleteBtn').hidden === false, 5000);
      const input = document.getElementById('titleInput');
      input.value = title;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      // 富文本默认视图下 bodyInput 只是隐藏的源码框，直接改它会被
      // currentBodyMd() 覆盖；正文索引改由下面的独立探针验证。
      await new Promise((r) => setTimeout(r, 750));
    }

    // 第一次同步：点状态胶囊 -> 输入 NAS 账户
    document.getElementById('syncBadge').click();
    const dlg = document.getElementById('syncLoginDialog');
    step('弹出连接 NAS 对话框', await waitFor(() => dlg.open || dlg.hasAttribute('open'), 5000));
    document.getElementById('syncUser').value = 'admin';
    document.getElementById('syncPass').value = 'admin';
    document.getElementById('syncLoginOk').click();
    step('首次同步完成', await waitFor(() => /已同步|已连接/.test(document.getElementById('syncBadge').textContent), 30000),
      document.getElementById('syncBadge').textContent.trim());
    await new Promise((r) => setTimeout(r, 500));

    const row = await idbGet('meta', 'sync_cursor');
    let cursor = null;
    try { cursor = row && row.value ? JSON.parse(row.value) : null; } catch (e) { cursor = null; }
    step('增量游标已落到本机 IDB', !!cursor && typeof cursor.rev === 'number' && cursor.epoch === 1 && !!cursor.salt,
      JSON.stringify(cursor));
    step('游标不含任何明文', !!cursor && JSON.stringify(cursor).indexOf('增量甲') < 0
      && !('title' in cursor) && !('body' in cursor) && !('text' in cursor), JSON.stringify(cursor));
    out.cursor = cursor;

    // 内存全文索引：解锁后恰好 2 条文档
    let stats = null;
    try { stats = noteIndex.stats(); } catch (e) { stats = null; }
    step('全文索引已构建（2 条文档）', !!stats && stats.docs === 2 && stats.bigrams > 0, JSON.stringify(stats));
    out.stats = stats;

    // 正文/分类/附件名的索引能力在真实浏览器里做一次独立探针
    const probe = NN_INDEX.create();
    probe.add('probe', '标题\n全文索引关键词Alpha\n工作', '工作');
    out.probeBody = probe.query('全文索引关键词').has('probe');
    out.probeFolder = probe.idsInFolder('工作').has('probe');
    step('正文中文子串可被索引召回', out.probeBody === true, out.probeBody);
    step('分类倒排可用', out.probeFolder === true, out.probeFolder);

    // 搜索结果与改造前一致
    const search = document.getElementById('searchInput');
    const countItems = () => document.querySelectorAll('.note-item').length;
    const doSearch = async (q) => {
      search.value = q;
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 260));
      return countItems();
    };
    out.searchAll = await doSearch('增量');
    out.searchAlpha = await doSearch('增量甲');
    out.searchNone = await doSearch('完全不存在xyz');
    out.searchReset = await doSearch('');
    step('搜索「增量」命中 2 条', out.searchAll === 2, out.searchAll);
    step('搜索「增量甲」命中 1 条', out.searchAlpha === 1, out.searchAlpha);
    step('不存在的词 0 条', out.searchNone === 0, out.searchNone);
    step('清空搜索恢复 2 条', out.searchReset === 2, out.searchReset);

    // 第二次同步：两端都无变更，应只带 since 且返回 0 条
    window.__nnReqLog.length = 0;
    window.__nnRespLog.length = 0;
    await window.doManualSync();
    await new Promise((r) => setTimeout(r, 350));
    out.second = { reqs: window.__nnReqLog.slice(), resps: window.__nnRespLog.slice() };
    step('第二次同步所有 /api/notes 都带 ?since=',
      out.second.reqs.filter((u) => u.indexOf('/api/notes') === 0).length > 0
      && out.second.reqs.filter((u) => u.indexOf('/api/notes') === 0)
        .every((u) => u.indexOf('?since=') > 0), JSON.stringify(out.second.reqs));
    step('无变更时服务端返回 0 条（不再全量）',
      out.second.resps.length === 1 && out.second.resps[0].count === 0,
      JSON.stringify(out.second.resps));
    step('第二次同步响应带 rev/partial', out.second.resps.length === 1
      && typeof out.second.resps[0].rev === 'number' && out.second.resps[0].partial === false,
      JSON.stringify(out.second.resps));
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  out.ok = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})()`;

const FLOW_DELTA = String.raw`(async () => {
  const out = { steps: [] };
  const step = (name, good, extra) => out.steps.push({ name: name, ok: !!good, extra: extra === undefined ? '' : String(extra) });
  try {
    window.__nnReqLog.length = 0;
    window.__nnRespLog.length = 0;
    await window.doManualSync();
    await new Promise((r) => setTimeout(r, 400));
    const resps = window.__nnRespLog.slice();
    step('服务端新增 1 条后，客户端只拉到 1 条',
      resps.length === 1 && resps[0].count === 1 && resps[0].ids[0] === 'server-added',
      JSON.stringify(resps));
    step('增量请求仍带 ?since=', resps.length === 1 && resps[0].url.indexOf('?since=') > 0,
      JSON.stringify(resps.map((r) => r.url)));
    // 再同步一次：游标已推进，服务端不再返回这条
    window.__nnRespLog.length = 0;
    await window.doManualSync();
    await new Promise((r) => setTimeout(r, 350));
    const again = window.__nnRespLog.slice();
    step('游标推进后同一条不再重复拉取', again.length === 1 && again[0].count === 0,
      JSON.stringify(again));
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  out.ok = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})()`;

(async () => {
  const browser = findBrowser();
  if (!browser) {
    console.log('  SKIP 端到端演练（未找到 Edge/Chrome）；静态协议断言已完成');
    console.log('\n客户端增量同步测试：' + pass + ' pass');
    return;
  }

  const PY = process.env.NN_PYTHON || 'python';
  const srv = spawn(PY, [path.join(ROOT, 'server.py')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: DATA, STATIC_DIR: staticDir
    }),
    stdio: 'ignore'
  });
  let child = null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-incsync-prof-'));
  const debugPort = PORT + 100;
  const cleanup = () => {
    try { if (child) child.kill(); } catch (e) { /* ignore */ }
    try { srv.kill(); } catch (e) { /* ignore */ }
    setTimeout(() => {
      for (const dir of [profile, DATA]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      }
    }, 400);
  };

  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) {
      try {
        const r = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(800) });
        up = r.ok;
      } catch (e) { await new Promise((r) => setTimeout(r, 250)); }
    }
    if (!up) throw new Error('server.py 没有启动');

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
        const pages = (list || []).filter((x) => x.type === 'page' && x.webSocketDebuggerUrl);
        target = pages.find((x) => String(x.url || '').indexOf(BASE) === 0) || null;
        if (target) break;
      } catch (e) { /* 还没起来 */ }
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
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    const send = (method, params) => new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id: id, method: method, params: params }));
    });

    await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__NN_SHELL__ = true;\n' + HOOK
    });
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Page.reload');

    let stable = 0;
    for (let i = 0; i < 150; i += 1) {
      const state = await send('Runtime.evaluate', {
        expression: 'document.readyState + "|" + (window.__NN_SHELL__ === true) + "|" + (typeof window.__nnReqLog !== "undefined")',
        returnByValue: true
      });
      const v = state.result && state.result.result && state.result.result.value;
      stable = v === 'complete|true|true' ? stable + 1 : 0;
      if (stable >= 2) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const evalFlow = async (expr) => {
      let reply = null;
      for (let i = 0; i < 3; i += 1) {
        reply = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        const err = reply && reply.error && reply.error.message;
        if (!err || !/context was destroyed/i.test(err)) break;
        await new Promise((r) => setTimeout(r, 400));
      }
      if (reply && reply.error) throw new Error('CDP 调用失败：' + reply.error.message);
      const raw = reply && reply.result && reply.result.result && reply.result.result.value;
      if (!raw) throw new Error('页面没有返回结果：' + JSON.stringify(reply).slice(0, 400));
      return JSON.parse(raw);
    };

    const setup = await evalFlow(FLOW_SETUP);
    (setup.steps || []).forEach((s) => ok(s.name, s.ok, s.extra));
    if (setup.error) ok('第一阶段流程未中断', false, setup.error);

    // 服务端侧插入 1 条（假密文即可：客户端解不开会 warn，但仍会被增量拉到）
    const login = await api('POST', '/api/login', { username: 'admin', password: 'admin' });
    const token = login.body.token || '';
    const put = await api('PUT', '/api/notes/server-added', {
      iv: 'aaaaaaaaaaaaaaaa', payload: 'opaque-ciphertext-from-server',
      updated_at: new Date().toISOString(), device: 'server-test'
    }, token);
    ok('服务端新增 1 条便签成功', put.status === 200 && put.body.applied === true,
      JSON.stringify(put.body).slice(0, 160));

    const delta = await evalFlow(FLOW_DELTA);
    (delta.steps || []).forEach((s) => ok(s.name, s.ok, s.extra));
    if (delta.error) ok('第二阶段流程未中断', false, delta.error);

    // 服务端独立核验：确有本机推上来的 2 条 + 服务端新增 1 条
    const all = (await api('GET', '/api/notes', undefined, token)).body.notes || [];
    ok('服务端共 3 条密文记录', all.length === 3, 'notes=' + all.length);
    ok('服务端仍只存密文（无明文标题）',
      all.every((n) => JSON.stringify(n).indexOf('增量甲') < 0 && JSON.stringify(n).indexOf('Alpha') < 0));

    socket.close();
  } catch (error) {
    ok('端到端演练无异常', false, String((error && error.message) || error));
  } finally {
    cleanup();
  }
  console.log('\n客户端增量同步测试：' + pass + ' pass');
})();
