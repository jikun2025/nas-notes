/* compat.js — 鸿蒙 7.0 / 卓易通 及老 WebView 兼容垫片（零依赖，纯 ES5 语法）
 *
 * 必须排在所有其它脚本之前：这个文件本身要能在尽量老的 JS 引擎上解析，
 * 所以全篇只用 var / function，不用 let、const、箭头函数、可选链、可选
 * catch 绑定、模板字符串等新语法。缺什么补什么，补不了的（如 crypto.subtle）
 * 只记录能力报告，不降低加密强度。
 *
 * 补齐的都是 app.js / md.js / _bridge.js 实际用到的 API：
 *   TextEncoder/TextDecoder（非安全上下文下的纯 JS 加解密兜底会用到）、
 *   String/Array 的 ES2015+ 方法、Object.assign、Array.from、
 *   NodeList.forEach、Element.closest/remove、Blob.text。
 * 加密相关能力（crypto.subtle / getRandomValues）绝不提供弱随机兜底：
 * 缺失时 cryptofb.js 会接管，getRandomValues 缺失则明确报诊断而不是静默降级。
 */
(function (g) {
  'use strict';

  var degraded = [];

  // ---------- UTF-8 TextEncoder / TextDecoder（仅在原生缺失时接管） ----------
  function utf8Encode(str) {
    var text = String(str), out = [], i, code, low, cp;
    for (i = 0; i < text.length; i += 1) {
      code = text.charCodeAt(i);
      cp = code;
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
        low = text.charCodeAt(i + 1);
        if (low >= 0xDC00 && low <= 0xDFFF) {
          cp = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
          i += 1;
        }
      }
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F));
      else if (cp < 0x10000) out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      else out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
                    0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    }
    return new Uint8Array(out);
  }

  function utf8Decode(bytes) {
    var view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var out = '', i = 0, b1, b2, b3, b4, cp;
    while (i < view.length) {
      b1 = view[i]; i += 1;
      if (b1 < 0x80) { out += String.fromCharCode(b1); continue; }
      if (b1 >= 0xC2 && b1 <= 0xDF && i < view.length) {
        b2 = view[i]; i += 1;
        out += String.fromCharCode(((b1 & 0x1F) << 6) | (b2 & 0x3F));
        continue;
      }
      if (b1 >= 0xE0 && b1 <= 0xEF && i + 1 < view.length) {
        b2 = view[i]; b3 = view[i + 1]; i += 2;
        cp = ((b1 & 0x0F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F);
        out += String.fromCharCode(cp);
        continue;
      }
      if (b1 >= 0xF0 && b1 <= 0xF4 && i + 2 < view.length) {
        b2 = view[i]; b3 = view[i + 1]; b4 = view[i + 2]; i += 3;
        cp = ((b1 & 0x07) << 18) | ((b2 & 0x3F) << 12) | ((b3 & 0x3F) << 6) | (b4 & 0x3F);
        cp -= 0x10000;
        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
        continue;
      }
      out += '\uFFFD';
    }
    return out;
  }

  if (typeof g.TextEncoder !== 'function') {
    g.TextEncoder = function () {};
    g.TextEncoder.prototype.encode = function (s) { return utf8Encode(s); };
    degraded.push('TextEncoder(垫片)');
  }
  if (typeof g.TextDecoder !== 'function') {
    g.TextDecoder = function () {};
    g.TextDecoder.prototype.decode = function (b) { return b == null ? '' : utf8Decode(b); };
    degraded.push('TextDecoder(垫片)');
  }

  // ---------- ES2015+ 常用方法 ----------
  if (!String.prototype.includes) {
    String.prototype.includes = function (s, pos) { return this.indexOf(s, pos || 0) !== -1; };
    degraded.push('String.includes');
  }
  if (!String.prototype.startsWith) {
    String.prototype.startsWith = function (s, pos) { return this.indexOf(s, pos || 0) === (pos || 0); };
  }
  if (!String.prototype.endsWith) {
    String.prototype.endsWith = function (s) {
      var i = this.length - String(s).length;
      return i >= 0 && this.indexOf(s, i) === i;
    };
  }
  if (!String.prototype.padStart) {
    String.prototype.padStart = function (len, pad) {
      var s = String(this), fill = String(pad || ' '), need = len - s.length, out = '';
      while (out.length < need) out += fill;
      return out.slice(0, need) + s;
    };
    degraded.push('String.padStart');
  }
  if (!Array.prototype.includes) {
    Array.prototype.includes = function (v) {
      for (var i = 0; i < this.length; i += 1) {
        if (this[i] === v || (this[i] !== this[i] && v !== v)) return true;
      }
      return false;
    };
    degraded.push('Array.includes');
  }
  if (!Array.prototype.find) {
    Array.prototype.find = function (fn, ctx) {
      for (var i = 0; i < this.length; i += 1) if (fn.call(ctx, this[i], i, this)) return this[i];
      return undefined;
    };
    degraded.push('Array.find');
  }
  if (!Object.assign) {
    Object.assign = function (target) {
      if (target == null) throw new TypeError('Object.assign: null target');
      var out = Object(target), i, k, src;
      for (i = 1; i < arguments.length; i += 1) {
        src = arguments[i];
        if (src == null) continue;
        for (k in src) if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
      }
      return out;
    };
    degraded.push('Object.assign');
  }
  if (!Number.isFinite) {
    Number.isFinite = function (v) { return typeof v === 'number' && isFinite(v); };
  }
  if (typeof Array.from !== 'function') {
    Array.from = function (items, mapFn, ctx) {
      if (items == null) throw new TypeError('Array.from: null');
      var list = Object(items), out = [], i = 0, len = list.length >>> 0, step, it, sym;
      if (typeof Symbol !== 'undefined' && Symbol.iterator && list[Symbol.iterator]) {
        it = list[Symbol.iterator]();
        while (!(step = it.next()).done) {
          out.push(mapFn ? mapFn.call(ctx, step.value, i) : step.value);
          i += 1;
        }
        return out;
      }
      for (i = 0; i < len; i += 1) out.push(mapFn ? mapFn.call(ctx, list[i], i) : list[i]);
      return out;
    };
    degraded.push('Array.from');
  }

  // ---------- DOM 便捷方法（老 WebView 常见缺口） ----------
  function matchesSelector(el, sel) {
    var fn = el.matches || el.webkitMatchesSelector || el.msMatchesSelector || el.mozMatchesSelector;
    return fn ? fn.call(el, sel) : false;
  }
  if (typeof Element !== 'undefined') {
    if (!Element.prototype.closest) {
      Element.prototype.closest = function (sel) {
        var node = this;
        while (node && node.nodeType === 1) {
          if (matchesSelector(node, sel)) return node;
          node = node.parentElement || node.parentNode;
        }
        return null;
      };
      degraded.push('Element.closest');
    }
    if (!Element.prototype.remove) {
      Element.prototype.remove = function () {
        if (this.parentNode) this.parentNode.removeChild(this);
      };
      degraded.push('Element.remove');
    }
  }
  [typeof NodeList !== 'undefined' ? NodeList : null,
   typeof HTMLCollection !== 'undefined' ? HTMLCollection : null].forEach(function (Ctor) {
    if (Ctor && !Ctor.prototype.forEach) {
      Ctor.prototype.forEach = function (fn, ctx) {
        for (var i = 0; i < this.length; i += 1) fn.call(ctx, this[i], i, this);
      };
      degraded.push('NodeList.forEach');
    }
  });
  if (typeof Blob === 'function' && !Blob.prototype.text && typeof FileReader === 'function') {
    Blob.prototype.text = function () {
      var blob = this;
      return new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result)); };
        fr.onerror = function () { reject(fr.error || new Error('FileReader failed')); };
        fr.readAsText(blob, 'utf-8');
      });
    };
    degraded.push('Blob.text(FileReader)');
  }

  // ---------- 能力报告（供诊断与静态回归） ----------
  var nav = g.navigator || {};
  var caps = {
    subtle: Boolean(g.crypto && g.crypto.subtle),
    cryptoRandom: Boolean(g.crypto && typeof g.crypto.getRandomValues === 'function'),
    textEncoder: true,
    fetch: typeof g.fetch === 'function',
    promise: typeof g.Promise === 'function',
    indexedDB: Boolean(g.indexedDB),
    dialogModal: Boolean(g.HTMLDialogElement && g.HTMLDialogElement.prototype
      && g.HTMLDialogElement.prototype.showModal),
    serviceWorker: 'serviceWorker' in nav,
    blobText: Boolean(typeof Blob === 'function' && Blob.prototype.text),
    degraded: degraded,
    ua: nav.userAgent || ''
  };
  g.__NN_CAPS__ = caps;

  if (!caps.cryptoRandom) {
    // 绝不提供 Math.random 兜底：那会直接破坏 AES-GCM 的 IV/密钥随机性。
    console.error('[compat] crypto.getRandomValues 不可用，加解密无法安全进行');
  } else if (degraded.length) {
    console.warn('[compat] 已启用兼容垫片：' + degraded.join(', '));
  }
})(typeof self !== 'undefined' ? self : this);
