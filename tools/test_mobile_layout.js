'use strict';
// 手机端布局回归：分类栏是可收起的抽屉、顶部为系统状态栏让位。
// 静态断言 + 真实浏览器（CDP，390×844 手机视口）跑完整流程并截图。
// 零依赖（Node 内置 http/child_process/WebSocket）。运行：node tools/test_mobile_layout.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const STATIC = path.join(ROOT, 'static');
const SHOT_DIR = path.join(ROOT, '.tmp');
const read = (name) => fs.readFileSync(path.join(STATIC, name), 'utf8');
const html = read('index.html');
const css = read('style.css');
const app = read('app.js');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (error) { console.error('  FAIL ' + name + ': ' + error.message); process.exitCode = 1; }
}

// ---------- 静态：抽屉与安全区都接上了 ----------
ok('窄屏侧栏是抽屉：☰ 打开，×/遮罩收起', () => {
  assert.match(html, /id="railToggleBtn"/);
  assert.match(html, /id="railCloseBtn"/);
  assert.match(html, /id="railScrim"/);
  assert.match(app, /function railIsDrawer\(\)/);
  assert.match(app, /classList\.toggle\('rail-open'/);
  const narrow = css.slice(css.indexOf('@media (max-width: 1180px)'), css.indexOf('@media (max-width: 860px)'));
  assert.match(narrow, /transform:\s*translateX\(-100%\)/);
  assert.match(narrow, /body\.rail-open \.sidebar\s*\{[^}]*translateX\(0\)/);
});

ok('手机不再用下拉替代分类（分类在抽屉里）', () => {
  const mobile = css.slice(css.indexOf('@media (max-width: 760px)'));
  assert.match(mobile, /\.filter-row\s*\{\s*display:\s*none/);
});

ok('安全区变量来自原生 insets，浏览器退化为 env()', () => {
  assert.match(css, /--safe-top:\s*var\(--nn-safe-top,\s*env\(safe-area-inset-top/);
  assert.match(html, /viewport-fit=cover/);
});

// 线上事故回归（v3.2.1）：弹窗只要带 open 就必须落在 fixed 层
ok('弹窗只要 open 就必须是 fixed 层（防「掉到页面底部」）', () => {
  // 事故形态：open 属性在、.dialog-fallback 缺失 → UA 的 absolute 定位把面板
  // 排到正文后面，要滚到底才看得见，遮罩也不出现。
  assert.match(css, /dialog\[open\]\s*\{[^}]*position:\s*fixed/);
  // openDialog 不能因为「已经 open」就提前返回，否则类永远不会补上
  assert.doesNotMatch(app, /if \(dialog\.open\) return true;/);
  assert.match(app, /dialog\.setAttribute\('open', ''\);\s*\r?\n\s*dialog\.classList\.add\('dialog-fallback'\)/);
});

// ---------- 真实浏览器 ----------
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

const HELPERS = String.raw`
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
  const rect = (el) => el.getBoundingClientRect();
  const px = (el, prop) => parseFloat(getComputedStyle(el)[prop]) || 0;
  const visible = (el) => {
    if (!el) return false;
    const r = rect(el);
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
`;

// 阶段一：本机建库 + 建一条便签 + 模拟 28px 状态栏
const PHASE_SETUP = String.raw`(async () => {
  const info = { steps: [] };
  const step = (name, good, extra) => info.steps.push({ name, ok: !!good, extra: extra === undefined ? '' : String(extra) });
  ${HELPERS}
  try {
    const localBtn = document.getElementById('lockLocalBtn');
    await waitFor(() => localBtn && !localBtn.hidden, 8000);
    document.getElementById('passphraseInput').value = 'mobile-pass-123';
    localBtn.click();
    const unlocked = await waitFor(() => document.getElementById('lockScreen').hidden === true, 25000);
    step('本机建库并进入列表', unlocked, document.getElementById('lockError').textContent);
    if (!unlocked) throw new Error('建库失败');

    // 造两条便签，让列表有内容可看
    for (const title of ['手机布局测试', '第二条便签']) {
      document.getElementById('newBtn').click();
      await waitFor(() => document.getElementById('deleteBtn').hidden === false, 6000);
      const input = document.getElementById('titleInput');
      input.value = title;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const rich = document.getElementById('richEditor');
      rich.innerHTML = '<p>这是手机端排版检查用的正文。</p>';
      rich.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      document.getElementById('backBtn').click();
      await new Promise((r) => setTimeout(r, 250));
    }
    info.noteItems = document.querySelectorAll('#noteList .note-item').length;
    step('列表渲染出便签', info.noteItems >= 1, 'items=' + info.noteItems);

    // 模拟原生注入的安全区（真机由 MainActivity 写入同样的变量）
    document.documentElement.style.setProperty('--nn-safe-top', '28px');
    document.documentElement.style.setProperty('--nn-safe-bottom', '16px');
    await new Promise((r) => setTimeout(r, 80));

    info.innerWidth = window.innerWidth;
    info.innerHeight = window.innerHeight;
    const toggle = document.getElementById('railToggleBtn');
    const rail = document.getElementById('sidebar');
    info.toggleDisplay = getComputedStyle(toggle).display;
    step('窄屏露出 ☰ 按钮', visible(toggle) && info.innerWidth <= 760, 'w=' + info.innerWidth);
    step('抽屉默认收起在屏幕外', rect(rail).right <= 1, 'right=' + Math.round(rect(rail).right));
    step('列表顶部为状态栏让位', px(document.querySelector('.note-pane-head'), 'paddingTop') >= 28,
      'paddingTop=' + px(document.querySelector('.note-pane-head'), 'paddingTop'));
    step('列表底部为手势条让位', px(document.querySelector('.note-list'), 'paddingBottom') >= 16,
      'paddingBottom=' + px(document.querySelector('.note-list'), 'paddingBottom'));
    info.headTop = Math.round(rect(document.querySelector('.note-pane-head')).top);
    info.firstItemTop = Math.round(rect(document.getElementById('newBtn')).top);
    step('顶部控件整体下移，不被状态栏压住', info.firstItemTop >= 28, 'newBtn.top=' + info.firstItemTop);
    return JSON.stringify(info);
  } catch (error) {
    info.error = String(error && error.message);
    return JSON.stringify(info);
  }
})()`;

// 阶段二：打开抽屉
const PHASE_RAIL = String.raw`(async () => {
  const info = { steps: [] };
  const step = (name, good, extra) => info.steps.push({ name, ok: !!good, extra: extra === undefined ? '' : String(extra) });
  ${HELPERS}
  try {
    // 上一步的 toast 会盖住抽屉底部按钮，等它自己消失再截图
    await waitFor(() => !document.getElementById('toast') || document.getElementById('toast').hidden === true, 5000);
    document.getElementById('railToggleBtn').click();
    await new Promise((r) => setTimeout(r, 340));
    const rail = document.getElementById('sidebar');
    const scrim = document.getElementById('railScrim');
    info.open = document.body.classList.contains('rail-open');
    info.railLeft = Math.round(rect(rail).left);
    info.railWidth = Math.round(rect(rail).width);
    info.railTop = Math.round(rect(rail).top);
    info.scrimOpacity = parseFloat(getComputedStyle(scrim).opacity);
    step('点 ☰ 抽屉滑出到屏内', info.open && info.railLeft >= 0, 'left=' + info.railLeft);
    step('抽屉宽度占屏约七成', info.railWidth > 200 && info.railWidth < window.innerWidth, 'w=' + info.railWidth);
    step('抽屉从屏幕顶端开始（含状态栏区）', info.railTop === 0, 'top=' + info.railTop);
    step('遮罩显示', info.scrimOpacity > 0.5, 'opacity=' + info.scrimOpacity);
    info.footVisible = ['syncBtn', 'lockBtn', 'settingsBtn'].every((id) => {
      const btn = document.getElementById(id);
      const r = rect(btn);
      return visible(btn) && r.bottom <= window.innerHeight + 1 && r.bottom > 0;
    });
    step('抽屉底部同步/锁定/设置三个入口可点', info.footVisible);
    info.railItems = Array.from(document.querySelectorAll('#folderRail .rail-item'))
      .map((el) => el.querySelector('.rail-name').textContent.trim());
    step('抽屉里有分类项', info.railItems.length >= 1, info.railItems.join('/'));
    return JSON.stringify(info);
  } catch (error) {
    info.error = String(error && error.message);
    return JSON.stringify(info);
  }
})()`;

// 阶段三：点分类自动收起 → 进编辑页检查顶部
const PHASE_EDIT = String.raw`(async () => {
  const info = { steps: [] };
  const step = (name, good, extra) => info.steps.push({ name, ok: !!good, extra: extra === undefined ? '' : String(extra) });
  ${HELPERS}
  try {
    const item = document.querySelector('#folderRail .rail-item');
    if (item) item.click();
    await new Promise((r) => setTimeout(r, 340));
    info.closedAfterPick = !document.body.classList.contains('rail-open');
    step('选完分类抽屉自动收起', info.closedAfterPick);

    document.getElementById('railToggleBtn').click();
    await new Promise((r) => setTimeout(r, 340));
    document.getElementById('railScrim').click();
    await new Promise((r) => setTimeout(r, 340));
    step('点遮罩也能收起', !document.body.classList.contains('rail-open'));

    document.querySelector('#noteList .note-item').click();
    await new Promise((r) => setTimeout(r, 420));
    const editor = document.getElementById('editor');
    const head = document.querySelector('.editor-head');
    info.editorShown = visible(editor);
    info.headPaddingTop = px(head, 'paddingTop');
    info.headTop = Math.round(rect(head).top);
    info.backTop = Math.round(rect(document.getElementById('backBtn')).top);
    step('进入编辑视图', info.editorShown);
    step('编辑区顶部为状态栏让位', info.headPaddingTop >= 28 && info.backTop >= 28,
      'paddingTop=' + info.headPaddingTop + ' backTop=' + info.backTop);
    info.viewButtons = Array.from(document.querySelectorAll('.view-switch button'))
      .filter((b) => visible(b)).length;
    step('视图切换按钮全部可见', info.viewButtons === 4, 'count=' + info.viewButtons);

    // 长正文：把内容撑长后往下滑，标题与工具栏必须还钉在顶部
    const rich = document.getElementById('richEditor');
    rich.innerHTML = Array.from({ length: 60 }, (_, i) =>
      '<p>第 ' + (i + 1) + ' 行正文，用来把编辑区撑长，检查固定条是否跟着滚走。</p>').join('');
    rich.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const scroll = document.getElementById('editorScroll');
    scroll.scrollTop = 900;
    await new Promise((r) => setTimeout(r, 250));
    const bar = document.getElementById('editorBar');
    const barRect = rect(bar);
    const headRect = rect(document.querySelector('.editor-head'));
    const toolbarRect = rect(document.getElementById('mdToolbar'));
    info.scrollTop = Math.round(scroll.scrollTop);
    step('正文确实滚动了', info.scrollTop > 100, 'scrollTop=' + info.scrollTop);
    step('下滑后标题/工具栏仍钉在编辑头下方',
      Math.abs(barRect.top - headRect.bottom) < 2 && barRect.bottom <= window.innerHeight,
      'barTop=' + Math.round(barRect.top) + ' headBottom=' + Math.round(headRect.bottom));
    step('工具栏整体在视口内，随时可点',
      toolbarRect.top >= headRect.bottom - 1 && toolbarRect.bottom < window.innerHeight,
      'toolbar=' + Math.round(toolbarRect.top) + '~' + Math.round(toolbarRect.bottom));
    step('固定条出现"钉住"投影', bar.classList.contains('is-stuck'));
    return JSON.stringify(info);
  } catch (error) {
    info.error = String(error && error.message);
    return JSON.stringify(info);
  }
})()`;

// 阶段四：设置里最长的面板要能滚，底部保存条不能被挤出屏幕
const PHASE_SETTINGS = String.raw`(async () => {
  const info = { steps: [] };
  const step = (name, good, extra) => info.steps.push({ name, ok: !!good, extra: extra === undefined ? '' : String(extra) });
  ${HELPERS}
  try {
    document.getElementById('railToggleBtn').click();
    await new Promise((r) => setTimeout(r, 340));
    document.getElementById('settingsBtn').click();
    const dlg = document.getElementById('settingsDialog');
    await waitFor(() => dlg && (dlg.open || dlg.hasAttribute('open')), 6000);
    await new Promise((r) => setTimeout(r, 260));
    document.querySelector('[data-settings-panel="sync"]').click();
    await new Promise((r) => setTimeout(r, 260));

    const body = dlg.querySelector('.settings-body');
    const foot = dlg.querySelector('.settings-foot');
    const dlgRect = rect(dlg);
    info.viewport = window.innerHeight;
    info.dialogTop = Math.round(dlgRect.top);
    info.dialogBottom = Math.round(dlgRect.bottom);
    step('设置对话框完整落在屏幕内', dlgRect.top >= -1 && dlgRect.bottom <= window.innerHeight + 1,
      'top=' + info.dialogTop + ' bottom=' + info.dialogBottom + ' vh=' + info.viewport);
    step('内容区可滚动（同步面板比屏幕长）', body.scrollHeight > body.clientHeight + 20,
      'scrollH=' + body.scrollHeight + ' clientH=' + body.clientHeight);
    step('底部保存按钮始终在视口内', rect(foot).height > 0 && rect(foot).bottom <= window.innerHeight + 1,
      'footBottom=' + Math.round(rect(foot).bottom));

    body.scrollTop = body.scrollHeight;
    await new Promise((r) => setTimeout(r, 260));
    info.scrolled = Math.round(body.scrollTop);
    const panel = document.querySelector('.settings-panel[data-panel="sync"]');
    const lastRow = panel.lastElementChild;
    step('能滚到底看到面板最后一行',
      rect(lastRow).bottom <= rect(body).bottom + 2, 'lastBottom=' + Math.round(rect(lastRow).bottom) + ' bodyBottom=' + Math.round(rect(body).bottom));
    step('滚到底后保存按钮没被顶走', rect(foot).bottom <= window.innerHeight + 1);

    // ---- 上架审核回归（华为报「设置里取消/保存无响应，关不掉弹窗」）----
    // 根因是 ArkWeb 把 <dialog> 放进 top layer 后按钮命中测试失效。现在弹窗
    // 一律走「open 属性 + 普通 fixed 层」，这里逐条钉住：不进模态层、按钮在最上层、
    // 取消/保存/× 三个出口都能关掉。
    step('弹窗不进浏览器模态层（不用 showModal）', dlg.matches(':modal') === false,
      'modal=' + dlg.matches(':modal'));

    const probeHit = (id) => {
      const el = document.getElementById(id);
      const r = rect(el);
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return { el, hit, ok: Boolean(hit && (hit === el || el.contains(hit))) };
    };
    const hitCancel = probeHit('cancelSettings');
    step('「取消」按钮处在命中测试最上层', hitCancel.ok,
      'hit=' + (hitCancel.hit ? (hitCancel.hit.id || hitCancel.hit.className || hitCancel.hit.tagName) : 'null'));
    hitCancel.el.click();
    await new Promise((r) => setTimeout(r, 320));
    info.closedByCancel = !dlg.hasAttribute('open') && !document.body.classList.contains('dialog-open');
    step('点「取消」能关掉设置弹窗', info.closedByCancel);

    // 重新打开，换「保存设置」这条出口
    document.getElementById('settingsBtn').click();
    await waitFor(() => dlg.hasAttribute('open'), 5000);
    await new Promise((r) => setTimeout(r, 220));
    const hitSave = probeHit('saveSettings');
    step('「保存设置」按钮处在命中测试最上层', hitSave.ok);
    hitSave.el.click();
    await new Promise((r) => setTimeout(r, 320));
    step('点「保存设置」也能关掉设置弹窗', !dlg.hasAttribute('open'));

    // 第三条出口：右上角 ×
    document.getElementById('settingsBtn').click();
    await waitFor(() => dlg.hasAttribute('open'), 5000);
    await new Promise((r) => setTimeout(r, 220));
    probeHit('settingsClose').el.click();
    await new Promise((r) => setTimeout(r, 320));
    step('点「×」也能关掉设置弹窗', !dlg.hasAttribute('open'));
    return JSON.stringify(info);
  } catch (error) {
    info.error = String(error && error.message);
    return JSON.stringify(info);
  }
})()`;

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

(async () => {
  const browser = findBrowser();
  if (!browser) {
    console.log('\n跳过真实浏览器部分：未找到 Edge/Chrome');
    console.log('\nMobile layout tests: ' + pass + ' pass');
    return;
  }

  const port = 18871;
  const origin = 'http://127.0.0.1:' + port;
  const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    if (urlPath.startsWith('/api/')) {
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
      // 模拟壳环境（同步默认手动，避免测试里发 /api 请求）
      const probe = '<script>window.__NN_SHELL__=true;</script>';
      body = Buffer.from(String(body).replace('</head>', probe + '</head>'), 'utf8');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-mobile-'));
  const debugPort = port + 100;
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + profile,
    '--window-size=390,844',
    origin + '/'
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try {
      // Windows 上 child.kill() 只杀父进程，headless 浏览器会把子进程留在后台并占着端口，
      // 下一次跑测试就会连到旧实例（连带旧 profile 的 IndexedDB）。用 taskkill /T 清整棵树。
      if (process.platform === 'win32') {
        require('child_process').spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill();
      }
    } catch (error) { /* ignore */ }
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
        target = pages.find((item) => String(item.url || '').indexOf(origin) === 0) || null;
        if (target) break;
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

    // 手机视口（390×844，DPR 3）+ 触摸模拟
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
      screenOrientation: { angle: 0, type: 'portraitPrimary' }
    });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Page.setBypassServiceWorker', { bypass: true });
    await send('Page.reload', { ignoreCache: true });

    let stable = 0;
    for (let i = 0; i < 120; i += 1) {
      const state = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      const value = state.result && state.result.result && state.result.result.value;
      if (value === 'complete') stable += 1; else stable = 0;
      if (stable >= 2) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    const run = async (expression, label) => {
      const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      const detail = reply.result || {};
      if (detail.exceptionDetails) {
        throw new Error(label + ' 脚本异常：' + JSON.stringify(detail.exceptionDetails).slice(0, 300));
      }
      const raw = detail.result && detail.result.value;
      if (!raw) throw new Error(label + ' 没有返回结果');
      const info = JSON.parse(raw);
      (info.steps || []).forEach((item) => {
        if (item.ok) { pass += 1; console.log('  PASS ' + item.name); }
        else {
          console.error('  FAIL ' + item.name + (item.extra ? '（' + item.extra + '）' : ''));
          process.exitCode = 1;
        }
      });
      if (info.error) {
        console.error('  FAIL ' + label + ' 执行失败：' + info.error);
        process.exitCode = 1;
      }
      return info;
    };

    const shot = async (name) => {
      const reply = await send('Page.captureScreenshot', { format: 'png' });
      const data = reply.result && reply.result.data;
      if (!data) return '';
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const file = path.join(SHOT_DIR, name);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    };

    const setup = await run(PHASE_SETUP, '列表阶段');
    console.log('  列表截图：' + await shot('mobile-list.png'));
    const rail = await run(PHASE_RAIL, '抽屉阶段');
    console.log('  抽屉截图：' + await shot('mobile-rail.png'));
    const edit = await run(PHASE_EDIT, '编辑阶段');
    console.log('  编辑截图：' + await shot('mobile-editor.png'));
    const settings = await run(PHASE_SETTINGS, '设置阶段');
    console.log('  设置截图：' + await shot('mobile-settings.png'));

    if (setup.noteItems < 1) process.exitCode = 1;
    if (!rail.open) process.exitCode = 1;
    if (!edit.editorShown) process.exitCode = 1;
    if (!(settings.scrolled > 20)) process.exitCode = 1;
  } finally {
    cleanup();
  }

  console.log('\nMobile layout tests: ' + pass + ' pass');
  // taskkill 是异步子进程，加上 http 服务的 keep-alive 句柄，事件循环可能一直不空，
  // 断言已经跑完却挂在收尾阶段。跑完就明确退出，不留给句柄决定。
  setTimeout(() => process.exit(process.exitCode || 0), 300);
})();
