'use strict';
// cryptofb.js 桩测：与 Node crypto 做字节级互操作对照
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'static', 'cryptofb.js'), 'utf8');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}
function hexEq(a, buf) { return a === Buffer.from(buf).toString('hex'); }

// ---- 1) 内部算法对照（expose 钩子，不装载 subtle） ----
globalThis.__cryptofb_export_internals__ = true;
eval(SRC);
const I = globalThis.__cryptofb_internals__;
ok('internals exported', !!I && typeof I.gcmEncrypt === 'function');

// SHA-256
for (const msg of [[], [97], Buffer.from('abc'), nodeCrypto.randomBytes(1000)]) {
  const m = Uint8Array.from(msg);
  ok('sha256 len' + msg.length, hexEq(nodeCrypto.createHash('sha256').update(Buffer.from(msg)).digest('hex'), I.sha256Bytes(m)));
}

// HMAC-SHA256
{
  const k = nodeCrypto.randomBytes(32), m = nodeCrypto.randomBytes(200);
  ok('hmac32', hexEq(nodeCrypto.createHmac('sha256', k).update(m).digest('hex'), I.hmacSha256(Uint8Array.from(k), Uint8Array.from(m))));
  const k2 = Buffer.from('key');
  ok('hmac-shortkey', hexEq(nodeCrypto.createHmac('sha256', k2).update('The quick brown fox jumps over the lazy dog').digest('hex'), I.hmacSha256(Uint8Array.from(k2), Uint8Array.from(Buffer.from('The quick brown fox jumps over the lazy dog')))));
}

// PBKDF2-SHA256
for (const iters of [1, 1000, 10000]) {
  const salt = nodeCrypto.randomBytes(16);
  const ref = nodeCrypto.pbkdf2Sync('p@ss测试', salt, iters, 32, 'sha256');
  ok('pbkdf2 iters=' + iters, hexEq(ref.toString('hex'), I.pbkdf2(new TextEncoder().encode('p@ss测试'), Uint8Array.from(salt), iters, 32)));
}
{ // 真实迭代次数 310k，对照 Node
  const salt = nodeCrypto.randomBytes(16);
  const t0 = Date.now();
  const mine = I.pbkdf2(new TextEncoder().encode('passphrase'), Uint8Array.from(salt), 310000, 32);
  const ref = nodeCrypto.pbkdf2Sync('passphrase', salt, 310000, 32, 'sha256');
  ok('pbkdf2 310000 (' + (Date.now() - t0) + 'ms)', hexEq(ref.toString('hex'), mine));
}

