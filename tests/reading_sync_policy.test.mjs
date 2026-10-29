// SPDX-License-Identifier: GPL-3.0-only
// 手机端进度同步纯逻辑：UTF-8 消息上限、摘要分批、冲突判定。
import assert from 'node:assert/strict';
import {
  utf8ByteLength, isValidSummary, decideSyncAction, decidePendingAction,
  buildSummaryBatches, mergeStateBatches, MAX_SYNC_MESSAGE_BYTES
} from '../harmony/entry/src/main/ets/model/ReadingSyncPolicy.js';

assert.equal(utf8ByteLength('abc'), 3);
assert.equal(utf8ByteLength('中文'), 6);
assert.equal(utf8ByteLength('😀'), 4);

const id = '0123456789abcdef';
const sha = 'ab'.repeat(32);
assert.equal(isValidSummary({ bookId: id, sha256: sha, offset: 0 }), true);
assert.equal(isValidSummary({ bookId: id, sha256: sha, offset: 1.5 }), false);
assert.equal(isValidSummary({ bookId: 'ABC', sha256: sha, offset: 0 }), false);
assert.equal(isValidSummary({ bookId: id, sha256: 'zz', offset: 0 }), false);

assert.equal(decideSyncAction(null, { offset: 10 }, -1), 'apply_remote');
assert.equal(decideSyncAction({ offset: 10, empty: false },
  { offset: 10 }, 10), 'none');
assert.equal(decideSyncAction({ offset: 10 }, { offset: 20 }, 10),
  'apply_remote');
assert.equal(decideSyncAction({ offset: 20 }, { offset: 10 }, 10),
  'apply_local');
assert.equal(decideSyncAction({ offset: 20 }, { offset: 30 }, 10),
  'conflict');
// 未知基线不能按大小覆盖，必须冲突。
assert.equal(decideSyncAction({ offset: 20 }, { offset: 10 }, -1),
  'conflict');

// 待确认 APPLY：只有对端回到本地新位置才算确认；仍停在旧基线
// 时必须重发；第三种位置说明双方都变过，必须让用户选择。
assert.equal(decidePendingAction(20, 10, -1, 10), 'not_pending');
assert.equal(decidePendingAction(20, 10, 20, 20), 'confirmed');
assert.equal(decidePendingAction(20, 10, 20, 10), 'resend');
assert.equal(decidePendingAction(20, 10, 20, 30), 'conflict');
assert.equal(decidePendingAction(20, -1, 20, 20), 'confirmed');
assert.equal(decidePendingAction(20, -1, 20, 10), 'conflict');
// 延迟 APPLY：手机已有更新的本地进度时，旧手表位置不能直接覆盖。
assert.equal(decidePendingAction(200, 100, 200, 50), 'conflict');
assert.equal(decideSyncAction(
  { offset: 200, syncedOffset: 100 }, { offset: 50 }, 100), 'conflict');
assert.equal(decideSyncAction(
  { offset: 100, syncedOffset: 100 }, { offset: 50 }, 100), 'apply_remote');

const summaries = [];
for (let i = 0; i < 300; i++) {
  summaries.push({
    bookId: i.toString(16).padStart(16, '0'),
    sha256: sha,
    offset: i * 100,
    updatedAt: i,
    syncedOffset: i * 100
  });
}
const base = {
  v: 0, type: 'READ_PROGRESS_STATE', source: 'phone',
  requestId: 'p-long-request-id', lastBookId: id, lastUpdatedAt: 1
};
const batches = buildSummaryBatches(summaries, base,
  MAX_SYNC_MESSAGE_BYTES);
assert.ok(batches.length > 1);
let merged = { books: [], lastBookId: '', lastUpdatedAt: 0 };
for (const batch of batches) {
  const size = utf8ByteLength(JSON.stringify(batch.payload));
  assert.ok(size < MAX_SYNC_MESSAGE_BYTES, 'batch must stay <4096: ' + size);
  assert.equal(batch.payload.batches, batches.length);
  merged = mergeStateBatches(merged, batch.payload);
}
assert.equal(merged.books.length, summaries.length);
assert.equal(merged.lastBookId, id);

// 乱序分片也能拼齐；重复分片幂等。
let reversed = { books: [], lastBookId: '', lastUpdatedAt: 0 };
for (let i = batches.length - 1; i >= 0; i--) {
  reversed = mergeStateBatches(reversed, batches[i].payload);
}
assert.equal(reversed.books.length, summaries.length);
const duplicate = mergeStateBatches(merged, batches[0].payload);
assert.equal(duplicate.books.length, summaries.length);

console.log('PASS: reading sync policy boundaries, batching, conflict decisions');
