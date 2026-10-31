// SPDX-License-Identifier: GPL-3.0-only
// Pure pagination tests run with Node's built-in TypeScript type stripping.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { findForwardPageStart, isTextWindowByteBoundary,
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

function paginateAll(text, maxHeightPx) {
  const pages = [];
  let charOffset = 0;
  let byteOffset = 0;
  while (charOffset < text.length) {
    const page = paginateForward(text.slice(charOffset), byteOffset,
      maxHeightPx, measure);
    assert.ok(page.endByte > page.startByte,
      'every non-empty page must advance');
    assert.ok(isTextWindowByteBoundary(text, page.endByte),
      'each page end must be a UTF-8 and scalar boundary');
    assert.ok(!page.text.endsWith('\r'), 'a CRLF pair must stay intact');
    assert.ok(!/^[\uDC00-\uDFFF]/.test(page.text),
      'a page must not begin with a detached low surrogate');
    pages.push({ ...page, startChar: charOffset });
    charOffset += page.text.length;
    byteOffset = page.endByte;
  }
  assert.equal(pages.map((page) => page.text).join(''), text,
    'forward pagination must preserve every source code unit once');
  return pages;
}

function loaderFor(text, maxHeightPx, countCalls = () => {}) {
  return async (offset) => {
    countCalls();
    const index = charAtByte(text, offset);
    assert.ok(index >= 0, 'replay offsets must be valid UTF-8 boundaries');
    return paginateForward(text.slice(index), offset, maxHeightPx, measure);
  };
}

async function verifyRecoveryAtLayout(text, maxHeightPx) {
  const pages = paginateAll(text, maxHeightPx);
  const loadPageAt = loaderFor(text, maxHeightPx);
  for (let i = 1; i < pages.length; i++) {
    const checkpointIndex = Math.floor((i - 1) /
      READER_CHECKPOINT_PAGE_INTERVAL) * READER_CHECKPOINT_PAGE_INTERVAL;
    const recovered = await recoverPreviousPageFromCheckpoint(
      pages[i].startByte, pages[checkpointIndex].startByte, loadPageAt);
    assert.equal(recovered?.startByte, pages[i - 1].startByte,
      `previous page must match forward boundary at height ${maxHeightPx}`);
    assert.equal(recovered?.endByte, pages[i].startByte,
      'recovered page must end at the current forward boundary');
    assert.equal(recovered?.text, pages[i - 1].text,
      'replay must reproduce the original forward page text');
  }
  return pages;
}

const source = 'ab😀cdEFGHIJKLMN\n中文🙂一二三四五六七八九\r\n' +
  'last paragraph with latin and 中文 mixed together';
assert.equal(utf8ByteLength(source), Buffer.byteLength(source, 'utf8'));
await verifyRecoveryAtLayout(source, 30);

// This layout has short lines, explicit line breaks and blank paragraphs.
// A reverse suffix fit used to return byte 15 for the
// page ending at 28; forward replay identifies byte 16 as the real boundary.
const irregular = 'hcehdf\n\njeaiecebhbadaed\nahbi\ndj\na\nghfjaej\nhdd';
const irregularPages = await verifyRecoveryAtLayout(irregular, 20);
assert.ok(irregular.includes('\n\n'), 'fixture must include a blank paragraph');
const partialFillPages = paginateAll('one short final fragment', 20);
assert.ok(measure(partialFillPages[partialFillPages.length - 1].text) < 20,
  'fixture must include a forward page that does not fill the viewport');
const targetPage = irregularPages.find((page) => page.startByte === 28);
assert.ok(targetPage, 'the regression fixture must retain its target boundary');
const recoveredIrregular = await recoverPreviousPageFromCheckpoint(28, 0,
  loaderFor(irregular, 20));
assert.equal(recoveredIrregular?.startByte, 16,
  'previous-page recovery must keep the original forward boundary');
assert.equal(recoveredIrregular?.endByte, targetPage.startByte);
assert.equal(await recoverPreviousPageFromCheckpoint(29, 0,
  loaderFor(irregular, 20)), null,
  'a non-boundary target must not fabricate a previous page');

const layoutVariation = ('short\n\nlong paragraph with uneven wrapping\n' +
  '中英文混排🙂 and a different line length\n').repeat(12);
const boundariesByHeight = new Set();
for (const maxHeightPx of [10, 20, 30, 40]) {
  const pages = await verifyRecoveryAtLayout(layoutVariation, maxHeightPx);
  boundariesByHeight.add(pages.map((page) => page.startByte).join(','));
}
assert.ok(boundariesByHeight.size > 1,
  'different viewport heights must produce and recover distinct page layouts');

const longReplayText = ('A short line\n\nA longer paragraph for wrapping.\n').repeat(32);
const longReplayPages = paginateAll(longReplayText, 20);
assert.ok(longReplayPages.length > READER_CHECKPOINT_PAGE_INTERVAL,
  'the long replay fixture must exceed one checkpoint interval');
let replayedPageCount = 0;
const longReplay = await recoverPreviousPageFromCheckpoint(
  longReplayPages[longReplayPages.length - 1].startByte,
  longReplayPages[0].startByte,
  loaderFor(longReplayText, 20, () => { replayedPageCount++; }));
assert.equal(longReplay?.startByte,
  longReplayPages[longReplayPages.length - 2].startByte,
  'replay must recover an exact page across spans longer than one checkpoint');
assert.ok(replayedPageCount > READER_CHECKPOINT_PAGE_INTERVAL,
  'recovery must continue forward when no nearby checkpoint exists');

const restoredOffset = irregularPages[3].startByte + 1;
assert.equal(await findForwardPageStart(restoredOffset,
  loaderFor(irregular, 20)), irregularPages[3].startByte,
  'a saved offset inside a page must align to that forward page start');
assert.equal(await findForwardPageStart(irregularPages[3].startByte,
  loaderFor(irregular, 20)), irregularPages[3].startByte,
  'an existing page boundary must remain unchanged');
assert.equal(await findForwardPageStart(restoredOffset,
  loaderFor(irregular, 20), undefined, irregularPages[2].startByte),
  irregularPages[3].startByte,
  'a known chapter or pagination anchor must replay without scanning earlier pages');

let measureCalls = 0;
const longWindow = 'x'.repeat(100_000);
const boundedPage = paginateForward(longWindow, 0, 2048, (text) => {
  measureCalls++;
  return text.length;
});
assert.equal(boundedPage.text.length, 2048);
assert.ok(measureCalls <= 18,
  'page end must be found by bisection, not one measurement per character');

console.log('PASS: UTF-8 boundaries, forward recovery, reflow and bounded measurement');
