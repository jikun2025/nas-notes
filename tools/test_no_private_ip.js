'use strict';
// 随包文件隐私回归：作者的内网地址/证书绝不能进任何安装包。
// 扫描 PWA static、安卓 assets、鸿蒙 rawfile 与两侧原生源码：
//  - 不得出现 192.168.x.x（作者家用局域网段）
//  - 不得再随包 ca.crt（内置 pin 已在 v3.0 整体退场）
// 纯静态检查，零依赖。运行：node tools/test_no_private_ip.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HAP_ROOT = 'E:/HarmonyOS/nas-notes-harmony';

const DIRS = [
  path.join(ROOT, 'static'),
  path.join(ROOT, 'android/app/src/main/assets'),
  path.join(ROOT, 'android/app/src/main/java'),
  path.join(ROOT, 'deploy'),
  HAP_ROOT + '/entry/src/main/ets',
  HAP_ROOT + '/entry/src/main/resources/rawfile'
];
// crt/pem 是 base64，服务器证书里合法含有 SAN IP，不参与 IP 扫描；
// 「不随包证书」由下面单独的存在性断言保证。
const SCAN_EXT = new Set(['.js', '.ts', '.java', '.ets', '.html', '.css', '.json', '.json5',
  '.webmanifest', '.svg', '.yml', '.yaml', '.md', '.txt', '.py', '.xml', '.kts', '.properties']);

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { console.error('  FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

const ROOT_FILES = [
  'docker-compose.yml',
  'CHANGELOG.md',
  'README.md',
  'server.py'
];

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (SCAN_EXT.has(path.extname(ent.name).toLowerCase())) out.push(p);
  }
  return out;
}

ok('随包/源码文件里不出现作者内网网段 192.168.', () => {
  const hits = [];
  for (const dir of DIRS) {
    for (const file of walk(dir, [])) {
      const text = fs.readFileSync(file, 'utf8');
      if (/192\.168\./.test(text)) hits.push(path.relative(ROOT, file));
    }
  }
  for (const rel of ROOT_FILES) {
    const file = path.join(ROOT, rel);
    if (fs.existsSync(file) && /192\.168\./.test(fs.readFileSync(file, 'utf8'))) hits.push(rel);
  }
  assert0(hits.length === 0, '含内网 IP 的文件：' + hits.join(', '));
});

ok('内置证书不再随包（static 与鸿蒙 rawfile 都没有 ca.crt）', () => {
  assert0(!fs.existsSync(path.join(ROOT, 'static/ca.crt')), 'static/ca.crt 仍存在');
  assert0(!fs.existsSync(path.join(ROOT, 'android/app/src/main/assets/ca.crt')), '安卓 assets 里有 ca.crt');
  assert0(!fs.existsSync(HAP_ROOT + '/entry/src/main/resources/rawfile/ca.crt'), '鸿蒙 rawfile 里有 ca.crt');
});

ok('sync-assets.js 不再同步 ca.crt 到鸿蒙 rawfile', () => {
  const text = fs.readFileSync(HAP_ROOT + '/tools/sync-assets.js', 'utf8');
  assert0(!/['"]ca\.crt['"]/.test(text), 'STATIC_FILES 仍包含 ca.crt');
});

function assert0(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log('\n随包隐私回归：' + pass + ' pass');
