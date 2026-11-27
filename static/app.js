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
const BACKUP_FORMAT = 'nas-notes-encrypted-backup-v2';
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
  lockServerBlock: document.getElementById('lockServerBlock'),
  lockServerInput: document.getElementById('lockServerInput'),
  lockServerTestBtn: document.getElementById('lockServerTestBtn'),
  lockServerState: document.getElementById('lockServerState'),
  usernameInput: document.getElementById('usernameInput'),
  passphraseLabel: document.getElementById('passphraseLabel'),
  passphraseInput: document.getElementById('passphraseInput'),
  confirmLabel: document.getElementById('confirmLabel'),
  confirmInput: document.getElementById('confirmInput'),
  lockError: document.getElementById('lockError'),
  unlockBtn: document.getElementById('unlockBtn'),
  lockLocalBtn: document.getElementById('lockLocalBtn'),
  lockOfflineNote: document.getElementById('lockOfflineNote'),
  resetVaultBtn: document.getElementById('resetVaultBtn'),
  resetPanel: document.getElementById('resetPanel'),
  resetConfirmInput: document.getElementById('resetConfirmInput'),
  resetVaultConfirmBtn: document.getElementById('resetVaultConfirmBtn'),
  resetCancelBtn: document.getElementById('resetCancelBtn'),
  syncBadge: document.getElementById('syncBadge'),
  sidebarEl: document.getElementById('sidebar'),
  railToggleBtn: document.getElementById('railToggleBtn'),
  railCloseBtn: document.getElementById('railCloseBtn'),
  railScrim: document.getElementById('railScrim'),
  folderRail: document.getElementById('folderRail'),
  folderFilter: document.getElementById('folderFilter'),
  newBtn: document.getElementById('newBtn'),
  searchInput: document.getElementById('searchInput'),
  searchCount: document.getElementById('searchCount'),
  noteList: document.getElementById('noteList'),
  syncBtn: document.getElementById('syncBtn'),
  lockBtn: document.getElementById('lockBtn'),
  settingsBtn: document.getElementById('settingsBtn'),
  settingsDialog: document.getElementById('settingsDialog'),
  settingsNav: document.querySelector('.settings-nav'),
  settingsTitle: document.getElementById('settingsTitle'),
  settingsClose: document.getElementById('settingsClose'),
  themeSelect: document.getElementById('themeSelect'),
  editorFontSelect: document.getElementById('editorFontSelect'),
  defaultViewSelect: document.getElementById('defaultViewSelect'),
  acctNameInput: document.getElementById('acctNameInput'),
  acctCurrentInput: document.getElementById('acctCurrentInput'),
  acctNewInput: document.getElementById('acctNewInput'),
  acctConfirmInput: document.getElementById('acctConfirmInput'),
  acctError: document.getElementById('acctError'),
  saveAccount: document.getElementById('saveAccount'),
  deviceInput: document.getElementById('deviceInput'),
  syncMode: document.getElementById('syncMode'),
  syncInterval: document.getElementById('syncInterval'),
  syncLocalState: document.getElementById('syncLocalState'),
  syncPendingCount: document.getElementById('syncPendingCount'),
  syncLastAt: document.getElementById('syncLastAt'),
  syncServerAddr: document.getElementById('syncServerAddr'),
  syncNowSettings: document.getElementById('syncNowSettings'),
  syncMsg: document.getElementById('syncMsg'),
  syncLoginDialog: document.getElementById('syncLoginDialog'),
  syncLoginHint: document.getElementById('syncLoginHint'),
  syncUser: document.getElementById('syncUser'),
  syncPass: document.getElementById('syncPass'),
  syncLoginError: document.getElementById('syncLoginError'),
  syncLoginCancel: document.getElementById('syncLoginCancel'),
  syncLoginOk: document.getElementById('syncLoginOk'),
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
  editorBar: document.getElementById('editorBar'),
  editorScroll: document.getElementById('editorScroll'),
  titleInput: document.getElementById('titleInput'),
  titleCount: document.getElementById('titleCount'),
  bodyCount: document.getElementById('bodyCount'),
  saveNowBtn: document.getElementById('saveNowBtn'),
  headingSelect: document.getElementById('headingSelect'),
  fontSizeSelect: document.getElementById('fontSizeSelect'),
  bodyInput: document.getElementById('bodyInput'),
  richPane: document.getElementById('richPane'),
  richEditor: document.getElementById('richEditor'),
  mdToolbar: document.getElementById('mdToolbar'),
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
  noteContextMenu: document.getElementById('noteContextMenu'),
  folderContextMenu: document.getElementById('folderContextMenu'),
  folderDialog: document.getElementById('folderDialog'),
  folderDialogTitle: document.getElementById('folderDialogTitle'),
  folderDialogSelect: document.getElementById('folderDialogSelect'),
  folderDialogNew: document.getElementById('folderDialogNew'),
  folderDialogCancel: document.getElementById('folderDialogCancel'),
  folderDialogSave: document.getElementById('folderDialogSave'),
  textDialog: document.getElementById('textDialog'),
  textDialogTitle: document.getElementById('textDialogTitle'),
  textDialogInput: document.getElementById('textDialogInput'),
  textDialogCancel: document.getElementById('textDialogCancel'),
  textDialogOk: document.getElementById('textDialogOk'),
  confirmDialog: document.getElementById('confirmDialog'),
  confirmTitle: document.getElementById('confirmTitle'),
  confirmMessage: document.getElementById('confirmMessage'),
  confirmCancel: document.getElementById('confirmCancel'),
  confirmOk: document.getElementById('confirmOk'),
  toast: document.getElementById('toast')
};

const notesCache = new Map();   // id -> 密文便签（可持久化）
const plainCache = new Map();   // id -> {title, body}（仅内存，绝不持久化）
// 内存全文/分类倒排索引：由已解密的 plainCache 构建，锁定即销毁；
// 明文绝不写进 IndexedDB、outbox、备份，也不发给服务端。
const noteIndex = (typeof NN_INDEX !== 'undefined' && NN_INDEX.create)
  ? NN_INDEX.create() : null;
const CURSOR_META_KEY = 'sync_cursor';   // 增量同步游标，只存 rev/epoch/salt
let cryptoKey = null;           // 保险库密钥 wkey（CryptoKey），仅内存
let wkeyBytes = null;           // wkey 原始字节（仅内存，改口令时重新包裹用）
let sessionToken = '';          // 登录换取的会话令牌（本机 localStorage）
let accountName = '';           // 当前登录账户名（仅显示用）
let vaultMeta = null;           // {salt, wrapped, iterations, version}
let initMode = false;
let currentId = null;
let deviceId = '';
let imageQuality = 'balanced';
let audioQuality = 'balanced';
// 离线优先：安卓壳里界面与数据都在本机，同步必须由用户主动触发，
// 所以壳内默认「手动」；浏览器直连 NAS 时保持自动。
const IS_SHELL = Boolean(window.__NN_SHELL__);
const DEFAULT_SYNC_MODE = IS_SHELL ? 'manual' : 'auto';
const SYNC_ERR_AUTH = 'auth';
const SYNC_ERR_NET = 'net';
const SYNC_ERR_VAULT = 'vault';
const SYNC_ERR_HTTP = 'http';

let syncMode = DEFAULT_SYNC_MODE;
let syncIntervalSec = SYNC_INTERVAL_DEFAULT;
let syncing = false;
let syncErrorKind = '';                                  // 上次同步失败的类型，用于状态文案
let offlineReady = false;                                // 本机已有可离线解锁的加密库
let lastSyncAt = localStorage.getItem('nn-last-sync') || '';
let syncLoginResolve = null;
let saveTimer = null;
let syncTimer = null;
let syncPollTimer = null;
let toastTimer = null;
let mediaRecorder = null;
let recordChunks = [];
let recordTimer = null;
let recordStartedAt = 0;
let theme = 'light';
let editorFont = 'normal';
let contextNoteId = null;
let longPressTimer = null;
let longPressFired = false;
let folderLongPressTimer = null;

// ---------- 外观（本机设置，不涉及加密数据） ----------
const EDITOR_FONT_PX = { small: '13px', normal: '15px', large: '18px', xlarge: '21px' };

function applyTheme(value) {
  theme = value === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  if (els.themeSelect) els.themeSelect.value = theme;
}

function applyEditorFont(value) {
  editorFont = EDITOR_FONT_PX[value] ? value : 'normal';
  document.documentElement.style.setProperty('--editor-fs', EDITOR_FONT_PX[editorFont]);
  if (els.editorFontSelect) els.editorFontSelect.value = editorFont;
  if (els.fontSizeSelect) els.fontSizeSelect.value = editorFont;
}

// ---------- 编辑视图 ----------
// 四种视图，对标 Joplin 的 editor / viewer / split 加上移动端的富文本模式：
//   rich   富文本：直接编辑渲染后的 DOM，看不到 Markdown 符号（默认）
//   source 纯 Markdown 源码
//   split  源码 + 实时预览
//   view   只读预览
const VIEW_MODES = ['rich', 'source', 'split', 'view'];

function isRichMode() { return viewMode === 'rich'; }
function isSourceMode() { return viewMode === 'source' || viewMode === 'split'; }

function applyViewMode(next, persist = true) {
  const wasRich = viewMode === 'rich';
  const target = VIEW_MODES.includes(next) ? next : 'rich';
  // 必须在改 viewMode 之前落盘：flushRich 内部有「当前不是富文本就直接返回」的保护
  if (wasRich && target !== 'rich') flushRich();
  viewMode = target;
  previewOn = viewMode === 'view';
  document.body.classList.remove('view-rich', 'view-source', 'view-split', 'view-view');
  document.body.classList.add('view-' + viewMode);
  document.querySelectorAll('[data-view]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewMode);
  });
  if (viewMode !== 'rich') clearRichToolbarState();
  if (viewMode === 'rich') renderRich();
  if (viewMode === 'source') autoGrowBody();
  if (viewMode === 'split' || viewMode === 'view') renderPreview();
  if (persist) localStorage.setItem('nn-view-mode', viewMode);
  syncHeadingSelect();
  updateCounters();
}

// 源码单栏时让 textarea 随内容增高，整个页面统一滚动（不再"盒子里套盒子"）
function autoGrowBody() {
  const ta = els.bodyInput;
  if (!ta || viewMode !== 'source') return;
  ta.style.height = 'auto';
  const next = Math.max(320, ta.scrollHeight + 2);
  ta.style.height = next + 'px';
}

function clearRichToolbarState() {
  if (!els.mdToolbar) return;
  els.mdToolbar.querySelectorAll('.md-btn.active').forEach((btn) => {
    if (String(btn.dataset.md || '').indexOf('fs-') !== 0) btn.classList.remove('active');
  });
}

function schedulePreview() {
  if (viewMode !== 'split' && viewMode !== 'view') return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => renderPreview(), 180);
}

function syncPaneScroll(from, to) {
  if (syncingScroll) return;
  const fromMax = from.scrollHeight - from.clientHeight;
  const toMax = to.scrollHeight - to.clientHeight;
  if (fromMax <= 0 || toMax <= 0) return;
  syncingScroll = true;
  to.scrollTop = (from.scrollTop / fromMax) * toMax;
  requestAnimationFrame(() => { syncingScroll = false; });
}

// ---------- 工具 ----------
function genId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
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
  els.syncBadge.className = 'badge sync-chip' + (kind ? ' ' + kind : '');
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
    if (cryptoKey && sessionToken && navigator.onLine && !document.hidden) {
      sync().catch(() => {});
    }
  }, syncIntervalSec * 1000);
}

// 同步状态：列表头部那颗胶囊既是状态也是入口（手机上侧栏是隐藏的，
// 没有它就没有任何手动同步入口）。
function formatClock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (sameDay) return `${hh}:${mm}`;
  return `${date.getMonth() + 1}-${date.getDate()} ${hh}:${mm}`;
}

async function pendingSyncCount() {
  try {
    return (await idbGetAll(STORE_OUT)).length;
  } catch (error) {
    return 0;
  }
}

async function updateSyncUI() {
  if (!els.syncBadge) return;
  const pending = cryptoKey ? await pendingSyncCount() : 0;
  let text = '未解锁';
  let kind = '';

  if (!cryptoKey) {
    text = '未解锁';
  } else if (syncing) {
    text = '同步中…';
  } else if (syncErrorKind === SYNC_ERR_AUTH) {
    text = '需登录同步';
    kind = 'error';
  } else if (syncErrorKind === SYNC_ERR_VAULT) {
    text = '库不一致';
    kind = 'error';
  } else if (syncErrorKind === SYNC_ERR_NET) {
    text = pending ? `离线 · 待同步 ${pending}` : '离线 · 本机已存';
    kind = 'offline';
  } else if (syncErrorKind === SYNC_ERR_HTTP) {
    text = '同步失败';
    kind = 'error';
  } else if (!sessionToken) {
    text = pending ? `离线可用 · 待同步 ${pending}` : '离线可用';
    kind = 'offline';
  } else if (pending) {
    text = `待同步 ${pending}`;
    kind = 'offline';
  } else if (lastSyncAt) {
    text = `已同步 ${formatClock(lastSyncAt)}`;
    kind = 'ok';
  } else {
    text = '已连接 NAS';
    kind = 'ok';
  }
  setBadge(text, kind);

  if (els.syncLocalState) {
    els.syncLocalState.textContent = cryptoKey
      ? (offlineReady ? '本机加密可用（离线可读写）' : '本机加密可用')
      : '未解锁';
  }
  if (els.syncPendingCount) els.syncPendingCount.textContent = cryptoKey ? `${pending} 条` : '—';
  if (els.syncLastAt) els.syncLastAt.textContent = lastSyncAt ? formatClock(lastSyncAt) : '从未同步';
  if (els.syncNowSettings) els.syncNowSettings.disabled = !cryptoKey || syncing;
}

// 兼容旧调用点：手动模式下更新状态胶囊。
async function updateManualBadge() {
  await updateSyncUI();
}

// 浏览器直连同源地址，没有「连哪台 NAS」的问题；只有安卓壳需要手填地址。
function nativeServerApi() {
  const api = window.NasNative;
  return api && typeof api.getServer === 'function' && typeof api.setServer === 'function' ? api : null;
}

