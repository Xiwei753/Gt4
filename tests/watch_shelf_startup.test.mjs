// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/watch_shelf_startup.test.mjs
// issue #10：**开机即书架**。
//
// 验收点：
//   1. onInit 同步返回时书架已经可用，且**启动阶段不读 books.json**；
//   2. 索引缺失/损坏不会卡住或清空书架（数据安全：不删原索引）；
//   3. 外部（手机传书）书目在后台合入，失败也不影响内置书架；
//   4. 本地文件接收成功触发书架刷新，失败只更新提示；
//   5. 二次确认删除；内置书籍不可删。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, existsSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSystemFileStub } from './helpers/system_file_stub.mjs';
import { createWatchLoader, writeWearEngineStub,
  writeRouterStub, writeStorageStub } from './helpers/watch_module_loader.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'suyue-shelf-'));
const sandbox = mkdtempSync(join(tmpdir(), 'suyue-shelffs-'));
const stubPath = writeSystemFileStub(tmp, sandbox);
const wearengineStubPath = writeWearEngineStub(tmp);
const routerStubPath = writeRouterStub(tmp);
const storageStubPath = writeStorageStub(tmp);
const load = createWatchLoader({ tmpDir: tmp, stubPath,
  wearengineStubPath, routerStubPath, storageStubPath });

const pageMod = await load('pages/index/index.js');
const BookStorage = await load('storage/BookStorage.js');
const LibraryIndex = await load('storage/LibraryIndex.js');
const systemFile = (await import(stubPath)).default;
const router = (await import(routerStubPath)).default;
const storage = (await import(storageStubPath)).default;

BookStorage.setOperationTimeout(120);
LibraryIndex.setQueueTimeout(60);

const root = join(sandbox, 'gt4reader');
const indexFile = join(root, 'books.json');
const bookFile = (id) => join(root, 'books', id + '.txt');
const clearLibrary = () => rmSync(root, { recursive: true, force: true });

const waitFor = async (fn, timeoutMs = 2000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 4));
  }
  return fn();
};

function newPage() {
  const p = Object.create(pageMod.default);
  p.data = Object.assign({}, pageMod.default.data);
  p.token = 0;
  p.external = [];
  return p;
}


// ---- 1. 启动同步渲染内置书架；文件层完全不响应也不影响 ----
{
  clearLibrary();
  // 1a. 书架在外部加载开始之前就已经渲染好。
  const page = newPage();
  let booksAtLoadStart = null;
  let statusAtLoadStart = null;
  page.loadExternal = function () {
    booksAtLoadStart = this.books.slice();
    statusAtLoadStart = this.status;
  };
  page.onInit();
  assert.equal(booksAtLoadStart.length, 0,
    'built-in shelf must be rendered BEFORE external load starts');
  assert.equal(statusAtLoadStart, '书架为空：可从手机传书',
    'empty shelf status must be shown synchronously');
  assert.equal(page.books.length, 0);
  assert.equal(page.initFailed, undefined,
    'legacy initFailed state machine must be gone');

  // 1b. 文件层完全死掉（不回调）：onInit 仍同步返回，书架照常。
  const dead = newPage();
  const oAccess = systemFile.access;
  const oReadText = systemFile.readText;
  const oReadArrayBuffer = systemFile.readArrayBuffer;
  const oGet = systemFile.get;
  systemFile.access = () => {};
  systemFile.readText = () => {};
  systemFile.readArrayBuffer = () => {};
  systemFile.get = () => {};
  try {
    dead.onInit();
    assert.equal(dead.status, '书架为空：可从手机传书',
      'a never-callback file layer must not block the shelf');
    assert.equal(dead.books.length, 0);
  } finally {
    systemFile.access = oAccess;
    systemFile.readText = oReadText;
    systemFile.readArrayBuffer = oReadArrayBuffer;
    systemFile.get = oGet;
  }
  console.info('  [1] 启动同步渲染书架；文件层不响应也不影响 ✓');
}

// ---- 2. 索引损坏：不卡死、不清空、不删原索引 ----
{
  clearLibrary();
  mkdirSync(join(root, 'books'), { recursive: true });
  writeFileSync(indexFile, '{ this is not json');
  const page = newPage();
  page.onInit();
  assert.equal(page.books.length, 0, 'corrupt index must not break shelf');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(page.books.length, 0);
  assert.ok(existsSync(indexFile),
    'a corrupt index must never be deleted/cleared automatically');
  assert.equal(page.status, '书架为空：可从手机传书');
  console.info('  [2] 索引损坏：书架照常，原索引未被删除 ✓');
}

