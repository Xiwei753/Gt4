// SPDX-License-Identifier: GPL-3.0-only
// Regression for the Reader/Index progress write race: a local save that is
// already in flight must not finish after a remote apply and overwrite it.
import assert from 'node:assert/strict';
import { enqueueBookWrite, captureWriteGeneration,
  bumpWriteGeneration } from
  '../harmony/entry/src/main/ets/model/ProgressWriteQueue.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 1. Local save starts first, remote apply queues behind it. The queue must
//    run them in order, so the remote position is the final persisted state.
let state = { offset: 10, syncedOffset: 10, pendingOffset: -1 };
let active = 0;
let maxActive = 0;
function task(update, waitMs) {
  return async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (waitMs) await delay(waitMs);
      state = update;
    } finally {
      active -= 1;
    }
  };
}

const local = enqueueBookWrite('book-a',
  task({ offset: 100, syncedOffset: 10, pendingOffset: -1 }, 25));
const remote = enqueueBookWrite('book-a',
  task({ offset: 300, syncedOffset: 300, pendingOffset: -1 }, 0));
await Promise.all([local, remote]);
assert.deepEqual(state, {
  offset: 300, syncedOffset: 300, pendingOffset: -1
}, 'remote apply must win after an already-started local save');
assert.equal(maxActive, 1, 'same-book writes must never overlap');

// 2. Normal order: remote apply first, then a later local save. The local
//    position wins, while the remote baseline is preserved by store.save().
state = { offset: 300, syncedOffset: 300, pendingOffset: -1 };
await enqueueBookWrite('book-a',
  task({ offset: 300, syncedOffset: 300, pendingOffset: -1 }, 0));
await enqueueBookWrite('book-a',
  task({ offset: 320, syncedOffset: 300, pendingOffset: -1 }, 0));
assert.deepEqual(state, {
  offset: 320, syncedOffset: 300, pendingOffset: -1
}, 'normal local read after remote apply keeps the remote baseline');

// 3. A failed task must not poison the queue for the next write.
let reached = false;
await enqueueBookWrite('book-b', async () => {
  throw new Error('disk full');
}).catch(() => {});
await enqueueBookWrite('book-b', async () => { reached = true; });
assert.equal(reached, true, 'queue must recover after a rejected write');

// 4. Different books are independent of one another.
let aDone = false;
let bDone = false;
await Promise.all([
  enqueueBookWrite('book-c', async () => { await delay(10); aDone = true; }),
  enqueueBookWrite('book-d', async () => { bDone = true; })
]);
assert.equal(aDone && bDone, true, 'different books must still complete');

// 5. 反向交错：远端 apply 已排队时，先前捕获代次的旧本地 save 即使排在
//    远端之后，也必须在真正执行时被判为过期而跳过。否则会把 300 写回 100。
state = { offset: 100, syncedOffset: 100, pendingOffset: -1 };
const staleGeneration = captureWriteGeneration('book-e');
const remoteGeneration = bumpWriteGeneration('book-e');
const remoteFirst = enqueueBookWrite('book-e',
  task({ offset: 300, syncedOffset: 300, pendingOffset: -1 }, 20),
  remoteGeneration);
const staleSave = enqueueBookWrite('book-e',
  task({ offset: 100, syncedOffset: 100, pendingOffset: -1 }, 0),
  staleGeneration);
await Promise.all([remoteFirst, staleSave]);
assert.deepEqual(state, {
  offset: 300, syncedOffset: 300, pendingOffset: -1
}, 'stale save must not resurrect old position after remote apply');

// 6. 远端应用之后，真正的新滚动捕获新代次，仍应正常保存。
const laterGeneration = captureWriteGeneration('book-e');
await enqueueBookWrite('book-e',
  task({ offset: 320, syncedOffset: 300, pendingOffset: -1 }, 0),
  laterGeneration);
assert.deepEqual(state, {
  offset: 320, syncedOffset: 300, pendingOffset: -1
}, 'a genuinely later save with current generation must still persist');

// 7. markSynced 只更新基线，不得提升代次使已排队的本地新阅读失效。
state = { offset: 100, syncedOffset: 100, pendingOffset: -1 };
const localGeneration = captureWriteGeneration('book-f');
const local200 = enqueueBookWrite('book-f', async () => {
  await delay(20);
  state = { ...state, offset: 200 };
}, localGeneration);
const markSynced = enqueueBookWrite('book-f', async () => {
  state = { ...state, syncedOffset: 100 };
});
await Promise.all([local200, markSynced]);
assert.deepEqual(state, {
  offset: 200, syncedOffset: 100, pendingOffset: -1
}, 'markSynced must not invalidate an already queued local save');

// 8. markSynced 先执行、本地 save 后执行时，save 仍使用当前代次并落盘。
state = { offset: 100, syncedOffset: 100, pendingOffset: -1 };
await enqueueBookWrite('book-g', async () => {
  state = { ...state, syncedOffset: 100 };
});
const afterMetaGeneration = captureWriteGeneration('book-g');
await enqueueBookWrite('book-g', async () => {
  state = { ...state, offset: 200 };
}, afterMetaGeneration);
assert.deepEqual(state, {
  offset: 200, syncedOffset: 100, pendingOffset: -1
}, 'a local save after markSynced must still persist');

// 9. markPending 同理：只记录待确认位置，不能丢弃本地新阅读位置。
state = { offset: 100, syncedOffset: 100, pendingOffset: -1 };
const pendingSaveGeneration = captureWriteGeneration('book-h');
const pendingLocal = enqueueBookWrite('book-h', async () => {
  await delay(20);
  state = { ...state, offset: 200, pendingOffset: 200 };
}, pendingSaveGeneration);
const markPending = enqueueBookWrite('book-h', async () => {
  state = { ...state, pendingOffset: 200 };
});
await Promise.all([pendingLocal, markPending]);
assert.deepEqual(state, {
  offset: 200, syncedOffset: 100, pendingOffset: 200
}, 'markPending must not invalidate an already queued local save');

console.log('PASS: per-book progress write queue ordering and recovery');
