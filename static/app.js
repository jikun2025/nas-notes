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
const MAX_PLAIN_JSON = 8 * 1024 * 1024;      // 加密前明文 JSON 上限（含附件 base64）
const MAX_RECORD_MS = 5 * 60 * 1000;         // 单条录音最长 5 分钟
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ALLOWED_AUDIO_TYPES = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav'];

// 压缩档位：目标体积是压缩后文件的字节数，迭代缩放/降质直到达标。
// 含大量文字的图片会强制提高最小边长和质量，避免小字糊掉。
const IMAGE_PROFILES = {
  clear: { label: '清晰', maxEdge: 1920, minEdge: 1280, target: 700 * 1024, qualities: [0.82, 0.75, 0.68] },
  balanced: { label: '均衡', maxEdge: 1440, minEdge: 960, target: 320 * 1024, qualities: [0.74, 0.66, 0.58, 0.5] },
  tiny: { label: '极小', maxEdge: 1024, minEdge: 640, target: 140 * 1024, qualities: [0.62, 0.54, 0.46, 0.4] }
};
const AUDIO_PROFILES = {
  clear: { label: '清晰', bps: 64000 },
  balanced: { label: '均衡', bps: 32000 },
  tiny: { label: '极小', bps: 20000 }
};

// 同步：auto = 编辑后/解锁/联网/定时自动同步；manual = 仅点「同步」按钮
const SYNC_INTERVAL_MIN = 10;
const SYNC_INTERVAL_MAX = 86400;
const SYNC_INTERVAL_DEFAULT = 60;

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
  syncMode: document.getElementById('syncMode'),
  syncInterval: document.getElementById('syncInterval'),
  imageQuality: document.getElementById('imageQuality'),
  audioQuality: document.getElementById('audioQuality'),
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
  mdToolbar: document.getElementById('mdToolbar'),
  previewBtn: document.getElementById('previewBtn'),
  mdPreview: document.getElementById('mdPreview'),
  folderRow: document.querySelector('.folder-row'),
  folderSelect: document.getElementById('folderSelect'),
  newFolderBtn: document.getElementById('newFolderBtn'),
  renameFolderBtn: document.getElementById('renameFolderBtn'),
  deleteFolderBtn: document.getElementById('deleteFolderBtn'),
  saveState: document.getElementById('saveState'),
  imageBtn: document.getElementById('imageBtn'),
  imageInput: document.getElementById('imageInput'),
  recordBtn: document.getElementById('recordBtn'),
  recordLabel: document.getElementById('recordLabel'),
  attachCount: document.getElementById('attachCount'),
  attachmentList: document.getElementById('attachmentList'),
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
let imageQuality = 'balanced';
let audioQuality = 'balanced';
let syncMode = 'auto';
let syncIntervalSec = SYNC_INTERVAL_DEFAULT;
let syncing = false;
let saveTimer = null;
let syncTimer = null;
let syncPollTimer = null;
let toastTimer = null;
let mediaRecorder = null;
let recordChunks = [];
let recordTimer = null;
let recordStartedAt = 0;

