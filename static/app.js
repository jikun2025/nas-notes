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
let syncing = false;
let saveTimer = null;
let syncTimer = null;
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
const BODY_CONTAINER_TAGS = new Set([
  'div', 'p', 'span', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'blockquote', 'figcaption'
]);

function textToBodyHTML(text) {
  return esc(String(text || '')).replace(/\r?\n/g, '<br>');
}

function inlineFigureHTML(mime, data, name) {
  const safeMime = /^image\/(?:jpeg|png|webp|gif)$/i.test(String(mime || ''))
    ? String(mime).toLowerCase() : 'image/jpeg';
  const safeData = String(data || '').replace(/[^A-Za-z0-9+/=]/g, '');
  const label = esc(name || '图片');
  if (!safeData) return '';
  return '<figure class="inline-image" contenteditable="false">' +
    '<img src="data:' + safeMime + ';base64,' + safeData + '" alt="' + label + '" data-inline-image="1">' +
    '<figcaption>' + label + '</figcaption>' +
    '<button type="button" class="inline-remove" data-remove-inline="1" title="删除图片">✕</button>' +
    '</figure><div><br></div>';
}

function sanitizeBodyHTML(html) {
  const source = String(html || '');
  if (!source) return '';
  let doc;
  try {
    doc = new DOMParser().parseFromString('<div id="nn-root">' + source + '</div>', 'text/html');
  } catch (error) {
    return textToBodyHTML(source.replace(/<[^>]*>/g, ''));
  }
  const root = doc.getElementById('nn-root');
  if (!root) return '';
  const output = [];
  const render = (node, sink) => {
    if (node.nodeType === 3) { sink.push(esc(node.nodeValue || '')); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta'].includes(tag)) return;
    if (tag === 'br') { sink.push('<br>'); return; }
    if (tag === 'img') {
      const match = INLINE_IMG_RE.exec(node.getAttribute('src') || '');
      if (match) {
        sink.push('<img src="data:' + match[1] + ';base64,' + match[2] +
          '" alt="' + esc(node.getAttribute('alt') || '图片') + '" data-inline-image="1">');
      }
      return;
    }
    if (tag === 'figure' && node.classList.contains('inline-image')) {
      const img = node.querySelector('img');
      const match = img && INLINE_IMG_RE.exec(img.getAttribute('src') || '');
      if (!match) return;
      const caption = node.querySelector('figcaption');
      const label = esc((caption && caption.textContent) || img.getAttribute('alt') || '图片');
      sink.push('<figure class="inline-image" contenteditable="false">' +
        '<img src="data:' + match[1] + ';base64,' + match[2] + '" alt="' + label +
        '" data-inline-image="1"><figcaption>' + label + '</figcaption>' +
        '<button type="button" class="inline-remove" data-remove-inline="1" title="删除图片">✕</button>' +
        '</figure>');
      return;
    }
    const children = [];
    Array.from(node.childNodes).forEach((child) => render(child, children));
    if (BODY_CONTAINER_TAGS.has(tag)) {
      sink.push('<' + tag + '>' + children.join('') + '</' + tag + '>');
    } else {
      sink.push(children.join(''));
    }
  };
  Array.from(root.childNodes).forEach((child) => render(child, output));
  return output.join('');
}

function bodyText(plain) {
  const html = String((plain && plain.body) || '');
  if (!html) return '';
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  } catch (error) {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

function inlineImageCount(plain) {
  return (String((plain && plain.body) || '').match(/class="inline-image"/g) || []).length;
}

function normalizePlain(plain) {
  if (!plain || typeof plain !== 'object') return plain;
  if (typeof plain.body !== 'string') plain.body = plain.body == null ? '' : String(plain.body);
  const attachments = normalizeAttachments(plain.attachments);
  if (plain.body_format !== 'html') plain.body = textToBodyHTML(plain.body);
  const figures = attachments.filter((item) => item.kind === 'image')
    .map((item) => inlineFigureHTML(item.mime, item.data, item.name)).join('');
  plain.attachments = attachments.filter((item) => item.kind === 'audio');
  if (figures) plain.body += figures;
  plain.body_format = 'html';
  plain.body = sanitizeBodyHTML(plain.body);
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
    title: plain.title || '', body: plain.body || '', attachments: plain.attachments || []
  })).length;
}

