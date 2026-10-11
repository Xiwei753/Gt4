// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/watch_init_diagnostics.test.mjs
// issue #8 P0：手表首页永久卡"正在准备本地书库"的回归。
//
// 用真实文件桩 + 失败注入覆盖施工单要求：
//   1. 新装无目录/无 books.json/无 demo → 明确空书架；
//   2. 已有两本书 → 就绪并可点击打开；
//   3. access 报 301 后 mkdir 成功（首装创建目录）；
//   4. mkdir 报 202 / readText 报错 → 屏幕给出阶段 + 错误码；
//   5. 任意文件操作不回调 → 页面超时后显示卡住的阶段；
//   6. 失败后重试可恢复；不影响已有书籍；
//   7. Wear Engine 异常不影响离线书架初始化；
//   8. 索引队列看门狗在无回调时释放，后续 listBooks 不再永久阻塞；
//      并区分"无 books.json"(missing) 与"文件系统异常"(error)。
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync,
  rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSystemFileStub } from './helpers/system_file_stub.mjs';
import { createWatchLoader, writeWearEngineStub,
  writeRouterStub, wait } from './helpers/watch_module_loader.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'suyue-init-'));
const sandbox = mkdtempSync(join(tmpdir(), 'suyue-initfs-'));
const stubPath = writeSystemFileStub(tmp, sandbox);
const wearengineStubPath = writeWearEngineStub(tmp);
const routerStubPath = writeRouterStub(tmp);
const load = createWatchLoader({ tmpDir: tmp, stubPath,
  wearengineStubPath, routerStubPath });

const pageMod = await load('pages/index/index.js');
const BookStorage = await load('storage/BookStorage.js');
const LibraryIndex = await load('storage/LibraryIndex.js');

const systemFile = (await import(stubPath)).default;
const router = (await import(routerStubPath)).default;

// 缩短后备超时，让测试保持毫秒级。
BookStorage.setOperationTimeout(120);
LibraryIndex.setQueueTimeout(60);

const enc = new TextEncoder();
const sandboxFile = (rel) => join(sandbox, rel);
const clearLibrary = () => rmSync(sandboxFile('gt4reader'),
  { recursive: true, force: true });

const waitFor = async (fn, timeoutMs = 2000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 4));
  }
  return fn();
};

// 页面实例：方法走原型，data 独立拷贝。
function newPage(initTimeoutMs = 30) {
  const p = Object.create(pageMod.default);
  p.data = Object.assign({}, pageMod.default.data);
  p.initTimeoutMs = initTimeoutMs;
  return p;
}

const initPage = async (page) => {
  page.onInit();
  await waitFor(() => page.initDone === true);
  return page;
};

const writeIndex = (entries) => {
  mkdirSync(sandboxFile('gt4reader'), { recursive: true });
  writeFileSync(sandboxFile('gt4reader/books.json'),
    JSON.stringify(entries));
};
const writeBook = (id, text) => {
  mkdirSync(sandboxFile('gt4reader/books'), { recursive: true });
  writeFileSync(sandboxFile('gt4reader/books/' + id + '.txt'), text);
};
const meta = (id, title) => ({ bookId: id, title,
  encoding: 'utf-8', bytes: 5, sha256: 'a'.repeat(64),
  chunks: 0, chunkBytes: 0, chapters: [] });

// ---- 1. 新装：明确空书架，不再无限"正在准备" ----
{
  clearLibrary();
  const page = await initPage(newPage());
  assert.equal(page.initFailed, false,
    'fresh install must not be reported as failure');
  assert.ok(page.status.includes('书库为空'),
    'fresh install must show an explicit empty shelf, got: ' +
    page.status);
  assert.equal(page.libraryReady, true);
  assert.equal(existsSync(sandboxFile('gt4reader/books')), true,
    'books dir must be created on first install');
}

// ---- 2. 已有两本书：就绪并可点击 ----
{
  clearLibrary();
  writeIndex([meta('1111111111111111', '第一本'),
    meta('2222222222222222', '第二本')]);
  writeBook('1111111111111111', 'AAAAA');
  writeBook('2222222222222222', 'BBBBB');
  const page = await initPage(newPage());
  assert.equal(page.books.length, 2,
    'existing books must load into the shelf');
  assert.ok(page.status.includes('本地书库就绪'),
    'shelf must report ready, got: ' + page.status);
  router.__calls.length = 0;
  page.openBook(1);
  assert.equal(router.__calls.length, 1);
  assert.equal(router.__calls[0][0], 'push');
  assert.equal(router.__calls[0][2].bookId, '2222222222222222',
    'opening a book must route by its bookId');
}

// ---- 3+4. mkdir 报 202 → 屏幕给目录阶段 + 错误码 ----
{
  clearLibrary();
  const original = systemFile.mkdir;
  systemFile.mkdir = (o) => o.fail && o.fail({}, 202);
  try {
    const page = await initPage(newPage());
    assert.equal(page.initFailed, true,
      'mkdir failure must surface as an init failure');
    assert.ok(page.status.includes('E_DIRS_books'),
      'status must name the failed stage, got: ' + page.status);
    assert.ok(page.status.includes('202'),
      'status must carry the real error code, got: ' + page.status);
  } finally {
    systemFile.mkdir = original;
  }
}

