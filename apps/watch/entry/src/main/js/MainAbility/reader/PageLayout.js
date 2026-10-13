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


// 唯一正文排版算法：按圆形安全区逐行布置，逐字符线性估算占位。
// Lite GT4 不适合对每个前缀反复 measureText（会导致过多原生桥调用）。
// 固定使用保守字格：中文按 1.14em，西文按 0.72em，代理对 1.4em。
// 这属于该渲染算法的设计，不是另一条降级/兜底渲染路径。
function glyphWidth(ch, size) {
  const code = ch.charCodeAt(0);
  if (code === 9) return size * 1.2;
  if (ch.length > 1 && code >= 0xD800 && code <= 0xDBFF) {
    return size * 1.4;
  }
  if (code <= 0x7F) {
    if (ch === ' ' || ch === '.' || ch === ',' || ch === ':' ||
        ch === ';' || ch === '!' || ch === 'i' || ch === 'l') {
      return size * 0.45;
    }
    return size * 0.72;
  }
  return size * 1.14;
}

export function takeCanvasPage(bytes, offset, options) {
  const opts = options || {};
  const font = Math.max(14, Math.min(32, Math.floor(opts.fontSize || 20)));
  const ratio = opts.lineHeightRatio || 1.55;
  const width = opts.width || 420;
  const height = opts.height || 420;
  const padding = opts.padding === undefined ? 16 : opts.padding;
  const lineHeight = Math.max(font, Math.floor(font * ratio));
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.max(1, Math.min(width, height) / 2 - padding);
  const rows = Math.min(32, Math.max(1, Math.floor(2 * radius / lineHeight)));
  const topStart = cy - rows * lineHeight / 2;
  const lines = [];
  let used = offset;
  // 文件开头或翻页起点可能有大量空行。跳过完整的前置空行
  // 而不是为每个空行浪费一整行 Canvas 高度；如下一行有正文，
  // 保留它自己的全角空格/缩进，不删除正文字符。
  // 全窗口皆是空白时也必须消耗它，供阅读页继续读取下一窗口。
  let scan = used;
  let lastBlankLineEnd = used;
  let leadingText = '';
  let completedBlankText = '';
  while (scan < bytes.length) {
    const lead = decodeAt(bytes, scan);
    if (!lead) break;
    const ch = lead.char;
    if (ch === '\n') {
      scan += lead.size;
      leadingText += '\n';
      lastBlankLineEnd = scan;
      completedBlankText = leadingText;
      continue;
    }
    if (ch === '\r' || ch === ' ' || ch === '\t' ||
        ch === '\u3000' || ch === '\u00A0' || ch === '\uFEFF') {
      scan += lead.size;
      // 与原逻辑相同：CR 会被消耗但不进入正文文本。
      if (ch !== '\r') leadingText += ch;
      continue;
    }
    break;
  }
  let combined = '';
  if (lastBlankLineEnd > used) {
    used = lastBlankLineEnd;
    combined = completedBlankText;
  } else if (scan === bytes.length) {
    used = scan;
    combined = leadingText;
  }
  for (let row = 0; row < rows && used < bytes.length; row++) {
    const top = topStart + row * lineHeight;
    const dy = Math.max(Math.abs(top - cy), Math.abs(top + lineHeight - cy));
    const half = Math.sqrt(Math.max(0, radius * radius - dy * dy));
    const maxWidth = half * 2;
    let consumedWidth = 0;
    let content = '';
    let newline = false;
    while (used < bytes.length) {
      const next = decodeAt(bytes, used);
      if (!next) break;
      const ch = next.char;
      if (ch === '\r') {
        used += next.size;
        continue;
      }
      if (ch === '\n') {
        used += next.size;
        newline = true;
        break;
      }
      const advance = glyphWidth(ch, font);
      if (consumedWidth + advance > maxWidth) break;
      content += ch;
      consumedWidth += advance;
      used += next.size;
    }
    lines.push({ text: content, x: cx - half, baselineY: top,
      maxWidth: maxWidth, advance: consumedWidth });
    combined += content;
    if (newline) combined += '\n';
  }
  return { lines: lines, text: combined, offset: offset,
    nextOffset: used, eof: used === bytes.length, lineHeight: lineHeight,
    rows: rows, radius: radius, centerX: cx, centerY: cy };
}