// ---------- 工具 ----------
function genId() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function bytesToB64(bytes) {
  // 分块避免大附件触发栈溢出。
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
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

const INLINE_IMG_RE = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/i;

function bodyText(plain) {
  return NN_MD.text((plain && plain.body) || '');
}

function inlineImageCount(plain) {
  return NN_MD.extractImageIds((plain && plain.body) || '').length;
}

function imageAttachmentsOf(plain) {
  return ((plain && plain.attachments) || []).filter((item) => item.kind === 'image');
}

// 旧版 body_format=html（contenteditable 富文本）→ Markdown 源码。
// 旧内联 data-URI 图片转为 image 附件并在正文插入 `![[att:<id>]]` 占位符。
function migrateLegacyBodyToMarkdown(plain) {
  const legacyHTML = plain.body;
  const makeImage = (item) => {
    const match = INLINE_IMG_RE.exec(String((item && item.src) || ''));
    if (!match) return '';
    const id = genId();
    plain.attachments.push({
      id,
      kind: 'image',
      name: String((item && item.name) || '图片').slice(0, 120),
      mime: match[1].toLowerCase(),
      data: match[2],
      duration: 0,
      bytes: base64Bytes(match[2])
    });
    return '![[att:' + id + ']]';
  };
  plain.body = NN_MD.htmlToMarkdown(legacyHTML, makeImage);
  plain.body_format = 'md';
}

function normalizePlain(plain) {
  if (!plain || typeof plain !== 'object') return plain;
  if (typeof plain.body !== 'string') plain.body = plain.body == null ? '' : String(plain.body);
  if (typeof plain.folder !== 'string') plain.folder = '';
  if (plain.folder.length > 100) plain.folder = plain.folder.slice(0, 100);
  plain.attachments = normalizeAttachments(plain.attachments);
  if (plain.body_format !== 'md') migrateLegacyBodyToMarkdown(plain);
  return plain;
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

function base64Bytes(data) {
  return Math.floor(String(data || '').length * 3 / 4);
}

function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

let cachedImageMime = '';
function preferredImageMime() {
  if (cachedImageMime) return cachedImageMime;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    cachedImageMime = canvas.toDataURL('image/webp').indexOf('data:image/webp') === 0
      ? 'image/webp' : 'image/jpeg';
  } catch (error) {
    cachedImageMime = 'image/jpeg';
  }
  return cachedImageMime;
}

// 粗略判断是否为文字/截图类图片：大面积纯色 + 高频强边缘。
// 这类图片压缩时会保住更多像素和质量，避免小字看不清。
function estimateTextHeavy(image) {
  try {
    const sw = 200;
    const sh = Math.max(1, Math.round(sw
      * (image.naturalHeight || image.height) / (image.naturalWidth || image.width)));
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, sw, sh);
    const data = ctx.getImageData(0, 0, sw, sh).data;
    const lum = (i) => (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    let flat = 0;
    let edges = 0;
    let count = 0;
    for (let y = 1; y < sh; y += 1) {
      for (let x = 1; x < sw; x += 1) {
        const i = (y * sw + x) * 4;
        const value = lum(i);
        if (value > 235 || value < 70) flat += 1;
        if (Math.abs(value - lum(i - 4)) > 55) edges += 1;
        count += 1;
      }
    }
    return count > 0 && flat / count > 0.5 && edges / count > 0.01;
  } catch (error) {
    return false;
  }
}

function setBadge(text, kind) {
  els.syncBadge.textContent = text;
  els.syncBadge.className = 'badge' + (kind ? ' ' + kind : '');
}

function normalizeSyncInterval(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return SYNC_INTERVAL_DEFAULT;
  return Math.min(SYNC_INTERVAL_MAX, Math.max(SYNC_INTERVAL_MIN, n));
}

function stopAutoSync() {
  if (syncPollTimer) {
    clearInterval(syncPollTimer);
    syncPollTimer = null;
  }
}

function startAutoSync() {
  stopAutoSync();
  if (syncMode !== 'auto') return;
  syncPollTimer = setInterval(() => {
    if (cryptoKey && navigator.onLine && !document.hidden) sync();
  }, syncIntervalSec * 1000);
}

async function updateManualBadge() {
  if (syncMode !== 'manual' || !cryptoKey) return;
  try {
    const pending = (await idbGetAll(STORE_OUT)).length;
    setBadge(pending ? `待同步 ${pending}` : '手动模式', pending ? 'offline' : '');
  } catch (error) {
    console.warn('[NasNotes] count outbox failed', error);
  }
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

// ---------- 附件（明文仅在内存，随便签一起加密） ----------
function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === 'object'
    && typeof item.id === 'string' && typeof item.mime === 'string'
    && typeof item.data === 'string' && item.data.length > 0)
    .map((item) => ({
      id: item.id.slice(0, 80),
      kind: item.kind === 'audio' ? 'audio' : 'image',
      name: String(item.name || '附件').slice(0, 120),
      mime: String(item.mime || '').split(';')[0].trim().toLowerCase(),
      data: item.data,
      duration: Number(item.duration) || 0,
      bytes: Number(item.bytes) || base64Bytes(item.data)
    }));
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(blob);
  });
}

function dataURLParts(dataURL) {
  // mime 可能带参数，例如 audio/webm;codecs=opus，不能只取到第一个分号。
  const match = /^data:([^,]+);base64,([\s\S]*)$/.exec(String(dataURL || ''));
  if (!match) return null;
  const mime = match[1].split(';')[0].trim().toLowerCase();
  const data = match[2].replace(/\s/g, '');
  return mime && data ? { mime, data } : null;
}

function blobToBase64(blob) {
  // 直接读字节，绕开 Data URL 中 codecs 参数带来的解析差异。
  return blob.arrayBuffer().then((buffer) => bytesToB64(new Uint8Array(buffer)));
}

function audioFileName(mime) {
  const ext = mime === 'audio/mp4' ? 'm4a'
    : mime === 'audio/ogg' ? 'ogg'
      : mime === 'audio/wav' ? 'wav' : 'webm';
  return '录音-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.' + ext;
}

async function compressImage(file) {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    throw new Error('不支持的图片格式：' + (file.type || '未知'));
  }
  if (file.type === 'image/gif') {
    // 动画 GIF 无法用 canvas 保帧压缩，只做体积限制。
    if (file.size > 2 * 1024 * 1024) {
      throw new Error('GIF 无法压缩，请控制在 2 MB 内（建议改用 JPG/PNG/WebP）');
    }
    const parts = dataURLParts(await blobToDataURL(file));
    if (!parts) throw new Error('GIF 读取失败');
    return { ...parts, kind: 'image', bytes: file.size };
  }

  const dataURL = await blobToDataURL(file);
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('图片解码失败'));
    image.src = dataURL;
  });
  const originalWidth = image.naturalWidth || image.width;
  const originalHeight = image.naturalHeight || image.height;
  if (!originalWidth || !originalHeight) throw new Error('无法读取图片尺寸');

  const profile = IMAGE_PROFILES[imageQuality] || IMAGE_PROFILES.balanced;
  const textHeavy = estimateTextHeavy(image);
  const maxEdge = textHeavy ? Math.max(profile.maxEdge, 1440) : profile.maxEdge;
  const minEdge = textHeavy ? Math.max(profile.minEdge, 1280) : profile.minEdge;
  const edges = Array.from(new Set([
    maxEdge, Math.round((maxEdge + minEdge) / 2), minEdge
  ]));
  const mime = preferredImageMime();
  let best = null;

  for (const edge of edges) {
    const scale = Math.min(1, edge / Math.max(originalWidth, originalHeight));
    const width = Math.max(1, Math.round(originalWidth * scale));
    const height = Math.max(1, Math.round(originalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, width, height);
    for (const quality of profile.qualities) {
      const parts = dataURLParts(canvas.toDataURL(mime, quality));
      if (!parts) continue;
      const bytes = base64Bytes(parts.data);
      if (!best || bytes < best.bytes) {
        best = { ...parts, kind: 'image', bytes, width, height };
      }
      if (bytes <= profile.target) return best;
    }
  }
  if (!best) throw new Error('图片压缩失败');
  return best;
}

