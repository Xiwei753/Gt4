// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/watch_receive.test.mjs
// 手表端接收闭环测试（施工单 P0-5/P0-6/P1-11/P1-12）：
//   - 文件通道：BOOK_META → receiveFileChannel
//     （复制 → 大小校验 → 流式 SHA-256 → 原子入库）
//     → RESULT ok=true 回传；
//   - 消息通道：BOOK_META → CHUNK×N → FINISH
//     → 拼接 → 摘要 → 入库 → RESULT；
//   - 失败路径：摘要不符 / 大小不符 / 无 BOOK_META，
//     必须清理暂存、不得出现在书架；
//   - LibraryIndex：写操作串行化、原子写无残留。
// 通过 @system.file 的 Node 桩（真实文件系统后端）
// 驱动 IncomingBookReceiver / LibraryIndex。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync,
  mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSystemFileStub } from './helpers/system_file_stub.mjs';
import { createWatchLoader, wait }
  from './helpers/watch_module_loader.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'suyue-rcv-'));
const sandbox = mkdtempSync(join(tmpdir(), 'suyue-fs-'));
// @system.file 桩：internal://app/<p> → sandbox/<p>
// （共享实现见 tests/helpers/system_file_stub.mjs）。
const stubPath = writeSystemFileStub(tmp, sandbox);
const load = createWatchLoader({ tmpDir: tmp, stubPath });

const BookStorage = await load('storage/BookStorage.js');
const LibraryIndex = await load('storage/LibraryIndex.js');
const { IncomingBookReceiver } =
  await load('wear/IncomingBookReceiver.js');
const { sha256Bytes } = await load('util/Sha256.js');

const enc = new TextEncoder();
const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');

const writeReceived = (name, bytes) => {
  const p = join(sandbox, name);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, Buffer.from(bytes));
  return 'internal://app/' + name;
};

const readSandbox = (name) =>
  readFileSync(join(sandbox, name));

// ---- A. 文件通道成功闭环 ----
const bookText = '第一章：你好，世界！\r\n第二章：流式校验。'
  .repeat(120);
const bookBytes = enc.encode(bookText);
const bookId = sha256(bookBytes).slice(0, 16);
const meta = {
  v: 0, type: 'BOOK_META',
  transferId: 'file-ok-1',
  bookId, title: '流式校验书', encoding: 'utf-8',
  bytes: bookBytes.length,
  sha256: sha256(bookBytes),
  chunks: 3, chunkBytes: 65536,
  chapters: [{ title: '正文', offset: 0,
    length: bookBytes.length }]
};
const receivedUri = writeReceived('inbox/book.bin',
  bookBytes);

await wait((cb) => BookStorage.ensureDirs(cb));
const sentMessages = [];
const statuses = [];
const receiver = new IncomingBookReceiver(
  (s) => statuses.push(s),
  (text) => sentMessages.push(text));
receiver.onMessage(JSON.stringify(meta));

const fileOutcome = await wait((cb) =>
  receiver.receiveFileChannel(receivedUri, null, cb));
assert.equal(fileOutcome.ok, true,
  'file channel must succeed: ' +
  JSON.stringify(fileOutcome));

// RESULT 必须经 sendToPhone 回传（P0-6）。
const results = sentMessages
  .map((t) => JSON.parse(t))
  .filter((m) => m.type === 'RESULT');
assert.equal(results.length, 1,
  'exactly one RESULT must go back to phone');
assert.equal(results[0].ok, true);
assert.equal(results[0].transferId, 'file-ok-1');
assert.equal(results[0].bookId, bookId);

// 书籍落盘且内容一致。
const onDisk = readSandbox('gt4reader/books/' + bookId + '.txt');
assert.equal(onDisk.length, bookBytes.length);
assert.deepEqual(Buffer.from(onDisk), Buffer.from(bookBytes));

// 书架登记元数据真实。
const entries = await wait((cb) =>
  LibraryIndex.listBooks(cb));
assert.equal(entries.length, 1);
assert.equal(entries[0].bookId, bookId);
assert.equal(entries[0].bytes, bookBytes.length);
assert.equal(entries[0].sha256, sha256(bookBytes));
assert.equal(entries[0].title, '流式校验书');
// 暂存已转正，无残留。
assert.equal(existsSync(join(sandbox,
  'gt4reader/temp/file-ok-1')), false);
