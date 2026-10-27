// SPDX-License-Identifier: GPL-3.0-only
// RESULT waiter 生命周期（第二轮 P0-3）。
//
// 修复的问题：
//   - 旧实现整个 sendBook 只注册一个 waiter，
//     首次 60s 超时后 Promise 固定为 E_TIMEOUT，
//     重试轮次无法被新回执唤醒；
//   - 等待计时覆盖了设备检查 + HELLO + 整个
//     上传，大文件在上传期间就会过期；
//   - 早退/异常路径只 pending.delete，未
//     clearTimeout，旧计时器仍会触发。
//
// 本模块把状态机做成纯逻辑（注入 setTimeout /
// clearTimeout），Node 可直接测试；ArkTS 侧
// （BookTransferService.ets）import 本 .js
// 模块——ArkTS↔JS 互操作本身待真机编译验证。
//
// 语义：
//   - 每个重试轮次调用 beginAttempt() 注册全新
//     waiter，旧 waiter 立即以 E_SUPERSEDED 结束
//     并清理计时器；
//   - 超时分为上传阶段（uploadTimeoutMs）与
//     回执阶段（resultTimeoutMs）；markUploaded()
//     切阶段：清上传计时器、起回执计时器。
//     上传超过 resultTimeoutMs 不会被误判超时；
//   - RESULT 可早于上传回调到达：deliver() 在
//     任何阶段都解析当前等待者；
//   - 迟到回执（waiter 已结束）只入缓存，不丢失；
//   - fail()/end() 统一清理计时器。

export function createWaiterRegistry(env) {
  const setTimer = env.setTimeout;
  const clearTimer = env.clearTimeout;
  const uploadTimeoutMs = env.uploadTimeoutMs;
  const resultTimeoutMs = env.resultTimeoutMs;

  const waiters = {};   // transferId → waiter
  const receipts = {};  // transferId → {ok, reason}

  function clearWaiter(waiter) {
    if (waiter.uploadTimer !== null) {
      clearTimer(waiter.uploadTimer);
      waiter.uploadTimer = null;
    }
    if (waiter.resultTimer !== null) {
      clearTimer(waiter.resultTimer);
      waiter.resultTimer = null;
    }
  }

  function settle(waiter, outcome) {
    if (waiter.settled) return;
    waiter.settled = true;
    clearWaiter(waiter);
    waiter.resolve(outcome);
  }

  function startResultTimer(waiter) {
    if (resultTimeoutMs <= 0 || waiter.settled) return;
    waiter.resultTimer = setTimer(() => {
      waiter.resultTimer = null;
      waiter.phase = 'result-timeout';
      settle(waiter, { ok: false, reason: 'E_TIMEOUT',
        phase: 'result' });
    }, resultTimeoutMs);
  }

  return {
    // 新重试轮次：注册全新 waiter。
    beginAttempt: function (transferId) {
      const previous = waiters[transferId];
      if (previous && !previous.settled) {
        previous.phase = 'superseded';
        settle(previous, { ok: false,
          reason: 'E_SUPERSEDED', phase: 'superseded' });
      }
      let resolveFn = null;
      const promise = new Promise((resolve) => {
        resolveFn = resolve;
      });
      const waiter = {
        promise: promise,
        resolve: resolveFn,
        settled: false,
        phase: 'upload',
        attempt: previous ? previous.attempt + 1 : 1,
        uploadTimer: null,
        resultTimer: null
      };
      if (uploadTimeoutMs > 0) {
        waiter.uploadTimer = setTimer(() => {
          waiter.uploadTimer = null;
          waiter.phase = 'upload-timeout';
          settle(waiter, { ok: false, reason: 'E_TIMEOUT',
            phase: 'upload' });
        }, uploadTimeoutMs);
      }
      waiters[transferId] = waiter;
      return promise;
    },

    // 上传完成：切换为回执等待阶段。
    markUploaded: function (transferId) {
      const waiter = waiters[transferId];
      if (!waiter || waiter.settled) return;
      if (waiter.uploadTimer !== null) {
        clearTimer(waiter.uploadTimer);
        waiter.uploadTimer = null;
      }
      waiter.phase = 'result';
      startResultTimer(waiter);
    },

    // RESULT 到达：缓存 + 解析当前等待者。
    // 返回 true 表示有活跃 waiter 被唤醒。
    deliver: function (message) {
      const transferId = message.transferId;
      const outcome = message.ok === true ?
        { ok: true } :
        { ok: false, reason: message.reason };
      receipts[transferId] = outcome;
      const waiter = waiters[transferId];
      if (!waiter || waiter.settled) return false;
      waiter.phase = 'delivered';
      settle(waiter, outcome);
      return true;
    },

    // 显式失败（取消/发送异常）：解析并清理。
    fail: function (transferId, reason) {
      const waiter = waiters[transferId];
      if (waiter && !waiter.settled) {
        waiter.phase = 'failed';
        settle(waiter, { ok: false, reason: reason });
      }
    },

    // 终结：清理计时器与状态（成功后调用）。
    end: function (transferId) {
      const waiter = waiters[transferId];
      if (waiter) clearWaiter(waiter);
      delete waiters[transferId];
    },

    attempt: function (transferId) {
      const waiter = waiters[transferId];
      return waiter ? waiter.attempt : 0;
    },

    phase: function (transferId) {
      const waiter = waiters[transferId];
      return waiter ? waiter.phase : 'none';
    },

    receipt: function (transferId) {
      return receipts[transferId];
    }
  };
}
