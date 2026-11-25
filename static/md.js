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
    return '<figure class="md-image"><img src="data:' + mime + ';base64,' + data +
      '" alt="' + label + '" data-preview-image="1"><figcaption>' + label + '</figcaption></figure>';
  }

  function safeHref(url) {
    var raw = String(url || '');
    if (/^https?:\/\//i.test(raw) || /^mailto:/i.test(raw)) return raw;
    return '#';
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
          : '<div class="md-missing-image">（正文引用的图片附件缺失）</div>');
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
        !/^\s*>/.test(lines[i]) && !/^(#{1,6})\s+/.test(lines[i]) && !/^```/.test(lines[i])) {
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
      lines.push(line
        .replace(ATT_REF_RE, '[图片]')
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
    esc: esc
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = NN_MD;
