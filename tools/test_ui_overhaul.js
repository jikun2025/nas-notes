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

ok('工具栏字号立即作用于编辑区（不再插入 span 源码）', () => {
  assert.match(html, /data-md="fs-small"[^>]*>A-/);
  assert.match(html, /data-md="fs-normal"[^>]*>A</);
  assert.match(html, /data-md="fs-large"[^>]*>A\+/);
  const block = app.slice(app.indexOf('function applyFontSize'), app.indexOf('// 插入表格'));
  assert.match(block, /applyEditorFont\(key\)/);
  assert.match(block, /localStorage\.setItem\('nn-editor-font'/);
  assert.doesNotMatch(block, /fsWrap/);
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

ok('视图切换固定在编辑器顶部，不再藏在横向工具栏里', () => {
  const head = html.slice(html.indexOf('class="editor-head"'), html.indexOf('class="editor-scroll"'));
  ['rich', 'source', 'split', 'view'].forEach((view) => {
    assert.match(head, new RegExp('data-view="' + view + '"'));
  });
  assert.doesNotMatch(head, /md-toolbar/);
  const toolbar = html.slice(html.indexOf('id="mdToolbar"'), html.indexOf('class="rich-pane"'));
  assert.doesNotMatch(toolbar, /data-view|预览/);
  assert.match(app, /function applyViewMode\(next, persist = true\)/);
  assert.match(app, /localStorage\.setItem\('nn-view-mode', viewMode\)/);
});

ok('分栏预览随输入实时更新，双栏滚动联动', () => {
  assert.match(app, /function schedulePreview\(\)/);
  assert.match(app, /schedulePreview\(\);/);
  assert.match(app, /function syncPaneScroll\(from, to\)/);
  assert.match(css, /body\.view-source \.preview-pane/);
  assert.match(css, /body\.view-view \.source-pane/);
});

ok('Service Worker 缓存已升版到 v18', () => {
  assert.match(sw, /const CACHE = 'nas-notes-v18'/);
});

console.log('\nUI overhaul tests: ' + pass + ' pass');
