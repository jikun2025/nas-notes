'use strict';
// 登录页 UI 回归：隐藏字段必须真的不显示；清库入口必须显著警示且需手动确认。
// 纯静态检查，零依赖。运行：node tools/test_login_ui.js

const fs = require('fs');
const path = require('path');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, 'static', name), 'utf8');
const html = read('index.html');
const css = read('style.css');
const app = read('app.js');
const sw = read('sw.js');
const server = fs.readFileSync(path.join(ROOT, 'server.py'), 'utf8');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { console.error('  FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

ok('确认密码标签与输入框默认 hidden', () => {
  assert.match(html, /id="confirmLabel"[^>]*\shidden/);
  assert.match(html, /id="confirmInput"[^>]*\shidden/);
});

ok('锁屏区 [hidden] 不被 label{display:block} 覆盖', () => {
  assert.match(css, /\.lock-card \[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

ok('清库面板默认隐藏', () => {
  assert.match(html, /id="resetPanel"[^>]*\shidden/);
});

ok('清库警示写明删除全部数据且账号密码不变', () => {
  const panel = html.slice(html.indexOf('id="resetPanel"'), html.indexOf('id="resetPanel"') + 900);
  assert.match(panel, /全部便签、图片和录音/);
  assert.match(panel, /账户名和密码不会改变/);
});

ok('清库需手动输入「清空数据」', () => {
  const block = app.slice(app.indexOf("els.resetVaultConfirmBtn.addEventListener"), app.indexOf('// 设置内自助改账户名'));
  assert.match(block, /!== '清空数据'/);
  assert.doesNotMatch(block, /window\.confirm|\bconfirm\(/);
});

ok('服务端清库只删 vault 与 notes，不动 accounts', () => {
  const block = server.slice(server.indexOf('if path == "/api/vault"'), server.indexOf('if path == "/api/vault"') + 800);
  assert.match(block, /DELETE FROM meta WHERE key = 'vault'/);
  assert.match(block, /DELETE FROM notes/);
  assert.doesNotMatch(block, /DELETE FROM accounts/);
});

ok('Service Worker 缓存已升版', () => {
  const cached = Number((/const CACHE = 'nas-notes-v(\d+)'/.exec(sw) || [0, '0'])[1]);
  assert.ok(cached >= 22, 'CACHE 版本需 >= 22，当前 ' + cached);
});

ok('登录页有 NAS 地址框且默认隐藏（仅安卓壳显示）', () => {
  assert.match(html, /id="lockServerBlock"[^>]*\shidden/);
  assert.match(html, /id="lockServerInput"/);
  assert.match(app, /els\.lockServerBlock\.hidden = !api/);
});

ok('登录前先把 NAS 地址写进原生配置，再发登录请求', () => {
  const block = app.slice(app.indexOf('async function handleUnlock()'), app.indexOf('async function checkLegacyVerifier'));
  const saveAt = block.indexOf('saveServerFromLockInput()');
  const loginAt = block.indexOf('unlockOnline(');
  assert.ok(saveAt > 0, 'handleUnlock 未调用 saveServerFromLockInput');
  assert.ok(loginAt > saveAt, '保存地址必须早于登录请求');
});

ok('NAS 地址归一化：补 http://、去尾斜杠、拒绝带路径', () => {
  const block = app.slice(app.indexOf('function normalizeServerUrl'), app.indexOf('function fillLockServerInput'));
  assert.match(block, /value = 'http:\/\/' \+ value/);
  assert.match(block, /replace\(\/\\\/\+\$\/, ''\)/);
  assert.match(block, /\^https\?/);
});

console.log('\nlogin UI tests: ' + pass + ' pass');
