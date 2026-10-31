// SPDX-License-Identifier: GPL-3.0-only
// Pure pagination tests run with Node's built-in TypeScript type stripping.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { isTextWindowByteBoundary, paginateForward,
  paginatePreviousToBoundary, recoverPreviousPageFromCheckpoint,
  formatReaderParagraphs, utf8ByteLength, READER_CHECKPOINT_PAGE_INTERVAL }
  from '../harmony/entry/src/main/ets/model/ReaderPagination.ts';

const lineHeight = 10;
const columns = 8;

assert.equal(formatReaderParagraphs('ABC\nDEF'), 'ABC\n\nDEF');
assert.equal(formatReaderParagraphs('ABC\r\nDEF'), 'ABC\r\n\r\nDEF');
assert.equal(formatReaderParagraphs('ABC\rDEF'), 'ABC\r\rDEF');
assert.equal(formatReaderParagraphs('ABC\n\nDEF'), 'ABC\n\nDEF');
assert.equal(formatReaderParagraphs('ABC\n  \nDEF'), 'ABC\n  \nDEF');
assert.equal(formatReaderParagraphs('ABC\n　\t\nDEF'), 'ABC\n　\t\nDEF');
assert.equal(formatReaderParagraphs('ABC\n'), 'ABC\n');
assert.equal(formatReaderParagraphs('\nDEF'), '\nDEF');

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

const source = 'ab😀cdEFGHIJKLMN\n中文🙂一二三四五六七八九\r\n' +
  'last paragraph with latin and 中文 mixed together';
assert.equal(utf8ByteLength(source), Buffer.byteLength(source, 'utf8'));
const sourcePages = paginateAll(source, 30);
assert.ok(sourcePages.length > 1, 'the Unicode fixture must span pages');
const unicodeTarget = sourcePages[1].startByte;
const unicodeTargetChar = charAtByte(source, unicodeTarget);
const unicodePrevious = paginatePreviousToBoundary(source.slice(0,
  unicodeTargetChar), 0, unicodeTarget, 30, measure);
assert.ok(unicodePrevious !== null,
  'local previous paging must support mixed Unicode text');
assert.equal(unicodePrevious.endByte, unicodeTarget);
assert.ok(!/^[\uDC00-\uDFFF]/.test(unicodePrevious.text) &&
  !/[\uD800-\uDBFF]$/.test(unicodePrevious.text),
  'a local previous page must not split a Unicode surrogate pair');

// This fixture covers short lines, blank paragraphs and uneven local suffixes.
const irregular = 'hcehdf\n\njeaiecebhbadaed\nahbi\ndj\na\nghfjaej\nhdd';
const irregularPages = paginateAll(irregular, 20);
assert.ok(irregular.includes('\n\n'), 'fixture must include a blank paragraph');
const partialFillPages = paginateAll('one short final fragment', 20);
assert.ok(measure(partialFillPages[partialFillPages.length - 1].text) < 20,
  'fixture must include a forward page that does not fill the viewport');
const targetPage = irregularPages.find((page) => page.startByte === 28);
assert.ok(targetPage, 'the regression fixture must retain its target boundary');
const previousIrregular = paginatePreviousToBoundary(irregular.slice(0, 28),
  0, targetPage.startByte, 20, measure);
assert.ok(previousIrregular !== null,
  'local reverse paging must produce a page for a known current boundary');
assert.equal(previousIrregular.endByte, targetPage.startByte,
  'the reverse page must end exactly where the current page begins');
assert.ok(previousIrregular.startByte > 0,
  'the local reverse page must not fall back to the book start');
const nextIrregular = paginateForward(irregular.slice(28), 28, 20, measure);
const expectedRoundTripStart = charAtByte(irregular, previousIrregular.startByte);
const expectedRoundTripEnd = charAtByte(irregular, nextIrregular.endByte);
assert.equal(previousIrregular.text + nextIrregular.text,
  irregular.slice(expectedRoundTripStart, expectedRoundTripEnd),
  'previous then next must preserve adjacent text without gaps or duplicates');

const layoutVariation = ('short\n\nlong paragraph with uneven wrapping\n' +
  '中英文混排🙂 and a different line length\n').repeat(12);
const boundariesByHeight = new Set();
for (const maxHeightPx of [10, 20, 30, 40]) {
  const pages = paginateAll(layoutVariation, maxHeightPx);
  boundariesByHeight.add(pages.map((page) => page.startByte).join(','));
}
assert.ok(boundariesByHeight.size > 1,
  'different viewport heights must produce distinct page layouts');

let measureCalls = 0;
const longWindow = 'x'.repeat(100_000);
const boundedPage = paginateForward(longWindow, 0, 2048, (text) => {
  measureCalls++;
  return text.length;
});
assert.equal(boundedPage.text.length, 2048);
assert.ok(measureCalls <= 18,
  'page end must be found by bisection, not one measurement per character');

// A resumed no-chapter TXT page in the second half must recover locally, then
// return to the exact saved page on the next action. Work stays window-bounded.
const noChapterText = ('line content with wrapping and text\n').repeat(12_000);
const savedOffset = 250_000;
const savedCharOffset = charAtByte(noChapterText, savedOffset);
assert.ok(savedCharOffset > noChapterText.length / 2,
  'the resumed fixture must be in the second half of a no-chapter book');
let checkpointReads = 0;
const checkpointResult = await recoverPreviousPageFromCheckpoint(savedOffset,
  0, async (offset) => {
    checkpointReads++;
    const charOffset = charAtByte(noChapterText, offset);
    return paginateForward(noChapterText.slice(charOffset), offset, 20, measure);
  });
assert.equal(checkpointResult, null,
  'a stale root checkpoint must fall through to local previous paging');
assert.equal(checkpointReads, READER_CHECKPOINT_PAGE_INTERVAL,
  'stale checkpoint replay must stop at its fixed budget');
const windowStartByte = Math.max(0, savedOffset - 64 * 1024);
const windowStartChar = charAtByte(noChapterText, windowStartByte);
let reverseMeasureCalls = 0;
const previousAtResume = paginatePreviousToBoundary(
  noChapterText.slice(windowStartChar, savedCharOffset), windowStartByte,
  savedOffset, 20, (text) => {
    reverseMeasureCalls++;
    return measure(text);
  });
assert.ok(previousAtResume !== null && previousAtResume.startByte > 0,
  'immediate previous from a late resume must not jump to book start');
assert.equal(previousAtResume.endByte, savedOffset,
  'the local previous page must end at the saved position');
assert.ok(reverseMeasureCalls <= 18,
  'local previous-page measurement must stay bounded by the 64 KiB window');
const resumedPage = paginateForward(noChapterText.slice(savedCharOffset,
  savedCharOffset + 64 * 1024), savedOffset, 20, measure);
const nextPageStarts = [previousAtResume.endByte];
const nextStart = nextPageStarts.pop();
const resumedAgain = paginateForward(noChapterText.slice(nextStart,
  nextStart + 64 * 1024), nextStart, 20, measure);
assert.deepEqual(resumedAgain, resumedPage,
  'previous followed by next must restore the exact resumed page');

console.log('PASS: UTF-8 boundaries, local previous paging and bounded measurement');
