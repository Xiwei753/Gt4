// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/watch_receive.test.mjs
// 手表端接收闭环测试（施工单 P0-5/P0-6/P1-11/P1-12）：
//   - 文件通道：BOOK_META → receiveFileChannel
//     （复制 → 大小校验 → 流式 SHA-256 → 原子入库）
//     → local status refreshes the visible shelf only on success;
//   - 消息通道：BOOK_META → CHUNK×N → FINISH
//     → 拼接 → 摘要 → 入库 → RESULT（legacy message channel）；
//   - 失败路径：摘要不符 / 大小不符 / 无 BOOK_META，
//     必须清理暂存、不得出现在书架；
//   - LibraryIndex：写操作串行化、原子写无残留。
// 通过 @system.file 的 Node 桩（真实文件系统后端）
// 驱动 IncomingBookReceiver / LibraryIndex / shelf status routing。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync,
  mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSystemFileStub } from './helpers/system_file_stub.mjs';
import { createWatchLoader, wait, writeWearEngineStub,
  writeRouterStub, writeStorageStub }
  from './helpers/watch_module_loader.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'suyue-rcv-'));
const sandbox = mkdtempSync(join(tmpdir(), 'suyue-fs-'));
// @system.file 桩：internal://app/<p> → sandbox/<p>
// （共享实现见 tests/helpers/system_file_stub.mjs）。
const stubPath = writeSystemFileStub(tmp, sandbox);
const wearengineStubPath = writeWearEngineStub(tmp);
const routerStubPath = writeRouterStub(tmp);
const storageStubPath = writeStorageStub(tmp);
const load = createWatchLoader({ tmpDir: tmp, stubPath,
  wearengineStubPath, routerStubPath, storageStubPath });

const BookStorage = await load('storage/BookStorage.js');
const LibraryIndex = await load('storage/LibraryIndex.js');
const { IncomingBookReceiver } =
  await load('wear/IncomingBookReceiver.js');
const { reportLocalReceiveOutcome } =
  await load('wear/WearReceiver.js');
const shelfMod = await load('pages/index/index.js');
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
const waitFor = async (fn, timeoutMs = 2000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  return fn();
};

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
const shelf = Object.create(shelfMod.default);
shelf.data = Object.assign({}, shelfMod.default.data);
shelf.token = 0;
shelf.external = [];
shelf.resume = '0';
let shelfLoads = 0;
const loadExternal = shelf.loadExternal;
shelf.loadExternal = function () {
  shelfLoads++;
  return loadExternal.call(this);
};
shelf.onInit();
assert.equal(await waitFor(() => shelf.externalLoaded), true,
  'the shelf must finish its initial external-library load');
assert.equal(shelf.books.length, 0,
  'the integration shelf must start empty before file reception');
const shelfLoadsBeforeImport = shelfLoads;
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
reportLocalReceiveOutcome(fileOutcome);
assert.equal(await waitFor(() =>
  shelf.books.some((book) => book.bookId === bookId)), true,
  'verified file import must refresh the visible shelf immediately');
assert.equal(shelf.transferStatus, '接收成功，已加入书架');
assert.ok(shelfLoads > shelfLoadsBeforeImport,
  'successful file import must trigger a shelf reload');

// 文件通道不通过 RESULT 回执手机；transferFile 回调是发送方的完成边界。
const results = sentMessages
  .map((t) => JSON.parse(t))
  .filter((m) => m.type === 'RESULT');
assert.equal(results.filter((m) => m.transferId === 'file-ok-1').length, 0,
  'file-channel receive must not send an application-level RESULT');

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
const shelfLoadsBeforeBadDigest = shelfLoads;
reportLocalReceiveOutcome(badOutcome);
assert.equal(shelf.transferStatus, '传书失败：E_DIGEST_MISMATCH');
assert.equal(shelf.books.some((book) =>
  book.bookId === 'bbbbbbbbbbbbbbbb'), false,
  'bad SHA must not show the rejected book as successfully received');
