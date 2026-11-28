'use strict';
// 富文本编辑器回归：静态结构 + HTML→Markdown 往返稳定性（真实浏览器执行）。
// 零依赖：只用 node 内置 http/fs/child_process，浏览器用系统自带 Edge/Chrome（CDP 取结果）。
// 运行：node tools/test_rich_editor.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, 'static', name), 'utf8');
const html = read('index.html');
const css = read('style.css');
const app = read('app.js');
const sw = read('sw.js');
const html2md = read('html2md.js');
const mdjs = read('md.js');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (error) { console.error('  FAIL ' + name + ': ' + error.message); process.exitCode = 1; }
}

// ---------- 静态结构 ----------
ok('富文本编辑区存在并默认展示', () => {
  assert.match(html, /<div class="rich-pane" id="richPane">/);
  assert.match(html, /id="richEditor" class="md-preview rich-editor" contenteditable="true"/);
  assert.match(css, /body:not\(\.view-rich\) \.rich-pane\s*\{\s*display:\s*none/);
  assert.match(css, /body\.view-rich \.writing-pane\s*\{\s*display:\s*none/);
});

ok('四种视图：富文本 / 源码 / 分栏 / 预览', () => {
  ['rich', 'source', 'split', 'view'].forEach((view) => {
    assert.match(html, new RegExp('data-view="' + view + '"'));
  });
  assert.match(app, /const VIEW_MODES = \['rich', 'source', 'split', 'view'\]/);
  assert.match(app, /function isRichMode\(\)/);
  assert.match(app, /function isSourceMode\(\)/);
});

ok('默认视图迁移到富文本（老 edit/split 一次性迁移）', () => {
  assert.match(app, /nn-view-v2/);
  assert.match(app, /const legacyMap = \{ edit: 'source', split: 'rich' \}/);
  assert.match(app, /localStorage\.getItem\('nn-default-view'\) \|\| 'rich'/);
});

ok('工具栏在富文本下改 DOM，不插入 Markdown 符号', () => {
  assert.match(app, /function handleRichAction\(kind\)/);
  assert.match(app, /if \(isRichMode\(\)\) \{ handleRichAction\(kind\); syncHeadingSelect\(\); return; \}/);
  // 加粗走 execCommand，而不是 applyAround('**','**')
  const block = app.slice(app.indexOf('function handleRichAction'), app.indexOf('function richKeydown'));
  assert.match(block, /richExec\('bold'\)/);
  assert.doesNotMatch(block, /applyAround/);
  // 点工具栏时不能丢失 contenteditable 的选区
  assert.match(app, /els\.mdToolbar\.addEventListener\('mousedown'/);
});

ok('富文本内容序列化回 Markdown 后走原有加密保存', () => {
  assert.match(html, /<script src="\/html2md\.js"><\/script>/);
  assert.match(app, /function richMarkdown\(\)/);
  assert.match(app, /NN_HTML2MD\.fromNode\(els\.richEditor\)/);
  assert.match(app, /function flushRich\(\)/);
  assert.match(app, /plain\.body = currentBodyMd\(\);/);
  assert.match(app, /els\.richEditor\.addEventListener\('input'/);
});

ok('粘贴只接受纯文本，避免外部 HTML 污染便签', () => {
  assert.match(app, /els\.richEditor\.addEventListener\('paste'/);
  assert.match(app, /getData\('text\/plain'\)/);
  assert.match(app, /event\.preventDefault\(\);\s*\n\s*const data = event\.clipboardData/);
});

ok('表格在富文本里直接操作 DOM 行列', () => {
  assert.match(app, /function insertTableRich\(cols = 3, rows = 2\)/);
  assert.match(app, /function richTableOp\(op\)/);
  assert.match(app, /case 'row-add': case 'row-del': case 'col-add': case 'col-del': richTableOp\(kind\); break;/);
});

ok('源码单栏自动增高，去掉盒中盒滚动', () => {
  assert.match(app, /function autoGrowBody\(\)/);
  assert.match(css, /body\.view-source \.body-input\s*\{\s*overflow:\s*hidden/);
});

ok('图片渲染带 data-att，才能往返成占位符', () => {
  assert.match(mdjs, /data-att=/);
  assert.match(html2md, /!\[\[att:' \+ att \+ '\]\]/);
});

ok('Service Worker 缓存已升版并纳入 html2md.js', () => {
  const cachedVer = Number((/const CACHE = 'nas-notes-v(\d+)'/.exec(sw) || [0, '0'])[1]);
  assert.ok(cachedVer >= 25, 'CACHE 版本需 >= 25，当前 ' + cachedVer);
  assert.match(sw, /'\/html2md\.js'/);
});

// ---------- 浏览器往返测试 ----------
function findBrowser() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
  ];
  return candidates.find((file) => { try { return fs.existsSync(file); } catch (e) { return false; } }) || '';
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    }).on('error', reject);
  });
}

