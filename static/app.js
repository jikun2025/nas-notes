'use strict';

/* 轻签（加密版）
 * - 服务端、IndexedDB 只存 AES-GCM 密文和 IV
 * - 明文只在内存 plainCache 中存在，锁定或刷新即清除
 * - 加密口令不写入任何存储，多端需各自输入同一口令
 */

const DB_NAME = 'nas-notes-enc';
const LEGACY_DB_NAME = 'nas-notes';
const STORE_NOTES = 'notes';
const STORE_OUT = 'outbox';
const STORE_META = 'meta';
const VAULT_VERSION = 1;
const PBKDF2_ITERATIONS = 310000;
const VERIFIER_TEXT = 'nas-notes-vault-v1';
const BACKUP_FORMAT = 'nas-notes-encrypted-backup-v1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const els = {
  lockScreen: document.getElementById('lockScreen'),
  lockTitle: document.getElementById('lockTitle'),
  lockHint: document.getElementById('lockHint'),
  passphraseInput: document.getElementById('passphraseInput'),
  confirmLabel: document.getElementById('confirmLabel'),
  confirmInput: document.getElementById('confirmInput'),
  lockError: document.getElementById('lockError'),
  unlockBtn: document.getElementById('unlockBtn'),
  syncBadge: document.getElementById('syncBadge'),
  newBtn: document.getElementById('newBtn'),
  searchInput: document.getElementById('searchInput'),
  searchCount: document.getElementById('searchCount'),
  noteList: document.getElementById('noteList'),
  syncBtn: document.getElementById('syncBtn'),
  lockBtn: document.getElementById('lockBtn'),
  settingsBtn: document.getElementById('settingsBtn'),
  settingsDialog: document.getElementById('settingsDialog'),
  tokenInput: document.getElementById('tokenInput'),
  deviceInput: document.getElementById('deviceInput'),
  exportBtn: document.getElementById('exportBtn'),
  importBtn: document.getElementById('importBtn'),
  importFile: document.getElementById('importFile'),
  saveSettings: document.getElementById('saveSettings'),
  cancelSettings: document.getElementById('cancelSettings'),
  backBtn: document.getElementById('backBtn'),
  deleteBtn: document.getElementById('deleteBtn'),
  editorMeta: document.getElementById('editorMeta'),
  titleInput: document.getElementById('titleInput'),
  bodyInput: document.getElementById('bodyInput'),
  saveState: document.getElementById('saveState'),
  toast: document.getElementById('toast')
};

const notesCache = new Map();   // id -> 密文便签（可持久化）
const plainCache = new Map();   // id -> {title, body}（仅内存，绝不持久化）
let cryptoKey = null;           // CryptoKey，仅内存
let vaultMeta = null;           // {salt, verifier, iterations, version}
let needsMetaPush = false;
let initMode = false;
let currentId = null;
let deviceId = '';
let token = '';
let syncing = false;
let saveTimer = null;
let syncTimer = null;
let toastTimer = null;

// ---------- 工具 ----------
function genId() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function bytesToB64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function b64ToBytes(value) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function isNewer(updatedA, deviceA, updatedB, deviceB) {
  if (updatedA !== updatedB) return updatedA > updatedB;
  return deviceA > deviceB;
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

function highlight(value, query) {
  const text = String(value || '');
  if (!query) return esc(text);
  const index = text.toLowerCase().indexOf(query);
  if (index < 0) return esc(text);
  return esc(text.slice(0, index)) + '<mark>' + esc(text.slice(index, index + query.length)) + '</mark>' + esc(text.slice(index + query.length));
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

function setBadge(text, kind) {
  els.syncBadge.textContent = text;
  els.syncBadge.className = 'badge' + (kind ? ' ' + kind : '');
}

function setSaveState(text) {
  els.saveState.textContent = text;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3000);
}

function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Token'] = token;
  return headers;
}

// ---------- WebCrypto ----------
async function deriveKey(passphrase, saltB64, iterations) {
  const material = await crypto.subtle.importKey(
    'raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64ToBytes(saltB64), iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptJSON(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(value))
  );
  return { iv: bytesToB64(iv), payload: bytesToB64(new Uint8Array(cipher)) };
}

