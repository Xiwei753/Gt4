// SPDX-License-Identifier: GPL-3.0-only
// TXT 章节识别：格式校验 → 形态校验 → 目录过滤 → 序号对齐。
//
// 这是手机导入、Android 导入和构建期 Python 脚本共用的规则蓝本。所有
// offset/length 都是规范化 UTF-8 字节偏移，绝不能用 JS 字符下标代替。
// 识别不到可靠标题时返回单章「正文」；任何情况下都不修改正文。

export var MAX_CHAPTER_TITLE_CHARS = 80;
export var MAX_CHAPTER_LINE_CHARS = 80;
export var TOC_RUN_MIN = 4;

var DIGITS = '0123456789０１２３４５６７８９';
var CHINESE_DIGITS = '零〇○一二三四五六七八九两壹贰叁肆伍陆柒捌玖';
var CHINESE_UNITS = '十拾百佰千仟万萬亿億';
var NUMBER_CHARS = DIGITS + CHINESE_DIGITS + CHINESE_UNITS;
var CHAPTER_UNITS = '章节回集话幕';
var VOLUME_UNITS = '卷部篇';
var SPECIAL_NAMES = [
  '大结局', '完本感言', '作者的话', '序章', '序言', '序幕',
  '楔子', '引子', '前言', '后记', '尾声', '终章', '终篇', '后序',
  '番外篇', '番外', '外传'
];
var BRACKET_PAIRS = [
  ['【', '】'], ['[', ']'], ['{', '}'], ['（', '）'], ['(', ')'],
  ['《', '》'], ['〈', '〉'], ['「', '」'], ['『', '』'],
  ['“', '”'], ['‘', '’']
];
var LEADING_DECOR = '★☆◆◇●○◎■□▲△▼▽※#=~_—－-·';
var OPEN_BRACKETS = '【[{(（《〈「『“‘';
var CLOSE_BRACKETS = '】]})）〉》」』”’';
var STRICT_SENTENCE_ENDINGS = '。；;…‥';
var TRAILING_ONLY_ENDINGS = '！？!?';
var FORBIDDEN_TITLE_PREFIX = '的着吧呢吗啊嘛哦呀';
var PUNCTUATION_PREFIX = '，。、；：！？…‥—～·';
var SITE_HINTS = ['www.', '.com', '.net', '.org', '小说', '文学', '书城',
  '阅读', '起点', '纵横', '17k', '百度', '贴吧', '全文', 'txt'];

function codePointLength(text) {
  var count = 0;
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
      var next = text.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) i++;
    }
    count++;
  }
  return count;
}

export function utf8ByteLength(text) {
  var total = 0;
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code < 0x80) {
      total += 1;
    } else if (code < 0x800) {
      total += 2;
    } else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
      var next = text.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        total += 4;
        i++;
      } else {
        total += 3;
      }
    } else {
      total += 3;
    }
  }
  return total;
}

function stripOuterBrackets(text) {
  var result = text;
  var changed = true;
  while (changed && result.length >= 2) {
    changed = false;
    var first = result.charAt(0);
    var last = result.charAt(result.length - 1);
    for (var i = 0; i < BRACKET_PAIRS.length; i++) {
      if (first === BRACKET_PAIRS[i][0] && last === BRACKET_PAIRS[i][1]) {
        result = result.substring(1, result.length - 1).trim();
        changed = true;
        break;
      }
    }
  }
  return result;
}

function stripLeadingDecorations(text) {
  var result = text;
  var changed = true;
  while (changed && result.length > 0) {
    changed = false;
    var ch = result.charAt(0);
    if (ch === ' ' || ch === '\t' || ch === '\u3000' ||
        LEADING_DECOR.indexOf(ch) >= 0) {
      result = result.substring(1).trim();
      changed = true;
    }
  }
  return result;
}

