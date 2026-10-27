// SPDX-License-Identifier: GPL-3.0-only
// 纯 JavaScript SHA-256：Lite Wearable JS 运行时没有加密 API，
// 手表接收书籍后必须能核验整本摘要。
// 兼容性：不使用 ES6+ 语法（Lite JS 老运行时可能没有
// Math.imul / codePointAt 等）；乘法提供 ES5 回退。
// 与 Node crypto 互验：tests/sha256.test.mjs。

var SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

var SHA256_H0 = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
];

var HEX = '0123456789abcdef';

function mul32(a, b) {
  if (typeof Math.imul === 'function') return Math.imul(a, b);
  // ES5 回退：(a*b) mod 2^32，分解为 16 位段避免精度丢失。
  var aHi = a >>> 16, aLo = a & 0xffff;
  var bHi = b >>> 16, bLo = b & 0xffff;
  var low = aLo * bLo;
  var mid = (aHi * bLo + aLo * bHi) & 0xffff;
  return ((low >>> 0) + (mid << 16)) >>> 0;
}

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

function toHex(word) {
  var s = '';
  for (var i = 7; i >= 0; i--) {
    s += HEX.charAt((word >>> (i * 4)) & 0xf);
  }
  return s;
}

export function sha256Bytes(bytes) {
  var hasher = createSha256();
  hasher.update(bytes);
  return hasher.digest();
}

// 流式 SHA-256：大文件按固定窗口分块喂入，
// 峰值内存只有单个窗口（施工单 P1-11）。
// 返回 { update(bytes), digest() }。
export function createSha256() {
  var h = SHA256_H0.slice();
  var block = new Uint8Array(64);
  var blockLen = 0;
  var totalLen = 0;
  var w = new Array(64);
  return {
    update: function (bytes) {
      var i = 0;
      totalLen += bytes.length;
      while (i < bytes.length) {
        var need = 64 - blockLen;
        var take = need < (bytes.length - i) ?
          need : (bytes.length - i);
        for (var j = 0; j < take; j++) {
          block[blockLen + j] = bytes[i + j];
        }
        blockLen += take;
        i += take;
        if (blockLen === 64) {
          compress(h, block, w);
          blockLen = 0;
        }
      }
    },
    digest: function () {
      var bitLenHi = Math.floor(totalLen / 0x20000000);
      var bitLenLo = (totalLen * 8) >>> 0;
      block[blockLen] = 0x80;
      blockLen += 1;
      if (blockLen > 56) {
        for (var p = blockLen; p < 64; p++) {
          block[p] = 0;
        }
        compress(h, block, w);
        blockLen = 0;
      }
      for (var q = blockLen; q < 56; q++) {
        block[q] = 0;
      }
      block[56] = (bitLenHi >>> 24) & 0xff;
      block[57] = (bitLenHi >>> 16) & 0xff;
      block[58] = (bitLenHi >>> 8) & 0xff;
      block[59] = bitLenHi & 0xff;
      block[60] = (bitLenLo >>> 24) & 0xff;
      block[61] = (bitLenLo >>> 16) & 0xff;
      block[62] = (bitLenLo >>> 8) & 0xff;
      block[63] = bitLenLo & 0xff;
      compress(h, block, w);
      return toHex(h[0]) + toHex(h[1]) + toHex(h[2]) +
        toHex(h[3]) + toHex(h[4]) + toHex(h[5]) +
        toHex(h[6]) + toHex(h[7]);
    }
  };
}

// 单块压缩：消息扩展 + 64 轮。
function compress(h, block, w) {
  var i;
  for (i = 0; i < 16; i++) {
    w[i] = ((block[i * 4] << 24) |
      (block[i * 4 + 1] << 16) |
      (block[i * 4 + 2] << 8) |
      block[i * 4 + 3]) >>> 0;
  }
  for (i = 16; i < 64; i++) {
    var s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^
      (w[i - 15] >>> 3)) >>> 0;
    var s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^
      (w[i - 2] >>> 10)) >>> 0;
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
  }
  var a = h[0], b = h[1], c = h[2], d = h[3];
  var e = h[4], f = h[5], g = h[6], hh = h[7];
  for (i = 0; i < 64; i++) {
    var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
    var ch = ((e & f) ^ (~e & g)) >>> 0;
    var t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
    var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
    var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
    var t2 = (S0 + maj) >>> 0;
    hh = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  h[0] = (h[0] + a) >>> 0;
  h[1] = (h[1] + b) >>> 0;
  h[2] = (h[2] + c) >>> 0;
  h[3] = (h[3] + d) >>> 0;
  h[4] = (h[4] + e) >>> 0;
  h[5] = (h[5] + f) >>> 0;
  h[6] = (h[6] + g) >>> 0;
  h[7] = (h[7] + hh) >>> 0;
}
