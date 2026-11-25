'use strict';
// 旧 verifier 加密库 → 新 wkey 包裹结构 的端到端迁移演练（零第三方依赖）。
//
// 用 node:sqlite 预注入 NAS 线上同款旧格式 vault（salt+verifier+310k，
// 口令密钥直加密笔记），起真实 server.py，按前端 handleUnlock /
// migrateLegacyVault / saveAccount 的调用序列走一遍：
//   登录 → 旧口令校验 → wkey 重加密 → replace 替换 vault →
//   改密（账户哈希+包裹原子替换）→ 新口令登录解包 → 解密全部笔记。
// 客户端侧加解密走 cryptofb.js internals（与前端 http 兜底实现同源、
// 已验与 WebCrypto/Node 字节级互操作），服务端为真实 server.py。
//
// 运行：node tools/test_legacy_migration.js   （NN_MIG_PORT 可覆盖端口）

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const nodeCrypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.NN_MIG_PORT || '18796');
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-mig-'));

const PBKDF2_ITER = 310000;
const LOGIN_ITERS = 100000;
const OLD_VAULT_PASS = 'old-secret-中文';   // 旧版锁屏加密口令（与登录口令不同）
const NEW_LOGIN_PASS = 'admin';             // 默认登录口令
const NEW_PASS_AFTER = 'brand-new-p@ss';    // 改密后的新口令

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

// ---------- 客户端加密原语（cryptofb internals，同前端 http 兜底） ----------
globalThis.__cryptofb_export_internals__ = true;
eval(fs.readFileSync(path.join(ROOT, 'static', 'cryptofb.js'), 'utf8'));
const I = globalThis.__cryptofb_internals__;
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

function deriveKeyBytes(passphrase, saltB64, iters) {
  return I.pbkdf2(enc.encode(passphrase), unb64(saltB64), iters, 32);
}
function gcmSeal(keyBytes, ptBytes) {          // → {iv, payload}（同 app.js encryptJSON）
  const iv = new Uint8Array(nodeCrypto.randomBytes(12));
  const r = I.gcmEncrypt(I.expandKey(keyBytes), iv, ptBytes, null);
  return { iv: b64(iv), payload: b64(Buffer.concat([Buffer.from(r.ciphertext), Buffer.from(r.tag)])) };
}
function gcmOpen(keyBytes, ivB64, payloadB64) { // → 明文 Uint8Array（失败抛错）
  const iv = unb64(ivB64), blob = unb64(payloadB64);
  return I.gcmDecrypt(I.expandKey(keyBytes), iv, blob.subarray(0, blob.length - 16), blob.subarray(blob.length - 16), null);
}
function sealJSON(keyBytes, value) { return gcmSeal(keyBytes, enc.encode(JSON.stringify(value))); }
function openJSON(keyBytes, ivB64, payloadB64) { return JSON.parse(dec.decode(gcmOpen(keyBytes, ivB64, payloadB64))); }
function wrapVaultB64(wrapKeyBytes, wkeyBytes) {  // 同 app.js wrapVault：iv:payload
  const s = sealJSON(wrapKeyBytes, { w: b64(wkeyBytes) });
  return s.iv + ':' + s.payload;
}
function unwrapVaultB64(wrapKeyBytes, wrapped) {
  const parts = String(wrapped).split(':');
  if (parts.length !== 2) throw new Error('bad wrapped format');
  const v = openJSON(wrapKeyBytes, parts[0], parts[1]);
  if (!v || typeof v.w !== 'string') throw new Error('bad wrapped payload');
  return unb64(v.w);
}

// ---------- 预注入旧格式库（模拟 NAS 现状：verifier + 1 条旧笔记） ----------
const legacySaltB64 = b64(nodeCrypto.randomBytes(16));
const legacyKey = deriveKeyBytes(OLD_VAULT_PASS, legacySaltB64, PBKDF2_ITER);

const vSeal = sealJSON(legacyKey, { check: 'nas-notes-vault-v1' });
const verifierField = vSeal.iv + ':' + vSeal.payload;

const notePlain = { title: '旧便签', body: '迁移演练正文', body_format: 'md', folder: '', attachments: [] };
const nSeal = sealJSON(legacyKey, notePlain);
const noteId = 'legacy-note-1';
const now = '2026-11-25T10:00:00.000Z';

