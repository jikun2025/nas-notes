// NasNotes 安卓壳桥接脚本（仅存在于 APK assets，不进入共享 PWA 代码）
// 注入时机：MainActivity 拦截 / 与 /index.html 时把本文件内联进 <head>，保证先于 app.js 执行。
// 在 Service Worker 上下文中被守卫跳过。
(function () {
  'use strict';
  // SW 上下文没有 document/DOM，且没有原生桥，直接退出
  if (typeof self.registration !== 'undefined' || typeof document === 'undefined') return;
  if (window.__NnBridge) return;
  window.__NnBridge = true;

  // 虚拟域由壳注入：安卓是 appassets.androidplatform.net，鸿蒙是 nasnotes.local。
  // 没有注入时退回当前页面 origin，两种壳的常规加载路径都成立。
  var ASSET_ORIGIN = window.__NN_ASSET_ORIGIN__ || location.origin;

  // 部分兼容层的 WebView 没有 fetch：给一个基于 XHR 的最小实现，避免
  // 下面 window.fetch = ... 第一行就抛错导致整座桥失效（登录/同步全废）。
  var origFetch;
  if (typeof window.fetch === 'function') {
    origFetch = window.fetch.bind(window);
  } else {
    origFetch = function (input, init) {
      init = init || {};
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open(init.method || 'GET', String(input), true);
        var hs = init.headers || {};
        Object.keys(hs).forEach(function (k) { xhr.setRequestHeader(k, hs[k]); });
        xhr.onload = function () {
          resolve(makeResponse(xhr.responseText, xhr.status,
            { 'Content-Type': xhr.getResponseHeader('Content-Type') || '' }));
        };
        xhr.onerror = function () { reject(new TypeError('XHR failed')); };
        xhr.send(init.body != null ? String(init.body) : null);
      });
    };
  }

  // 老 WebView 的 Response 构造器对 204/205/304 或某些 header 会抛异常；
  // 构造失败时退化成鸭子类型对象（app.js 只用 ok/status/json/text/headers）。
  function makeResponse(text, status, hdrs) {
    hdrs = hdrs || {};
    try {
      if (typeof Response === 'function') {
        return new Response(text, { status: status, headers: hdrs });
      }
    } catch (e) { /* 落到下面的兼容对象 */ }
    var body = String(text == null ? '' : text);
    return {
      status: status,
      ok: status >= 200 && status < 300,
      headers: { get: function (k) { return hdrs[k] || null; } },
      json: function () { return Promise.resolve(JSON.parse(body)); },
      text: function () { return Promise.resolve(body); },
      blob: function () { return Promise.resolve(new Blob([body])); }
    };
  }

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
        // 兼容层里的原生转发可能比普通 WebView 慢，留 10 秒；超时后本机数据照常保留。
        var timer = setTimeout(function () {
          delete window[cb];
          reject(new TypeError('request timeout（NAS 无响应，本机数据不受影响）'));
        }, 10000);
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
          resolve(makeResponse(text, status, hdrs));
        };
        try {
          // 鸿蒙的 ArkWeb 代理方法不收 null 参数，统一传空串；
          // 安卓原生层用 `body != null && !body.isEmpty()` 判断，空串同样不会发 body。
          window.NasNative.apiAsync(cb, method, path, JSON.stringify(headers),
            body == null ? '' : String(body));
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
        .then(function (b) {
          // Blob.prototype.text 是较新 API：compat.js 已补，这里再兜一层 FileReader。
          if (typeof b.text === 'function') return b.text();
          return new Promise(function (resolve, reject) {
            var fr = new FileReader();
            fr.onload = function () { resolve(String(fr.result)); };
            fr.onerror = function () { reject(fr.error || new Error('FileReader failed')); };
            fr.readAsText(b, 'utf-8');
          });
        })
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

  // 「设置 → 连接服务器」：填服务器地址、账户名、密码，可导入 CA 证书，
  // 点「连接并同步」才建立连接（原生 SharedPreferences 持久化地址与账户）。
  // 应用本身免密直入（系统门禁），这里填的是 NAS 上的账户——不是应用密码。
  function readSavedAccount() {
    var api = window.NasNative;
    if (!api || typeof api.getServerAccount !== 'function') return null;
    try {
      var raw = String(api.getServerAccount() || '');
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || !data.username) return null;
      return { username: String(data.username), password: String(data.password || '') };
    } catch (e) { return null; }
  }

  function normalizeAddr(raw) {
    var v = String(raw || '').trim().replace(/\/+$/, '');
    if (v && !/^https?:\/\//i.test(v)) v = 'https://' + v;
    return /^https?:\/\/[^\/\s]+$/.test(v) ? v : '';
  }

  function fillConnectForm() {
    var inp = document.getElementById('nn-server-input');
    if (inp && !inp.value) {
      try { inp.value = window.NasNative.getServer() || ''; } catch (e) { /* 桥异常按空 */ }
    }
    var user = document.getElementById('nn-user-input');
    var pass = document.getElementById('nn-pass-input');
    var saved = readSavedAccount();
    if (saved) {
      if (user && !user.value) user.value = saved.username;
      if (pass && !pass.value) pass.value = saved.password;
    }
    var state = document.getElementById('nn-connect-state');
    var addr = '';
    try { addr = String(window.NasNative.getServer() || ''); } catch (e) { /* 忽略 */ }
    if (state && !state.textContent) {
      state.textContent = addr ? '已连接：' + addr : '未连接：填好下面几项后点「连接并同步」';
    }
  }

  function injectServerRow() {
    var panel = document.querySelector('.settings-panel[data-panel="sync"]');
    if (!panel || !window.NasNative || document.getElementById('nn-server-row')) return false;

    var card = panel.querySelector('.sync-card');
    var wrap = document.createElement('div');
    wrap.id = 'nn-server-wrap';
    wrap.innerHTML =
      '<label for="nn-server-input">服务器地址</label>' +
      '<p class="muted" id="nn-server-hint">本机离线读写不需要它；连接后应用才会访问这台服务器（只传密文）。</p>' +
      '<div id="nn-server-row" style="display:flex;gap:8px;align-items:center;margin:6px 0 12px">' +
      '<input id="nn-server-input" type="text" placeholder="https://nas.example.com:28443" style="flex:1;min-width:0;padding:8px;border-radius:8px;border:1px solid #999">' +
      '</div>' +
      '<label for="nn-user-input">服务器账户名</label>' +
      '<div style="margin:6px 0 12px"><input id="nn-user-input" type="text" autocomplete="username" style="width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid #999"></div>' +
      '<label for="nn-pass-input">服务器账户密码</label>' +
      '<div style="margin:6px 0 4px"><input id="nn-pass-input" type="password" autocomplete="current-password" style="width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid #999"></div>' +
      '<p class="muted tiny">账户与密码只保存在本应用的原生配置里（不进网页存储），用于登录服务器与自动重新连接。</p>' +
      '<div style="display:flex;gap:10px;align-items:center;margin:10px 0 6px">' +
      '<button id="nn-connect-btn" type="button" style="padding:9px 18px;border-radius:8px;border:1px solid #3a72b0;background:#2b6cb0;color:#fff;cursor:pointer">连接并同步</button>' +
      '<span id="nn-connect-state" class="muted tiny"></span>' +
      '</div>';

    if (card) panel.insertBefore(wrap, card);
    else panel.insertBefore(wrap, panel.firstChild);

    var btn = document.getElementById('nn-connect-btn');
    var state = document.getElementById('nn-connect-state');
    fillConnectForm();
    btn.addEventListener('click', function () {
      var v = normalizeAddr(document.getElementById('nn-server-input').value);
      if (!v) { toast('地址格式：http(s)://IP或域名[:端口]'); return; }
      var user = (document.getElementById('nn-user-input').value || '').trim();
      var pass = document.getElementById('nn-pass-input').value || '';
      if (!pass) {
        var saved = readSavedAccount();
        if (saved && saved.password) { pass = saved.password; if (!user) user = saved.username; }
      }
      if (!pass) { toast('请填写服务器账户密码'); return; }
      if (typeof window.NnConnectServer !== 'function') { toast('页面尚未就绪，稍候再试'); return; }
      btn.disabled = true;
      state.textContent = '连接中…';
      window.NnConnectServer({ server: v, username: user, password: pass }).then(function (res) {
        btn.disabled = false;
        state.textContent = '已连接：' + v;
        toast((res && res.mode === 'linked') ? '已接入服务器上的加密库，完成同步' : '已连接：本机加密库已上传到服务器');
      }).catch(function (err) {
        btn.disabled = false;
        state.textContent = '连接失败，本机数据不受影响';
        toast('连接失败：' + ((err && err.message) || '未知错误'));
      });
    });
    injectCaRow(panel);
    return true;
  }

  // 「导入本地 CA 证书」：别人家 NAS 用自签/私有 CA 时，光填地址会握手失败。
  // 选一个 ca.crt / server.crt（PEM），文本交给原生层持久化（NasNative.setCa），
  // 原生 HTTPS 转发就信任它。证书只存在这台设备上，绝不上行。
  // 原生没有 setCa（旧版壳）时整行不出现，避免点了没反应。
  function caStatusText(pem) {
    var n = (String(pem).match(/-----BEGIN CERTIFICATE-----/g) || []).length;
    if (!n) return '未导入：公开的 Let\'s Encrypt 等证书无需导入；NAS 用自签证书时才需要';
    var name = '';
    try { name = localStorage.getItem('nn-ca-name') || ''; } catch (e) { /* 隐私模式 */ }
    return '已导入 ' + n + ' 张证书' + (name ? '（' + name + '）' : '') + '，本机 HTTPS 连接会额外信任它们';
  }

  function refreshCaStatus() {
    var el = document.getElementById('nn-ca-status');
    if (!el || !window.NasNative || typeof window.NasNative.getCa !== 'function') return;
    var pem = '';
    try { pem = window.NasNative.getCa() || ''; } catch (e) { /* 桥异常按未导入 */ }
    el.textContent = caStatusText(pem);
  }

  function injectCaRow(panel) {
    if (document.getElementById('nn-ca-wrap')) return;
    var api = window.NasNative;
    if (!api || typeof api.setCa !== 'function' || typeof api.getCa !== 'function') return;
    var anchor = document.getElementById('nn-server-wrap');
    var wrap = document.createElement('div');
    wrap.id = 'nn-ca-wrap';
    wrap.innerHTML =
      '<label for="nn-ca-file">本地 CA 证书（自家 HTTPS 服务）</label>' +
      '<div id="nn-ca-row" style="display:flex;gap:8px;align-items:center;margin:6px 0 4px">' +
      '<input id="nn-ca-file" type="file" accept=".crt,.pem,.cer,.der" style="flex:1;min-width:0;font-size:13px">' +
      '<button id="nn-ca-clear" type="button" style="padding:8px 14px;border-radius:8px;border:1px solid #777;background:#e8e8e8;cursor:pointer">清除</button>' +
      '</div>' +
      '<p id="nn-ca-status" class="muted tiny"></p>';
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
    else panel.appendChild(wrap);

    refreshCaStatus();

    var fileInput = document.getElementById('nn-ca-file');
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      if (!f) return;
      if (f.size > 262144) { toast('证书文件过大（超过 256KB），请选择 ca.crt 这类小文件'); fileInput.value = ''; return; }
      if (typeof FileReader !== 'function') { toast('当前系统组件不支持读取文件'); fileInput.value = ''; return; }
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result || '');
        if (text.indexOf('-----BEGIN CERTIFICATE-----') < 0) {
          toast('这个文件不是 PEM 证书：需要 .crt/.pem（含 -----BEGIN CERTIFICATE-----）');
          fileInput.value = '';
          return;
        }
        var ret = '';
        try { ret = api.setCa(text) || ''; } catch (e) { ret = '桥调用失败'; }
        if (ret === 'ok') {
          try { localStorage.setItem('nn-ca-name', String(f.name || '')); } catch (e) { /* 隐私模式 */ }
          toast('CA 证书已导入');
        } else {
          toast('导入失败：' + (ret || '未知错误'));
        }
        refreshCaStatus();
        fileInput.value = '';
      };
      reader.onerror = function () { toast('读取证书失败'); fileInput.value = ''; };
      reader.readAsText(f, 'utf-8');
    });
    document.getElementById('nn-ca-clear').addEventListener('click', function () {
      try { api.clearCa(); } catch (e) { /* 忽略 */ }
      try { localStorage.removeItem('nn-ca-name'); } catch (e) { /* 忽略 */ }
      refreshCaStatus();
      toast('已清除导入的证书');
    });
  }

  function tryInject(rounds) {
    if (injectServerRow()) return;
    if (rounds > 0) setTimeout(function () { tryInject(rounds - 1); }, 400);
  }

  // app.js 每次打开「设置」都会派发这个事件：按原生持久化值回填地址、账户与 CA 状态，
  // 保证在别处改过配置后打开设置看到的一定是当前真值。
  document.addEventListener('nn:settings-open', function () {
    try { fillConnectForm(); } catch (e) { /* 忽略桥异常 */ }
    refreshCaStatus();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { tryInject(12); });
  } else {
    tryInject(12);
  }
})();