function stripTrailingDecorations(text) {
  var result = text;
  var changed = true;
  while (changed && result.length > 0) {
    changed = false;
    var ch = result.charAt(result.length - 1);
    if (ch === ' ' || ch === '\t' || ch === '\u3000' ||
        LEADING_DECOR.indexOf(ch) >= 0) {
      result = result.substring(0, result.length - 1).trim();
      changed = true;
    }
  }
  return result;
}

function stripLooseBrackets(text) {
  var result = text;
  while (result.length > 0 && OPEN_BRACKETS.indexOf(result.charAt(0)) >= 0) {
    result = result.substring(1).trim();
  }
  while (result.length > 0 &&
         CLOSE_BRACKETS.indexOf(result.charAt(result.length - 1)) >= 0) {
    result = result.substring(0, result.length - 1).trim();
  }
  return result;
}

function stripTitleBrackets(text) {
  var result = text;
  while (result.length > 0 && CLOSE_BRACKETS.indexOf(result.charAt(0)) >= 0) {
    result = result.substring(1).trim();
  }
  while (result.length > 0 &&
         OPEN_BRACKETS.indexOf(result.charAt(result.length - 1)) >= 0) {
    result = result.substring(0, result.length - 1).trim();
  }
  return result;
}

function normalizeHeading(text) {
  return stripLooseBrackets(stripTrailingDecorations(
    stripLeadingDecorations(stripOuterBrackets(text.trim()))));
}

function isNumberChar(ch) {
  return NUMBER_CHARS.indexOf(ch) >= 0;
}

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\u3000';
}

function isSeparator(ch) {
  return isSpace(ch) || ch === ':' || ch === '：' || ch === '.' ||
    ch === '．' || ch === '·' || ch === '-' || ch === '—' ||
    ch === '－' || ch === '_' || ch === '、';
}

function parseChineseNumber(raw) {
  if (!raw) return -1;
  var allArabic = true;
  for (var a = 0; a < raw.length; a++) {
    if (DIGITS.indexOf(raw.charAt(a)) < 0) {
      allArabic = false;
      break;
    }
  }
  if (allArabic) {
    var digits = '';
    for (var b = 0; b < raw.length; b++) {
      var idx = DIGITS.indexOf(raw.charAt(b));
      digits += String(idx % 10);
    }
    var arabic = parseInt(digits, 10);
    return isNaN(arabic) ? -1 : arabic;
  }

  var digitMap = {
    '零': 0, '〇': 0, '○': 0, '一': 1, '二': 2, '三': 3, '四': 4,
    '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '两': 2,
    '壹': 1, '贰': 2, '叁': 3, '肆': 4, '伍': 5, '陆': 6,
    '柒': 7, '捌': 8, '玖': 9
  };
  var total = 0;
  var section = 0;
  var number = 0;
  var seen = false;
  for (var i = 0; i < raw.length; i++) {
    var ch = raw.charAt(i);
    if (Object.prototype.hasOwnProperty.call(digitMap, ch)) {
      number = digitMap[ch];
      seen = true;
      continue;
    }
    var unit = CHINESE_UNITS.indexOf(ch);
    if (unit < 0) return -1;
    seen = true;
    if (unit <= 1) {
      if (number === 0) number = 1;
      section += number * 10;
    } else if (unit <= 3) {
      if (number === 0) number = 1;
      section += number * 100;
    } else if (unit <= 5) {
      if (number === 0) number = 1;
      section += number * 1000;
    } else if (unit <= 7) {
      if (number === 0) number = 1;
      section = (section + number) * 10000;
      total += section;
      section = 0;
    } else {
      if (number === 0) number = 1;
      section = (section + number) * 100000000;
      total += section;
      section = 0;
    }
    number = 0;
  }
  if (!seen) return -1;
  return total + section + number;
}