const dbPath = path.join(DATA, 'notes.db');
{
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
    'CREATE TABLE notes (id TEXT PRIMARY KEY, iv TEXT NOT NULL DEFAULT \'\',' +
    ' payload TEXT NOT NULL DEFAULT \'\', created_at TEXT NOT NULL DEFAULT \'\',' +
    ' updated_at TEXT NOT NULL DEFAULT \'\', deleted INTEGER NOT NULL DEFAULT 0,' +
    ' device TEXT NOT NULL DEFAULT \'\');'
  );
  // 旧 vault：有 verifier、无 wrapped —— 与新库结构区分的关键
  db.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run(
    'vault', JSON.stringify({ salt: legacySaltB64, verifier: verifierField, iterations: PBKDF2_ITER, version: 1 })
  );
  db.prepare('INSERT INTO notes (id,iv,payload,created_at,updated_at,deleted,device) VALUES (?,?,?,?,?,0,?)')
    .run(noteId, nSeal.iv, nSeal.payload, now, now, 'olddev');
  db.close();
}

// ---------- 起真实服务器 ----------
const PY = process.env.NN_PYTHON || 'python';
const proc = spawn(PY, [path.join(ROOT, 'server.py')], {
  env: Object.assign({}, process.env, {
    PORT: String(PORT), DATA_DIR: DATA, STATIC_DIR: path.join(ROOT, 'static'),
  }),
  stdio: 'ignore',
});