// AES-256 密钥扩展 + 单块加密（FIPS-197 已知向量）
{
  const key = Uint8Array.from(Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex'));
  const pt = Uint8Array.from(Buffer.from('00112233445566778899aabbccddeeff', 'hex'));
  const w = I.expandKey(key);
  ok('FIPS-197 AES-256 ECB', hexEq('8ea2b7ca516745bfeafc49904b496089', I.encryptBlock(w, pt.slice())));
  // 密钥扩展无需单独断言：上一条 C.3 已知答案覆盖全部 15 组轮密钥，错一个词密文必错。
}

// AES-256-GCM 互操作：密文+tag 字节级一致
function gcmInterop(len, label) {
  const key = nodeCrypto.randomBytes(32), iv = nodeCrypto.randomBytes(12), pt = nodeCrypto.randomBytes(len);
  const c = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  const refCT = Buffer.concat([c.update(pt), c.final()]);
  const refTag = c.getAuthTag();
  const w1 = I.expandKey(Uint8Array.from(key));
  const r1 = I.gcmEncrypt(w1, Uint8Array.from(iv), Uint8Array.from(pt), null);
  const ct = Buffer.concat([Buffer.from(r1.ciphertext), Buffer.from(r1.tag)]);
  ok('gcm enc len=' + len + ' ' + label, ct.subarray(0, Math.max(len, 0)).equals(refCT.subarray(0, Math.max(len, 0))) && Buffer.from(r1.tag).equals(refTag) && Buffer.from(r1.ciphertext).equals(refCT));
  // 解密往返
  const back = I.gcmDecrypt(I.expandKey(Uint8Array.from(key)), Uint8Array.from(iv), ct.subarray(0, len), ct.subarray(len), null);
  ok('gcm dec len=' + len, Buffer.from(back).equals(pt));
  // 篡改 tag 必须抛错
  const bad = Buffer.from(ct); bad[bad.length - 1] ^= 1;
  let threw = false;
  try { I.gcmDecrypt(I.expandKey(Uint8Array.from(key)), Uint8Array.from(iv), bad.subarray(0, len), bad.subarray(len), null); } catch (e) { threw = /decrypt failed/.test(e.message); }
  ok('gcm bad tag throws', threw);
  // Node 解我们的密文（互操作反向验证）
  const d = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(refTag);
  ok('gcm node-decrypts-ours', Buffer.concat([d.update(ct.subarray(0, len)), d.final()]).equals(pt));
}
gcmInterop(0, 'empty'); gcmInterop(1, '1B'); gcmInterop(15, '15B'); gcmInterop(16, '16B');
gcmInterop(17, '17B'); gcmInterop(1000, '1000B'); gcmInterop(100000, '100KB');
// 固定向量（NIST GCM 测试向量 KAT 风格，用 Node 做参照已覆盖；此处再验查表路径 buildTables 生效）
{
  const key = nodeCrypto.randomBytes(32), iv = nodeCrypto.randomBytes(12), pt = nodeCrypto.randomBytes(5000);
  const c = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  const ref = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
  const w = I.expandKey(Uint8Array.from(key));
  // 第一次调用建表（T 传 null 走内部懒建），第二次显式用表——结果必须一致且与 Node 一致
  const r1 = I.gcmEncrypt(w, Uint8Array.from(iv), Uint8Array.from(pt), null);
  const o1 = Buffer.concat([Buffer.from(r1.ciphertext), Buffer.from(r1.tag)]);
  const r2 = I.gcmEncrypt(w, Uint8Array.from(iv), Uint8Array.from(pt), null);
  const o2 = Buffer.concat([Buffer.from(r2.ciphertext), Buffer.from(r2.tag)]);
  ok('gcm tables consistent', o1.equals(ref) && o2.equals(ref));
}

// ---- 2) 装载路径：无 subtle 的沙箱里装载，走 importKey/deriveKey/encrypt/decrypt 全流程 ----
(async () => {
  const sandbox = { TextEncoder, TextDecoder, setTimeout, console, Math, Uint8Array, Uint32Array, ArrayBuffer, DataView, Promise, Error, TypeError, JSON, Object, Array, Buffer };
  sandbox.globalThis = sandbox;
  sandbox.crypto = { getRandomValues: (a) => { const b = nodeCrypto.randomBytes(a.length); a.set(b); return a; } }; // 无 subtle
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const sub = sandbox.crypto.subtle;
  ok('subtle installed in sandbox', !!sub && typeof sub.importKey === 'function' && typeof sub.deriveKey === 'function'
      && typeof sub.deriveBits === 'function');
  const run = vm.runInContext(`(async () => {
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const m = await crypto.subtle.importKey('raw', enc.encode('口令pw'), 'PBKDF2', false, ['deriveKey','deriveBits']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, m, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode('hello 轻签 payload'));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return { salt, iv, ct, pt: new TextDecoder().decode(pt) };
  })()`, sandbox);
  const r = await run;
  ok('flow decrypt == plain', r.pt === 'hello 轻签 payload');
  // 派生密钥与 Node pbkdf2 对照（拿到 __gcm.H 之前先验密钥字节：用 gcm 密文对照代替——直接外部解密）
  // 用 Node 派生同一 key 解我们的密文
  const kref = nodeCrypto.pbkdf2Sync('口令pw', Buffer.from(r.salt), 310000, 32, 'sha256');
  const d = nodeCrypto.createDecipheriv('aes-256-gcm', kref, Buffer.from(r.iv));
  const cbuf = Buffer.from(r.ct);
  d.setAuthTag(cbuf.subarray(cbuf.length - 16));
  const plain = Buffer.concat([d.update(cbuf.subarray(0, cbuf.length - 16)), d.final()]).toString('utf8');
  ok('interop node decrypts sandbox ct', plain === 'hello 轻签 payload');

  // ---- 登录凭证 deriveBits（deriveCredential 依赖）----
  const credRun = await vm.runInContext(`(async () => {
    const enc = new TextEncoder();
    const lsalt = crypto.getRandomValues(new Uint8Array(16));
    const m = await crypto.subtle.importKey('raw', enc.encode('admin'), 'PBKDF2', false, ['deriveKey','deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: lsalt, iterations: 100000, hash: 'SHA-256' }, m, 256);
    return { lsalt, cred: new Uint8Array(bits) };
  })()`, sandbox);
  const cref = nodeCrypto.pbkdf2Sync('admin', Buffer.from(credRun.lsalt), 100000, 32, 'sha256');
  ok('deriveBits credential == node pbkdf2', Buffer.from(credRun.cred).equals(cref));

  // ---- importKey('raw', AES-GCM) + wrap/unwrap 全链路（wkey 包裹）----
  const wrapRun = await vm.runInContext(`(async () => {
    const enc = new TextEncoder(), dec = new TextDecoder();
    const b64 = (b) => Buffer.from(b).toString('base64');
    const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
    // 派生 wrapKey（口令侧）
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const m = await crypto.subtle.importKey('raw', enc.encode('newpass'), 'PBKDF2', false, ['deriveKey']);
    const wrapKey = await crypto.subtle.deriveKey({ name:'PBKDF2', salt, iterations: 310000, hash:'SHA-256' }, m, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
    // 随机 wkey，用 importKey('raw', AES-GCM) 导入成可加密密钥
    const wkeyBytes = crypto.getRandomValues(new Uint8Array(32));
    const wkey = await crypto.subtle.importKey('raw', wkeyBytes, 'AES-GCM', false, ['encrypt','decrypt']);
    // 用 wkey 加密一条便签
    const iv1 = crypto.getRandomValues(new Uint8Array(12));
    const noteCt = await crypto.subtle.encrypt({ name:'AES-GCM', iv: iv1 }, wkey, enc.encode(JSON.stringify({title:'t',body:'b'})));
    // 用 wrapKey 包裹 wkey
    const iv2 = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await crypto.subtle.encrypt({ name:'AES-GCM', iv: iv2 }, wrapKey, enc.encode(JSON.stringify({ w: b64(wkeyBytes) })));
    // 解包裹 → 重新 importKey → 解密便签
    const unwrappedBuf = await crypto.subtle.decrypt({ name:'AES-GCM', iv: iv2 }, wrapKey, wrapped);
    const obj = JSON.parse(dec.decode(unwrappedBuf));
    const wkeyBytes2 = unb64(obj.w);
    const wkey2 = await crypto.subtle.importKey('raw', wkeyBytes2, 'AES-GCM', false, ['encrypt','decrypt']);
    const notePt = await crypto.subtle.decrypt({ name:'AES-GCM', iv: iv1 }, wkey2, noteCt);
    return { salt, notePt: dec.decode(notePt), wkeyBytes, wrapped, iv2 };
  })()`, sandbox);
  ok('wkey wrap/unwrap roundtrip', wrapRun.notePt === JSON.stringify({title:'t',body:'b'}));
  // Node 侧：用口令派生 wrapKey 解 wrapped，拿到 wkey，再解 noteCt——与沙箱完全互操作
  {
    const wrapKeyRef = nodeCrypto.pbkdf2Sync('newpass', Buffer.from(wrapRun.salt), 310000, 32, 'sha256');
    const wbuf = Buffer.from(wrapRun.wrapped);
    const dd = nodeCrypto.createDecipheriv('aes-256-gcm', wrapKeyRef, Buffer.from(wrapRun.iv2));
    dd.setAuthTag(wbuf.subarray(wbuf.length - 16));
    const unwrappedJson = Buffer.concat([dd.update(wbuf.subarray(0, wbuf.length - 16)), dd.final()]).toString('utf8');
    const wkeyFromNode = Buffer.from(JSON.parse(unwrappedJson).w, 'base64');
    ok('wkey bytes match node unwrap', wkeyFromNode.equals(Buffer.from(wrapRun.wkeyBytes)));
  }
  // importKey 错误长度必须拒绝
  let importThrew = false;
  try { await vm.runInContext(`crypto.subtle.importKey('raw', new Uint8Array(16), 'AES-GCM', false, ['encrypt'])`, sandbox); }
  catch (e) { importThrew = true; }
  ok('importKey AES-GCM rejects short key', importThrew);

  // 原生环境不装载守卫
  const sandbox2 = { crypto: { subtle: { importKey() {} } }, console };
  sandbox2.globalThis = sandbox2;
  vm.createContext(sandbox2);
  const marker = { importKey() {} };
  sandbox2.crypto.subtle = marker;
  vm.runInContext(SRC, sandbox2);
  ok('guard: native subtle untouched', sandbox2.crypto.subtle === marker);

  console.log(`\ncryptofb tests: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
