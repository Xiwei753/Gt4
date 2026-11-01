// SPDX-License-Identifier: GPL-3.0-only
// Android 侧协议一致性交叉验证（issue #3）。
//
// 目的：Android APK 是同一套 protocol v0 的“手机”生产者，
// 不引入第三套协议。本测试把 Android 的产物形状与共享示例、
// 以及与 Kotlin 源码里的常量做静态对齐，Node 即可运行：
//   node tests/android-protocol.test.mjs
//
// 覆盖：
//   - 共享 examples/*.json（含 android-*.json）字段齐全；
//   - android-book-meta.json 的 UTF-8 字节数 / 章节偏移 / SHA-256 /
//     bookId（sha256 前 16 位）/ chunks 与真实正文自洽；
//   - Android BOOK_META 生产者字段集合与协议契约一致；
//   - 文件通道回调是发送方完成边界；不会等待 RESULT 或自动重发；
//   - Kotlin 常量与身份名静态对齐（包名 / 手表 bundle / 分块 / 上限）。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ---------- 1) 共享示例（含 Android 新增示例）字段齐全 ----------
const EXAMPLES = new URL('../protocol/examples/', import.meta.url);
const files = readdirSync(EXAMPLES).filter((f) => f.endsWith('.json'));
for (const f of files) {
  const msg = JSON.parse(readFileSync(new URL(f, EXAMPLES), 'utf8'));
  assert.equal(typeof msg.v, 'number', f + ': v required');
  assert.equal(msg.v, 0, f + ': only protocol v0 is defined');
  assert.equal(typeof msg.type, 'string', f + ': type required');
  if (msg.type.indexOf('READ_PROGRESS_') === 0) {
    // 阅读进度是独立于传书的协议；字段由 tests/watch_progress_sync
    // 与 tests/phone_reader_sync 校验，不要求 transferId。
    continue;
  }
  if (msg.type !== 'HELLO') {
    assert.equal(typeof msg.transferId, 'string',
      f + ': transferId required for non-HELLO');
    assert.ok(msg.transferId.length > 0, f + ': transferId must be non-empty');
  }
}
for (const required of ['android-book-meta.json', 'android-result.json']) {
  assert.ok(files.includes(required), required + ' must exist');
}

// ---------- 2) android-book-meta.json 与真实正文自洽 ----------
// 正文 = 两个章节的 UTF-8 拼接；字节偏移是 UTF-8 字节数，
// 而不是字符数（中文每字 3 字节）。
const meta = JSON.parse(
  readFileSync(new URL('android-book-meta.json', EXAMPLES), 'utf8'));
assert.equal(meta.type, 'BOOK_META');
assert.equal(meta.encoding, 'utf-8');
assert.equal(meta.chunkBytes, 65536, 'Android chunkBytes = 64KB');
assert.match(meta.sha256, /^[0-9a-f]{64}$/, 'sha256 lowercase hex');
assert.equal(meta.bookId, meta.sha256.slice(0, 16),
  'bookId = sha256 first 16 chars');

const chapterTexts = ['第一章正文。\n', '第二章正文。\n'];
const body = Buffer.from(chapterTexts.join(''), 'utf8');
assert.equal(body.length, meta.bytes, 'bytes = UTF-8 byte length');
assert.equal(sha256(body), meta.sha256, 'sha256 must match body');
assert.equal(meta.bookId, sha256(body).slice(0, 16));

let covered = 0;
for (const [i, ch] of meta.chapters.entries()) {
  assert.equal(ch.offset, covered, 'chapters contiguous from 0');
  assert.equal(ch.length, Buffer.byteLength(chapterTexts[i], 'utf8'),
    'chapter length = UTF-8 bytes of that chapter');
  covered += ch.length;
}
assert.equal(covered, meta.bytes, 'chapters must cover bytes');
assert.equal(meta.chunks, Math.max(1, Math.ceil(meta.bytes / meta.chunkBytes)),
  'chunks = ceil(bytes/chunkBytes), min 1');