function currentPlain() {
  const plain = plainCache.get(currentId);
  if (!plain || !cryptoKey) return null;
  if (!Array.isArray(plain.attachments)) plain.attachments = [];
  return plain;
}

function plainSize(plain) {
  return encoder.encode(JSON.stringify({
    title: plain.title || '', body: plain.body || '', folder: plain.folder || '',
    attachments: plain.attachments || []
  })).length;
}

async function addAttachments(items) {
  const plain = currentPlain();
  if (!plain) { toast('请先打开一条便签'); return; }
  let added = 0;
  let totalBytes = 0;
  for (const item of items) {
    const audioCount = plain.attachments.filter((att) => att.kind === 'audio').length;
    if (audioCount >= 20) { toast('单条便签最多 20 段录音'); break; }
    if (plainSize(plain) > MAX_PLAIN_JSON) { toast('便签体积已达上限，请删除部分录音'); break; }
    try {
      const result = item.kind === 'audio' ? item : await compressImage(item.file || item);
      if (!result || !result.data) throw new Error('录音编码失败');
      const bytes = Number(result.bytes) || base64Bytes(result.data);
      plain.attachments.push({
        id: genId(),
        kind: result.kind,
        name: String(result.name || (result.kind === 'audio' ? '录音' : '图片')).slice(0, 120),
        mime: result.mime,
        data: result.data,
        duration: Number(result.duration) || 0,
        bytes
      });
      totalBytes += bytes;
      added += 1;
    } catch (error) {
      console.warn('[NasNotes] audio attachment failed', error);
      toast('录音添加失败：' + (error && error.message ? error.message : '未知错误'));
    }
  }
  if (!added) return;
  renderAttachments();
  setSaveState('加密中…');
  const note = notesCache.get(currentId);
  if (note) await queueUpsert(note);
  toast(`已添加 ${added} 段录音（${formatBytes(totalBytes)}，已加密）`);
}

let previewOn = false;
let savedCaretPos = -1;

function currentCaret() {
  const ta = els.bodyInput;
  return (typeof ta.selectionStart === 'number' && document.activeElement === ta)
    ? ta.selectionStart : ta.value.length;
}

// 在光标处插入独立成行的图片占位符（预览态先切回编辑态）
function insertImagePlaceholder(att, caret) {
  if (previewOn) togglePreview(false);
  const ta = els.bodyInput;
  const value = ta.value;
  let pos = Math.min(Math.max(0, caret), value.length);
  const prefix = (pos > 0 && value[pos - 1] !== '\n') ? '\n' : '';
  const suffix = (pos < value.length && value[pos] !== '\n') ? '\n' : '';
  const insert = prefix + '![[att:' + att.id + ']]' + suffix;
  ta.value = value.slice(0, pos) + insert + value.slice(pos);
  const next = pos + insert.length;
  ta.setSelectionRange(next, next);
  ta.focus();
}

async function handleImageInput(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = '';
  if (!files.length) return;
  const plain = currentPlain();
  if (!plain) { toast('请先打开一条便签'); return; }
  const caret = savedCaretPos >= 0 ? savedCaretPos : currentCaret();
  savedCaretPos = -1;
  let added = 0;
  let totalBytes = 0;
  for (const file of files) {
    try {
      const result = await compressImage(file);
      if (!result || !result.data) throw new Error('图片编码失败');
      const att = {
        id: genId(),
        kind: 'image',
        name: String(file.name || '图片').slice(0, 120),
        mime: result.mime,
        data: result.data,
        duration: 0,
        bytes: Number(result.bytes) || base64Bytes(result.data)
      };
      plain.attachments.push(att);
      if (plainSize(plain) > MAX_PLAIN_JSON) {
        plain.attachments.pop();
        toast('便签体积已达上限，请删除部分图片');
        break;
      }
      insertImagePlaceholder(att, caret);
      totalBytes += att.bytes;
      added += 1;
    } catch (error) {
      console.warn('[NasNotes] inline image failed', error);
      toast('图片插入失败：' + (error && error.message ? error.message : '未知错误'));
    }
  }
  if (!added) return;
  handleEdit();
  renderAttachments();
  toast(`已插入 ${added} 张图片（压缩后共 ${formatBytes(totalBytes)}，已加密）`);
}

function pickAudioMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function updateRecordUI(recording) {
  els.recordBtn.classList.toggle('recording', recording);
  els.recordLabel.textContent = recording ? '停止' : '录音';
  els.recordBtn.title = recording ? '停止并保存录音' : '录制语音（最长 5 分钟）';
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
}

