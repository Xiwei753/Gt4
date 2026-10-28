// SPDX-License-Identifier: GPL-3.0-only
// issue #17：长时间连续翻页 / 前台切换的压力回归。
// 目标不是宣称真机不卡，而是证明：
//   · 数千次翻页后 pending/isLoading 归零、历史仍有界；
//   · 文件回调丢失时阅读页能在有限时间内报错，不会永久卡死；
//   · 迟到回调不会在超时后第二次改写页面。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSystemFileStub } from './helpers/system_file_stub.mjs';
import { createWatchLoader, writeRouterStub, writeStorageStub }
  from './helpers/watch_module_loader.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'suyue-stress-'));
const disk = mkdtempSync(join(tmpdir(), 'suyue-stress-fs-'));
const bookId = 'cccccccccccccccc';
const bookPath = join(disk, 'gt4reader', 'books', bookId + '.txt');

function canvasRef() {
  const state = { gets: 0, draws: 0, paints: 0 };
  return {
    width: 452, height: 452, state,
    getContext() {
      state.gets++;
      return {
        fillRect() { state.paints++; },
        fillText() { state.draws++; },
        clearRect() {}
      };
    }
  };
}

try {
  mkdirSync(join(disk, 'gt4reader', 'books'), { recursive: true });
  // 约 2 MB：足够覆盖上千个 2048 字节窗口。
  writeFileSync(bookPath,
    Buffer.from('长篇小说正文与翻页压力。'.repeat(90000), 'utf8'));

  const stubPath = writeSystemFileStub(tmp, disk);
  const storageStubPath = writeStorageStub(tmp);
  const routerStubPath = writeRouterStub(tmp);
  const load = createWatchLoader({ tmpDir: tmp, stubPath,
    routerStubPath, storageStubPath });
  const BookStorage = await load('storage/BookStorage.js');
  const systemFile = (await import(stubPath)).default;

  // ---- 1. 文件接口永不回调：有限超时，且迟到回调不再生效 ----
  BookStorage.setOperationTimeout(30);
  {
    let calls = 0;
    const original = systemFile.readArrayBuffer;
    let lateSuccess = null;
    systemFile.readArrayBuffer = (o) => { lateSuccess = o.success; };
    const result = await new Promise((resolve) =>
      BookStorage.readBytes(bookId, 0, 100, (r) => {
        calls++;
        resolve(r);
      }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'timeout');
    assert.equal(calls, 1);
    // 超时后底层接口又返回：settle-once 必须丢弃。
    lateSuccess({ buffer: new Uint8Array([1, 2, 3]).buffer });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 1, 'late callback after timeout must be ignored');
    systemFile.readArrayBuffer = original;
  }

  // ---- 2. 阅读页遇到无回调读取：报错解锁，不永久停留在加载态 ----
  const reader = await load('pages/reader/reader.js');
  {
    BookStorage.setOperationTimeout(30);
    const stuck = Object.create(reader.default);
    Object.assign(stuck, reader.default.data);
    stuck.bookId = bookId;
    stuck.bundled = false;
    stuck.isBusy = false;
    stuck.isLoading = false;
    stuck.history = [];
    stuck.chapters = [];
    const original = systemFile.readArrayBuffer;
    systemFile.readArrayBuffer = () => {};
    try {
      stuck.loadPage(0);
      assert.equal(stuck.isLoading, true, 'read starts in-flight');
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(stuck.isLoading, false,
        'missing read callback must release the reading lock');
      assert.equal(stuck.isBusy, false);
      assert.equal(stuck.readingError, true);
      assert.ok(stuck.pageHint.indexOf('timeout') >= 0,
        'timeout must be reported, not hidden: ' + stuck.pageHint);
    } finally {
      systemFile.readArrayBuffer = original;
    }
  }

  // ---- 3. 连续翻页 + 周期性前后台切换 ----
  BookStorage.setOperationTimeout(1200);
  const press = Object.create(reader.default);
  Object.assign(press, reader.default.data);
  const ref = canvasRef();
  press.$refs = { readerCanvas: ref };
  press.bookId = bookId;
  press.bundled = false;
  press.canvasReady = true;
  press.isBusy = false;
  press.isLoading = false;
  press.progressReady = true;
  press.lastBookSaved = false;
  press.offset = 0;
  press.nextOffset = 0;
  press.history = [];
  press.settingsOpen = false;
  press.readingError = false;
  press.chapters = [];
  press.setChapters({ bytes: 2 * 1024 * 1024, chapters: [] });
  press.saves = 0;
  press.scheduleSave = function () { this.saves++; };

  press.loadPage(0);
  assert.equal(press.isLoading, false);
  const storage = (await import(storageStubPath)).default;
  assert.equal(storage.__values['suyue.last'], bookId,
    'successful first render must remember the book for cold resume');
  const savesAfterFirst = press.saves;
  press.onHide();
  press.onShow();
  assert.equal(press.saves, savesAfterFirst,
    'onShow redraw must not rewrite unchanged progress');
  let pages = 0;
  for (let i = 0; i < 4000; i++) {
    const before = press.offset;
    press.nextPage();
    if (press.offset <= before) break;
    pages++;
    if (i % 100 === 0) {
      press.onHide();
      press.onShow();
    }
  }
  assert.ok(pages > 1000,
    'stress fixture must exercise at least 1000 successful page flips, got ' + pages);
  assert.equal(press.pending, null, 'no page payload may accumulate');
  assert.equal(press.isLoading, false, 'no read may be left in flight');
  assert.equal(press.isBusy, false, 'page must be interactive at rest');
  assert.ok(press.history.length <= 60,
    'history must stay bounded, got ' + press.history.length);
  assert.ok(press.saves >= pages, 'every rendered page requested a save');
  assert.ok(ref.state.draws > pages, 'pages must actually paint');
  // ---- 4. 异步文件回调（非同步桩）+ 前后台交错：不积压、不重复应用 ----
  {
    const asyncPage = Object.create(reader.default);
    Object.assign(asyncPage, reader.default.data);
    const asyncRef = canvasRef();
    asyncPage.$refs = { readerCanvas: asyncRef };
    asyncPage.bookId = bookId;
    asyncPage.bundled = false;
    asyncPage.canvasReady = true;
    asyncPage.isBusy = false;
    asyncPage.isLoading = false;
    asyncPage.progressReady = true;
    asyncPage.lastBookSaved = true;
    asyncPage.offset = 0;
    asyncPage.nextOffset = 0;
    asyncPage.history = [];
    asyncPage.settingsOpen = false;
    asyncPage.readingError = false;
    asyncPage.chapters = [];
    asyncPage.setChapters({ bytes: 2 * 1024 * 1024, chapters: [] });
    asyncPage.saves = 0;
    asyncPage.scheduleSave = function () { this.saves++; };
    const original = systemFile.readArrayBuffer;
    let reads = 0;
    let applied = 0;
    systemFile.readArrayBuffer = (o) => {
      reads++;
      const delay = (reads % 5) + 1;
      setTimeout(() => original(o), delay);
    };
    try {
      asyncPage.loadPage(0);
      for (let i = 0; i < 30; i++) {
        for (let wait = 0; wait < 50 && asyncPage.isLoading; wait++) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        assert.equal(asyncPage.isLoading, false,
          'async read must settle without leaving a stuck lock');
        if (asyncPage.offset > 0) applied++;
        const before = asyncPage.offset;
        // 在读取在途时切前后台，验证 onShow 不会叠加第二次读取。
        asyncPage.nextPage();
        if (i % 4 === 0) {
          asyncPage.onHide();
          asyncPage.onShow();
        }
        if (asyncPage.offset <= before && !asyncPage.isLoading) {
          // 可能是末页；继续只为验证没有积压。
        }
      }
      for (let wait = 0; wait < 50 && asyncPage.isLoading; wait++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assert.equal(asyncPage.pending, null, 'async callbacks must not accumulate');
      assert.equal(asyncPage.isLoading, false);
      assert.ok(asyncRef.state.paints <= applied + 2,
        'each async page may paint at most once, got paints=' +
        asyncRef.state.paints + ' applied=' + applied);
      assert.ok(reads <= applied + 2,
        'onShow redraw must not issue duplicate reads: reads=' + reads);
      assert.ok(asyncPage.history.length <= 60,
        'async history must stay bounded');
    } finally {
      systemFile.readArrayBuffer = original;
    }
  }

  console.info('PASS: 连续 ' + pages + ' 次翻页/前台切换后资源有界，' +
    '异步回调不积压，文件回调丢失会超时（issue #17；真机卡顿仍需实测）');
} finally {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(disk, { recursive: true, force: true });
}
