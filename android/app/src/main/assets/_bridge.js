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
        // 8 秒足够局域网响应；再长会让「点同步」像卡死。超时后本机数据照常保留。
        var timer = setTimeout(function () {
          delete window[cb];
          reject(new TypeError('request timeout（NAS 无响应，本机数据不受影响）'));
        }, 8000);
        window[cb] = function (status, respHeaders, text) {
          clearTimeout(timer);
          delete window[cb];
          // 原生层传回的是 headers 的 JSON 文本（不是对象），且 status=0 表示网络层失败
          if (!status) {
            reject(new TypeError('Failed to fetch（连不上 NAS，本机数据不受影响）'));
            return;
          }
          var hdrs = {};
          try {
            hdrs = typeof respHeaders === 'string' ? JSON.parse(respHeaders) : (respHeaders || {});
          } catch (e) { hdrs = {}; }
          try {
            resolve(new Response(text, { status: status, headers: hdrs }));
          } catch (e) {
            reject(new TypeError('bad response from native bridge: ' + e.message));
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

  // 在「设置 → 同步」面板里注入「NAS 服务器地址」（原生 SharedPreferences 持久化）。
  // 本机读写完全不需要这个地址，只有点同步时才连它——所以它属于同步设置，
  // 不放在设置弹窗顶部（那样会打散两级设置布局）。
  function injectServerRow() {
    var panel = document.querySelector('.settings-panel[data-panel="sync"]');
    if (!panel || !window.NasNative || document.getElementById('nn-server-row')) return false;

    var card = panel.querySelector('.sync-card');
    var wrap = document.createElement('div');
    wrap.id = 'nn-server-wrap';
    wrap.innerHTML =
      '<label for="nn-server-input">NAS 服务器地址</label>' +
      '<p class="muted" id="nn-server-hint">本机离线读写不需要它；只有点「立即同步」时才会连这个地址（只传密文）。</p>' +
      '<div id="nn-server-row" style="display:flex;gap:8px;align-items:center;margin:6px 0 14px">' +
      '<input id="nn-server-input" type="text" placeholder="http://192.168.5.10:28080" style="flex:1;min-width:0;padding:8px;border-radius:8px;border:1px solid #999">' +
      '<button id="nn-server-save" type="button" style="padding:8px 14px;border-radius:8px;border:1px solid #777;background:#e8e8e8;cursor:pointer">保存并测试</button>' +
      '</div>';

    if (card) panel.insertBefore(wrap, card);
    else panel.insertBefore(wrap, panel.firstChild);

    var inp = document.getElementById('nn-server-input');
    var btn = document.getElementById('nn-server-save');
    inp.value = window.NasNative.getServer() || '';
    btn.addEventListener('click', function () {
      var v = (inp.value || '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\/[^\/\s]+$/.test(v)) { toast('地址格式：http(s)://IP或域名[:端口]'); return; }
      window.NasNative.setServer(v);
      var label = document.getElementById('syncServerAddr');
      if (label) label.textContent = v;
      toast('已保存，正在测试连接…');
      // 走被劫持的 fetch，才会真正转发到 NAS（origFetch 会落到虚拟域，永远"成功"）
      window.fetch(ASSET_ORIGIN + '/api/health')
        .then(function (r) { toast(r.status < 500 ? '连接正常 ✓' : '服务器响应异常(' + r.status + ')'); })
        .catch(function () { toast('连接失败：本机离线功能不受影响，检查地址/端口/NAS 服务即可'); });
    });
    return true;
  }

  function tryInject(rounds) {
    if (injectServerRow()) return;
    if (rounds > 0) setTimeout(function () { tryInject(rounds - 1); }, 400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { tryInject(12); });
  } else {
    tryInject(12);
  }
})();
