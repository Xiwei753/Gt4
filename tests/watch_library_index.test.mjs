// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/watch_library_index.test.mjs
// 第二轮复核 P0 的针对性失败回归：
//
// P0-2（文件与 BOOK_META 的关联）：
//   - 第二个不同 transferId 的 BOOK_META → E_BUSY，
//     且在途传输不受影响；
//   - 相同 transferId 重发 META 视为重启；
//   - 回调缺文件路径字段 → extractFileRef 返回 null；
//   - 无在途传输时收到文件 → E_PROTOCOL，不落盘。
//
// P0-4（索引回滚的对象别名 Bug）：
//   - tmp 写成功但 move 失败 → 回滚恢复上一份
//     快照，磁盘内容与快照一致（不是失败内容）；
//   - 更新已有书籍失败 → 保留旧元数据；
//   - 目标不可覆盖的文件系统 → 删除后重试成功；
//   - 回滚后不残留 .tmp。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync,
  mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSystemFileStub } from './helpers/system_file_stub.mjs';
import { createWatchLoader, writeWearEngineStub, wait }
  from './helpers/watch_module_loader.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'suyue-idx-'));
const sandbox = mkdtempSync(join(tmpdir(), 'suyue-idxfs-'));
const stubPath = writeSystemFileStub(tmp, sandbox);
const wearengineStubPath = writeWearEngineStub(tmp);
const load = createWatchLoader({ tmpDir: tmp, stubPath,
  wearengineStubPath });

const BookStorage = await load('storage/BookStorage.js');
const LibraryIndex = await load('storage/LibraryIndex.js');
const { IncomingBookReceiver } =
  await load('wear/IncomingBookReceiver.js');
const { extractFileRef } = await load('wear/WearReceiver.js');
const { sha256Bytes } = await load('util/Sha256.js');

const enc = new TextEncoder();
const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');

await wait((cb) => BookStorage.ensureDirs(cb));

const sandboxFile = (rel) => join(sandbox, rel);
const indexOnDisk = () => JSON.parse(
  readFileSync(sandboxFile('gt4reader/books.json'), 'utf8'));
const setFailMoves = (n) => writeFileSync(
  sandboxFile('.fail_move_count'), String(n));
const clearFailMoves = () =>
  rmSync(sandboxFile('.fail_move_count'),
    { force: true });
const setFailWrites = (n) => writeFileSync(
  sandboxFile('.fail_write_count'), String(n));
const clearFailWrites = () =>
  rmSync(sandboxFile('.fail_write_count'), { force: true });

const bookBytes = enc.encode('索引回滚测试正文。'.repeat(40));
const meta = {
  v: 0, type: 'BOOK_META',
  transferId: 'flow-1',
  bookId: sha256(bookBytes).slice(0, 16),
  title: '回滚测试书', encoding: 'utf-8',
  bytes: bookBytes.length,
  sha256: sha256(bookBytes),
  chunks: 1, chunkBytes: 65536, chapters: []
};
const writeInbox = (name, bytes) => {
  mkdirSync(join(sandbox, 'inbox'), { recursive: true });
  writeFileSync(join(sandbox, name), Buffer.from(bytes));
  return 'internal://app/' + name;
};
const inboxUri = writeInbox('inbox/flow1.bin', bookBytes);

const okWritebook = (id, title) => {
  mkdirSync(join(sandbox, 'gt4reader/books'),
    { recursive: true });
  writeFileSync(sandboxFile('gt4reader/books/' + id + '.txt'),
    title);
  return { bookId: id, title, encoding: 'utf-8',
    bytes: 10, sha256: sha256Bytes(enc.encode(title)),
    chunks: 1, chunkBytes: 1024, chapters: [] };
};

// ---- P0-2: 单本互斥 E_BUSY ----
{
  const sent = [];
  const receiver = new IncomingBookReceiver(() => {},
    (text) => sent.push(JSON.parse(text)));
  receiver.onMessage(JSON.stringify(meta));       // 在途 flow-1
  const other = Object.assign({}, meta, {
    transferId: 'flow-2',
    bookId: 'eeeeeeeeeeeeeeee',
    sha256: sha256(enc.encode('另一本'))
  });
  receiver.onMessage(JSON.stringify(other));
  const busy = sent.filter((m) =>
    m.type === 'RESULT' && m.transferId === 'flow-2');
  assert.equal(busy.length, 1);
  assert.equal(busy[0].ok, false);
  assert.equal(busy[0].reason, 'E_BUSY',
    'second concurrent transfer must be rejected with E_BUSY');
  // 在途 flow-1 不受影响：仍能正常完成。
  const outcome = await wait((cb) =>
    receiver.receiveFileChannel(inboxUri, null, cb));
  assert.equal(outcome.ok, true,
    'in-flight transfer must survive the E_BUSY rejection');
  const flow1 = sent.filter((m) =>
    m.type === 'RESULT' && m.transferId === 'flow-1');
  assert.equal(flow1.length, 1);
  assert.equal(flow1[0].ok, true);
  const list = await wait((cb) => LibraryIndex.listBooks(cb));
  assert.ok(list.some((e) => e.bookId === meta.bookId));
  assert.ok(!list.some((e) => e.bookId === other.bookId),
    'rejected transfer must not reach the shelf');
}