// 浏览器往返：用 CDP 读 fixture 算出的结果。
// 不用 --dump-dom：新版 Edge 在 headless 下不再把 DOM 写到 stdout（本机实测恒为空输出），
// 会让这个用例永久失败。CDP 与 test_offline_mode / test_mobile_layout / test_shell_page 同一条通道。
async function runRoundtrip() {
  const browser = findBrowser();
  if (!browser) {
    console.log('  SKIP 浏览器往返（未找到 Edge/Chrome，可手工打开 tools/rich-fixture.html）');
    return;
  }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  const port = 19000 + Math.floor(Math.random() * 200);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const dbg = 19320 + Math.floor(Math.random() * 60);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-rich-'));
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=' + dbg, '--user-data-dir=' + profile,
    'http://127.0.0.1:' + port + '/tools/rich-fixture.html'], { stdio: 'ignore' });
  const cleanup = () => {
    try {
      // Windows 上 child.kill() 只杀父进程，浏览器子进程会继续占着调试端口，
      // 下次运行可能连到旧实例，故整棵树清掉。
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill();
      }
    } catch (error) { /* ignore */ }
    try { server.close(); } catch (error) { /* ignore */ }
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (error) { /* ignore */ } }, 300);
  };
  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 80 && !target; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        const list = await httpJson('http://127.0.0.1:' + dbg + '/json/list');
        const pages = (list || []).filter((item) => item.type === 'page' && item.webSocketDebuggerUrl);
        target = pages.find((item) => String(item.url || '').indexOf('rich-fixture.html') >= 0) || pages[0] || null;
      } catch (error) { /* 浏览器还没起来，继续等 */ }
    }
    if (!target) throw new Error('CDP 目标未就绪');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')));
    });
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (error) { return; }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    });
    const send = (method, params) => new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });

    // fixture 跑完把结果写进 #result（初始值 PENDING），轮询到不再是 PENDING 为止。
    let raw = '';
    for (let i = 0; i < 75; i += 1) {
      const out = await send('Runtime.evaluate', {
        expression: "(document.getElementById('result') || {}).textContent || ''",
        returnByValue: true
      });
      raw = String((out.result && out.result.result && out.result.result.value) || '');
      if (raw && raw !== 'PENDING') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!raw || raw === 'PENDING') {
      console.error('  FAIL 浏览器往返：未取到结果（fixture 没有写回 #result）');
      process.exitCode = 1;
      return;
    }
    let report;
    try {
      report = JSON.parse(raw);
    } catch (error) {
      console.error('  FAIL 浏览器往返：结果不是合法 JSON');
      console.error('  ' + raw.slice(0, 400));
      process.exitCode = 1;
      return;
    }
    if (report.failed) {
      console.error('  FAIL HTML→Markdown 往返：' + report.failed + '/' + report.total + ' 项不稳定');
      (report.failures || []).forEach((item) => {
        console.error('    - ' + item.name + (item.error ? '（' + item.error + '）' : ''));
        if (!item.error) {
          console.error('      md: ' + JSON.stringify(item.md2));
          console.error('      before: ' + item.html1);
          console.error('      after : ' + item.html2);
        }
      });
      process.exitCode = 1;
      return;
    }
    pass += 1;
    console.log('  PASS HTML→Markdown 往返稳定（' + report.total + ' 个用例）');
  } catch (error) {
    console.error('  FAIL 浏览器往返：' + (error && error.message ? error.message : error));
    process.exitCode = 1;
  } finally {
    try { if (ws) ws.close(); } catch (error) { /* ignore */ }
    cleanup();
  }
}

runRoundtrip().finally(() => {
  console.log('\nRich editor tests: ' + pass + ' pass');
  // taskkill 子进程与 http 句柄会让事件循环不空，断言跑完就明确退出。
  setTimeout(() => process.exit(process.exitCode || 0), 300);
});
