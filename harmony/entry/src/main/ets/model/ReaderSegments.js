// SPDX-License-Identifier: GPL-3.0-only
// 手机阅读器的显示分段：把已读入的 UTF-8 字节目录窗口切成约 256 字节的小段。
// 位置始终是规范化 UTF-8 字节偏移；本模块不读文件、不依赖屏幕尺寸或字体，
// 也不把整本书放进内存。所有 offset 相对传入窗口的起点，由调用方加 base。

export var SEGMENT_TARGET_BYTES = 256;
var DEFAULT_MAX_SEGMENTS = 4096;

function isContinuationByte(value) {
  return (value & 0xC0) === 0x80;
}

// 向前（向窗口起点方向）吸附到完整字符的起始字节。
function snapStart(bytes, offset) {
  var pos = Math.floor(Number(offset));
  if (!isFinite(pos)) pos = 0;
  if (pos < 0) pos = 0;
  if (pos > bytes.length) pos = bytes.length;
  while (pos > 0 && pos < bytes.length &&
      isContinuationByte(bytes[pos])) {
    pos--;
  }
  return pos;
}

function nextCharBoundary(bytes, offset) {
  var pos = snapStart(bytes, offset);
  if (pos >= bytes.length) return bytes.length;
  pos++;
  while (pos < bytes.length && isContinuationByte(bytes[pos])) pos++;
  return pos;
}

// 返回以 i 结尾的句末标点长度：。！？；… 以及常见 ASCII 标点。
// 返回值只用于确认“这里可以断”，不会跨字符切字节。
function sentenceEndSize(bytes, i) {
  var b = bytes[i];
  if (b === 0x82) {
    return i >= 2 && bytes[i - 2] === 0xE3 && bytes[i - 1] === 0x80 ? 3 : 0;
  }
  if (b === 0x81 || b === 0x9F || b === 0x9B) {
    return i >= 2 && bytes[i - 2] === 0xEF &&
      bytes[i - 1] === 0xBC ? 3 : 0;
  }
  if (b === 0xA6) {
    return i >= 2 && bytes[i - 2] === 0xE2 && bytes[i - 1] === 0x80 ? 3 : 0;
  }
  if (b === 0x2E || b === 0x21 || b === 0x3F || b === 0x3B) return 1;
  return 0;
}

// 不要把 CRLF 拆到两段；宁可多带一个字节。
function avoidCrLfSplit(bytes, end) {
  if (end > 0 && end < bytes.length &&
      bytes[end - 1] === 0x0D && bytes[end] === 0x0A) {
    return end + 1;
  }
  return end;
}

// 单段终点：优先换行后，其次句末标点后，再次空格后，最后才是安全字符边界。
// 回看范围固定为半段，整体仍是线性；只在字符边界外最多多取几个字节。
function segmentEnd(bytes, start, target) {
  var limit = Math.min(bytes.length, start + target);
  var minimum = start + Math.max(1, Math.floor((limit - start) / 2));
  var i;
  var size;
  for (i = limit - 1; i >= minimum; i--) {
    if (bytes[i] === 0x0A) return avoidCrLfSplit(bytes, i + 1);
  }
  for (i = limit - 1; i >= minimum; i--) {
    size = sentenceEndSize(bytes, i);
    if (size > 0) return i + 1;
  }
  for (i = limit - 1; i >= minimum; i--) {
    if (bytes[i] === 0x20) return i + 1;
  }
  var end = nextCharBoundary(bytes, limit);
  if (end <= start) end = nextCharBoundary(bytes, start);
  if (end <= start) end = Math.min(bytes.length, start + 1);
  return avoidCrLfSplit(bytes, end);
}

function decodeUtf8(bytes, start, end) {
  var result = '';
  var i = start;
  while (i < end) {
    var b0 = bytes[i];
    var cp = 0xFFFD;
    var size = 1;
    if (b0 < 0x80) {
      cp = b0;
    } else if (b0 >= 0xC2 && b0 <= 0xDF &&
        i + 1 < end && isContinuationByte(bytes[i + 1])) {
      cp = ((b0 & 0x1F) << 6) | (bytes[i + 1] & 0x3F);
      size = 2;
    } else if (b0 >= 0xE0 && b0 <= 0xEF && i + 2 < end &&
        isContinuationByte(bytes[i + 1]) &&
        isContinuationByte(bytes[i + 2])) {
      cp = ((b0 & 0x0F) << 12) |
        ((bytes[i + 1] & 0x3F) << 6) |
        (bytes[i + 2] & 0x3F);
      if (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
      size = 3;
    } else if (b0 >= 0xF0 && b0 <= 0xF4 && i + 3 < end &&
        isContinuationByte(bytes[i + 1]) &&
        isContinuationByte(bytes[i + 2]) &&
        isContinuationByte(bytes[i + 3])) {
      cp = ((b0 & 0x07) << 18) |
        ((bytes[i + 1] & 0x3F) << 12) |
        ((bytes[i + 2] & 0x3F) << 6) |
        (bytes[i + 3] & 0x3F);
      if (cp < 0x10000 || cp > 0x10FFFF) cp = 0xFFFD;
      size = 4;
    }
    if (cp > 0xFFFF) {
      var rest = cp - 0x10000;
      result += String.fromCharCode(0xD800 + (rest >> 10),
        0xDC00 + (rest & 0x3FF));
    } else {
      result += String.fromCharCode(cp);
    }
    i += size;
  }
  return result;
}

// 把窗口切成小段；返回 [{offset, length, text}]，offset 相对窗口起点。
// maxSegments 是硬上限，保证调用方一次最多渲染有界数量的 ListItem。
export function splitWindowSegments(bytes, targetBytes, maxSegments) {
  var segments = [];
  if (!bytes || typeof bytes.length !== 'number' || bytes.length === 0) {
    return segments;
  }
  var target = Math.max(32,
    Math.floor(Number(targetBytes) || SEGMENT_TARGET_BYTES));
  var limit = Math.max(1,
    Math.floor(Number(maxSegments) || DEFAULT_MAX_SEGMENTS));
  var pos = 0;
  while (pos < bytes.length && segments.length < limit) {
    var end = segmentEnd(bytes, pos, target);
    if (end <= pos) break;
    if (end > bytes.length) end = bytes.length;
    segments.push({
      offset: pos,
      length: end - pos,
      text: decodeUtf8(bytes, pos, end)
    });
    pos = end;
  }
  return segments;
}

// 二分查找 offset 落在（或最接近）哪一段；用于回读进度、跳章和重排后定位。
// 返回 -1 表示没有可用分段；offset 在首段之前取 0，在末尾之后取最后一段。
export function segmentIndexForOffset(segments, offset) {
  if (!Array.isArray(segments) || segments.length === 0) return -1;
  var value = Number(offset);
  if (!isFinite(value)) value = 0;
  value = Math.floor(value);
  var low = 0;
  var high = segments.length - 1;
  var found = 0;
  while (low <= high) {
    var mid = (low + high) >> 1;
    var segment = segments[mid];
    var start = Number(segment.offset);
    var end = start + Number(segment.length);
    if (value < start) {
      high = mid - 1;
    } else {
      found = mid;
      if (value < end) return mid;
      low = mid + 1;
    }
  }
  return found;
}

// 已加载分段的字节跨度，用于“继续加载”的总量上限。
export function loadedSegmentBytes(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return 0;
  var first = segments[0];
  var last = segments[segments.length - 1];
  return Number(last.offset) + Number(last.length) - Number(first.offset);
}