// 允许只写 IP、IP:端口；统一补 https://（NAS 已切 HTTPS 反代）并去掉尾部斜杠。非法返回空串。
function normalizeServerUrl(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
  value = value.replace(/\/+$/, '');
  return /^https?:\/\/[^\s/?#]+$/i.test(value) ? value : '';
}

function fillLockServerInput() {
  if (!els.lockServerBlock) return;
  const api = nativeServerApi();
  els.lockServerBlock.hidden = !api;
  if (!api) return;
  if (!els.lockServerInput.value) {
    try { els.lockServerInput.value = api.getServer() || ''; } catch (error) { /* 桥异常按空处理 */ }
  }
  // 原生对象在、桥接脚本不在：说明 APK 里的 _bridge.js 没注入，所有 /api/ 请求
  // 都会落到静态资源拦截器上（502 Bridge Unavailable），登录和同步都不可能成功。
  if (!window.__NnBridge) {
    setLockServerState('壳内桥接脚本未加载：请求发不出去，请安装最新 APK', 'bad');
    return;
  }
  setLockServerState('');
}

function setLockServerState(text, kind) {
  if (!els.lockServerState) return;
  els.lockServerState.textContent = text || '';
  els.lockServerState.hidden = !text;
  els.lockServerState.className = 'lock-server-state' + (kind ? ' ' + kind : '');
}

// 登录/同步前把登录页填的地址写进原生配置（SharedPreferences）。
// 返回 false 表示格式不对，已提示，调用方应停下。
function saveServerFromLockInput() {
  const api = nativeServerApi();
  if (!api || !els.lockServerInput) return true;
  const raw = (els.lockServerInput.value || '').trim();
  if (!raw) return true;          // 留空沿用上次保存的地址
  const value = normalizeServerUrl(raw);
  if (!value) {
    showLockError('NAS 地址格式不对，例如 https://192.168.5.10:28443');
    return false;
  }
  try { api.setServer(value); } catch (error) { console.warn('[NasNotes] setServer failed', error); }
  els.lockServerInput.value = value;
  updateServerLabel();
  return true;
}

// 服务器地址只在壳里由原生层管理；浏览器直连时就是当前同源地址。
function updateServerLabel() {
  if (!els.syncServerAddr) return;
  let label = location.origin;
  try {
    if (window.NasNative && typeof window.NasNative.getServer === 'function') {
      label = window.NasNative.getServer() || '未设置（在登录页或设置里填入 NAS 地址）';
    }
  } catch (error) { /* 桥不可用时按同源显示 */ }
  els.syncServerAddr.textContent = label;
}

function syncMsgShow(message, isError) {
  if (!els.syncMsg) return;
  els.syncMsg.textContent = message || '';
  els.syncMsg.hidden = !message;
  els.syncMsg.className = 'muted tiny' + (isError ? ' error-text' : '');
}

// ---------- 窄屏分类抽屉（≤1180px 侧栏不再常驻） ----------
function railIsDrawer() {
  try {
    return window.matchMedia('(max-width: 1180px)').matches;
  } catch (error) {
    return window.innerWidth <= 1180;
  }
}

function setRailOpen(open) {
  const want = Boolean(open) && railIsDrawer();
  document.body.classList.toggle('rail-open', want);
  if (els.railToggleBtn) els.railToggleBtn.setAttribute('aria-expanded', want ? 'true' : 'false');
}

function openRail() { setRailOpen(true); }
function closeRail() { setRailOpen(false); }

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
  if (sessionToken) headers['X-Token'] = sessionToken;
  return headers;
}

// 会话过期：离线优先下绝不因此把用户踢回锁屏（会丢掉正在编辑的内容），
// 只标记「需登录同步」，编辑与解密照常。只有本机没有离线库时才回锁屏。
function handleSessionExpired() {
  sessionToken = '';
  localStorage.removeItem('nn-session');
  syncErrorKind = SYNC_ERR_AUTH;
  if (cryptoKey && offlineReady) {
    updateSyncUI();
    return;
  }
  if (cryptoKey) lockApp();
  else showLockScreen(vaultMeta && vaultMeta.salt ? 'unlock' : 'init');
  showLockError('会话已过期，请重新登录');
}

function syncFail(kind, message) {
  const error = new Error(message || kind);
  error.kind = kind;
  return error;
}

function isNetError(error) {
  if (!error) return false;
  if (error.kind === SYNC_ERR_NET) return true;
  const msg = String(error.message || '');
  return /Failed to fetch|NetworkError|连不上|timeout|timed out|ECONN|network|bridge unavailable/i.test(msg);
}