async function toggleRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    stopRecording();
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    toast('当前浏览器不支持录音（需要 HTTPS 或 localhost）');
    return;
  }
  if (!currentPlain()) { toast('请先打开一条便签'); return; }

  try {
    // 单声道 + 降噪/回声消除，配合低码率 Opus 可显著缩小语音体积。
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    } catch (error) {
      console.warn('[NasNotes] constrained audio failed, fallback', error);
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    const mimeType = pickAudioMime();
    const profile = AUDIO_PROFILES[audioQuality] || AUDIO_PROFILES.balanced;
    const options = { audioBitsPerSecond: profile.bps };
    if (mimeType) options.mimeType = mimeType;
    mediaRecorder = new MediaRecorder(stream, options);
    recordChunks = [];
    const actualMime = mediaRecorder.mimeType || mimeType || 'audio/webm';

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size) recordChunks.push(event.data);
    };
    mediaRecorder.onerror = (event) => {
      console.warn('[NasNotes] MediaRecorder error', event);
      clearInterval(recordTimer);
      recordTimer = null;
      stream.getTracks().forEach((track) => track.stop());
      updateRecordUI(false);
      mediaRecorder = null;
      recordChunks = [];
      toast('录音编码出错，请重试或换用 Chrome / Edge');
    };

    mediaRecorder.onstop = async () => {
      clearInterval(recordTimer);
      recordTimer = null;
      stream.getTracks().forEach((track) => track.stop());
      updateRecordUI(false);
      mediaRecorder = null;
      const durationMs = Date.now() - recordStartedAt;
      const blob = new Blob(recordChunks, { type: actualMime });
      recordChunks = [];
      if (!blob.size) { toast('未捕获到声音，请重试'); return; }
      try {
        const mime = String(blob.type || actualMime).split(';')[0].trim().toLowerCase();
        const data = await blobToBase64(blob);
        if (!data) { toast('录音数据为空，请重试'); return; }
        await addAttachments([{
          kind: 'audio',
          mime,
          data,
          name: audioFileName(mime),
          duration: Math.round(durationMs / 1000),
          bytes: blob.size
        }]);
      } catch (error) {
        console.warn('[NasNotes] recording encode failed', error);
        toast('录音编码失败：' + (error && error.message ? error.message : '未知错误'));
      }
    };

    mediaRecorder.start(200);
    recordStartedAt = Date.now();
    updateRecordUI(true);
    recordTimer = setInterval(() => {
      const elapsed = Date.now() - recordStartedAt;
      els.recordLabel.textContent = '停止 ' + Math.floor(elapsed / 1000) + 's';
      if (elapsed >= MAX_RECORD_MS) stopRecording();
    }, 500);
  } catch (error) {
    console.warn('[NasNotes] recording failed', error);
    toast('无法录音：' + (error && error.message ? error.message : '请检查麦克风权限'));
    updateRecordUI(false);
  }
}

function attachmentURL(item) {
  const allowed = item.kind === 'audio' ? ALLOWED_AUDIO_TYPES : ALLOWED_IMAGE_TYPES;
  const raw = String(item.mime || '').split(';')[0].trim().toLowerCase();
  const mime = allowed.includes(raw) ? raw
    : (raw.startsWith(item.kind === 'audio' ? 'audio/' : 'image/')
      ? raw : (item.kind === 'audio' ? 'audio/webm' : 'image/jpeg'));
  return `data:${mime};base64,${item.data}`;
}