async function decryptJSON(key, ivB64, payloadB64) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(ivB64) }, key, b64ToBytes(payloadB64)
  );
  return JSON.parse(decoder.decode(plain));
}

async function createVerifier(key) {
  const sealed = await encryptJSON(key, { check: VERIFIER_TEXT });
  return sealed.iv + ':' + sealed.payload;
}

async function checkVerifier(key, verifier) {
  try {
    const parts = String(verifier || '').split(':');
    if (parts.length !== 2) return false;
    const value = await decryptJSON(key, parts[0], parts[1]);
    return value && value.check === VERIFIER_TEXT;
  } catch (error) {
    return false;
  }
}

// ---------- IndexedDB（仅密文） ----------
const dbPromise = new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE_NOTES)) db.createObjectStore(STORE_NOTES, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(STORE_OUT)) db.createObjectStore(STORE_OUT, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function idbGetAll(storeName) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(storeName, key) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function idbPut(storeName, value) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(storeName, key) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- 锁屏与加密库 ----------
function showLockScreen(mode) {
  initMode = mode === 'init';
  els.lockScreen.hidden = false;
  els.lockTitle.textContent = initMode ? '创建加密便签库' : '轻签已锁定';
  els.lockHint.textContent = initMode
    ? '首次使用请设置加密口令。便签会在本机加密后才上传，服务器无法读取内容。'
    : '请输入加密口令。口令只在内存中使用，不会写入服务器或浏览器。';
  els.confirmLabel.hidden = !initMode;
  els.confirmInput.hidden = !initMode;
  els.unlockBtn.textContent = initMode ? '创建加密库' : '解锁';
  els.lockError.hidden = true;
  els.passphraseInput.value = '';
  els.confirmInput.value = '';
  setBadge(initMode ? '待初始化' : '未解锁');
  setTimeout(() => els.passphraseInput.focus(), 0);
}

function showLockError(message) {
  els.lockError.textContent = message;
  els.lockError.hidden = false;
}

async function fetchMeta() {
  const response = await fetch('/api/meta', { headers: authHeaders() });
  if (response.status === 401) {
    setBadge('令牌错误', 'error');
    throw new Error('访问令牌不正确');
  }
  if (!response.ok) throw new Error('读取加密库信息失败: HTTP ' + response.status);

  const meta = await response.json();
  if (meta.initialized) {
    vaultMeta = {
      salt: meta.salt,
      verifier: meta.verifier,
      iterations: meta.iterations,
      version: meta.version
    };
    needsMetaPush = false;
    await idbPut(STORE_META, { key: 'vault', value: JSON.stringify(vaultMeta) });
  } else {
    needsMetaPush = Boolean(vaultMeta && vaultMeta.salt);
  }
  return meta;
}

async function handleUnlock() {
  const passphrase = els.passphraseInput.value;
  if (!passphrase) return showLockError('请输入加密口令');
  els.lockError.hidden = true;
  els.unlockBtn.disabled = true;

  try {
    if (initMode) {
      if (passphrase.length < 8) return showLockError('口令至少需要 8 位');
      if (passphrase !== els.confirmInput.value) return showLockError('两次输入的口令不一致');

      const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
      const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
      const meta = {
        salt,
        verifier: await createVerifier(key),
        iterations: PBKDF2_ITERATIONS,
        version: VAULT_VERSION
      };

      const response = await fetch('/api/meta', {
        method: 'PUT', headers: authHeaders(), body: JSON.stringify(meta)
      });
      if (response.status === 401) return showLockError('访问令牌不正确，请先在设置中填写');
      if (response.status === 409) {
        await fetchMeta();
        showLockScreen('unlock');
        return showLockError('服务端已有加密库，请直接解锁');
      }
      if (!response.ok) throw new Error('初始化失败: HTTP ' + response.status);

      vaultMeta = meta;
      await idbPut(STORE_META, { key: 'vault', value: JSON.stringify(meta) });
      cryptoKey = key;
      needsMetaPush = false;
    } else {
      if (!vaultMeta || !vaultMeta.salt) return showLockError('加密库信息缺失，请刷新重试');
      const key = await deriveKey(passphrase, vaultMeta.salt, vaultMeta.iterations);
      if (!(await checkVerifier(key, vaultMeta.verifier))) return showLockError('口令不正确');
      cryptoKey = key;

      if (needsMetaPush) {
        const response = await fetch('/api/meta', {
          method: 'PUT', headers: authHeaders(), body: JSON.stringify(vaultMeta)
        });
        if (response.ok || response.status === 409) needsMetaPush = false;
      }
    }

    els.lockScreen.hidden = true;
    els.passphraseInput.value = '';
    els.confirmInput.value = '';
    await rebuildPlainCache();
    setSaveState('已解锁');
    renderList();
    renderEditor();
    await sync();
  } catch (error) {
    console.warn('[NasNotes] unlock failed', error);
    showLockError('操作失败：' + (error && error.message ? error.message : '未知错误'));
  } finally {
    els.unlockBtn.disabled = false;
  }
}

async function rebuildPlainCache() {
  plainCache.clear();
  let failed = 0;
  for (const note of notesCache.values()) {
    if (note.deleted || !note.payload) continue;
    try {
      const plain = await decryptJSON(cryptoKey, note.iv, note.payload);
      if (plain && typeof plain.title === 'string' && typeof plain.body === 'string') {
        plainCache.set(note.id, plain);
      } else {
        failed += 1;
      }
    } catch (error) {
      failed += 1;
    }
  }
  if (failed) toast(failed + ' 条便签无法解密（可能来自不同口令或备份）');
}

async function lockApp() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    const note = notesCache.get(currentId);
    if (note && cryptoKey) await queueUpsert(note);
  }
  cryptoKey = null;
  plainCache.clear();
  currentId = null;
  document.body.classList.remove('show-editor');
  els.titleInput.value = '';
  els.bodyInput.value = '';
  showLockScreen('unlock');
}

