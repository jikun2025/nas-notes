'use strict';
// 鸿蒙壳静态回归：CA 桥三方法、用户 CA 才设 caPath、默认地址为空不出网、
// 设备密钥与服务器账户桥（免密直入）。纯静态检查（读 E:\HarmonyOS\nas-notes-harmony
// 的 ArkTS 源码），零依赖。运行：node tools/test_harmony_shell.js
//
// 背景：鸿蒙壳与安卓壳共用同一份 _bridge.js（桥接 API 必须同名同语义），
// 且上架默认是「纯本机模式」——没有任何 NAS 地址时原生层绝不能出网；
// 他人自签 NAS 靠「设置 → 连接服务器」导入 CA，包内不内置任何证书
// （v3.0 起内置 pin 整体退场，作者内网 IP 也不得随包）。

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
const moduleJson = fs.readFileSync(path.join(HAP_ROOT, 'entry/src/main/module.json5'), 'utf8');
// rawfile 里的网页副本：跟着 static/ 走 sync-assets.js，这里顺带验证“同步过了”
const RAWFILE = HAP_ROOT + '/entry/src/main/resources/rawfile';
const rawApp = fs.readFileSync(path.join(RAWFILE, 'app.js'), 'utf8');
const rawCss = fs.readFileSync(path.join(RAWFILE, 'style.css'), 'utf8');

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

ok('NasPrefs：KEY_CA 存取清齐备，server 默认空＋不预填旧地址', () => {
  assert.match(prefs, /const KEY_CA: string = 'user_ca'/);
  assert.match(prefs, /getSync\(KEY_CA, ''\)/);
  assert.match(prefs, /putSync\(KEY_CA, pem\)/);
  assert.match(prefs, /deleteSync\(KEY_CA\)/);
  // server 默认值即空串（getSync(KEY_SERVER, '')）＝上架默认纯本机
  assert.match(prefs, /getSync\(KEY_SERVER, ''\)/);
  // 包内与源码里都不许再出现作者内网 IP，也不做旧地址一次性迁移
  assert.doesNotMatch(prefs, /192\.168\./);
  assert.match(prefs, /v\.indexOf\(':\/\/'\) < 0[\s\S]{0,80}'https:\/\/' \+ v/);
});

