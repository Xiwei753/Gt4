// SPDX-License-Identifier: GPL-3.0-only
// Regression for the Reader/Index progress write race: a local save that is
// already in flight must not finish after a remote apply and overwrite it.
import assert from 'node:assert/strict';
import { enqueueBookWrite } from
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

console.log('PASS: per-book progress write queue ordering and recovery');