assert.equal(shelfLoads, shelfLoadsBeforeBadDigest,
  'bad SHA must not refresh the shelf as a successful import');
const badResults = sentMessages
  .map((t) => JSON.parse(t))
  .filter((m) => m.type === 'RESULT' &&
    m.transferId === 'file-bad-1');
assert.equal(badResults.length, 0,
  'watch-side digest rejection must not be misreported through RESULT');
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

// ---- E2. 完整 65 章目录分片后，文件入库保留全部跳章元数据 ----
const chapterParts = [];
const chapterEntries = [];
let chapterOffset = 0;
for (let i = 0; i < 65; i++) {
  const text = '第' + (i + 1) + '章 正文内容 abcdefghij\n';
  const bytes = enc.encode(text);
  chapterParts.push(bytes);
  chapterEntries.push({ title: '第' + (i + 1) + '章',
    offset: chapterOffset, length: bytes.length });
  chapterOffset += bytes.length;
}
const chapterBytes = Buffer.concat(chapterParts.map((part) =>
  Buffer.from(part)));
const chapterBookId = sha256(chapterBytes).slice(0, 16);
const chapterMeta = {
  v: 0, type: 'BOOK_META', transferId: 'file-chapters-65',
  bookId: chapterBookId, title: '六十五章书', encoding: 'utf-8',
  bytes: chapterBytes.length, sha256: sha256(chapterBytes),
  chunks: 1, chunkBytes: 65536, chapters: [], chapterChunks: 5
};
receiver.onMessage(JSON.stringify(chapterMeta));
for (let index = 4; index >= 0; index--) {
  receiver.onMessage(JSON.stringify({
    v: 0, type: 'CHAPTERS', transferId: chapterMeta.transferId,
    bookId: chapterBookId, index, total: 5,
    chapters: chapterEntries.slice(index * 13, (index + 1) * 13)
  }));
}
const chaptersUri = writeReceived('inbox/chapters.bin', chapterBytes);
const chapterOutcome = await wait((cb) =>
  receiver.receiveFileChannel(chaptersUri, null, cb));
assert.equal(chapterOutcome.ok, true);
const chapterEntry = await wait((cb) =>
  LibraryIndex.getBook(chapterBookId, cb));
assert.equal(chapterEntry.chapters.length, 65,
  'a complete long directory must be retained for chapter navigation');
assert.deepEqual(chapterEntry.chapters.map((c) => c.title),
  chapterEntries.map((c) => c.title));
assert.equal(sentMessages.map((t) => JSON.parse(t)).filter((m) =>
  m.type === 'CHAPTERS_ACK').length, 0,
  'chapter metadata transfer must not use application ACKs');

// ---- E3. 缺失/不完整目录不阻断正文校验和入库 ----
const missingMeta = Object.assign({}, meta, {
  transferId: 'file-no-chapter-meta',
  bookId: '1212121212121212', title: '无目录书'
});
delete missingMeta.chapters;
receiver.onMessage(JSON.stringify(missingMeta));
const missingOutcome = await wait((cb) =>
  receiver.receiveFileChannel(receivedUri, null, cb));
assert.equal(missingOutcome.ok, true,
  'a valid body without chapter metadata must be imported');
const missingEntry = await wait((cb) =>
  LibraryIndex.getBook(missingMeta.bookId, cb));
assert.deepEqual(missingEntry.chapters, []);

const partialMeta = Object.assign({}, chapterMeta, {
  transferId: 'file-partial-chapters',
  bookId: '3434343434343434'
});
receiver.onMessage(JSON.stringify(partialMeta));
receiver.onMessage(JSON.stringify({
  v: 0, type: 'CHAPTERS', transferId: partialMeta.transferId,
  bookId: partialMeta.bookId, index: 0, total: 5,
  chapters: chapterEntries.slice(0, 13)
}));
const partialOutcome = await wait((cb) =>
  receiver.receiveFileChannel(chaptersUri, null, cb));
