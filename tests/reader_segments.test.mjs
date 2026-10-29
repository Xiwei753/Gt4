// SPDX-License-Identifier: GPL-3.0-only
// 手机阅读器显示分段与进度回读的真实逻辑回归（不调用 DevEco SDK）。
import assert from 'node:assert/strict';
import {
  SEGMENT_TARGET_BYTES,
  safeWindowLength,
  segmentIndexForOffset,
  splitWindowSegments
} from '../harmony/entry/src/main/ets/model/ReaderSegments.js';
import {
  isValidBoundary,
  snapToBoundary
} from '../harmony/entry/src/main/ets/model/TextWindow.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');
const OLD_CHUNK_BYTES = 6 * 1024;

function buildText(lines) {
  let text = '';
  for (let i = 0; i < lines; i++) {
    text += '第' + i + '章 风起😀\r\n';
    text += '他说：“走吧。”然后转身……\n';
  }
  return text;
}

function assertSegmentsCover(bytes, segments, label) {
  assert.ok(segments.length > 0, label + ': segments must not be empty');
  assert.equal(segments[0].offset, 0, label + ': first segment starts at 0');
  let joined = '';
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    assert.ok(segment.length > 0, label + ': empty segment');
    assert.ok(segment.length <= SEGMENT_TARGET_BYTES + 4,
      label + ': segment may exceed target only by a UTF-8/CRLF tail');
    assert.equal(isValidBoundary(bytes, segment.offset), true,
      label + ': start must be a UTF-8 boundary');
    assert.equal(isValidBoundary(bytes, segment.offset + segment.length), true,
      label + ': end must be a UTF-8 boundary');
    if (i > 0) {
      assert.equal(segments[i - 1].offset + segments[i - 1].length,
        segment.offset, label + ': segments must be contiguous');
    }
    const raw = bytes.subarray(segment.offset, segment.offset + segment.length);
    assert.equal(decoder.decode(raw), segment.text,
      label + ': text must decode from its own byte range');
    if (segment.offset + segment.length < bytes.length) {
      assert.ok(!(bytes[segment.offset + segment.length - 1] === 0x0D &&
        bytes[segment.offset + segment.length] === 0x0A),
      label + ': must not split CRLF');
    }
    joined += segment.text;
  }
  assert.equal(segments[segments.length - 1].offset +
    segments[segments.length - 1].length, bytes.length,
  label + ': segments must cover the whole window');
  return joined;
}

// 1. 中文 + emoji + CRLF：范围连续、边界合法、文本可无损拼回。
const text = buildText(500);
const bytes = encoder.encode(text);
const segments = splitWindowSegments(bytes, SEGMENT_TARGET_BYTES, 4000);
const joined = assertSegmentsCover(bytes, segments, 'mixed utf8');
assert.equal(joined, text, 'concatenated segment text must equal source');
assert.ok(segments.length > 100, 'long text must produce many fine segments');
assert.ok(segments.some((segment) =>
  bytes[segment.offset + segment.length - 1] === 0x0A),
'newline should be preferred as a split point');
assert.equal(splitWindowSegments(bytes, SEGMENT_TARGET_BYTES, 5).length, 5,
  'maxSegments must hard-cap the returned list');

// 长句没有换行时，句末标点也应优先；不能只退化成固定字节切分。
const sentenceText = '没有换行的长句😀，仍然要找到句号。'.repeat(200);
const sentenceBytes = encoder.encode(sentenceText);
const sentenceSegments = splitWindowSegments(sentenceBytes,
  SEGMENT_TARGET_BYTES, 4000);
assertSegmentsCover(sentenceBytes, sentenceSegments, 'sentence');
assert.ok(sentenceSegments.some((segment) =>
  segment.text.endsWith('。') || segment.text.endsWith('！')),
'sentence punctuation should be preferred as a split point');

// 2. 同一段阅读过程内移动位置：保存精确段首，回读时落在同一段，
//    而不是退回到旧实现里整块 6 KiB 的块首。
const windowBytes = bytes.subarray(0, Math.min(64 * 1024, bytes.length));
const windowSegments = splitWindowSegments(windowBytes, SEGMENT_TARGET_BYTES, 900);
const firstIndex = windowSegments.findIndex((segment) => segment.offset >= 1024);
assert.ok(firstIndex >= 0, 'window must contain offsets above 1 KiB');
const laterIndex = firstIndex + 12;
assert.ok(laterIndex < windowSegments.length, 'later segment must exist');
const first = windowSegments[firstIndex];
const later = windowSegments[laterIndex];
assert.ok(Math.floor(first.offset / OLD_CHUNK_BYTES) ===
  Math.floor(later.offset / OLD_CHUNK_BYTES),
'both samples must live inside one old 6 KiB chunk');
assert.notEqual(first.offset, later.offset,
'fine segments must expose distinct offsets inside one old chunk');

const savedOffset = later.offset;
const reloadIndex = segmentIndexForOffset(windowSegments, savedOffset);
assert.equal(reloadIndex, laterIndex,
'reloading must resolve the segment saved at the exact offset');
const reloaded = windowSegments[reloadIndex];
assert.ok(reloaded.offset <= savedOffset &&
  savedOffset < reloaded.offset + reloaded.length,
'reloaded segment must contain the saved offset');
assert.equal(savedOffset, reloaded.offset,
'a top-of-list segment must save its exact start offset');
assert.notEqual(savedOffset, 0, 'several screens in must not save offset 0');

