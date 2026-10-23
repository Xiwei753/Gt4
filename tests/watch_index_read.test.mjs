// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/watch_index_read.test.mjs
// issue #8 真机回归：索引读取必须走分块 readArrayBuffer，
// 不能再对 @system.file.readText 传 65536（真机 4 KB 上限 → 302）。
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync,
  existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSystemFileStub } from './helpers/system_file_stub.mjs';
import { createWatchLoader, writeWearEngineStub }
  from './helpers/watch_module_loader.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'suyue-idx-'));
const sandbox = mkdtempSync(join(tmpdir(), 'suyue-idxfs-'));
const stubPath = writeSystemFileStub(tmp, sandbox);
const load = createWatchLoader({ tmpDir: tmp, stubPath,
  wearengineStubPath: writeWearEngineStub(tmp) });
const systemFile = (await import(stubPath)).default;
const libraryIndex = await load('storage/LibraryIndex.js');

const gt = join(sandbox, 'gt4reader');
const booksJson = join(gt, 'books.json');
const booksDir = join(gt, 'books');

const settle = (fn, ms = 3000) => Promise.race([
  new Promise((res) => fn(res)),
  new Promise((_, rej) => setTimeout(
    () => rej(new Error('settle timeout')), ms))
]);

function reset() {
  rmSync(gt, { recursive: true, force: true });
}
function meta(id, title) {
  return { bookId: id, title, encoding: 'utf-8', bytes: 5,
    sha256: 'a'.repeat(64), chunks: 0, chunkBytes: 0, chapters: [] };
}
function seed(entries, rawText) {
  mkdirSync(gt, { recursive: true });
  writeFileSync(booksJson, rawText !== undefined ?
    rawText : JSON.stringify(entries));
  mkdirSync(booksDir, { recursive: true });
  (entries || []).forEach((e) => writeFileSync(
    join(booksDir, e.bookId + '.txt'), 'x'));
}
async function list() {
  const diag = {};
  const books = await settle((done) =>
    libraryIndex.listBooks(done, (d) => { diag.value = d; }));
  return { books, diag: diag.value };
}

// ---- 1. 新装：没有 books.json → 正常空书架 + missing(301) ----
{
  reset();
  const { books, diag } = await list();
  assert.deepEqual(books, [], 'first install must be an empty shelf');
  assert.equal(diag.state, 'missing');
  assert.equal(diag.code, 301);
  assert.equal(diag.api, 'access',
    'a genuinely missing index is detected by file.access (301)');
}

// ---- 2. 小索引（两本）：按顺序加载 + ok（简单 readText）----
{
  reset();
  seed([meta('1111111111111111', '第一本'),
    meta('2222222222222222', '第二本')]);
  const { books, diag } = await list();
  assert.equal(books.length, 2);
  assert.deepEqual(books.map((b) => b.bookId),
    ['1111111111111111', '2222222222222222']);
  assert.deepEqual(books.map((b) => b.title), ['第一本', '第二本']);
  assert.equal(diag.state, 'ok');
  assert.equal(diag.api, 'readText',
    'a small index must use the upstream readText({uri}) style');
}

// ---- 3. 索引 > 4096 字节，且中文标题正好跨分块边界 ----
{
  reset();
  // 选一个 A 的个数，使第一个中文字符的字节起点在 4096 之前、
  // 且它的 3 个字节跨过 4096（分块边界切在多字节字符中间）。
  let split = null;
  for (let n = 3900; n < 4200; n += 1) {
    const head = '[{"bookId":"3333333333333333","title":"' +
      'A'.repeat(n);
    const off = Buffer.byteLength(head);
    if (off < 4096 && 4096 < off + 3) { split = { head, off, n }; break; }
  }
  assert.ok(split, 'test must find a multibyte-splitting offset');
  const title = 'A'.repeat(split.n) + '中文标题';
  const text = split.head + '中文标题' +
    '","encoding":"utf-8","bytes":5,"sha256":"' +
    'a'.repeat(64) + '","chunks":0,"chunkBytes":0,"chapters":[]}]';
  assert.ok(Buffer.byteLength(text) > 4096,
    'index must exceed the 4 KB readText limit');
  seed([meta('3333333333333333', title)], text);
  const { books, diag } = await list();
  assert.equal(books.length, 1,
    'chunked read must load a >4 KB index without loss');
  assert.equal(books[0].title, title,
    'multibyte title split across a chunk boundary must decode ' +
    'correctly');
  assert.equal(diag.state, 'ok');
}

