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
//   - 回执关联：RESULT 必须按 transferId 关联，串号不得计入成功；
//   - 成功只在 ok=true 时成立；E_BUSY / E_CANCELLED 等为失败；
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

// ---------- 4) 回执关联（照 Android ReceiptMatcher 语义，P0-C） ----------
// 只有 v=0 且 type=RESULT，且 transferId 与 bookId 同时命中当前等待者，
// 才唤醒本次等待；串号 / 别的书 / 缺 bookId 一律忽略。
const receipts = new Map();
let pending = null; // { transferId, bookId }
const begin = (transferId, bookId) => { pending = { transferId, bookId }; };
const clearPending = () => { pending = null; };
const deliver = (json) => {
  if (json.v !== 0 || json.type !== 'RESULT') return false;
  const tid = json.transferId;
  const bid = json.bookId;
  if (typeof tid !== 'string' || tid.length === 0) return false;
  if (typeof bid !== 'string' || bid.length === 0) return false;
  if (!pending || pending.transferId !== tid || pending.bookId !== bid) {
    return false;
  }
  receipts.set(tid, { ok: json.ok === true, reason: json.reason });
  return true;
};
const inFlight = 'aaaa0000bbbb1111cccc2222dddd3333';
const bookId = '3a7bd3e2360a4f5c';
begin(inFlight, bookId);
assert.equal(
  deliver({ v: 0, type: 'RESULT', transferId: inFlight, bookId, ok: true }), true);
assert.equal(receipts.get(inFlight).ok, true, 'ok=true is success');
// 别的 transferId 的回执不得被认为唤醒本次等待者。
const other = 'ffff9999eeee8888dddd7777cccc6666';
assert.equal(
  deliver({ v: 0, type: 'RESULT', transferId: other, bookId, ok: true }), false,
  'stray transferId must not match');
// transferId 对但 bookId 不同（串号到别的书）也必须忽略。
assert.equal(
  deliver({ v: 0, type: 'RESULT', transferId: inFlight,
    bookId: 'deadbeefdeadbeef', ok: true }), false,
  'bookId mismatch must not match');
// 缺 bookId 的帧不得被当成命中（协议要求 RESULT 携带 bookId）。
assert.equal(
  deliver({ v: 0, type: 'RESULT', transferId: inFlight, ok: true }), false,
  'missing bookId must not match');
// 非 RESULT / 坏帧被丢弃。
assert.equal(
  deliver({ v: 0, type: 'ACK', transferId: inFlight, bookId, index: 0 }), false);
assert.equal(
  deliver({ v: 1, type: 'RESULT', transferId: inFlight, bookId, ok: true }),
  false);
assert.equal(
  deliver({ v: 0, type: 'RESULT', transferId: '', bookId, ok: true }), false);

// ok=false 一律失败；E_BUSY 不可重试成功。
assert.equal(
  deliver({ v: 0, type: 'RESULT', transferId: inFlight, bookId,
    ok: false, reason: 'E_BUSY' }), true);
assert.equal(receipts.get(inFlight).ok, false, 'E_BUSY must be failure');
assert.equal(receipts.get(inFlight).reason, 'E_BUSY');
assert.equal(
  deliver({ v: 0, type: 'RESULT', transferId: inFlight, bookId,
    ok: false, reason: 'E_DIGEST_MISMATCH' }), true);
assert.equal(receipts.get(inFlight).ok, false);
// 取消/重试后清空 pending：迟到回执不得再命中。
clearPending();
assert.equal(
  deliver({ v: 0, type: 'RESULT', transferId: inFlight, bookId, ok: true }),
  false, 'late receipt after clear must not match');

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
for (const type of ['HELLO', 'BOOK_META', 'RESULT', 'ERROR']) {
  assert.ok(transferService.includes('"' + type + '"'),
    'BookTransferService must emit/accept ' + type);
}

// P0-C：回执匹配器必须同时比对 transferId 与 bookId（纯 Kotlin 逻辑）。
const receiptMatcher = read('wear/ReceiptMatcher.kt');
assert.ok(
  receiptMatcher.includes('current.transferId != transferId || current.bookId != bookId'),
  'ReceiptMatcher must match BOTH transferId and bookId');

// P1-5：重发策略必须允许已发送/发送失败的书籍再次发送。
const sendPolicy = read('model/SendPolicy.kt');
for (const s of ['READY', 'SENT', 'TRANSFER_FAILED']) {
  assert.ok(sendPolicy.includes(s), 'SendPolicy.isSendable must allow ' + s);
}

const appGradle = read('../../../../../../build.gradle.kts');
assert.ok(appGradle.includes('applicationId = "com.xiwei.suyue.android"'),
  'applicationId must be com.xiwei.suyue.android');

console.info('PASS: android protocol examples, UTF-8 byte offsets, sha256/bookId, ' +
  'BOOK_META fields, receipt correlation, cancel, Kotlin constants');
