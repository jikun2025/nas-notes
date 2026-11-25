'use strict';

/* 轻签 Markdown 模块（零依赖）
 * - NN_MD.render(src, images)：Markdown 子集 → HTML。所有文本先整体转义，
 *   输出 HTML 不含任何原始 HTML；链接仅放行 http/https/mailto。
 * - NN_MD.text(src)：剥离 Markdown 语法，用于列表摘要与搜索。
 * - NN_MD.htmlToMarkdown(html, makeImage)：旧版 body_format=html 的正文迁移为
 *   Markdown 源码，旧内联图片经 makeImage 转为附件 + `![[att:<id>]]` 占位符。
 * 附件占位符格式：![[att:<id>]]，id 只允许 [A-Za-z0-9_-]{1,80}。
 */
var NN_MD = (function () {
  var ATT_REF_RE = /\s*!?\[\[att:([A-Za-z0-9_-]{1,80})\]\]/g;
  var ATT_HEAD_RE = /^\s*!?\[\[att:([A-Za-z0-9_-]{1,80})\]\]\s*$/;
  var LIST_RE = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+(.*)$/;
  var TASK_RE = /^([^\[\]]*)\[( |x|X)\]\s+(.*)$/;
  // 字号：正文存字面量 <span style="font-size:small|large|xlarge">文字</span>。
  // 渲染走「转义后定点恢复」：正文先整体转义（不会残留任何原始 HTML），
  // 再把白名单内的这段转义形态换成 <span class="fs-…">（样式在 style.css），
  // 其余 < > 保持转义原样显示，不放开任意 HTML。
  var FS_RE = /&lt;span style=&quot;font-size:(small|large|xlarge)&quot;&gt;(.*?)&lt;\/span&gt;/g;
  var FS_UNWRAP_RE = /^\s*<span style="font-size:(small|large|xlarge)">([^<]*)<\/span>\s*$/;
  var FS_STRIP_ALL_RE = /<span style="font-size:(?:small|large|xlarge)">([^<]*)<\/span>/g;
  // GFM 管道表格：表头行 + 分隔行（|---|:--:|--:|）+ 若干数据行。
  // 单列（| --- |）也合法，故重复组用 *；是否成表由「表头行含 |」把关。
  var TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function figureHTML(att) {
    var mime = /^image\/(jpeg|png|webp|gif)$/i.test(String(att.mime || ''))
      ? String(att.mime).toLowerCase() : 'image/jpeg';
    var data = String(att.data || '').replace(/[^A-Za-z0-9+/=]/g, '');
    if (!data) return '';
    var label = esc(att.name || '图片');
    // data-att 只在富文本编辑态有用：html2md.js 靠它把图片还原成 ![[att:id]] 占位符
    var attId = String(att.id || '');
    var attAttr = /^[A-Za-z0-9_-]{1,80}$/.test(attId) ? ' data-att="' + attId + '"' : '';
    return '<figure class="md-image"' + attAttr + '><img src="data:' + mime + ';base64,' + data +
      '" alt="' + label + '" data-preview-image="1"' + attAttr + '><figcaption>' + label + '</figcaption></figure>';
  }

  function safeHref(url) {
    var raw = String(url || '');
    if (/^https?:\/\//i.test(raw) || /^mailto:/i.test(raw)) return raw;
    return '#';
  }

  // ---------- 表格辅助 ----------
  function isTableStart(lines, idx) {
    return idx + 1 < lines.length &&
      lines[idx].indexOf('|') >= 0 && lines[idx].trim() !== '' &&
      TABLE_SEP_RE.test(lines[idx + 1]) && lines[idx + 1].indexOf('|') >= 0;
  }

  function splitRow(line) {
    var s = String(line).trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    var cells = [];
    var cur = '';
    for (var k = 0; k < s.length; k += 1) {
      var ch = s.charAt(k);
      if (ch === '\\' && k + 1 < s.length && s.charAt(k + 1) === '|') { cur += '\\|'; k += 1; continue; }
      if (ch === '|') { cells.push(cur); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur);
    return cells.map(function (c) { return c.trim(); });
  }

  function sepAligns(sepLine) {
    return splitRow(sepLine).map(function (cell) {
      var s = cell.trim();
      var left = s.charAt(0) === ':';
      var right = s.charAt(s.length - 1) === ':';
      if (left && right) return 'center';
      if (right) return 'right';
      if (left) return 'left';
      return '';
    });
  }

  function alignAttr(align) {
    return (align === 'center' || align === 'right') ? ' class="md-al-' + align + '"' : '';
  }

  function rowLine(cells) {
    return '|' + cells.join('|') + '|';
  }

  // 重建行时统一补齐空格，避免出现 "|||" 这种没法读的畸形行
  function padRow(cells) {
    var parts = cells.map(function (cell) {
      return String(cell == null ? '' : cell).trim();
    });
    return '| ' + parts.join(' | ') + ' |';
  }

  // 生成插入用表格源码（cols 列、rows 条数据行）
  function insertTableMarkdown(rows, cols) {
    var n = Math.max(1, Math.min(20, Math.round(Number(cols) || 3)));
    var m = Math.max(0, Math.min(50, Math.round(Number(rows) === 0 ? 0 : (rows == null || isNaN(Number(rows)) ? 2 : Number(rows)))));
    var header = [];
    var sep = [];
    for (var c = 0; c < n; c += 1) { header.push(' 列' + (c + 1) + ' '); sep.push(' --- '); }
    var out = [rowLine(header), rowLine(sep)];
    for (var r = 0; r < m; r += 1) {
      var blank = [];
      for (var k = 0; k < n; k += 1) blank.push('  ');
      out.push(rowLine(blank));
    }
    return out.join('\n');
  }

  // 找到包含 caretLine 的表格块（表头 start、分隔行 sep、末行 end），不在表内返回 null
  function findTableBlock(lines, caretLine) {
    for (var h = Math.min(caretLine, lines.length - 2); h >= 0; h -= 1) {
      if (!isTableStart(lines, h)) continue;
      var end = h + 1;
      while (end + 1 < lines.length && lines[end + 1].indexOf('|') >= 0 && lines[end + 1].trim()) end += 1;
      if (caretLine >= h && caretLine <= end) return { start: h, sep: h + 1, end: end };
    }
    return null;
  }

  // 光标在某行内的列号（按未转义 | 计数）
  function cellIndexAt(line, caretCol) {
    var idx = 0;
    for (var i = 0; i < line.length && i < caretCol; i += 1) {
      if (line.charAt(i) === '\\') { i += 1; continue; }
      if (line.charAt(i) === '|') idx += 1;
    }
    return Math.max(0, idx);
  }

  // 表格增删行列（工具栏按钮调用）。op: row-add|row-del|col-add|col-del
  // 光标定位当前表/行/列；返回 {ok, text, reason}
  function tableOp(src, offset, op) {
    var text = String(src == null ? '' : src);
    var safeOffset = Math.max(0, Math.min(text.length, Number(offset) || 0));
    var before = text.slice(0, safeOffset);
    var caretLine = (before.match(/\n/g) || []).length;
    var lineStart = before.lastIndexOf('\n') + 1;
    var lines = text.split('\n');
    var blk = findTableBlock(lines, caretLine);
    if (!blk) return { ok: false, reason: '光标不在表格内（先用「表格」插入，或把光标放到表格行上）' };
    var start = blk.start, sep = blk.sep, end = blk.end;
    var ncols = splitRow(lines[start]).length;
    var colAt = Math.max(0, Math.min(ncols - 1, cellIndexAt(lines[caretLine], safeOffset - lineStart)));
    var out = lines.slice();
    var r;
    if (op === 'col-add') {
      var insAt = colAt + 1;
      for (r = start; r <= end; r += 1) {
        var cellsA = splitRow(out[r]);
        while (cellsA.length < ncols) cellsA.push('');
        cellsA.splice(insAt, 0, r === sep ? '---' : '');
        out[r] = padRow(cellsA);
      }
    } else if (op === 'col-del') {
      if (ncols <= 1) {
        out.splice(start, end - start + 1); // 仅剩一列：删整表
      } else {
        for (r = start; r <= end; r += 1) {
          var cellsD = splitRow(out[r]);
          while (cellsD.length < ncols) cellsD.push('');
          cellsD.splice(colAt, 1);
          out[r] = padRow(cellsD);
        }
      }
    } else if (op === 'row-add') {
      var blank = [];
      for (var c = 0; c < ncols; c += 1) blank.push('');
      out.splice(end + 1, 0, padRow(blank));
    } else if (op === 'row-del') {
      if (caretLine === start || caretLine === sep) {
        // 光标在表头/分隔行：删最后一条数据行；没有数据行则删整表
        if (end > sep) out.splice(end, 1); else out.splice(start, end - start + 1);
      } else {
        out.splice(caretLine, 1);
      }
    } else {
      return { ok: false, reason: 'unknown op: ' + op };
    }
    return { ok: true, text: out.join('\n') };
  }

  // 字号包裹/取消（fs: small|large|xlarge）。对 [start,end) 选区：
  // 已整体是该字号的 span → 取消；否则包一层。返回 {text, start, end}（新选区）
  function fsWrap(src, start, end, size) {
    var text = String(src == null ? '' : src);
    var s = Math.max(0, Math.min(text.length, Number(start) || 0));
    var e = Math.max(s, Math.min(text.length, Number(end) || s));
    if (!/^(small|large|xlarge)$/.test(String(size))) return { text: text, start: s, end: e };
    var sel = text.slice(s, e);
    var unwrap = FS_UNWRAP_RE.exec(sel);
    if (unwrap && unwrap[1] === size) {
      // 选区整体已是该字号 → 取消
      var inner = unwrap[2];
      var next = text.slice(0, s) + inner + text.slice(e);
      return { text: next, start: s, end: s + inner.length };
    }
    if (unwrap) sel = unwrap[2]; // 不同字号切换：先剥旧壳
    // 选区恰在某 span 内部：把整段 span 外扩再取消（同字号切换）
    var around = sel === text.slice(s, e) ? fsSpanAround(text, s, e, size) : null;
    if (around) {
      var inner2 = text.slice(around.innerStart, around.innerEnd);
      var next2 = text.slice(0, around.start) + inner2 + text.slice(around.end);
      return { text: next2, start: around.start, end: around.start + inner2.length };
    }
    var content = sel || '文字';
    var openTag = '<span style="font-size:' + size + '">';
    var wrapped = openTag + content + '</span>';
    return { text: text.slice(0, s) + wrapped + text.slice(e), start: s + openTag.length, end: s + openTag.length + content.length };
  }

  // 若 [s,e) 完全落在某个 size 字号 span 的正文内，返回该 span 的边界
  function fsSpanAround(text, s, e, size) {
    var openTag = '<span style="font-size:' + size + '">';
    var closeTag = '</span>';
    var openIdx = text.lastIndexOf(openTag, Math.max(0, s));
    if (openIdx < 0) return null;
    var innerStart = openIdx + openTag.length;
    var closeIdx = text.indexOf(closeTag, Math.max(e, innerStart));
    if (closeIdx < innerStart) return null;
    // 正文中不应再出现同类开标签（避免嵌套混乱时误判）
    var nextOpen = text.indexOf(openTag, innerStart);
    if (nextOpen >= 0 && nextOpen < closeIdx) return null;
    if (innerStart > s || closeIdx < e) return null;
    return { start: openIdx, end: closeIdx + closeTag.length, innerStart: innerStart, innerEnd: closeIdx };
  }

  function inline(text) {
    var codes = [];
    // 行内代码优先抽取，避免其中的 * _ 等被误当作强调
    var out = String(text).replace(/`([^`\n]+)`/g, function (m, body) {
      codes.push('<code>' + esc(body) + '</code>');
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    // 先整体转义再做语法替换：语法字符（* _ [ ] ( ) ~ #）不在转义集内，
    // 转义只会把 & < > " ' 变成实体，之后产出的标签才是整段输出里唯一的 HTML。
    out = esc(out);
    out = out.replace(FS_RE, function (m, size, body) { return '<span class="fs-' + size + '">' + body + '</span>'; });
    out = out.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    out = out.replace(/___([^_\n]+)___/g, '<strong><em>$1</em></strong>');
    out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    out = out.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, function (m, label, url) {
      // url/label 此刻已整体转义过，safeHref 只做协议白名单，不再二次 esc
      return '<a href="' + safeHref(url) + '" target="_blank" rel="noopener noreferrer">' + (label || safeHref(url)) + '</a>';
    });
    out = out.replace(/\u0000(\d+)\u0000/g, function (m, idx) { return codes[Number(idx)] || ''; });
    return out;
  }

  function render(src, images) {
    var byId = new Map();
    (images || []).forEach(function (att) { if (att && att.id) byId.set(String(att.id), att); });
    var lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var attHead = ATT_HEAD_RE.exec(line);
      if (attHead) {
        var att = byId.get(attHead[1]);
        out.push(att ? figureHTML(att)
          : '<div class="md-missing-image" data-att="' + attHead[1] + '">（正文引用的图片附件缺失）</div>');
        i += 1;
        continue;
      }
      if (/^```(.*)$/.test(line)) {
        var buf = [];
        i += 1;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i += 1; }
        i += 1;
        out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }
      var heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        var level = heading[1].length;
        out.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>');
        i += 1;
        continue;
      }
      if (/^\s*([-*_])\s*(?:\1[\s]*){2,}$/.test(line) && line.trim().length >= 3) {
        out.push('<hr>');
        i += 1;
        continue;
      }
      if (/^\s*>/.test(line)) {
        var quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
        out.push('<blockquote>' + quote.map(function (q) { return inline(q); }).join('<br>') + '</blockquote>');
        continue;
      }
      if (isTableStart(lines, i)) {
        var header = splitRow(lines[i]);
        var aligns = sepAligns(lines[i + 1]);
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i += 1;
        }
        var th = header.map(function (cell, c) {
          return '<th' + alignAttr(aligns[c]) + '>' + inline(cell) + '</th>';
        }).join('');
        var tb = rows.map(function (cells) {
          return '<tr>' + header.map(function (_, c) {
            return '<td' + alignAttr(aligns[c]) + '>' + inline(cells[c] || '') + '</td>';
          }).join('') + '</tr>';
        }).join('');
        out.push('<table class="md-table"><thead><tr>' + th + '</tr></thead><tbody>' + tb + '</tbody></table>');
        continue;
      }
      if (LIST_RE.test(line)) {
        var items = [];
        var ordered = /^\s*\d/.test(line);
        while (i < lines.length && LIST_RE.test(lines[i])) {
          var itemMatch = LIST_RE.exec(lines[i]);
          var content = itemMatch[2];
          var task = TASK_RE.exec(content);
          if (task) {
            var checked = task[2] !== ' ';
            items.push('<li class="md-task"><input type="checkbox" disabled' + (checked ? ' checked' : '') + '>' +
              (checked ? '<del>' + inline(task[3]) + '</del>' : inline(task[3])) + '</li>');
          } else {
            items.push('<li>' + inline(content) + '</li>');
          }
          i += 1;
        }
        var tag = ordered ? 'ol' : 'ul';
        out.push('<' + tag + '>' + items.join('') + '</' + tag + '>');
        continue;
      }
      if (!line.trim()) { i += 1; continue; }
      var para = [];
      while (i < lines.length && lines[i].trim() && !ATT_HEAD_RE.test(lines[i]) && !LIST_RE.test(lines[i]) &&
        !/^\s*>/.test(lines[i]) && !/^(#{1,6})\s+/.test(lines[i]) && !/^```/.test(lines[i]) &&
        !isTableStart(lines, i)) {
        para.push(inline(lines[i]));
        i += 1;
      }
      out.push('<p>' + para.join('<br>') + '</p>');
    }
    return out.join('');
  }

  function text(src) {
    var raw = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    var lines = [];
    raw.split('\n').forEach(function (line) {
      if (ATT_HEAD_RE.test(line)) { lines.push('[图片]'); return; }
      // 表格分隔行（|---|:--:|）在摘要里没有意义，直接丢掉
      if (line.indexOf('|') >= 0 && TABLE_SEP_RE.test(line)) return;
      lines.push(line
        .replace(ATT_REF_RE, '[图片]')
        .replace(FS_STRIP_ALL_RE, '$1')
        .replace(/^```.*$/, '')
        .replace(/^#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[( |x|X)\]\s+)?/, function (m, box) { return box === 'x' || box === 'X' ? '[x] ' : '· '; })
        .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/___([^_]+)___/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/~~([^~]+)~~/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\|/g, ' ')
        .replace(/^\s*([-*_])\s*(?:\1[\s]*){2,}$/, '---'));
    });
    return lines.join('\n').replace(/\s+/g, ' ').trim();
  }

  function escapeRe(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // 旧版富文本 body（HTML）→ Markdown 源码。makeImage(item) 应把旧内联图片注册为附件、
  // 返回占位符 ![[att:<id>]]（失败返回 ''）。
  function htmlToMarkdown(html, makeImage) {
    var doc;
    try {
      doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    } catch (error) {
      return String(html || '').replace(/<[^>]*>/g, '');
    }
    var parts = [];

    function renderInline(node) {
      var buf = [];
      Array.prototype.forEach.call(node.childNodes, function (child) {
        if (child.nodeType === 3) { buf.push(child.nodeValue || ''); return; }
        if (child.nodeType !== 1) return;
        var tag = child.tagName.toLowerCase();
        if (['b', 'strong'].includes(tag)) {
          var b = renderInline(child).trim();
          if (b) buf.push('**' + b + '**');
        } else if (['i', 'em'].includes(tag)) {
          var e = renderInline(child).trim();
          if (e) buf.push('*' + e + '*');
        } else if (['u'].includes(tag)) {
          buf.push(renderInline(child));
        } else if (['del', 's', 'strike'].includes(tag)) {
          var d = renderInline(child).trim();
          if (d) buf.push('~~' + d + '~~');
        } else if (['code'].includes(tag)) {
          var c = (child.textContent || '');
          if (c) buf.push('`' + c.replace(/`/g, '') + '`');
        } else if (['a'].includes(tag)) {
          var href = child.getAttribute('href') || '';
          var label = renderInline(child).trim();
          buf.push('[' + (label || href) + '](' + safeHref(href) + ')');
        } else if (['br'].includes(tag)) {
          buf.push('\n');
        } else {
          buf.push(renderInline(child));
        }
      });
      return buf.join('');
    }

    function walk(node) {
      Array.prototype.forEach.call(node.childNodes, function (child) {
        if (child.nodeType === 3) {
          var t = (child.nodeValue || '').trim();
          if (t) parts.push(t);
          return;
        }
        if (child.nodeType !== 1) return;
        var tag = child.tagName.toLowerCase();
        if (['script', 'style'].includes(tag)) return;
        if (tag === 'figure' && child.classList.contains('inline-image')) {
          var img = child.querySelector('img');
          var src = img ? (img.getAttribute('src') || '') : '';
          var caption = child.querySelector('figcaption');
          var name = (caption && caption.textContent) || (img && img.getAttribute('alt')) || '图片';
          if (makeImage && src) {
            var placeholder = makeImage({ src: src, name: name });
            if (placeholder) parts.push(placeholder);
          }
          return;
        }
        if (tag === 'img') {
          var src2 = child.getAttribute('src') || '';
          if (makeImage && src2) {
            var ph = makeImage({ src: src2, name: child.getAttribute('alt') || '图片' });
            if (ph) parts.push(ph);
          }
          return;
        }
        var heading = /^h([1-6])$/.exec(tag);
        if (heading) {
          parts.push('#'.repeat(Number(heading[1])) + ' ' + renderInline(child).trim());
          return;
        }
        if (tag === 'blockquote') {
          var quoted = renderInline(child).trim().split('\n').map(function (l) { return '> ' + l; });
          parts.push(quoted.join('\n'));
          return;
        }
        if (tag === 'pre') {
          parts.push('```\n' + (child.textContent || '') + '\n```');
          return;
        }
        if (tag === 'hr') { parts.push('---'); return; }
        if (tag === 'ul' || tag === 'ol') {
          var idx = 1;
          Array.prototype.forEach.call(child.children, function (li) {
            if (li.tagName.toLowerCase() !== 'li') return;
            var content = renderInline(li).trim();
            var marker = tag === 'ol' ? (idx++ + '. ') : '- ';
            parts.push(marker + content);
          });
          return;
        }
        if (tag === 'br') { return; }
        if (['div', 'p', 'section', 'article'].includes(tag)) {
          var own = renderInline(child).trim();
          // 只保留叶子内容；嵌套块交给下一层 walk，避免重复
          var hasBlockChild = Array.prototype.some.call(child.children, function (el) {
            var t2 = el.tagName.toLowerCase();
            return ['div', 'p', 'ul', 'ol', 'blockquote', 'pre', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr'].includes(t2);
          });
          if (!hasBlockChild) { if (own) parts.push(own); }
          walk(child);
          return;
        }
        // span/b/i 等出现在块级位置：按行内处理
        var inlineOut = renderInline(child).trim();
        if (inlineOut) parts.push(inlineOut);
      });
    }

    walk(doc.body || doc.documentElement);
    // 图片占位符行保持独立；文本间以空行分隔
    return parts.filter(function (p) { return p !== ''; }).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function stripImagePlaceholders(src) {
    return String(src == null ? '' : src).replace(ATT_REF_RE, '');
  }

  function extractImageIds(src) {
    var ids = [];
    var re = new RegExp(escapeRe('[[att:(') + '[A-Za-z0-9_-]{1,80}' + escapeRe(')]'), 'g');
    var m;
    var scan = /!?\[\[att:([A-Za-z0-9_-]{1,80})\]\]/g;
    while ((m = scan.exec(String(src == null ? '' : src))) !== null) ids.push(m[1]);
    return ids;
  }

  return {
    ATT_REF_RE: ATT_REF_RE,
    render: render,
    text: text,
    htmlToMarkdown: htmlToMarkdown,
    stripImagePlaceholders: stripImagePlaceholders,
    extractImageIds: extractImageIds,
    figureHTML: figureHTML,
    esc: esc,
    insertTableMarkdown: insertTableMarkdown,
    tableOp: tableOp,
    fsWrap: fsWrap
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = NN_MD;