function parseSpecialCore(core) {
  var best = '';
  for (var i = 0; i < SPECIAL_NAMES.length; i++) {
    var name = SPECIAL_NAMES[i];
    if (core.indexOf(name) === 0 && name.length > best.length) best = name;
  }
  if (!best) return null;
  var rest = core.substring(best.length);
  if (rest && !isSpace(rest.charAt(0)) && !isSeparator(rest.charAt(0)) &&
      !isNumberChar(rest.charAt(0)) &&
      best !== '番外' && best !== '番外篇' && best !== '外传') {
    return null;
  }
  var number = 0;
  var numbered = false;
  var digits = '';
  var j = 0;
  while (j < rest.length && isSpace(rest.charAt(j))) j++;
  while (j < rest.length && isNumberChar(rest.charAt(j))) {
    digits += rest.charAt(j);
    j++;
  }
  if (digits.length > 0) {
    number = parseChineseNumber(digits);
    if (number < 0) return null;
    numbered = true;
  }
  while (j < rest.length && isSeparator(rest.charAt(j))) j++;
  var title = stripTitleBrackets(rest.substring(j).trim());
  return {
    title: (best + (digits.length > 0 ? digits : '') +
      (title.length > 0 ? ' ' + title : '')).trim(),
    rawTitle: title,
    kind: 'special',
    number: number,
    numbered: numbered
  };
}

function parseNumberedCore(core) {
  if (core.charAt(0) !== '第') return null;
  var i = 1;
  while (i < core.length && isSpace(core.charAt(i))) i++;
  var start = i;
  while (i < core.length && isNumberChar(core.charAt(i))) i++;
  if (i === start) return null;
  var rawNumber = core.substring(start, i);
  while (i < core.length && isSpace(core.charAt(i))) i++;
  if (i >= core.length) return null;
  var unit = core.charAt(i);
  if (CHAPTER_UNITS.indexOf(unit) < 0 && VOLUME_UNITS.indexOf(unit) < 0) {
    return null;
  }
  i++;
  while (i < core.length && isSeparator(core.charAt(i))) i++;
  var title = stripTitleBrackets(core.substring(i).trim());
  var number = parseChineseNumber(rawNumber);
  if (number < 0) return null;
  return {
    title: ('第' + rawNumber + unit +
      (title.length > 0 ? ' ' + title : '')).trim(),
    rawTitle: title,
    kind: VOLUME_UNITS.indexOf(unit) >= 0 ? 'volume' : 'chapter',
    number: number,
    numbered: true
  };
}

function parseEnglishCore(core) {
  var lower = core.toLowerCase();
  var special = '';
  if (lower.indexOf('prologue') === 0) special = 'Prologue';
  else if (lower.indexOf('epilogue') === 0) special = 'Epilogue';
  if (special) {
    var rest = core.substring(special.length);
    if (rest.length > 0 && !isSeparator(rest.charAt(0))) return null;
    var title = stripTitleBrackets(
      rest.replace(/^[\s:：.．·\-—－_]+/, '').trim());
    return {
      title: (special + (title.length > 0 ? ' ' + title : '')).trim(),
      rawTitle: title,
      kind: 'special',
      number: 0,
      numbered: false
    };
  }
  if (lower.indexOf('chapter') !== 0) return null;
  var pos = 7;
  if (pos >= core.length || !isSpace(core.charAt(pos))) return null;
  while (pos < core.length && isSpace(core.charAt(pos))) pos++;
  var numStart = pos;
  while (pos < core.length && /[0-9]/.test(core.charAt(pos))) pos++;
  if (pos === numStart) {
    while (pos < core.length && /[IVXLCDMivxlcdm]/.test(core.charAt(pos))) pos++;
  }
  if (pos === numStart) return null;
  var rawNumber = core.substring(numStart, pos);
  while (pos < core.length && isSeparator(core.charAt(pos))) pos++;
  var title = stripTitleBrackets(core.substring(pos).trim());
  var number = /^[0-9]+$/.test(rawNumber) ? parseInt(rawNumber, 10) : 0;
  return {
    title: ('Chapter ' + rawNumber +
      (title.length > 0 ? ' ' + title : '')).trim(),
    rawTitle: title,
    kind: 'chapter',
    number: number,
    numbered: number > 0
  };
}