async function req(method, urlPath, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Token'] = token;
  const res = await fetch(BASE + urlPath, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = {};
  try { json = await res.json(); } catch (e) { /* empty */ }
  return { status: res.status, body: json };
}

async function loginCredential(passphrase) {
  const s = await req('GET', '/api/login-salt?username=admin');
  return {
    saltB64: s.body.salt,
    credential: b64(I.pbkdf2(enc.encode(passphrase), unb64(s.body.salt), s.body.iterations || LOGIN_ITERS, 32)),
  };
}

(async () => {
  // 等待 /api/health 就绪
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      const res = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(1000) });
      up = res.ok;
    } catch (e) { await new Promise((r) => setTimeout(r, 250)); }
  }
  if (!up) throw new Error('server did not start');

  // ---- 前端 handleUnlock 序列 ----
  const lg = await loginCredential(NEW_LOGIN_PASS);
  let r = await req('POST', '/api/login', { username: 'admin', credential: lg.credential });
  ok('登录 admin/admin 200', r.status === 200 && Boolean(r.body.token));
  const token = r.body.token || '';

  let meta = (await req('GET', '/api/meta', undefined, token)).body;
  const isLegacy = Boolean(meta.verifier && !meta.wrapped);
  ok('GET meta 识别为旧库', isLegacy && meta.salt === legacySaltB64);

  // checkLegacyVerifier：旧口令派生 → 解 verifier
  let okVerifier = false;
  try {
    const v = openJSON(legacyKey, ...(meta.verifier.split(':')));
    okVerifier = v.check === 'nas-notes-vault-v1';
  } catch (e) { /* expected-false */ }
  ok('旧加密口令校验 verifier 通过', okVerifier);

  // 登录口令(admin)派生校验应失败 → 触发前端“补问旧加密口令”分支
  const keyLogin = deriveKeyBytes(NEW_LOGIN_PASS, meta.salt, meta.iterations);
  let loginDeriveFails = false;
  try { gcmOpen(keyLogin, ...meta.verifier.split(':')); } catch (e) { loginDeriveFails = true; }
  ok('登录口令≠旧库口令时校验失败（走补问分支）', loginDeriveFails);

  // migrateLegacyVault：新 salt+wrapKey(登录口令)+wkey → replace 替换 vault
  const migSaltB64 = b64(nodeCrypto.randomBytes(16));
  const wrapKey = deriveKeyBytes(NEW_LOGIN_PASS, migSaltB64, PBKDF2_ITER);
  const wkey = new Uint8Array(nodeCrypto.randomBytes(32));
  r = await req('PUT', '/api/meta', {
    salt: migSaltB64, wrapped: wrapVaultB64(wrapKey, wkey),
    iterations: PBKDF2_ITER, version: 1, replace: true,
  }, token);
  ok('replace 替换 vault 200', r.status === 200 && r.body.initialized === true);

  // 旧笔记：旧密文仍在 → 旧口令解密 → wkey 重加密 → PUT
  let notes = (await req('GET', '/api/notes', undefined, token)).body.notes || [];
  let note = notes.find((n) => n.id === noteId);
  ok('旧笔记仍在（旧密文）', Boolean(note) && note.payload === nSeal.payload);
  const legacyDecoded = openJSON(legacyKey, note.iv, note.payload);
  ok('旧口令解出正文', legacyDecoded.body === notePlain.body);
  const resealed = sealJSON(wkey, legacyDecoded);
  r = await req('PUT', '/api/notes/' + noteId, {
    iv: resealed.iv, payload: resealed.payload,
    updated_at: '2026-11-25T12:00:00.000Z', device: 'migratedev',
  }, token);
  ok('wkey 重加密后推送 200', r.status === 200 && r.body.applied === true);

  // 新结构解锁往返：登录口令 → unwrap → wkey → 解密笔记
  meta = (await req('GET', '/api/meta', undefined, token)).body;
  const wkeyBack = unwrapVaultB64(wrapKey, meta.wrapped);
  ok('unwrap 取回 wkey 字节一致', Buffer.from(wkeyBack).equals(Buffer.from(wkey)));
  notes = (await req('GET', '/api/notes', undefined, token)).body.notes || [];
  note = notes.find((n) => n.id === noteId);
  const migrated = openJSON(wkeyBack, note.iv, note.payload);
  ok('迁移后 wkey 解密正文一致', migrated.title === '旧便签' && migrated.body === notePlain.body);

  // ---- saveAccount 改密序列（账户哈希 + 包裹原子替换） ----
  const newLoginSaltB64 = b64(nodeCrypto.randomBytes(16));
  const newCredential = b64(I.pbkdf2(enc.encode(NEW_PASS_AFTER), unb64(newLoginSaltB64), LOGIN_ITERS, 32));
  const newWrapSaltB64 = b64(nodeCrypto.randomBytes(16));
  const newWrapKey = deriveKeyBytes(NEW_PASS_AFTER, newWrapSaltB64, PBKDF2_ITER);
  const cur = await loginCredential(NEW_LOGIN_PASS);
  r = await req('PUT', '/api/account', {
    username: 'admin',
    current_credential: cur.credential,
    new_credential: newCredential,
    new_login_salt: newLoginSaltB64,
    vault: {
      salt: newWrapSaltB64, wrapped: wrapVaultB64(newWrapKey, wkey),
      iterations: PBKDF2_ITER, version: 1,
    },
  }, token);
  ok('改密+重包裹 200', r.status === 200 && r.body.ok === true);
  ok('改密后旧会话被撤销', (await req('GET', '/api/meta', undefined, token)).status === 401);

  // 新口令登录 → 解包 → 解笔记（wkey 不变，笔记密文无需再动）
  const lg2 = await loginCredential(NEW_PASS_AFTER);
  r = await req('POST', '/api/login', { username: 'admin', credential: lg2.credential });
  ok('新口令登录 200', r.status === 200 && Boolean(r.body.token));
  const token3 = r.body.token || '';
  meta = (await req('GET', '/api/meta', undefined, token3)).body;
  const wkey3 = unwrapVaultB64(newWrapKey, meta.wrapped);
  ok('改密后解包 wkey 不变', Buffer.from(wkey3).equals(Buffer.from(wkey)));
  notes = (await req('GET', '/api/notes', undefined, token3)).body.notes || [];
  note = notes.find((n) => n.id === noteId);
  const finalPlain = openJSON(wkey3, note.iv, note.payload);
  ok('改密后笔记依然可解密', finalPlain.body === notePlain.body);

  // 旧口令登录应失效
  const lgOld = await loginCredential(NEW_LOGIN_PASS);
  ok('旧口令登录失效', (await req('POST', '/api/login', { username: 'admin', credential: lgOld.credential })).status === 401);
})()
  .catch((e) => { fail++; console.error('  FATAL ' + (e && e.stack || e)); })
  .finally(() => {
    try { proc.kill(); } catch (e) { /* gone */ }
    fs.rmSync(DATA, { recursive: true, force: true });
    console.log('\nlegacy migration tests: ' + pass + ' pass, ' + fail + ' fail');
    process.exit(fail ? 1 : 0);
  });