// ---------- WebCrypto ----------
async function deriveKey(passphrase, saltB64, iterations) {
  const material = await crypto.subtle.importKey(
    'raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey', 'deriveBits']
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

// 保险库密钥 wkey：随机生成、真正加密便签的密钥。它用
// AES-GCM(KDF(登录口令, salt), wkey) 包裹后存入 vault.wrapped——
// 修改登录口令只需换包裹层，wkey 不变，笔记密文无需重加密。
function randomWkeyBytes() {
  return crypto.getRandomValues(new Uint8Array(32));
}

async function importWkey(wkeyBytes) {
  return crypto.subtle.importKey('raw', wkeyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function wrapVault(wrapKey, wkeyBytes) {
  const sealed = await encryptJSON(wrapKey, { w: bytesToB64(wkeyBytes) });
  return sealed.iv + ':' + sealed.payload;
}

async function unwrapVault(wrapKey, wrapped) {
  const parts = String(wrapped || '').split(':');
  if (parts.length !== 2) throw new Error('bad wrapped format');
  const value = await decryptJSON(wrapKey, parts[0], parts[1]);
  if (!value || typeof value.w !== 'string') throw new Error('bad wrapped payload');
  return b64ToBytes(value.w);
}

// ---------- 本机保险库（离线优先） ----------
// 手机上必须能完全脱离 NAS 使用：vault（salt + 用密码包裹的 wkey）缓存在本机
// IndexedDB 里，输入密码就能解出 wkey，不需要任何网络请求。
// 「仅在本机使用」建的库带 local_only 标记，第一次连上服务器时再上传包裹层。
async function readLocalVault() {
  try {
    const row = await idbGet(STORE_META, 'vault');
    if (row && row.value) return JSON.parse(row.value);
  } catch (error) {
    console.warn('[NasNotes] read local vault failed', error);
  }
  return null;
}

async function saveLocalVault(meta) {
  await idbPut(STORE_META, { key: 'vault', value: JSON.stringify(meta) });
}

// 只用本机缓存的包裹层解锁。密码不对时 AES-GCM 校验失败会抛错，由调用方决定下一步。
async function unlockWithLocalVault(passphrase) {
  const meta = await readLocalVault();
  if (!meta || !meta.salt || !meta.wrapped) return null;
  const wrapKey = await deriveKey(passphrase, meta.salt, meta.iterations || PBKDF2_ITERATIONS);
  const wkey = await unwrapVault(wrapKey, meta.wrapped);
  const key = await importWkey(wkey);
  vaultMeta = meta;
  wkeyBytes = wkey;
  return key;
}

// 完全本机的加密库：本机生成 salt 与 wkey，密码只用于包裹。
// 不写服务端，不需要登录；之后用户主动同步时再把包裹层推上去。
async function createLocalVault(passphrase) {
  const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
  const wrapKey = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const wkey = randomWkeyBytes();
  const meta = {
    salt,
    wrapped: await wrapVault(wrapKey, wkey),
    iterations: PBKDF2_ITERATIONS,
    version: VAULT_VERSION,
    local_only: true
  };
  await saveLocalVault(meta);
  vaultMeta = meta;
  wkeyBytes = wkey;
  offlineReady = true;
  return importWkey(wkey);
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

// 三种编辑视图（借鉴 Joplin 的 editor / split / viewer）：分栏为桌面默认。
let viewMode = 'split';
let previewOn = false;          // 兼容旧逻辑：仅预览模式为 true
let previewTimer = null;
let syncingScroll = false;
let activeFolder = '';          // '' = 全部；UNGROUPED = 未分类；其余为分类名
let savedCaretPos = -1;

function currentCaret() {
  const ta = els.bodyInput;
  return (typeof ta.selectionStart === 'number' && document.activeElement === ta)
    ? ta.selectionStart : ta.value.length;
}

// 在光标处插入独立成行的图片占位符（仅预览态先切回可编辑态）
function insertImagePlaceholder(att, caret) {
  if (isRichMode()) {
    // 富文本：直接插入渲染好的图片块（保存时序列化回 ![[att:id]]）
    richInsertBlock(NN_MD.figureHTML(att) + '<p><br></p>');
    return;
  }
  if (viewMode === 'view') applyViewMode('source');
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
    if (viewMode === 'rich') renderRich();
    if (viewMode === 'split' || viewMode === 'view') renderPreview();
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

/** 单事务批量写：导入备份 / 增量拉取时不再为每条便签各开一个事务。 */
async function idbPutMany(storeName, values) {
  if (!values || values.length === 0) return;
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const value of values) store.put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- 锁屏与加密库 ----------
const DEFAULT_USERNAME = 'admin';

function showLockScreen(mode) {
  initMode = mode === 'init';
  els.lockScreen.hidden = false;
  els.lockTitle.textContent = IS_SHELL ? '轻签 · 本机便签' : '登录轻签';
  els.lockHint.textContent = initMode
    ? '第一次使用：填好 NAS 地址，再输入 NAS 的账户和密码登录并同步；暂时不连 NAS 就用下面的「仅在本机使用」（默认 admin / admin）。'
    : '输入密码解锁本机库即可离线读写；需要同步时点列表顶部的同步状态按钮。';
  fillLockServerInput();
  els.confirmLabel.hidden = true;
  els.confirmInput.hidden = true;
  els.resetPanel.hidden = true;
  els.resetConfirmInput.value = '';
  els.unlockBtn.textContent = initMode ? '登录并同步' : '解锁';
  els.lockLocalBtn.hidden = !initMode;
  if (els.lockOfflineNote) els.lockOfflineNote.hidden = !initMode;
  els.lockError.hidden = true;
  if (!els.usernameInput.value) {
    els.usernameInput.value = accountName || localStorage.getItem('nn-account') || DEFAULT_USERNAME;
  }
  els.passphraseInput.value = '';
  els.confirmInput.value = '';
  offlineReady = Boolean(vaultMeta && vaultMeta.wrapped);
  setBadge(initMode ? '本机无库' : '未解锁');
  setTimeout(() => (els.passphraseInput.value ? els.passphraseInput : (initMode ? els.usernameInput : els.passphraseInput)).focus(), 0);
}

function showLockError(message) {
  els.lockError.textContent = message;
  els.lockError.hidden = false;
}

// 普通账户登录：账户名 + 密码 → 服务端校验（哈希入库）→ 会话令牌。
// 不依赖 WebCrypto：局域网 HTTP / 安卓 WebView 下也能稳定登录。
async function loginAccount(username, password) {
  const resp = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (resp.status === 401) return null;
  if (resp.status === 429) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || '尝试次数过多，请稍后再试');
  }
  if (!resp.ok) throw new Error('登录失败: HTTP ' + resp.status);
  const data = await resp.json();
  sessionToken = data.token || '';
  accountName = data.username || username;
  localStorage.setItem('nn-session', JSON.stringify({ token: sessionToken, username: accountName }));
  localStorage.setItem('nn-account', accountName);
  localStorage.removeItem('nn-token');   // 旧版令牌残留清理
  return data;
}

async function fetchMeta() {
  const response = await fetch('/api/meta', { headers: authHeaders() });
  if (response.status === 401) {
    handleSessionExpired();
    throw new Error('会话已过期');
  }
  if (!response.ok) throw new Error('读取加密库信息失败: HTTP ' + response.status);

  const meta = await response.json();
  if (meta.initialized) {
    // 本机若是「仅本机使用」建的库、且服务器是另一套密钥，绝不悄悄覆盖本机包裹层，
    // 否则本机笔记会立刻解不开。交由调用方提示用户处理。
    const localOnly = vaultMeta && vaultMeta.local_only;
    const mismatch = localOnly && vaultMeta.salt && meta.salt && vaultMeta.salt !== meta.salt;
    if (!mismatch) {
      vaultMeta = {
        salt: meta.salt,
        wrapped: meta.wrapped,
        iterations: meta.iterations,
        version: meta.version,
        legacy: Boolean(meta.verifier && !meta.wrapped)
      };
      if (vaultMeta.legacy) vaultMeta.verifier = meta.verifier;
      await saveLocalVault(vaultMeta);
    }
  }
  return meta;
}

// 解锁后的公共收尾：解密本机密文、恢复分类、渲染，并决定要不要联网。
async function afterUnlock(key) {
  cryptoKey = key;
  offlineReady = true;
  syncErrorKind = '';
  els.lockScreen.hidden = true;
  els.passphraseInput.value = '';
  els.confirmInput.value = '';
  await rebuildPlainCache();
  await loadFolderRegistry();
  setSaveState('已解锁');
  renderList();
  renderEditor();
  await updateSyncUI();
  // 只有「自动」模式才会在解锁瞬间联网；手动模式（安卓壳默认）绝不主动请求，
  // 否则就是用户说的「在线版便签」了。
  if (syncMode === 'auto' && sessionToken) {
    startAutoSync();
    try { await sync(); } catch (error) { /* 状态胶囊已展示失败原因 */ }
  } else {
    stopAutoSync();
  }
}

function countLocalNotes() {
  let count = 0;
  for (const note of notesCache.values()) if (!note.deleted) count += 1;
  return count;
}

// 改用服务器库前清空本机这些密的便签（账户不动）。用于确认过「放弃本机离线库」之后。
async function clearLocalNotes() {
  notesCache.clear();
  plainCache.clear();
  if (noteIndex) noteIndex.clear();
  await resetSyncCursor();
  for (const store of [STORE_NOTES, STORE_OUT]) {
    try {
      const rows = await idbGetAll(store);
      for (const row of rows) await idbDelete(store, row.id);
    } catch (error) { /* 清不掉就继续，下面会覆盖写入 */ }
  }
  currentId = null;
  renderList();
  renderEditor();
}

function logoutQuiet() {
  sessionToken = '';
  localStorage.removeItem('nn-session');
}

// 联网解锁：登录 → 对齐服务器加密库 → 用密码解出 wkey。
// 返回 CryptoKey；返回 null 表示已给出提示、应停在锁屏。
async function unlockOnline(username, passphrase) {
  const session = await loginAccount(username, passphrase);
  if (!session) {
    showLockError('账户或密码不正确');
    return null;
  }
  localStorage.setItem('nn-account', accountName);

  const server = await readServerVault();

  // 旧版库（口令密钥直接加密笔记、没有 wkey 包裹）：沿用原来的静默迁移路径
  if (server.initialized && !server.wrapped && server.verifier) {
    vaultMeta = {
      salt: server.salt, wrapped: '', iterations: server.iterations,
      version: server.version, legacy: true, verifier: server.verifier
    };
    await saveLocalVault(vaultMeta);
    const legacyKey = await deriveKey(passphrase, vaultMeta.salt, vaultMeta.iterations);
    if (!(await checkLegacyVerifier(legacyKey, vaultMeta.verifier))) {
      showLockError('旧加密库需要用升级前的加密口令迁移；可点「忘记密码？」清空重建');
      return null;
    }
    return migrateLegacyVault(legacyKey, passphrase);
  }

  if (server.initialized && server.wrapped) {
    const sameVault = Boolean(vaultMeta && vaultMeta.salt && vaultMeta.salt === server.salt);
    const localCount = countLocalNotes();
    if (!sameVault && vaultMeta && vaultMeta.local_only && localCount > 0) {
      const adopt = await askConfirm(
        '服务器上是另一套加密库',
        `本机有一个独立的离线库（${localCount} 条便签），它与服务器的加密库密钥不同，无法自动合并。` +
        `改用服务器库会清空本机这 ${localCount} 条便签，建议先到「设置 → 数据与备份」导出备份。要改用服务器库吗？`,
        '改用服务器库'
      );
      if (!adopt) {
        logoutQuiet();
        showLockError('已保持本机离线库不变。要同步请先导出本机备份，再改用服务器库。');
        return null;
      }
      await clearLocalNotes();
    }
    vaultMeta = {
      salt: server.salt,
      wrapped: server.wrapped,
      iterations: server.iterations || PBKDF2_ITERATIONS,
      version: server.version || VAULT_VERSION
    };
    await saveLocalVault(vaultMeta);
    const wrapKey = await deriveKey(passphrase, vaultMeta.salt, vaultMeta.iterations);
    let wkey;
    try {
      wkey = await unwrapVault(wrapKey, vaultMeta.wrapped);
    } catch (error) {
      showLockError('这个密码解不开服务器上的加密库（可能是在别的设备改过密码）。可在锁屏页用「清空加密库重新开始」重建');
      return null;
    }
    wkeyBytes = wkey;
    return importWkey(wkey);
  }

  // 服务器还没有加密库：本机若已有库（例如先在手机离线用了一阵）就把它推上去，
  // 这样手机上的离线笔记不会因为连了一次 NAS 就丢掉。
  if (vaultMeta && vaultMeta.salt && vaultMeta.wrapped) {
    const resp = await fetch('/api/meta', {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({
        salt: vaultMeta.salt, wrapped: vaultMeta.wrapped,
        iterations: vaultMeta.iterations, version: vaultMeta.version, replace: true
      })
    });
    if (resp.status === 409) {
      await fetchMeta();
    } else if (!resp.ok) {
      throw new Error('上传本机加密库失败: HTTP ' + resp.status);
    } else {
      vaultMeta = Object.assign({}, vaultMeta, { local_only: false });
      await saveLocalVault(vaultMeta);
    }
    const wrapKey = await deriveKey(passphrase, vaultMeta.salt, vaultMeta.iterations);
    let wkey;
    try {
      wkey = await unwrapVault(wrapKey, vaultMeta.wrapped);
    } catch (error) {
      showLockError('本机离线库的密码与刚输入的不一致：请用创建本机库时的那个密码');
      return null;
    }
    wkeyBytes = wkey;
    return importWkey(wkey);
  }

  // 两边都没有库：用登录密码新建
  const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
  const wrapKey = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const newWkey = randomWkeyBytes();
  const meta = {
    salt,
    wrapped: await wrapVault(wrapKey, newWkey),
    iterations: PBKDF2_ITERATIONS,
    version: VAULT_VERSION
  };
  const response = await fetch('/api/meta', {
    method: 'PUT', headers: authHeaders(), body: JSON.stringify(meta)
  });
  if (response.status === 409) {
    await fetchMeta();   // 其他设备刚建库，改用它的包裹层
    if (!vaultMeta || !vaultMeta.wrapped) return null;
    const remoteWrap = await deriveKey(passphrase, vaultMeta.salt, vaultMeta.iterations);
    try {
      wkeyBytes = await unwrapVault(remoteWrap, vaultMeta.wrapped);
    } catch (error) {
      showLockError('其他设备刚创建的加密库与本密码不匹配，请用那台设备的密码登录');
      return null;
    }
    return importWkey(wkeyBytes);
  }
  if (!response.ok) throw new Error('初始化加密库失败: HTTP ' + response.status);
  vaultMeta = meta;
  wkeyBytes = newWkey;
  await saveLocalVault(vaultMeta);
  return importWkey(newWkey);
}

async function handleUnlock() {
  const username = (els.usernameInput.value || '').trim() || DEFAULT_USERNAME;
  const passphrase = els.passphraseInput.value;
  els.lockError.hidden = true;
  setLockServerState('');
  // 先把登录页填的 NAS 地址写进原生配置，否则登录请求会打到上次的旧地址。
  if (!saveServerFromLockInput()) return;
  if (!passphrase) return showLockError('请输入密码');
  els.unlockBtn.disabled = true;

  try {
    // 1) 本机优先：不发任何网络请求，断网、NAS 关机都能解锁。
    if (vaultMeta && vaultMeta.wrapped) {
      let localKey = null;
      try {
        localKey = await unlockWithLocalVault(passphrase);
      } catch (error) {
        localKey = null;   // 密码不对 → 再用服务器验证（可能密码在别的设备改过）
      }
      if (localKey) {
        accountName = accountName || localStorage.getItem('nn-account') || DEFAULT_USERNAME;
        await afterUnlock(localKey);
        return;
      }
      try {
        const key = await unlockOnline(username, passphrase);
        if (key) await afterUnlock(key);
      } catch (error) {
        if (isNetError(error)) {
          showLockError('本机密码不正确，且连不上 NAS 无法在线验证。');
        } else {
          throw error;
        }
      }
      return;
    }

    // 2) 本机还没有库：必须联网登录一次（创建或接管服务器库）
    let key = null;
    try {
      key = await unlockOnline(username, passphrase);
    } catch (error) {
      if (isNetError(error)) {
        els.lockLocalBtn.hidden = false;
        if (els.lockOfflineNote) els.lockOfflineNote.hidden = false;
        showLockError('连不上 NAS，无法登录。若想先离线使用，请点下方「仅在本机使用」用当前密码创建本机加密库。');
        return;
      }
      throw error;
    }
    if (key) await afterUnlock(key);
  } catch (error) {
    console.warn('[NasNotes] unlock failed', error);
    showLockError('操作失败：' + (error && error.message ? error.message : '未知错误'));
  } finally {
    els.unlockBtn.disabled = false;
  }
}

async function checkLegacyVerifier(key, verifier) {
  try {
    const parts = String(verifier || '').split(':');
    if (parts.length !== 2) return false;
    const value = await decryptJSON(key, parts[0], parts[1]);
    return Boolean(value && value.check === 'nas-notes-vault-v1');
  } catch (error) {
    return false;
  }
}

// 旧库（口令密钥直加密）→ 新结构（随机 wkey + 口令包裹）。迁移在本机完成：
// 全部笔记解密后用 wkey 重加密，再原子替换服务端 vault 包裹并重推密文。
async function migrateLegacyVault(legacyKey, passphrase) {
  const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
  const wrapKey = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const newWkey = randomWkeyBytes();
  const wkey = await importWkey(newWkey);

  // 逐条解密并用 wkey 重加密（先只更新本机缓存与队列，成功后再提交 vault）
  const resealed = [];
  for (const note of notesCache.values()) {
    if (note.deleted || !note.payload) continue;
    try {
      const plain = await decryptJSON(legacyKey, note.iv, note.payload);
      const sealed = await encryptJSON(wkey, plain);
      resealed.push(Object.assign({}, note, { iv: sealed.iv, payload: sealed.payload }));
    } catch (error) {
      console.warn('[NasNotes] legacy re-encrypt failed', note.id, error);
    }
  }

  const meta = {
    salt,
    wrapped: await wrapVault(wrapKey, newWkey),
    iterations: PBKDF2_ITERATIONS,
    version: VAULT_VERSION,
    replace: true
  };
  const response = await fetch('/api/meta', {
    method: 'PUT', headers: authHeaders(), body: JSON.stringify(meta)
  });
  if (!response.ok) throw new Error('加密库升级失败: HTTP ' + response.status);

  vaultMeta = { salt, wrapped: meta.wrapped, iterations: PBKDF2_ITERATIONS, version: VAULT_VERSION };
  wkeyBytes = newWkey;   // 供改口令时重新包裹（仅内存）
  await idbPut(STORE_META, { key: 'vault', value: JSON.stringify(vaultMeta) });
  for (const note of resealed) {
    notesCache.set(note.id, note);
    await idbPut(STORE_NOTES, note);
    await idbPut(STORE_OUT, {
      id: note.id,
      method: 'PUT',
      payload: { iv: note.iv, payload: note.payload, updated_at: note.updated_at, device: deviceId },
      queued_at: Date.now()
    });
  }
  toast('加密库已升级为口令包裹结构');
  return wkey;
}

async function rebuildPlainCache() {
  plainCache.clear();
  if (noteIndex) noteIndex.clear();
  let failed = 0;
  for (const note of notesCache.values()) {
    if (note.deleted || !note.payload) continue;
    try {
      const plain = await decryptJSON(cryptoKey, note.iv, note.payload);
      if (plain && typeof plain.title === 'string' && typeof plain.body === 'string') {
        normalizePlain(plain);
        plainCache.set(note.id, plain);
        indexNote(note.id, plain);
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
  // 注意：这里不再撤销服务端会话。「锁定」只清内存里的明文与密钥，
  // 会话令牌本来就存在本机 localStorage；保留它才能做到「解锁后直接同步」，
  // 也避免离线时发一个必定失败的 /api/logout 请求。
  cryptoKey = null;
  wkeyBytes = null;
  plainCache.clear();
  if (noteIndex) noteIndex.clear();   // 明文索引只在解锁期间存在
  folderRegistry = [];
  currentId = null;
  closeRail();
  document.body.classList.remove('show-editor');
  els.titleInput.value = '';
  els.bodyInput.value = '';
  els.mdPreview.innerHTML = '';
  if (els.richEditor) els.richEditor.innerHTML = '';
  applyViewMode('rich', false);
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
  indexNote(updated.id);
  setSaveState('已存本机');

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
  if (noteIndex) noteIndex.remove(noteId);
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

// ---------- 同步（只在用户主动点，或 Web 端自动模式时发生） ----------
// 增量同步游标：只存服务端分配的 rev、加密库代际 epoch 与 vault salt。
// 三者任一变化都强制回退全量；游标里不含任何明文，符合端到端加密约束。
async function readSyncCursor() {
  try {
    const row = await idbGet(STORE_META, CURSOR_META_KEY);
    if (!row || !row.value) return null;
    const value = JSON.parse(row.value);
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    return null;
  }
}
async function writeSyncCursor(value) {
  await idbPut(STORE_META, { key: CURSOR_META_KEY, value: JSON.stringify(value) });
}
async function resetSyncCursor() {
  try { await idbDelete(STORE_META, CURSOR_META_KEY); } catch (error) { /* 清不掉按全量处理 */ }
}

// 读服务器 vault，但不写本机缓存：先确认两边是同一套加密库，再谈同步。
async function readServerVault() {
  let response;
  try {
    response = await fetch('/api/meta', { headers: authHeaders() });
  } catch (error) {
    throw syncFail(SYNC_ERR_NET, '连不上 NAS 服务器');
  }
  if (response.status === 401) throw syncFail(SYNC_ERR_AUTH, '服务器登录已失效');
  if (!response.ok) throw syncFail(SYNC_ERR_HTTP, '读取加密库信息失败: HTTP ' + response.status);
  return response.json();
}

// 「仅本机使用」的库第一次连上服务器时把包裹层推上去，之后两端就是同一套密钥。
async function uploadLocalVault() {
  const resp = await fetch('/api/meta', {
    method: 'PUT', headers: authHeaders(),
    body: JSON.stringify({
      salt: vaultMeta.salt, wrapped: vaultMeta.wrapped,
      iterations: vaultMeta.iterations, version: vaultMeta.version,
      replace: Boolean(vaultMeta.local_only)
    })
  });
  if (resp.status === 401) throw syncFail(SYNC_ERR_AUTH, '服务器登录已失效');
  if (resp.status === 409) throw syncFail(SYNC_ERR_VAULT, '服务器上已有加密库');
  if (!resp.ok) throw syncFail(SYNC_ERR_HTTP, '上传加密库失败: HTTP ' + resp.status);
  vaultMeta = Object.assign({}, vaultMeta, { local_only: false });
  await saveLocalVault(vaultMeta);
}

async function sync() {
  if (syncing || !cryptoKey) return false;
  if (!sessionToken) throw syncFail(SYNC_ERR_AUTH, '需要登录 NAS 才能同步');

  syncing = true;
  syncErrorKind = '';
  setBadge('同步中…');
  updateSyncUI();
  try {
    // 0) 库一致性。服务器还没有库就上传本机库；服务器是另一套库就停下，
    //    绝不把本机密文推进去（推过去别的设备也解不开）。
    const meta = await readServerVault();
    if (!meta.initialized) {
      await uploadLocalVault();
    } else if (vaultMeta && meta.salt && vaultMeta.salt !== meta.salt) {
      throw syncFail(SYNC_ERR_VAULT, '本机与服务器的加密库不是同一套密钥');
    } else if (vaultMeta && vaultMeta.local_only) {
      vaultMeta = Object.assign({}, vaultMeta, { local_only: false });
      await saveLocalVault(vaultMeta);
    }

    const outbox = await idbGetAll(STORE_OUT);
    outbox.sort((a, b) => a.queued_at - b.queued_at);

    for (const op of outbox) {
      let response;
      try {
        response = await fetch('/api/notes/' + encodeURIComponent(op.id), {
          method: op.method,
          headers: authHeaders(),
          body: JSON.stringify(op.payload || {})
        });
      } catch (error) {
        throw syncFail(SYNC_ERR_NET, '推送时连不上 NAS');
      }
      if (response.status === 401) throw syncFail(SYNC_ERR_AUTH, '服务器登录已失效');
      if (!response.ok) throw syncFail(SYNC_ERR_HTTP, '推送失败: HTTP ' + response.status);

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
          indexNote(op.id, plain);
        } catch (error) {
          console.warn('[NasNotes] decrypt pushed note failed', op.id, error);
          noteIndexRemove(op.id);
        }
      } else {
        plainCache.delete(op.id);
        noteIndexRemove(op.id);
      }
      if (result.applied === false) toast('检测到更新冲突，已采用服务端版本');
    }

    // ---- 增量拉取 ----
    // 游标是服务端分配的 rev（与本机时钟无关），只存 rev/epoch/salt，无明文。
    // 老服务端不返回 rev/nextSince 时自动退化为「一次全量、不写游标」，不会失效。
    const vaultSalt = (vaultMeta && vaultMeta.salt) || '';
    const serverEpoch = Number(meta.epoch) || 0;
    const cursor = await readSyncCursor();
    let since = 0;
    if (cursor && cursor.salt === vaultSalt && cursor.epoch === serverEpoch
        && Number.isFinite(cursor.rev) && cursor.rev >= 0) {
      since = cursor.rev;
    } else if (cursor && cursor.epoch !== serverEpoch) {
      toast('服务器加密库已被重置，本次做全量对齐');
    }

    const pendingIds = new Set((await idbGetAll(STORE_OUT)).map((item) => item.id));
    let incremental = true;
    let finalRev = since;
    let pages = 0;
    let keepPulling = true;
    while (keepPulling && pages < 200) {
      pages += 1;
      let response;
      try {
        response = await fetch('/api/notes?since=' + encodeURIComponent(String(since)),
          { headers: authHeaders() });
      } catch (error) {
        throw syncFail(SYNC_ERR_NET, '拉取时连不上 NAS');
      }
      if (response.status === 401) throw syncFail(SYNC_ERR_AUTH, '服务器登录已失效');
      if (!response.ok) throw syncFail(SYNC_ERR_HTTP, '拉取失败: HTTP ' + response.status);

      const data = await response.json();
      if (typeof data.rev !== 'number' || typeof data.nextSince !== 'number') {
        incremental = false;   // 老服务端：忽略分页字段，按一次性全量处理
      }
      const pulled = [];
      for (const note of data.notes || []) {
        if (pendingIds.has(note.id)) continue;
        const local = notesCache.get(note.id);
        // 冲突裁决仍是 last-write-wins + device 字典序，与服务端 is_newer 完全一致；
        // rev 只用于分页与游标，绝不参与裁决（双端一致是硬约束）。
        if (!local || isNewer(note.updated_at, note.device, local.updated_at, local.device)) {
          pulled.push(note);
          notesCache.set(note.id, note);
          if (!note.deleted && note.payload) {
            try {
              const plain = await decryptJSON(cryptoKey, note.iv, note.payload);
              normalizePlain(plain);
              plainCache.set(note.id, plain);
              indexNote(note.id, plain);
            } catch (error) {
              console.warn('[NasNotes] decrypt pulled note failed', note.id, error);
              noteIndexRemove(note.id);
            }
          } else {
            plainCache.delete(note.id);
            noteIndexRemove(note.id);
          }
        }
      }
      if (pulled.length) await idbPutMany(STORE_NOTES, pulled);

      if (!incremental) { keepPulling = false; break; }
      if (since > data.rev) {
        // 本机游标比服务端还大（连到另一套库 / 服务端重建过）：从 0 重来一次
        since = 0;
        continue;
      }
      finalRev = data.nextSince;
      keepPulling = Boolean(data.partial);
      if (keepPulling) since = data.nextSince;
    }
    if (incremental) {
      await writeSyncCursor({ rev: finalRev, epoch: serverEpoch, salt: vaultSalt });
    }

    lastSyncAt = new Date().toISOString();
    localStorage.setItem('nn-last-sync', lastSyncAt);
    syncErrorKind = '';
    setBadge('已同步', 'ok');
    setSaveState('已同步');
    renderList();
    if (currentId) updateEditorMeta();
    return true;
  } catch (error) {
    syncErrorKind = error.kind || SYNC_ERR_HTTP;
    console.warn('[NasNotes] sync failed', error);
    setBadge(syncErrorKind === SYNC_ERR_NET ? '离线 · 本机已存' : '同步失败',
      syncErrorKind === SYNC_ERR_NET ? 'offline' : 'error');
    throw error;
  } finally {
    syncing = false;
    updateSyncUI();
  }
}

// 手动同步：先把当前编辑落盘，再确保有服务器会话，最后跑一次双向同步。
async function doManualSync() {
  if (!cryptoKey) {
    toast('请先解锁');
    return;
  }
  if (syncing) return;
  clearTimeout(syncTimer);
  flushRich();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    const note = notesCache.get(currentId);
    if (note) await queueUpsert(note);
  }
  if (!sessionToken) {
    const connected = await openSyncLogin();
    if (!connected) return;
  }
  try {
    await sync();
    toast('已与 NAS 同步');
    syncMsgShow('同步完成：' + formatClock(lastSyncAt), false);
  } catch (error) {
    // 会话失效时清掉令牌：用户再点一次同步就会走「连接 NAS」输入密码，而不是反复失败。
    if (error.kind === SYNC_ERR_AUTH) logoutQuiet();
    const message = error.kind === SYNC_ERR_AUTH
      ? '登录已失效，请重新连接 NAS（再点一次即可输入密码）'
      : error.kind === SYNC_ERR_VAULT
        ? '本机与服务器的加密库不一致，已停止同步（不会覆盖任何一边）'
        : error.kind === SYNC_ERR_NET
          ? '连不上 NAS，本机修改已保存，稍后可再同步'
          : '同步失败：' + (error.message || '未知错误');
    toast(message);
    syncMsgShow(message, true);
    updateSyncUI();
  }
}

// 同步前的小登录框（离线解锁后没有会话令牌时用）。
function openSyncLogin() {
  return new Promise((resolve) => {
    syncLoginResolve = (value) => {
      syncLoginResolve = null;
      resolve(Boolean(value));
    };
    els.syncUser.value = accountName || localStorage.getItem('nn-account') || DEFAULT_USERNAME;
    els.syncPass.value = '';
    els.syncLoginError.hidden = true;
    if (els.syncLoginHint) {
      els.syncLoginHint.textContent = '本机修改已加密保存，不会丢。同步只是把本机与 NAS 对齐，需要 NAS 上的账户密码。';
    }
    if (!openDialog(els.syncLoginDialog)) {
      const done = syncLoginResolve;
      syncLoginResolve = null;
      done(false);
      return;
    }
    setTimeout(() => els.syncPass.focus(), 30);
  });
}

function closeSyncLogin(ok) {
  closeDialog(els.syncLoginDialog);
  if (syncLoginResolve) syncLoginResolve(ok);
}

function triggerSync(delay = 300) {
  if (syncMode !== 'auto' || !cryptoKey || !sessionToken) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { sync().catch(() => {}); }, delay);
}

// ---------- 渲染（明文只来自内存） ----------
const UNGROUPED = '未分类';
const collapsedFolders = new Set();   // 仅内存：折叠的分类名

// 分类清单：分类原本只能从便签的 folder 字段反推，于是「空分类」根本不存在——
// 连续新建两个分类时，旧分类下没有便签就会消失，看起来像被新分类覆盖了。
// 这里额外维护一份本机分类清单（与便签一样用 wkey 加密后存 IndexedDB），
// 让空分类也能留着；有便签的分类仍随便签同步到其他设备。
const FOLDERS_META_KEY = 'folders';
let folderRegistry = [];

function normalizeFolderName(name) {
  const value = typeof name === 'string' ? name.trim().slice(0, 100) : '';
  return value === UNGROUPED ? '' : value;
}

function registerFolder(name) {
  const value = normalizeFolderName(name);
  if (!value || folderRegistry.indexOf(value) >= 0) return false;
  folderRegistry.push(value);
  folderRegistry.sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return true;
}

function unregisterFolder(name) {
  const value = normalizeFolderName(name);
  const next = folderRegistry.filter((item) => item !== value);
  if (next.length === folderRegistry.length) return false;
  folderRegistry = next;
  return true;
}

async function loadFolderRegistry() {
  folderRegistry = [];
  if (!cryptoKey) return;
  try {
    const row = await idbGet(STORE_META, FOLDERS_META_KEY);
    const parts = String((row && row.value) || '').split(':');
    if (parts.length !== 2) return;
    const list = await decryptJSON(cryptoKey, parts[0], parts[1]);
    if (Array.isArray(list)) list.forEach((name) => registerFolder(name));
  } catch (error) {
    console.warn('[NasNotes] 分类清单解密失败，按便签重建', error);
    folderRegistry = [];
  }
}

async function persistFolderRegistry() {
  if (!cryptoKey) return;
  try {
    const sealed = await encryptJSON(cryptoKey, folderRegistry.slice());
    await idbPut(STORE_META, { key: FOLDERS_META_KEY, value: sealed.iv + ':' + sealed.payload });
  } catch (error) {
    console.warn('[NasNotes] 保存分类清单失败', error);
  }
}

function allFolders() {
  const names = new Set(folderRegistry);
  for (const note of notesCache.values()) {
    if (note.deleted) continue;
    const plain = plainCache.get(note.id);
    const folder = plain && typeof plain.folder === 'string' ? plain.folder.trim() : '';
    if (folder) names.add(folder.slice(0, 100));
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

// 分类导航（三区布局的左栏）：分类计数来自内存明文，不访问服务端。
function renderFolderRail() {
  const counts = new Map();
  let total = 0;
  for (const note of notesCache.values()) {
    if (note.deleted) continue;
    total += 1;
    const plain = plainCache.get(note.id);
    const folder = (plain && typeof plain.folder === 'string' && plain.folder.trim().slice(0, 100))
      || UNGROUPED;
    counts.set(folder, (counts.get(folder) || 0) + 1);
  }
  const folders = allFolders();
  const names = folders.concat(counts.has(UNGROUPED) ? [UNGROUPED] : []);
  const rail = [{ key: '', label: '全部便签', count: total }].concat(
    names.map((name) => ({ key: name, label: name, count: counts.get(name) || 0 }))
  );
  if (activeFolder && !names.includes(activeFolder)) activeFolder = '';
  els.folderRail.innerHTML = rail.map((item) =>
    '<button type="button" class="rail-item' + (item.key === activeFolder ? ' active' : '') +
    '" data-folder="' + esc(item.key) + '"><span class="rail-name">' + esc(item.label) +
    '</span><span class="rail-count">' + item.count + '</span></button>'
  ).join('');
  els.folderFilter.innerHTML = rail.map((item) =>
    '<option value="' + esc(item.key) + '">' + esc(item.label) + '（' + item.count + '）</option>'
  ).join('');
  els.folderFilter.value = activeFolder;
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
  // 当前便签已归类时就可以给整个分类改名/删除（原来判断成“分类不在清单里才显示”，
  // 而 allFolders() 本身包含当前便签的分类，这两个按钮等于永远不出现）。
  const hasCurrent = Boolean(current);
  els.renameFolderBtn.hidden = !hasCurrent;
  els.deleteFolderBtn.hidden = !hasCurrent;
  if (hasCurrent) {
    els.renameFolderBtn.title = '重命名分类「' + current + '」';
    els.deleteFolderBtn.title = '删除分类「' + current + '」（其中便签移入未分类）';
  }
}

// 打开弹窗：老版安卓 WebView 的内核可能没有 dialog.showModal()，
// 直接调用会抛异常并被吞掉，表现为“点了完全没反应”。这里统一兜底。
function openDialog(dialog) {
  if (!dialog) return false;
  if (dialog.open) return true;
  try {
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
      return true;
    }
  } catch (error) {
    console.warn('[NasNotes] showModal 不可用，改用降级显示', error);
  }
  try {
    if (typeof dialog.show === 'function') dialog.show();
    else dialog.setAttribute('open', '');
    dialog.classList.add('dialog-fallback');
    document.body.classList.add('dialog-open');
    return true;
  } catch (error) {
    console.warn('[NasNotes] 弹窗打开失败', error);
    return false;
  }
}

function closeDialog(dialog) {
  if (!dialog) return;
  try {
    if (dialog.open && typeof dialog.close === 'function') dialog.close();
  } catch (error) { /* 忽略：下面会强制移除 open 属性 */ }
  try { dialog.removeAttribute('open'); } catch (error) { /* 忽略 */ }
  dialog.classList.remove('dialog-fallback');
  if (!document.querySelector('dialog[open]')) document.body.classList.remove('dialog-open');
}

// 降级显示的弹窗没有原生 Esc 关闭，这里补一个
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const stack = Array.from(document.querySelectorAll('dialog[open].dialog-fallback'));
  if (!stack.length) return;
  const top = stack[stack.length - 1];
  event.preventDefault();
  if (typeof top.onclose === 'function') top.onclose();
  else closeDialog(top);
});

// 应用内弹窗：安卓 WebView 默认不显示浏览器原生 prompt/confirm。
function askText(title, initial, label) {
  return new Promise((resolve) => {
    els.textDialogTitle.textContent = title;
    const lab = els.textDialog.querySelector('label[for="textDialogInput"]');
    if (lab) lab.textContent = label || '名称';
    els.textDialogInput.value = initial || '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      els.textDialogOk.onclick = null;
      els.textDialogCancel.onclick = null;
      els.textDialog.onclose = null;
      closeDialog(els.textDialog);
      resolve(value === null ? null : String(value).trim());
    };
    els.textDialogOk.onclick = () => finish(els.textDialogInput.value);
    els.textDialogCancel.onclick = () => finish(null);
    els.textDialog.onclose = () => finish(null);
    if (!openDialog(els.textDialog)) { finish(null); return; }
    setTimeout(() => { els.textDialogInput.focus(); els.textDialogInput.select(); }, 0);
  });
}

function askConfirm(title, message, okLabel) {
  return new Promise((resolve) => {
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    els.confirmOk.textContent = okLabel || '确定';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      els.confirmOk.onclick = null;
      els.confirmCancel.onclick = null;
      els.confirmDialog.onclose = null;
      closeDialog(els.confirmDialog);
      resolve(value);
    };
    els.confirmOk.onclick = () => finish(true);
    els.confirmCancel.onclick = () => finish(false);
    els.confirmDialog.onclose = () => finish(false);
    if (!openDialog(els.confirmDialog)) { finish(false); }
  });
}