// 原子写无 .tmp 残留（P1-12）。
assert.equal(existsSync(join(sandbox,
  'gt4reader/books.json.tmp')), false);

// ---- B. 摘要不符：拒绝、清理、不入书架 ----
const badMeta = Object.assign({}, meta, {
  transferId: 'file-bad-1',
  bookId: 'bbbbbbbbbbbbbbbb',
  sha256: 'cc'.repeat(32)
});
receiver.onMessage(JSON.stringify(badMeta));
const badOutcome = await wait((cb) =>
  receiver.receiveFileChannel(receivedUri, null, cb));
assert.equal(badOutcome.ok, false);
assert.equal(badOutcome.reason, 'E_DIGEST_MISMATCH');
const badResults = sentMessages
  .map((t) => JSON.parse(t))
  .filter((m) => m.type === 'RESULT' &&
    m.transferId === 'file-bad-1');
assert.equal(badResults.length, 1);
assert.equal(badResults[0].ok, false);
assert.equal(badResults[0].reason, 'E_DIGEST_MISMATCH');
assert.equal(existsSync(join(sandbox,
  'gt4reader/books/bbbbbbbbbbbbbbbb.txt')), false,
  'rejected book must not reach the shelf');
assert.equal(existsSync(join(sandbox,
  'gt4reader/temp/file-bad-1')), false,
  'rejected transfer temp must be cleaned');

// ---- C. 大小不符 ----
const shortMeta = Object.assign({}, meta, {
  transferId: 'file-short-1',
  bookId: 'cccccccccccccccc',
  bytes: bookBytes.length + 10
});
receiver.onMessage(JSON.stringify(shortMeta));
const shortOutcome = await wait((cb) =>
  receiver.receiveFileChannel(receivedUri, null, cb));
assert.equal(shortOutcome.ok, false);
assert.equal(shortOutcome.reason, 'E_SIZE_MISMATCH');
assert.equal(existsSync(join(sandbox,
  'gt4reader/books/cccccccccccccccc.txt')), false);

// ---- D. 无 BOOK_META 直接文件通道 ----
const orphanOutcome = await wait((cb) =>
  receiver.receiveFileChannel(receivedUri, null, cb));
assert.equal(orphanOutcome.ok, false);
assert.equal(orphanOutcome.reason, 'E_PROTOCOL');
// ---- E. 消息通道闭环：CHUNK×N → FINISH ----
const msgText = '消息通道：中文内容 😀。'.repeat(200);
const msgBytes = enc.encode(msgText);
const msgBookId = sha256(msgBytes).slice(0, 16);
const chunkBytes = 500;
const total = Math.ceil(msgBytes.length / chunkBytes);
const msgMeta = {
  v: 0, type: 'BOOK_META',
  transferId: 'msg-ok-1',
  bookId: msgBookId, title: '消息通道书',
  encoding: 'utf-8', bytes: msgBytes.length,
  sha256: sha256(msgBytes),
  chunks: total, chunkBytes,
  chapters: [{ title: '正文', offset: 0,
    length: msgBytes.length }]
};
receiver.onMessage(JSON.stringify(msgMeta));
const sentB64 = (bytes) =>
  Buffer.from(bytes).toString('base64');
let offset = 0;
for (let i = 0; i < total; i++) {
  const slice = msgBytes.subarray(offset,
    offset + chunkBytes);
  const ackCountBefore = sentMessages
    .filter((t) => JSON.parse(t).type === 'ACK')
    .length;
  receiver.onMessage(JSON.stringify({
    v: 0, type: 'CHUNK', transferId: 'msg-ok-1',
    bookId: msgBookId, index: i, total,
    offset, length: slice.length,
    payloadB64: sentB64(slice)
  }));
  // ACK 必须经统一响应通道回手机。
  const ackMessages = sentMessages
    .map((t) => JSON.parse(t))
    .filter((m) => m.type === 'ACK' &&
      m.transferId === 'msg-ok-1');
  assert.equal(ackMessages.length,
    ackCountBefore + 1,
    'each chunk must be ACKed on the response channel');
  const ack = ackMessages[ackMessages.length - 1];
  assert.equal(ack.ok, true);
  assert.equal(ack.index, i);
  offset += slice.length;
}
receiver.onMessage(JSON.stringify({
  v: 0, type: 'FINISH', transferId: 'msg-ok-1',
  bookId: msgBookId
}));
// FINISH 的 persist 是回调链，轮询等待入库。
let msgDone = false;
for (let tries = 0; tries < 200 && !msgDone; tries++) {
  const list = await wait((cb) =>
    LibraryIndex.listBooks(cb));
  msgDone = list.some((e) => e.bookId === msgBookId);
  if (!msgDone) {
    await new Promise((r) => setTimeout(r, 10));
  }
}
assert.ok(msgDone, 'message-channel book must be persisted');
const msgResult = sentMessages
  .map((t) => JSON.parse(t))
  .filter((m) => m.type === 'RESULT' &&
    m.transferId === 'msg-ok-1');