// ---- 3. 外部书目后台合入 + 打开 + 二次确认删除 ----
{
  clearLibrary();
  mkdirSync(join(root, 'books'), { recursive: true });
  const ext = 'aaaaaaaaaaaaaaaa';
  writeFileSync(bookFile(ext), 'external book');
  writeFileSync(indexFile, JSON.stringify([
    { bookId: ext, title: '外来书', bytes: 13, addedAt: 1 }
  ]));
  router.__calls.length = 0;
  const page = newPage();
  page.onInit();
  // 文件桩是同步回调，外部书目可能已即时合入；关键是后台合入、
  // 不阻塞启动（见用例 1）。这里等待最终一致即可。
  await waitFor(() => page.books.length === 1, 1500);
  assert.equal(page.books[0].bookId, ext);
  assert.equal(page.books[0].title, '外来书');
  assert.notEqual(page.books[0].origin, 'builtin');
  assert.equal(page.status, '书架就绪（1 本）');
  // 打开：按唯一 bookId（不是数组下标），且必须用 router.replace
  page.openBook(ext);
  assert.equal(router.__calls[0][0], 'replace');
  assert.equal(router.__calls[0][1], 'pages/reader/reader');
  assert.equal(router.__calls[0][2].bookId, ext);
  // 参数无效必须给出明确错误，而不是静默返回
  const beforeInvalid = router.__calls.length;
  page.openBook(0);
  page.openBook({ target: {} });
  assert.equal(router.__calls.length, beforeInvalid,
    'invalid bookId must not navigate');
  assert.ok(page.status.indexOf('E_BOOK_ID_INVALID') !== -1,
    'invalid bookId must be reported; status=' + page.status);
  // 二次确认删除：第一次提示，第二次执行
  page.askDelete(ext);
  assert.ok(page.status.indexOf('再次点击') === 0);
  page.askDelete(ext);
  await waitFor(() => page.books.length === 0, 1500);
  assert.equal(page.books.length, 0,
    'second confirm removes the book; status=' + page.status);
  console.info('  [3] 外部书目后台合入 / 打开 / 二次确认删除 ✓');
}

// ---- 4. 本地入库结果：成功刷新书架，失败不假报成功 ----
{
  clearLibrary();
  const page = newPage();
  let refreshes = 0;
  page.loadExternal = function () { refreshes++; };
  page.onInit();
  const beforeResult = refreshes;
  page.handleReceiveStatus(JSON.stringify(
    { type: 'RESULT', ok: false, reason: 'E_BUSY' }));
  assert.equal(page.transferStatus, '传书失败：E_BUSY');
  assert.equal(refreshes, beforeResult,
    'failed local receive must not refresh as a successful import');
  page.handleReceiveStatus(JSON.stringify(
    { type: 'RESULT', ok: true }));
  assert.equal(page.transferStatus, '接收成功，已加入书架');
  assert.equal(refreshes, beforeResult + 1,
    'successful local receive must refresh the external shelf');
  assert.equal(page.books.length, 0);
  page.handleReceiveStatus('纯文本提示');
  assert.equal(page.transferStatus, '纯文本提示');
  console.info('  [4] 本地入库成功刷新书架，失败不误报 ✓');
}

// ---- 5. 冷启动自动续读：只认仍存在的书，显式返回不重开 ----
{
  clearLibrary();
  mkdirSync(join(root, 'books'), { recursive: true });
  const ext = 'bbbbbbbbbbbbbbbb';
  writeFileSync(bookFile(ext), 'resume me');
  writeFileSync(indexFile, JSON.stringify([
    { bookId: ext, title: '续读书', bytes: 9, addedAt: 1 }
  ]));
  for (const key of Object.keys(storage.__values)) {
    delete storage.__values[key];
  }
  storage.__values['suyue.last'] = ext;
  router.__calls.length = 0;
  const page = newPage();
  page.onInit();
  await waitFor(() => router.__calls.length > 0, 1500);
  assert.equal(router.__calls.length, 1,
    'cold start must auto-open the last book exactly once');
  assert.equal(router.__calls[0][1], 'pages/reader/reader');
  assert.equal(router.__calls[0][2].bookId, ext);
  page.onShow();
  page.onShow();
  assert.equal(router.__calls.length, 1,
    'lifecycle onShow must not route again after auto-resume');
  console.info('  [5a] 冷启动自动续读且 onShow 不重复进入 ✓');

  // 被删除/文件不可访问：正常留在书架，不永久等待。
  clearLibrary();
  mkdirSync(join(root, 'books'), { recursive: true });
  writeFileSync(indexFile, JSON.stringify([
    { bookId: ext, title: '已删除', bytes: 9, addedAt: 1 }
  ]));
  router.__calls.length = 0;
  const missing = newPage();
  missing.onInit();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(router.__calls.length, 0,
    'missing last book must stay on the shelf');
  assert.equal(missing.status, '书架为空：可从手机传书');
  console.info('  [5b] 上次书籍被删除时降级回书架 ✓');

  // 从阅读页显式返回：resume=0，不得再次自动打开。
  clearLibrary();
  mkdirSync(join(root, 'books'), { recursive: true });
  writeFileSync(bookFile(ext), 'resume me');
  writeFileSync(indexFile, JSON.stringify([
    { bookId: ext, title: '续读书', bytes: 9, addedAt: 1 }
  ]));
  router.__calls.length = 0;
  const back = newPage();
  back.data.resume = '0';
  back.resume = '0';
  back.onInit();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(router.__calls.length, 0,
    'explicit shelf return must suppress auto-resume');
  console.info('  [5c] 显式返回书架不自动重开 ✓');
}

rmSync(tmp, { recursive: true, force: true });
rmSync(sandbox, { recursive: true, force: true });
console.info('PASS: 开机即书架——启动同步显示书单、不读 books.json、' +
  '索引损坏不阻塞、外部书目后台合入、冷启动续读（issue #10/#17）');