function parseHeadingCore(core) {
  var parsed = parseNumberedCore(core);
  if (parsed) return parsed;
  parsed = parseEnglishCore(core);
  if (parsed) return parsed;
  return parseSpecialCore(core);
}

function looksLikeSitePrefix(prefix) {
  var text = prefix.trim();
  if (!text || codePointLength(text) > 30) return false;
  if (STRICT_SENTENCE_ENDINGS.indexOf(text.charAt(text.length - 1)) >= 0) {
    return false;
  }
  var lower = text.toLowerCase();
  for (var i = 0; i < SITE_HINTS.length; i++) {
    if (lower.indexOf(SITE_HINTS[i]) >= 0) return true;
  }
  var last = text.charAt(text.length - 1);
  return (last === ':' || last === '：' || last === ']' || last === '】' ||
    last === ')' || last === '）' || last === '|' || last === '/') &&
    codePointLength(text) <= 16;
}

function parseHeading(line) {
  var trimmed = line.trim();
  if (!trimmed) return null;
  if (codePointLength(trimmed) > MAX_CHAPTER_LINE_CHARS) return null;

  var normalized = normalizeHeading(trimmed);
  if (!normalized) return null;
  if (codePointLength(normalized) > MAX_CHAPTER_LINE_CHARS) return null;

  var parsed = parseHeadingCore(normalized);
  if (!parsed) {
    // 下载站常在标题前加站名/“正文”等前缀。只接受短且明显像站点前缀的
    // 前缀，避免把正文中的“第…章”当成标题。
    for (var i = 1; i < normalized.length && i <= 32; i++) {
      if (normalized.charAt(i) !== '第' &&
          normalized.substr(i, 7).toLowerCase() !== 'chapter') continue;
      var prefix = normalized.substring(0, i);
      if (!looksLikeSitePrefix(prefix)) continue;
      var tail = normalizeHeading(normalized.substring(i));
      var siteParsed = parseHeadingCore(tail);
      if (siteParsed) {
        parsed = siteParsed;
        normalized = tail;
        break;
      }
    }
  }
  if (!parsed) return null;

  var rawTitle = parsed.rawTitle || '';
  if (rawTitle && codePointLength(rawTitle) >
      MAX_CHAPTER_TITLE_CHARS) return null;
  for (var e = 0; e < normalized.length; e++) {
    if (STRICT_SENTENCE_ENDINGS.indexOf(normalized.charAt(e)) >= 0) {
      return null;
    }
  }

  // 感叹号/问号允许出现在标题末尾，但不能出现在句子中间。
  for (var p = 0; p < normalized.length; p++) {
    if (TRAILING_ONLY_ENDINGS.indexOf(normalized.charAt(p)) >= 0) {
      var after = normalized.substring(p + 1);
      if (after.replace(/[！？!?\s]/g, '').length > 0) return null;
    }
  }

  var title = rawTitle;
  if (title.length > 0) {
    var first = title.charAt(0);
    if (FORBIDDEN_TITLE_PREFIX.indexOf(first) >= 0) return null;
    if (PUNCTUATION_PREFIX.indexOf(first) >= 0) return null;
  }

  // 正文里常见的“第123章 他走了，再也没有回来”没有句末标点，但
  // 逗号/顿号/分号说明它更像一句话。短标题仍允许“你好，世界”。
  if (title.length > 0 && codePointLength(title) > 6) {
    for (var q = 0; q < title.length; q++) {
      var ch = title.charAt(q);
      if (ch === '，' || ch === ',' || ch === '、' ||
          ch === '；' || ch === ';') return null;
    }
  }
  // 特殊标题（番外/序章/尾声等）保留原行内空格，避免
  // “番外 一”被改写成“番外一”；装饰和站点前缀仍已清理。
  if (parsed.kind === 'special') parsed.title = normalized;
  return parsed;
}

