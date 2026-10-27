// SPDX-License-Identifier: GPL-3.0-only
// 纯 JS UTF-8 解码（字节 → 字符串），ES5 语法。
// 非法序列替换为 U+FFFD，不抛异常；与 PageLayout 的
// 显示侧解码分离：本文件用于入库前的整体解码。
var REPLACEMENT = '�';

function decodeUtf8(bytes) {
  var out = '';
  var i = 0;
  var len = bytes.length;
  while (i < len) {
    var b0 = bytes[i];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
      continue;
    }
    var width = 0;
    var min = 0;
    if (b0 >= 0xc2 && b0 <= 0xdf) { width = 2; min = 0x80; }
    else if (b0 >= 0xe0 && b0 <= 0xef) { width = 3; min = 0x800; }
    else if (b0 >= 0xf0 && b0 <= 0xf4) { width = 4; min = 0x10000; }
    else {
      out += REPLACEMENT;
      i += 1;
      continue;
    }
    if (i + width > len) {
      out += REPLACEMENT;
      break;
    }
    var code = b0 & (width === 2 ? 0x1f : width === 3 ? 0x0f : 0x07);
    var valid = true;
    var j;
    for (j = 1; j < width; j++) {
      var b = bytes[i + j];
      if ((b & 0xc0) !== 0x80) { valid = false; break; }
      code = (code << 6) | (b & 0x3f);
    }
    if (!valid || code < min || code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)) {
      out += REPLACEMENT;
      i += 1;
      continue;
    }
    if (code <= 0xffff) {
      out += String.fromCharCode(code);
    } else {
      var pair = code - 0x10000;
      out += String.fromCharCode(0xd800 + (pair >> 10),
        0xdc00 + (pair & 1023));
    }
    i += width;
  }
  return out;
}

export function decodeUtf8Bytes(bytes) {
  return decodeUtf8(bytes);
}
