import assert from 'node:assert/strict';
import {
  clampOffset,
  snapToBoundary,
  isValidBoundary,
  nextBoundary,
  previousBoundary,
  safeChunkEnd,
  splitWindowChunks,
  chapterIndexAt
} from '../harmony/entry/src/main/ets/model/TextWindow.js';

const encoder = new TextEncoder();
const text = '第一章 😀 开始\n正文 abc\n第二章 继续\n尾部\n';
const bytes = encoder.encode(text);

assert.equal(clampOffset(bytes, -10), 0);
assert.equal(clampOffset(bytes, bytes.length + 10), bytes.length);
assert.equal(clampOffset(bytes, 1.9), 1);

// 每个 UTF-8 字符的起始字节都必须是合法边界，续字节不是。
let prefix = '';
for (const char of Array.from(text)) {
  prefix += char;
  const offset = encoder.encode(prefix).length;
  assert.equal(isValidBoundary(bytes, offset), true, `boundary ${offset}`);
}
assert.equal(isValidBoundary(bytes, -1), false);
assert.equal(isValidBoundary(bytes, bytes.length + 1), false);

// 从任意字节位置向前吸附，不能落在续字节上。
for (let offset = 0; offset <= bytes.length; offset++) {
  const snapped = snapToBoundary(bytes, offset);
  assert.equal(isValidBoundary(bytes, snapped), true, `snap ${offset}`);
  assert.ok(snapped <= offset);
}

const emojiStart = encoder.encode('第一章 ').length;
assert.equal(isValidBoundary(bytes, emojiStart), true);
assert.equal(isValidBoundary(bytes, emojiStart + 1), false);
assert.equal(snapToBoundary(bytes, emojiStart + 1), emojiStart);
assert.equal(nextBoundary(bytes, emojiStart), emojiStart + 4);
assert.equal(previousBoundary(bytes, emojiStart + 4), emojiStart);

// 分块必须覆盖窗口、块间无重叠，且每块首尾都是合法边界。
const ranges = splitWindowChunks(bytes, 12, 1000);
assert.ok(ranges.length > 0);
assert.equal(ranges[0].offset, 0);
for (let i = 0; i < ranges.length; i++) {
  const range = ranges[i];
  assert.equal(isValidBoundary(bytes, range.offset), true);
  assert.equal(isValidBoundary(bytes, range.offset + range.length), true);
  if (i > 0) {
    assert.equal(ranges[i - 1].offset + ranges[i - 1].length, range.offset);
  }
}
assert.equal(ranges[ranges.length - 1].offset + ranges[ranges.length - 1].length,
  bytes.length);

// 优先在换行后切块，不能把 CRLF 或 emoji 切坏。
const crlf = encoder.encode('第一行\r\n第二行😀\r\n第三行\r\n');
const crlfRanges = splitWindowChunks(crlf, 14, 10);
for (const range of crlfRanges) {
  assert.equal(isValidBoundary(crlf, range.offset), true);
  assert.equal(isValidBoundary(crlf, range.offset + range.length), true);
}
assert.ok(crlfRanges.some((range) => crlf[range.offset + range.length - 1] === 10));

// 章节定位使用字节偏移，而不是字符下标。
const chapters = [
  { title: '第一章', offset: 0 },
  { title: '第二章', offset: encoder.encode('第一章 😀 开始\n正文 abc\n').length },
  { title: '第三章', offset: bytes.length - 1 }
];
assert.equal(chapterIndexAt(chapters, 0), 0);
assert.equal(chapterIndexAt(chapters, chapters[1].offset - 1), 0);
assert.equal(chapterIndexAt(chapters, chapters[1].offset), 1);
assert.equal(chapterIndexAt(chapters, bytes.length), 2);
assert.equal(chapterIndexAt([], 0), -1);

console.log('text window: UTF-8 boundaries and bounded chunks passed');