async function promptFolderName(initial, title) {
  const name = await askText(title, initial || '', '分类名称');
  if (name === null) return null;
  const trimmed = name.slice(0, 100);
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

// ---------- 内存全文索引（明文绝不落盘，锁定即销毁） ----------
function indexFolderOf(plain) {
  return String((plain && plain.folder) || '').trim().slice(0, 100).toLowerCase();
}
function activeFolderKey() {
  if (!activeFolder || activeFolder === UNGROUPED) return '';
  return String(activeFolder).trim().toLowerCase();
}
function indexableText(plain) {
  const parts = [String(plain.title || ''), bodyText(plain), String(plain.folder || '')];
  const atts = plain.attachments || [];
  for (let i = 0; i < atts.length; i += 1) parts.push(String(atts[i].name || ''));
  return parts.join('\n');
}
function indexNote(id, plain) {
  if (!noteIndex) return;
  const p = plain || plainCache.get(id);
  if (!p) { noteIndex.remove(id); return; }
  noteIndex.add(id, indexableText(p), indexFolderOf(p));
}
function noteIndexRemove(id) {
  if (noteIndex) noteIndex.remove(id);
}
// 与改造前完全一致的精确匹配：索引只负责缩小候选集，最终判定仍走各字段 includes。
function matchesQuery(item, query) {
  const plain = item.plain;
  if (String(plain.title || '').toLowerCase().includes(query)) return true;
  if (String(plain.folder || '').toLowerCase().includes(query)) return true;
  const atts = plain.attachments || [];
  for (let i = 0; i < atts.length; i += 1) {
    if (String(atts[i].name || '').toLowerCase().includes(query)) return true;
  }
  if (!item.text) item.text = bodyText(plain);
  return item.text.toLowerCase().includes(query);
}

function notesInActiveFolder() {
  const key = activeFolderKey();
  // 分类倒排：切分类时只遍历该分类的 id，不再全量扫 notesCache。
  const source = (noteIndex && activeFolder)
    ? noteIndex.idsInFolder(key) : notesCache.keys();
  const out = [];
  for (const id of source) {
    const note = notesCache.get(id);
    if (!note || note.deleted) continue;
    if (activeFolder && key !== indexFolderOf(plainCache.get(id))) continue;
    out.push(note);
  }
  return out;
}

// 列表一次最多渲染多少条。全量缓存、搜索与计数仍基于全部便签，只是不把
// 几千个 DOM 节点一次性塞进页面（移动端 WebView 会明显掉帧）。
const LIST_RENDER_LIMIT = 200;
let listShowAll = false;

function visibleNotes() {
  const query = els.searchInput.value.trim().toLowerCase();
  // 正在编辑的便签明文可能还没到 450ms 自动保存，索引里是上一版；
  // 搜索时只刷新这一条，保证「刚打的字立刻能搜到」，成本可忽略。
  if (query && noteIndex && currentId && plainCache.has(currentId)) {
    indexNote(currentId, plainCache.get(currentId));
  }

  let base;
  if (query && noteIndex) {
    // 倒排表先给出候选集（中文 bigram 交集，保证包含即召回），
    // 再按分类过滤、按原字段精确校验，语义与全量扫描完全一致。
    const ids = noteIndex.query(query);
    const key = activeFolderKey();
    base = [];
    if (ids) {
      for (const id of ids) {
        const note = notesCache.get(id);
        if (!note || note.deleted) continue;
        if (activeFolder && key !== indexFolderOf(plainCache.get(id))) continue;
        base.push(note);
      }
    }
  } else {
    base = notesInActiveFolder();
  }

  return base
    .map((note) => ({
      note,
      plain: plainCache.get(note.id) || { title: '（无法解密）', body: '', folder: '' }
    }))
    .filter((item) => (!query ? true : matchesQuery(item, query)))
    .sort((a, b) => String(b.note.updated_at).localeCompare(String(a.note.updated_at)));
}

function noteItemHTML(item, query) {
  const images = inlineImageCount(item.plain);
  const audios = (item.plain.attachments || []).filter((att) => att.kind === 'audio').length;
  const attachmentHint = (images ? ` 🖼${images}` : '') + (audios ? ` 🎤${audios}` : '');
  const snippet = ((item.text || bodyText(item.plain)).slice(0, 80) || '（空便签）') + attachmentHint;
  return '<button class="note-item' + (item.note.id === currentId ? ' active' : '') +
    '" type="button" data-id="' + esc(item.note.id) + '">' +
    '<div class="item-title">' + highlight(item.plain.title || '（无标题）', query) + '</div>' +
    '<div class="item-snippet">' + highlight(snippet || '（空便签）', query) + '</div>' +
    '<div class="item-time">' + esc(formatTime(item.note.updated_at)) + '</div>' +
    '</button>';
}

function renderList() {
  renderFolderRail();
  const query = els.searchInput.value.trim().toLowerCase();
  const items = visibleNotes();
  const total = query ? notesInActiveFolder().length : items.length;
  els.searchCount.textContent = query ? `${items.length}/${total}` : `${total} 条`;

  if (items.length === 0) {
    els.noteList.innerHTML = '<div class="empty-state"><span class="empty-icon">' +
      (query ? '⌕' : '✎') + '</span>' +
      (query ? '没有匹配的便签' : '还没有便签<br>点「新建」写下第一条') + '</div>';
    return;
  }

  // 大列表只把前 LIST_RENDER_LIMIT 条变成 DOM，其余用底部按钮按需展开；
  // 计数、分类栏、搜索仍按全量计算，数据一条不少。
  const shown = (listShowAll || items.length <= LIST_RENDER_LIMIT)
    ? items : items.slice(0, LIST_RENDER_LIMIT);
  const hiddenCount = items.length - shown.length;

  // 一级 = 分类，二级 = 该分类下的便签标题；「未分类」固定排最后
  const groups = new Map();
  shown.forEach((item) => {
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
  }).join('') + (hiddenCount
    ? '<button id="listMoreBtn" class="list-more" type="button">仅显示前 ' + shown.length +
      ' 条，还有 ' + hiddenCount + ' 条 · 点此显示全部</button>'
    : '');
}

// 字数统计：标题计数固定显示在输入框内，正文计数在页脚（取渲染后的可见文字，不含 Markdown 符号）
function updateCounters() {
  if (els.titleCount && els.titleInput) {
    const max = els.titleInput.maxLength > 0 ? els.titleInput.maxLength : 200;
    els.titleCount.textContent = els.titleInput.value.length + '/' + max;
  }
  if (els.bodyCount) {
    const plain = plainCache.get(currentId);
    els.bodyCount.textContent = bodyText(plain || { body: '' }).length + ' 字符';
  }
}

function updateEditorMeta() {
  const note = notesCache.get(currentId);
  updateCounters();
  if (!note) { els.editorMeta.textContent = '未选择便签'; return; }
  const plain = plainCache.get(currentId);
  const chars = bodyText(plain || { body: '' }).length;
  const device = String(note.device || '').slice(0, 8);
  els.editorMeta.textContent = '已加密 · ' + chars + ' 字 · 更新 ' + formatTime(note.updated_at) +
    (device ? ' · 设备 ' + device + '…' : '');
}

function renderPreview() {
  const plain = plainCache.get(currentId);
  if (!plain) { els.mdPreview.innerHTML = ''; return; }
  els.mdPreview.innerHTML = NN_MD.render(plain.body || '', imageAttachmentsOf(plain));
}

// ---------- 富文本编辑（对标 Joplin 移动端「富文本」模式） ----------
// 编辑区直接承载渲染后的 DOM：textContent 就是排版后的文字，看不到 ** # | 这些符号。
// 保存时由 html2md.js 序列化回 Markdown，磁盘/云端仍然只有一份 Markdown 源码。
let richDirty = false;      // DOM 有未序列化的改动
let richCachedMd = '';      // 序列化缓存，避免每次按键都整篇遍历 DOM

function renderRich() {
  if (!els.richEditor) return;
  const plain = plainCache.get(currentId);
  els.richEditor.innerHTML = plain
    ? NN_MD.render(plain.body || '', imageAttachmentsOf(plain))
    : '';
  // md.js 渲染的复选框是 disabled（预览态），编辑态要能点
  els.richEditor.querySelectorAll('input[type="checkbox"]').forEach((box) => {
    box.removeAttribute('disabled');
  });
  richCachedMd = plain ? (plain.body || '') : '';
  richDirty = false;
  updateRichPlaceholder();
}

function updateRichPlaceholder() {
  if (!els.richEditor) return;
  const hasContent = Boolean(els.richEditor.querySelector('img,table,figure,pre,blockquote,hr')) ||
    els.richEditor.textContent.trim() !== '';
  els.richEditor.classList.toggle('is-empty', !hasContent);
}

function richMarkdown() {
  if (!richDirty) return richCachedMd;
  try {
    richCachedMd = NN_HTML2MD.fromNode(els.richEditor);
  } catch (error) {
    console.warn('[NasNotes] html2md failed', error);
    richCachedMd = els.bodyInput.value;
  }
  richDirty = false;
  return richCachedMd;
}

// 富文本内容 → Markdown → 走正常加密保存
function flushRich() {
  if (viewMode !== 'rich' || !currentId) return;
  const plain = plainCache.get(currentId);
  if (!plain) return;
  const md = richMarkdown();
  els.bodyInput.value = md;   // 切到源码视图时直接看到最新内容，不受下面的早退影响
  if (md === plain.body) return;
  plain.body = md;
  handleEdit();
}

// 统一取正文源码：富文本从 DOM 序列化，源码模式取 textarea
function currentBodyMd() {
  return viewMode === 'rich' ? richMarkdown() : els.bodyInput.value;
}

// 兼容旧调用：布尔值映射到「仅预览 / 源码」两个端点。
function togglePreview(force) {
  const want = typeof force === 'boolean'
    ? (force ? 'view' : 'source')
    : (viewMode === 'view' ? 'source' : 'view');
  applyViewMode(want);
}

function renderEditor() {
  const plain = plainCache.get(currentId);
  if (!plain) {
    els.titleInput.value = '';
    els.bodyInput.value = '';
    els.deleteBtn.hidden = true;
    els.attachCount.textContent = '';
    els.attachmentList.innerHTML = '';
    els.mdPreview.innerHTML = '';
    if (els.richEditor) els.richEditor.innerHTML = '';
    if (els.folderRow) els.folderRow.hidden = true;
    if (els.mdToolbar) els.mdToolbar.hidden = true;
    if (els.saveNowBtn) els.saveNowBtn.disabled = true;
  } else {
    normalizePlain(plain);
    els.titleInput.value = plain.title || '';
    els.bodyInput.value = plain.body || '';
    if (viewMode === 'rich') renderRich();
    if (viewMode === 'split' || viewMode === 'view') renderPreview();
    els.deleteBtn.hidden = false;
    if (els.folderRow) els.folderRow.hidden = false;
    if (els.mdToolbar) els.mdToolbar.hidden = false;
    if (els.saveNowBtn) els.saveNowBtn.disabled = false;
    renderFolderOptions();
    renderAttachments();
  }
  updateEditorMeta();
  requestAnimationFrame(updateToolbarScrollState);
}

function selectNote(id) {
  currentId = id;
  applyViewMode(viewMode, false);
  closeRail();
  document.body.classList.add('show-editor');
  renderList();
  renderEditor();
  // 换便签回到顶部，固定条上的投影也跟着复位
  if (els.editorScroll) els.editorScroll.scrollTop = 0;
  updateEditorStuck();
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
      wrapped: vaultMeta.wrapped,
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

// 导入只写本机（离线可用），条目进 outbox，等用户手动同步时再推给 NAS。
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
  if (!cryptoKey) {
    toast('请先解锁再导入');
    return;
  }

  try {
    const sample = backup.notes.find((note) => note && !note.deleted && note.payload);
    if (sample) {
      const plain = await decryptJSON(cryptoKey, sample.iv, sample.payload);
      if (!plain || typeof plain.title !== 'string') throw new Error('口令不匹配');
    }

    const incoming = backup.meta || {};
    const sameVault = Boolean(vaultMeta && vaultMeta.salt && incoming.salt && vaultMeta.salt === incoming.salt);
    if (vaultMeta && vaultMeta.salt && !sameVault) {
      throw new Error('备份来自另一套加密库（密钥不同），不能直接并入本机现有的库');
    }
    if (!vaultMeta || !vaultMeta.salt) {
      if (!incoming.salt || !incoming.wrapped) throw new Error('备份缺少加密参数');
      vaultMeta = {
        salt: incoming.salt,
        wrapped: incoming.wrapped,
        iterations: incoming.iterations || PBKDF2_ITERATIONS,
        version: incoming.version || VAULT_VERSION
      };
      await saveLocalVault(vaultMeta);
      await resetSyncCursor();
    }

    const stamp = new Date().toISOString();
    const noteRows = [];
    const outRows = [];
    let imported = 0;
    let skipped = 0;
    for (const note of backup.notes) {
      if (!note || !/^[A-Za-z0-9_-]{1,64}$/.test(note.id || '')) {
        skipped += 1;
        continue;
      }
      const record = {
        id: note.id,
        iv: note.iv || '',
        payload: note.payload || '',
        created_at: note.created_at || note.updated_at || stamp,
        updated_at: note.updated_at || stamp,
        deleted: Boolean(note.deleted),
        device: note.device || 'import'
      };
      notesCache.set(record.id, record);
      noteRows.push(record);
      outRows.push({
        id: record.id,
        method: 'PUT',
        payload: {
          iv: record.iv, payload: record.payload,
          updated_at: record.updated_at, device: deviceId
        },
        queued_at: Date.now()
      });
      imported += 1;
    }
    await idbPutMany(STORE_NOTES, noteRows);
    await idbPutMany(STORE_OUT, outRows);

    await rebuildPlainCache();
    renderList();
    renderEditor();
    await updateSyncUI();
    toast(`已导入本机 ${imported} 条（跳过 ${skipped}），点顶部状态按钮即可同步到 NAS`);
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

// 登录页「测试」按钮：保存地址并真正打一次 /api/health，避免填错地址后
// 一路登录失败却看不出是网络问题。
if (els.lockServerTestBtn) {
  els.lockServerTestBtn.addEventListener('click', async () => {
    els.lockError.hidden = true;
    if (!saveServerFromLockInput()) return;
    const api = nativeServerApi();
    const target = api ? (api.getServer() || '') : location.origin;
    if (!target) {
      setLockServerState('先填 NAS 地址，例如 192.168.5.10:28443', 'bad');
      return;
    }
    els.lockServerTestBtn.disabled = true;
    setLockServerState('正在连接 ' + target + ' …');
    try {
      const response = await fetch('/api/health');
      if (response.ok) {
        setLockServerState('连接正常 ✓ ' + target, 'ok');
      } else {
        let body = '';
        try { body = (await response.text()).slice(0, 200); } catch (error) { body = ''; }
        if (response.status === 502 && /native bridge unavailable/i.test(body)) {
          setLockServerState('请求被壳拦截了（桥接脚本没加载），请安装最新 APK', 'bad');
        } else {
          setLockServerState('能连通，但返回 HTTP ' + response.status + '（检查地址或服务状态）', 'bad');
        }
      }
    } catch (error) {
      setLockServerState('连不上 ' + target + '：检查地址、端口与 NAS 是否开机', 'bad');
    } finally {
      els.lockServerTestBtn.disabled = false;
    }
  });
}

// 「仅在本机使用」：不登录、不联网，用当前密码在本机建一个加密库。
// 这是「离线独立 App」的第一入口，之后随时可以在同步里连 NAS。
els.lockLocalBtn.addEventListener('click', async () => {
  const passphrase = els.passphraseInput.value;
  if (passphrase.length < 8) {
    return showLockError('本机密码至少 8 位（忘记无法恢复，建议记到密码管理器）');
  }
  els.lockError.hidden = true;
  els.lockLocalBtn.disabled = true;
  try {
    const key = await createLocalVault(passphrase);
    accountName = '本机';
    localStorage.setItem('nn-account', accountName);
    els.usernameInput.value = DEFAULT_USERNAME;
    await afterUnlock(key);
    toast('已创建本机加密库：不联网也能读写，需要同步时点顶部的状态按钮');
  } catch (error) {
    console.warn('[NasNotes] create local vault failed', error);
    showLockError('创建本机加密库失败：' + (error && error.message ? error.message : '未知错误'));
  } finally {
    els.lockLocalBtn.disabled = false;
  }
});

// 顶部状态胶囊 = 手动同步入口（手机上侧栏是隐藏的，这是唯一显眼的位置）
els.syncBadge.addEventListener('click', doManualSync);
els.syncNowSettings.addEventListener('click', doManualSync);
els.syncLoginCancel.addEventListener('click', () => closeSyncLogin(false));
els.syncLoginDialog.addEventListener('close', () => {
  if (syncLoginResolve) syncLoginResolve(false);
});
els.syncPass.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') els.syncLoginOk.click();
});
els.syncLoginOk.addEventListener('click', async () => {
  const user = (els.syncUser.value || '').trim() || DEFAULT_USERNAME;
  const pass = els.syncPass.value;
  const fail = (message) => {
    els.syncLoginError.textContent = message;
    els.syncLoginError.hidden = false;
  };
  els.syncLoginError.hidden = true;
  if (!pass) return fail('请输入 NAS 的账户密码');
  els.syncLoginOk.disabled = true;
  try {
    const session = await loginAccount(user, pass);
    if (!session) return fail('账户或密码不正确');
    localStorage.setItem('nn-account', accountName);
    const meta = await readServerVault();
    if (meta.initialized && vaultMeta && meta.salt && vaultMeta.salt && meta.salt !== vaultMeta.salt) {
      logoutQuiet();
      return fail('服务器上的是另一套加密库，与本机密钥不同，无法同步。');
    }
    els.syncPass.value = '';
    syncErrorKind = '';
    if (syncMode === 'auto') startAutoSync();
    closeSyncLogin(true);
  } catch (error) {
    fail(isNetError(error)
      ? '连不上 NAS，请检查网络与设置里的服务器地址'
      : ('连接失败：' + (error && error.message ? error.message : '未知错误')));
  } finally {
    els.syncLoginOk.disabled = false;
  }
});

// 忘记密码逃生口：先展开明确的危险操作区，必须手动输入「清空数据」。
// 不使用 window.confirm —— 安卓 WebView 默认不弹出原生对话框。
els.resetVaultBtn.addEventListener('click', () => {
  els.lockError.hidden = true;
  els.resetPanel.hidden = !els.resetPanel.hidden;
  if (!els.resetPanel.hidden) els.resetConfirmInput.focus();
});
els.resetCancelBtn.addEventListener('click', () => {
  els.resetPanel.hidden = true;
  els.resetConfirmInput.value = '';
  els.lockError.hidden = true;
});

els.resetVaultConfirmBtn.addEventListener('click', async () => {
  if ((els.resetConfirmInput.value || '').trim() !== '清空数据') {
    return showLockError('请输入「清空数据」四个字，或点「取消」退出');
  }
  els.lockError.hidden = true;
  els.resetVaultConfirmBtn.disabled = true;
  try {
    if (!sessionToken) {
      // 未登录时先验证账户密码再清库，避免任意访客删数据
      const username = (els.usernameInput.value || '').trim() || DEFAULT_USERNAME;
      const password = els.passphraseInput.value;
      if (!password) return showLockError('请先在上方输入账户名和密码');
      const session = await loginAccount(username, password);
      if (!session) return showLockError('账户或密码不正确');
    }
    const resp = await fetch('/api/vault', {
      method: 'DELETE', headers: authHeaders(),
      body: JSON.stringify({ confirm: 'RESET' })
    });
    if (resp.status === 401) { handleSessionExpired(); return; }
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      return showLockError('清空失败：' + (body.error || ('HTTP ' + resp.status)));
    }
    // 清本机：加密库元数据、全部缓存、待发队列
    vaultMeta = null;
    cryptoKey = null;
    wkeyBytes = null;
    notesCache.clear();
    plainCache.clear();
    folderRegistry = [];
    try {
      await idbPut(STORE_META, { key: 'vault', value: 'null' });
      await idbDelete(STORE_META, FOLDERS_META_KEY);
      const db = await dbPromise;
      for (const storeName of [STORE_NOTES, STORE_OUT]) {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).clear();
        await new Promise((resolve, reject) => {
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      }
    } catch (error) { /* 本机缓存清理失败不影响服务端已清空 */ }
    showLockScreen('init');
    showLockError('全部便签与加密库已删除。账户名和密码不变，重新登录将创建新的空加密库。');
    renderList();
    renderEditor();
  } catch (error) {
    console.warn('[NasNotes] reset vault failed', error);
    showLockError('清空失败：' + (error && error.message ? error.message : '未知错误'));
  } finally {
    els.resetVaultConfirmBtn.disabled = false;
  }
});

// 设置内自助改账户名/口令：口令换了，加密库包裹层必须在同一请求里原子更换。
function acctErrorShow(message) {
  els.acctError.textContent = message;
  els.acctError.hidden = false;
}

els.saveAccount.addEventListener('click', async () => {
  els.acctError.hidden = true;
  const currentName = accountName;
  const targetName = (els.acctNameInput.value || '').trim();
  const currentPass = els.acctCurrentInput.value;
  const newPass = els.acctNewInput.value;
  const confirmPass = els.acctConfirmInput.value;
  if (!sessionToken || !currentName) return acctErrorShow('请先登录');
  if (!currentPass) return acctErrorShow('修改账户需要先输入当前口令');
  if (targetName && targetName !== currentName && !/^[A-Za-z0-9_.\-\u4e00-\u9fff]{1,64}$/.test(targetName)) {
    return acctErrorShow('账户名只能包含中英文、数字、._-（最长 64）');
  }
  if (newPass) {
    if (newPass.length < 8) return acctErrorShow('新口令至少 8 位');
    if (newPass !== confirmPass) return acctErrorShow('两次输入的新口令不一致');
    if (!cryptoKey || !wkeyBytes || !vaultMeta || !vaultMeta.salt) {
      return acctErrorShow('改口令需要先解锁（要重新包裹加密库）。请先在登录页登录后再来设置。');
    }
  }
  els.saveAccount.disabled = true;
  try {
    // 普通账户校验：当前密码交给服务端按哈希核对，不做客户端派生。
    const body = {
      username: targetName || currentName,
      current_password: currentPass
    };

    if (newPass) {
      body.new_password = newPass;
      // 用新密码重新包裹 wkey：笔记密文不变，只换包裹层。
      const newWrapSalt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
      const newWrapKey = await deriveKey(newPass, newWrapSalt, PBKDF2_ITERATIONS);
      body.vault = {
        salt: newWrapSalt,
        wrapped: await wrapVault(newWrapKey, wkeyBytes),
        iterations: PBKDF2_ITERATIONS,
        version: VAULT_VERSION
      };
    }

    const resp = await fetch('/api/account', {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify(body)
    });
    if (resp.status === 401) { handleSessionExpired(); throw new Error('会话已过期，请重新登录'); }
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(result.error || ('HTTP ' + resp.status));

    // 服务端已撤销全部旧会话：本机清掉会话，用新账户/新口令重新登录
    sessionToken = '';
    localStorage.removeItem('nn-session');
    if (newPass) {
      vaultMeta = {
        salt: body.vault.salt,
        wrapped: body.vault.wrapped,
        iterations: PBKDF2_ITERATIONS,
        version: VAULT_VERSION
      };
      await idbPut(STORE_META, { key: 'vault', value: JSON.stringify(vaultMeta) });
      await resetSyncCursor();   // salt 变了，旧游标作废，下次全量对齐
    }
    accountName = result.username || targetName || currentName;

    const nextPass = newPass || currentPass;
    const relogged = await loginAccount(accountName, nextPass);
    if (!relogged) throw new Error('修改成功但自动重新登录失败，请在登录页手动登录');

    els.acctCurrentInput.value = '';
    els.acctNewInput.value = '';
    els.acctConfirmInput.value = '';
    els.acctNameInput.value = accountName;
    closeDialog(els.settingsDialog);
    toast(newPass ? '账户口令已更新，加密库已用新口令重新保护' : '账户名已更新');
    if (cryptoKey && syncMode === 'auto') triggerSync(200);
  } catch (error) {
    console.warn('[NasNotes] account change failed', error);
    acctErrorShow('保存失败：' + (error && error.message ? error.message : '未知错误'));
  } finally {
    els.saveAccount.disabled = !sessionToken;
  }
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
  if (longPressFired) { longPressFired = false; return; }
  if (event.target.closest('#listMoreBtn')) {
    listShowAll = true;
    renderList();
    return;
  }
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

// ---------- 便签右键 / 长按操作 ----------
function showContextMenu(x, y, id) {
  contextNoteId = id;
  if (els.folderContextMenu) hideFolderContextMenu();
  const menu = els.noteContextMenu;
  menu.hidden = false;
  const w = menu.offsetWidth || 180;
  const h = menu.offsetHeight || 130;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
}

function hideContextMenu() {
  els.noteContextMenu.hidden = true;
  contextNoteId = null;
}

els.noteList.addEventListener('contextmenu', (event) => {
  const button = event.target.closest('.note-item');
  if (!button) return;
  event.preventDefault();
  showContextMenu(event.clientX, event.clientY, button.dataset.id);
});

els.noteList.addEventListener('touchstart', (event) => {
  const button = event.target.closest('.note-item');
  if (!button || event.touches.length !== 1) return;
  const touch = event.touches[0];
  const x = touch.clientX;
  const y = touch.clientY;
  const id = button.dataset.id;
  clearTimeout(longPressTimer);
  longPressFired = false;
  longPressTimer = setTimeout(() => {
    longPressFired = true;
    showContextMenu(x, y, id);
  }, 520);
}, { passive: true });

['touchmove', 'touchend', 'touchcancel'].forEach((type) => {
  els.noteList.addEventListener(type, () => {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }, { passive: true });
});

els.noteContextMenu.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-action]');
  if (!action) return;
  const id = contextNoteId;
  hideContextMenu();
  if (!id) return;
  if (action.dataset.action === 'open') selectNote(id);
  else if (action.dataset.action === 'folder') openFolderDialog(id);
  else if (action.dataset.action === 'delete') deleteNoteById(id);
});