// ---------- 本地写入（始终先加密） ----------
async function queueUpsert(note) {
  if (!cryptoKey) return null;
  const plain = plainCache.get(note.id) || { title: '', body: '' };
  const sealed = await encryptJSON(cryptoKey, {
    title: plain.title || '',
    body: plain.body || ''
  });

  const updated = Object.assign({}, note, {
    iv: sealed.iv,
    payload: sealed.payload,
    updated_at: new Date().toISOString(),
    device: deviceId
  });
  notesCache.set(updated.id, updated);
  setSaveState('待同步');

  await idbPut(STORE_NOTES, updated);
  await idbPut(STORE_OUT, {
    id: updated.id,
    method: 'PUT',
    payload: {
      iv: updated.iv,
      payload: updated.payload,
      updated_at: updated.updated_at,
      device: deviceId
    },
    queued_at: Date.now()
  });
  triggerSync();
  return updated;
}

async function queueDelete(noteId) {
  const note = notesCache.get(noteId);
  if (!note) return;
  const stamp = new Date().toISOString();
  const updated = Object.assign({}, note, {
    deleted: true, updated_at: stamp, device: deviceId
  });
  notesCache.set(noteId, updated);
  plainCache.delete(noteId);
  await idbPut(STORE_NOTES, updated);
  await idbPut(STORE_OUT, {
    id: noteId,
    method: 'DELETE',
    payload: { updated_at: stamp, device: deviceId },
    queued_at: Date.now()
  });
  triggerSync();
}