// ---- 4b. readText 报 300 → 不伪装成空书架，给出错误码 ----
// issue #9 A2：小索引走 readText({uri})，失败必须上屏而不是当空库。
{
  clearLibrary();
  writeIndex([meta('4444444444444444', '保留')]);
  writeBook('4444444444444444', 'DDDDD');
  const original = systemFile.readText;
  systemFile.readText = (o) => o.fail && o.fail({}, 300);
  try {
    const page = await initPage(newPage());
    assert.equal(page.initFailed, true,
      'index read error must not masquerade as an empty shelf');
    assert.ok(page.status.includes('E_INDEX_READ'),
      'status must flag the index read error, got: ' + page.status);
    assert.ok(page.status.includes('300'),
      'status must carry the read error code, got: ' + page.status);
    assert.ok(page.status.includes('readText'),
      'status must name the failing interface, got: ' + page.status);
  } finally {
    systemFile.readText = original;
  }
}

// ---- 5. 任意文件操作不回调 → 超时显示卡住的阶段 ----
{
  clearLibrary();
  const original = systemFile.access;
  systemFile.access = () => {};
  try {
    const page = newPage(30);
    page.onInit();
    await waitFor(() => page.initDone === true, 1000);
    assert.equal(page.initFailed, true,
      'a hung file op must end in a visible timeout');
    assert.ok(page.status.includes('E_INIT_TIMEOUT'),
      'timeout must be labelled, got: ' + page.status);
    assert.ok(page.status.includes('目录 books'),
      'timeout must show the stuck stage, got: ' + page.status);
  } finally {
    systemFile.access = original;
  }
}

// ---- 6. 失败后重试恢复；不影响已有书籍 ----
{
  clearLibrary();
  writeIndex([meta('3333333333333333', '重试书')]);
  writeBook('3333333333333333', 'CCCCC');
  const original = systemFile.access;
  systemFile.access = () => {};
  const page = newPage(30);
  page.onInit();
  await waitFor(() => page.initDone === true, 1000);
  assert.equal(page.initFailed, true);
  systemFile.access = original;
  page.retryInit();
  await waitFor(() => page.initDone === true && !page.initFailed);
  assert.equal(page.initFailed, false, 'retry must recover');
  assert.equal(page.books.length, 1,
    'retry must load the existing book without losing it');
  assert.equal(page.books[0].bookId, '3333333333333333');
}

// ---- 7. 传书未就绪（Wear Engine 指纹未配置）不影响离线书架 ----
{
  clearLibrary();
  const page = await initPage(newPage());
  assert.equal(page.initFailed, false,
    'Wear Engine state must not block the offline shelf');
  assert.ok(page.status.includes('书库为空'),
    'offline shelf must still reach a terminal state');
  assert.equal(typeof page.transferStatus, 'string');
  assert.ok(page.transferStatus.length > 0,
    'transfer init must report its own status independently');
}

// ---- 8. 索引队列看门狗 + 诊断分类 ----
{
  clearLibrary();
  // missing：无 books.json（301）。
  let missingDiag = null;
  const missing = await wait((cb) => LibraryIndex.listBooks(cb,
    (d) => { missingDiag = d; }));
  assert.equal(missing.length, 0);
  assert.equal(missingDiag.state, 'missing',
    'absent index from a fresh install must be classified missing');

  // error：readText 报 300（issue #9 A2：小索引走 readText）。
  writeIndex([meta('9999999999999999', '异常')]);
  writeBook('9999999999999999', 'EEEEE');
  const original = systemFile.readText;
  systemFile.readText = (o) => o.fail && o.fail({}, 300);
  try {
    let errDiag = null;
    const err = await wait((cb) => LibraryIndex.listBooks(cb,
      (d) => { errDiag = d; }));
    assert.equal(err.length, 0);
    assert.equal(errDiag.state, 'error',
      'a real I/O failure must be classified error, not empty');
    assert.equal(errDiag.code, 300);
  } finally {
    systemFile.readText = original;
  }

  // 无回调：看门狗释放队列并回报结构化超时，后续 listBooks 不再阻塞。
  let firstDiag = null;
  let firstBooks = null;
  systemFile.readText = () => {};
  LibraryIndex.listBooks((b) => { firstBooks = b; },
    (d) => { firstDiag = d; });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(firstDiag && firstDiag.state === 'error',
    'a hung index read must report a structured error');
  assert.deepEqual(firstBooks, []);
  systemFile.readText = original;
  const after = await Promise.race([
    wait((cb) => LibraryIndex.listBooks(cb, () => {})),
    new Promise((_, rej) => setTimeout(
      () => rej(new Error('queue stuck after watchdog')), 1000))
  ]);
  assert.ok(Array.isArray(after),
    'watchdog must release the queue for the next listBooks');
}

console.info('PASS: watch shelf init stages, screen-level error ' +
  'codes, timeout fallback, retry, Wear Engine isolation and ' +
  'index queue watchdog (issue #8)');
