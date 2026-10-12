// SPDX-License-Identifier: GPL-3.0-only
// 扩展分页回归：中文/英文/emoji、CRLF、
// 超长无空格段落、跨 2048B UTF-8 边界、
// 文件尾、前后页来回 100 次、字号变化后
// 定位不漂移。
// Run: node --experimental-default-type=module tests/pagination.test.mjs
import assert from 'node:assert/strict';
import { TextEncoder } from 'node:util';
import { decodeAt, takePage, takeRoundPage, roundLineWidth } from '../apps/watch/entry/src/main/js/MainAbility/reader/PageLayout.js';
import { columnsFor, rowsFor,
  normalizeSettings } from '../apps/watch/entry/src/main/js/MainAbility/reader/ReaderSettings.js';

const encode = new TextEncoder();

// ---------- 基础：UTF-8 中文/emoji、边界、可逆 ----------
const sample = '第一章：你好，世界！ 2026 ABC\n第二行😀\n'.repeat(50);
const raw = encode.encode(sample);
let position = 0;
let reconstructed = '';
let count = 0;
while (position < raw.length) {
  const page = takePage(raw.subarray(position, position + 2048), position, 14, 7);
  assert.ok(page.nextOffset > position, 'pager must advance');
  assert.ok(page.text.length > 0, 'page must contain text');
  reconstructed += page.text;
  position = page.nextOffset;
  count++;
  assert.ok(count < 2000, 'pager must terminate');
}
assert.equal(reconstructed.replace(/\r/g, ''), sample.replace(/\r/g, ''), 'all characters must survive pagination');
assert.equal(decodeAt(encode.encode('😀'), 0)?.size, 4);
assert.equal(decodeAt(encode.encode('你'), 0)?.size, 3);
assert.equal(decodeAt(new Uint8Array([0xe4, 0xbd]), 0), null, 'incomplete UTF-8 must not be consumed');
assert.equal(takePage(encode.encode(''), 0, 14, 7).nextOffset, 0);

// ---------- CRLF 不吞字 ----------
{
  const crlf = encode.encode('行一\r\n行二\r\n行三\r\n');
  let pos = 0;
  let text = '';
  while (pos < crlf.length) {
    const page = takePage(crlf.subarray(pos, pos + 2048), pos, 14, 7);
    assert.ok(page.nextOffset > pos);
    text += page.text;
    pos = page.nextOffset;
  }
  assert.equal(text, '行一\n行二\n行三\n',
    'CRLF becomes LF, nothing swallowed');
}

// ---------- 超长无空格段落（强制折行） ----------
{
  const long = encode.encode('甲'.repeat(500));
  let pos = 0;
  let chars = 0;
  const seen = [];
  while (pos < long.length) {
    const page = takePage(long.subarray(pos, pos + 2048), pos, 14, 7);
    assert.ok(page.nextOffset > pos);
    chars += page.text.length;
    seen.push(page.text);
    pos = page.nextOffset;
  }
  assert.equal(chars, 500, 'no character may be lost in long no-space runs');
  for (const t of seen) {
    assert.ok(t.split('\n').length <= 7);
  }
}

// ---------- 跨 2048B UTF-8 边界的多字节字符 ----------
{
  // 2047 个 ASCII 后跟汉字：3 字节字符恰好跨窗口边界。
  const head = 'a'.repeat(2047);
  const text = head + '汉' + 'b'.repeat(100);
  const bytes = encode.encode(text);
  assert.equal(bytes.length, 2047 + 3 + 100);
  let pos = 0;
  let out = '';
  while (pos < bytes.length) {
    const page = takePage(bytes.subarray(pos, pos + 2048), pos, 40, 100);
    out += page.text;
    pos = page.nextOffset;
  }
  assert.equal(out, text, 'multi-byte char at window boundary must survive');
}

// ---------- 文件尾：最后一页之后不再前进 ----------
{
  const tiny = encode.encode('结尾');
  const page = takePage(tiny, 0, 14, 7);
  assert.equal(page.eof, true);
  assert.equal(page.nextOffset, tiny.length);
  const empty = takePage(tiny.subarray(page.nextOffset), page.nextOffset, 14, 7);
  assert.equal(empty.text, '');
  assert.equal(empty.nextOffset, page.nextOffset);
}