// ---------- 同步 ----------
async function sync() {
  if (syncing || !cryptoKey) return;
  if (!navigator.onLine) {
    setBadge('离线', 'offline');
    return;
  }

  syncing = true;
  setBadge('同步中…');
  try {
    if (needsMetaPush) await fetchMeta();

    const outbox = await idbGetAll(STORE_OUT);
    outbox.sort((a, b) => a.queued_at - b.queued_at);

    for (const op of outbox) {
      const response = await fetch('/api/notes/' + encodeURIComponent(op.id), {
        method: op.method,
        headers: authHeaders(),
        body: JSON.stringify(op.payload || {})
      });
      if (response.status === 401) {
        setBadge('令牌错误', 'error');
        toast('访问令牌不正确，请在设置中填写');
        return;
      }
      if (!response.ok) throw new Error('推送失败: HTTP ' + response.status);

      const result = await response.json();
      const serverNote = result.note;
      notesCache.set(op.id, serverNote);
      await idbPut(STORE_NOTES, serverNote);
      await idbDelete(STORE_OUT, op.id);

      if (!serverNote.deleted && serverNote.payload) {
        try {
          plainCache.set(op.id, await decryptJSON(cryptoKey, serverNote.iv, serverNote.payload));
        } catch (error) {
          console.warn('[NasNotes] decrypt pushed note failed', op.id, error);
        }
      } else {
        plainCache.delete(op.id);
      }
      if (result.applied === false) toast('检测到更新冲突，已采用服务端版本');
    }

    const response = await fetch('/api/notes', { headers: authHeaders() });
    if (response.status === 401) {
      setBadge('令牌错误', 'error');
      return;
    }
    if (!response.ok) throw new Error('拉取失败: HTTP ' + response.status);

    const data = await response.json();
    const pendingIds = new Set((await idbGetAll(STORE_OUT)).map((item) => item.id));

    for (const note of data.notes || []) {
      if (pendingIds.has(note.id)) continue;
      const local = notesCache.get(note.id);
      if (!local || isNewer(note.updated_at, note.device, local.updated_at, local.device)) {
        notesCache.set(note.id, note);
        await idbPut(STORE_NOTES, note);
        if (!note.deleted && note.payload) {
          try {
            plainCache.set(note.id, await decryptJSON(cryptoKey, note.iv, note.payload));
          } catch (error) {
            console.warn('[NasNotes] decrypt pulled note failed', note.id, error);
          }
        } else {
          plainCache.delete(note.id);
        }
      }
    }

    setBadge('已同步', 'ok');
    setSaveState('已保存');
    renderList();
    if (currentId) updateEditorMeta();
  } catch (error) {
    console.warn('[NasNotes] sync failed', error);
    setBadge(navigator.onLine ? '同步失败' : '离线', navigator.onLine ? 'error' : 'offline');
  } finally {
    syncing = false;
  }
}

function triggerSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 300);
}

// ---------- 渲染（明文只来自内存） ----------
function visibleNotes() {
  const query = els.searchInput.value.trim().toLowerCase();
  return Array.from(notesCache.values())
    .filter((note) => !note.deleted)
    .map((note) => ({
      note,
      plain: plainCache.get(note.id) || { title: '（无法解密）', body: '' }
    }))
    .filter((item) => !query
      || (item.plain.title || '').toLowerCase().includes(query)
      || (item.plain.body || '').toLowerCase().includes(query))
    .sort((a, b) => String(b.note.updated_at).localeCompare(String(a.note.updated_at)));
}

function renderList() {
  const query = els.searchInput.value.trim().toLowerCase();
  const items = visibleNotes();
  const total = Array.from(notesCache.values()).filter((note) => !note.deleted).length;
  els.searchCount.textContent = query ? `${items.length}/${total}` : `${total} 条`;

  if (items.length === 0) {
    els.noteList.innerHTML = '<div class="muted" style="padding:18px 12px">' +
      (query ? '没有匹配的便签' : '还没有便签，点「新建」开始') + '</div>';
    return;
  }

  els.noteList.innerHTML = items.map((item) => {
    const snippet = String(item.plain.body || '').replace(/\s+/g, ' ').slice(0, 80);
    return '<button class="note-item' + (item.note.id === currentId ? ' active' : '') +
      '" type="button" data-id="' + esc(item.note.id) + '">' +
      '<div class="item-title">' + highlight(item.plain.title || '（无标题）', query) + '</div>' +
      '<div class="item-snippet">' + highlight(snippet || '（空便签）', query) + '</div>' +
      '<div class="item-time">' + esc(formatTime(item.note.updated_at)) + '</div>' +
      '</button>';
  }).join('');
}

