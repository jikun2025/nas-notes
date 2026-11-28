'use strict';
// 鸿蒙壳静态回归：CA 桥三方法、按 host 选 caPath、默认地址为空不出网。
// 纯静态检查（读 E:\HarmonyOS\nas-notes-harmony 的 ArkTS 源码），零依赖。
// 运行：node tools/test_harmony_shell.js
//
// 背景：鸿蒙壳与安卓壳共用同一份 _bridge.js（桥接 API 必须同名同语义），
// 且上架默认是「纯本机模式」——没有任何 NAS 地址时原生层绝不能出网；
// 他人自签 NAS 靠「设置→同步」导入 CA，caPath 按主机选择而不是全局独占
// （早期 caPath 无条件注入内置 CA，导致别人连自己的 HTTPS 服务失败）。

const fs = require('fs');
const path = require('path');
const assert = require('node:assert');

const HAP_ROOT = 'E:/HarmonyOS/nas-notes-harmony';
const ETS = HAP_ROOT + '/entry/src/main/ets';
const read = (p) => fs.readFileSync(path.join(ETS, p), 'utf8');

const bridge = read('common/NasBridge.ets');
const prefs = read('common/NasPrefs.ets');
const ca = read('common/CaBundle.ets');
const http = read('common/NasHttp.ets');
const index = read('pages/Index.ets');
const appJson = fs.readFileSync(path.join(HAP_ROOT, 'AppScope/app.json5'), 'utf8');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { console.error('  FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

ok('桥接三方法齐备，语义与安卓壳一致（返回 "ok"／中文原因）', () => {
  assert.match(bridge, /setCa\(pem: string\): string/);
  assert.match(bridge, /getCa\(\): string/);
  assert.match(bridge, /clearCa\(\): void/);
  assert.match(bridge, /-----BEGIN CERTIFICATE-----/);
  assert.match(bridge, /256 \* 1024/);
  assert.match(bridge, /return 'ok'/);
  // 存 Preferences 真源，并立即重建沙箱证书文件
  assert.match(bridge, /NasPrefs\.setCa\(pem\)/);
  assert.match(bridge, /CaBundle\.materialize\(\)/);
  assert.match(bridge, /NasPrefs\.clearCa\(\)/);
});

ok('methodList 暴露三个新桥方法（漏了网页侧调用直接 undefined）', () => {
  const m = /methodList: \[([^\]]+)\]/.exec(index);
  assert.ok(m, '找不到 methodList');
  for (const name of ['setCa', 'getCa', 'clearCa', 'getServer', 'setServer', 'apiAsync', 'saveText']) {
    assert.ok(m[1].includes("'" + name + "'"), 'methodList 缺少 ' + name);
  }
});

ok('NasPrefs：KEY_CA 存取清齐备，server 默认空＋旧地址一次性迁移', () => {
  assert.match(prefs, /const KEY_CA: string = 'user_ca'/);
  assert.match(prefs, /getSync\(KEY_CA, ''\)/);
  assert.match(prefs, /putSync\(KEY_CA, pem\)/);
  assert.match(prefs, /deleteSync\(KEY_CA\)/);
  // server 默认值即空串（getSync(KEY_SERVER, '')）＝上架默认纯本机
  assert.match(prefs, /getSync\(KEY_SERVER, ''\)/);
  assert.match(prefs, /http:\/\/192\.168\.5\.10:28080.*https:\/\/192\.168\.5\.10:28443/s);
});

ok('apiAsync 空地址绝不出网，回包与安卓壳同款 no server configured', () => {
  assert.match(bridge, /if \(!server\) \{[\s\S]*?no server configured/);
});

ok('CaBundle：按 host 选 caPath（自家→内置 pin、他人→用户 CA、无→空走系统）', () => {
  assert.match(ca, /const OWN_HOST: string = '192\.168\.5\.10'/);
  assert.match(ca, /static pathFor\(host: string\): string/);
  // 用户 CA 落盘沙箱文件（caPath 只认文件路径）
  assert.match(ca, /nasnotes-user-ca\.pem/);
  // 自家主机且导入了用户 CA：合并 bundle，避免「导了别人 CA 反而连不上自家」
  assert.match(ca, /nasnotes-ca-bundle\.pem/);
  assert.match(ca, /builtIn \+ '\\n' \+ user/);
});

ok('NasHttp：caPath 按 URL 主机选择，不再无条件注入内置 CA', () => {
  assert.match(http, /CaBundle\.pathFor\(hostOf\(url\)\)/);
  assert.match(http, /function hostOf\(url: string\): string/);
  // 旧的全局独占写法必须消失（那是别人连不上自己 HTTPS 的根因）
  assert.doesNotMatch(http, /const ca: string = CaBundle\.get\(\);/);
});

ok('版本号已递增（鸿蒙 2.9）', () => {
  const code = /"versionCode": (\d+)/.exec(appJson);
  const name = /"versionName": "([^"]+)"/.exec(appJson);
  assert.ok(code && Number(code[1]) >= 2900000, 'versionCode 应递增，当前 ' + (code && code[1]));
  assert.ok(name && name[1] >= '2.9', 'versionName 应递增，当前 ' + (name && name[1]));
});

console.log('\n鸿蒙壳静态回归：' + pass + ' pass');
