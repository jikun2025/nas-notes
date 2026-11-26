'use strict';
// 鸿蒙 7.0 / 卓易通 WebView 兼容静态回归：node tools/test_harmony_compat.js
// 覆盖：语法级别、能力垫片、脚本装载顺序、两条资源拦截路径、安全区兜底、
// 桥接降级、CSS 降级、明文传输配置、无第三方外链。

const fs = require('fs');
const path = require('path');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const compat = read('static/compat.js');
const app = read('static/app.js');
const cryptofb = read('static/cryptofb.js');
const html = read('static/index.html');
const css = read('static/style.css');
const sw = read('static/sw.js');
const java = read('android/app/src/main/java/com/nasnotes/app/MainActivity.java');
const bridge = read('android/app/src/main/assets/_bridge.js');
const manifest = read('android/app/src/main/AndroidManifest.xml');
const gradle = read('android/app/build.gradle.kts');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  PASS ' + name); }
  catch (e) { console.error('  FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

ok('compat.js 本身保持 ES5 语法（老引擎也能解析）', () => {
  assert.doesNotMatch(compat, /(^|[^\w.])(let|const)\s+[A-Za-z_$]/);
  assert.doesNotMatch(compat, /=>/);
  assert.doesNotMatch(compat, /`/);
  assert.doesNotMatch(compat, /\?\./);
  assert.doesNotMatch(compat, /\?\?/);
  assert.match(compat, /^\(function \(g\) \{/m);
});

ok('compat.js 补齐 app.js 实际依赖的高风险 API', () => {
  for (const token of ['TextEncoder', 'TextDecoder', 'Object.assign', 'Array.from',
    'String.prototype.includes', 'Array.prototype.includes', 'Array.prototype.find',
    'Element.prototype.closest', 'Element.prototype.remove',
    'Ctor.prototype.forEach', 'Blob.prototype.text', 'String.prototype.padStart']) {
    assert.ok(compat.indexOf(token) >= 0, '缺少垫片：' + token);
  }
  assert.ok(compat.indexOf('NodeList') >= 0 && compat.indexOf('HTMLCollection') >= 0,
    '集合迭代器垫片需同时覆盖 NodeList 与 HTMLCollection');
  assert.match(compat, /__NN_CAPS__/);
  assert.match(compat, /\[compat\]/);
});

ok('加密随机性绝不降级：缺 getRandomValues 只报错，不用 Math.random 兜底', () => {
  assert.match(compat, /绝不提供 Math\.random 兜底/);
  assert.match(compat, /crypto\.getRandomValues 不可用/);
  assert.doesNotMatch(compat, /crypto\.getRandomValues\s*=\s*function[\s\S]*Math\.random/);
});

ok('app.js / cryptofb.js 不把 ES2020 的 globalThis 当唯一全局对象', () => {
  assert.doesNotMatch(app, /globalThis/);
  assert.doesNotMatch(cryptofb, /var g = globalThis/);
  assert.match(cryptofb, /var g = \(typeof window !== 'undefined'\) \? window/);
  assert.match(cryptofb, /typeof globalThis !== 'undefined'\) \? globalThis : this/);
  assert.doesNotMatch(app, /\?\./);
  assert.doesNotMatch(app, /\?\?/);
});

ok('页面脚本顺序：compat 最先、索引在 app.js 之前', () => {
  const iCompat = html.indexOf('<script src="/compat.js"></script>');
  const iIndex = html.indexOf('<script src="/nn-index.js"></script>');
  const iApp = html.indexOf('<script src="/app.js"></script>');
  assert.ok(iCompat >= 0 && iIndex >= 0 && iApp >= 0);
  assert.ok(iCompat < iApp, 'compat.js 必须早于 app.js');
  assert.ok(iIndex < iApp, 'nn-index.js 必须早于 app.js');
  // 兼容垫片在 head 里，壳注入的桥（</head> 前）仍在它之后
  assert.ok(iCompat < html.indexOf('</head>'));
});

ok('SW 缓存清单包含新增脚本且版本已升级', () => {
  assert.match(sw, /const CACHE = 'nas-notes-v28'/);
  assert.match(sw, /'\/compat\.js'/);
  assert.match(sw, /'\/nn-index\.js'/);
});

ok('APK 内联页把两个新脚本都塞进 HTML，compat 排第一', () => {
  assert.match(java, /new String\[\]\{"compat\.js", "cryptofb\.js", "md\.js",/);
  assert.match(java, /"html2md\.js", "nn-index\.js", "app\.js"\}/);
  for (const js of ['compat.js', 'nn-index.js']) {
    assert.ok(html.indexOf('<script src="/' + js + '"></script>') >= 0,
      'index.html 缺少 ' + js);
  }
});

ok('两条资源加载路径共用 injectShellScripts（壳标记 + 桥不丢）', () => {
  assert.match(java, /private String injectShellScripts\(String html\)/);
  const inline = java.slice(java.indexOf('private String buildInlinePage'),
    java.indexOf('private String injectShellScripts'));
  assert.match(inline, /return injectShellScripts\(html\)/);
  const asset = java.slice(java.indexOf('private WebResourceResponse assetResponse'),
    java.indexOf('private byte[] readAssetBytes'));
  assert.match(asset, /injectShellScripts\(base\)/);
  assert.match(java, /window\.__NN_SHELL__=true;/);
});

ok('WebView 同时覆盖新旧两版 shouldInterceptRequest', () => {
  assert.match(java, /shouldInterceptRequest\(WebView view, WebResourceRequest request\)/);
  assert.match(java, /shouldInterceptRequest\(WebView view, String url\)/);
  assert.match(java, /private WebResourceResponse interceptUri\(Uri uri\)/);
  assert.match(java, /return request == null \? null : interceptUri\(request\.getUrl\(\)\)/);
  assert.match(java, /return interceptUri\(Uri\.parse\(url\)\)/);
  assert.ok(java.indexOf('shouldInterceptRequest(WebView view, String url)') > 0);
});

ok('老版 onReceivedError 也降级到内联页，不再空实现', () => {
  assert.match(java, /onReceivedError\(WebView view, int errorCode, String description, String failingUrl\)/);
  assert.match(java, /主文档加载失败\(旧版回调\)/);
});

ok('状态栏安全区：insets 回调缺失时用系统 dimen 兜底', () => {
  assert.match(java, /private int systemDimen\(String name\)/);
  assert.match(java, /status_bar_height/);
  assert.match(java, /navigation_bar_height/);
  assert.match(java, /applyFallbackInsets\(\)/);
  assert.match(java, /ui\.postDelayed\(new Runnable\(\)/);
  assert.match(java, /injectSafeInsets\(\);/, 'onPageFinished 仍补写');
});

ok('兼容垫片的诊断信息能被 fatal 面板收集', () => {
  assert.match(java, /m\.message\(\)\.indexOf\("\[compat\]"\) >= 0/);
  assert.match(java, /WebView\.getCurrentWebViewPackage\(\)/);
});

ok('CSS 对 dvh / env() 做双降级，且不用 :has()', () => {
  assert.match(css, /height: 100vh; height: 100dvh/);
  assert.match(css, /--safe-top: var\(--nn-safe-top, 0px\)/);
  assert.match(css, /--safe-top: var\(--nn-safe-top, env\(safe-area-inset-top, 0px\)\)/);
  assert.doesNotMatch(css, /:has\(/);
});

ok('原生桥对缺 fetch / 老 Response / 缺 Blob.text 都有降级', () => {
  assert.match(bridge, /typeof window\.fetch === 'function'/);
  assert.match(bridge, /new XMLHttpRequest\(\)/);
  assert.match(bridge, /function makeResponse\(text, status, hdrs\)/);
  assert.match(bridge, /new Response\(text, \{ status: status, headers: hdrs \}\)/);
  assert.match(bridge, /if \(typeof b\.text === 'function'\) return b\.text\(\)/);
  assert.match(bridge, /new FileReader\(\)/);
  assert.match(bridge, /JSON\.parse\(respHeaders\)/);
  assert.match(bridge, /if \(!status\) \{/);
  assert.match(bridge, /resolve\(makeResponse\(text, status, hdrs\)\)/);
});

ok('局域网明文 HTTP 已在清单里显式允许（兼容层默认禁 cleartext）', () => {
  assert.match(manifest, /android:usesCleartextTraffic="true"/);
  assert.match(gradle, /minSdk = 26/);
});

ok('无第三方 CDN / 外链依赖（离线可用、鸿蒙兼容层不猜网络）', () => {
  assert.doesNotMatch(html, /<script[^>]+src="https?:\/\//);
  assert.doesNotMatch(html, /<link[^>]+href="https?:\/\//);
  assert.doesNotMatch(app, /https?:\/\/(cdn|unpkg|jsdelivr|fonts)/i);
});

ok('非安全上下文由 cryptofb.js 接管，HTTPS 前提不变', () => {
  assert.match(cryptofb, /g\.crypto && g\.crypto\.subtle/);
  assert.match(cryptofb, /原生可用，无需兜底/);
  assert.match(read('README.md'), /HTTPS/);
});

console.log('\n鸿蒙兼容静态回归：' + pass + ' pass');
