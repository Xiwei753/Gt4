// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/transfer_waiters.test.mjs
// RESULT waiter 生命周期回归（第二轮 P0-3），
// 针对复核指出的三个具体缺陷：
//   1. 首次超时后重试无法被新回执唤醒；
//   2. 上传时间被计入回执超时（大文件误超时）；
//   3. 早退/异常路径残留计时器。
// 计时器为注入的假时钟，全程确定性。
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync }
  from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'suyue-wait-'));
const src = readFileSync(
  'harmony/entry/src/main/ets/services/TransferWaiters.js',
  'utf8');
const modPath = join(tmp, 'TransferWaiters.mjs');
writeFileSync(modPath, src);
const { createWaiterRegistry, sendThenAwaitChapterAck } =
  await import(modPath);

// Phone UI book transfer must be explicitly one-shot. The waiter registry
// itself remains able to handle late RESULT, but BookTransferService never
// schedules a second HELLO/file upload after a failed attempt.
const senderSrc = readFileSync(
  'harmony/entry/src/main/ets/services/BookTransferService.ts', 'utf8');
const phoneSrc = readFileSync(
  'harmony/entry/src/main/ets/pages/Index.ets', 'utf8');
assert.ok(senderSrc.includes('this.waiters.beginAttempt(transferId)') &&
  !senderSrc.includes('while (attempt <= retry)') &&
  !senderSrc.includes('retry: number =') &&
  !senderSrc.includes('重试耗尽') &&
  senderSrc.includes("progress.phase = 'HELLO'") &&
  senderSrc.includes("progress.phase = 'TRANSFER_FILE'") &&
  senderSrc.includes("progress.sdkCode = Number(codeFromMessage[1])"),
  'one user book-send action must have one attempt and retain failure stage/code');
assert.ok(phoneSrc.includes("recordReaderDiagnostic(context, 'transfer', 'fail', lastSdkCode") &&
  phoneSrc.includes("recordReaderDiagnostic(context, 'device', 'discover_fail'") &&
  !phoneSrc.includes('planRetry('),
  'phone diagnostics must preserve transfer/device failure details and never auto-retry discovery');

function makeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { due: now + ms, fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    tick(ms) {
      now += ms;
      let fired = true;
      while (fired) {
        fired = false;
        for (const [id, t] of [...timers]) {
          if (t.due <= now) {
            timers.delete(id);
            t.fn();
            fired = true;
          }
        }
      }
    },
    pending() { return timers.size; }
  };
}

const makeRegistry = (uploadTimeoutMs = 300000,
  resultTimeoutMs = 60000) =>
  createWaiterRegistry({ setTimeout: null,
    clearTimeout: null, uploadTimeoutMs, resultTimeoutMs });

// ---- 1. 首次回执超时后，第二轮能被新 RESULT 唤醒 ----
{
  const clock = makeClock();
  const reg = createWaiterRegistry({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    uploadTimeoutMs: 300000,
    resultTimeoutMs: 60000
  });
  const first = reg.beginAttempt('t1');
  reg.markUploaded('t1');
  clock.tick(60001);
  assert.deepEqual(await first,
    { ok: false, reason: 'E_TIMEOUT', phase: 'result' },
    'first attempt must time out on the result phase');
  assert.equal(reg.phase('t1'), 'result-timeout');

  const second = reg.beginAttempt('t1');
  assert.equal(reg.attempt('t1'), 2,
    'second attempt must be a fresh waiter');
  reg.markUploaded('t1');
  const resolved = reg.deliver({ transferId: 't1',
    ok: true });
  assert.equal(resolved, true,
    'new RESULT must wake the second attempt');
  assert.deepEqual(await second, { ok: true });
  reg.end('t1');
  assert.equal(clock.pending(), 0,
    'no stray timers after end');
}

// ---- 2. RESULT 早于上传回调到达 ----
{
  const clock = makeClock();
  const reg = createWaiterRegistry({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    uploadTimeoutMs: 300000,
    resultTimeoutMs: 60000
  });
  const attempt = reg.beginAttempt('t2');
  assert.equal(reg.phase('t2'), 'upload');
  // 上传尚未结束，回执已到（手表快速处理）。
  reg.deliver({ transferId: 't2', ok: true });
  assert.deepEqual(await attempt, { ok: true },
    'RESULT during upload must resolve immediately');
  // 上传回调随后到达：不得重启计时器或再次解析。
  reg.markUploaded('t2');
  assert.equal(clock.pending(), 0,
    'markUploaded after delivery must not arm timers');
  reg.end('t2');
}

