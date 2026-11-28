'use strict';
// 安卓壳登录页回归：第一次打开必须能填 NAS 地址，填完点登录要先把地址
// 写进原生配置（SharedPreferences），再发登录请求；非法地址要当场拦下。
// 真实浏览器（CDP）+ 假原生桥，零依赖。运行：node tools/test_login_server.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STATIC = path.join(ROOT, 'static');

let pass = 0;

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
  const errText = () => (document.getElementById('lockError').textContent || '').trim();

  try {
    const block = document.getElementById('lockServerBlock');
    const shown = await waitFor(() => block && !block.hidden, 15000);
    step('壳内登录页显示 NAS 地址', shown);
    const input = document.getElementById('lockServerInput');
    info.prefilled = input.value;
    step('地址按原生配置回填', info.prefilled === 'http://old-nas:1111', info.prefilled);

    // 1) 非法地址：当场拦下，不写配置、不发请求
    input.value = 'ftp://bad host';
    document.getElementById('passphraseInput').value = 'admin';
    document.getElementById('unlockBtn').click();
    await new Promise((r) => setTimeout(r, 400));
    info.badError = errText();
    step('非法地址被拦下并提示格式', /格式/.test(info.badError), info.badError);
    step('非法地址没有写进原生配置', window.__nasSet.length === 0, JSON.stringify(window.__nasSet));

    // 2) 只填 IP:端口 + 尾斜杠 → 归一化后保存，再登录
    input.value = ' 10.0.0.20:28080/ ';
    document.getElementById('passphraseInput').value = 'admin';
    document.getElementById('unlockBtn').click();
    const saved = await waitFor(() => window.__nasSet.length > 0, 5000);
    info.saved = window.__nasSet.slice();
    step('登录前把地址写进原生配置', saved && info.saved[0] === 'https://10.0.0.20:28080', JSON.stringify(info.saved));
    info.inputAfter = input.value;
    step('输入框回填归一化后的地址', info.inputAfter === 'https://10.0.0.20:28080', info.inputAfter);

    // 3) 登录请求必须真的发到 NAS（这里由本地服务代答 401）
    const rejected = await waitFor(() => /不正确/.test(errText()), 10000);
    step('地址保存后确实发起了登录请求', rejected, errText());

    // 4) 留空则沿用上次的地址，不清空配置
    info.before = window.__nasSet.length;
    input.value = '';
    document.getElementById('unlockBtn').click();
    await new Promise((r) => setTimeout(r, 300));
    step('地址留空时沿用上次保存的值', window.__nasSet.length === info.before, JSON.stringify(window.__nasSet));
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

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.log('  SKIP 浏览器检查（未找到 Edge/Chrome）');
    console.log('\nLogin server tests: 0 pass');
    return;
  }

  const port = 19340 + Math.floor(Math.random() * 50);
  const origin = 'http://127.0.0.1:' + port;
  const apiHits = [];

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath.startsWith('/api/')) {
      apiHits.push(req.method + ' ' + urlPath);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":"账号或密码不正确"}');
      return;
    }
    const rel = urlPath === '/' ? '/index.html' : urlPath;
    const file = path.join(STATIC, rel);
    if (!file.startsWith(STATIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    let body = fs.readFileSync(file);
    if (rel === '/index.html') {
      // 模拟 APK 壳：__NN_SHELL__ + 原生桥（只实现地址读写）
      const stub = '<script>window.__NN_SHELL__=true;window.__nasSet=[];' +
        'window.NasNative={getServer:function(){return "http://old-nas:1111";},' +
        'setServer:function(v){window.__nasSet.push(v);},saveText:function(){}};</script>';
      body = Buffer.from(String(body).replace('</head>', stub + '</head>'), 'utf8');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream' });
    res.end(body);
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-login-'));
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
    if (detail.exceptionDetails) throw new Error('页面脚本异常：' + JSON.stringify(detail.exceptionDetails).slice(0, 400));
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
      console.error('  FAIL 登录页流程中断：' + info.error);
      process.exitCode = 1;
    }
    if (apiHits.indexOf('POST /api/login') < 0) {
      console.error('  FAIL 服务端没收到登录请求：' + JSON.stringify(apiHits));
      process.exitCode = 1;
    }
    socket.close();
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error('  FAIL 登录页回归：' + (error && error.message ? error.message : error));
  process.exitCode = 1;
}).finally(() => {
  console.log('\nLogin server tests: ' + pass + ' pass');
});
