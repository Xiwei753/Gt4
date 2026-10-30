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

export interface ReaderPreviousPageFallback {
  (targetStartByte: number): Promise<ReaderTextPage | null>;
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

/**
 * Recovers the largest fitting suffix that ends at a known forward page
 * boundary. The caller may enlarge its bounded read window when this returns
 * the window start and more source text exists before it.
 */
export function paginateBackward(text: string, windowStartByte: number,
  targetEndByte: number, maxHeightPx: number,
  measureHeightPx: ReaderTextMeasure): ReaderTextPage | null {
  const boundaries = textBoundaries(text);
  const targetByte = targetEndByte - windowStartByte;
  let targetUnit = -1;
  for (let i = 0; i < boundaries.bytes.length; i++) {
    if (boundaries.bytes[i] === targetByte) {
      targetUnit = i;
      break;
    }
  }
  if (targetUnit <= 0) return null;

  let low = 0;
  let high = targetUnit;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = text.slice(boundaries.chars[middle],
      boundaries.chars[targetUnit]);
    if (heightFits(candidate, maxHeightPx, measureHeightPx)) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  const startUnit = Math.min(targetUnit - 1, low);
  const charStart = boundaries.chars[startUnit];
  const charEnd = boundaries.chars[targetUnit];
  return {
    startByte: windowStartByte + boundaries.bytes[startUnit],
    endByte: targetEndByte,
    text: text.slice(charStart, charEnd)
  };
}

/**
 * Replays forward from a nearby page checkpoint to recover an exact previous
 * page boundary. The replay bound matches the checkpoint interval; older
 * anchors fall back to the measured suffix search.
 */
export async function recoverPreviousPageFromCheckpoint(
  targetStartByte: number, checkpointByte: number,
  loadPageAt: ReaderPageLoader,
  fallback: ReaderPreviousPageFallback): Promise<ReaderTextPage | null> {
  let cursor = checkpointByte;
  let pages = 0;
  while (cursor < targetStartByte &&
      pages < READER_CHECKPOINT_PAGE_INTERVAL) {
    const page = await loadPageAt(cursor);
    if (page.startByte !== cursor || page.endByte <= cursor) break;
    if (page.endByte === targetStartByte) return page;
    if (page.endByte > targetStartByte) break;
    cursor = page.endByte;
    pages += 1;
  }
  return fallback(targetStartByte);
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
