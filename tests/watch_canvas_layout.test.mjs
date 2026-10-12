// SPDX-License-Identifier: GPL-3.0-only
// Issue #11：圆屏 Canvas 逐行排版与绘制契约。
// 用仿真的 Canvas 2D 上下文（measureText/fillText/clearRect/fillRect）
// 验证：圆心最宽、每行都在安全圆内、真实测量参与排版、
// 中英文/emoji/换行不丢字、字节位置可逆、多页不吞不重。
import assert from 'node:assert/strict';
import { createEstimator, takeCanvasPage } from '../apps/watch/entry/src/main/js/MainAbility/reader/PageLayout.js';
import { drawPage, measureWith, pageColors } from '../apps/watch/entry/src/main/js/MainAbility/reader/CanvasTextRenderer.js';

const VIEW = { width: 420, height: 420 };

// 确定性字宽：CJK/标点 1.05×，ASCII 0.6×（含 emoji 按码点计一次）。
function measureOf(fontSize) {
  return (text) => {
    let width = 0;
    for (const ch of text) {
      width += ch.codePointAt(0) > 0x2E7F ? fontSize * 1.05 : fontSize * 0.6;
    }
    return width;
  };
}

function fakeCtx() {
  const calls = { fillText: [], clearRect: 0, fillRect: [] };
  return {
    font: '',
    fillStyle: '',
    textBaseline: '',
    textAlign: '',
    measureText: (text) => ({ width: measureOf(20)(text) }),
    fillText: (text, x, y) => { calls.fillText.push({ text, x, y }); },
    clearRect: (x, y, w, h) => { calls.clearRect++; calls.cleared = { x, y, w, h }; },
    fillRect: (x, y, w, h) => { calls.fillRect.push({ x, y, w, h }); },
    __calls: calls
  };
}

const SAMPLE = ('第一行中文，标点。第二行English mix 123。\n'
  + '空行下面是一个emoji 😀 与更多中文内容。\n'
  + '\n'
  + '   缩进与长段无换行文字'.repeat(4) + '\n').repeat(40);

// ---- 1. 圆内几何：中间行最宽，每行都在安全圆内 ----
{
  const bytes = Buffer.from(SAMPLE, 'utf8');
  const page = takeCanvasPage(bytes, 0, {
    width: VIEW.width, height: VIEW.height,
    fontSize: 20, lineHeightRatio: 1.55, measure: measureOf(20)
  });
  assert.equal(page.measured, true, 'real measure must be marked as measured');
  assert.equal(page.centerX, 210);
  assert.equal(page.centerY, 210);
  assert.ok(page.lines.length > 6, 'a circle page must hold several rows');
  const mid = page.lines[Math.floor(page.lines.length / 2)];
  assert.ok(page.lines[0].maxWidth < mid.maxWidth,
    'top row must be narrower than the middle row on a circle');
  for (const line of page.lines) {
    assert.ok(line.x >= page.centerX - page.radius - 0.01,
      'line must not start outside the safe circle');
    assert.ok(line.x + line.maxWidth <= page.centerX + page.radius + 0.01,
      'line must not end outside the safe circle');
    assert.ok(measureOf(20)(line.text) <= line.maxWidth + 0.01,
      'rendered text must fit the measured row width');
  }
  // 圆弦公式：每行的左右边界必须等于该行上下缘的弦。
  for (const line of page.lines) {
    const dy = Math.max(Math.abs(line.baselineY - page.centerY),
      Math.abs(line.baselineY + page.lineHeight - page.centerY));
    const expected = Math.sqrt(Math.max(0, page.radius * page.radius - dy * dy));
    assert.ok(Math.abs((line.x + line.maxWidth / 2) - page.centerX) < 0.01,
      'row must be centred on the canvas centre');
    assert.ok(Math.abs(line.maxWidth / 2 - expected) < 0.5,
      'row width must follow the chord at its own glyph box');
  }
}

// ---- 2. 字号 14 / 20 / 32 都能分页并保持字节位置可逆 ----
for (const fontSize of [14, 20, 32]) {
  const bytes = Buffer.from(SAMPLE, 'utf8');
  const page = takeCanvasPage(bytes, 0, {
    width: VIEW.width, height: VIEW.height,
    fontSize: fontSize, lineHeightRatio: 1.55, measure: measureOf(fontSize)
  });
  assert.ok(page.lineHeight >= Math.floor(fontSize * 1.55) - 1,
    'line height must follow font size');
  assert.ok(page.nextOffset > 0, 'font ' + fontSize + ' must consume bytes');
  assert.equal(Buffer.from(page.text, 'utf8').length, page.nextOffset,
    'font ' + fontSize + ' consumed text must map back to source bytes');
}

// ---- 3. 多页前后翻页：不吞字、不重复、内容逐字重建 ----
{
  const full = Buffer.from(SAMPLE, 'utf8');
  // 2046 = 3×682，正好落在 UTF-8 字符边界上，避免把“跨窗口不完整
  // 字符留给下一页”的行为误判为丢字（该行为已在用例 5 单独验证）。
  const windowBytes = full.subarray(0, 2046);
  const opts = { width: VIEW.width, height: VIEW.height,
    fontSize: 20, lineHeightRatio: 1.55, measure: measureOf(20) };
  let offset = 0;
  let rebuilt = '';
  let pages = 0;
  while (offset < windowBytes.length && pages < 50) {
    const page = takeCanvasPage(windowBytes, offset, opts);
    assert.ok(page.nextOffset > offset,
      'each page must advance the byte offset');
    assert.equal(Buffer.from(page.text, 'utf8').length,
      page.nextOffset - offset, 'consumed text must equal consumed bytes');
    rebuilt += page.text;
    offset = page.nextOffset;
    pages++;
  }
  assert.ok(pages > 1 && pages < 50,
    'a 2 KB Chinese window must span multiple, bounded pages');
  assert.equal(rebuilt, windowBytes.toString('utf8'),
    'paging must rebuild the window without dropping or duplicating text');
}