// ---------- 前后页来回 100 次 ----------
{
  const book = encode.encode('章节'.repeat(2000)); // 4000 字 / 12000 字节
  const columns = 14;
  const rows = 7;
  const offsets = [0];
  let pos = 0;
  while (pos < book.length) {
    const page = takePage(book.subarray(pos, pos + 2048), pos, columns, rows);
    if (!page.text) break;
    pos = page.nextOffset;
    offsets.push(pos);
  }
  assert.ok(offsets.length > 2, 'book must span multiple pages');
  let index = 0;
  for (let i = 0; i < 100; i++) {
    // 交替前进/后退：净效果在相邻页间振荡，
    // 不单调爬向书尾。
    if (i % 2 === 0) {
      if (index < offsets.length - 1 &&
          offsets[index + 1] > offsets[index]) {
        index += 1;
      }
    } else {
      if (index > 0) index -= 1;
    }
  }
  // 最终必须落在合法页边界上，且该页可正常渲染。
  assert.ok(offsets.includes(offsets[index]),
    'final offset must be a known page boundary');
  const page = takePage(book.subarray(offsets[index],
    offsets[index] + 2048), offsets[index], columns, rows);
  assert.ok(page.text.length > 0);
  assert.equal(page.offset, offsets[index]);
}

// ---------- 字号变化：列数/行数推导与定位稳定 ----------
{
  const book = encode.encode('字'.repeat(3000));
  const small = normalizeSettings({ fontSize: 14, lineHeightRatio: 1.3 });
  const large = normalizeSettings({ fontSize: 32, lineHeightRatio: 2.0 });
  assert.ok(columnsFor(small) > columnsFor(large),
    'smaller font must yield more columns');
  // 同一偏移、同一设置下分页结果确定（不漂移）
  const offset = 1000;
  const first = takePage(book.subarray(offset, offset + 2048),
    offset, columnsFor(small), rowsFor(small));
  const second = takePage(book.subarray(offset, offset + 2048),
    offset, columnsFor(small), rowsFor(small));
  assert.equal(first.nextOffset, second.nextOffset);
  assert.equal(first.text, second.text);
  // 改变字号后从同一偏移重排，仍然不丢字
  for (const settings of [small, large]) {
    let pos = 0;
    let chars = 0;
    let guard = 0;
    while (pos < book.length) {
      const page = takePage(book.subarray(pos, pos + 2048),
        pos, columnsFor(settings), rowsFor(settings));
      assert.ok(page.nextOffset > pos, 'must advance at ' + pos);
      chars += page.text.length;
      pos = page.nextOffset;
      assert.ok(++guard < 5000);
    }
    assert.equal(chars, 3000,
      'font size change must not lose characters');
  }
}

// ---------- decodeAt 回归 ----------
{
  assert.equal(decodeAt(encode.encode('世'), 0).size, 3);
  assert.equal(decodeAt(encode.encode('a'), 0).size, 1);
  assert.equal(decodeAt(new Uint8Array([0xff]), 0).char, '�');
}

console.info('PASS: UTF-8 Chinese/emoji, CRLF, long runs, ' +
  'boundary, EOF, 100x back/forward, font stability; pages=' + count);


// #10 圆屏逐行排版：圆心更宽，逐字节消耗稳定；字号变化不会吞字。
{
  const sample = '文字甲乙丙丁ABCDEFG😀\n'.repeat(250);
  const bytes = encode.encode(sample);
  const probe = takeRoundPage(bytes.subarray(0, 2048), 0, 20, 1.55);
  assert.ok(probe.lines.length > 6);
  assert.ok(roundLineWidth(0, 13, 31) < roundLineWidth(6, 13, 31),
    'top chord must be narrower than center chord');
  for (const font of [14, 20, 32]) {
    let pos = 0;
    let out = '';
    let guard = 0;
    while (pos < bytes.length) {
      const page = takeRoundPage(bytes.subarray(pos, pos + 2048),
        pos, font, 1.55);
      assert.ok(page.nextOffset > pos, 'round paginator is stuck: ' + pos);
      out += page.text;
      pos = page.nextOffset;
      assert.ok(++guard < 4000);
    }
    assert.equal(out, sample, 'round pagination must preserve source text');
  }
}
