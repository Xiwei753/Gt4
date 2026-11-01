// SPDX-License-Identifier: GPL-3.0-only
// issue #17：阅读设置里的章节面板与按字节跳转。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSystemFileStub } from './helpers/system_file_stub.mjs';
import { createWatchLoader, writeRouterStub, writeStorageStub }
  from './helpers/watch_module_loader.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'suyue-rchapters-'));
const disk = mkdtempSync(join(tmpdir(), 'suyue-rchapters-fs-'));
try {
  const load = createWatchLoader({ tmpDir: tmp,
    stubPath: writeSystemFileStub(tmp, disk),
    routerStubPath: writeRouterStub(tmp),
    storageStubPath: writeStorageStub(tmp) });
  const mod = await load('pages/reader/reader.js');
  const p = Object.create(mod.default);
  Object.assign(p, mod.default.data);
  p.offset = 25;
  p.isBusy = false;
  p.settingsOpen = false;
  p.chapterOpen = false;
  p.calls = [];
  p.loadPage = function (offset, previous) {
    this.calls.push([offset, previous]);
  };
  p.setChapters({
    bytes: 80,
    chapters: [
      { title: '第一章', offset: 0, length: 20 },
      { title: '第二章', offset: 20, length: 40 },
      { title: '第三章', offset: 60, length: 20 }
    ]
  });
  assert.equal(p.hasChapters, true);
  assert.equal(p.chapterLabel, '第二章');
  assert.deepEqual(p.chapterRows.map((r) => r.index), [0, 1, 2]);

  p.openChapters();
  assert.equal(p.settingsOpen, true);
  assert.equal(p.chapterOpen, true);
  p.jumpChapter(2);
  assert.deepEqual(p.calls[0], [60, 25],
    'chapter jump must pass the real byte offset and previous position');
  assert.equal(p.settingsOpen, false, 'jump returns to reading');
  assert.equal(p.chapterOpen, false);
  p.offset = 60; // 模拟跳转页渲染完成后的真实位置。

  p.calls.length = 0;
  p.previousChapter();
  assert.deepEqual(p.calls[0], [20, 60],
    'previous chapter must use the current saved offset as history');

  p.calls.length = 0;
  p.nextChapter();
  assert.equal(p.calls.length, 0,
    'next chapter at the last chapter must be a no-op');

  p.openSettings();
  assert.equal(p.chapterOpen, false);
  p.openChapters();
  p.closeChapters();
  assert.equal(p.settingsOpen, true, 'chapter panel returns to settings');
  assert.equal(p.chapterOpen, false);

  const plain = Object.create(mod.default);
  Object.assign(plain, mod.default.data);
  plain.setChapters({ bytes: 10, chapters: [] });
  assert.equal(plain.hasChapters, false);
  plain.openChapters();
  assert.equal(plain.settingsOpen, false,
    'single/no-chapter books keep the old settings flow');

  // issue #27 review：65 章 TXT 可完整打开目录并跳转到末章；
  // 仅浏览完整目录不产生 loadPage。
  const many = Object.create(mod.default);
  Object.assign(many, mod.default.data);
  many.offset = 0;
  many.isBusy = false;
  many.calls = [];
  many.loadPage = function (offset, previous) {
    this.calls.push([offset, previous]);
  };
  const list = Array.from({ length: 65 }, (_, i) => ({
    title: '第' + (i + 1) + '章', offset: i * 10, length: 10
  }));
  many.setChapters({ bytes: 650, chapters: list });
  many.openChapters();
  assert.equal(many.chapterRows.length, 65,
    'full chapter list must be available for native scrolling');
  assert.equal(many.chapterRows[64].title, '第65章');
  assert.equal(many.calls.length, 0,
    'opening the full list must not jump or load a page');
  many.jumpChapter(64);
  assert.deepEqual(many.calls[0], [640, 0],
    'clicking chapter 65 must jump to its byte offset');
  assert.equal(many.settingsOpen, false);

  console.info('PASS: 完整章节列表使用字节偏移跳转且不重开旧书 UI（issue #27）');
} finally {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(disk, { recursive: true, force: true });
}
