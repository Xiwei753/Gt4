// SPDX-License-Identifier: GPL-3.0-only
// Pure UTF-8 page-boundary logic. Text measurement is supplied by the ArkUI
// caller so this module can be exercised without HarmonyOS runtime objects.

export interface ReaderTextPage {
  startByte: number;
  endByte: number;
  text: string;
}

export interface ReaderPageBoundary {
  byteOffset: number;
  textOffset: number;
}

export interface ReaderTextMeasure {
  (text: string): number;
}

export interface ReaderPageLoader {
  (startByte: number): Promise<ReaderTextPage>;
}

export const READER_CHECKPOINT_PAGE_INTERVAL = 8;

interface TextBoundaries {
  bytes: number[];
  chars: number[];
}

function scalarWidth(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function codePointAt(text: string, index: number):
  { value: number; end: number } {
  const first = text.charCodeAt(index);
  if (first >= 0xd800 && first <= 0xdbff && index + 1 < text.length) {
    const second = text.charCodeAt(index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) {
      return {
        value: 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00),
        end: index + 2
      };
    }
  }
  return { value: first, end: index + 1 };
}

function textBoundaries(text: string): TextBoundaries {
  const bytes: number[] = [0];
  const chars: number[] = [0];
  let byteOffset = 0;
  let charOffset = 0;
  while (charOffset < text.length) {
    const scalar = codePointAt(text, charOffset);
    byteOffset += scalarWidth(scalar.value);
    charOffset = scalar.end;
    // Keep a CRLF pair together so a page break cannot turn one source line
    // ending into two visible line breaks.
    if (scalar.value === 0x0d && charOffset < text.length &&
        text.charCodeAt(charOffset) === 0x0a) {
      byteOffset += 1;
      charOffset += 1;
    }
    bytes.push(byteOffset);
    chars.push(charOffset);
  }
  return { bytes: bytes, chars: chars };
}

function heightFits(text: string, maxHeightPx: number,
  measureHeightPx: ReaderTextMeasure): boolean {
  const height = measureHeightPx(text);
  return Number.isFinite(height) && height <= maxHeightPx;
}

/** Finds the largest code-point prefix that fits one measured text viewport. */
export function paginateForward(text: string, startByte: number,
  maxHeightPx: number, measureHeightPx: ReaderTextMeasure): ReaderTextPage {
  const boundaries = textBoundaries(text);
  const units = boundaries.chars.length - 1;
  if (units <= 0) {
    return { startByte: startByte, endByte: startByte, text: '' };
  }

  let low = 0;
  let high = units;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = text.slice(0, boundaries.chars[middle]);
    if (heightFits(candidate, maxHeightPx, measureHeightPx)) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  // Always make progress when a viewport is shorter than one rendered line.
  const count = Math.max(1, low);
  const charEnd = boundaries.chars[count];
  return {
    startByte: startByte,
    endByte: startByte + boundaries.bytes[count],
    text: text.slice(0, charEnd)
  };
}

/** Replays a bounded number of forward pages to recover the exact prior page. */
export async function recoverPreviousPageFromCheckpoint(
  targetStartByte: number, checkpointByte: number,
  loadPageAt: ReaderPageLoader,
  maxPages: number = READER_CHECKPOINT_PAGE_INTERVAL):
  Promise<ReaderTextPage | null> {
  if (!Number.isInteger(targetStartByte) || !Number.isInteger(checkpointByte) ||
      checkpointByte < 0 || checkpointByte >= targetStartByte ||
      !Number.isInteger(maxPages) || maxPages < 1) return null;
  let cursor = checkpointByte;
  let pages = 0;
  while (cursor < targetStartByte && pages < maxPages) {
    const page = await loadPageAt(cursor);
    if (page.startByte !== cursor || page.endByte <= cursor) break;
    if (page.endByte === targetStartByte) return page;
    if (page.endByte > targetStartByte) break;
    cursor = page.endByte;
    pages += 1;
  }
  return null;
}

/** Returns true when byteOffset is a UTF-8 boundary in a decoded text window. */
export function isTextWindowByteBoundary(text: string,
  byteOffset: number): boolean {
  const boundaries = textBoundaries(text).bytes;
  for (let i = 0; i < boundaries.length; i++) {
    if (boundaries[i] === byteOffset) return true;
  }
  return false;
}

export function utf8ByteLength(text: string): number {
  const boundaries = textBoundaries(text).bytes;
  return boundaries[boundaries.length - 1];
}