// ---- 4. 读索引参数错误 202 → error(202)，且绝不清空索引 ----
{
  reset();
  const entries = [meta('4444444444444444', '保留')];
  seed(entries);
  const before = readFileSync(booksJson, 'utf8');
  const original = systemFile.readText;
  systemFile.readText = (o) => o.fail && o.fail({}, 202);
  try {
    const { books, diag } = await list();
    assert.deepEqual(books, []);
    assert.equal(diag.state, 'error');
    assert.equal(diag.code, 202);
    assert.equal(diag.api, 'readText');
    assert.equal(existsSync(booksJson), true,
      'an index read error must not delete books.json');
    assert.equal(readFileSync(booksJson, 'utf8'), before,
      'an index read error must not rewrite/clear the index');
  } finally {
    systemFile.readText = original;
  }
}

// ---- 5. 读索引 I/O 错误 300 → error(300) ----
{
  reset();
  seed([meta('5555555555555555', '保留')]);
  const original = systemFile.readText;
  systemFile.readText = (o) => o.fail && o.fail({}, 300);
  try {
    const { diag } = await list();
    assert.equal(diag.state, 'error');
    assert.equal(diag.code, 300);
  } finally {
    systemFile.readText = original;
  }
}

// ---- 6. 读索引不回调 → 队列看门狗释放，并回报结构化超时 ----
{
  reset();
  seed([meta('6666666666666666', '后续')]);
  libraryIndex.setQueueTimeout(40);
  const original = systemFile.readText;
  let firstDiag = null;
  let firstBooks = null;
  systemFile.readText = () => {};
  libraryIndex.listBooks((b) => { firstBooks = b; },
    (d) => { firstDiag = d; });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(firstDiag && firstDiag.state === 'error',
    'a hung index read must report a structured error, not hang');
  assert.deepEqual(firstBooks, []);
  systemFile.readText = original;
  const books = await settle((done) =>
    libraryIndex.listBooks(done, () => {}));
  assert.equal(books.length, 1,
    'watchdog must release the queue for the next listBooks');
}

// ---- 7. 桩确实复现真机限制：readText length>4096 → 302 ----
{
  reset();
  seed([meta('7777777777777777', '限制')]);
  let code = null;
  await settle((done) => systemFile.readText({
    uri: 'internal://app/gt4reader/books.json',
    length: 65536,
    success: () => done(),
    fail: (d, c) => { code = c; done(); }
  }));
  assert.equal(code, 302,
    'the stub must reproduce the real >4 KB readText = 302 limit');
}

// ---- 8. readText 报 302 时自动回退分块 readArrayBuffer ----
{
  reset();
  seed([meta('8888888888888888', '回退')]);
  writeFileSync(join(sandbox, '.readtext_302'), '');
  try {
    const { books, diag } = await list();
    assert.equal(books.length, 1,
      'a 302 on the small readText path must fall back to chunked read');
    assert.equal(books[0].bookId, '8888888888888888');
    assert.equal(diag.state, 'ok');
    assert.equal(diag.api, 'readArrayBuffer',
      'the 302 fallback must report readArrayBuffer');
  } finally {
    rmSync(join(sandbox, '.readtext_302'), { force: true });
  }
}

console.info('PASS: index read is probe-first (access/get), uses ' +
  'small readText then chunked readArrayBuffer, distinguishes ' +
  '301/202/300/timeout, 302-fallback, survives > 4 KB and ' +
  'multibyte chunk boundaries (issue #8/#9)');