// ---- P0-2: 相同 transferId 重发 META = 重启 ----
{
  const sent = [];
  const receiver = new IncomingBookReceiver(() => {},
    (text) => sent.push(JSON.parse(text)));
  receiver.onMessage(JSON.stringify(meta));
  // 重启：清空接收状态后重发，仍应成功入库。
  receiver.onMessage(JSON.stringify(meta));
  const outcome = await wait((cb) =>
    receiver.receiveFileChannel(inboxUri, null, cb));
  assert.equal(outcome.ok, true,
    're-sent META with the same transferId is an idempotent restart');
  const results = sent.filter((m) => m.type === 'RESULT');
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
}

// ---- P0-2: 文件路径字段探测 ----
{
  assert.deepEqual(extractFileRef({ file: 'internal://app/a' }),
    { uri: 'internal://app/a', field: 'file' });
  assert.deepEqual(extractFileRef({ name: 'internal://app/b' }),
    { uri: 'internal://app/b', field: 'name' });
  assert.equal(extractFileRef({ isFileType: true }), null,
    'missing file reference must be reported, not guessed');
  assert.equal(extractFileRef({ file: '' }), null);
  assert.equal(extractFileRef(null), null);
}

// ---- P0-4 / issue #9 A4: tmp 写失败 → 回滚快照 ----
let baselineCount = 0;
{
  clearFailMoves();
  clearFailWrites();
  // 先写入一本成功书籍，建立"上一份好快照"。
  const first = okWritebook('1111111111111111', '第一本');
  const added = await wait((cb) =>
    LibraryIndex.addBook(first, cb));
  assert.equal(added.ok, true);
  const before = indexOnDisk();
  baselineCount = before.length;
  assert.ok(before.some((e) => e.bookId === '1111111111111111'),
    'baseline entry must be present');

  // 下一次保存：tmp 写入失败 → 保存失败 → 触发回滚。
  setFailWrites(1);
  const second = okWritebook('2222222222222222', '第二本');
  const failed = await wait((cb) =>
    LibraryIndex.addBook(second, cb));
  assert.equal(failed.ok, false,
    'save must fail while the tmp write is failing');
  assert.equal(failed.reason, 'index_write');
  clearFailWrites();

  // 回滚必须恢复上一份快照（第二本不得写入），
  // 且不能把失败的脏数据写回。
  const after = indexOnDisk();
  assert.equal(after.length, baselineCount,
    'rollback must restore the last good snapshot');
  assert.ok(!after.some((e) => e.bookId === '2222222222222222'),
    'failed entry must not appear after rollback');
  // 孤儿书籍文件被删除。
  assert.equal(existsSync(sandboxFile(
    'gt4reader/books/2222222222222222.txt')), false,
    'orphan book file must be removed on rollback');
  // 回滚成功路径不带 rollback 标记。
  assert.equal(failed.rollback, undefined);
}

// ---- issue #9 A4: move 失败不得删除原索引（回退覆盖写，不丢数据）----
{
  clearFailWrites();
  const first = indexOnDisk();
  setFailMoves(3);
  const moveBook = okWritebook('5555555555555555', '移动失败书');
  const added = await wait((cb) =>
    LibraryIndex.addBook(moveBook, cb));
  clearFailMoves();
  assert.equal(added.ok, true,
    'commit must fall back to overwrite (never delete the original)');
  const after = indexOnDisk();
  assert.equal(after.length, first.length + 1);
  assert.ok(after.some((e) => e.bookId === '5555555555555555'));
  // 旧条目仍在（没有把原索引删掉）。
  for (const e of first) {
    assert.ok(after.some((x) => x.bookId === e.bookId),
      'original entries must survive a move failure');
  }
}

// ---- P0-4: 更新已有书籍失败 → 保留旧元数据 ----
{
  const before = indexOnDisk();
  const updated = okWritebook('1111111111111111', '改名后的第二版');
  setFailWrites(1);
  const failed = await wait((cb) =>
    LibraryIndex.addBook(updated, cb));
  clearFailWrites();
  assert.equal(failed.ok, false);
  const after = indexOnDisk();
  assert.equal(after.length, before.length);
  const entry = after.find((e) => e.bookId === '1111111111111111');
  assert.equal(entry.title, '第一本',
    'failed update must keep the previous title');
}