assert.equal(partialOutcome.ok, true,
  'a correct body must still import when chapter chunks are missing');
const partialEntry = await wait((cb) =>
  LibraryIndex.getBook(partialMeta.bookId, cb));
assert.deepEqual(partialEntry.chapters, [],
  'an incomplete catalog must not be stored as a partial jump directory');
assert.equal(sentMessages.map((t) => JSON.parse(t)).filter((m) =>
  m.type === 'RESULT' && m.transferId === partialMeta.transferId).length, 0,
  'file-channel completion must not depend on or emit RESULT');

// ---- E4. 失效的可选目录不会清掉活动传输或正文 ----
const invalidCatalogMeta = Object.assign({}, meta, {
  transferId: 'file-invalid-catalog',
  bookId: '5656565656565656', title: '目录异常书',
  chapters: [{ title: '越界', offset: -1, length: 20 }]
});
receiver.onMessage(JSON.stringify(invalidCatalogMeta));
const invalidCatalogOutcome = await wait((cb) =>
  receiver.receiveFileChannel(receivedUri, null, cb));
assert.equal(invalidCatalogOutcome.ok, true,
  'invalid optional chapter metadata must not reject a valid body');
const invalidCatalogEntry = await wait((cb) =>
  LibraryIndex.getBook(invalidCatalogMeta.bookId, cb));
assert.deepEqual(invalidCatalogEntry.chapters, []);

// ---- E5. 被遗弃的传输超时清理后可接收下一本 ----
let fakeNow = 0;
let fakeTimerId = 0;
const fakeTimers = new Map();
const staleReplies = [];
const staleStatuses = [];
const staleReceiver = new IncomingBookReceiver((status) => staleStatuses.push(status),
  (message) => staleReplies.push(JSON.parse(message)), {
    staleTimeoutMs: 1000,
    now: () => fakeNow,
    setTimeout: (fn, delay) => {
      const id = ++fakeTimerId;
      fakeTimers.set(id, { due: fakeNow + delay, fn });
      return id;
    },
    clearTimeout: (id) => fakeTimers.delete(id)
  });
const staleMeta = Object.assign({}, chapterMeta, {
  transferId: 'abandoned-expiry',
  bookId: 'efefefefefefefef'
});
staleReceiver.onMessage(JSON.stringify(staleMeta));
fakeNow = 1001;
for (const [id, timer] of [...fakeTimers]) {
  if (timer.due <= fakeNow) {
    fakeTimers.delete(id);
    timer.fn();
  }
}
const expiryRetry = Object.assign({}, chapterMeta, {
  transferId: 'expiry-retry',
  bookId: '9898989898989898'
});
staleReceiver.onMessage(JSON.stringify(expiryRetry));
assert.ok(staleStatuses.some((status) => status === '接收《六十五章书》'),
  'bounded expiry must clear an unreachable old transaction');
const expiryOutcome = await wait((cb) =>
  staleReceiver.receiveFileChannel(chaptersUri, null, cb));
assert.equal(expiryOutcome.ok, true,
  'the next file transfer must not wait for an application ACK');

// ---- F. LibraryIndex 串行写（P1-12） ----
await wait((cb) => LibraryIndex.removeBook(bookId, cb));
await wait((cb) => LibraryIndex.removeBook(msgBookId, cb));
for (const id of [chapterBookId, missingMeta.bookId, partialMeta.bookId,
  invalidCatalogMeta.bookId, expiryRetry.bookId]) {
  await wait((cb) => LibraryIndex.removeBook(id, cb));
}
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

shelf.onDestroy();
console.info('PASS: watch receive loop (file channel, local shelf refresh, ' +
  'message channel, digest/size rejection, ' +
  'serialized index writes); book bytes=' +
  bookBytes.length);
