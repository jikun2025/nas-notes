'use strict';
// UI 重构静态回归：两级设置、便签右键/长按菜单、应用内弹窗、字号与表格工具。
// 纯静态检查，零依赖。运行：node tools/test_ui_overhaul.js

const fs = require('fs');
const path = require('path');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, 'static', name), 'utf8');
const html = read('index.html');
const css = read('style.css');
const app = read('app.js');
const sw = read('sw.js');
const java = fs.readFileSync(path.join(ROOT, 'android/app/src/main/java/com/nasnotes/app/MainActivity.java'), 'utf8');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { console.error('  FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

ok('设置为两级结构：五个分类入口对应五个面板', () => {
  const nav = html.match(/data-settings-panel="/g) || [];
  const panels = html.match(/class="settings-panel"/g) || [];
  assert.strictEqual(nav.length, 5);
  assert.strictEqual(panels.length, 5);
  assert.match(html, /class="settings-nav"/);
  assert.match(css, /\.settings-shell\s*\{[^}]*display:\s*flex/);
});

ok('设置面板默认只显示账户分类', () => {
  const panels = html.match(/<section class="settings-panel"[^>]*>/g) || [];
  assert.strictEqual(panels.length, 5);
  panels.forEach((tag, i) => {
    assert.strictEqual(/\shidden/.test(tag), i !== 0, 'panel ' + i + ' hidden 状态不对');
  });
  assert.match(app, /function showSettingsPanel\(name\)/);
});

ok('外观设置含主题与编辑字号，保存写入本机', () => {
  assert.match(html, /id="themeSelect"[\s\S]{0,160}<option value="light"/);
  assert.match(html, /id="editorFontSelect"[\s\S]{0,220}<option value="xlarge"/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(app, /localStorage\.setItem\('nn-theme', theme\)/);
  assert.match(app, /localStorage\.setItem\('nn-editor-font', editorFont\)/);
  assert.match(css, /--editor-fs:/);
});

ok('工具栏字号以「字号」下拉切换，立即作用于编辑区（不再插入 span 源码）', () => {
  assert.match(html, /id="fontSizeSelect"[\s\S]{0,240}<option value="xlarge"/);
  assert.match(html, /id="headingSelect"[\s\S]{0,200}<option value="h3"/);
  assert.match(app, /els\.fontSizeSelect\.addEventListener\('change'/);
  assert.match(app, /els\.headingSelect\.addEventListener\('change'/);
  const block = app.slice(app.indexOf('function applyFontSize'), app.indexOf('// 插入表格'));
  assert.match(block, /applyEditorFont\(key\)/);
  assert.match(block, /localStorage\.setItem\('nn-editor-font'/);
  assert.doesNotMatch(block, /fsWrap/);
});

ok('工具栏桌面两行分组，手机合并成一行横向滑动', () => {
  const toolbar = html.slice(html.indexOf('id="mdToolbar"'), html.indexOf('class="rich-pane"'));
  assert.strictEqual((toolbar.match(/class="md-row"/g) || []).length, 2);
  assert.match(toolbar, /data-md="table"/);
  assert.match(toolbar, /data-md="hr"/);
  assert.match(toolbar, /id="imageBtn"/);
  assert.match(toolbar, /id="recordBtn"/);
  assert.match(css, /\.md-toolbar\s*\{[^}]*flex-direction:\s*column/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.md-toolbar\s*\{[^}]*flex-wrap:\s*nowrap/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.md-toolbar\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(css, /\.md-row\s*\{\s*display:\s*contents/);
});

ok('标题区含字数计数与「保存」按钮，正文页脚显示字符数', () => {
  assert.match(html, /id="titleCount"[^>]*>0\/200</);
  assert.match(html, /id="bodyCount"[^>]*>0 字符</);
  assert.match(html, /id="saveNowBtn"/);
  assert.match(html, /class="title-field"/);
  assert.match(app, /function updateCounters\(\)/);
  assert.match(app, /async function saveNow\(\)/);
  assert.match(app, /els\.saveNowBtn\.addEventListener\('click', saveNow\)/);
});

ok('插入表格直接落到正文，不依赖 dialog/prompt（WebView 兼容）', () => {
  const start = app.indexOf('function insertTable(cols');
  const block = app.slice(start, app.indexOf('// 表格增删行列')).replace(/^\s*\/\/.*$/gm, '');
  // 点一下即插入：函数内直接改 textarea，并调用 Markdown 表格生成
  assert.match(block, /NN_MD\.insertTableMarkdown\(m, n\)/);
  assert.match(block, /ta\.setSelectionRange\(caret, caret\)/);
  // 不得再依赖任何弹窗或原生 prompt
  assert.doesNotMatch(block, /showModal|tableDialog|\bprompt\(/);
  assert.doesNotMatch(app, /id="tableDialog"/);
  assert.doesNotMatch(app, /window\.prompt\(|window\.confirm\(/);
  // 工具栏按钮仍绑定到 table
  assert.match(html, /data-md="table"/);
  // 所有 dialog.showModal 只能出现在 openDialog 内部，避免老 WebView 静默失败
  const directCalls = app.match(/els\.\w+Dialog\.showModal\(\)/g) || [];
  assert.equal(directCalls.length, 0);
  assert.match(app, /function openDialog\(dialog\)/);
  assert.match(app, /dialog\.classList\.add\('dialog-fallback'\)/);
});

ok('便签列表支持右键与长按，菜单含删除/分类', () => {
  assert.match(html, /id="noteContextMenu"[^>]*>/);
  ['open', 'folder', 'delete'].forEach((action) => {
    assert.match(html, new RegExp('data-action="' + action + '"'));
  });
  assert.match(app, /els\.noteList\.addEventListener\('contextmenu'/);
  assert.match(app, /els\.noteList\.addEventListener\('touchstart'/);
  assert.match(app, /function showContextMenu\(x, y, id\)/);
  assert.match(app, /function openFolderDialog\(id\)/);
  assert.match(app, /function deleteNoteById\(id\)/);
});

ok('三区布局：分类栏 + 便签列表 + 编辑预览区', () => {
  assert.match(html, /<aside class="sidebar" id="sidebar">/);
  assert.match(html, /id="folderRail" class="folder-rail"/);
  assert.match(html, /<section class="note-pane" id="notePane">/);
  assert.match(html, /id="noteList" class="note-list"/);
  assert.match(html, /<main class="editor" id="editor">/);
  assert.match(css, /\.writing-pane\s*\{[^}]*grid-template-columns[^}]*1fr[^}]*1fr/);
  assert.match(app, /function renderFolderRail\(\)/);
  assert.match(app, /function notesInActiveFolder\(\)/);
});

ok('手机端分类栏是「可收起的抽屉」，不再直接隐藏', () => {
  assert.match(html, /id="railToggleBtn"/);
  assert.match(html, /id="railCloseBtn"/);
  assert.match(html, /id="railScrim"/);
  assert.match(app, /function railIsDrawer\(\)/);
  assert.match(app, /function setRailOpen\(open\)/);
  assert.match(app, /classList\.toggle\('rail-open'/);
  assert.match(app, /els\.railToggleBtn\.addEventListener\('click'/);
  assert.match(app, /els\.railCloseBtn\.addEventListener\('click', closeRail\)/);
  assert.match(app, /els\.railScrim\.addEventListener\('click', closeRail\)/);
  // 点分类、进编辑、锁屏都要自动收起，否则抽屉会一直压着列表
  assert.match(app, /if \(railIsDrawer\(\)\) closeRail\(\);/);
  assert.match(app, /classList\.contains\('rail-open'\)\) closeRail\(\);/);

  const narrow = css.slice(css.indexOf('@media (max-width: 1180px)'), css.indexOf('@media (max-width: 860px)'));
  assert.doesNotMatch(narrow, /\.sidebar\s*\{[^}]*display:\s*none/);
  assert.match(narrow, /body\.rail-open \.sidebar\s*\{[^}]*translateX\(0\)/);
  assert.match(narrow, /\.rail-toggle\s*\{[^}]*display:\s*inline-flex/);
  // 侧栏底部还有同步/锁定/设置三个入口，手机上也必须能点到
  assert.match(html, /id="syncBtn"/);
  assert.match(html, /id="lockBtn"/);
  assert.match(html, /id="settingsBtn"/);
});

ok('系统栏安全区：状态栏不再压住顶部标题', () => {
  assert.match(css, /--safe-top:\s*var\(--nn-safe-top,\s*env\(safe-area-inset-top/);
  assert.match(css, /--safe-bottom:\s*var\(--nn-safe-bottom,\s*env\(safe-area-inset-bottom/);
  assert.match(css, /\.note-pane-head\s*\{[^}]*var\(--safe-top\)/);
  assert.match(css, /\.editor-head\s*\{[^}]*var\(--safe-top\)/);
  assert.match(css, /\.rail-brand\s*\{[^}]*var\(--safe-top\)/);
  assert.match(css, /\.lock-screen\s*\{[\s\S]*?var\(--safe-top\)/);
  assert.match(css, /\.note-list\s*\{[^}]*var\(--safe-bottom\)/);
  // 原生层把真实 insets 写成 CSS 变量；页面载入完成后补写一次
  assert.match(java, /private void installSafeInsets\(\)/);
  assert.match(java, /setProperty\('--nn-safe-top'/);
  assert.match(java, /public void onPageFinished[\s\S]{0,200}injectSafeInsets\(\)/);
});

ok('视图切换固定在编辑器顶部，不再藏在横向工具栏里', () => {
  const head = html.slice(html.indexOf('class="editor-head"'), html.indexOf('class="editor-bar"'));
  ['rich', 'source', 'split', 'view'].forEach((view) => {
    assert.match(head, new RegExp('data-view="' + view + '"'));
  });
  assert.doesNotMatch(head, /md-toolbar/);
  const toolbar = html.slice(html.indexOf('id="mdToolbar"'), html.indexOf('class="rich-pane"'));
  assert.doesNotMatch(toolbar, /data-view|预览/);
  assert.match(app, /function applyViewMode\(next, persist = true\)/);
  assert.match(app, /localStorage\.setItem\('nn-view-mode', viewMode\)/);
});

ok('标题与排版工具栏在滚动区之外，正文滑多远都能点', () => {
  // 结构：editor-head → editor-bar（标题/分类/工具栏）→ editor-scroll（只有正文）
  const bar = html.indexOf('class="editor-bar"');
  const scroll = html.indexOf('class="editor-scroll"');
  assert.ok(bar > 0 && scroll > bar, 'editor-bar 必须在 editor-scroll 之前');
  const fixed = html.slice(bar, scroll);
  assert.match(fixed, /id="titleInput"/);
  assert.match(fixed, /id="folderSelect"/);
  assert.match(fixed, /id="mdToolbar"/);
  const scrolled = html.slice(scroll, html.indexOf('id="attachmentList"'));
  assert.doesNotMatch(scrolled, /id="titleInput"|id="mdToolbar"/);
  assert.match(scrolled, /id="richEditor"/);
  // 样式：固定条不参与压缩，滚动容器自己滚
  assert.match(css, /\.editor-bar\s*\{[^}]*flex:\s*none/);
  assert.match(css, /\.editor-scroll\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(app, /els\.editorBar\.classList\.toggle\('is-stuck'/);
});

ok('设置长面板在对话框内滚动，标题栏与保存按钮不跑掉', () => {
  assert.match(css, /\.settings-dialog\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.settings-dialog\s*\{[^}]*max-height:\s*calc\(100dvh[^}]*--safe-top/);
  assert.match(css, /\.settings-shell\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0/);
  assert.match(css, /\.settings-main\s*\{[^}]*min-height:\s*0/);
  assert.match(css, /\.settings-body\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.settings-foot\s*\{[^}]*flex:\s*none/);
  // 手机上不再给 shell 一个 88vh 的软上限（会算不出确定高度 → 内容被裁）
  const narrow = css.slice(css.indexOf('@media (max-width: 860px)'), css.indexOf('@media (max-width: 760px)'));
  assert.doesNotMatch(narrow, /max-height:\s*88vh/);
  assert.match(narrow, /\.settings-shell\s*\{\s*flex-direction:\s*column/);
  assert.match(narrow, /\.settings-body\s*\{[^}]*var\(--safe-bottom\)/);
});

ok('分栏预览随输入实时更新，双栏滚动联动', () => {
  assert.match(app, /function schedulePreview\(\)/);
  assert.match(app, /schedulePreview\(\);/);
  assert.match(app, /function syncPaneScroll\(from, to\)/);
  assert.match(css, /body\.view-source \.preview-pane/);
  assert.match(css, /body\.view-view \.source-pane/);
});

ok('分类可同时存在多个：本机加密清单保住空分类', () => {
  assert.match(app, /const FOLDERS_META_KEY = 'folders'/);
  assert.match(app, /let folderRegistry = \[\]/);
  assert.match(app, /async function loadFolderRegistry\(\)/);
  assert.match(app, /async function persistFolderRegistry\(\)/);
  const all = app.slice(app.indexOf('function allFolders()'), app.indexOf('// 分类导航（三区布局的左栏）'));
  assert.match(all, /new Set\(folderRegistry\)/);
  // 解锁后读清单、锁屏时清内存
  assert.match(app, /await loadFolderRegistry\(\)/);
  assert.match(app, /plainCache\.clear\(\);\s*folderRegistry = \[\];/);
  // 新建分类只登记名字；当前便签已有分类时不把它搬走（否则旧分类会被"覆盖"）
  const create = app.slice(app.indexOf('els.newFolderBtn.addEventListener'),
    app.indexOf('els.renameFolderBtn.addEventListener'));
  assert.match(create, /registerFolder\(name\)/);
  assert.match(create, /await persistFolderRegistry\(\)/);
  assert.match(create, /if \(plain && !current\)/);
  assert.match(create, /moved\s*\?/);
  // 改名 / 删除同步清单
  assert.match(app, /async function renameFolder\(from\)/);
  assert.match(app, /async function deleteFolder\(from\)/);
  assert.match(app, /if \(unregisterFolder\(source\)\) await persistFolderRegistry\(\)/);
  // 空分类没有便签可以打开，给它右键/长按菜单
  assert.match(html, /id="folderContextMenu"/);
  assert.match(html, /data-action="rename">✏️ 重命名分类…/);
  assert.match(app, /els\.folderRail\.addEventListener\('contextmenu'/);
  // 清库时一并清掉清单
  assert.match(app, /await idbDelete\(STORE_META, FOLDERS_META_KEY\)/);
});

ok('分类改名/删除按钮不再永远隐藏', () => {
  const block = app.slice(app.indexOf('function renderFolderOptions()'),
    app.indexOf('// 打开弹窗：老版安卓 WebView'));
  assert.match(block, /els\.renameFolderBtn\.hidden = !hasCurrent/);
  assert.match(block, /els\.deleteFolderBtn\.hidden = !hasCurrent/);
  assert.doesNotMatch(block, /const custom =/);
});

ok('Service Worker 缓存已升版', () => {
  const cachedVer = Number((/const CACHE = 'nas-notes-v(\d+)'/.exec(sw) || [0, '0'])[1]);
  assert.ok(cachedVer >= 25, 'CACHE 版本需 >= 25，当前 ' + cachedVer);
});

ok('大列表分批渲染：只画前 200 条，其余按需展开', () => {
  assert.match(app, /const LIST_RENDER_LIMIT = 200;/);
  assert.match(app, /const shown = \(listShowAll \|\| items\.length <= LIST_RENDER_LIMIT\)/);
  assert.match(app, /const hiddenCount = items\.length - shown\.length;/);
  assert.match(app, /shown\.forEach\(\(item\) => \{/);
  assert.match(app, /id="listMoreBtn" class="list-more"/);
  assert.match(app, /event\.target\.closest\('#listMoreBtn'\)/);
  assert.match(app, /listShowAll = false;\s*\n\s*renderList\(\);/);
  assert.match(read('style.css'), /\.list-more\s*\{/);
});

ok('搜索输入防抖，连打字不逐字重建列表', () => {
  assert.match(app, /let searchRenderTimer = 0;/);
  assert.match(app, /clearTimeout\(searchRenderTimer\)/);
  assert.match(app, /searchRenderTimer = setTimeout\(renderList, 120\)/);
  assert.doesNotMatch(app, /searchInput\.addEventListener\('input', renderList\)/);
});

ok('正文纯文本延迟解析并缓存，搜索与摘要不重复算', () => {
  const block = app.slice(app.indexOf('function visibleNotes()'),
    app.indexOf('function noteItemHTML'));
  assert.match(block, /if \(!query\) return true;/);
  assert.match(block, /item\.text = text;/);
  assert.match(app, /item\.text \|\| bodyText\(item\.plain\)/);
  assert.match(app, /const total = query \? notesInActiveFolder\(\)\.length : items\.length;/);
});

console.log('\nUI overhaul tests: ' + pass + ' pass');
