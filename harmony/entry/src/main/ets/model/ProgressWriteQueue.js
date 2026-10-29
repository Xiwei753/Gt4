// SPDX-License-Identifier: GPL-3.0-only
// 同一本书的读改写必须串行：Reader 与 Index 各自持有 Store 实例，
// 只有模块级队列才能跨实例保证 Preferences 的最终写入顺序。
// 纯 JS，Node 可直接测试。

var chains = new Map();

export function enqueueBookWrite(bookId, task) {
  var previous = chains.get(bookId);
  var run = previous === undefined ? task() : previous.then(task, task);
  chains.set(bookId, run);
  var cleanup = function () {
    if (chains.get(bookId) === run) {
      chains.delete(bookId);
    }
  };
  run.then(cleanup, cleanup);
  return run;
}
