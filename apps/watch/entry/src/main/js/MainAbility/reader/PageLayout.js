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


// 估算字宽：只有在真机 measureText 不可用时才作为回退
// （CJK 1.1×字号、ASCII 0.62×、emoji 1.2×，与旧实现一致）。
// 正常路径必须用 Canvas 的 measureText 实测。
export function createEstimator(fontSize) {
  const size = Math.max(1, fontSize);
  return function (text) {
    let total = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        total += size * 1.2; // 代理对（emoji）整体计宽
        i++;
      } else if (code <= 0x7F) {
        total += text.charAt(i) === '\t' ? size * 1.12 : size * 0.62;
      } else {
        total += size * 1.1;
      }
    }
    return total;
  };
}

// GT4 圆屏分页（issue #11）：按**真实字形宽度**和**画布尺寸**排版，
// 输出每行可直接交给 Canvas 绘制的坐标。
//   options = { width, height, fontSize, lineHeightRatio, padding, measure }
//   measure(text) -> 像素宽度；未提供时回退到 createEstimator。
// 每行的安全左右边界按该行字形盒的**上下边缘**取圆弦：
//   dy = max(|top-cy|, |bottom-cy|)，半宽 = sqrt(r² - dy²)。
// 返回 { lines:[{text,x,baselineY,maxWidth}], text, offset, nextOffset,
//        eof, lineHeight, rows, radius, centerX, centerY, measured }。
// offset/nextOffset 都是**相对传入 bytes 的索引**（窗口内偏移）：
// 从 bytes[offset] 开始排版，nextOffset 是真正被渲染消耗到的索引；
// 调用方若需书内绝对位置，自行加上窗口起始绝对偏移。
// 跨窗口不完整的 UTF-8 字符留到下一页，绝不吞字或重复。
export function takeCanvasPage(bytes, offset, options) {
  const opts = options || {};
  const fontSize = Math.max(1, Math.floor(opts.fontSize || 20));
  const ratio = opts.lineHeightRatio || 1.55;
  const width = opts.width || 420;
  const height = opts.height || 420;
  const padding = opts.padding === undefined ? 12 : opts.padding;
  const measured = typeof opts.measure === 'function';
  const measure = measured ? opts.measure : createEstimator(fontSize);

  const lineHeight = Math.max(1, Math.floor(fontSize * ratio));
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.max(1, Math.min(width, height) / 2 - padding);
  const rows = Math.max(1, Math.floor((radius * 2) / lineHeight));
  const topStart = centerY - (rows * lineHeight) / 2;

  const lines = [];
  let combined = '';
  let used = offset; // 从请求的偏移开始排版，不是从窗口 0
  for (let row = 0; row < rows; row++) {
    const top = topStart + row * lineHeight;
    const bottom = top + lineHeight;
    const dy = Math.max(Math.abs(top - centerY),
      Math.abs(bottom - centerY));
    const half = Math.sqrt(Math.max(0, radius * radius - dy * dy));
    const x = centerX - half;
    const maxWidth = half * 2;
    let content = '';
    let broke = false;
    while (used < bytes.length) {
      const item = decodeAt(bytes, used);
      if (!item) break; // 不完整的 UTF-8：留给下一页窗口
      const ch = item.char;
      if (ch === '\r') { used += item.size; continue; }
      if (ch === '\n') {
        used += item.size;
        broke = true;
        break;
      }
      const trial = content + ch;
      if (content !== '' && measure(trial) > maxWidth) break;
      content = trial;
      used += item.size;
    }
    lines.push({ text: content, x: x, baselineY: top, maxWidth: maxWidth });
    combined += content;
    if (broke) combined += '\n';
    if (used >= bytes.length) break;
    if (content === '' && !broke) break; // 无法前进，避免死循环
  }
  return {
    lines: lines, text: combined, offset: offset,
    nextOffset: used, eof: used === bytes.length,
    lineHeight: lineHeight, rows: rows, radius: radius,
    centerX: centerX, centerY: centerY, measured: measured
  };
}
