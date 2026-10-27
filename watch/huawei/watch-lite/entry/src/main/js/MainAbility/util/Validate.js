// SPDX-License-Identifier: GPL-3.0-only
// 纯字符格式校验：**本文件不能使用正则**。
//
// 证据（本机 HarmonyOS Command Line Tools 26.0.0 / API 26 实测）：
//   ace-loader/lib/lite/lite-snapshot-plugin.js 用 jerry-snapshot
//   把每个页面 JS 转成 .bc 快照；JerryScript 构建**不含 RegExp**：
//     - 正则字面量 /abc/  → 解析期 SyntaxError，快照生成失败；
//     - new RegExp('a')   → 运行期 ReferenceError；
//     - 'x'.replace('a','b') → TypeError（replace 仍依赖正则实现）。
//   快照失败时 lite-snapshot-plugin 只打印错误、**不会让构建失败**，
//   结果是 HAP 里缺少该页 .bc，构建"成功"但页面在手表上起不来。
// 因此所有格式校验都用字符比较实现，并加 Node 回归测试守门。
var HEX_LOWER = '0123456789abcdef';

// 定长小写十六进制（bookId 16 位、sha256 64 位）。
export function isLowerHex(text, length) {
  if (typeof text !== 'string' || text.length !== length) {
    return false;
  }
  for (var i = 0; i < text.length; i++) {
    if (HEX_LOWER.indexOf(text.charAt(i)) === -1) {
      return false;
    }
  }
  return true;
}

// 文件名安全 token：仅 [0-9a-zA-Z_-]，长度 1..maxLength。
// 用于 transferId 等直接拼进 URI 的值，杜绝路径穿越。
export function isSafeToken(text, maxLength) {
  if (typeof text !== 'string' || text.length < 1) {
    return false;
  }
  if (typeof maxLength === 'number' && text.length > maxLength) {
    return false;
  }
  for (var i = 0; i < text.length; i++) {
    var c = text.charAt(i);
    var isDigit = c >= '0' && c <= '9';
    var isLower = c >= 'a' && c <= 'z';
    var isUpper = c >= 'A' && c <= 'Z';
    if (isDigit || isLower || isUpper ||
        c === '-' || c === '_') {
      continue;
    }
    return false;
  }
  return true;
}
