// SPDX-License-Identifier: GPL-3.0-only
// 阅读窗口与 UTF-8 边界工具。所有位置都是规范化 UTF-8 字节偏移；
// 这里不依赖屏幕宽度、字体、页码，也不修改正文。

export function isContinuationByte(value) {
  return (value & 0xC0) === 0x80;
}

export function clampOffset(bytes, offset) {
  if (!bytes || typeof bytes.length !== 'number') return 0;
  var value = Number(offset);
  if (!isFinite(value)) return 0;
  value = Math.floor(value);
  if (value < 0) return 0;
  if (value > bytes.length) return bytes.length;
  return value;
}

// 向前（向文件头方向）找到完整字符的起始字节。
export function snapToBoundary(bytes, offset) {
  var pos = clampOffset(bytes, offset);
  while (pos > 0 && pos < bytes.length && isContinuationByte(bytes[pos])) {
    pos--;
  }
  return pos;
}

export function isValidBoundary(bytes, offset) {
  if (!bytes || typeof offset !== 'number' || !isFinite(offset) ||
      Math.floor(offset) !== offset) return false;
  if (offset < 0 || offset > bytes.length) return false;
  if (offset === 0 || offset === bytes.length) return true;
  return !isContinuationByte(bytes[offset]);
}

export function nextBoundary(bytes, offset) {
  var pos = snapToBoundary(bytes, offset);
  if (pos >= bytes.length) return bytes.length;
  pos++;
  while (pos < bytes.length && isContinuationByte(bytes[pos])) pos++;
  return pos;
}

export function previousBoundary(bytes, offset) {
  var pos = clampOffset(bytes, offset);
  if (pos <= 0) return 0;
  pos--;
  while (pos > 0 && isContinuationByte(bytes[pos])) pos--;
  return pos;
}

// 在目标附近优先切在换行后；找不到合适换行时退回 UTF-8 字符边界。
// 返回的 end 永远是合法边界，且 start < end <= bytes.length。
export function safeChunkEnd(bytes, start, targetEnd) {
  var begin = snapToBoundary(bytes, start);
  var end = snapToBoundary(bytes, targetEnd);
  if (end <= begin) {
    end = nextBoundary(bytes, begin);
    return Math.min(end, bytes.length);
  }
  var minimum = begin + Math.max(1, Math.floor((end - begin) / 3));
  for (var i = end - 1; i >= minimum; i--) {
    if (bytes[i] === 10) return i + 1;
  }
  return end;
}

// 把一段已经读入内存的窗口切成有界块。返回的 offset 相对窗口起点。
export function splitWindowChunks(bytes, targetBytes, maxChunks) {
  var ranges = [];
  if (!bytes || bytes.length === 0 || maxChunks <= 0) return ranges;
  var target = Math.max(256, Math.floor(targetBytes || 4096));
  var pos = 0;
  while (pos < bytes.length && ranges.length < maxChunks) {
    var end = safeChunkEnd(bytes, pos, Math.min(bytes.length, pos + target));
    if (end <= pos) break;
    ranges.push({ offset: pos, length: end - pos });
    pos = end;
  }
  return ranges;
}

export function chapterIndexAt(chapters, offset) {
  if (!Array.isArray(chapters) || chapters.length === 0) return -1;
  var value = Number(offset);
  if (!isFinite(value)) value = 0;
  var found = 0;
  for (var i = 0; i < chapters.length; i++) {
    if (chapters[i].offset <= value) found = i;
    else break;
  }
  return found;
}
