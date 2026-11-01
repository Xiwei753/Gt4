// SPDX-License-Identifier: GPL-3.0-only
// issue #17：手表章节索引的字节边界、乱序/越界防御与完整目录。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWatchLoader } from './helpers/watch_module_loader.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'suyue-chapters-'));
try {
  const load = createWatchLoader({ tmpDir: tmp,
    stubPath: join(tmp, 'unused-stub.mjs') });
  const Ch = await load('reader/Chapters.js');

  assert.deepEqual(Ch.normalizeChapters(null, 123),
    [{ title: '正文', offset: 0, length: 123 }],
    'old books without chapters stay readable as one continuous text');
  assert.deepEqual(Ch.normalizeChapters([], 0),
    [{ title: '正文', offset: 0, length: 0 }]);

  const normalized = Ch.normalizeChapters([
    { title: ' 第二章 ', offset: 20, length: 999 },
    { title: '第一章', offset: 0, length: 999 },
    { title: '重复起点', offset: 20, length: 1 },
    { title: '越界', offset: 80, length: 1 },
    { title: '非法', offset: -1, length: 1 },
    { title: '', offset: 60, length: 20 }
  ], 80);
  assert.deepEqual(normalized, [
    { title: '第一章', offset: 0, length: 20 },
    { title: '第二章', offset: 20, length: 40 },
    { title: '第 3 章', offset: 60, length: 20 }
  ], 'sort/dedupe/recompute contiguous byte ranges; drop out-of-range');

  const leading = Ch.normalizeChapters([
    { title: '第一章', offset: 12, length: 20 }
  ], 32);
  assert.deepEqual(leading, [
    { title: '正文', offset: 0, length: 12 },
    { title: '第一章', offset: 12, length: 20 }
  ], 'unindexed leading bytes remain reachable');

  const chapters = normalized;
  assert.equal(Ch.chapterIndexAt(chapters, 0), 0);
  assert.equal(Ch.chapterIndexAt(chapters, 19), 0);
  assert.equal(Ch.chapterIndexAt(chapters, 20), 1);
  assert.equal(Ch.chapterIndexAt(chapters, 79), 2);
  assert.equal(Ch.chapterLabel(chapters, -1), '第一章');
  assert.equal(Ch.chapterLabel(chapters, 1), '第二章');
  assert.equal(Ch.chapterLabel(chapters, 99), '第 3 章');

  const rows = Ch.chapterListRows(chapters, 1);
  assert.deepEqual(rows.map((r) => r.index), [0, 1, 2]);
  assert.deepEqual(rows.map((r) => r.current), [false, true, false]);
  assert.equal(rows[1].label, '▶ 第二章');
  assert.deepEqual(Ch.chapterListRows([], 0), [],
    'empty chapter lists stay empty');

  console.info('PASS: 章节字节索引、排序/越界防御与完整目录（issue #17）');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
