// SPDX-License-Identifier: GPL-3.0-only
// TXT 编码检测与统一 UTF-8 输出。
// 规则：
//   1. UTF-8 BOM / UTF-16 BOM 优先识别；
//   2. 完整 UTF-8 校验通过则按 UTF-8 处理；
//   3. 否则按 GBK/GB18030 尝试解码；解码接口不支持或失败时明确报错，
//      不做静默替换（不产生乱码书架）。
// 注意：HarmonyOS util.TextDecoder 实际支持的编码集合以真机为准，
// GBK/GB18030 当前属于“待验证”编码。
import { util } from '@kit.ArkTS';

export interface DecodedText {
  text: string;
  encoding: string;
}

const BOM_UTF8 = [0xef, 0xbb, 0xbf];
const BOM_UTF16LE = [0xff, 0xfe];
const BOM_UTF16BE = [0xfe, 0xff];

function hasBom(bytes: Uint8Array, bom: number[]): boolean {
  if (bytes.length < bom.length) return false;
  for (let i = 0; i < bom.length; i++) {
    if (bytes[i] !== bom[i]) return false;
  }
  return true;
}

// 标准 UTF-8 合法性校验：不允许超长编码、代理区、>U+10FFFF。
export function isValidUtf8(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 < 0x80) { i += 1; continue; }
    let width = 0;
    let min = 0;
    if (b0 >= 0xc2 && b0 <= 0xdf) { width = 2; min = 0x80; }
    else if (b0 >= 0xe0 && b0 <= 0xef) { width = 3; min = 0x800; }
    else if (b0 >= 0xf0 && b0 <= 0xf4) { width = 4; min = 0x10000; }
    else { return false; }
    if (i + width > bytes.length) return false;
    let code = b0 & (width === 2 ? 0x1f : width === 3 ? 0x0f : 0x07);
    for (let j = 1; j < width; j++) {
      const b = bytes[i + j];
      if ((b & 0xc0) !== 0x80) return false;
      code = (code << 6) | (b & 0x3f);
    }
    if (code < min || code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)) {
      return false;
    }
    i += width;
  }
  return true;
}

export function detectEncoding(bytes: Uint8Array): string {
  if (hasBom(bytes, BOM_UTF8)) return 'utf-8';
  if (hasBom(bytes, BOM_UTF16LE)) return 'utf-16le';
  if (hasBom(bytes, BOM_UTF16BE)) return 'utf-16be';
  if (isValidUtf8(bytes)) return 'utf-8';
  // 无 BOM 且非合法 UTF-8：按 GBK/GB18030 候选处理（仍需解码验证）。
  return 'gbk';
}

function tryDecode(bytes: Uint8Array, encoding: string): string | null {
  try {
    const decoder = util.TextDecoder.create(encoding);
    return decoder.decodeWithStream(bytes);
  } catch (e) {
    return null;
  }
}

// 统一输出文本。失败返回 null，调用方负责明确提示，不静默替换。
export function decodeToText(bytes: Uint8Array): DecodedText | null {
  const encoding = detectEncoding(bytes);
  const text = tryDecode(bytes, encoding);
  if (text === null) return null;
  return { text, encoding };
}