function openLightbox(src) {
  const overlay = document.createElement('div');
  overlay.className = 'image-lightbox';
  const image = document.createElement('img');
  image.src = src;
  image.alt = '图片预览';
  overlay.appendChild(image);
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

function renderAttachments() {
  const plain = plainCache.get(currentId);
  const items = plain && Array.isArray(plain.attachments) ? plain.attachments : [];
  const images = items.filter((item) => item.kind === 'image').length;
  const audios = items.filter((item) => item.kind === 'audio').length;
  const parts = [];
  if (images) parts.push(images + ' 张图片');
  if (audios) parts.push(audios + ' 段录音');
  els.attachCount.textContent = parts.length ? parts.join(' · ') : '';
  if (!items.length) {
    els.attachmentList.innerHTML = '';
    return;
  }
  els.attachmentList.innerHTML = items.map((item) => {
    const name = esc(item.name || (item.kind === 'audio' ? '录音' : '图片'));
    const src = attachmentURL(item);
    let media;
    if (item.kind === 'audio') {
      media = `<audio controls preload="none" src="${src}"></audio>`;
    } else {
      media = `<img src="${src}" alt="${name}" class="attachment-thumb" data-lightbox="1">`;
    }
    const size = formatBytes(item.bytes || base64Bytes(item.data));
    const meta = item.kind === 'audio'
      ? `${item.duration ? item.duration + 's · ' : ''}${size}` : size;
    return '<div class="attachment-card">' + media +
      '<div class="attachment-info"><span class="attachment-name">' + name + '</span>' +
      '<span>' + meta + '</span>' +
      '<button class="attachment-remove" type="button" data-remove="' + esc(item.id) + '" title="删除附件">✕</button>' +
      '</div></div>';
  }).join('');
}

async function removeAttachment(id) {
  const plain = currentPlain();
  if (!plain) return;
  const removed = (plain.attachments || []).find((item) => item.id === id);
  const before = plain.attachments.length;
  plain.attachments = plain.attachments.filter((item) => item.id !== id);
  if (plain.attachments.length === before) return;
  // 图片附件删除时同步移除正文中的占位符
  if (removed && removed.kind === 'image' && plain === plainCache.get(currentId)) {
    const cleaned = String(plain.body || '').replace(
      new RegExp('[ \\t]*!?\\[\\[att:' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]\\][ \\t]*', 'gm'), '');
    els.bodyInput.value = cleaned;
    plain.body = cleaned;
    if (previewOn) renderPreview();
  }
  renderAttachments();
  const note = notesCache.get(currentId);
  if (note) await queueUpsert(note);
  toast(removed && removed.kind === 'image' ? '图片已删除（正文占位符一并移除）' : '录音已删除');
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
    if (syncMode === 'auto') {
      startAutoSync();
      await sync();
    } else {
      stopAutoSync();
      await updateManualBadge();
    }
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
        normalizePlain(plain);
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
  stopRecording();
  stopAutoSync();
  clearTimeout(syncTimer);
  cryptoKey = null;
  plainCache.clear();
  currentId = null;
  document.body.classList.remove('show-editor');
  els.titleInput.value = '';
  els.bodyInput.value = '';
  previewOn = false;
  els.mdPreview.innerHTML = '';
  els.mdPreview.hidden = true;
  els.bodyInput.hidden = false;
  els.previewBtn.classList.remove('active');
  els.previewBtn.textContent = '👁 预览';
  els.attachmentList.innerHTML = '';
  els.attachCount.textContent = '';
  document.querySelectorAll('.image-lightbox').forEach((node) => node.remove());
  showLockScreen('unlock');
}

// ---------- 本地写入（始终先加密） ----------
async function queueUpsert(note) {
  if (!cryptoKey) return null;
  const plain = normalizePlain(plainCache.get(note.id) || {
    title: '', body: '', body_format: 'md', folder: '', attachments: []
  });
  const sealed = await encryptJSON(cryptoKey, {
    title: plain.title || '',
    body: plain.body || '',
    body_format: 'md',
    folder: plain.folder || '',
    attachments: normalizeAttachments(plain.attachments)
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
  updateManualBadge();
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
  updateManualBadge();
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
          const plain = await decryptJSON(cryptoKey, serverNote.iv, serverNote.payload);
          normalizePlain(plain);
          plainCache.set(op.id, plain);
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
            const plain = await decryptJSON(cryptoKey, note.iv, note.payload);
            normalizePlain(plain);
            plainCache.set(note.id, plain);
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

function triggerSync(delay = 300) {
  if (syncMode !== 'auto' || !cryptoKey) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, delay);
}

// ---------- 渲染（明文只来自内存） ----------
const UNGROUPED = '未分类';
const collapsedFolders = new Set();   // 仅内存：折叠的分类名

function allFolders() {
  const names = new Set();
  for (const note of notesCache.values()) {
    if (note.deleted) continue;
    const plain = plainCache.get(note.id);
    const folder = plain && typeof plain.folder === 'string' ? plain.folder.trim() : '';
    if (folder) names.add(folder.slice(0, 100));
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function renderFolderOptions() {
  const plain = plainCache.get(currentId);
  const current = plain && typeof plain.folder === 'string' ? plain.folder.trim() : '';
  const folders = allFolders();
  const parts = ['<option value="">（' + UNGROUPED + '）</option>'];
  folders.forEach((name) => {
    parts.push('<option value="' + esc(name) + '">' + esc(name) + '</option>');
  });
  if (current && !folders.includes(current)) {
    parts.push('<option value="' + esc(current) + '" selected>' + esc(current) + '</option>');
  }
  els.folderSelect.innerHTML = parts.join('');
  els.folderSelect.value = current;
  const hasCurrent = Boolean(current);
  const custom = hasCurrent && !folders.includes(current);
  els.renameFolderBtn.hidden = !custom;
  els.deleteFolderBtn.hidden = !custom;
  if (custom) {
    els.renameFolderBtn.title = '重命名分类「' + current + '」';
    els.deleteFolderBtn.title = '删除分类「' + current + '」（其中便签移入未分类）';
  }
}

function promptFolderName(initial, title) {
  const name = window.prompt(title, initial || '');
  if (name === null) return null;
  const trimmed = name.trim().slice(0, 100);
  if (!trimmed) { toast('分类名不能为空'); return null; }
  if (trimmed === UNGROUPED) { toast('「' + UNGROUPED + '」是保留名称'); return null; }
  return trimmed;
}

async function setFolderForAll(from, to) {
  const stamp = new Date().toISOString();
  let touched = 0;
  for (const note of Array.from(notesCache.values())) {
    if (note.deleted) continue;
    const plain = plainCache.get(note.id);
    if (!plain || typeof plain.folder !== 'string') continue;
    if (plain.folder.trim() !== from) continue;
    plain.folder = to;
    plainCache.set(note.id, plain);
    // plainCache 内容随输入实时同步，queueUpsert 读到的就是最新明文
    await queueUpsert(note);
    touched += 1;
  }
  return touched;
}

function visibleNotes() {
  const query = els.searchInput.value.trim().toLowerCase();
  return Array.from(notesCache.values())
    .filter((note) => !note.deleted)
    .map((note) => ({
      note,
      plain: plainCache.get(note.id) || { title: '（无法解密）', body: '', folder: '' }
    }))
    .filter((item) => !query
      || (item.plain.title || '').toLowerCase().includes(query)
      || bodyText(item.plain).toLowerCase().includes(query)
      || (item.plain.folder || '').toLowerCase().includes(query)
      || (item.plain.attachments || []).some((att) =>
        (att.name || '').toLowerCase().includes(query)))
    .sort((a, b) => String(b.note.updated_at).localeCompare(String(a.note.updated_at)));
}

function noteItemHTML(item, query) {
  const images = inlineImageCount(item.plain);
  const audios = (item.plain.attachments || []).filter((att) => att.kind === 'audio').length;
  const attachmentHint = (images ? ` 🖼${images}` : '') + (audios ? ` 🎤${audios}` : '');
  const snippet = (bodyText(item.plain).slice(0, 80) || '（空便签）') + attachmentHint;
  return '<button class="note-item' + (item.note.id === currentId ? ' active' : '') +
    '" type="button" data-id="' + esc(item.note.id) + '">' +
    '<div class="item-title">' + highlight(item.plain.title || '（无标题）', query) + '</div>' +
    '<div class="item-snippet">' + highlight(snippet || '（空便签）', query) + '</div>' +
    '<div class="item-time">' + esc(formatTime(item.note.updated_at)) + '</div>' +
    '</button>';
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

  // 一级 = 分类，二级 = 该分类下的便签标题；「未分类」固定排最后
  const groups = new Map();
  items.forEach((item) => {
    const folder = (item.plain.folder || '').trim().slice(0, 100) || UNGROUPED;
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(item);
  });
  const folderNames = Array.from(groups.keys()).sort((a, b) => {
    if (a === UNGROUPED) return 1;
    if (b === UNGROUPED) return -1;
    return a.localeCompare(b, 'zh-CN');
  });

  els.noteList.innerHTML = folderNames.map((folder) => {
    const list = groups.get(folder);
    const collapsed = collapsedFolders.has(folder);
    const head = '<div class="folder-group-head" role="button" tabindex="0" data-folder="' + esc(folder) + '" title="点击折叠/展开">' +
      '<span class="folder-caret">' + (collapsed ? '▸' : '▾') + '</span>' +
      '<span class="folder-name">' + esc(folder) + '</span>' +
      '<span class="folder-count">' + list.length + '</span>' +
      '</div>';
    const body = collapsed ? '' : '<div class="folder-group-body">' +
      list.map((item) => noteItemHTML(item, query)).join('') + '</div>';
    return '<div class="folder-group">' + head + body + '</div>';
  }).join('');
}

function updateEditorMeta() {
  const note = notesCache.get(currentId);
  els.editorMeta.textContent = note
    ? '更新于 ' + formatTime(note.updated_at) + ' · 已加密 · ' + (note.device || '未知设备')
    : '未选择便签';
}

function renderPreview() {
  const plain = plainCache.get(currentId);
  if (!plain) { els.mdPreview.innerHTML = ''; return; }
  els.mdPreview.innerHTML = NN_MD.render(plain.body || '', imageAttachmentsOf(plain));
}

function togglePreview(force) {
  const next = typeof force === 'boolean' ? force : !previewOn;
  if (next === previewOn) return;
  if (!currentId) return;
  previewOn = next;
  if (previewOn) {
    // 先把 textarea 里的当前编辑同步进内存，再渲染
    const plain = plainCache.get(currentId);
    if (plain) plain.body = els.bodyInput.value;
    renderPreview();
  }
  els.mdPreview.hidden = !previewOn;
  els.bodyInput.hidden = previewOn;
  els.previewBtn.classList.toggle('active', previewOn);
  els.previewBtn.textContent = previewOn ? '✎ 编辑' : '👁 预览';
}

function renderEditor() {
  const plain = plainCache.get(currentId);
  if (!plain) {
    els.titleInput.value = '';
    els.bodyInput.value = '';
    els.deleteBtn.hidden = true;
    els.attachCount.textContent = '';
    els.attachmentList.innerHTML = '';
    if (previewOn) togglePreview(false);
    if (els.folderRow) els.folderRow.hidden = true;
    if (els.mdToolbar) els.mdToolbar.hidden = true;
  } else {
    normalizePlain(plain);
    els.titleInput.value = plain.title || '';
    els.bodyInput.value = plain.body || '';
    if (previewOn) renderPreview();
    els.deleteBtn.hidden = false;
    if (els.folderRow) els.folderRow.hidden = false;
    if (els.mdToolbar) els.mdToolbar.hidden = false;
    renderFolderOptions();
    renderAttachments();
  }
  updateEditorMeta();
}

function selectNote(id) {
  currentId = id;
  previewOn = false;
  els.mdPreview.hidden = true;
  els.bodyInput.hidden = false;
  els.previewBtn.classList.remove('active');
  els.previewBtn.textContent = '👁 预览';
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
  const keepFolder = (els.folderSelect.value || '').trim();
  plainCache.set(id, { title: '', body: '', body_format: 'md', folder: keepFolder, attachments: [] });
  notesCache.set(id, {
    id, iv: '', payload: '', created_at: stamp,
    updated_at: stamp, deleted: false, device: deviceId
  });
  queueUpsert(notesCache.get(id));
  selectNote(id);
});

els.noteList.addEventListener('click', (event) => {
  const head = event.target.closest('.folder-group-head');
  if (head) {
    const folder = head.dataset.folder || '';
    if (collapsedFolders.has(folder)) collapsedFolders.delete(folder);
    else collapsedFolders.add(folder);
    renderList();
    return;
  }
  const button = event.target.closest('.note-item');
  if (button) selectNote(button.dataset.id);
});

els.noteList.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.classList.contains('folder-group-head')) {
    event.preventDefault();
    event.target.click();
  }
});

els.searchInput.addEventListener('input', renderList);
els.syncBtn.addEventListener('click', () => { clearTimeout(syncTimer); sync(); });

els.imageBtn.addEventListener('click', () => {
  if (!currentPlain()) { toast('请先打开一条便签'); return; }
  savedCaretPos = currentCaret();
  els.imageInput.click();
});
els.imageInput.addEventListener('change', handleImageInput);
els.recordBtn.addEventListener('click', toggleRecording);

// 预览态点击图片放大（渲染产物只有 <img data-preview-image>）
els.mdPreview.addEventListener('click', (event) => {
  const img = event.target.closest('img[data-preview-image]');
  if (img) openLightbox(img.src);
});

// ---------- Markdown 工具栏 ----------
function applyAround(prefix, suffix, placeholder) {
  const ta = els.bodyInput;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const selected = ta.value.slice(start, end);
  const text = selected || placeholder || '';
  ta.value = ta.value.slice(0, start) + prefix + text + suffix + ta.value.slice(end);
  const caretStart = start + prefix.length;
  ta.focus();
  if (selected) ta.setSelectionRange(caretStart, caretStart + text.length);
  else ta.setSelectionRange(caretStart, caretStart + text.length);
  handleEdit();
}

function applyLinePrefix(makePrefix) {
  const ta = els.bodyInput;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const value = ta.value;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = value.indexOf('\n', end);
  if (lineEnd < 0) lineEnd = value.length;
  const block = value.slice(lineStart, lineEnd);
  const lines = block.length ? block.split('\n') : [''];
  // 已全部带该前缀则取消（切换语义）
  const prefixes = lines.map((line, i) => makePrefix(i, line));
  const already = lines.every((line, i) => line.startsWith(prefixes[i]));
  const nextLines = already ? lines.map((line, i) => line.slice(prefixes[i].length))
    : lines.map((line, i) => {
      const stripped = line.replace(/^(\s*)(?:[-*+]\s+|\d{1,9}[.)]\s+|>\s+|#{1,6}\s+)?/, '$1');
      return prefixes[i] + stripped.replace(/^\s+/, '');
    });
  const next = nextLines.join('\n');
  ta.value = value.slice(0, lineStart) + next + value.slice(lineEnd);
  ta.focus();
  ta.setSelectionRange(lineStart, lineStart + next.length);
  handleEdit();
}

function handleMdAction(kind) {
  if (!currentId) { toast('请先打开一条便签'); return; }
  if (kind === 'preview') { togglePreview(); return; }
  if (previewOn) togglePreview(false);
  switch (kind) {
    case 'bold': applyAround('**', '**', '加粗文字'); break;
    case 'italic': applyAround('*', '*', '斜体文字'); break;
    case 'strike': applyAround('~~', '~~', '删除线'); break;
    case 'code': applyAround('`', '`', 'code'); break;
    case 'h1': applyLinePrefix(() => '# '); break;
    case 'h2': applyLinePrefix(() => '## '); break;
    case 'h3': applyLinePrefix(() => '### '); break;
    case 'ul': applyLinePrefix(() => '- '); break;
    case 'ol': applyLinePrefix((i) => (i + 1) + '. '); break;
    case 'task': applyLinePrefix(() => '- [ ] '); break;
    case 'quote': applyLinePrefix(() => '> '); break;
    case 'link': applyAround('[', '](https://)', '链接文字'); break;
    case 'hr': {
      const ta = els.bodyInput;
      const start = ta.selectionStart;
      const before = start > 0 && ta.value[start - 1] !== '\n' ? '\n' : '';
      const text = before + '---\n';
      ta.value = ta.value.slice(0, start) + text + ta.value.slice(ta.selectionEnd);
      const next = start + text.length;
      ta.focus();
      ta.setSelectionRange(next, next);
      handleEdit();
      break;
    }
    default: break;
  }
}

els.mdToolbar.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-md]');
  if (!btn) return;
  event.preventDefault();
  handleMdAction(btn.dataset.md);
});