function splitLines(text) {
  var lines = [];
  var start = 0;
  var byteOffset = 0;
  for (var i = 0; i <= text.length; i++) {
    if (i < text.length && text.charCodeAt(i) !== 10) continue;
    var full = text.substring(start, i < text.length ? i + 1 : i);
    if (full.length > 0) {
      var content = full;
      if (content.charAt(content.length - 1) === '\n') {
        content = content.substring(0, content.length - 1);
      }
      if (content.charAt(content.length - 1) === '\r') {
        content = content.substring(0, content.length - 1);
      }
      lines.push({
        content: content,
        start: byteOffset,
        index: lines.length
      });
      byteOffset += utf8ByteLength(full);
    }
    start = i + 1;
    if (i === text.length) break;
  }
  return lines;
}

function isBlank(line) {
  return line.content.trim().length === 0;
}

function isTocMarker(line) {
  var text = line.content.replace(/[\s\u3000:：]/g, '').toLowerCase();
  return text === '目录' || text === '章节目录' || text === '章节列表' ||
    text === '目录章节' || text === '正文目录' || text === '作品目录' ||
    text === 'contents' || text === 'tableofcontents' || text === 'toc';
}

function contentLinesBetween(lines, leftIndex, rightIndex) {
  var count = 0;
  for (var i = leftIndex + 1; i < rightIndex; i++) {
    if (!isBlank(lines[i])) count++;
  }
  return count;
}

function normalizeTitleForMatch(title) {
  var text = title.toLowerCase();
  text = text.replace(/[\s\u3000【】\[\]{}（）()《》〈〉「」『』“”‘’]/g, '');
  text = text.replace(/[.．·…‥\-—－_]+$/g, '');
  text = text.replace(/[0-9０-９]+$/g, '');
  return text;
}

function denseFlags(candidates, lines) {
  var dense = [];
  for (var i = 0; i < candidates.length; i++) dense.push(false);
  for (var k = 0; k + 1 < candidates.length; k++) {
    dense[k] = contentLinesBetween(lines,
      candidates[k].lineIndex, candidates[k + 1].lineIndex) === 0;
  }
  return dense;
}

function dropToc(candidates, lines) {
  if (candidates.length < 2) return candidates;
  var dense = denseFlags(candidates, lines);
  var drop = [];
  for (var i = 0; i < candidates.length; i++) drop.push(false);

  // 连续 4 个以上候选之间没有正文行：典型目录区。最后一条候选后面
  // 没有可比对象，因此不会被这一段吃掉。
  var i = 0;
  while (i < candidates.length) {
    if (!dense[i]) {
      i++;
      continue;
    }
    var j = i;
    while (j < candidates.length && dense[j]) j++;
    if (j - i >= TOC_RUN_MIN) {
      for (var k = i; k < j; k++) drop[k] = true;
    }
    i = j;
  }

  // “目录/章节列表”标记后只有 2~3 条时，上面的阈值不够。若这些条目
  // 在后面又出现（同一标题或同一序号），则只把前面这一小段当目录。
  var markerIndex = -1;
  for (var m = 0; m < lines.length && m <= 200; m++) {
    if (isTocMarker(lines[m])) {
      markerIndex = m;
      break;
    }
  }
  if (markerIndex >= 0) {
    var first = -1;
    for (var c = 0; c < candidates.length; c++) {
      if (candidates[c].lineIndex > markerIndex) {
        first = c;
        break;
      }
    }
    if (first >= 0) {
      var end = first;
      while (end < candidates.length && dense[end]) end++;
      if (end - first >= 2 && end < candidates.length) {
        var laterTitles = [];
        for (var t = end; t < candidates.length; t++) {
          laterTitles.push(normalizeTitleForMatch(candidates[t].title));
        }
        var matched = 0;
        for (var u = first; u < end; u++) {
          var key = normalizeTitleForMatch(candidates[u].title);
          if (key && laterTitles.indexOf(key) >= 0) matched++;
        }
        if (matched >= 1) {
          for (var d = first; d < end; d++) drop[d] = true;
        }
      }
    }
  }

  var kept = [];
  for (var x = 0; x < candidates.length; x++) {
    if (!drop[x]) kept.push(candidates[x]);
  }
  return kept;
}

