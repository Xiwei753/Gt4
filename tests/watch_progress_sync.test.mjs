// SPDX-License-Identifier: GPL-3.0-only
// 手表端阅读进度同步：路由、摘要、幂等、冲突、边界与删除清理。
// 使用真实文件系统桩 + @system.storage 桩，不连接 Wear Engine。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSystemFileStub } from './helpers/system_file_stub.mjs';
import { createWatchLoader, writeStorageStub }
  from './helpers/watch_module_loader.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'suyue-sync-'));
const sandbox = mkdtempSync(join(tmpdir(), 'suyue-sync-fs-'));
const stub = writeStorageStub(tmp);
const fileStub = writeSystemFileStub(tmp, sandbox);
const load = createWatchLoader({ tmpDir: tmp, stubPath: fileStub,
  storageStubPath: stub });

const storage = (await import(stub)).default;
const BookStorage = await load('storage/BookStorage.js');
const LibraryIndex = await load('storage/LibraryIndex.js');
const ProgressStore = await load('storage/ProgressStore.js');
const ProgressSync = await load('wear/ProgressSync.js');

const text = '第一章 你好，世界\n第二段：同步 😀 内容。\n'.repeat(20);
const bytes = new TextEncoder().encode(text);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const bookId = sha256.slice(0, 16);
const book = {
  bookId, title: '同步测试书', bytes: bytes.length, sha256,
  chapters: [{ title: '正文', offset: 0, length: bytes.length }]
};

const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (fn) => new Promise((resolve) => fn(resolve));
const get = () => call((cb) => ProgressStore.loadProgress(bookId, cb));
const base = () => call((cb) => ProgressStore.loadSyncBase(bookId, cb));
const save = (offset, history = []) => call((cb) =>
  ProgressStore.saveProgress(bookId, offset, history, null, cb));
const saveBase = (offset) => call((cb) =>
  ProgressStore.saveSyncBase(bookId, offset, 1, cb));

await call((cb) => BookStorage.ensureDirs(cb));
mkdirSync(join(sandbox, 'gt4reader/books'), { recursive: true });
writeFileSync(join(sandbox, 'gt4reader/books/' + bookId + '.txt'),
  Buffer.from(bytes));
const added = await call((cb) => LibraryIndex.addBook(book, cb));
assert.equal(added.ok, true);

let sent = [];
const send = (text) => { sent.push(JSON.parse(text)); };

// GET → 手表回 STATE，且只含已有进度的书。
await save(3, [0]);
await saveBase(3);
sent = [];
assert.equal(ProgressSync.handleMessage(JSON.stringify({
  v: 0, type: 'READ_PROGRESS_GET', source: 'phone', requestId: 'r1'
}), send), true);
await wait();
assert.equal(sent.length, 1);
assert.equal(sent[0].type, 'READ_PROGRESS_STATE');
assert.equal(sent[0].source, 'watch');
assert.equal(sent[0].books[0].bookId, bookId);
assert.equal(sent[0].books[0].offset, 3);
assert.ok(JSON.stringify(sent[0]).length < 4096);

// 非进度消息不接管，交回传书接收器。
assert.equal(ProgressSync.handleMessage(JSON.stringify({
  v: 0, type: 'RESULT', ok: true
}), send), false);

// 本地无进度：采用远端，并写入同步基线。
await call((cb) => ProgressStore.clearProgress(bookId, cb));
sent = [];
ProgressSync.handleMessage(JSON.stringify({
  v: 0, type: 'READ_PROGRESS_STATE', source: 'phone',
  books: [{ bookId, sha256, offset: 3, updatedAt: 10 }]
}), send);
await wait();
assert.equal((await get()).offset, 3);
assert.equal((await base()).offset, 3);

// 摘要不符：忽略，不创建/不覆盖。
await save(6, [3]);
sent = [];
ProgressSync.handleMessage(JSON.stringify({
  v: 0, type: 'READ_PROGRESS_STATE', source: 'phone',
  books: [{ bookId, sha256: 'ff'.repeat(32), offset: 9, updatedAt: 20 }]
}), send);
await wait();
assert.equal((await get()).offset, 6);

// 两边都改过：不覆盖，把手表摘要发回手机等待选择。
await saveBase(0);
sent = [];
ProgressSync.handleMessage(JSON.stringify({
  v: 0, type: 'READ_PROGRESS_STATE', source: 'phone',
  books: [{ bookId, sha256, offset: 9, updatedAt: 20 }]
}), send);
await wait();
assert.equal((await get()).offset, 6);
assert.ok(sent.some((m) => m.type === 'READ_PROGRESS_STATE' &&
  m.books[0].offset === 6));

// 本地新读、远端仍等于基线：发 APPLY 让手机采用手表进度。
await saveBase(3);
sent = [];
ProgressSync.handleMessage(JSON.stringify({
  v: 0, type: 'READ_PROGRESS_STATE', source: 'phone',
  books: [{ bookId, sha256, offset: 3, updatedAt: 10 }]
}), send);
await wait();
assert.ok(sent.some((m) => m.type === 'READ_PROGRESS_APPLY' &&
  m.offset === 6));

// APPLY 合法：清空旧历史并应用。
sent = [];
ProgressSync.handleMessage(JSON.stringify({
  v: 0, type: 'READ_PROGRESS_APPLY', source: 'phone',
  bookId, sha256, offset: 3, updatedAt: 30
}), send);
await wait();
let restored = await get();
assert.equal(restored.offset, 3);
assert.deepEqual(restored.history, []);
assert.equal((await base()).offset, 3);

// UTF-8 续字节偏移：拒绝，保持原进度。
ProgressSync.handleMessage(JSON.stringify({
  v: 0, type: 'READ_PROGRESS_APPLY', source: 'phone',
  bookId, sha256, offset: 1, updatedAt: 40
}), send);
await wait();
assert.equal((await get()).offset, 3);

// 超出正文范围：拒绝。
ProgressSync.handleMessage(JSON.stringify({
  v: 0, type: 'READ_PROGRESS_APPLY', source: 'phone',
  bookId, sha256, offset: bytes.length + 1, updatedAt: 41
}), send);
await wait();
assert.equal((await get()).offset, 3);

// 删除清理：进度、同步基线、last 一并移除。
await call((cb) => ProgressStore.saveLastBook(bookId, cb));
await call((cb) => ProgressStore.clearProgress(bookId, cb));
assert.equal(storage.__values['suyue.pos.' + bookId], undefined);
assert.equal(storage.__values['suyue.sync.' + bookId], undefined);
assert.equal(storage.__values['suyue.last'], undefined);

console.log('PASS: watch progress sync route/summary/apply/conflict/delete');
