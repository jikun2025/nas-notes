'use strict';

/* 轻签 HTML → Markdown 序列化（零依赖）
 * 富文本（contenteditable）模式保存用：把编辑区 DOM 还原成 Markdown 源码。
 * 只处理 NN_MD.render 能产出的结构 + contenteditable 原生编辑产生的 div/p/br。
 * 设计原则：
 *   - 生成的 Markdown 必须能被 NN_MD.render 还原成同样的 DOM（往返稳定）；
 *   - 不引入任何第三方库，不依赖 DOMParser（直接操作节点）。
 */
var NN_HTML2MD = (function () {
  var BLOCK = ['div', 'p', 'ul', 'ol', 'blockquote', 'pre', 'table', 'figure',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'section', 'article'];

  function isTag(el, tag) {
    return String((el && el.tagName) || '').toLowerCase() === tag;
  }

  function elements(el) {
    return Array.prototype.filter.call((el && el.children) || [], function (child) {
      return child.tagName;
    });
  }

  function hasBlockChild(el) {
    return elements(el).some(function (child) {
      return BLOCK.indexOf(String(child.tagName).toLowerCase()) >= 0;
    });
  }

  function textOf(el) {
    return String((el && el.textContent) == null ? '' : el.textContent)
      .replace(/\u00a0/g, ' ').replace(/\r/g, '');
  }

  // 段落内换行：contenteditable 用 <br>，Markdown 里直接是换行（md.js 渲染回 <br>）
  function inline(node) {
    var out = '';
    Array.prototype.forEach.call((node && node.childNodes) || [], function (child) {
      if (child.nodeType === 3) {
        out += String(child.nodeValue || '').replace(/\u00a0/g, ' ');
        return;
      }
      if (child.nodeType !== 1) return;
      var tag = String(child.tagName).toLowerCase();
      if (tag === 'br') { out += '\n'; return; }
      if (tag === 'input') return;
      var inner = inline(child);
      var trimmed = inner.trim();
      if (tag === 'strong' || tag === 'b') {
        out += trimmed ? '**' + inner.replace(/^\s+|\s+$/g, '') + '**' : inner;
      } else if (tag === 'em' || tag === 'i') {
        out += trimmed ? '*' + inner.replace(/^\s+|\s+$/g, '') + '*' : inner;
      } else if (tag === 'del' || tag === 's' || tag === 'strike') {
        out += trimmed ? '~~' + inner.replace(/^\s+|\s+$/g, '') + '~~' : inner;
      } else if (tag === 'code') {
        out += '`' + textOf(child).replace(/`/g, '') + '`';
      } else if (tag === 'a') {
        var href = child.getAttribute('href') || '';
        out += '[' + (trimmed || href) + '](' + (href || '#') + ')';
      } else if (tag === 'img') {
        out += imageMd(child);
      } else if (tag === 'span') {
        var size = fontSpanSize(child);
        out += size ? '<span style="font-size:' + size + '">' + inner + '</span>' : inner;
      } else if (tag === 'figure') {
        out += imageMd(child);
      } else {
        out += inner;
      }
    });
    return out;
  }

  function fontSpanSize(el) {
    var cls = String(el.getAttribute('class') || '');
    var m = /(?:^|\s)fs-(small|large|xlarge)(?:\s|$)/.exec(cls);
    return m ? m[1] : '';
  }

  // 图片：附件图（带 data-att）还原为占位符，外链图还原为 ![](url)
  function imageMd(el) {
    var img = isTag(el, 'img') ? el : el.querySelector('img');
    var att = (img && img.getAttribute('data-att')) || el.getAttribute('data-att') || '';
    if (/^[A-Za-z0-9_-]{1,80}$/.test(att)) return '![[att:' + att + ']]';
    if (!img) return '';
    var src = img.getAttribute('src') || '';
    if (!src) return '';
    var alt = img.getAttribute('alt') || '';
    return '![' + alt + '](' + src + ')';
  }

  function listMd(el, depth) {
    var ordered = isTag(el, 'ol');
    var lines = [];
    var index = 1;
    elements(el).forEach(function (li) {
      if (!isTag(li, 'li')) return;
      var box = li.querySelector('input[type="checkbox"]');
      var clone = li.cloneNode(true);
      Array.prototype.forEach.call(clone.querySelectorAll('input[type="checkbox"]'), function (n) {
        n.parentNode.removeChild(n);
      });
      // 任务项的正文在 md.js 渲染时被 <del> 包住，序列化时剥掉，避免每轮往返多一层删除线
      if (box) {
        Array.prototype.forEach.call(clone.querySelectorAll('del'), function (d) {
          while (d.firstChild) d.parentNode.insertBefore(d.firstChild, d);
          d.parentNode.removeChild(d);
        });
      }
      // md.js 的列表渲染是平铺的（不支持嵌套），嵌套列表也按同级展开，保证往返稳定
      var nested = [];
      elements(clone).forEach(function (child) {
        if (isTag(child, 'ul') || isTag(child, 'ol')) {
          nested.push(listMd(child, depth + 1));
          clone.removeChild(child);
        }
      });
      var content = inline(clone).trim().replace(/\n/g, '\n' + '  ');
      var indent = depth > 0 ? '  ' : '';
      var marker;
      if (box) marker = box.checked ? '- [x] ' : '- [ ] ';
      else if (ordered) marker = (index++) + '. ';
      else marker = '- ';
      lines.push(indent + marker + content);
      nested.forEach(function (block) { if (block) lines.push(block); });
    });
    return lines.join('\n');
  }

  function alignOf(cell) {
    var cls = String(cell.getAttribute('class') || '');
    if (/\bmd-al-center\b/.test(cls)) return 'center';
    if (/\bmd-al-right\b/.test(cls)) return 'right';
    var style = String(cell.getAttribute('style') || '');
    if (/text-align:\s*center/i.test(style)) return 'center';
    if (/text-align:\s*right/i.test(style)) return 'right';
    return '';
  }

  function sepCell(align) {
    if (align === 'center') return ':---:';
    if (align === 'right') return '---:';
    return '---';
  }

  function tableMd(el) {
    var rows = [];
    var aligns = [];
    Array.prototype.forEach.call(el.querySelectorAll('tr'), function (tr) {
      var cells = [];
      Array.prototype.forEach.call(tr.querySelectorAll('th,td'), function (cell) {
        var text = inline(cell).trim().replace(/\n+/g, ' ').replace(/\|/g, '\\|');
        cells.push(text);
        if (!aligns.length || aligns.length < cells.length) aligns.push(alignOf(cell));
      });
      if (cells.length) rows.push(cells);
    });
    if (!rows.length) return '';
    var width = 0;
    rows.forEach(function (row) { if (row.length > width) width = row.length; });
    rows.forEach(function (row) { while (row.length < width) row.push(''); });
    while (aligns.length < width) aligns.push('');
    var lines = [
      '| ' + rows[0].join(' | ') + ' |',
      '| ' + aligns.slice(0, width).map(sepCell).join(' | ') + ' |'
    ];
    for (var i = 1; i < rows.length; i += 1) lines.push('| ' + rows[i].join(' | ') + ' |');
    return lines.join('\n');
  }

  function blocks(node) {
    var out = [];
    Array.prototype.forEach.call((node && node.childNodes) || [], function (child) {
      if (child.nodeType === 3) {
        var text = String(child.nodeValue || '').replace(/\u00a0/g, ' ').trim();
        if (text) out.push(text);
        return;
      }
      if (child.nodeType !== 1) return;
      var tag = String(child.tagName).toLowerCase();
      if (tag === 'script' || tag === 'style') return;
      if (/^h[1-6]$/.test(tag)) {
        var level = Number(tag.slice(1));
        var heading = inline(child).trim();
        if (heading) out.push(new Array(level + 1).join('#') + ' ' + heading);
        return;
      }
      if (tag === 'p') {
        var para = inline(child).trim();
        if (para) out.push(para);
        return;
      }
      if (tag === 'div' || tag === 'section' || tag === 'article') {
        // 附件缺失占位（md.js 输出 div[data-att]）也要还原成占位符，否则丢图引用
        var refId = child.getAttribute('data-att') || '';
        if (/^[A-Za-z0-9_-]{1,80}$/.test(refId)) {
          out.push('![[att:' + refId + ']]');
          return;
        }
        if (hasBlockChild(child)) { out = out.concat(blocks(child)); return; }
        var own = inline(child).trim();
        if (own) out.push(own);
        return;
      }
      if (tag === 'ul' || tag === 'ol') {
        var list = listMd(child, 0);
        if (list) out.push(list);
        return;
      }
      if (tag === 'blockquote') {
        var quote = (hasBlockChild(child) ? blocks(child).join('\n') : inline(child).trim());
        if (quote) {
          out.push(quote.split('\n').map(function (line) { return '> ' + line; }).join('\n'));
        }
        return;
      }
      if (tag === 'pre') {
        out.push('```\n' + textOf(child).replace(/\n+$/, '') + '\n```');
        return;
      }
      if (tag === 'hr') { out.push('---'); return; }
      if (tag === 'table') {
        var table = tableMd(child);
        if (table) out.push(table);
        return;
      }
      if (tag === 'figure' || tag === 'img') {
        var image = imageMd(child);
        if (image) out.push(image);
        return;
      }
      if (tag === 'br') return;
      // 行内元素直接出现在块级位置（如刚加粗还没成段）：把元素本身当行内处理，
      // 否则 ** 会丢，只有文字被提出来
      var loose = inline({ childNodes: [child] }).trim();
      if (loose) out.push(loose);
    });
    return out;
  }

  // 入口：把编辑区 DOM 转成 Markdown 源码（块之间空一行）
  function fromNode(root) {
    if (!root) return '';
    var parts = blocks(root).filter(function (part) { return String(part).trim() !== ''; });
    return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  return { fromNode: fromNode, inline: inline, tableMd: tableMd, listMd: listMd };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = NN_HTML2MD;
