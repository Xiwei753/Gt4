// SPDX-License-Identifier: GPL-3.0-only
// 纯 JS base64 解码（Lite JS 运行时没有 atob），ES5 语法。
// 非法字符按 RFC 4648 忽略；长度不符时尾部截断处理。
var B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var B64_LOOKUP = new Array(256);
var i;
for (i = 0; i < 256; i++) B64_LOOKUP[i] = -1;
for (i = 0; i < B64_CHARS.length; i++) {
  B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;
}
B64_LOOKUP[61] = -2; // '=' padding

export function decodeBase64(input) {
  var s = String(input);
  var len = s.length;
  var bytes = [];
  var buffer = 0;
  var bits = 0;
  var i;
  for (i = 0; i < len; i++) {
    var code = s.charCodeAt(i);
    if (code > 255) continue;
    var value = B64_LOOKUP[code];
    if (value === -1) continue;   // 忽略非法字符
    if (value === -2) break;      // padding 结束
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  var out = new Uint8Array(bytes.length);
  for (i = 0; i < bytes.length; i++) out[i] = bytes[i];
  return out;
}