// Ctrl/Cmd+B/I/K 快捷键（与 Joplin 习惯一致）
els.bodyInput.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (key === 'b') { event.preventDefault(); handleMdAction('bold'); }
  else if (key === 'i') { event.preventDefault(); handleMdAction('italic'); }
  else if (key === 'k') { event.preventDefault(); handleMdAction('link'); }
});

// ---------- 分类操作 ----------
els.folderSelect.addEventListener('change', async () => {
  const plain = currentPlain();
  if (!plain) return;
  plain.folder = (els.folderSelect.value || '').trim().slice(0, 100);
  plainCache.set(currentId, plain);
  renderFolderOptions();
  const note = notesCache.get(currentId);
  if (note) await queueUpsert(note);
  renderList();
  toast(plain.folder ? '已移入分类「' + plain.folder + '」' : '已移入' + UNGROUPED);
});

els.newFolderBtn.addEventListener('click', async () => {
  if (!currentId) { toast('请先打开一条便签'); return; }
  const name = promptFolderName('', '新建分类名称');
  if (!name) return;
  const plain = currentPlain();
  if (plain) {
    plain.folder = name;
    plainCache.set(currentId, plain);
    const note = notesCache.get(currentId);
    if (note) await queueUpsert(note);
  }
  renderFolderOptions();
  renderList();
  toast('已新建分类「' + name + '」，当前便签已移入');
});