// ---- 3. 上传超过回执超时不算超时（阶段分离） ----
{
  const clock = makeClock();
  const reg = createWaiterRegistry({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    uploadTimeoutMs: 300000,
    resultTimeoutMs: 60000
  });
  let settled = false;
  const attempt = reg.beginAttempt('t3')
    .then((v) => { settled = true; return v; });
  // 上传历时 120s（超过 resultTimeoutMs=60s）：
  // 回执计时器尚未启动，不得超时。
  clock.tick(120000);
  assert.equal(settled, false,
    'upload duration must not count toward the result timeout');
  reg.markUploaded('t3');
  clock.tick(59999);
  assert.equal(settled, false);
  clock.tick(2);
  assert.deepEqual(await attempt,
    { ok: false, reason: 'E_TIMEOUT', phase: 'result' },
    'result timer starts only after upload completes');
  reg.end('t3');
}

// ---- 3b. 上传阶段自身超时 ----
{
  const clock = makeClock();
  const reg = createWaiterRegistry({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    uploadTimeoutMs: 300000,
    resultTimeoutMs: 60000
  });
  const attempt = reg.beginAttempt('t3b');
  clock.tick(300001);
  assert.deepEqual(await attempt,
    { ok: false, reason: 'E_TIMEOUT', phase: 'upload' },
    'upload phase timeout is reported separately');
  reg.end('t3b');
}

// ---- 4. 迟到回执不丢失 ----
{
  const clock = makeClock();
  const reg = createWaiterRegistry({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    uploadTimeoutMs: 300000,
    resultTimeoutMs: 60000
  });
  const attempt = reg.beginAttempt('t4');
  reg.markUploaded('t4');
  clock.tick(60001);
  await attempt;
  // 超时之后回执才到。
  const woken = reg.deliver({ transferId: 't4', ok: true });
  assert.equal(woken, false,
    'no live waiter to wake after timeout');
  assert.deepEqual(reg.receipt('t4'), { ok: true },
    'late receipt must be cached');
  // 下一轮重试可用缓存判断，不再当作未知。
  assert.deepEqual(reg.receipt('t4'), { ok: true });
  reg.end('t4');
}

// ---- 5. fail()/end() 清理计时器 ----
{
  const clock = makeClock();
  const reg = createWaiterRegistry({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    uploadTimeoutMs: 300000,
    resultTimeoutMs: 60000
  });
  const attempt = reg.beginAttempt('t5');
  reg.fail('t5', 'E_CANCELLED');
  assert.deepEqual(await attempt,
    { ok: false, reason: 'E_CANCELLED' });
  assert.equal(clock.pending(), 0,
    'fail must clear timers');
  clock.tick(1000000);
  reg.end('t5');
}

// ---- 6. 新一轮 beginAttempt 令旧等待者以 E_SUPERSEDED 结束 ----
{
  const clock = makeClock();
  const reg = createWaiterRegistry({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    uploadTimeoutMs: 300000,
    resultTimeoutMs: 60000
  });
  const first = reg.beginAttempt('t6');
  const second = reg.beginAttempt('t6');
  assert.deepEqual(await first,
    { ok: false, reason: 'E_SUPERSEDED',
      phase: 'superseded' },
    'old waiter must not hang across attempts');
  assert.equal(reg.attempt('t6'), 2);
  reg.markUploaded('t6');
  reg.deliver({ transferId: 't6', ok: true });
  assert.deepEqual(await second, { ok: true });
  reg.end('t6');
  assert.equal(clock.pending(), 0);
}

// ---- 7. 重复回执只解析一次 ----
{
  const clock = makeClock();
  const reg = createWaiterRegistry({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    uploadTimeoutMs: 300000,
    resultTimeoutMs: 60000
  });
  const attempt = reg.beginAttempt('t7');
  reg.markUploaded('t7');
  assert.equal(reg.deliver({ transferId: 't7', ok: false,
    reason: 'E_DIGEST_MISMATCH' }), true);
  assert.equal(reg.deliver({ transferId: 't7', ok: true }),
    false, 'second RESULT must not re-resolve');
  assert.deepEqual(await attempt,
    { ok: false, reason: 'E_DIGEST_MISMATCH' },
    'first outcome wins');
  reg.end('t7');
}

// 负超时（禁用）不设计时器
{
  const reg = makeRegistry(0, 0);
  const attempt = reg.beginAttempt('t8');
  reg.markUploaded('t8');
  reg.deliver({ transferId: 't8', ok: true });
  assert.deepEqual(await attempt, { ok: true });
  reg.end('t8');
}

console.info('PASS: RESULT waiter lifecycle ' +
  '(retry rounds, upload/result phase separation, ' +
  'early RESULT, late receipt, timer cleanup)');