// ---------- 分类栏右键 / 长按操作（空分类也能改名或删除） ----------
let contextFolderName = '';

function showFolderContextMenu(x, y, name) {
  contextFolderName = name;
  hideContextMenu();
  const menu = els.folderContextMenu;
  menu.hidden = false;
  const w = menu.offsetWidth || 190;
  const h = menu.offsetHeight || 96;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
}

function hideFolderContextMenu() {
  els.folderContextMenu.hidden = true;
  contextFolderName = '';
}

async function renameFolder(from) {
  const source = (from || '').trim();
  if (!source) return;
  const to = await promptFolderName(source, '重命名分类「' + source + '」为：');
  if (!to || to === source) return;
  const merged = allFolders().indexOf(to) >= 0;
  const touched = await setFolderForAll(source, to);
  let changed = unregisterFolder(source);
  if (registerFolder(to)) changed = true;
  if (changed) await persistFolderRegistry();
  renderFolderOptions();
  renderList();
  toast(merged
    ? '已把「' + source + '」的 ' + touched + ' 条便签并入「' + to + '」'
    : '分类「' + source + '」已重命名为「' + to + '」（' + touched + ' 条便签）');
}

async function deleteFolder(from) {
  const source = (from || '').trim();
  if (!source) return;
  const yes = await askConfirm('删除分类',
    '删除分类「' + source + '」？其中便签会移入' + UNGROUPED + '，便签本身不会删除。', '删除分类');
  if (!yes) return;
  const touched = await setFolderForAll(source, '');
  if (unregisterFolder(source)) await persistFolderRegistry();
  const plain = plainCache.get(currentId);
  if (plain && (plain.folder || '').trim() === source) plain.folder = '';
  renderFolderOptions();
  renderList();
  toast('分类「' + source + '」已删除，' + touched + ' 条便签移入' + UNGROUPED);
}