els.renameFolderBtn.addEventListener('click', async () => {
  const plain = currentPlain();
  if (!plain) return;
  const from = (plain.folder || '').trim();
  if (!from) return;
  const to = promptFolderName(from, '重命名分类「' + from + '」为：');
  if (!to || to === from) return;
  const touched = await setFolderForAll(from, to);
  if (plain === plainCache.get(currentId)) plain.folder = to;
  renderFolderOptions();
  renderList();
  toast('分类「' + from + '」已重命名为「' + to + '」（' + touched + ' 条便签）');
});

els.deleteFolderBtn.addEventListener('click', async () => {
  const plain = currentPlain();
  if (!plain) return;
  const from = (plain.folder || '').trim();
  if (!from) return;
  if (!window.confirm('删除分类「' + from + '」？其中便签会移入' + UNGROUPED + '，便签本身不会删除。')) return;
  const touched = await setFolderForAll(from, '');
  if (plain === plainCache.get(currentId)) plain.folder = '';
  renderFolderOptions();
  renderList();
  toast('分类「' + from + '」已删除，' + touched + ' 条便签移入' + UNGROUPED);
});
els.attachmentList.addEventListener('click', (event) => {
  const remove = event.target.closest('[data-remove]');
  if (remove) { removeAttachment(remove.dataset.remove); return; }
  if (event.target.closest('[data-lightbox]')) openLightbox(event.target.src);
});

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
  if (!window.confirm('确定删除这条便签（含正文图片和录音）？删除会同步到 NAS。')) return;
  clearTimeout(saveTimer);
  stopRecording();
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
  const plain = plainCache.get(currentId) || { title: '', body: '', body_format: 'md', folder: '', attachments: [] };
  plain.title = els.titleInput.value;
  plain.body = els.bodyInput.value;
  plain.body_format = 'md';
  if (typeof plain.folder !== 'string') plain.folder = '';
  if (!Array.isArray(plain.attachments)) plain.attachments = [];
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
  if (document.visibilityState === 'hidden') {
    flushPendingEdit();
  } else if (syncMode === 'auto' && cryptoKey) {
    triggerSync(500);
  }
});