function alignSegment(segment) {
  var n = segment.length;
  if (n === 0) return [];
  var keep = [];
  for (var i = 0; i < n; i++) keep.push(false);
  var numbered = [];
  for (var s = 0; s < n; s++) {
    if (segment[s].kind === 'special' || segment[s].kind === 'volume' ||
        !segment[s].numbered) {
      keep[s] = true;
    } else {
      numbered.push(s);
    }
  }
  var size = numbered.length;
  if (size > 0) {
    var tails = [];
    var tailPos = [];
    var prev = [];
    for (var p = 0; p < size; p++) prev.push(-1);
    var length = 0;
    for (var q = 0; q < size; q++) {
      var value = segment[numbered[q]].number;
      var lo = 0;
      var hi = length;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (tails[mid] < value) lo = mid + 1;
        else hi = mid;
      }
      if (lo < length && tails[lo] === value) continue;
      if (lo === length) length++;
      tails[lo] = value;
      tailPos[lo] = q;
      prev[q] = lo > 0 ? tailPos[lo - 1] : -1;
    }
    if (length > 0) {
      for (var back = tailPos[length - 1]; back >= 0; back = prev[back]) {
        keep[numbered[back]] = true;
      }
    }
  }
  var out = [];
  for (var r = 0; r < n; r++) {
    if (keep[r]) out.push(segment[r]);
  }
  return out;
}

function alignByNumber(candidates) {
  if (candidates.length === 0) return candidates;
  var kept = [];
  var segmentStart = 0;
  for (var i = 0; i < candidates.length; i++) {
    var starts = false;
    if (i > segmentStart) {
      if (candidates[i].kind === 'volume') starts = true;
      else if (candidates[i].numbered && candidates[i].number === 1) starts = true;
    }
    if (!starts) continue;
    kept = kept.concat(alignSegment(candidates.slice(segmentStart, i)));
    kept.push(candidates[i]);
    segmentStart = i + 1;
  }
  return kept.concat(alignSegment(candidates.slice(segmentStart)));
}

export function detectTxtChapters(text, bytes) {
  var total = bytes && typeof bytes.length === 'number' ?
    bytes.length : utf8ByteLength(text);
  var lines = splitLines(text);
  var candidates = [];
  for (var i = 0; i < lines.length; i++) {
    var parsed = parseHeading(lines[i].content);
    if (!parsed) continue;
    candidates.push({
      title: parsed.title,
      offset: lines[i].start,
      lineIndex: lines[i].index,
      kind: parsed.kind,
      number: parsed.number,
      numbered: parsed.numbered
    });
  }
  if (candidates.length === 0) {
    return [{ title: '正文', offset: 0, length: total }];
  }
  var afterToc = dropToc(candidates, lines);
  var kept = alignByNumber(afterToc);
  if (kept.length === 0) {
    return [{ title: '正文', offset: 0, length: total }];
  }
  kept.sort(function (a, b) { return a.offset - b.offset; });
  var chapters = [];
  for (var c = 0; c < kept.length; c++) {
    var end = c + 1 < kept.length ? kept[c + 1].offset : total;
    if (end > kept[c].offset && kept[c].offset >= 0 && end <= total) {
      chapters.push({
        title: kept[c].title,
        offset: kept[c].offset,
        length: end - kept[c].offset
      });
    }
  }
  if (chapters.length === 0) {
    return [{ title: '正文', offset: 0, length: total }];
  }
  return chapters;
}