function folderMenuTarget(node) {
  const item = node && node.closest ? node.closest('.rail-item') : null;
  const name = item ? (item.dataset.folder || '').trim() : '';
  // 「全部便签」和「未分类」是虚拟分类，没有可改名/删除的实体
  if (!name || name === UNGROUPED) return '';
  return name;
}

els.folderRail.addEventListener('contextmenu', (event) => {
  const name = folderMenuTarget(event.target);
  if (!name) return;
  event.preventDefault();
  showFolderContextMenu(event.clientX, event.clientY, name);
});

els.folderRail.addEventListener('touchstart', (event) => {
  const name = folderMenuTarget(event.target);
  if (!name || event.touches.length !== 1) return;
  const touch = event.touches[0];
  const x = touch.clientX;
  const y = touch.clientY;
  clearTimeout(folderLongPressTimer);
  folderLongPressTimer = setTimeout(() => { showFolderContextMenu(x, y, name); }, 520);
}, { passive: true });

['touchmove', 'touchend', 'touchcancel'].forEach((type) => {
  els.folderRail.addEventListener(type, () => {
    clearTimeout(folderLongPressTimer);
    folderLongPressTimer = null;
  }, { passive: true });
});

els.folderContextMenu.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-action]');
  if (!action) return;
  const name = contextFolderName;
  hideFolderContextMenu();
  if (!name) return;
  if (action.dataset.action === 'rename') renameFolder(name);
  else if (action.dataset.action === 'delete') deleteFolder(name);
});

document.addEventListener('click', (event) => {
  if (!els.noteContextMenu.hidden && !event.target.closest('#noteContextMenu')) hideContextMenu();
  if (!els.folderContextMenu.hidden && !event.target.closest('#folderContextMenu')) hideFolderContextMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!els.noteContextMenu.hidden) hideContextMenu();
  if (!els.folderContextMenu.hidden) hideFolderContextMenu();
  if (document.body.classList.contains('rail-open')) closeRail();
});

async function openFolderDialog(id) {
  const plain = plainCache.get(id);
  if (!plain) { toast('便签尚未解锁，无法调整分类'); return; }
  const folders = allFolders();
  const current = (plain.folder || '').trim();
  const options = ['<option value="">（' + UNGROUPED + '）</option>'];
  folders.forEach((name) => options.push('<option value="' + esc(name) + '">' + esc(name) + '</option>'));
  options.push('<option value="__new__">＋ 新建分类…</option>');
  els.folderDialogSelect.innerHTML = options.join('');
  els.folderDialogSelect.value = folders.includes(current) ? current : '';
  els.folderDialogNew.value = '';
  syncFolderDialogNew();
  els.folderDialogTitle.textContent = '调整分类 · ' + (plain.title || '无标题便签').slice(0, 24);
  let settled = false;
  const finish = async (save) => {
    if (settled) return;
    settled = true;
    els.folderDialogSave.onclick = null;
    els.folderDialogCancel.onclick = null;
    els.folderDialog.onclose = null;
    closeDialog(els.folderDialog);
    if (!save) return;
    let name = els.folderDialogSelect.value;
    if (name === '__new__') {
      name = (els.folderDialogNew.value || '').trim().slice(0, 100);
      if (!name) { toast('请输入分类名称'); return; }
      if (name === UNGROUPED) { toast('「' + UNGROUPED + '」是保留名称'); return; }
      // 新分类名先登记到本机清单，即使这条便签以后又被移走，分类也会留着
      if (registerFolder(name)) await persistFolderRegistry();
    }
    const target = plainCache.get(id);
    if (!target) return;
    target.folder = name;
    plainCache.set(id, target);
    const note = notesCache.get(id);
    if (note) await queueUpsert(note);
    if (id === currentId) renderFolderOptions();
    renderList();
    toast(name ? '已移入分类「' + name + '」' : '已移入' + UNGROUPED);
  };
  els.folderDialogSave.onclick = () => finish(true);
  els.folderDialogCancel.onclick = () => finish(false);
  els.folderDialog.onclose = () => finish(false);
  if (!openDialog(els.folderDialog)) { toast('无法打开分类弹窗，请刷新页面重试'); }
}

function syncFolderDialogNew() {
  const isNew = els.folderDialogSelect.value === '__new__';
  els.folderDialogNew.hidden = !isNew;
  const label = els.folderDialog.querySelector('label[for="folderDialogNew"]');
  if (label) label.hidden = !isNew;
  if (isNew) els.folderDialogNew.focus();
}
els.folderDialogSelect.addEventListener('change', syncFolderDialogNew);

// 搜索每敲一字都会全量过滤 + 重建列表；120ms 防抖把连打十几个字
// 从十几次渲染收敛成一次（几千条便签时差别是秒级）。
let searchRenderTimer = 0;
els.searchInput.addEventListener('input', () => {
  clearTimeout(searchRenderTimer);
  searchRenderTimer = setTimeout(renderList, 120);
});
els.syncBtn.addEventListener('click', () => { clearTimeout(syncTimer); doManualSync(); });

// 分类筛选：左栏按钮（宽屏常驻 / 窄屏抽屉）与列表上方下拉共用同一状态。
els.folderRail.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-folder]');
  if (!btn) return;
  activeFolder = btn.dataset.folder || '';
  listShowAll = false;
  renderList();
  // 手机上选完分类就把抽屉收起来，否则挡着列表看不到结果
  if (railIsDrawer()) closeRail();
});
els.folderFilter.addEventListener('change', () => {
  activeFolder = els.folderFilter.value || '';
  listShowAll = false;
  renderList();
});

// 抽屉开关：列表头 ☰ 打开，× / 遮罩 / Esc 收起；侧栏底部按钮点完也收。
if (els.railToggleBtn) {
  els.railToggleBtn.addEventListener('click', () => {
    if (document.body.classList.contains('rail-open')) closeRail();
    else openRail();
  });
}
if (els.railCloseBtn) els.railCloseBtn.addEventListener('click', closeRail);
if (els.railScrim) els.railScrim.addEventListener('click', closeRail);
if (els.sidebarEl) {
  // 用捕获阶段兜住「同步 / 锁定 / 设置」这类会弹窗或切屏的按钮，
  // 先让各自 handler 跑完，再把抽屉收起来。
  els.sidebarEl.addEventListener('click', (event) => {
    if (!railIsDrawer()) return;
    if (!event.target.closest('.rail-foot button')) return;
    setTimeout(closeRail, 0);
  });
}
window.addEventListener('resize', () => {
  if (!railIsDrawer()) closeRail();
});

// 视图切换：编辑 / 分栏 / 预览，位置固定在编辑器顶部，不会被工具栏挤没。
document.querySelectorAll('[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => applyViewMode(btn.dataset.view));
});
els.bodyInput.addEventListener('scroll', () => {
  if (viewMode === 'split') syncPaneScroll(els.bodyInput, els.mdPreview);
});
els.mdPreview.addEventListener('scroll', () => {
  if (viewMode === 'split') syncPaneScroll(els.mdPreview, els.bodyInput);
});

els.imageBtn.addEventListener('click', () => {
  if (!currentPlain()) { toast('请先打开一条便签'); return; }
  if (isRichMode()) {
    rememberRichRange();
    savedCaretPos = -1;
  } else {
    savedCaretPos = currentCaret();
  }
  els.imageInput.click();
});
els.imageInput.addEventListener('change', handleImageInput);
els.recordBtn.addEventListener('click', toggleRecording);