function updateEditorMeta() {
  const note = notesCache.get(currentId);
  els.editorMeta.textContent = note
    ? '更新于 ' + formatTime(note.updated_at) + ' · 已加密 · ' + (note.device || '未知设备')
    : '未选择便签';
}

function renderEditor() {
  const plain = plainCache.get(currentId);
  if (!plain) {
    els.titleInput.value = '';
    els.bodyInput.value = '';
    els.deleteBtn.hidden = true;
  } else {
    els.titleInput.value = plain.title || '';
    els.bodyInput.value = plain.body || '';
    els.deleteBtn.hidden = false;
  }
  updateEditorMeta();
}

function selectNote(id) {
  currentId = id;
  document.body.classList.add('show-editor');
  renderList();
  renderEditor();
  els.titleInput.focus();
}

// ---------- 加密备份导出 / 导入 ----------
function exportBackup() {
  if (!cryptoKey || !vaultMeta) {
    toast('请先解锁');
    return;
  }
  const backup = {
    format: BACKUP_FORMAT,
    exported_at: new Date().toISOString(),
    meta: {
      salt: vaultMeta.salt,
      verifier: vaultMeta.verifier,
      iterations: vaultMeta.iterations,
      version: vaultMeta.version
    },
    notes: Array.from(notesCache.values())
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'nas-notes-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast('已导出加密备份（不含明文）');
}

async function importBackup(file) {
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch (error) {
    toast('不是有效的 JSON 备份');
    return;
  }
  if (!backup || backup.format !== BACKUP_FORMAT || !Array.isArray(backup.notes)) {
    toast('备份格式不匹配');
    return;
  }

  try {
    const sample = backup.notes.find((note) => note && !note.deleted && note.payload);
    if (sample) {
      const plain = await decryptJSON(cryptoKey, sample.iv, sample.payload);
      if (!plain || typeof plain.title !== 'string') throw new Error('口令不匹配');
    }

    if (!vaultMeta || !vaultMeta.salt) {
      if (!backup.meta || !backup.meta.salt) throw new Error('备份缺少加密参数');
      const meta = {
        salt: backup.meta.salt,
        verifier: backup.meta.verifier,
        iterations: backup.meta.iterations || PBKDF2_ITERATIONS,
        version: backup.meta.version || VAULT_VERSION
      };
      const response = await fetch('/api/meta', {
        method: 'PUT', headers: authHeaders(), body: JSON.stringify(meta)
      });
      if (!response.ok && response.status !== 409) throw new Error('写入加密参数失败');
      vaultMeta = meta;
      await idbPut(STORE_META, { key: 'vault', value: JSON.stringify(meta) });
    }

    let imported = 0;
    let skipped = 0;
    for (const note of backup.notes) {
      if (!note || !/^[A-Za-z0-9_-]{1,64}$/.test(note.id || '')) {
        skipped += 1;
        continue;
      }
      const response = await fetch('/api/notes/' + encodeURIComponent(note.id), {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          iv: note.iv || '',
          payload: note.payload || '',
          updated_at: note.updated_at || new Date().toISOString(),
          device: note.device || 'import',
          deleted: Boolean(note.deleted)
        })
      });
      if (response.status === 401) throw new Error('访问令牌不正确');
      if (response.ok) imported += 1;
      else skipped += 1;
    }

    await sync();
    await rebuildPlainCache();
    renderList();
    renderEditor();
    toast(`导入完成：${imported} 条，跳过 ${skipped} 条`);
  } catch (error) {
    console.warn('[NasNotes] import failed', error);
    toast('导入失败：' + (error && error.message ? error.message : '未知错误'));
  }
}

// ---------- 事件绑定 ----------
els.unlockBtn.addEventListener('click', handleUnlock);
els.passphraseInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') handleUnlock();
});
els.confirmInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') handleUnlock();
});

els.lockBtn.addEventListener('click', () => { lockApp(); });

els.newBtn.addEventListener('click', () => {
  if (!cryptoKey) return;
  const stamp = new Date().toISOString();
  const id = genId();
  plainCache.set(id, { title: '', body: '' });
  notesCache.set(id, {
    id, iv: '', payload: '', created_at: stamp,
    updated_at: stamp, deleted: false, device: deviceId
  });
  queueUpsert(notesCache.get(id));
  selectNote(id);
});

