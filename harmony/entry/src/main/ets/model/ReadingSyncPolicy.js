// SPDX-License-Identifier: GPL-3.0-only
// 阅读进度同步的纯逻辑：摘要校验、分批、冲突判定。
// 不依赖 SDK、文件或 UI，Node 可直接测试。
// 协议约束：每条消息 UTF-8 < 4096 字节；不携带正文/目录/书架。

export var MAX_SYNC_MESSAGE_BYTES = 4096;

export function utf8ByteLength(text) {
  var total = 0;
  for (var i = 0; i < text.length; i++) {
    var n = text.charCodeAt(i);
    if (n < 0x80) {
      total += 1;
    } else if (n < 0x800) {
      total += 2;
    } else if (n >= 0xd800 && n <= 0xdbff &&
      i + 1 < text.length) {
      var low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        total += 4;
        i++;
      } else {
        total += 3;
      }
    } else {
      total += 3;
    }
  }
  return total;
}

export function isLowerHex(text, length) {
  if (typeof text !== 'string' || text.length !== length) {
    return false;
  }
  for (var i = 0; i < text.length; i++) {
    var c = text.charAt(i);
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
      return false;
    }
  }
  return true;
}

export function isValidSummary(value) {
  if (!value || typeof value !== 'object') return false;
  if (!isLowerHex(value.bookId, 16)) return false;
  if (!isLowerHex(value.sha256, 64)) return false;
  if (typeof value.offset !== 'number' || !isFinite(value.offset) ||
      Math.floor(value.offset) !== value.offset || value.offset < 0) {
    return false;
  }
  if (value.updatedAt !== undefined &&
      (typeof value.updatedAt !== 'number' || !isFinite(value.updatedAt))) {
    return false;
  }
  return true;
}

// 本地/远端/上次同步基线（-1 表示未知）。
// 返回 none | apply_remote | apply_local | conflict。
// 关键：绝不按“谁的 offset 更大”覆盖；回到上一章也是合法进度。
export function decideSyncAction(local, remote, baseline) {
  if (!remote) return 'none';
  if (!local || local.empty) return 'apply_remote';
  if (local.offset === remote.offset) return 'none';
  var base = typeof baseline === 'number' ? baseline : -1;
  if (base >= 0 && local.offset === base) return 'apply_remote';
  if (base >= 0 && remote.offset === base) return 'apply_local';
  return 'conflict';
}

// 已发出 APPLY、但尚未确认对端持久化时的判定。
// pendingOffset 只表示“手机想同步的新位置”，不是已同步基线。
// confirmed: 对端已经等于本地新位置，可以推进基线；
// resend: 对端仍在旧基线，重发 APPLY；
// conflict: 对端有第三个位置，交给用户选择。
export function decidePendingAction(localOffset, syncedOffset,
  pendingOffset, remoteOffset) {
  if (typeof pendingOffset !== 'number' || !isFinite(pendingOffset) ||
      pendingOffset < 0) {
    return 'not_pending';
  }
  if (remoteOffset === localOffset) return 'confirmed';
  if (typeof syncedOffset === 'number' && syncedOffset >= 0 &&
      remoteOffset === syncedOffset) {
    return 'resend';
  }
  return 'conflict';
}

// 把摘要装进 <= maxBytes 的 STATE 分片。base 是除 books 外的公共字段。
// 返回 [{ payload, batch, batches }]；单条摘要本身放不下时返回空数组。
export function buildSummaryBatches(summaries, base, maxBytes) {
  var limit = typeof maxBytes === 'number' && maxBytes > 0 ?
    maxBytes : MAX_SYNC_MESSAGE_BYTES;
  var clean = [];
  for (var i = 0; i < summaries.length; i++) {
    if (isValidSummary(summaries[i])) clean.push(summaries[i]);
  }
  var groups = [];
  var current = [];
  for (var j = 0; j < clean.length; j++) {
    var probe = current.concat([clean[j]]);
    var payload = Object.assign({}, base, {
      books: probe, batch: 9999, batches: 9999
    });
    if (utf8ByteLength(JSON.stringify(payload)) < limit) {
      current = probe;
      continue;
    }
    if (current.length === 0) {
      return [];
    }
    groups.push(current);
    current = [clean[j]];
    var single = Object.assign({}, base, {
      books: current, batch: 9999, batches: 9999
    });
    if (utf8ByteLength(JSON.stringify(single)) >= limit) {
      return [];
    }
  }
  if (current.length > 0) groups.push(current);
  var out = [];
  for (var k = 0; k < groups.length; k++) {
    out.push({
      payload: Object.assign({}, base, {
        books: groups[k],
        batch: k,
        batches: groups.length
      }),
      batch: k,
      batches: groups.length
    });
  }
  return out;
}

// 合并同一 requestId 的分片；重复分片幂等，乱序到达也能拼齐。
export function mergeStateBatches(existing, message) {
  var state = existing || { books: [], lastBookId: '', lastUpdatedAt: 0 };
  if (Array.isArray(message.books)) {
    for (var i = 0; i < message.books.length; i++) {
      if (isValidSummary(message.books[i])) {
        state.books.push(message.books[i]);
      }
    }
  }
  if (typeof message.lastBookId === 'string' &&
      isLowerHex(message.lastBookId, 16)) {
    state.lastBookId = message.lastBookId;
    state.lastUpdatedAt = typeof message.lastUpdatedAt === 'number' ?
      message.lastUpdatedAt : 0;
  }
  var seen = {};
  var unique = [];
  for (var j = 0; j < state.books.length; j++) {
    var key = state.books[j].bookId + ':' + state.books[j].sha256;
    if (seen[key]) continue;
    seen[key] = true;
    unique.push(state.books[j]);
  }
  state.books = unique;
  return state;
}