// ---------- 3) Android BOOK_META 生产者字段集合 ----------
const META_KEYS = ['bookId', 'title', 'encoding', 'bytes', 'sha256',
  'chunks', 'chunkBytes', 'chapters'];
for (const key of META_KEYS) {
  assert.ok(Object.prototype.hasOwnProperty.call(meta, key),
    'android BOOK_META must carry ' + key);
}
const SRC = new URL(
  '../android/app/src/main/java/com/xiwei/suyue/', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, SRC), 'utf8');

const bookModels = read('model/BookModels.kt');
for (const key of META_KEYS) {
  assert.ok(bookModels.includes('.put("' + key + '"'),
    'BookModels.toBookMetaPayload must put ' + key);
}
assert.ok(bookModels.includes('sha256.take(16)'),
  'Android bookId = sha256.take(16)');

// ---------- 4) 当前发送路径不依赖应用层回执或重试 ----------
const transferSource = read('wear/BookTransferService.kt');
assert.ok(transferSource.includes('gateway.sendFile(') &&
  transferSource.includes('message = "文件已发送；手表侧校验和入库未确认"'),
  'transferFile success must be reported without claiming watch ingestion');
assert.ok(!transferSource.includes('CompletableDeferred') &&
  !transferSource.includes('RESULT_TIMEOUT_MS') &&
  !transferSource.includes('ReceiptMatcher') &&
  !transferSource.includes('while (attempt') &&
  !transferSource.includes('MAX_RETRY'),
  'Android sender must not wait for RESULT or automatically retry');

// ---------- 5) 取消语义 ----------
const cancel = JSON.parse(
  readFileSync(new URL('android-cancel.json', EXAMPLES), 'utf8'));
assert.equal(cancel.type, 'ERROR');
assert.equal(cancel.code, 'E_CANCELLED');
assert.equal(cancel.transferId, meta.transferId);

// ---------- 6) Kotlin 常量 / 身份名静态对齐 ----------
const peerIdentity = read('wear/PeerIdentity.kt');
assert.ok(peerIdentity.includes('WATCH_BUNDLE_NAME = "con.xiwei.suyue.gt4"'),
  'watch bundle must be con.xiwei.suyue.gt4 (con, not com)');
assert.ok(peerIdentity.includes('PHONE_BUNDLE_NAME = "com.xiwei.suyue.android"'),
  'phone bundle must be the AGC Android package name com.xiwei.suyue.android');

const identityConfig = read('wear/PeerIdentityConfig.kt');
assert.ok(identityConfig.includes('INJECTED_WATCH_FINGERPRINT = ""'),
  'fingerprint placeholder must stay empty (injected at build time)');

const importService = read('importer/BookImportService.kt');
assert.ok(importService.includes('MAX_BOOK_BYTES = 32L * 1024 * 1024'),
  'import cap = 32MB');
assert.ok(importService.includes('MESSAGE_CHUNK_BYTES = 64 * 1024'),
  'message chunk = 64KB');

const transferService = read('wear/BookTransferService.kt');
for (const type of ['HELLO', 'BOOK_META', 'ERROR']) {
  assert.ok(transferService.includes('"' + type + '"'),
    'BookTransferService must emit/accept ' + type);
}

// P1-5：重发策略必须允许已发送/发送失败的书籍再次发送。
const sendPolicy = read('model/SendPolicy.kt');
for (const s of ['READY', 'SENT', 'TRANSFER_FAILED']) {
  assert.ok(sendPolicy.includes(s), 'SendPolicy.isSendable must allow ' + s);
}

const appGradle = read('../../../../../../build.gradle.kts');
assert.ok(appGradle.includes('applicationId = "com.xiwei.suyue.android"'),
  'applicationId must be com.xiwei.suyue.android');

console.info('PASS: android protocol examples, UTF-8 byte offsets, sha256/bookId, ' +
  'BOOK_META fields, file-send completion boundary, cancel, Kotlin constants');