// 预览态点击图片放大（渲染产物只有 <img data-preview-image>）
els.mdPreview.addEventListener('click', (event) => {
  const img = event.target.closest('img[data-preview-image]');
  if (img) openLightbox(img.src);
});

// ---------- 富文本编辑操作 ----------
// 全部直接操作 contenteditable 的 DOM：点「B」就是真加粗，正文里不会出现 **。
// 写入 body 的时机交给 richChanged()（序列化 → 加密保存）。
let savedRichRange = null;

function richClosest(node, tag) {
  let el = node && node.nodeType === 1 ? node : (node && node.parentNode);
  while (el && el !== els.richEditor) {
    if (el.nodeType === 1 && el.tagName.toLowerCase() === tag) return el;
    el = el.parentNode;
  }
  return null;
}

function richBlockTag() {
  const sel = window.getSelection();
  let el = sel && sel.anchorNode;
  if (el && el.nodeType !== 1) el = el.parentNode;
  while (el && el !== els.richEditor) {
    if (el.nodeType === 1 && /^(h[1-6]|p|div|blockquote|li|pre)$/.test(el.tagName.toLowerCase())) {
      return el.tagName.toLowerCase();
    }
    el = el.parentNode;
  }
  return '';
}

function rememberRichRange() {
  if (!isRichMode() || !els.richEditor) return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (els.richEditor.contains(range.commonAncestorContainer)) savedRichRange = range.cloneRange();
}

function restoreRichRange() {
  if (!savedRichRange) return;
  const sel = window.getSelection();
  try {
    sel.removeAllRanges();
    sel.addRange(savedRichRange);
  } catch (error) { /* 节点已被删除时忽略 */ }
}

function richFocus() {
  if (!els.richEditor) return;
  const sel = window.getSelection();
  const inside = Boolean(sel && sel.rangeCount && els.richEditor.contains(sel.anchorNode));
  try { els.richEditor.focus({ preventScroll: true }); } catch (error) { els.richEditor.focus(); }
  if (!inside) restoreRichRange();
}

function richChanged() {
  richDirty = true;
  updateRichPlaceholder();
  handleEdit();
}

function richInsertHtml(html) {
  richFocus();
  const sel = window.getSelection();
  let done = false;
  if (sel && sel.rangeCount && els.richEditor.contains(sel.anchorNode)) {
    try { done = document.execCommand('insertHTML', false, html); } catch (error) { done = false; }
    if (!done) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const holder = document.createElement('div');
      holder.innerHTML = html;
      const frag = document.createDocumentFragment();
      while (holder.firstChild) frag.appendChild(holder.firstChild);
      range.insertNode(frag);
      done = true;
    }
  }
  if (!done) {
    els.richEditor.insertAdjacentHTML('beforeend', html);
  }
  richDirty = true;
  updateRichPlaceholder();
}

// 块级元素（表格 / 图片 / 分隔线）插到当前顶层块的后面，
// 否则光标在列表项里时会把 <table> 塞进 <li>，结构非法、序列化也会丢内容。
function richInsertBlock(html) {
  richFocus();
  const sel = window.getSelection();
  const node = sel && sel.anchorNode;
  if (!node || !els.richEditor.contains(node)) {
    els.richEditor.insertAdjacentHTML('beforeend', html);
    richChanged();
    return;
  }
  let top = node;
  while (top && top.parentNode && top.parentNode !== els.richEditor) top = top.parentNode;
  if (!top || top === els.richEditor) els.richEditor.insertAdjacentHTML('beforeend', html);
  else top.insertAdjacentHTML('afterend', html);
  richChanged();
}

function richExec(command, value) {
  richFocus();
  let ok = false;
  try { ok = document.execCommand(command, false, value == null ? null : value); } catch (error) { ok = false; }
  if (ok) richChanged();
  return ok;
}

function richFormatBlock(tag) {
  richFocus();
  try { document.execCommand('formatBlock', false, tag); } catch (error) {
    try { document.execCommand('formatBlock', false, '<' + tag + '>'); } catch (error2) { /* ignore */ }
  }
  richChanged();
}

function richHeading(level) {
  const tag = 'h' + level;
  richFormatBlock(richBlockTag() === tag ? 'p' : tag);
}

function richInlineCode() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const existing = richClosest(sel.anchorNode, 'code');
  if (existing) {
    // 再点一次取消：把 code 拆掉，文本留在原位
    const parent = existing.parentNode;
    while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
    parent.removeChild(existing);
    richChanged();
    return;
  }
  const range = sel.getRangeAt(0);
  const code = document.createElement('code');
  if (range.collapsed) code.textContent = 'code';
  else code.appendChild(range.extractContents());
  range.insertNode(code);
  const next = document.createRange();
  next.selectNodeContents(code);
  sel.removeAllRanges();
  sel.addRange(next);
  savedRichRange = next.cloneRange();
  richChanged();
}

async function richLink() {
  rememberRichRange();
  const url = await askText('插入链接', 'https://', '链接地址');
  if (!url) return;
  if (!/^(https?:\/\/|mailto:)/i.test(url)) { toast('只支持 http/https/mailto 链接'); return; }
  richFocus();
  const sel = window.getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed) {
    try { document.execCommand('createLink', false, url); } catch (error) { /* ignore */ }
    richChanged();
  } else {
    richInsertHtml('<a href="' + NN_MD.esc(url) + '" target="_blank" rel="noopener noreferrer">' +
      NN_MD.esc(url) + '</a>');
    richChanged();
  }
}

function richTask() {
  richFocus();
  try { document.execCommand('insertUnorderedList'); } catch (error) { /* ignore */ }
  const sel = window.getSelection();
  const li = richClosest(sel && sel.anchorNode, 'li');
  if (li && !li.querySelector('input[type="checkbox"]')) {
    li.classList.add('md-task');
    const box = document.createElement('input');
    box.type = 'checkbox';
    li.insertBefore(box, li.firstChild);
    li.insertBefore(document.createTextNode(' '), box.nextSibling);
  }
  richChanged();
}

// 富文本里的表格：直接插入渲染好的 table，行列操作改 DOM
function insertTableRich(cols = 3, rows = 2) {
  const n = Math.max(1, Math.min(20, Number(cols) || 3));
  const m = Math.max(0, Math.min(50, Number(rows) || 0));
  richInsertBlock(NN_MD.render(NN_MD.insertTableMarkdown(m, n), []) + '<p><br></p>');
  toast('已插入 ' + n + ' 列 × ' + m + ' 行表格：用 ＋行/－行/＋列/－列 调整');
}

function richTableOp(op) {
  const sel = window.getSelection();
  const cell = richClosest(sel && sel.anchorNode, 'td') || richClosest(sel && sel.anchorNode, 'th');
  if (!cell) { toast('请先把光标放到表格单元格里'); return; }
  const row = cell.parentNode;
  const table = richClosest(cell, 'table');
  if (!row || !table) return;
  const body = table.tBodies[0] || table;
  const index = Array.prototype.indexOf.call(row.children, cell);
  if (op === 'row-add') {
    const tr = document.createElement('tr');
    Array.prototype.forEach.call(row.children, function () {
      const td = document.createElement('td');
      td.innerHTML = '<br>';
      tr.appendChild(td);
    });
    if (row.parentNode === table.tHead) body.appendChild(tr);
    else row.parentNode.insertBefore(tr, row.nextSibling);
  } else if (op === 'row-del') {
    if (row.parentNode === table.tHead) {
      // 删表头没意义：改删第一行数据
      const first = body.rows[0];
      if (first) body.removeChild(first); else table.parentNode.removeChild(table);
    } else {
      row.parentNode.removeChild(row);
    }
  } else if (op === 'col-add') {
    Array.prototype.forEach.call(table.rows, function (tr) {
      const ref = tr.children[index];
      const cellTag = tr.parentNode === table.tHead ? 'th' : 'td';
      const created = document.createElement(cellTag);
      created.innerHTML = '<br>';
      if (ref && ref.nextSibling) tr.insertBefore(created, ref.nextSibling);
      else tr.appendChild(created);
    });
  } else if (op === 'col-del') {
    const width = (table.rows[0] && table.rows[0].children.length) || 0;
    if (width <= 1) { table.parentNode.removeChild(table); }
    else {
      Array.prototype.forEach.call(table.rows, function (tr) {
        if (tr.children[index]) tr.removeChild(tr.children[index]);
      });
    }
  } else {
    return;
  }
  if (table.rows.length === 0 || (table.rows[0] && table.rows[0].children.length === 0)) {
    if (table.parentNode) table.parentNode.removeChild(table);
  }
  richChanged();
  const labels = { 'row-add': '已加一行', 'row-del': '已删一行', 'col-add': '已加一列', 'col-del': '已删一列' };
  toast(labels[op] || '表格已更新');
}

function handleRichAction(kind) {
  switch (kind) {
    case 'p': richFormatBlock('p'); break;
    case 'bold': richExec('bold'); break;
    case 'italic': richExec('italic'); break;
    case 'strike': richExec('strikeThrough'); break;
    case 'h1': richHeading(1); break;
    case 'h2': richHeading(2); break;
    case 'h3': richHeading(3); break;
    case 'ul': richExec('insertUnorderedList'); break;
    case 'ol': richExec('insertOrderedList'); break;
    case 'task': richTask(); break;
    case 'link': richLink(); break;
    case 'quote': richFormatBlock(richBlockTag() === 'blockquote' ? 'p' : 'blockquote'); break;
    case 'code': richInlineCode(); break;
    case 'hr': richInsertBlock('<hr>'); break;
    case 'table': insertTableRich(); break;
    case 'row-add': case 'row-del': case 'col-add': case 'col-del': richTableOp(kind); break;
    default: break;
  }
}

// 工具栏状态回显：光标在加粗/标题/列表里时按钮高亮（和 Joplin 一致）
let richToolbarTimer = null;
function scheduleRichToolbarState() {
  if (!isRichMode()) return;
  clearTimeout(richToolbarTimer);
  richToolbarTimer = setTimeout(updateRichToolbarState, 60);
}

function updateRichToolbarState() {
  if (!isRichMode() || !els.mdToolbar) return;
  const commands = { bold: 'bold', italic: 'italic', strike: 'strikeThrough', ul: 'insertUnorderedList', ol: 'insertOrderedList' };
  Object.keys(commands).forEach((kind) => {
    const btn = els.mdToolbar.querySelector('[data-md="' + kind + '"]');
    if (!btn) return;
    let on = false;
    try { on = document.queryCommandState(commands[kind]); } catch (error) { on = false; }
    btn.classList.toggle('active', on);
  });
  const tag = richBlockTag();
  ['h1', 'h2', 'h3', 'quote'].forEach((kind) => {
    const btn = els.mdToolbar.querySelector('[data-md="' + kind + '"]');
    if (!btn) return;
    btn.classList.toggle('active', tag === (kind === 'quote' ? 'blockquote' : kind));
  });
  const codeBtn = els.mdToolbar.querySelector('[data-md="code"]');
  if (codeBtn) {
    const sel = window.getSelection();
    codeBtn.classList.toggle('active', Boolean(richClosest(sel && sel.anchorNode, 'code')));
  }
  if (els.headingSelect) els.headingSelect.value = /^h[1-3]$/.test(tag) ? tag : 'p';
}

function richKeydown(event) {
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (key === 'b') { event.preventDefault(); handleRichAction('bold'); }
  else if (key === 'i') { event.preventDefault(); handleRichAction('italic'); }
  else if (key === 'k') { event.preventDefault(); handleRichAction('link'); }
}

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

// 「段落：正文」：把当前行的 Markdown 标题标记去掉（源码模式）
function clearHeadingSource() {
  const ta = els.bodyInput;
  const value = ta.value;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = value.indexOf('\n', end);
  if (lineEnd < 0) lineEnd = value.length;
  const block = value.slice(lineStart, lineEnd).replace(/^#{1,6}\s+/gm, '');
  ta.value = value.slice(0, lineStart) + block + value.slice(lineEnd);
  ta.focus();
  const caret = lineStart + block.length;
  ta.setSelectionRange(caret, caret);
  handleEdit();
}

// 取光标所在段落的标题级别，用来让工具栏下拉框跟随当前段落
function currentHeadingLevel() {
  if (isRichMode()) {
    const tag = richBlockTag();
    return /^h[1-3]$/.test(tag) ? tag : 'p';
  }
  if (isSourceMode()) {
    const ta = els.bodyInput;
    const start = ta.selectionStart;
    const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = ta.value.indexOf('\n', start);
    if (lineEnd < 0) lineEnd = ta.value.length;
    const match = /^(#{1,6})\s+/.exec(ta.value.slice(lineStart, lineEnd));
    return match && match[1].length <= 3 ? 'h' + match[1].length : 'p';
  }
  return 'p';
}

function syncHeadingSelect() {
  if (!els.headingSelect) return;
  els.headingSelect.value = currentHeadingLevel();
}

// 编辑区字号：立即作用于编辑区和预览，设置只保存在本机，不写入便签正文。
function applyFontSize(size) {
  const key = String(size).replace(/^fs-/, '');
  if (!EDITOR_FONT_PX[key]) return;
  applyEditorFont(key);
  localStorage.setItem('nn-editor-font', editorFont);
  const names = { small: '小号', normal: '标准', large: '大号', xlarge: '特大' };
  toast('编辑区字号：' + names[editorFont]);
}

// 插入表格：点一下就在光标处插入 3 列 × 2 行，不经过任何弹窗。
// （旧版依赖 <dialog>，在部分安卓 WebView 上 showModal 不可用，点了毫无反应。）
// 需要更多行列时，用工具栏的「＋行 / －行 / ＋列 / －列」调整。
function insertTable(cols = 3, rows = 2) {
  if (isRichMode()) { insertTableRich(cols, rows); return; }
  const ta = els.bodyInput;
  if (!ta || !isSourceMode()) { toast('请先打开一条便签'); return; }
  if (typeof NN_MD === 'undefined' || typeof NN_MD.insertTableMarkdown !== 'function') {
    toast('表格组件未加载，请刷新页面（强制刷新可清缓存）');
    return;
  }
  const n = Math.max(1, Math.min(20, Number(cols) || 3));
  const m = Math.max(0, Math.min(50, Number(rows) || 0));
  const start = ta.selectionStart;
  const before = ta.value.slice(0, start);
  const pad = before && !/\n\n$/.test(before) ? (/\n$/.test(before) ? '\n' : '\n\n') : '';
  const block = NN_MD.insertTableMarkdown(m, n);
  const tail = '\n';
  ta.value = before + pad + block + tail + ta.value.slice(ta.selectionEnd);
  const caret = start + pad.length + block.length + tail.length;
  ta.focus();
  ta.setSelectionRange(caret, caret);
  handleEdit();
  toast('已插入 ' + n + ' 列 × ' + m + ' 行表格：用 ＋行/－行/＋列/－列 调整');
}

// 表格增删行列：根据光标所在行/列定位
function tableOperate(op) {
  const ta = els.bodyInput;
  const res = NN_MD.tableOp(ta.value, ta.selectionStart, op);
  if (!res.ok) { toast(res.reason || '表格操作失败'); return; }
  ta.value = res.text;
  ta.focus();
  const pos = Math.min(ta.value.length, ta.selectionStart);
  ta.setSelectionRange(pos, pos);
  handleEdit();
  const labels = { 'row-add': '已在表格末尾加一行', 'row-del': '已删除光标所在行', 'col-add': '已在光标右侧加一列', 'col-del': '已删除光标所在列' };
  toast(labels[op] || '表格已更新');
}

function handleMdAction(kind) {
  if (!currentId) { toast('请先打开一条便签'); return; }
  if (kind === 'preview') { togglePreview(); return; }
  // 字号是本机外观设置，两种编辑模式下都生效
  if (kind.indexOf('fs-') === 0) { applyFontSize(kind.slice(3)); return; }
  if (isRichMode()) { handleRichAction(kind); syncHeadingSelect(); return; }
  if (viewMode === 'view') applyViewMode('source');
  if (kind === 'table') { insertTable(); return; }
  if (kind === 'row-add' || kind === 'row-del' || kind === 'col-add' || kind === 'col-del') {
    tableOperate(kind);
    return;
  }
  if (kind === 'p') { clearHeadingSource(); syncHeadingSelect(); return; }
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
  syncHeadingSelect();
}

// 手机端：工具栏一行横滑，可滑时右缘渐隐提示，滑到尽头撤掉
function updateToolbarScrollState() {
  const el = els.mdToolbar;
  if (!el) return;
  const max = el.scrollWidth - el.clientWidth;
  el.classList.toggle('can-scroll', max > 4);
  el.classList.toggle('at-end', max > 4 && el.scrollLeft >= max - 4);
}
if (els.mdToolbar) {
  els.mdToolbar.addEventListener('scroll', updateToolbarScrollState, { passive: true });
  window.addEventListener('resize', updateToolbarScrollState);
}

// 正文滚起来时给固定条一点投影，让人看出上面那条是"钉住"的，而不是内容被切断。
function updateEditorStuck() {
  if (!els.editorBar || !els.editorScroll) return;
  els.editorBar.classList.toggle('is-stuck', els.editorScroll.scrollTop > 4);
}
if (els.editorScroll) {
  els.editorScroll.addEventListener('scroll', updateEditorStuck, { passive: true });
}
// 富文本里点工具栏不能让 contenteditable 失焦：一旦失焦选区就没了，加粗/标题会作用不到文字上。
els.mdToolbar.addEventListener('mousedown', (event) => {
  if (isRichMode() && event.target.closest('[data-md]')) event.preventDefault();
});

els.mdToolbar.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-md]');
  if (!btn) return;
  event.preventDefault();
  handleMdAction(btn.dataset.md);
});