// ---- 4. 换行/回车/空行/缩进/emoji 不被拼掉也不被拆开 ----
{
  const src = '甲\r\n\r\n   缩进乙😀\n丙';
  const bytes = Buffer.from(src, 'utf8');
  const page = takeCanvasPage(bytes, 0, {
    width: VIEW.width, height: VIEW.height,
    fontSize: 20, lineHeightRatio: 1.55, measure: measureOf(20)
  });
  const joined = page.lines.map((l) => l.text).join('\n');
  assert.ok(!joined.includes('\r'), 'carriage return must be consumed, not drawn');
  assert.ok(joined.startsWith('甲\n') && joined.includes('   缩进乙😀'),
    'blank line, indent and emoji must survive pagination');
  // CRLF 会规范化成单个换行：渲染文本不再逐字节可逆，
  // 但所有源字节都必须被消耗（换行不能被吞），且不得画出 \r。
  assert.equal(page.text, src.split('\r').join(''),
    'newlines must be preserved as line breaks');
  assert.equal(page.nextOffset, bytes.length,
    'every source byte must be consumed without dropping newlines');
}

// ---- 5. 跨窗口的不完整 UTF-8 字符留到下一页 ----
{
  const bytes = Buffer.from('中'.repeat(8), 'utf8');
  const cut = bytes.subarray(0, 7); // 2 个完整“中”(6B) + 1 个被截断的首字节
  const page = takeCanvasPage(cut, 0, {
    width: 420, height: 420, fontSize: 20, lineHeightRatio: 1.55,
    measure: measureOf(20)
  });
  assert.equal(page.text, '中中',
    'incomplete trailing UTF-8 must be left for the next window');
  assert.equal(page.nextOffset, 6);
}

// ---- 6. 无 measureText 时回退估算，并如实标记 ----
{
  const page = takeCanvasPage(Buffer.from(SAMPLE, 'utf8'), 0, {
    width: 420, height: 420, fontSize: 20, lineHeightRatio: 1.55
  });
  assert.equal(page.measured, false, 'missing measure must be reported');
  assert.ok(page.lines.length > 0);
  assert.equal(typeof createEstimator(20)('中文abc123'), 'number');
}

// ---- 7. 大文本小窗口 ----
{
  const big = Buffer.from('很长的正文没有换行'.repeat(5000), 'utf8');
  const small = big.subarray(0, 512);
  const page = takeCanvasPage(small, 0, {
    width: 420, height: 420, fontSize: 32, lineHeightRatio: 1.3,
    measure: measureOf(32)
  });
  assert.ok(page.nextOffset > 0 && page.nextOffset <= 512,
    'small window must still fill a page without exceeding its bytes');
}

// ---- 8. 绘制器：调用真实 Canvas API 且只在给定行上绘制 ----
{
  const ctx = fakeCtx();
  const page = takeCanvasPage(Buffer.from(SAMPLE, 'utf8'), 0, {
    width: 420, height: 420, fontSize: 20, lineHeightRatio: 1.55,
    measure: measureOf(20)
  });
  const result = drawPage(ctx, VIEW, page.lines, { fontSize: 20, theme: 'night' });
  assert.equal(result.ok, true);
  assert.equal(result.drawn,
    page.lines.filter((l) => l.text).length,
    'every non-empty row must be drawn (blank lines stay blank)');
  assert.equal(ctx.__calls.clearRect, 1, 'previous page must be cleared once');
  assert.equal(ctx.__calls.fillRect.length, 1, 'background must be painted once');
  assert.ok(ctx.font.includes('20px'), 'font must be set from the font size');
  assert.equal(ctx.textBaseline, 'top');
  assert.equal(ctx.textAlign, 'left');
  assert.equal(ctx.__calls.fillText.length,
    page.lines.filter((l) => l.text).length,
    'every non-empty row must be drawn exactly once');
  const first = ctx.__calls.fillText[0];
  assert.equal(first.x, page.lines[0].x, 'row must be drawn at its measured x');
  assert.equal(first.y, page.lines[0].baselineY);
  assert.equal(pageColors('day').background, '#f5f4f0');
  assert.equal(pageColors('night').background, '#101114');
}

// ---- 9. 绘制异常必须给出可定位原因，不能静默/黑屏 ----
{
  assert.deepEqual(drawPage(null, VIEW, [], { fontSize: 20 }),
    { ok: false, reason: 'no_context' });
  const noFill = { clearRect() {}, fillRect() {}, measureText: () => ({ width: 1 }) };
  assert.equal(drawPage(noFill, VIEW, [], {}).reason, 'no_context');
  const throwing = fakeCtx();
  throwing.fillText = () => { throw new Error('boom'); };
  assert.equal(drawPage(throwing, VIEW, [{ text: '甲', x: 10, baselineY: 10 }], {}).reason,
    'draw_throw');
  assert.equal(measureWith(null), null, 'no context means no measurement');
  assert.equal(measureWith({}), null, 'canvas without measureText must be reported');
  assert.equal(measureWith(fakeCtx())('中'), measureOf(20)('中'),
    'measureWith must use the canvas measureText result');
}

console.info('PASS: 圆屏 Canvas 逐行排版：圆心最宽、每行在圆内、真实测量、'
  + '中英/emoji/换行不丢字、多页字节可逆、绘制异常可定位');