window.addEventListener('online', () => {
  if (!cryptoKey) return;
  if (syncMode === 'manual') {
    updateManualBadge();
    return;
  }
  setBadge('联网中');
  triggerSync(200);
});
window.addEventListener('offline', () => {
  if (cryptoKey) setBadge('离线', 'offline');
});

els.settingsBtn.addEventListener('click', () => {
  els.tokenInput.value = token;
  els.deviceInput.value = deviceId;
  els.syncMode.value = syncMode;
  els.syncInterval.value = String(syncIntervalSec);
  els.imageQuality.value = imageQuality;
  els.audioQuality.value = audioQuality;
  els.settingsDialog.showModal();
});
els.cancelSettings.addEventListener('click', () => els.settingsDialog.close());
els.saveSettings.addEventListener('click', () => {
  token = els.tokenInput.value.trim();
  deviceId = els.deviceInput.value.trim() || genId();
  const nextMode = els.syncMode.value === 'manual' ? 'manual' : 'auto';
  const rawInterval = els.syncInterval.value;
  const nextInterval = normalizeSyncInterval(rawInterval);
  imageQuality = IMAGE_PROFILES[els.imageQuality.value] ? els.imageQuality.value : 'balanced';
  audioQuality = AUDIO_PROFILES[els.audioQuality.value] ? els.audioQuality.value : 'balanced';
  localStorage.setItem('nn-token', token);
  localStorage.setItem('nn-device', deviceId);
  localStorage.setItem('nn-sync-mode', nextMode);
  localStorage.setItem('nn-sync-interval', String(nextInterval));
  localStorage.setItem('nn-image-quality', imageQuality);
  localStorage.setItem('nn-audio-quality', audioQuality);
  els.settingsDialog.close();

  const modeChanged = nextMode !== syncMode || nextInterval !== syncIntervalSec;
  syncMode = nextMode;
  syncIntervalSec = nextInterval;
  clearTimeout(syncTimer);
  if (syncMode === 'auto') {
    startAutoSync();
    if (cryptoKey) triggerSync(100);
  } else {
    stopAutoSync();
    updateManualBadge();
  }
  if (String(rawInterval) !== String(nextInterval)) {
    toast(`同步间隔已限制为 ${SYNC_INTERVAL_MIN}～${SYNC_INTERVAL_MAX} 秒`);
  } else if (modeChanged) {
    toast(syncMode === 'auto' ? `已切换自动同步，每 ${syncIntervalSec} 秒一次` : '已切换手动同步，需点击「同步」按钮');
  }
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
  syncMode = localStorage.getItem('nn-sync-mode') === 'manual' ? 'manual' : 'auto';
  syncIntervalSec = normalizeSyncInterval(localStorage.getItem('nn-sync-interval') || SYNC_INTERVAL_DEFAULT);
  imageQuality = localStorage.getItem('nn-image-quality') || 'balanced';
  audioQuality = localStorage.getItem('nn-audio-quality') || 'balanced';
  if (!IMAGE_PROFILES[imageQuality]) imageQuality = 'balanced';
  if (!AUDIO_PROFILES[audioQuality]) audioQuality = 'balanced';
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
