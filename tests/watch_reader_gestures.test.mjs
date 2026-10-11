// SPDX-License-Identifier: GPL-3.0-only
// Issue #10：阅读页手势/设置不触碰文件服务，独立检验 UI 事件逻辑。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSystemFileStub } from './helpers/system_file_stub.mjs';
import { createWatchLoader, writeRouterStub } from './helpers/watch_module_loader.mjs';

const temp = mkdtempSync(join(tmpdir(), 'suyue-read-ui-'));
const fsRoot = mkdtempSync(join(tmpdir(), 'suyue-read-ui-fs-'));
try {
  const load = createWatchLoader({
    tmpDir: temp,
    stubPath: writeSystemFileStub(temp, fsRoot),
    routerStubPath: writeRouterStub(temp)
  });
  const mod = await load('pages/reader/reader.js');
  function page() {
    const p = Object.create(mod.default);
    Object.assign(p, mod.default.data);
    p.isBusy = false;
    p.bookId = 'aaaaaaaaaaaaaaaa';
    p.fontSize = 20;
    p.lineHeightRatio = 1.55;
    p.settingsOpen = false;
    p.offset = 0;
    p.userMoved = false;
    let prev = 0;
    let next = 0;
    let repaint = 0;
    p.previousPage = () => { prev++; };
    p.nextPage = () => { next++; };
    p.loadPage = () => { repaint++; };
    p.__counts = () => ({ prev, next, repaint });
    return p;
  }
  const p = page();
  p.onReadingSwipe({ direction: 'up' });
  assert.equal(p.settingsOpen, false);
  p.onReadingSwipe({ direction: 'right' });
  assert.equal(p.settingsOpen, true,
    'right swipe must open full-screen settings');
  p.onSettingsSwipe({ direction: 'left' });
  assert.equal(p.settingsOpen, false,
    'left swipe from settings must return to reading');
  p.onReadingSwipe({ direction: 'left' });
  p.onReaderTap({ globalX: 350 });
  p.onReaderTap({ globalX: 80 });
  assert.deepEqual(p.__counts(), { prev: 1, next: 2, repaint: 0 });
  p.openSettings();
  p.onReaderTap({ globalX: 350 });
  assert.equal(p.__counts().next, 2,
    'reading gestures must not flip pages in settings');
  p.onSettingsSwipe({ direction: 'up' });
  assert.equal(p.settingsOpen, true);
  p.closeSettings();
  p.fontLarger();
  assert.equal(p.fontSize, 21);
  p.fontSmaller();
  assert.equal(p.fontSize, 20);
  p.spacingLooser();
  assert.equal(p.lineHeightRatio, 1.65);
  p.spacingTighter();
  assert.equal(p.lineHeightRatio, 1.55);
  assert.equal(p.__counts().repaint, 4);
  p.isBusy = true;
  p.onReaderTap({ globalX: 80 });
  assert.equal(p.__counts().prev, 1);
  console.info('PASS: 纯正文、右滑设置、左滑返回、点按翻页、设置调整');
} finally {
  rmSync(temp, { recursive: true, force: true });
  rmSync(fsRoot, { recursive: true, force: true });
}
