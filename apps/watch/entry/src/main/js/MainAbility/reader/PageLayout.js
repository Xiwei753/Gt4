// SPDX-License-Identifier: GPL-3.0-only
// 纯 JavaScript UTF-8 流读取和简易圆屏分页；不依赖浏览器 TextDecoder。
// 宽度是粗略估算，实际像素分页仍需 GT4 46mm 真机校准。
export function decodeAt(bytes, pos) {
  const b0 = bytes[pos];
  if (b0 === undefined) return null;
  if (b0 < 128) return { char: String.fromCharCode(b0), size: 1 };
  const width = b0 >= 0xF0 && b0 <= 0xF4 ? 4 :
    b0 >= 0xE0 && b0 <= 0xEF ? 3 : b0 >= 0xC2 && b0 <= 0xDF ? 2 : 0;
  if (!width) return { char: '\uFFFD', size: 1 };
  if (pos + width > bytes.length) return null;
  for (let i = 1; i < width; i++) {
    if ((bytes[pos + i] & 0xC0) !== 0x80) return { char: '\uFFFD', size: 1 };
  }
  const b1 = bytes[pos + 1];
  const b2 = bytes[pos + 2];
  const b3 = bytes[pos + 3];
  const code = width === 2 ? ((b0 & 31) << 6) | (b1 & 63) :
    width === 3 ? ((b0 & 15) << 12) | ((b1 & 63) << 6) | (b2 & 63) :
    ((b0 & 7) << 18) | ((b1 & 63) << 12) | ((b2 & 63) << 6) | (b3 & 63);
  if (code > 0x10FFFF || code >= 0xD800 && code <= 0xDFFF ||
      width === 2 && code < 0x80 || width === 3 && code < 0x800 ||
      width === 4 && code < 0x10000) {
    return { char: '\uFFFD', size: 1 };
  }
  if (code <= 0xFFFF) return { char: String.fromCharCode(code), size: width };
  const pair = code - 0x10000;
  return { char: String.fromCharCode(0xD800 + (pair >> 10), 0xDC00 + (pair & 1023)), size: width };
}

export function takePage(bytes, offset, columns, maxRows) {
  const cols = columns || 14;
  const rowsLimit = maxRows || 7;
  let used = 0;
  let row = 1;
  let col = 0;
  let text = '';
  while (used < bytes.length) {
    const item = decodeAt(bytes, used);
    if (!item) break; // 不能消耗不完整的 UTF-8 字符。
    const ch = item.char;
    if (ch === '\r') { used += item.size; continue; }
    if (ch === '\n') {
      if (row >= rowsLimit) break;
      text += '\n'; row++; col = 0; used += item.size; continue;
    }
    // 避免 lite-JS 老运行时可能没有的 String.prototype.codePointAt。
    const firstUnit = ch.charCodeAt(0);
    const advance = firstUnit <= 0x7F ? (ch === '\t' ? 2 : 0.55) : 1;
    if (col + advance > cols) {
      if (row >= rowsLimit) break;
      row++; col = 0;
    }
    text += ch;
    col += advance;
    used += item.size;
  }
  return { text: text, offset: offset, nextOffset: offset + used, eof: used === bytes.length };
}


// GT4 圆内排版：根据每一行距离圆心的高度计算圆弦宽度。
export function roundLineWidth(row, rows, lineHeight) {
  const radius = 202;
  const dy = (row - (rows - 1) / 2) * lineHeight;
  const chord = 2 * Math.sqrt(Math.max(0, radius * radius - dy * dy));
  return Math.max(70, Math.min(390, Math.floor(chord - 20)));
}

export function takeRoundPage(bytes, offset, fontSize, lineRatio) {
  const lineHeight = Math.max(20, Math.floor(fontSize * lineRatio));
  const rows = Math.max(3, Math.floor(400 / lineHeight));
  const lines = [];
  let used = 0;
  let row = 0;
  let combined = '';
  while (row < rows && used < bytes.length) {
    const width = roundLineWidth(row, rows, lineHeight);
    let content = '';
    let filled = 0;
    let explicitNewline = false;
    while (used < bytes.length) {
      const item = decodeAt(bytes, used);
      if (!item) break;
      const ch = item.char;
      if (ch === '\r') {
        used += item.size;
        continue;
      }
      if (ch === '\n') {
        if (row >= rows - 1) break;
        used += item.size;
        explicitNewline = true;
        break;
      }
      const c = ch.charCodeAt(0);
      const advance = c <= 0x7F ?
        (ch === '\t' ? fontSize * 1.12 : fontSize * 0.62) :
        fontSize * 1.1;
      if (content.length > 0 && filled + advance > width) break;
      content += ch;
      filled += advance;
      used += item.size;
    }
    if (content.length === 0 && !explicitNewline) break;
    lines.push({ id: row,
      text: content.length > 0 ? content : ' ',
      width: width });
    combined += content;
    if (explicitNewline) combined += '\n';
    row++;
  }
  return {
    lines: lines, text: combined,
    offset: offset, nextOffset: offset + used,
    eof: used === bytes.length, lineHeight: lineHeight
  };
}
