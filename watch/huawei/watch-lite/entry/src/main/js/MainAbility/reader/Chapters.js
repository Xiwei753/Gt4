// SPDX-License-Identifier: GPL-3.0-only
// 章节索引的轻量校验与完整目录列表。
// 偏移一律是规范化 UTF-8 正文字节偏移，不是 JS 字符下标，也不能由
// 字体/页码反推。旧书没有 chapters 时仍返回单一「正文」，不影响阅读。
var MAX_TITLE = 80;

function fallback(totalBytes) {
  var total = (typeof totalBytes === 'number' && totalBytes > 0) ?
    Math.floor(totalBytes) : 0;
  return [{ title: '正文', offset: 0, length: total }];
}

function cleanTitle(value, index) {
  var title = typeof value === 'string' ? value.trim() : '';
  if (!title) title = '第 ' + (index + 1) + ' 章';
  if (title.length > MAX_TITLE) title = title.slice(0, MAX_TITLE);
  return title;
}

// 只接受严格递增的非负字节起点；长度按相邻起点/文件尾重算，避免
// 手机端或旧版本传来的 length 与正文实际不一致。
export function normalizeChapters(raw, totalBytes) {
  var total = (typeof totalBytes === 'number' && totalBytes > 0) ?
    Math.floor(totalBytes) : 0;
  if (!Array.isArray(raw) || raw.length === 0) return fallback(total);
  var entries = [];
  for (var i = 0; i < raw.length; i++) {
    var item = raw[i];
    if (!item || typeof item !== 'object') continue;
    var offset = item.offset;
    if (typeof offset !== 'number' || !isFinite(offset) ||
      Math.floor(offset) !== offset || offset < 0) continue;
    if (total > 0 && offset >= total) continue;
    entries.push({ title: typeof item.title === 'string' ?
      item.title.trim() : '', offset: offset });
  }
  if (entries.length === 0) return fallback(total);
  entries.sort(function (a, b) { return a.offset - b.offset; });
  var unique = [];
  for (var j = 0; j < entries.length; j++) {
    if (unique.length > 0 &&
      unique[unique.length - 1].offset === entries[j].offset) continue;
    unique.push(entries[j]);
  }
  if (unique[0].offset > 0) {
    unique.unshift({ title: '正文', offset: 0 });
  }
  var out = [];
  for (var k = 0; k < unique.length; k++) {
    var start = unique[k].offset;
    var end = (k + 1 < unique.length) ? unique[k + 1].offset : total;
    if (end <= start && total > 0) continue;
    out.push({ title: cleanTitle(unique[k].title, k), offset: start,
      length: total > 0 ? end - start : 0 });
  }
  return out.length > 0 ? out : fallback(total);
}

export function chapterIndexAt(chapters, offset) {
  if (!Array.isArray(chapters) || chapters.length === 0) return -1;
  var pos = typeof offset === 'number' ? offset : 0;
  var found = -1;
  for (var i = 0; i < chapters.length; i++) {
    if (chapters[i].offset > pos) break;
    found = i;
  }
  return found;
}

// 章节面板把完整目录交给原生 list，由列表本身负责纵向滚动。
export function chapterListRows(chapters, current) {
  if (!Array.isArray(chapters) || chapters.length === 0) return [];
  var currentIndex = (typeof current === 'number') ? current : -1;
  var rows = [];
  for (var i = 0; i < chapters.length; i++) {
    rows.push({ index: i, title: chapters[i].title,
      current: i === currentIndex,
      label: (i === currentIndex ? '▶ ' : '') + chapters[i].title });
  }
  return rows;
}

export function chapterLabel(chapters, index) {
  if (!Array.isArray(chapters) || chapters.length === 0) return '';
  var i = (typeof index === 'number' && index >= 0) ? index : 0;
  if (i >= chapters.length) i = chapters.length - 1;
  return chapters[i].title;
}
