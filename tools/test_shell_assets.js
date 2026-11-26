'use strict';
// 安卓壳静态回归：内联页构建、WebResourceResponse 编码、原生桥响应解析。
// 纯静态检查，零依赖。运行：node tools/test_shell_assets.js
//
// 背景：壳早期把 "text/html; charset=utf-8" 拆成 ("text","html") 传给
// WebResourceResponse（第二个参数是字符编码），WebView 把首页当纯文本，
// 装到手机上就是一片白。这组断言防止再犯，同时保证 index.html 的标签
// 与 Java 里的内联替换串一致（改前端忘了同步壳，就会静默退回白屏）。

const fs = require('fs');
const path = require('path');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const readFile = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const html = readFile('static/index.html');
const java = readFile('android/app/src/main/java/com/nasnotes/app/MainActivity.java');
const bridge = readFile('android/app/src/main/assets/_bridge.js');
const gradle = readFile('android/app/build.gradle.kts');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { console.error('  FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

ok('WebResourceResponse 用正确 MIME 与 utf-8 编码（白屏根因）', () => {
  assert.match(java, /new WebResourceResponse\(mediaTypeOf\(mime\), "utf-8"/);
  assert.match(java, /private static String mediaTypeOf\(String mime\)/);
  assert.doesNotMatch(java, /mimeSplit|mimeSub/);
});

ok('首页优先走虚拟域，空白时自动降级到内联页', () => {
  assert.match(java, /webView\.loadUrl\(ASSET_ORIGIN \+ "\/"\)/);
  assert.match(java, /private void fallbackToInline\(String reason\)/);
  assert.match(java, /webView\.loadDataWithBaseURL\(base, buildInlinePage\(\), "text\/html", "utf-8", base\)/);
  assert.match(java, /fallbackToInline\("主文档加载失败："/);
  assert.match(java, /if \(attempt == 0\) \{\s*fallbackToInline/);
});

ok('内联页把 CSS 与四个脚本都塞进 HTML，并在 </head> 前注入原生桥', () => {
  assert.ok(html.indexOf('<link rel="stylesheet" href="/style.css">') >= 0, 'index.html 缺少 style.css 引用');
  assert.match(java, /<link rel=\\"stylesheet\\" href=\\"\/style\.css\\">/);
  for (const js of ['cryptofb.js', 'md.js', 'html2md.js', 'app.js']) {
    assert.ok(html.indexOf('<script src="/' + js + '"></script>') >= 0, 'index.html 缺少 ' + js);
    assert.ok(java.indexOf('"<script src=\\"/" + js + "\\"></script>"') >= 0, 'Java 内联串与 index.html 不匹配：' + js);
  }
  assert.match(java, /replaceOnce\(html, "<\/head>",/);
  assert.match(java, /window\.__NN_SHELL__=true;/);
  assert.match(java, /escapeForInlineScript\(/);
  assert.match(java, /<\/script", "<\\\\\/script"/);
});

ok('壳内不注册 Service Worker（静态资源已内联，没有可缓存的网络资源）', () => {
  assert.match(readFile('static/app.js'), /if \('serviceWorker' in navigator && !window\.__NN_SHELL__\)/);
});

ok('原生桥把 headers JSON 解析成对象，status=0 明确按网络失败处理', () => {
  assert.match(bridge, /JSON\.parse\(respHeaders\)/);
  assert.match(bridge, /if \(!status\) \{/);
  assert.match(bridge, /new Response\(text, \{ status: status, headers: hdrs \}\)/);
  // 设置里的"连接测试"必须走被劫持的 fetch，否则请求落到虚拟域永远成功
  assert.match(bridge, /window\.fetch\(ASSET_ORIGIN \+ '\/api\/health'\)/);
});

ok('虚拟域返回首页也注入壳标记与桥（否则 /api/ 会 502 Bridge Unavailable）', () => {
  const block = java.slice(java.indexOf('private WebResourceResponse assetResponse'),
    java.indexOf('private byte[] readAssetBytes'));
  assert.match(block, /"index\.html"\.equals\(assetName\)/);
  assert.match(block, /injectShellScripts\(base\)/);
  assert.match(java, /private String injectShellScripts\(String html\)/);
  // 两条加载路径（拦截器 / 内联降级）必须共用同一个注入函数
  const inline = java.slice(java.indexOf('private String buildInlinePage'),
    java.indexOf('private String injectShellScripts'));
  assert.match(inline, /return injectShellScripts\(html\)/);
});

ok('APK 打包配置：static 与 main/assets 都进 assets，版本号已递增', () => {
  assert.match(gradle, /assets\.srcDirs\("src\/main\/assets", staticDir\.path\)/);
  const code = /versionCode = (\d+)/.exec(gradle);
  assert.ok(code && Number(code[1]) >= 20, 'versionCode 应递增，当前 ' + (code && code[1]));
});

console.log('\nShell assets tests: ' + pass + ' pass');
