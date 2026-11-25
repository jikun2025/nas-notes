'use strict';
// 富文本编辑器回归：静态结构 + HTML→Markdown 往返稳定性（真实浏览器执行）。
// 零依赖：只用 node 内置 http/fs/child_process，浏览器用系统自带 Edge/Chrome 的 headless dump-dom。
// 运行：node tools/test_rich_editor.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
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
  assert.match(sw, /const CACHE = 'nas-notes-v20'/);
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

function unescapeHtml(text) {
  return String(text)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function runRoundtrip() {
  return new Promise((resolve) => {
    const browser = findBrowser();
    if (!browser) {
      console.log('  SKIP 浏览器往返（未找到 Edge/Chrome，可手工打开 tools/rich-fixture.html）');
      resolve();
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
    server.listen(port, '127.0.0.1', () => {
      const url = 'http://127.0.0.1:' + port + '/tools/rich-fixture.html';
      // 必须异步：spawnSync 会阻塞事件循环，本地 http server 就响应不了这次请求
      execFile(browser, ['--headless=new', '--disable-gpu', '--no-first-run',
        '--virtual-time-budget=8000', '--dump-dom', url],
      { encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
        server.close();
        const out = String(stdout || '');
        const match = /<pre id="result">([\s\S]*?)<\/pre>/.exec(out);
        if (!match) {
          console.error('  FAIL 浏览器往返：未取到结果' + (error ? '（' + error.message + '）' : ''));
          console.error('  ' + out.slice(0, 400));
          process.exitCode = 1;
          resolve();
          return;
        }
        let report;
        try { report = JSON.parse(unescapeHtml(match[1])); }
        catch (err) {
          console.error('  FAIL 浏览器往返：结果不是合法 JSON');
          process.exitCode = 1;
          resolve();
          return;
        }
        if (report.failed) {
          console.error('  FAIL HTML→Markdown 往返：' + report.failed + '/' + report.total + ' 项不稳定');
          report.failures.forEach((item) => {
            console.error('    - ' + item.name + (item.error ? '（' + item.error + '）' : ''));
            if (!item.error) {
              console.error('      md: ' + JSON.stringify(item.md2));
              console.error('      before: ' + item.html1);
              console.error('      after : ' + item.html2);
            }
          });
          process.exitCode = 1;
          resolve();
          return;
        }
        pass += 1;
        console.log('  PASS HTML→Markdown 往返稳定（' + report.total + ' 个用例）');
        resolve();
      });
    });
  });
}

runRoundtrip();

process.on('exit', () => {
  console.log('\nRich editor tests: ' + pass + ' pass');
});
