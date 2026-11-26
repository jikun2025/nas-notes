/* nn-index.js — 内存态全文索引 + 分类倒排（零依赖，ES5 语法，鸿蒙 WebView 可跑）
 *
 * 硬约束：端到端加密项目里，明文绝不落盘、绝不上行。所以这个索引只存在于
 * 内存：解锁后由已解密的 plainCache 构建，锁定 / 清库时立即销毁，不写入
 * IndexedDB、outbox、备份，也不发给服务端。它本质上是「搜索缓存」，不是存储层。
 *
 * 为什么是 bigram（二元组）：中文没有空格，没法按词切分；把可搜索文本切成
 * 连续二元组建立倒排表，任意长度 >=2 的子串查询都能拆成若干 bigram 求交集，
 * 保证「包含即召回」（不会漏检）。交集可能带来跨位置的假阳性，调用方再用
 * 原始字段的 includes() 精确校验一次即可，语义与改造前完全一致。
 * 单字查询走 unigram 倒排表。
 *
 * 复杂度：搜索从「每次遍历全部便签 + 解析 Markdown」降为「查倒排表取候选集，
 * 只对候选做精确校验」；分类切换从 O(n) 降为 O(该分类的条数)。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.NN_INDEX = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function normalize(value) {
    return String(value == null ? '' : value).toLowerCase();
  }

  // 空串代表「未分类」，避免把展示名硬编码进通用模块。
  function folderKey(folder) {
    return normalize(folder).trim();
  }

  function addTo(map, key, id) {
    var set = map.get(key);
    if (!set) { set = new Set(); map.set(key, set); }
    set.add(id);
  }

  function removeFrom(map, key, id) {
    var set = map.get(key);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) map.delete(key);
  }

  function Index() {
    this.bi = new Map();       // bigram -> Set<id>
    this.uni = new Map();      // 单字 -> Set<id>
    this.docs = new Map();     // id -> { bi, uni, folder }
    this.folders = new Map();  // folderKey -> Set<id>
  }

  Index.prototype.remove = function (id) {
    var doc = this.docs.get(id);
    if (!doc) return;
    var self = this;
    doc.bi.forEach(function (token) { removeFrom(self.bi, token, id); });
    doc.uni.forEach(function (token) { removeFrom(self.uni, token, id); });
    removeFrom(this.folders, doc.folder, id);
    this.docs.delete(id);
  };

  Index.prototype.add = function (id, text, folder) {
    this.remove(id);
    var normalized = normalize(text);
    var bi = new Set();
    var uni = new Set();
    var i;
    for (i = 0; i < normalized.length; i += 1) {
      uni.add(normalized.charAt(i));
      if (i + 1 < normalized.length) bi.add(normalized.slice(i, i + 2));
    }
    var self = this;
    bi.forEach(function (token) { addTo(self.bi, token, id); });
    uni.forEach(function (token) { addTo(self.uni, token, id); });
    var key = folderKey(folder);
    addTo(this.folders, key, id);
    this.docs.set(id, { bi: bi, uni: uni, folder: key });
  };

  /** 返回候选 id 集合；null 表示「无查询条件，不应过滤」。 */
  Index.prototype.query = function (rawQuery) {
    var q = normalize(rawQuery);
    if (!q) return null;
    var sets = [];
    var i;
    if (q.length === 1) {
      sets.push(this.uni.get(q.charAt(0)));
    } else {
      for (i = 0; i + 1 < q.length; i += 1) sets.push(this.bi.get(q.slice(i, i + 2)));
    }
    var smallest = null;
    for (i = 0; i < sets.length; i += 1) {
      if (!sets[i] || sets[i].size === 0) return new Set();
      if (!smallest || sets[i].size < smallest.size) smallest = sets[i];
    }
    var out = new Set();
    smallest.forEach(function (id) {
      for (var j = 0; j < sets.length; j += 1) {
        if (!sets[j].has(id)) return;
      }
      out.add(id);
    });
    return out;
  };

  Index.prototype.idsInFolder = function (folder) {
    var set = this.folders.get(folderKey(folder));
    return set ? new Set(set) : new Set();
  };

  Index.prototype.folderOf = function (id) {
    var doc = this.docs.get(id);
    return doc ? doc.folder : '';
  };

  Index.prototype.clear = function () {
    this.bi.clear();
    this.uni.clear();
    this.docs.clear();
    this.folders.clear();
  };

  Index.prototype.stats = function () {
    return {
      docs: this.docs.size,
      bigrams: this.bi.size,
      unigrams: this.uni.size,
      folders: this.folders.size
    };
  };

  return {
    create: function () { return new Index(); },
    normalize: normalize,
    folderKey: folderKey,
    Index: Index
  };
});