// 工具栏下拉：段落样式（正文/H1-H3）与编辑区字号
if (els.headingSelect) {
  els.headingSelect.addEventListener('change', () => {
    handleMdAction(els.headingSelect.value || 'p');
  });
}
if (els.fontSizeSelect) {
  els.fontSizeSelect.addEventListener('change', () => {
    applyFontSize(els.fontSizeSelect.value);
  });
}

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
  const name = await promptFolderName('', '新建分类名称');
  if (!name) return;
  if (allFolders().indexOf(name) >= 0) { toast('分类「' + name + '」已存在'); return; }
  registerFolder(name);
  await persistFolderRegistry();
  // 当前便签还没归类时顺便移入新分类；已经有分类就不动它，
  // 免得「新建」把原来的分类里的最后一条便签带走，看起来像被覆盖。
  const plain = currentPlain();
  const current = plain ? (plain.folder || '').trim() : '';
  let moved = false;
  if (plain && !current) {
    plain.folder = name;
    plainCache.set(currentId, plain);
    const note = notesCache.get(currentId);
    if (note) await queueUpsert(note);
    moved = true;
  }
  renderFolderOptions();
  renderList();
  toast(moved
    ? '已新建分类「' + name + '」，当前便签已移入'
    : '已新建分类「' + name + '」，可从分类下拉或右键菜单移入');
});

els.renameFolderBtn.addEventListener('click', async () => {
  const plain = currentPlain();
  if (!plain) return;
  await renameFolder((plain.folder || '').trim());
});

els.deleteFolderBtn.addEventListener('click', async () => {
  const plain = currentPlain();
  if (!plain) return;
  await deleteFolder((plain.folder || '').trim());
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

async function deleteNoteById(id) {
  if (!id || !notesCache.has(id)) return;
  const yes = await askConfirm('删除便签', '确定删除这条便签（含正文图片和录音）？删除会同步到 NAS，且不可恢复。', '删除便签');
  if (!yes) return;
  clearTimeout(saveTimer);
  stopRecording();
  await queueDelete(id);
  if (currentId === id) {
    currentId = null;
    document.body.classList.remove('show-editor');
    setSaveState('已保存');
    renderEditor();
  }
  renderList();
  toast('便签已删除');
}

els.deleteBtn.addEventListener('click', () => deleteNoteById(currentId));

// 顶部「✓ 保存」：不等 450ms 的自动保存，立刻把内存明文加密落盘并触发一次同步。
async function saveNow() {
  if (!currentId || !cryptoKey) { toast('请先打开一条便签'); return; }
  if (isRichMode()) flushRich();
  clearTimeout(saveTimer);
  saveTimer = null;
  const note = notesCache.get(currentId);
  if (!note) return;
  await queueUpsert(note);
  renderList();
  updateEditorMeta();
  toast('已保存');
  if (syncMode === 'auto') triggerSync(200);
}

if (els.saveNowBtn) els.saveNowBtn.addEventListener('click', saveNow);

function handleEdit() {
  const note = notesCache.get(currentId);
  if (!note || !cryptoKey) return;
  const plain = plainCache.get(currentId) || { title: '', body: '', body_format: 'md', folder: '', attachments: [] };
  plain.title = els.titleInput.value;
  plain.body = currentBodyMd();
  plain.body_format = 'md';
  if (typeof plain.folder !== 'string') plain.folder = '';
  if (!Array.isArray(plain.attachments)) plain.attachments = [];
  plainCache.set(currentId, plain);
  setSaveState('编辑中…');
  updateEditorMeta();
  if (viewMode === 'source') autoGrowBody();
  schedulePreview();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const target = notesCache.get(currentId);
    if (target) queueUpsert(target);
    renderList();   // 标题/分类改动及时反映到列表，不必等同步回来
  }, 450);
}

els.titleInput.addEventListener('input', handleEdit);
els.bodyInput.addEventListener('input', handleEdit);

// ---------- 富文本事件 ----------
if (els.richEditor) {
  els.richEditor.addEventListener('input', () => {
    richDirty = true;
    updateRichPlaceholder();
    handleEdit();
  });
  // 失焦即落盘，避免切走时丢掉最后一次输入
  els.richEditor.addEventListener('blur', () => { flushRich(); });
  els.richEditor.addEventListener('keydown', richKeydown);
  els.richEditor.addEventListener('paste', (event) => {
    event.preventDefault();
    const data = event.clipboardData || window.clipboardData;
    const text = data ? data.getData('text/plain') : '';
    if (!text) return;
    // 只收纯文本：外部 HTML 带着样式/脚本进来会污染便签，也会让序列化不可控
    richInsertHtml(NN_MD.esc(text).replace(/\r\n?/g, '\n').replace(/\n/g, '<br>'));
    richChanged();
  });
  els.richEditor.addEventListener('drop', (event) => { event.preventDefault(); });
  els.richEditor.addEventListener('change', (event) => {
    if (event.target && event.target.type === 'checkbox') richChanged();
  });
  document.addEventListener('selectionchange', () => {
    rememberRichRange();
    if (isRichMode()) scheduleRichToolbarState();
    else syncHeadingSelect();
  });
  els.bodyInput.addEventListener('click', syncHeadingSelect);
  els.bodyInput.addEventListener('keyup', syncHeadingSelect);
}

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
  // 手动模式绝不因为「网恢复了」就自动上传：用户选择离线独立使用，
  // 联网与否都不该触发网络行为，只更新状态提示。
  if (syncMode === 'manual') {
    if (!sessionToken) syncMsgShow('已联网。点状态胶囊即可与 NAS 同步。', false);
    updateSyncUI();
    return;
  }
  setBadge('联网中');
  triggerSync(200);
});
window.addEventListener('offline', () => {
  if (!cryptoKey) return;
  if (syncMode === 'manual') {
    syncMsgShow('当前无网络，本机读写不受影响。', false);
    updateSyncUI();
    return;
  }
  setBadge('离线', 'offline');
});

const SETTINGS_PANEL_TITLES = {
  account: '账户', sync: '同步', appearance: '外观与编辑', data: '数据与备份', about: '关于'
};

function showSettingsPanel(name) {
  if (!SETTINGS_PANEL_TITLES[name]) name = 'account';
  els.settingsNav.querySelectorAll('[data-settings-panel]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.settingsPanel === name);
  });
  els.settingsDialog.querySelectorAll('.settings-panel').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== name;
  });
  els.settingsTitle.textContent = SETTINGS_PANEL_TITLES[name];
  els.settingsDialog.querySelector('.settings-body').scrollTop = 0;
}

els.settingsNav.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-settings-panel]');
  if (btn) showSettingsPanel(btn.dataset.settingsPanel);
});
els.settingsClose.addEventListener('click', () => closeDialog(els.settingsDialog));

els.settingsBtn.addEventListener('click', async () => {
  applyTheme(theme);
  applyEditorFont(editorFont);
  els.defaultViewSelect.value = localStorage.getItem('nn-default-view') || viewMode;
  showSettingsPanel('account');
  els.deviceInput.value = deviceId;
  els.syncMode.value = syncMode;
  els.syncInterval.value = String(syncIntervalSec);
  els.imageQuality.value = imageQuality;
  els.audioQuality.value = audioQuality;
  els.acctNameInput.value = accountName;
  els.acctCurrentInput.value = '';
  els.acctNewInput.value = '';
  els.acctConfirmInput.value = '';
  els.acctError.hidden = true;
  els.saveAccount.disabled = !sessionToken;
  openDialog(els.settingsDialog);
  updateSyncUI();
  updateServerLabel();
  // 壳内「设置 → 同步」里的地址行由桥接注入，打开设置时按原生配置回填，
  // 免得在登录页改过地址后这里还显示旧值。
  const injectedServerInput = document.getElementById('nn-server-input');
  const nativeApi = nativeServerApi();
  if (injectedServerInput && nativeApi) {
    try { injectedServerInput.value = nativeApi.getServer() || ''; } catch (error) { /* 忽略桥异常 */ }
  }
  if (sessionToken) {
    // 服务端为准刷新账户名（改名后其他设备同步显示）
    try {
      const resp = await fetch('/api/account', { headers: authHeaders() });
      if (resp.status === 401) { handleSessionExpired(); updateSyncUI(); return; }
      if (resp.ok) {
        const data = await resp.json();
        if (data.username) {
          accountName = data.username;
          els.acctNameInput.value = accountName;
        }
      }
    } catch (error) { /* 离线时保持本机记录 */ }
  }
});
els.cancelSettings.addEventListener('click', () => closeDialog(els.settingsDialog));
els.saveSettings.addEventListener('click', () => {
  applyTheme(els.themeSelect.value);
  applyEditorFont(els.editorFontSelect.value);
  const nextDefaultView = VIEW_MODES.includes(els.defaultViewSelect.value)
    ? els.defaultViewSelect.value : 'rich';
  localStorage.setItem('nn-default-view', nextDefaultView);
  applyViewMode(nextDefaultView);
  localStorage.setItem('nn-theme', theme);
  localStorage.setItem('nn-editor-font', editorFont);
  deviceId = els.deviceInput.value.trim() || genId();
  const nextMode = els.syncMode.value === 'manual' ? 'manual' : 'auto';
  const rawInterval = els.syncInterval.value;
  const nextInterval = normalizeSyncInterval(rawInterval);
  imageQuality = IMAGE_PROFILES[els.imageQuality.value] ? els.imageQuality.value : 'balanced';
  audioQuality = AUDIO_PROFILES[els.audioQuality.value] ? els.audioQuality.value : 'balanced';
  localStorage.setItem('nn-device', deviceId);
  localStorage.setItem('nn-sync-mode', nextMode);
  localStorage.setItem('nn-sync-interval', String(nextInterval));
  localStorage.setItem('nn-image-quality', imageQuality);
  localStorage.setItem('nn-audio-quality', audioQuality);
  closeDialog(els.settingsDialog);

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
  try {
    const sessionRaw = JSON.parse(localStorage.getItem('nn-session') || 'null');
    if (sessionRaw && sessionRaw.token) {
      sessionToken = sessionRaw.token;
      accountName = sessionRaw.username || '';
    }
  } catch (error) { /* 旧数据或损坏，按未登录处理 */ }
  localStorage.removeItem('nn-token');   // 旧版令牌残留清理
  // 安卓壳默认「手动」：启动、编辑、联网都不联网，只有用户点同步才连 NAS。
  // 浏览器直连 NAS 时保持自动（那本来就是在线环境）。
  syncMode = (localStorage.getItem('nn-sync-mode') || DEFAULT_SYNC_MODE) === 'manual' ? 'manual' : 'auto';
  syncIntervalSec = normalizeSyncInterval(localStorage.getItem('nn-sync-interval') || SYNC_INTERVAL_DEFAULT);
  imageQuality = localStorage.getItem('nn-image-quality') || 'balanced';
  audioQuality = localStorage.getItem('nn-audio-quality') || 'balanced';
  if (!IMAGE_PROFILES[imageQuality]) imageQuality = 'balanced';
  if (!AUDIO_PROFILES[audioQuality]) audioQuality = 'balanced';
  applyTheme(localStorage.getItem('nn-theme') || 'light');
  applyEditorFont(localStorage.getItem('nn-editor-font') || 'normal');
  // 旧版本（edit/split/view）一次性迁移到新的四视图，默认进入富文本。
  // 老的分栏是默认值而非用户主动选择，用户反馈「分栏别扭」，所以 split 也迁到 rich。
  if (localStorage.getItem('nn-view-v2') !== '1') {
    const legacyMap = { edit: 'source', split: 'rich' };
    const oldView = localStorage.getItem('nn-view-mode');
    if (oldView) localStorage.setItem('nn-view-mode', legacyMap[oldView] || oldView);
    const oldDefault = localStorage.getItem('nn-default-view');
    if (oldDefault) localStorage.setItem('nn-default-view', legacyMap[oldDefault] || oldDefault);
    localStorage.setItem('nn-view-v2', '1');
  }
  const storedView = localStorage.getItem('nn-view-mode');
  const defaultView = localStorage.getItem('nn-default-view') || 'rich';
  applyViewMode(VIEW_MODES.includes(storedView) ? storedView : defaultView, false);
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

  // 安卓壳（APK）里静态资源是内联进页面的，没有可缓存的网络资源，
  // 注册 Service Worker 只会空转并可能缓存旧版本，直接跳过。
  if ('serviceWorker' in navigator && !window.__NN_SHELL__) {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('[NasNotes] service worker registration failed', error);
    });
  }

  // 启动阶段不主动联网：本机有库就直接进「输入密码解锁」，没有库才提示去连 NAS。
  // 只有 Web 端的自动模式才在这里刷新会话与服务器包裹层。
  if (sessionToken && syncMode === 'auto') {
    try {
      await fetchMeta();
    } catch (error) {
      console.warn('[NasNotes] fetch meta failed, use cached', error);
    }
    if (sessionToken) {
      try {
        // 只验证会话是否有效，不再为了探活把整库便签拉一遍。
        const resp = await fetch('/api/account', { headers: authHeaders() });
        if (resp.status === 401) handleSessionExpired();
      } catch (error) { /* 离线时保留会话，联网后再验证 */ }
    }
  }

  offlineReady = Boolean(vaultMeta && vaultMeta.wrapped);
  showLockScreen(vaultMeta && vaultMeta.salt ? 'unlock' : 'init');
  renderList();
  renderEditor();
  updateSyncUI();
  updateServerLabel();
})();
