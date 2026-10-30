// SPDX-License-Identifier: GPL-3.0-only
// Pure pagination tests run with Node's built-in TypeScript type stripping.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { isTextWindowByteBoundary, paginateBackward,
  paginateForward, recoverPreviousPageFromCheckpoint, utf8ByteLength,
  READER_CHECKPOINT_PAGE_INTERVAL }
  from '../harmony/entry/src/main/ets/model/ReaderPagination.ts';

const lineHeight = 10;
const columns = 8;
function measure(text) {
  let lines = 1;
  let used = 0;
  for (let i = 0; i < text.length;) {
    const first = text.charCodeAt(i);
    let width = 1;
    if (first >= 0xd800 && first <= 0xdbff && i + 1 < text.length &&
        text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      width = 2;
    }
    const scalar = text.slice(i, i + width);
    i += width;
    if (scalar === '\r' && text.charAt(i) === '\n') {
      i += 1;
      lines++;
      used = 0;
    } else if (scalar === '\n') {
      lines++;
      used = 0;
    } else {
      if (used === columns) {
        lines++;
        used = 0;
      }
      used++;
    }
  }
  return lines * lineHeight;
}

const source = 'ab😀cdEFGHIJKLMN\n中文🙂一二三四五六七八九\r\n' +
  'last paragraph with latin and 中文 mixed together';
assert.equal(utf8ByteLength(source), Buffer.byteLength(source, 'utf8'));

function charAtByte(text, targetByte) {
  let bytes = 0;
  for (let index = 0; index < text.length;) {
    if (bytes === targetByte) return index;
    const first = text.charCodeAt(index);
    const width = first >= 0xd800 && first <= 0xdbff &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff ? 2 : 1;
    const scalar = text.slice(index, index + width);
    bytes += Buffer.byteLength(scalar, 'utf8');
    index += width;
  }
  return bytes === targetByte ? text.length : -1;
}

async function loadPageAt(offset) {
  const index = charAtByte(source, offset);
  assert.ok(index >= 0, 'checkpoint offsets must be valid source boundaries');
  return paginateForward(source.slice(index), offset, 30, measure);
}

const pages = [];
let remaining = source;
let startByte = 0;
while (remaining.length > 0) {
  const page = paginateForward(remaining, startByte, 30, measure);
  assert.ok(page.endByte > page.startByte,
    'every non-empty page must advance');
  assert.ok(isTextWindowByteBoundary(source, page.endByte),
    'each page end must be a UTF-8 and scalar boundary');
  assert.ok(!page.text.endsWith('\r'), 'a CRLF pair must stay intact');
  assert.ok(!/^[\uDC00-\uDFFF]/.test(page.text),
    'a page must not begin with a detached low surrogate');
  pages.push({ ...page, startChar: source.length - remaining.length });
  remaining = remaining.slice(page.text.length);
  startByte = page.endByte;
}
assert.equal(pages.map((page) => page.text).join(''), source,
  'forward pagination must preserve every source code unit once');
for (let i = 1; i < pages.length; i++) {
  const priorText = source.slice(0, pages[i].startChar);
  const priorPage = paginateBackward(priorText, 0, pages[i].startByte,
    30, measure);
  assert.ok(priorPage);
  const replayed = await loadPageAt(priorPage.startByte);
  assert.equal(replayed.endByte, pages[i].startByte,
    'the reverse fallback must advance back to its known target boundary');
  assert.equal(replayed.text, priorPage.text,
    'a reverse fallback page must be stable when advanced');

  const checkpointIndex = Math.max(0,
    Math.floor((i - 1) / READER_CHECKPOINT_PAGE_INTERVAL) *
      READER_CHECKPOINT_PAGE_INTERVAL);
  const recovered = await recoverPreviousPageFromCheckpoint(
    pages[i].startByte, pages[checkpointIndex].startByte, loadPageAt,
    async (target) => paginateBackward(source.slice(0,
      charAtByte(source, target)), 0, target, 30, measure));
  assert.equal(recovered?.startByte, pages[i - 1].startByte,
    'checkpoint replay must recover the exact previous UTF-8 offset');
  assert.equal(recovered?.text, pages[i - 1].text,
    'checkpoint replay must preserve the original forward page');
}

let measureCalls = 0;
const longWindow = 'x'.repeat(100_000);
const boundedPage = paginateForward(longWindow, 0, 2048, (text) => {
  measureCalls++;
  return text.length;
});
assert.equal(boundedPage.text.length, 2048);
assert.ok(measureCalls <= 18,
  'page end must be found by bisection, not one measurement per character');

console.log('PASS: UTF-8 page boundaries, reversibility and bounded measurement');
