// SPDX-License-Identifier: GPL-3.0-only
// 同一本书的读改写串行队列 + 写入代次。
// Reader 与 Index 各自持有 Store 实例；只有模块级 Map 能跨实例
// 保证 Preferences 的最终写入顺序。代次用于在任务真正执行时丢弃
// 远端应用之前排队的旧本地保存。
var chains = new Map();
var generations = new Map();

export function captureWriteGeneration(bookId) {
  var value = generations.get(bookId);
  return value === undefined ? 0 : value;
}

export function bumpWriteGeneration(bookId) {
  var next = captureWriteGeneration(bookId) + 1;
  generations.set(bookId, next);
  return next;
}

export function enqueueBookWrite(bookId, task, generation) {
  var previous = chains.get(bookId);
  var guarded = function () {
    if (generation !== undefined &&
        generation !== captureWriteGeneration(bookId)) {
      return Promise.resolve();
    }
    return task();
  };
  var run = previous === undefined ? guarded() : previous.then(guarded, guarded);
  chains.set(bookId, run);
  var cleanup = function () {
    if (chains.get(bookId) === run) {
      chains.delete(bookId);
    }
  };
  run.then(cleanup, cleanup);
  return run;
}
