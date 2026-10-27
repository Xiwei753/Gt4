// SPDX-License-Identifier: GPL-3.0-only
// 传输协议纯逻辑（无 HarmonyOS 依赖，Node 可测）：
// BOOK_META 校验、块接收（幂等、按序）、拼接、摘要核验。
import { sha256Bytes, createSha256 } from '../util/Sha256.js';
import { isLowerHex } from '../util/Validate.js';

export function validateBookMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    return { ok: false, reason: 'E_PROTOCOL' };
  }
  if (meta.v !== 0) return { ok: false, reason: 'E_PROTOCOL' };
  if (typeof meta.transferId !== 'string' ||
      meta.transferId.length === 0) {
    return { ok: false, reason: 'E_PROTOCOL' };
  }
  if (typeof meta.bookId !== 'string' ||
      !isLowerHex(meta.bookId, 16)) {
    return { ok: false, reason: 'E_PROTOCOL' };
  }
  if (typeof meta.title !== 'string') {
    return { ok: false, reason: 'E_PROTOCOL' };
  }
  if (meta.encoding !== 'utf-8') {
    return { ok: false, reason: 'E_UNSUPPORTED_FORMAT' };
  }
  if (typeof meta.bytes !== 'number' || meta.bytes <= 0) {
    return { ok: false, reason: 'E_PROTOCOL' };
  }
  if (typeof meta.sha256 !== 'string' ||
      !isLowerHex(meta.sha256, 64)) {
    return { ok: false, reason: 'E_PROTOCOL' };
  }
  if (typeof meta.chunks !== 'number' || meta.chunks < 1) {
    return { ok: false, reason: 'E_PROTOCOL' };
  }
  if (typeof meta.chunkBytes !== 'number' ||
      meta.chunkBytes < 1) {
    return { ok: false, reason: 'E_PROTOCOL' };
  }
  if (!Array.isArray(meta.chapters)) {
    return { ok: false, reason: 'E_PROTOCOL' };
  }
  return { ok: true };
}

// 单本在途约束（第二轮 P0-2）：同一时刻只允许
// 一个 transferId 处于接收中；第二个不同 id 的
// BOOK_META 一律 E_BUSY。相同 id 视为重启（幂等
// 重发 META），由调用方替换状态。
export function beginTransfer(meta, activeTransferId) {
  const valid = validateBookMeta(meta);
  if (!valid.ok) return { ok: false, reason: valid.reason };
  if (activeTransferId &&
      activeTransferId !== meta.transferId) {
    return { ok: false, reason: 'E_BUSY' };
  }
  return {
    ok: true,
    state: {
      meta: meta,
      chunks: {},        // index → Uint8Array
      receivedCount: 0,
      totalBytes: 0
    }
  };
}

// 幂等：重复 index 不覆盖、不重复计数。
// 按序约束：offset 必须等于已收字节数（消息通道按序到达；
// 文件通道不经此函数）。
export function applyChunk(state, chunk, payloadBytes) {
  if (chunk.transferId !== state.meta.transferId) {
    return { ok: false, reason: 'E_PROTOCOL' };
  }
  if (chunk.bookId !== state.meta.bookId) {
    return { ok: false, reason: 'E_PROTOCOL' };
  }
  if (chunk.total !== state.meta.chunks) {
    return { ok: false, reason: 'E_PROTOCOL' };
  }
  if (chunk.index < 0 || chunk.index >= state.meta.chunks) {
    return { ok: false, reason: 'E_PROTOCOL' };
  }
  // 幂等优先：重复 index 直接确认，不再校验 offset
  // 连续性（重复块的 offset 必然小于已收字节数）。
  if (state.chunks[chunk.index]) {
    return { ok: true, duplicate: true };
  }
  if (chunk.offset !== state.totalBytes) {
    return { ok: false, reason: 'E_PROTOCOL' };
  }
  if (chunk.length !== payloadBytes.length) {
    return { ok: false, reason: 'E_PROTOCOL' };
  }
  state.chunks[chunk.index] = payloadBytes;
  state.receivedCount += 1;
  state.totalBytes += payloadBytes.length;
  return { ok: true };
}

export function missingIndices(state) {
  const missing = [];
  for (var i = 0; i < state.meta.chunks; i++) {
    if (!state.chunks[i]) missing.push(i);
  }
  return missing;
}

export function assembleBytes(state) {
  const missing = missingIndices(state);
  if (missing.length > 0) {
    return { ok: false, reason: 'E_MISSING_CHUNKS' };
  }
  if (state.totalBytes !== state.meta.bytes) {
    return { ok: false, reason: 'E_PROTOCOL' };
  }
  const out = new Uint8Array(state.totalBytes);
  var pos = 0;
  for (var i = 0; i < state.meta.chunks; i++) {
    const part = state.chunks[i];
    out.set(part, pos);
    pos += part.length;
  }
  return { ok: true, bytes: out };
}

export function verifyDigest(bytes, expectedSha256) {
  return sha256Bytes(bytes) === expectedSha256;
}

// 文件通道流式校验：按窗口喂入，峰值内存
// 只有一个窗口（施工单 P1-11）。
export function createDigestVerifier(expectedSha256) {
  var hasher = createSha256();
  var total = 0;
  return {
    update: function (bytes) {
      hasher.update(bytes);
      total += bytes.length;
    },
    finish: function (expectedBytes) {
      if (typeof expectedBytes === 'number' &&
          total !== expectedBytes) {
        return { ok: false, reason: 'E_SIZE_MISMATCH' };
      }
      return hasher.digest() === expectedSha256
        ? { ok: true }
        : { ok: false, reason: 'E_DIGEST_MISMATCH' };
    },
    received: function () {
      return total;
    }
  };
}
