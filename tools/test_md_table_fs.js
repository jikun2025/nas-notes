'use strict';
/* 桩测：NN_MD 表格渲染 / tableOp 增删行列 / fsWrap 字号包裹 / text() 剥离 */
const assert = require('node:assert');
const NN_MD = require('../static/md.js');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log('ok - ' + name);
}

// ---------- 渲染 ----------
ok('render: 基本表格 → <table>', () => {
  const html = NN_MD.render('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n');
  assert.ok(html.includes('<table class="md-table">'));
  assert.ok(html.includes('<th>甲</th>'));
  assert.ok(html.includes('<td>1</td>'));
  assert.ok(html.includes('<td>2</td>'));
});

ok('render: 对齐标记 :---: / ---:', () => {
  const html = NN_MD.render('| a | b |\n| :---: | ---: |\n| 1 | 2 |\n');
  assert.ok(html.includes('<th class="md-al-center">a</th>'));
  assert.ok(html.includes('<th class="md-al-right">b</th>'));
  assert.ok(html.includes('<td class="md-al-center">1</td>'));
});

ok('render: 非表格行（无分隔行）不当表格', () => {
  const html = NN_MD.render('| a | b |\n| 1 | 2 |\n');
  assert.ok(!html.includes('<table'));
});

ok('render: 表格单元里转义 HTML', () => {
  const html = NN_MD.render('| a |\n| --- |\n| <script>x</script> |\n');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
});

// ---------- insertTableMarkdown ----------
ok('insertTableMarkdown: 3列2行', () => {
  const t = NN_MD.insertTableMarkdown(2, 3);
  const lines = t.split('\n');
  assert.strictEqual(lines.length, 4);
  // 每行 3 列 → 4 个 |
  lines.forEach((l) => assert.strictEqual((l.match(/\|/g) || []).length, 4));
});

// ---------- tableOp ----------
const TABLE = '前文\n| a | b |\n| --- | --- |\n| 1 | 2 |\n后文';
const HEADER_AT = TABLE.indexOf('| a');
const DATA_AT = TABLE.indexOf('| 1');

ok('tableOp: row-add 在表末尾加空行', () => {
  const res = NN_MD.tableOp(TABLE, DATA_AT, 'row-add');
  assert.ok(res.ok);
  const lines = res.text.split('\n');
  const idx = lines.findIndex((l) => l === '| 1 | 2 |');
  assert.strictEqual(lines[idx + 1], '|  |  |');
});

ok('tableOp: row-del 删光标所在数据行', () => {
  const res = NN_MD.tableOp(TABLE, DATA_AT, 'row-del');
  assert.ok(res.ok);
  assert.ok(!res.text.includes('| 1 | 2 |'));
  assert.ok(res.text.includes('| a | b |'));
});

ok('tableOp: col-add 在光标列右侧加列', () => {
  const res = NN_MD.tableOp(TABLE, DATA_AT + 3, 'col-add'); // 光标在 a/1 列内
  assert.ok(res.ok);
  const lines = res.text.split('\n');
  assert.strictEqual(lines[1], '| a | b |  |'); // 表头补列
  assert.strictEqual(lines[2], '| --- | --- | --- |');
});

ok('tableOp: col-del 删光标所在列', () => {
  const res = NN_MD.tableOp(TABLE, DATA_AT, 'col-del'); // 光标在第一列
  assert.ok(res.ok);
  const lines = res.text.split('\n');
  assert.strictEqual(lines[1], '| b |');
  assert.strictEqual(lines[3], '| 2 |');
});

ok('tableOp: col-del 最后一列 → 删整表', () => {
  const one = '| x |\n| --- |\n| 1 |';
  const res = NN_MD.tableOp(one, 2, 'col-del');
  assert.ok(res.ok);
  assert.ok(!res.text.includes('x'));
});

ok('tableOp: 光标不在表内返回 reason', () => {
  const res = NN_MD.tableOp('hello world', 3, 'row-add');
  assert.ok(!res.ok);
  assert.ok(res.reason.includes('光标不在表格内'));
});

ok('tableOp: row-del 光标在表头且无数据行 → 删整表', () => {
  const t = '| x | y |\n| --- | --- |';
  const res = NN_MD.tableOp(t, 2, 'row-del');
  assert.ok(res.ok);
  assert.ok(!res.text.includes('x'));
});

ok('tableOp: 增列后渲染仍正常', () => {
  const res = NN_MD.tableOp(TABLE, DATA_AT, 'col-add');
  const html = NN_MD.render(res.text);
  assert.ok(html.includes('<td></td>'));
});

// ---------- fsWrap ----------
ok('fsWrap: 选区包裹 large', () => {
  const t = 'hello big text';
  const res = NN_MD.fsWrap(t, 6, 9, 'large');
  assert.strictEqual(res.text, 'hello <span style="font-size:large">big</span> text');
  assert.strictEqual(res.text.slice(res.start, res.end), 'big');
});

ok('fsWrap: 再包同字号 → 取消', () => {
  const wrapped = 'hello <span style="font-size:large">big</span> text';
  const s = wrapped.indexOf('big');
  const res = NN_MD.fsWrap(wrapped, s, s + 3, 'large');
  assert.strictEqual(res.text, 'hello big text');
});

ok('fsWrap: 选区含 span 整体 → 取消', () => {
  const wrapped = '<span style="font-size:small">x</span>';
  const res = NN_MD.fsWrap(wrapped, 0, wrapped.length, 'small');
  assert.strictEqual(res.text, 'x');
});

ok('fsWrap: small→large 切换（剥旧壳包新壳）', () => {
  const wrapped = '<span style="font-size:small">x</span>';
  const res = NN_MD.fsWrap(wrapped, 0, wrapped.length, 'large');
  assert.strictEqual(res.text, '<span style="font-size:large">x</span>');
});

ok('fsWrap: 无选区插占位文字', () => {
  const res = NN_MD.fsWrap('ab', 1, 1, 'xlarge');
  assert.ok(res.text.includes('<span style="font-size:xlarge">文字</span>'));
});

ok('fsWrap: 渲染恢复为 fs-* class', () => {
  const html = NN_MD.render('a <span style="font-size:large">big</span> b');
  assert.ok(html.includes('<span class="fs-large">big</span>'));
});

ok('fsWrap: 其他 HTML 仍被转义', () => {
  const html = NN_MD.render('<span style="font-size:huge">x</span> <b>y</b>');
  assert.ok(!html.includes('<b>'));
  assert.ok(html.includes('&lt;b&gt;'));
});

ok('text(): 摘要剥离字号 span', () => {
  const t = NN_MD.text('前 <span style="font-size:large">大字</span> 后');
  assert.strictEqual(t, '前 大字 后');
});

ok('render: 字号嵌套加粗共存', () => {
  const html = NN_MD.render('<span style="font-size:large">**粗**</span>');
  assert.ok(html.includes('fs-large'));
  assert.ok(html.includes('<strong>粗</strong>'));
});

console.log('\n' + passed + ' assertions passed');
