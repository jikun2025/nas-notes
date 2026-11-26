'use strict';
// 安卓壳页面回归：按 MainActivity.buildInlinePage 的规则把 static/ 内联成一个 HTML，
// 在真实浏览器里跑一遍，确认「不会白屏」「原生桥劫持生效」。
// 零依赖；找不到 Edge/Chrome 时自动跳过。运行：node tools/test_shell_page.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STATIC = path.join(ROOT, 'static');
const readFile = (p) => fs.readFileSync(p, 'utf8');
const esc = (code) => code.replace(/<\/script/g, '<\\/script').replace(/<!--/g, '<\\!--');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { console.error('  FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

function buildInlinePage(origin) {
  let html = readFile(path.join(STATIC, 'index.html'));
  // 与 Java 相同：函数式拼接（替换串里的 $& 会被 String.replace 当成特殊模式）
  html = html.replace('<link rel="stylesheet" href="/style.css">',
    () => '<style>' + readFile(path.join(STATIC, 'style.css')) + '</style>');
  for (const js of ['cryptofb.js', 'md.js', 'html2md.js', 'app.js']) {
    html = html.replace('<script src="/' + js + '"></script>',
      () => '<script>' + esc(readFile(path.join(STATIC, js))) + '</script>');
  }
  let bridge = readFile(path.join(ROOT, 'android/app/src/main/assets/_bridge.js'));
  // 测试页 origin 是本机 http 服务，把虚拟域常量替成本机才能触发桥接分支
  if (origin) bridge = bridge.split('https://appassets.androidplatform.net').join(origin);
  html = html.replace('</head>',
    () => '<script>window.__NN_SHELL__=true;</script>\n<script>' + esc(bridge) + '</script>\n</head>');
  return html;
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
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

function unescapeHtml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

const browser = findBrowser();
if (!browser) {
  console.log('  SKIP 浏览器检查（未找到 Edge/Chrome）');
  console.log('\nShell page tests: 0 pass');
  process.exit(0);
}

const port = 19120 + Math.floor(Math.random() * 60);
const origin = 'http://127.0.0.1:' + port;

const FAKE_NATIVE = `<script>
  window.__calls = [];
  window.__serverSet = [];
  window.NasNative = {
    getServer: function () { return 'http://127.0.0.1:1'; },
    setServer: function (v) { window.__serverSet.push(v); },
    apiAsync: function (cb, method, p) {
      window.__calls.push(method + ' ' + p);
      setTimeout(function () { window[cb](200, '{"content-type":"application/json"}', '{"ok":true}'); }, 0);
    },
    saveText: function () {}
  };
</script>`;

const PROBE = `<script>
  window.addEventListener('load', function () {
    var box = document.createElement('pre');
    box.id = 'diag';
    var info = {
      shell: window.__NN_SHELL__ === true,
      bridge: window.__NnBridge === true,
      lock: !!document.getElementById('lockScreen'),
      title: (document.getElementById('lockTitle') || {}).textContent || '',
      inputs: document.querySelectorAll('#lockScreen input').length,
      styles: document.styleSheets.length,
      textLen: document.body.innerText.replace(/\\s+/g, '').length
    };
    fetch('/api/health').then(function (r) { return r.text().then(function (t) {
      info.bridgeStatus = r.status;
      info.bridgeBody = t.slice(0, 40);
      info.calls = window.__calls;
      box.textContent = JSON.stringify(info);
      document.body.appendChild(box);
    }); }).catch(function (e) {
      info.bridgeError = String(e && e.message);
      info.calls = window.__calls;
      box.textContent = JSON.stringify(info);
      document.body.appendChild(box);
    });
  });
</script>`;

let page = buildInlinePage(origin);
page = page.replace('<script>window.__NN_SHELL__=true;</script>',
  () => FAKE_NATIVE + '<script>window.__NN_SHELL__=true;</script>');
page = page.replace('</body>', () => PROBE + '</body>');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
});

server.listen(port, '127.0.0.1', () => {
  execFile(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--virtual-time-budget=6000', '--dump-dom', origin + '/'],
    { encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024 },
    (error, stdout) => {
      server.close();
      const out = String(stdout || '');
      // 只看 DOM 里真正渲染出来的 <pre id="diag">，别匹配到脚本源码里的 'DIAG=' 字面量
      const match = /<pre id="diag"[^>]*>([\s\S]*?)<\/pre>/.exec(out);
      if (!match) {
        console.error('  FAIL 内联页没有跑起来：未拿到探针结果（页面可能白屏）');
        console.error('    DOM 长度 ' + out.length + '，前 300 字符：' + out.slice(0, 300));
        process.exitCode = 1;
        return;
      }
      let info;
      try { info = JSON.parse(unescapeHtml(match[1])); }
      catch (e) { console.error('  FAIL 探针结果不是合法 JSON：' + match[1].slice(0, 200)); process.exitCode = 1; return; }

      ok('内联页渲染出登录界面，而不是空白', () => {
        if (!info.lock) throw new Error('缺少 #lockScreen');
        if (!(info.textLen > 40)) throw new Error('正文过短 textLen=' + info.textLen);
        if (!/轻签/.test(info.title)) throw new Error('标题异常：' + info.title);
        if (info.inputs < 2) throw new Error('登录输入框数量异常：' + info.inputs);
        if (info.styles < 1) throw new Error('样式表未生效');
      });
      ok('壳标记与原生桥都已就位', () => {
        if (!info.shell) throw new Error('__NN_SHELL__ 未置位');
        if (!info.bridge) throw new Error('__NnBridge 未置位');
      });
      ok('fetch(/api/*) 被桥接转发，且响应头能正确解析', () => {
        if (info.bridgeError) throw new Error('桥接调用失败：' + info.bridgeError);
        if (info.bridgeStatus !== 200) throw new Error('状态码异常：' + info.bridgeStatus);
        if (!/ok/.test(info.bridgeBody || '')) throw new Error('响应体异常：' + info.bridgeBody);
        if (!Array.isArray(info.calls) || info.calls.indexOf('GET /api/health') < 0) {
          throw new Error('原生桥没有被调用：' + JSON.stringify(info.calls));
        }
      });
      console.log('\nShell page tests: ' + pass + ' pass');
    });
});
