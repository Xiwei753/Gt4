// SPDX-License-Identifier: GPL-3.0-only
// issue #17 review：长章节目录必须分片，单条 Wear Engine P2P 消息 <=4096 字节。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'suyue-chunk-'));
const source = readFileSync(join('harmony', 'entry', 'src', 'main', 'ets',
  'model', 'ChapterChunks.js'), 'utf8');
const modPath = join(tmp, 'ChapterChunks.mjs');
writeFileSync(modPath, source);

try {
  const { splitChapterChunks, MAX_MESSAGE_BYTES, TARGET_CHAPTER_BYTES,
    CHAPTER_TOO_LARGE } = await import(modPath);
  const encoder = new TextEncoder();
  const transferId = 't'.repeat(32);
  const bookId = 'a'.repeat(16);
  const measure = (group, index, totalHint) =>
    encoder.encode(JSON.stringify({
      v: 0, type: 'CHAPTERS', transferId, bookId,
      index, total: totalHint, chapters: group
    })).length;

  function chapters(count) {
    let offset = 0;
    return Array.from({ length: count }, (_, i) => {
      const title = '第' + (i + 1) +
        '章 这是用于校验 4096 字节 P2P 消息上限的中文章节标题';
      const length = encoder.encode(title).length + 100;
      const chapter = { title, offset, length };
      offset += length;
      return chapter;
    });
  }

  function check(count) {
    const list = chapters(count);
    const groups = splitChapterChunks(list, (group, index, totalHint) =>
      encoder.encode(JSON.stringify({
        v: 0, type: 'CHAPTERS', transferId, bookId,
        index, total: totalHint, chapters: group
      })).length);
    assert.ok(groups.length > 1, count + ' chapters must be split');
    assert.equal(groups.reduce((n, g) => n + g.length, 0), count,
      'every chapter must appear exactly once');
    const fullMeta = JSON.stringify({
      v: 0, type: 'BOOK_META', transferId, bookId,
      title: '五百章长目录', encoding: 'utf-8', bytes: 1,
      sha256: '0'.repeat(64), chunks: 1, chunkBytes: 1,
      chapters: list
    });
    assert.ok(encoder.encode(fullMeta).length > MAX_MESSAGE_BYTES,
      'fixture must exercise the real >4096-byte BOOK_META failure');
    const chunkedMeta = JSON.stringify({
      v: 0, type: 'BOOK_META', transferId, bookId,
      title: '五百章长目录', encoding: 'utf-8', bytes: 1,
      sha256: '0'.repeat(64), chunks: 1, chunkBytes: 1,
      chapters: [], chapterChunks: groups.length
    });
    assert.ok(encoder.encode(chunkedMeta).length <= MAX_MESSAGE_BYTES,
      'chunked BOOK_META must fit the P2P limit');
    const messages = groups.map((group, index) =>
      JSON.stringify({ v: 0, type: 'CHAPTERS', transferId, bookId,
        index, total: groups.length, chapters: group }));
    for (const message of messages) {
      const size = encoder.encode(message).length;
      assert.ok(size <= MAX_MESSAGE_BYTES,
        'CHAPTERS must fit 4096 bytes, got ' + size);
      assert.ok(size <= TARGET_CHAPTER_BYTES + 512,
        'chunk should stay near the safety target, got ' + size);
    }
    assert.match(messages[0], /"type":"CHAPTERS"/);
    assert.match(messages[0], /"total":\d+/);
  }

  check(100);
  check(500);
  {
    const huge = [{ title: '超'.repeat(1500), offset: 0, length: 100 }];
    assert.ok(measure(huge, 0, 1) > MAX_MESSAGE_BYTES,
      'fixture must exceed the message limit as a single chapter');
    assert.throws(
      () => splitChapterChunks(huge, measure),
      (error) => error && error.message === CHAPTER_TOO_LARGE,
      'oversized single chapter must fail explicitly, not be truncated');
  }
  console.info('PASS: 100/500 chapter catalogs are split into <=4096-byte ' +
    'CHAPTERS messages; oversized single chapter fails explicitly');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