// 真正从保存位置重开：新窗口从该字节开始，首段仍是同一位置，而不是块首 0。
const reopenFromSaved = windowBytes.subarray(savedOffset);
const savedSegments = splitWindowSegments(reopenFromSaved,
  SEGMENT_TARGET_BYTES, 900);
const savedIndex = segmentIndexForOffset(savedSegments, 0);
assert.equal(savedIndex, 0, 'reopen at saved offset must resolve first segment');
assert.equal(savedOffset + savedSegments[savedIndex].offset, savedOffset,
'reopen must start exactly at the saved byte offset');
assert.equal(savedSegments[savedIndex].text, reloaded.text,
'reopen must show the same segment text, not an earlier 6 KiB chunk');

// 3. 跳章到很远的章节：窗口从章节偏移开始，仍需定位到包含它的段。
const longText = buildText(5000);
const longBytes = encoder.encode(longText);
assert.ok(longBytes.length > 256 * 1024, 'long book must exceed one window');
const jumpTarget = Math.floor(longBytes.length * 0.72);
const chapterBase = snapToBoundary(longBytes, jumpTarget);
const jumpWindow = longBytes.subarray(chapterBase,
  Math.min(chapterBase + 64 * 1024, longBytes.length));
const jumpSegments = splitWindowSegments(jumpWindow,
  SEGMENT_TARGET_BYTES, 900);
const relativeTarget = jumpTarget - chapterBase;
const jumpIndex = segmentIndexForOffset(jumpSegments, relativeTarget);
assert.ok(jumpIndex >= 0, 'chapter offset must resolve to a segment');
const jumpSegment = jumpSegments[jumpIndex];
const jumpStart = chapterBase + jumpSegment.offset;
assert.ok(jumpStart <= jumpTarget &&
  jumpTarget < jumpStart + jumpSegment.length,
'chapter jump must land on the segment containing the requested byte');
assert.ok(jumpStart > 0, 'chapter jump must not reset to file start');

// 跳章后继续读一段，再保存；回读窗口从该位置开始，必须保持同一偏移。
const afterJumpIndex = jumpIndex + 10;
assert.ok(afterJumpIndex < jumpSegments.length, 'post-jump segment must exist');
const afterJumpOffset = chapterBase + jumpSegments[afterJumpIndex].offset;
const reloadWindow = longBytes.subarray(afterJumpOffset,
  Math.min(afterJumpOffset + 64 * 1024, longBytes.length));
const reloadSegments = splitWindowSegments(reloadWindow,
  SEGMENT_TARGET_BYTES, 900);
const reopenIndex = segmentIndexForOffset(reloadSegments, 0);
assert.equal(reopenIndex, 0, 'reopening at a saved offset starts at its segment');
assert.equal(afterJumpOffset + reloadSegments[reopenIndex].offset,
  afterJumpOffset, 'reopen offset must equal the saved byte offset');
assert.notEqual(afterJumpOffset, 0, 'reopen must not fall back to offset 0');

// 4. 字号/行距/宽度重排只改变显示：同一 offset 仍解析到同一段，
//    不会把 currentOffset 清成 0。
const sameIndex = segmentIndexForOffset(reloadSegments, 0);
const sameStart = afterJumpOffset + reloadSegments[sameIndex].offset;
assert.equal(sameStart, afterJumpOffset,
'style/width re-render must keep the same canonical offset');
assert.equal(reloadSegments[sameIndex].text,
  reloadSegments[0].text, 're-render must keep the same visible segment');
assert.equal(segmentIndexForOffset([], 123), -1,
'empty list must resolve to -1');

// 5. 64 KiB 文件窗口边界不能切断 UTF-8 字符；逐窗口读取后拼接必须与原文一致。
const continuous = [];
for (let i = 0; i < 3000; i++) {
  continuous.push('第' + i + '章 风起😀他说：“走吧。”然后转身……\n');
}
const continuousText = continuous.join('');
const continuousBytes = encoder.encode(continuousText);
let windowOffset = 0;
let windowCount = 0;
let joinedText = '';
while (windowOffset < continuousBytes.length) {
  const chunk = continuousBytes.subarray(windowOffset,
    Math.min(windowOffset + 64 * 1024, continuousBytes.length));
  const hasMore = windowOffset + chunk.length < continuousBytes.length;
  const usable = safeWindowLength(chunk, hasMore);
  assert.ok(usable > 0, 'window must retain at least one complete character');
  const windowBytes = chunk.subarray(0, usable);
  const windowSegments = splitWindowSegments(windowBytes,
    SEGMENT_TARGET_BYTES, 4000);
  const windowText = assertSegmentsCover(windowBytes, windowSegments,
    '64KiB window@' + windowOffset);
  assert.equal(windowText, decoder.decode(windowBytes),
    'window segments must decode back to the exact window bytes');
  joinedText += windowText;
  windowOffset += usable;
  windowCount += 1;
  assert.ok(windowCount < 10000, 'window loop must terminate');
}
assert.ok(windowCount > 1, 'test text must span multiple 64 KiB windows');
assert.equal(joinedText, continuousText,
  'concatenated windows must equal the original text');
assert.equal(joinedText.indexOf('\uFFFD'), -1,
  'no replacement characters from split UTF-8 windows');

console.log('reader segments: UTF-8 boundaries, fine offsets and re-anchoring passed');