assert.equal(msgResult.length, 1);
assert.equal(msgResult[0].ok, true);
const msgOnDisk = readSandbox('gt4reader/books/' +
  msgBookId + '.txt');
assert.deepEqual(Buffer.from(msgOnDisk),
  Buffer.from(msgBytes));

// ---- E2. 文件通道 + CHAPTERS 分片：章节先于文件到达，乱序分片可重排 ----
const chapterText = '第一章：分片目录\r\n第二章：文件通道\r\n'.repeat(40);
const chapterBytes = enc.encode(chapterText);
const chapterBookId = sha256(chapterBytes).slice(0, 16);
const chapterMeta = {
  v: 0, type: 'BOOK_META',
  transferId: 'file-chapters-1',
  bookId: chapterBookId, title: '分片目录书',
  encoding: 'utf-8', bytes: chapterBytes.length,
  sha256: sha256(chapterBytes),
  chunks: 1, chunkBytes: 65536,
  chapters: [], chapterChunks: 2
};
receiver.onMessage(JSON.stringify(chapterMeta));
receiver.onMessage(JSON.stringify({
  v: 0, type: 'CHAPTERS', transferId: 'file-chapters-1',
  bookId: chapterBookId, index: 1, total: 2,
  chapters: [{ title: '第二章', offset: 20,
    length: chapterBytes.length - 20 }]
}));
receiver.onMessage(JSON.stringify({
  v: 0, type: 'CHAPTERS', transferId: 'file-chapters-1',
  bookId: chapterBookId, index: 0, total: 2,
  chapters: [{ title: '第一章', offset: 0, length: 20 }]
}));
const chaptersUri = writeReceived(
  'inbox/chapters.bin', chapterBytes);
const chapterOutcome = await wait((cb) =>
  receiver.receiveFileChannel(chaptersUri, null, cb));
assert.equal(chapterOutcome.ok, true);
const chapterEntry = await wait((cb) =>
  LibraryIndex.getBook(chapterBookId, cb));
assert.deepEqual(chapterEntry.chapters.map((c) => c.title),
  ['第一章', '第二章'], 'CHAPTERS chunks must be assembled before addBook');
await wait((cb) => LibraryIndex.removeBook(chapterBookId, cb));

// ---- F. LibraryIndex 串行写（P1-12） ----
await wait((cb) => LibraryIndex.removeBook(bookId, cb));
await wait((cb) => LibraryIndex.removeBook(msgBookId, cb));
const addIds = [];
for (let i = 0; i < 5; i++) {
  const id = ('ddddd' + String(i).padStart(11, '0'))
    .slice(0, 16);
  addIds.push(id);
  // listBooks 会按文件存在性过滤：
  // 先落真实书籍文件，再写索引。
  mkdirSync(join(sandbox, 'gt4reader/books'),
    { recursive: true });
  writeFileSync(join(sandbox, 'gt4reader/books',
    id + '.txt'), '并发书' + i);
}
const adds = addIds.map((id, i) =>
  wait((cb) => LibraryIndex.addBook({
    bookId: id,
    title: '并发书' + i, encoding: 'utf-8',
    bytes: 10 + i, sha256: sha256Bytes(
      enc.encode('x' + i)),
    chunks: 1, chunkBytes: 1024, chapters: []
  }, cb)));
const addResults = await Promise.all(adds);
for (const r of addResults) assert.equal(r.ok, true);
const finalList = await wait((cb) =>
  LibraryIndex.listBooks(cb));
assert.equal(finalList.length, 5,
  'concurrent adds must all be serialized, none lost');
assert.equal(existsSync(join(sandbox,
  'gt4reader/books.json.tmp')), false);

console.info('PASS: watch receive loop (file channel, ' +
  'message channel, digest/size rejection, ' +
  'serialized index writes); book bytes=' +
  bookBytes.length);