async function addAttachments(items) {
  const plain = currentPlain();
  if (!plain) { toast('请先打开一条便签'); return; }
  let added = 0;
  let totalBytes = 0;
  for (const item of items) {
    if (plain.attachments.length >= 20) { toast('单条便签最多 20 段录音'); break; }
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

let savedBodyRange = null;

function rememberBodySelection() {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return;
  const node = selection.anchorNode;
  const element = node && (node.nodeType === 1 ? node : node.parentElement);
  if (element && els.bodyInput.contains(element)) {
    savedBodyRange = selection.getRangeAt(0).cloneRange();
  }
}

function insertHTMLAtSelection(html) {
  els.bodyInput.focus();
  const selection = window.getSelection();
  selection.removeAllRanges();
  if (savedBodyRange && els.bodyInput.contains(savedBodyRange.startContainer)) {
    selection.addRange(savedBodyRange);
  } else {
    const range = document.createRange();
    range.selectNodeContents(els.bodyInput);
    range.collapse(false);
    selection.addRange(range);
  }
  let inserted = false;
  try { inserted = document.execCommand('insertHTML', false, html); } catch (error) { inserted = false; }
  if (!inserted && selection.rangeCount) {
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const fragment = range.createContextualFragment(html);
    const last = fragment.lastChild;
    range.insertNode(fragment);
    if (last) {
      range.setStartAfter(last);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
  rememberBodySelection();
}

async function handleImageInput(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = '';
  if (!files.length) return;
  if (!currentPlain()) { toast('请先打开一条便签'); return; }
  let added = 0;
  let totalBytes = 0;
  for (const file of files) {
    try {
      const result = await compressImage(file);
      if (!result || !result.data) throw new Error('图片编码失败');
      const figure = inlineFigureHTML(result.mime, result.data, file.name || '图片');
      if (!figure) throw new Error('图片数据为空');
      if (encoder.encode(els.bodyInput.innerHTML + figure).length > MAX_PLAIN_JSON) {
        toast('便签体积已达上限，请删除部分图片');
        break;
      }
      insertHTMLAtSelection(figure);
      totalBytes += Number(result.bytes) || base64Bytes(result.data);
      added += 1;
    } catch (error) {
      console.warn('[NasNotes] inline image failed', error);
      toast('图片插入失败：' + (error && error.message ? error.message : '未知错误'));
    }
  }
  if (!added) return;
  handleEdit();
  toast(`已在正文中插入 ${added} 张图片（压缩后共 ${formatBytes(totalBytes)}，已加密）`);
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
  els.attachCount.textContent = items.length ? `${items.length} 段录音` : '';
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
  const before = plain.attachments.length;
  plain.attachments = plain.attachments.filter((item) => item.id !== id);
  if (plain.attachments.length === before) return;
  renderAttachments();
  const note = notesCache.get(currentId);
  if (note) await queueUpsert(note);
  toast('录音已删除');
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
  cryptoKey = null;
  plainCache.clear();
  currentId = null;
  document.body.classList.remove('show-editor');
  els.titleInput.value = '';
  els.bodyInput.innerHTML = '';
  savedBodyRange = null;
  els.attachmentList.innerHTML = '';
  els.attachCount.textContent = '';
  document.querySelectorAll('.image-lightbox').forEach((node) => node.remove());
  showLockScreen('unlock');
}

// ---------- 本地写入（始终先加密） ----------
async function queueUpsert(note) {
  if (!cryptoKey) return null;
  const plain = normalizePlain(plainCache.get(note.id) || {
    title: '', body: '', body_format: 'html', attachments: []
  });
  const sealed = await encryptJSON(cryptoKey, {
    title: plain.title || '',
    body: plain.body || '',
    body_format: 'html',
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
      || bodyText(item.plain).toLowerCase().includes(query)
      || (item.plain.attachments || []).some((att) =>
        (att.name || '').toLowerCase().includes(query)))
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
    const images = inlineImageCount(item.plain);
    const audios = (item.plain.attachments || []).length;
    const attachmentHint = (images ? ` 🖼${images}` : '') + (audios ? ` 🎤${audios}` : '');
    const snippet = (bodyText(item.plain).slice(0, 80) || '（空便签）') + attachmentHint;
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
    els.bodyInput.innerHTML = '';
    els.deleteBtn.hidden = true;
    els.attachCount.textContent = '';
    els.attachmentList.innerHTML = '';
  } else {
    normalizePlain(plain);
    els.titleInput.value = plain.title || '';
    els.bodyInput.innerHTML = plain.body || '';
    savedBodyRange = null;
    els.deleteBtn.hidden = false;
    renderAttachments();
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
  plainCache.set(id, { title: '', body: '', body_format: 'html', attachments: [] });
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

els.imageBtn.addEventListener('click', () => {
  if (!currentPlain()) { toast('请先打开一条便签'); return; }
  rememberBodySelection();
  els.imageInput.click();
});
els.imageInput.addEventListener('change', handleImageInput);
els.recordBtn.addEventListener('click', toggleRecording);
document.addEventListener('selectionchange', rememberBodySelection);
els.bodyInput.addEventListener('paste', (event) => {
  // 只接受纯文本，避免粘贴 HTML 带入脚本或多余体积。
  event.preventDefault();
  const text = (event.clipboardData && event.clipboardData.getData('text/plain')) || '';
  if (!text) return;
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
});
els.bodyInput.addEventListener('click', (event) => {
  const remove = event.target.closest('[data-remove-inline]');
  if (remove) {
    const figure = remove.closest('figure.inline-image');
    if (figure) {
      figure.remove();
      handleEdit();
      toast('正文图片已删除');
    }
    return;
  }
  if (event.target.closest('[data-inline-image]')) openLightbox(event.target.src);
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
  const plain = plainCache.get(currentId) || { title: '', body: '', body_format: 'html', attachments: [] };
  plain.title = els.titleInput.value;
  plain.body = els.bodyInput.innerHTML;
  plain.body_format = 'html';
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
  els.imageQuality.value = imageQuality;
  els.audioQuality.value = audioQuality;
  els.settingsDialog.showModal();
});
els.cancelSettings.addEventListener('click', () => els.settingsDialog.close());
els.saveSettings.addEventListener('click', () => {
  token = els.tokenInput.value.trim();
  deviceId = els.deviceInput.value.trim() || genId();
  imageQuality = IMAGE_PROFILES[els.imageQuality.value] ? els.imageQuality.value : 'balanced';
  audioQuality = AUDIO_PROFILES[els.audioQuality.value] ? els.audioQuality.value : 'balanced';
  localStorage.setItem('nn-token', token);
  localStorage.setItem('nn-device', deviceId);
  localStorage.setItem('nn-image-quality', imageQuality);
  localStorage.setItem('nn-audio-quality', audioQuality);
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