// ---- issue #9 A4: 目标不可覆盖 → move 失败，改为覆盖写成功 ----
{
  const before = indexOnDisk();
  writeFileSync(sandboxFile('.no_overwrite'), '');
  const third = okWritebook('3333333333333333', '第三本');
  const added = await wait((cb) =>
    LibraryIndex.addBook(third, cb));
  rmSync(sandboxFile('.no_overwrite'), { force: true });
  assert.equal(added.ok, true,
    'commit must fall back to overwrite when move cannot replace the target');
  const after = indexOnDisk();
  assert.equal(after.length, before.length + 1);
  assert.ok(after.some((e) => e.bookId === '3333333333333333'));
}

// ---- P0-4: 并发增删后无 .tmp 残留、无丢条目 ----
{
  const ids = [];
  for (let i = 0; i < 4; i++) {
    // bookId 必须是 16 位十六进制（索引解析会
    // 过滤非法 id，测试数据必须真实合法）。
    const id = ('4' + i.toString(16) +
      '444444444444444').slice(0, 16);
    ids.push(id);
    okWritebook(id, '并发' + i);
  }
  const ops = [];
  for (const id of ids) {
    ops.push(wait((cb) => LibraryIndex.addBook(
      okWritebook(id, '并发书'), cb)));
  }
  ops.push(wait((cb) =>
    LibraryIndex.removeBook('3333333333333333', cb)));
  const results = await Promise.all(ops);
  for (const r of results) assert.equal(r.ok, true);
  const after = await wait((cb) => LibraryIndex.listBooks(cb));
  for (const id of ids) {
    assert.ok(after.some((e) => e.bookId === id),
      'serialized concurrent adds must not be lost');
  }
  assert.equal(existsSync(sandboxFile(
    'gt4reader/books.json.tmp')), false,
    'no leftover index tmp file');
}

// ---- 书架顺序：异步 file.access 故意乱序完成也必须稳定 ----
{
  const diskBefore = indexOnDisk().map((e) => e.bookId);
  const systemFile = (await import(stubPath)).default;
  const originalAccess = systemFile.access;
  let checks = 0;
  systemFile.access = (o) => {
    if (o.uri.includes('/books/') && o.uri.endsWith('.txt')) {
      // 第一条最慢，后面的快速返回，复现真机异步乱序完成。
      checks++;
      const delay = checks === 1 ? 30 : 1;
      setTimeout(() => originalAccess(o), delay);
      return;
    }
    originalAccess(o);
  };
  try {
    const listed = await wait((cb) => LibraryIndex.listBooks(cb));
    assert.deepEqual(listed.map((e) => e.bookId), diskBefore,
      'async file checks must preserve persisted shelf order');
    assert.deepEqual(indexOnDisk().map((e) => e.bookId), diskBefore,
      'listing existing books must not rewrite their ordering');
  } finally {
    systemFile.access = originalAccess;
  }
}

// ---- issue #7 真机修正：索引分块读取（books.json > 4 KB）----
{
  // Lite readText 单次文本上限 4 KB（超出报 302），
  // 旧实现用 length:65536 在真机上会随索引变大而失败。
  const ids = [];
  const entries = [];
  mkdirSync(sandboxFile('gt4reader/books'), { recursive: true });
  for (let i = 0; i < 80; i++) {
    const id = ('7'.repeat(16) + i.toString(16)).slice(-16);
    ids.push(id);
    writeFileSync(sandboxFile('gt4reader/books/' + id + '.txt'), 'x');
    entries.push({ bookId: id, title: 'book-' + i,
      encoding: 'utf-8', bytes: 1, sha256: 'a'.repeat(64),
      chunks: 0, chunkBytes: 0, chapters: [] });
  }
  writeFileSync(sandboxFile('gt4reader/books.json'),
    JSON.stringify(entries));
  const size = readFileSync(
    sandboxFile('gt4reader/books.json')).length;
  assert.ok(size > 4096,
    'fixture index must exceed 4 KB, got ' + size);
  const listed = await wait((cb) => LibraryIndex.listBooks(cb));
  assert.equal(listed.length, 80,
    'chunked index read must not lose entries');
  assert.deepEqual(listed.map((e) => e.bookId), ids,
    'chunked index read must preserve order');
}

console.info('PASS: index rollback (alias-free snapshot, ' +
  'move-failure recovery, overwrite fallback) and ' +
  'single-transfer E_BUSY / file-ref probing');