// ---- 8. CHAPTERS_ACK must match the one in-flight catalog slice ----
{
  const clock = makeClock();
  const reg = createWaiterRegistry({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    uploadTimeoutMs: 300000,
    resultTimeoutMs: 60000,
    chapterAckTimeoutMs: 10000
  });
  const ack = reg.beginChapterAck('chapter-transfer', 'book-1', 0, 2);
  assert.equal(reg.deliverChapterAck({ v: 0, type: 'CHAPTERS_ACK',
    transferId: 'stale-transfer', bookId: 'book-1',
    index: 0, total: 2, ok: true }), false,
  'stale transfer ACK must not release the waiter');
  assert.equal(reg.deliverChapterAck({ v: 0, type: 'CHAPTERS_ACK',
    transferId: 'chapter-transfer', bookId: 'other-book',
    index: 0, total: 2, ok: true }), false,
  'wrong book ACK must not release the waiter');
  assert.equal(reg.deliverChapterAck({ v: 0, type: 'CHAPTERS_ACK',
    transferId: 'chapter-transfer', bookId: 'book-1',
    index: 1, total: 2, ok: true }), false,
  'out-of-order ACK must not release the current slice');
  assert.equal(reg.deliverChapterAck({ v: 0, type: 'CHAPTERS_ACK',
    transferId: 'chapter-transfer', bookId: 'book-1',
    index: 0, total: 2, ok: true }), true);
  assert.deepEqual(await ack, { ok: true });
  assert.equal(reg.deliverChapterAck({ v: 0, type: 'CHAPTERS_ACK',
    transferId: 'chapter-transfer', bookId: 'book-1',
    index: 0, total: 2, ok: true }), false,
  'duplicate late ACK must be ignored');
  reg.end('chapter-transfer');
  assert.equal(clock.pending(), 0);
}

// ---- 9. ACK timeout and cancellation clear the chapter waiter ----
{
  const clock = makeClock();
  const reg = createWaiterRegistry({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    uploadTimeoutMs: 300000,
    resultTimeoutMs: 60000,
    chapterAckTimeoutMs: 10000
  });
  const ack = reg.beginChapterAck('chapter-timeout', 'book-2', 3, 5);
  clock.tick(9999);
  assert.equal(clock.pending(), 1);
  clock.tick(1);
  assert.deepEqual(await ack, { ok: false,
    reason: 'E_CHAPTERS_ACK_TIMEOUT', phase: 'chapters_ack' });
  assert.equal(reg.deliverChapterAck({ v: 0, type: 'CHAPTERS_ACK',
    transferId: 'chapter-timeout', bookId: 'book-2',
    index: 3, total: 5, ok: true }), false,
  'timed out ACK must not revive the waiter');
  reg.end('chapter-timeout');
  assert.equal(clock.pending(), 0);

  const cancelled = reg.beginChapterAck('chapter-cancel', 'book-3', 0, 1);
  reg.fail('chapter-cancel', 'E_CANCELLED');
  assert.deepEqual(await cancelled,
    { ok: false, reason: 'E_CANCELLED', phase: 'chapters_ack' });
  reg.end('chapter-cancel');
  assert.equal(clock.pending(), 0,
    'cancellation must clear the chapter ACK timeout');
}

console.info('PASS: CHAPTERS_ACK matching, timeout, cancellation and stale ACK handling');

// ---- 10. ACK cannot outrun a later SDK send failure ----
{
  let rejectSend = null;
  const sendPromise = new Promise((resolve, reject) => {
    rejectSend = reject;
  });
  const ackPromise = Promise.resolve({ ok: true });
  let fileTransferStarted = false;
  const flow = sendThenAwaitChapterAck(sendPromise, ackPromise)
    .then((ack) => {
      if (ack.ok) fileTransferStarted = true;
    });
  await Promise.resolve();
  assert.equal(fileTransferStarted, false,
    'an early ACK must not start file transfer before SDK send completes');
  rejectSend(new Error('SDK send failed after early ACK'));
  await assert.rejects(flow, /SDK send failed/);
  assert.equal(fileTransferStarted, false,
    'a late SDK failure must prevent file transfer');
}

// ---- 11. A successful send still waits for ACK and timeout blocks file ----
{
  let resolveSend = null;
  const sendPromise = new Promise((resolve) => {
    resolveSend = resolve;
  });
  const ackPromise = Promise.resolve({ ok: false,
    reason: 'E_CHAPTERS_ACK_TIMEOUT' });
  let fileTransferStarted = false;
  const flow = sendThenAwaitChapterAck(sendPromise, ackPromise)
    .then((ack) => {
      if (ack.ok) fileTransferStarted = true;
      return ack;
    });
  await Promise.resolve();
  assert.equal(fileTransferStarted, false,
    'the unresolved send must remain the first gate');
  resolveSend();
  assert.deepEqual(await flow, { ok: false,
    reason: 'E_CHAPTERS_ACK_TIMEOUT' });
  assert.equal(fileTransferStarted, false,
    'successful send plus ACK timeout must not start file transfer');
}

assert.ok(senderSrc.includes('sendThenAwaitChapterAck(') &&
  !senderSrc.includes('Promise.race') &&
  senderSrc.includes('notifyRemoteCancellation(transferId)'),
  'phone must await SDK send then ACK and cancel remote state after failure');
console.info('PASS: chapter send result gates ACK and file transfer');