ok('apiAsync 空地址绝不出网，回包与安卓壳同款 no server configured', () => {
  assert.match(bridge, /if \(!server\) \{[\s\S]*?no server configured/);
});

ok('CaBundle：包内不内置任何证书/主机 pin，只落用户导入 CA', () => {
  // 内置 pin 整体退场（v3.0）：不许再有 OWN_HOST、rawfile ca.crt、合并 bundle
  assert.doesNotMatch(ca, /OWN_HOST/);
  assert.doesNotMatch(ca, /getRawFileContentSync/);
  assert.doesNotMatch(ca, /nasnotes-ca-bundle\.pem/);
  assert.doesNotMatch(ca, /nasnotes-ca\.pem/);
  assert.doesNotMatch(ca, /192\.168\./);
  // 用户 CA 落盘沙箱文件（caPath 只认文件路径），没导入时 caPath 为空
  assert.match(ca, /nasnotes-user-ca\.pem/);
  assert.match(ca, /static caPath\(\): string/);
  assert.match(ca, /static materialize\(\): void/);
});

ok('NasHttp：只在导入过 CA 时才设 caPath，否则走系统默认信任', () => {
  assert.match(http, /CaBundle\.caPath\(\)/);
  assert.match(http, /if \(ca\.length > 0\) \{\s*options\.caPath = ca;/);
  // 旧的全局独占与按内置主机选择的写法都必须消失
  assert.doesNotMatch(http, /CaBundle\.pathFor/);
  assert.doesNotMatch(http, /function hostOf\(url: string\): string/);
  assert.doesNotMatch(http, /192\.168\./);
});

ok('设备密钥与服务器账户桥齐备（免密直入的根基，只存原生侧）', () => {
  assert.match(bridge, /getDeviceSecret\(\): string/);
  assert.match(bridge, /NasPrefs\.getDeviceSecret\(\)/);
  assert.match(bridge, /saveServerAccount\(username: string, password: string\): string/);
  assert.match(bridge, /getServerAccount\(\): string/);
  assert.match(bridge, /clearServerAccount\(\): void/);
  assert.match(prefs, /const KEY_DEV_SECRET: string = 'dev_secret'/);
  assert.match(prefs, /cryptoFramework\.createRandom\(\)/);
  assert.match(prefs, /generateRandomSync\(32\)/);
  assert.match(prefs, /const rand: cryptoFramework\.Random = cryptoFramework\.createRandom\(\);/);
  assert.match(prefs, /const KEY_SERVER_USER: string = 'server_user'/);
  assert.match(prefs, /const KEY_SERVER_PASS: string = 'server_pass'/);
  const m = /methodList: \[([^\]]+)\]/.exec(index);
  assert.ok(m, '找不到 methodList');
  for (const name of ['getDeviceSecret', 'saveServerAccount', 'getServerAccount', 'clearServerAccount']) {
    assert.ok(m[1].includes("'" + name + "'"), 'methodList 缺少 ' + name);
  }
});

ok('麦克风：安装包声明 + 原生运行时申请 + 网页层放行，三道齐备（审核「无法录音」回归）', () => {
  // 1) 安装包里声明 ohos.permission.MICROPHONE（user_grant，声明只代表“允许申请”）
  assert.match(moduleJson, /ohos\.permission\.MICROPHONE/);
  assert.match(moduleJson, /reason_microphone/);
  // 2) 原生侧必须真的去申请：ArkWeb 的 onPermissionRequest 只放行网页层，
  //    管不到系统授权，缺这一步 getUserMedia 必然 NotAllowedError
  assert.match(bridge, /abilityAccessCtrl\.createAtManager\(\)/);
  assert.match(bridge, /checkAccessTokenSync\(tokenId, MIC_PERMISSION\)/);
  assert.match(bridge, /requestPermissionsFromUser\(this\.ctx, \[MIC_PERMISSION\]\)/);
  assert.match(bridge, /requestMic\(\): string/);
  assert.match(bridge, /micState\(\): string/);
  // 3) 桥方法没登记进 methodList，网页侧调用就是 undefined
  const micList = /methodList: \[([^\]]+)\]/.exec(index);
  assert.ok(micList, '找不到 methodList');
  for (const name of ['requestMic', 'micState']) {
    assert.ok(micList[1].includes("'" + name + "'"), 'methodList 缺少 ' + name);
  }
  // 4) 网页侧录音前先过桥申请；rawfile 与母本同步（忘记 sync-assets 会在这里炸）
  assert.match(rawApp, /function shellMicState\(\)/);
  assert.match(rawApp, /String\(api\.requestMic\(\) \|\| ''\)/);
  assert.match(rawApp, /function watchMicThenRecord\(\)/);
  assert.match(rawApp, /async function startRecording\(\)/);
  // 5) onPermissionRequest 必须按 ArkWeb 的真实资源名放行。
  //    实测 API 26 的 getAccessibleResource() 返回 ["TYPE_AUDIO_CAPTURE"]，
  //    不是 'ohos.permission.MICROPHONE'，也不是 Android 的 RESOURCE_AUDIO_CAPTURE。
  //    名字写错就永远匹配不上、走 deny()，表现为点录音立刻「无法录音：Permission denied」
  //    ——v3.0 首版正是这么错的，靠模拟器实测才发现。
  assert.match(index, /TYPE_AUDIO_CAPTURE/);
  assert.match(index, /onPermissionRequest\(\(event\)/);
  assert.match(index, /indexOf\('AUDIO_CAPTURE'\) >= 0/);
  // 手势约束：ArkWeb 要求 getUserMedia 在点击的同步窗口内发起，
  // startRecording 里 getUserMedia 之前不能出现任何 await（会吃掉激活态）
  const recHead = rawApp.slice(rawApp.indexOf('async function startRecording()'), rawApp.indexOf('mediaRecorder.onstop'));
  const firstAwait = recHead.indexOf('await');
  assert.ok(firstAwait > 0, 'startRecording 里应该有 getUserMedia 调用');
  assert.match(recHead.slice(firstAwait), /^await navigator\.mediaDevices\.getUserMedia/,
    'startRecording 里的第一个 await 必须是 getUserMedia（前面插 await 会丢用户手势）');
});

ok('弹窗不进浏览器模态层（ArkWeb top layer 里按钮点不动，审核「设置关不掉」回归）', () => {
  // 只用 open 属性 + 普通 fixed 层；showModal()/show() 都会把元素推进 top layer
  assert.doesNotMatch(rawApp, /dialog\.showModal\(/);
  assert.doesNotMatch(rawApp, /dialog\.show\(\)/);
  assert.match(rawApp, /dialog\.setAttribute\('open', ''\)/);
  // 关掉的弹窗必须彻底不渲染（.settings-dialog 的 display:flex 会盖掉 UA 规则）
  assert.match(rawCss, /dialog:not\(\[open\]\) \{ display: none !important; \}/);
  // 弹窗层要压住遮罩(410)与抽屉/遮罩(29/30)，提示条要压在弹窗之上
  assert.match(rawCss, /dialog\.dialog-fallback \{[^}]*z-index: 420/);
  assert.match(rawCss, /\.toast \{[^}]*z-index: 460/);
});

ok('版本号已递增（鸿蒙 3.0）', () => {
  const code = /"versionCode": (\d+)/.exec(appJson);
  const name = /"versionName": "([^"]+)"/.exec(appJson);
  assert.ok(code && Number(code[1]) >= 3000000, 'versionCode 应递增，当前 ' + (code && code[1]));
  assert.ok(name && name[1] >= '3.0', 'versionName 应递增，当前 ' + (name && name[1]));
});

console.log('\n鸿蒙壳静态回归：' + pass + ' pass');
