'use strict';
// 内存全文/分类索引单测：零依赖，node tools/test_search_index.js
// 核心断言——「索引候选 + 精确校验」的结果必须与改造前的「全量扫描 + 精确校验」
// 完全一致，尤其要保证中文子串不漏检。

const fs = require('fs');
const path = require('path');
const assert = require('node:assert');
const NN_INDEX = require('../static/nn-index.js');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'static', 'nn-index.js'), 'utf8');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  PASS ' + name); }
  catch (e) { console.error('  FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

// 与 app.js 的 indexableText / matchesQuery 等价的模拟
function makeDoc(d) {
  return {
    id: d.id,
    title: d.title || '',
    body: d.body || '',
    folder: d.folder || '',
    names: d.names || []
  };
}
function indexText(d) {
  return [d.title, d.body, d.folder].concat(d.names).join('\n');
}
function exact(d, q) {
  if (String(d.title).toLowerCase().includes(q)) return true;
  if (String(d.body).toLowerCase().includes(q)) return true;
  if (String(d.folder).toLowerCase().includes(q)) return true;
  for (const n of d.names) if (String(n).toLowerCase().includes(q)) return true;
  return false;
}

const DOCS = [
  makeDoc({ id: 'a', title: '项目周报', body: '本周一完成了全文索引与增量同步的联调，Markdown 渲染也顺畅。', folder: '工作', names: ['架构图.png'] }),
  makeDoc({ id: 'b', title: '购物清单', body: '牛奶 two bottles、鸡蛋、咖啡豆。', folder: '生活', names: ['receipt.jpg', '清单备份.json'] }),
  makeDoc({ id: 'c', title: 'Meeting notes', body: 'Discussed incremental sync over HTTP 502 and WebView fallback.', folder: '工作', names: [] }),
  makeDoc({ id: 'd', title: '鸿蒙适配', body: '卓易通 WebView 的 shouldInterceptRequest 旧版重载必须补齐。', folder: '开发', names: ['compat-check.txt'] }),
  makeDoc({ id: 'e', title: '空', body: '', folder: '', names: [] }),
  makeDoc({ id: 'f', title: '数字与符号', body: '2026-11-26 v2.6 100% (!) abc_ABC', folder: '测试', names: ['a+b(1).png'] })
];

function build() {
  const idx = NN_INDEX.create();
  DOCS.forEach((d) => idx.add(d.id, indexText(d), d.folder));
  return idx;
}

ok('索引构建：文档数/分类数正确', () => {
  const idx = build();
  const st = idx.stats();
  assert.strictEqual(st.docs, DOCS.length);
  assert.strictEqual(st.folders, 5);           // 工作/生活/开发/测试 与 未分类(空串)
  assert.ok(st.bigrams > 0 && st.unigrams > 0);
});

ok('中文子串查询：命中且包含即召回', () => {
  const idx = build();
  for (const q of ['全文索引', '增量同步', '周报', '清单', '鸿蒙适配', '卓易通']) {
    const ids = Array.from(idx.query(q));
    assert.ok(ids.length > 0, '查询 ' + q + ' 应有候选');
  }
});

ok('英文大小写不敏感、数字与标点可搜', () => {
  const idx = build();
  assert.ok(idx.query('incremental').has('c'));
  assert.ok(idx.query('INCREMENTAL').has('c'));
  assert.ok(idx.query('2026-11-26').has('f'));
  assert.ok(idx.query('100%').has('f'));
  assert.ok(idx.query('abc_ABC').has('f'));
});

ok('单字查询走 unigram 倒排', () => {
  const idx = build();
  assert.ok(idx.query('牛').has('b'));
  assert.ok(idx.query('索').has('a'));
  assert.ok(idx.query('Z').size === 0);
});

ok('空查询返回 null（不过滤），不存在的词返回空集合', () => {
  const idx = build();
  assert.strictEqual(idx.query(''), null);
  assert.strictEqual(idx.query('   ').size, 0);   // 空格串本身无 token
  assert.strictEqual(idx.query('完全不存在的词组zzz').size, 0);
});

ok('附件名与分类名也能被索引（候选集里）', () => {
  const idx = build();
  assert.ok(idx.query('receipt.jpg').has('b'));
  assert.ok(idx.query('compat-check').has('d'));
  assert.ok(idx.query('工作').has('a') || idx.query('工作').has('c'));
});

ok('分类倒排：切分类只返回该分类 id，未分类用空串', () => {
  const idx = build();
  assert.deepStrictEqual(Array.from(idx.idsInFolder('工作')).sort(), ['a', 'c']);
  assert.deepStrictEqual(Array.from(idx.idsInFolder('生活')).sort(), ['b']);
  assert.deepStrictEqual(Array.from(idx.idsInFolder('')).sort(), ['e']);
  assert.strictEqual(idx.idsInFolder('不存在的分类').size, 0);
  assert.strictEqual(idx.folderOf('a'), '工作');
});

ok('增量维护：改正文后旧词不再命中、新词命中', () => {
  const idx = build();
  idx.add('a', indexText(makeDoc({ id: 'a', title: '改过的标题', body: '全新的内容关键词', folder: '工作' })), '工作');
  assert.ok(!idx.query('全文索引').has('a'));
  assert.ok(idx.query('全新的内容').has('a'));
  assert.strictEqual(idx.stats().docs, DOCS.length);   // 没有重复文档
});

ok('增量维护：改分类后旧分类不再包含它', () => {
  const idx = build();
  idx.add('a', indexText(DOCS[0]), '归档');
  assert.ok(!idx.idsInFolder('工作').has('a'));
  assert.ok(idx.idsInFolder('归档').has('a'));
  assert.strictEqual(idx.folderOf('a'), '归档');
});

ok('增量维护：remove 后倒排表无残留', () => {
  const idx = build();
  idx.remove('a');
  assert.strictEqual(idx.stats().docs, DOCS.length - 1);
  assert.ok(!idx.query('全文索引').has('a'));
  assert.ok(!idx.idsInFolder('工作').has('a'));
  idx.clear();
  assert.strictEqual(idx.stats().docs, 0);
  assert.strictEqual(idx.stats().bigrams, 0);
});

// ---------- 关键：与全量扫描等价，不漏检 ----------
ok('随机对照：索引候选 + 精确校验 ≡ 全量扫描（1000 条 / 200 查询）', () => {
  const chars = '轻签便签加密同步索引增量全文鸿蒙卓易通WebView服务端口令密文MarkdownABCabc0123 -_.,!%()[]';
  let seed = 20261126;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  function randText(n) {
    let out = '';
    for (let i = 0; i < n; i += 1) out += chars[Math.floor(rnd() * chars.length)];
    return out;
  }
  const docs = [];
  for (let i = 0; i < 1000; i += 1) {
    docs.push(makeDoc({
      id: 'r' + i,
      title: randText(6 + Math.floor(rnd() * 14)),
      body: randText(40 + Math.floor(rnd() * 260)),
      folder: rnd() < 0.2 ? '' : randText(2 + Math.floor(rnd() * 6)),
      names: rnd() < 0.3 ? [randText(8) + '.png'] : []
    }));
  }
  const idx = NN_INDEX.create();
  const byId = new Map();
  docs.forEach((d) => { idx.add(d.id, indexText(d), d.folder); byId.set(d.id, d); });

  for (let t = 0; t < 200; t += 1) {
    let q;
    if (t % 3 === 0) {
      const d = docs[Math.floor(rnd() * docs.length)];
      const src = [d.title, d.body, d.folder].concat(d.names)[Math.floor(rnd() * 4)] || d.body;
      const start = Math.floor(rnd() * Math.max(1, src.length - 1));
      q = src.slice(start, start + 1 + Math.floor(rnd() * 6)).toLowerCase();
      if (!q) q = 'a';
    } else {
      q = randText(1 + Math.floor(rnd() * 5)).toLowerCase();
    }
    const full = new Set(docs.filter((d) => exact(d, q)).map((d) => d.id));
    const candidates = idx.query(q) || new Set(docs.map((d) => d.id));
    const viaIndex = new Set();
    candidates.forEach((id) => {
      const d = byId.get(id);
      if (d && exact(d, q)) viaIndex.add(id);
    });
    assert.strictEqual(viaIndex.size, full.size,
      '查询 ' + JSON.stringify(q) + ' 命中数不一致：索引 ' + viaIndex.size + ' vs 全量 ' + full.size);
    full.forEach((id) => assert.ok(viaIndex.has(id), '查询 ' + JSON.stringify(q) + ' 漏检 ' + id));
  }
});

// ---------- 硬约束：明文索引绝不落盘 ----------
ok('索引模块不含任何持久化/网络调用（明文只在内存）', () => {
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|IDBDatabase/);
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket/);
  assert.doesNotMatch(source, /crypto|subtle/);
});

ok('索引模块保持 ES5 语法（老 WebView / 鸿蒙卓易通可解析）', () => {
  assert.doesNotMatch(source, /(^|[^\w])(let|const)\s+\w/);
  assert.doesNotMatch(source, /=>/);
  assert.doesNotMatch(source, /\?\./);
  assert.doesNotMatch(source, /`/);
});

console.log('\n全文索引单测：' + pass + ' pass');
