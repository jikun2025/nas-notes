// NasNotes 安卓壳桥接脚本（仅存在于 APK assets，不进入共享 PWA 代码）
// 注入时机：MainActivity 拦截 / 与 /index.html 时把本文件内联进 <head>，保证先于 app.js 执行。
// 在 Service Worker 上下文中被守卫跳过。
(function () {
  'use strict';
  // SW 上下文没有 document/DOM，且没有原生桥，直接退出
  if (typeof self.registration !== 'undefined' || typeof document === 'undefined') return;
  if (window.__NnBridge) return;
  window.__NnBridge = true;

  var ASSET_ORIGIN = 'https://appassets.androidplatform.net';
  var origFetch = window.fetch.bind(window);

  var cbSeq = 0;
  function nextCb() {
    return '__nn_cb_' + (++cbSeq) + '_' + Date.now().toString(36);
  }

  function collectHeaders(init, input) {
    var out = {};
    var h = (init && init.headers) || (input && input.headers);
    if (!h) return out;
    if (typeof h.forEach === 'function') {
      h.forEach(function (v, k) { out[k] = v; });
    } else if (Array.isArray(h)) {
      h.forEach(function (pair) { out[pair[0]] = pair[1]; });
    } else {
      Object.keys(h).forEach(function (k) { out[k] = String(h[k]); });
    }
    return out;
  }

  // /api/* → 原生 HttpURLConnection 转发到用户配置的 NAS 服务器（绕开 WebView 对 http 的混合内容拦截）
  window.fetch = function (input, init) {
    init = init || {};
    var rawUrl = typeof input === 'string' ? input : (input && input.url) || '';
    var abs = rawUrl;
    try { abs = new URL(rawUrl, location.href).href; } catch (e) { /* keep as-is */ }

    if (abs.indexOf(ASSET_ORIGIN + '/api/') === 0) {
      var path = abs.slice(ASSET_ORIGIN.length);
      var method = String((init.method) || (input && input.method) || 'GET').toUpperCase();
      var headers = collectHeaders(init, input);
      var body = init.body != null ? String(init.body) : null;
      return new Promise(function (resolve, reject) {
        if (!window.NasNative || typeof window.NasNative.apiAsync !== 'function') {
          reject(new TypeError('NasNative bridge unavailable（原生桥不可用）'));
          return;
        }
        var cb = nextCb();
        var timer = setTimeout(function () {
          delete window[cb];
          reject(new TypeError('request timeout（服务器无响应，请检查设置中的 NAS 地址）'));
        }, 20000);
        window[cb] = function (status, respHeaders, text) {
          clearTimeout(timer);
          delete window[cb];
          try {
            resolve(new Response(text, { status: status, headers: respHeaders || {} }));
          } catch (e) {
            reject(new TypeError('bad response from native bridge'));
          }
        };
        try {
          window.NasNative.apiAsync(cb, method, path, JSON.stringify(headers), body);
        } catch (e) {
          clearTimeout(timer);
          delete window[cb];
          reject(e);
        }
      });
    }
    return origFetch(input, init);
  };

  // 备份导出：blob: + a[download] 在 WebView 内不触发下载，改为原生保存到系统下载目录
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
    if (a && a.href && a.href.indexOf('blob:') === 0) {
      e.preventDefault();
      origFetch(a.href)
        .then(function (r) { return r.blob(); })
        .then(function (b) { return b.text(); })
        .then(function (t) {
          if (window.NasNative && window.NasNative.saveText) {
            window.NasNative.saveText(String(a.download || 'nas-notes-backup.json'), t);
          }
        })
        .catch(function () {});
    }
  }, true);

  function toast(msg) {
    var t = document.getElementById('toast');
    if (t) {
      t.textContent = msg;
      t.hidden = false;
      setTimeout(function () { t.hidden = true; }, 3000);
    }
  }

  // 在设置对话框顶部注入「NAS 服务器地址」配置（原生 SharedPreferences 持久化）
  function injectServerRow() {
    var dlg = document.getElementById('settingsDialog');
    if (!dlg || !window.NasNative || document.getElementById('nn-server-row')) return false;
    dlg.insertAdjacentHTML('beforeend',
      '<h4 id="nn-server-title">NAS 服务器（本 APK 专用）</h4>' +
      '<p class="muted" id="nn-server-hint">APK 内置界面离线运行，便签数据实时转发到该地址（仅密文）。</p>' +
      '<div id="nn-server-row" style="display:flex;gap:8px;align-items:center;margin:6px 0 10px">' +
      '<input id="nn-server-input" type="text" placeholder="http://192.168.5.10:28080" style="flex:1;min-width:0;padding:8px;border-radius:8px;border:1px solid #999">' +
      '<button id="nn-server-save" type="button" style="padding:8px 14px;border-radius:8px;border:1px solid #777;background:#e8e8e8;cursor:pointer">保存并测试</button>' +
      '</div>');
    var inp = document.getElementById('nn-server-input');
    var btn = document.getElementById('nn-server-save');
    var title = document.getElementById('nn-server-title');
    var hint = document.getElementById('nn-server-hint');
    var row = document.getElementById('nn-server-row');
    inp.value = window.NasNative.getServer() || '';
    // 移到对话框最顶部（h3「设置」之后）
    var h3 = dlg.querySelector('h3');
    if (h3) {
      h3.insertAdjacentElement('afterend', title);
      title.insertAdjacentElement('afterend', hint);
      hint.insertAdjacentElement('afterend', row);
    }
    btn.addEventListener('click', function () {
      var v = (inp.value || '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\/[^\/\s]+$/.test(v)) { toast('地址格式：http(s)://IP或域名[:端口]'); return; }
      window.NasNative.setServer(v);
      toast('已保存，正在测试连接…');
      origFetch(ASSET_ORIGIN + '/api/health')
        .then(function (r) { toast(r.status < 500 ? '连接正常 ✓' : '服务器响应异常(' + r.status + ')'); })
        .catch(function () { toast('连接失败，请检查地址、端口与 NAS 服务状态'); });
    });
    return true;
  }

  function tryInject(rounds) {
    if (injectServerRow()) return;
    if (rounds > 0) setTimeout(function () { tryInject(rounds - 1); }, 400);
  }

  // 页面加载后与每次打开设置时都尝试注入（设置对话框内容由前端动态 show）
  document.addEventListener('click', function (e) {
    var t = e.target;
    while (t) {
      if (t.id === 'settingsBtn') { setTimeout(function () { tryInject(8); }, 250); break; }
      t = t.parentElement;
    }
  }, true);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { tryInject(12); });
  } else {
    tryInject(12);
  }
})();