els.noteList.addEventListener('click', (event) => {
  const button = event.target.closest('.note-item');
  if (button) selectNote(button.dataset.id);
});

els.searchInput.addEventListener('input', renderList);
els.syncBtn.addEventListener('click', () => { clearTimeout(syncTimer); sync(); });

els.backBtn.addEventListener('click', () => {
  clearTimeout(saveTimer);
  const note = notesCache.get(currentId);
  if (note && cryptoKey) queueUpsert(note);
  document.body.classList.remove('show-editor');
  currentId = null;
  renderList();
});

els.deleteBtn.addEventListener('click', async () => {
  if (!currentId) return;
  if (!window.confirm('确定删除这条便签？删除会同步到 NAS。')) return;
  clearTimeout(saveTimer);
  await queueDelete(currentId);
  currentId = null;
  document.body.classList.remove('show-editor');
  setSaveState('已保存');
  renderList();
  renderEditor();
});

function handleEdit() {
  const note = notesCache.get(currentId);
  if (!note || !cryptoKey) return;
  const plain = plainCache.get(currentId) || { title: '', body: '' };
  plain.title = els.titleInput.value;
  plain.body = els.bodyInput.value;
  plainCache.set(currentId, plain);
  setSaveState('编辑中…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const target = notesCache.get(currentId);
    if (target) queueUpsert(target);
  }, 450);
}

els.titleInput.addEventListener('input', handleEdit);
els.bodyInput.addEventListener('input', handleEdit);

function flushPendingEdit() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const note = notesCache.get(currentId);
  if (note && cryptoKey) queueUpsert(note);
}

window.addEventListener('pagehide', flushPendingEdit);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPendingEdit();
});

window.addEventListener('online', () => {
  if (!cryptoKey) return;
  setBadge('联网中');
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 200);
});
window.addEventListener('offline', () => {
  if (cryptoKey) setBadge('离线', 'offline');
});

els.settingsBtn.addEventListener('click', () => {
  els.tokenInput.value = token;
  els.deviceInput.value = deviceId;
  els.settingsDialog.showModal();
});
els.cancelSettings.addEventListener('click', () => els.settingsDialog.close());
els.saveSettings.addEventListener('click', () => {
  token = els.tokenInput.value.trim();
  deviceId = els.deviceInput.value.trim() || genId();
  localStorage.setItem('nn-token', token);
  localStorage.setItem('nn-device', deviceId);
  els.settingsDialog.close();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 100);
});

els.exportBtn.addEventListener('click', exportBackup);
els.importBtn.addEventListener('click', () => els.importFile.click());
els.importFile.addEventListener('change', () => {
  const file = els.importFile.files && els.importFile.files[0];
  if (file) importBackup(file);
  els.importFile.value = '';
});

// ---------- 启动 ----------
(async function init() {
  // 清理旧版可能存过明文的 IndexedDB
  try { indexedDB.deleteDatabase(LEGACY_DB_NAME); } catch (error) { /* ignore */ }

  deviceId = localStorage.getItem('nn-device') || genId();
  token = localStorage.getItem('nn-token') || '';
  localStorage.setItem('nn-device', deviceId);

  try {
    await dbPromise;
    const cachedNotes = await idbGetAll(STORE_NOTES);
    cachedNotes.forEach((note) => notesCache.set(note.id, note));
    const cachedMeta = await idbGet(STORE_META, 'vault');
    if (cachedMeta && cachedMeta.value) vaultMeta = JSON.parse(cachedMeta.value);
  } catch (error) {
    console.error('[NasNotes] IndexedDB unavailable', error);
    toast('本机缓存不可用，离线功能将受影响');
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('[NasNotes] service worker registration failed', error);
    });
  }

  try {
    await fetchMeta();
  } catch (error) {
    console.warn('[NasNotes] fetch meta failed, use cached', error);
  }

  showLockScreen(vaultMeta && vaultMeta.salt ? 'unlock' : 'init');
  renderList();
  renderEditor();
})();
