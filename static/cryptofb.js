/* cryptofb.js — 非安全上下文（http://局域网IP 等）下的 WebCrypto 兼容层。
 *
 * 浏览器只在“安全上下文”（HTTPS / localhost）暴露 crypto.subtle；通过
 * http://192.168.5.10:28080 访问时 crypto.subtle 为 undefined，首次创建
 * 口令会在 importKey 处抛 "Cannot read properties of undefined"。本文件
 * 仅在 crypto.subtle 缺失时装载，用零依赖纯 JS 补齐 app.js 用到的最小
 * 接口面：importKey('raw',…,'PBKDF2') → deriveKey(PBKDF2-HMAC-SHA256 →
 * AES-256-GCM) → encrypt/decrypt（12B IV，输出 = 密文 || 16B tag）。
 * 密文格式与原生 WebCrypto / Node crypto 完全一致，不改变存储结构；
 * 原生可用（HTTPS、localhost）时本文件不做任何事。
 *
 * 说明：这是可用性兜底，纯 JS 实现无恒定时间保证；若想更稳妥仍建议配
 * HTTPS 反代。口令派生的密钥永不出设备、服务端只见密文，性质不变。
 */
(function () {
  'use strict';
  var g = globalThis;
  var expose = g.__cryptofb_export_internals__ === true; // Node 桩测钩子
  if (!expose && g.crypto && g.crypto.subtle &&
      typeof g.crypto.subtle.importKey === 'function') {
    return; // 原生可用，无需兜底
  }

  // ---------- SHA-256（FIPS 180-4，常量对照标准实现核验） ----------
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }

  function sha256Bytes(msg) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var i, off, l = msg.length;
    var padLen = (((l + 9 + 63) >> 6) << 6);
    var buf = new Uint8Array(padLen);
    buf.set(msg);
    buf[l] = 0x80;
    var dv = new DataView(buf.buffer);
    dv.setUint32(padLen - 8, Math.floor(l * 8 / 4294967296));
    dv.setUint32(padLen - 4, (l * 8) >>> 0);
    var W = new Uint32Array(64);
    for (off = 0; off < padLen; off += 64) {
      for (i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
      for (i = 16; i < 64; i++) {
        var x = W[i - 15], y = W[i - 2];
        var s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
        var s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], h2 = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        var ch = ((e & f) ^ ((~e) & h2)) >>> 0;
        var T1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
        var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        var T2 = (S0 + maj) >>> 0;
        h = h2; h2 = f; f = e; e = (d + T1) >>> 0;
        d = c; c = b; b = a; a = (T1 + T2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + h2) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    var out = new Uint8Array(32);
    var odv = new DataView(out.buffer);
    for (i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
    return out;
  }

  function hmacSha256(keyBytes, msgBytes) {
    var key = keyBytes, i;
    if (key.length > 64) key = sha256Bytes(key);
    var inner = new Uint8Array(64 + msgBytes.length);
    var outer = new Uint8Array(96);
    for (i = 0; i < 64; i++) {
      var kb = i < key.length ? key[i] : 0;
      inner[i] = kb ^ 0x36;
      outer[i] = kb ^ 0x5c;
    }
    inner.set(msgBytes, 64);
    outer.set(sha256Bytes(inner), 64);
    return sha256Bytes(outer);
  }

  // ---------- PBKDF2-HMAC-SHA256（WebCrypto 默认 SHA-256） ----------
  function pbkdf2(password, salt, iterations, dkLen) {
    var pw = hmacPadKey(password);
    var blocks = Math.ceil(dkLen / 32);
    var out = new Uint8Array(blocks * 32);
    var msgLen = salt.length + 4;
    var msg = new Uint8Array(msgLen);
    msg.set(salt);
    var dv = new DataView(msg.buffer);
    var o = 0;
    for (var b = 1; b <= blocks; b++) {
      dv.setUint32(salt.length, b);
      var u = hmacWithPad(pw, msg);          // U1 = PRF(P, S || INT(b))
      var t = u.slice();
      for (var it = 1; it < iterations; it++) {
        u = hmacWithPad(pw, u);              // Uc = PRF(P, Uc-1)
        for (var i = 0; i < 32; i++) t[i] ^= u[i];
      }
      out.set(t.subarray(0, Math.min(32, dkLen - o)), o);
      o += 32;
    }
    return out.subarray(0, dkLen);
  }

  // 分块异步 PBKDF2：310k 次迭代在手机上要好几秒，同步跑会冻结页面。
  // 每 chunk 次迭代让出一个宏任务，UI 保持响应（按钮此时已禁用）。
  function pbkdf2Async(password, salt, iterations, dkLen) {
    var pw = hmacPadKey(password);
    var blocks = Math.ceil(dkLen / 32);
    var out = new Uint8Array(blocks * 32);
    var msg = new Uint8Array(salt.length + 4);
    msg.set(salt);
    var dv = new DataView(msg.buffer);
    var chunk = 25000;
    return new Promise(function (resolve, reject) {
      var b = 1, o = 0, t, u, remaining;
      function startBlock() {
        if (b > blocks) { resolve(out.subarray(0, dkLen)); return; }
        dv.setUint32(salt.length, b);
        u = hmacWithPad(pw, msg);
        t = u.slice();
        remaining = iterations - 1;
        setTimeout(step, 0);
      }
      function step() {
        try {
          var stopAt = Math.max(0, remaining - chunk);
          while (remaining > stopAt) {
            u = hmacWithPad(pw, u);
            for (var i = 0; i < 32; i++) t[i] ^= u[i];
            remaining--;
          }
          if (remaining > 0) { setTimeout(step, 0); return; }
          out.set(t.subarray(0, Math.min(32, dkLen - o)), o);
          o += 32; b++;
          startBlock();
        } catch (error) { reject(error); }
      }
      startBlock();
    });
  }

  // PBKDF2 热路径：密钥只填充一次，每轮仅压缩两个块。
  function hmacPadKey(key) {
    var k = key.length > 64 ? sha256Bytes(key) : key;
    var ipad = new Uint8Array(64), opad = new Uint8Array(64);
    for (var i = 0; i < 64; i++) {
      var kb = i < k.length ? k[i] : 0;
      ipad[i] = kb ^ 0x36;
      opad[i] = kb ^ 0x5c;
    }
    return { ipad: ipad, opad: opad };
  }

  function hmacWithPad(padded, msg) {
    var inner = new Uint8Array(64 + msg.length);
    inner.set(padded.ipad);
    inner.set(msg, 64);
    var outer = new Uint8Array(96);
    outer.set(padded.opad);
    outer.set(sha256Bytes(inner), 64);
    return sha256Bytes(outer);
  }

  // ---------- AES（仅加密方向；GCM 解密也只用正向分组） ----------
  // S-box 由 GF(2^8) 求逆 + 仿射变换生成，免手写 256 项常量表出错。
  var SBOX = (function () {
    var exp = new Uint8Array(256), log = new Uint8Array(256);
    var x = 1;
    for (var i = 0; i < 255; i++) {
      exp[i] = x;
      log[x] = i;
      // 3 是 GF(2^8) 的本原元（2 不是：它只生成 51 阶子群），x·3 = x·2 ⊕ x
      x = (x ^ ((x << 1) ^ ((x & 0x80) ? 0x1b : 0))) & 0xff;
    }
    var sbox = new Uint8Array(256);
    for (var b = 0; b < 256; b++) {
      var inv = b === 0 ? 0 : exp[(255 - log[b]) % 255];
      var v = inv;
      inv = (inv << 1 | inv >>> 7) & 0xff;
      v ^= inv;
      inv = (inv << 1 | inv >>> 7) & 0xff;
      v ^= inv;
      inv = (inv << 1 | inv >>> 7) & 0xff;
      v ^= inv;
      inv = (inv << 1 | inv >>> 7) & 0xff;
      v ^= inv;
      sbox[b] = (v ^ 0x63) & 0xff;
    }
    return sbox;
  })();

  var RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

  function subWord(w) {
    return ((SBOX[(w >>> 24) & 0xff] << 24) | (SBOX[(w >>> 16) & 0xff] << 16) |
            (SBOX[(w >>> 8) & 0xff] << 8) | SBOX[w & 0xff]) >>> 0;
  }

  // AES-256 密钥扩展（Nk=8, Nr=14, 60 个字）
  function expandKey(key) {
    var w = new Uint32Array(60), i;
    var kv = new DataView(key.buffer, key.byteOffset, key.byteLength);
    for (i = 0; i < 8; i++) w[i] = kv.getUint32(i * 4);
    for (i = 8; i < 60; i++) {
      var t = w[i - 1];
      if (i % 8 === 0) {
        t = ((t << 8) | (t >>> 24)) >>> 0;           // RotWord
        // RCON 异或到字的最高字节（a0），不是最低字节
        t = (subWord(t) ^ (RCON[i / 8 - 1] << 24)) >>> 0;
      } else if (i % 8 === 4) {
        t = subWord(t);
      }
      w[i] = (w[i - 8] ^ t) >>> 0;
    }
    return w;
  }

  function xtime(b) { return ((b << 1) ^ ((b & 0x80) ? 0x1b : 0)) & 0xff; }

  // 单块 AES 加密：state 为 16 字节（列主序，标准布局）
  function encryptBlock(w, state) {
    var r, c, i, t, s = state;
    var wv = new DataView(s.buffer, s.byteOffset, 16);
    for (c = 0; c < 4; c++) {
      var k = w[c];
      wv.setUint32(c * 4, wv.getUint32(c * 4) ^ k);
    }
    for (r = 1; r <= 14; r++) {
      for (i = 0; i < 16; i++) s[i] = SBOX[s[i]];                    // SubBytes
      t = s.slice();                                                  // ShiftRows
      s[1] = t[5];  s[5] = t[9];  s[9] = t[13]; s[13] = t[1];
      s[2] = t[10]; s[6] = t[14]; s[10] = t[2]; s[14] = t[6];
      s[3] = t[15]; s[7] = t[3];  s[11] = t[7]; s[15] = t[11];
      if (r !== 14) {                                                 // MixColumns
        for (c = 0; c < 4; c++) {
          var b = c * 4;
          var a0 = s[b], a1 = s[b + 1], a2 = s[b + 2], a3 = s[b + 3];
          s[b]     = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
          s[b + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
          s[b + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
          s[b + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3);
        }
      }
      var s2 = new DataView(s.buffer, s.byteOffset, 16);
      for (c = 0; c < 4; c++) {
        var kk = w[r * 4 + c];
        s2.setUint32(c * 4, s2.getUint32(c * 4) ^ kk);
      }
    }
    return s;
  }

  // ---------- GF(2^128) 乘法与 GHASH（SP 800-38D） ----------
  // 位序约定：bit0 = 字节 0 的 MSB；乘 x = 整体右移 1 位，溢出时 XOR 0xe1 到首字节。
  // 零分配实现：ghash 对每 MB 密文都要走一遍，热点上不做任何 slice。
  function gmulInto(Z, V, X) {
    // Z = X · V（调用后 V 内容会被破坏）
    for (var j = 0; j < 16; j++) Z[j] = 0;
    for (var i = 0; i < 128; i++) {
      if ((X[i >> 3] & (0x80 >> (i & 7))) !== 0) {
        for (j = 0; j < 16; j++) Z[j] ^= V[j];
      }
      var lsb = V[15] & 1;
      for (j = 15; j > 0; j--) V[j] = ((V[j] >>> 1) | ((V[j - 1] & 1) << 7)) & 0xff;
      V[0] >>>= 1;
      if (lsb) V[0] ^= 0xe1;
    }
  }

  function ghash(H, data) {
    var Y = new Uint8Array(16), Z = new Uint8Array(16), V = new Uint8Array(16);
    var j, off;
    for (off = 0; off < data.length; off += 16) {
      for (j = 0; j < 16; j++) Y[j] ^= data[off + j] || 0;
      V.set(H);
      gmulInto(Z, V, Y);
      for (j = 0; j < 16; j++) { Y[j] = Z[j]; }
    }
    return Y;
  }

  // 4-bit 查表加速：每密钥建 16 张表（约 4KB），每块 32 次查表替代 128 轮迭代。
  // T[j][v] = GFMUL(v 放到第 j 个半字节的块, H)。j 偶→高半字节，j 奇→低半字节。
  function buildTables(H) {
    var T = [], j, v;
    for (j = 0; j < 32; j++) {
      var tbl = [];
      for (v = 0; v < 16; v++) {
        var X = new Uint8Array(16);
        X[j >> 1] = (j & 1) ? v : ((v << 4) & 0xff);
        var Z = new Uint8Array(16), V = H.slice();
        gmulInto(Z, V, X);
        tbl.push(Z);
      }
      T.push(tbl);
    }
    return T;
  }

  function ghashTable(T, data) {
    var Y = new Uint8Array(16), N = new Uint8Array(16);
    var k, j, off;
    for (off = 0; off < data.length; off += 16) {
      for (k = 0; k < 16; k++) Y[k] ^= data[off + k] || 0;
      for (k = 0; k < 16; k++) N[k] = 0;
      for (j = 0; j < 32; j++) {
        var yb = Y[j >> 1];
        var nib = (j & 1) ? (yb & 15) : (yb >> 4);
        var t = T[j][nib];
        for (k = 0; k < 16; k++) N[k] ^= t[k];
      }
      for (k = 0; k < 16; k++) Y[k] = N[k];
    }
    return Y;
  }

  // ---------- AES-GCM（NIST SP 800-38D，IV=12B，tag=16B，无 AAD） ----------
  // 12 字节 IV 的 GCM：J0 = IV||0x000001（tag 掩码），首个 Keystream 块用 IV||0x000002。
  function gcmEncrypt(w, iv, plaintext, T) {
    var counter = new Uint8Array(16);
    var ks = new Uint8Array(16);
    var out = new Uint8Array(plaintext.length);
    var j0, i, off, n;
    counter.set(iv);
    counter[15] = 1;
    var scratch = new Uint8Array(16);
    scratch.set(iv); scratch[15] = 1;
    j0 = encryptBlock(w, scratch.slice());         // tag mask = E(K, J0)
    var H = encryptBlock(w, new Uint8Array(16));   // H = E(K, 0^128)（12B IV 特例）
    if (!T) T = buildTables(H);
    for (off = 0; off < plaintext.length; off += 16) {
      // 计数器 +1（32 位大端，从 IV||1 起）
      for (i = 15; i >= 12; i--) { counter[i] = (counter[i] + 1) & 0xff; if (counter[i]) break; }
      ks.set(counter);
      encryptBlock(w, ks);
      n = Math.min(16, plaintext.length - off);
      for (i = 0; i < n; i++) out[off + i] = plaintext[off + i] ^ ks[i];
    }
    // GHASH(C 零填充到 16B 块 || len(A)=0(64b) || len(C)*8(64b))——注意是对密文 C，不是明文
    var total = (plaintext.length + 15 & ~15) + 16;
    var ghashIn = new Uint8Array(total);
    ghashIn.set(out);
    var lv = new DataView(ghashIn.buffer);
    lv.setUint32(total - 8, Math.floor(plaintext.length * 8 / 4294967296));
    lv.setUint32(total - 4, (plaintext.length * 8) >>> 0);
    var S = ghashTable(T, ghashIn);
    // tag = GHASH(...) ⊕ E(K, J0)
    var tag = new Uint8Array(16);
    for (i = 0; i < 16; i++) tag[i] = S[i] ^ j0[i];
    return { ciphertext: out, tag: tag };
  }

  function gcmDecrypt(w, iv, ciphertext, tag, T) {
    // GCM 解密只需正向分组：先 GHASH 验 tag，再 CTR 还原明文。
    var j0, scratch = new Uint8Array(16), i;
    scratch.set(iv); scratch[15] = 1;
    j0 = encryptBlock(w, scratch.slice());
    var H = encryptBlock(w, new Uint8Array(16));   // H = E(K, 0^128)
    if (!T) T = buildTables(H);
    var total = (ciphertext.length + 15 & ~15) + 16;
    var ghashIn = new Uint8Array(total);
    ghashIn.set(ciphertext);
    var lv = new DataView(ghashIn.buffer);
    lv.setUint32(total - 8, Math.floor(ciphertext.length * 8 / 4294967296));
    lv.setUint32(total - 4, (ciphertext.length * 8) >>> 0);
    var S = ghashTable(T, ghashIn);
    var expected = new Uint8Array(16);
    for (i = 0; i < 16; i++) expected[i] = S[i] ^ j0[i];
    // 定长比较（兜底层不追求严格恒定时间，但不做短路早退）
    var diff = 0;
    for (i = 0; i < 16; i++) diff |= expected[i] ^ tag[i];
    if (diff !== 0) throw new Error('decrypt failed');
    var out = new Uint8Array(ciphertext.length);
    var counter = new Uint8Array(16);
    counter.set(iv);
    counter[15] = 1;   // CTR 起点与加密端一致：首个数据块用 IV‖2（IV‖1 归 J0）
    var ks = new Uint8Array(16);
    var off, n;
    for (off = 0; off < ciphertext.length; off += 16) {
      for (i = 15; i >= 12; i--) { counter[i] = (counter[i] + 1) & 0xff; if (counter[i]) break; }
      ks.set(counter);
      encryptBlock(w, ks);
      n = Math.min(16, ciphertext.length - off);
      for (i = 0; i < n; i++) out[off + i] = ciphertext[off + i] ^ ks[i];
    }
    return out;
  }

  // ---------- WebCrypto 风格接口（仅覆盖 app.js 的调用面） ----------
  function toBytes(x) {
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    throw new TypeError('expected BufferSource');
  }

  function importKey(format, keyData, alg, extractable, keyUsages) {
    if (format !== 'raw') {
      return Promise.reject(new Error('unsupported importKey: ' + format + '/' + alg));
    }
    if (alg === 'PBKDF2') {
      return Promise.resolve({ __fbk: 'PBKDF2-raw', bytes: toBytes(keyData) });
    }
    if (alg === 'AES-GCM' || (alg && alg.name === 'AES-GCM')) {
      // wkey 导入：32 字节原始密钥直接扩展成 AES 轮密钥（GCM 查表在
      // encrypt/decrypt 里经 lazyGcm 惰性挂上）。
      var raw = toBytes(keyData);
      if (raw.length !== 32) return Promise.reject(new Error('importKey: AES-GCM needs 256-bit key'));
      return Promise.resolve({ __fbk: 'AES-GCM', w: expandKey(raw) });
    }
    return Promise.reject(new Error('unsupported importKey: ' + format + '/' + alg));
  }

  function deriveBits(alg, baseKey, length) {
    if (!baseKey || baseKey.__fbk !== 'PBKDF2-raw') {
      return Promise.reject(new Error('deriveBits: invalid base key'));
    }
    if (alg.name !== 'PBKDF2' || String(alg.hash).toUpperCase() !== 'SHA-256') {
      return Promise.reject(new Error('deriveBits: unsupported params'));
    }
    if (!length || length % 8 !== 0) {
      return Promise.reject(new Error('deriveBits: invalid length'));
    }
    return pbkdf2Async(baseKey.bytes, toBytes(alg.salt), alg.iterations, length / 8)
      .then(function (raw) { return raw.buffer; });
  }

  function deriveKey(alg, baseKey, derivedKeyAlgorithm, extractable, keyUsages) {
    if (!baseKey || baseKey.__fbk !== 'PBKDF2-raw') {
      return Promise.reject(new Error('deriveKey: invalid base key'));
    }
    if (alg.name !== 'PBKDF2' || String(alg.hash).toUpperCase() !== 'SHA-256') {
      return Promise.reject(new Error('deriveKey: unsupported params'));
    }
    if (!derivedKeyAlgorithm || derivedKeyAlgorithm.name !== 'AES-GCM' || derivedKeyAlgorithm.length !== 256) {
      return Promise.reject(new Error('deriveKey: unsupported target'));
    }
    return Promise.resolve().then(function () {
      return pbkdf2Async(baseKey.bytes, toBytes(alg.salt), alg.iterations, 32);
    }).then(function (raw) {
      var key = { __fbk: 'AES-GCM', w: expandKey(raw) };
      // GCM 的 GHASH 子密钥（E(K,0^128)）与 32 张查表只算一次，挂到 key 上复用。
      var H = encryptBlock(key.w, new Uint8Array(16));
      key.__gcm = { H: H, T: buildTables(H) };
      return key;
    });
  }

  function encrypt(alg, key, data) {
    if (!key || key.__fbk !== 'AES-GCM' || alg.name !== 'AES-GCM') {
      return Promise.reject(new Error('encrypt: unsupported'));
    }
    try {
      var iv = toBytes(alg.iv);
      if (iv.length !== 12) throw new Error('IV must be 12 bytes');
      var g2 = key.__gcm || (key.__gcm = lazyGcm(key));
      var r = gcmEncrypt(key.w, iv, toBytes(data), g2.T);
      var out = new Uint8Array(r.ciphertext.length + 16);
      out.set(r.ciphertext);
      out.set(r.tag, r.ciphertext.length);
      return Promise.resolve(out.buffer);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function lazyGcm(key) {
    var H = encryptBlock(key.w, new Uint8Array(16));
    return { H: H, T: buildTables(H) };
  }

  function decrypt(alg, key, data) {
    if (!key || key.__fbk !== 'AES-GCM' || alg.name !== 'AES-GCM') {
      return Promise.reject(new Error('decrypt: unsupported'));
    }
    try {
      var buf = toBytes(data);
      if (buf.length < 16) throw new Error('ciphertext too short');
      var iv = toBytes(alg.iv);
      if (iv.length !== 12) throw new Error('IV must be 12 bytes');
      var g2 = key.__gcm || (key.__gcm = lazyGcm(key));
      var plain = gcmDecrypt(key.w, iv, buf.subarray(0, buf.length - 16), buf.subarray(buf.length - 16), g2.T);
      return Promise.resolve(plain.buffer);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  if (expose) {
    g.__cryptofb_internals__ = {
      sha256Bytes: sha256Bytes, hmacSha256: hmacSha256, pbkdf2: pbkdf2,
      expandKey: expandKey, encryptBlock: encryptBlock,
      gcmEncrypt: gcmEncrypt, gcmDecrypt: gcmDecrypt
    };
    return;
  }

  // 非安全上下文里 crypto.subtle 是 Crypto.prototype 上的 getter-only 属性，
  // 严格模式下直接赋值会抛 TypeError，必须走 defineProperty。
  if (!g.crypto) g.crypto = {};
  var subtleImpl = { importKey: importKey, deriveKey: deriveKey, deriveBits: deriveBits, encrypt: encrypt, decrypt: decrypt };
  try {
    Object.defineProperty(g.crypto, 'subtle', {
      value: subtleImpl, configurable: true, writable: true
    });
  } catch (error) {
    // 极端环境兜底：defineProperty 失败时挂到全局，app.js 侧按 window.__cryptofb_subtle__ 取
    g.__cryptofb_subtle__ = subtleImpl;
  }
})();
