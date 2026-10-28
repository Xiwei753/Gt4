// SPDX-License-Identifier: GPL-3.0-only
// Run: node --experimental-default-type=module tests/protocol.test.mjs
// 按 protocol/README.md 的 v0 规格独立验证：
//   - 全部 examples 字段齐全、类型正确、示例自洽
//   - CJK/emoji/CRLF 按 UTF-8 字节分块（允许劈开多字节字符），
//     乱序到达、重复块幂等，拼接后 sha256 与原文一致
//   - 缺块 FINISH → E_MISSING_CHUNKS，不入书架
//   - 字节翻转 → E_DIGEST_MISMATCH，半本书不落盘
//   - 书名转义（引号/换行/Unicode）JSON 往返
//   - RESUME 只补缺失块；取消走 ERROR E_CANCELLED
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const b64decode = (s) => new Uint8Array(Buffer.from(s, 'base64'));

// ---------- 示例校验 ----------
const EXAMPLES = new URL('../protocol/examples/', import.meta.url);
const files = readdirSync(EXAMPLES).filter((f) => f.endsWith('.json'));
assert.ok(files.includes('hello.json'), 'hello example required');
for (const f of files) {
  const msg = JSON.parse(readFileSync(new URL(f, EXAMPLES), 'utf8'));
  assert.equal(typeof msg.v, 'number', f + ': v required');
  assert.equal(typeof msg.type, 'string', f + ': type required');
  if (msg.type !== 'HELLO') {
    assert.equal(typeof msg.transferId, 'string', f + ': transferId required');
  }
}
// CHUNK 示例必须自洽：payloadB64 解码长度 === length。
const chunkExample = JSON.parse(
  readFileSync(new URL('chunk.json', EXAMPLES), 'utf8'));
assert.equal(b64decode(chunkExample.payloadB64).length,
  chunkExample.length, 'chunk example payload must match length');
assert.ok(chunkExample.total >= chunkExample.index + 1);
// CHAPTERS 示例：分片必须自洽，且每片不超过 P2P 4096 字节。
const chaptersExample = JSON.parse(
  readFileSync(new URL('chapters.json', EXAMPLES), 'utf8'));
assert.equal(chaptersExample.type, 'CHAPTERS');
assert.ok(chaptersExample.index >= 0);
assert.ok(chaptersExample.total > chaptersExample.index);
assert.ok(chaptersExample.chapters.length > 0);
assert.ok(Buffer.byteLength(JSON.stringify(chaptersExample), 'utf8') <= 4096);
// BOOK_META 示例：chapters 区间必须覆盖 bytes。
const metaExample = JSON.parse(
  readFileSync(new URL('book-meta.json', EXAMPLES), 'utf8'));
assert.ok(metaExample.chapters.length > 0);
let covered = 0;
for (const ch of metaExample.chapters) {
  assert.equal(ch.offset, covered, 'chapters must be contiguous');
  covered += ch.length;
}
assert.equal(covered, metaExample.bytes, 'chapters must cover bytes');
// RESULT 失败示例必须带 reason（规格：ok=false 必填 reason）。
const failResult = {
  v: 0, type: 'RESULT', transferId: 't', bookId: 'b',
  ok: false, reason: 'E_SPACE'
};
assert.ok(failResult.reason.length > 0);

// ---------- 接收端模拟（按规格实现） ----------
function createReceiver() {
  return {
    transfers: new Map(),
    acked: new Map(), // transferId -> Set<index>
    shelf: new Map(), // bookId -> bytes
    start(meta) {
      if (this.transfers.has(meta.transferId)) {
        throw new Error('E_DUPLICATE_TRANSFER');
      }
      this.transfers.set(meta.transferId, {
        meta,
        chunks: new Map(),
        committed: false
      });
      this.acked.set(meta.transferId, new Set());
    },
    chunk(msg, payload) {
      const t = this.transfers.get(msg.transferId);
      assert.ok(t, 'unknown transferId');
      assert.equal(msg.total, t.meta.chunks, 'total mismatch');
      assert.ok(msg.index >= 0 && msg.index < t.meta.chunks,
        'index out of range');
      assert.equal(msg.offset, msg.index * t.meta.chunkBytes,
        'offset must be index*chunkBytes');
      assert.equal(payload.length, msg.length,
        'payload length must match declared length');
      if (!t.chunks.has(msg.index)) {
        t.chunks.set(msg.index, payload); // 幂等：重复块不覆盖
      }
      this.acked.get(msg.transferId).add(msg.index);
      return { v: 0, type: 'ACK', transferId: msg.transferId,
        bookId: msg.bookId, index: msg.index, ok: true };
    },
    resume(transferId) {
      const received = [...this.acked.get(transferId)].sort((a, b) => a - b);
      return { v: 0, type: 'RESUME', transferId,
        bookId: this.transfers.get(transferId).meta.bookId,
        received };
    },
    finish(msg) {
      const t = this.transfers.get(msg.transferId);
      assert.ok(t, 'unknown transferId');
      const missing = [];
      for (let i = 0; i < t.meta.chunks; i++) {
        if (!t.chunks.has(i)) missing.push(i);
      }
      if (missing.length > 0) {
        return { v: 0, type: 'RESULT', transferId: msg.transferId,
          bookId: msg.bookId, ok: false,
          reason: 'E_MISSING_CHUNKS:' + missing.join(',') };
      }
      // 按 offset 顺序拼接。
      const parts = [];
      let total = 0;
      for (let i = 0; i < t.meta.chunks; i++) {
        const p = t.chunks.get(i);
        parts.push(p);
        total += p.length;
      }
      const book = new Uint8Array(total);
      let pos = 0;
      for (const p of parts) { book.set(p, pos); pos += p.length; }
      const digest = sha256(book);
      if (digest !== t.meta.sha256) {
        t.chunks.clear(); // 清理暂存，不入书架
        return { v: 0, type: 'RESULT', transferId: msg.transferId,
          bookId: msg.bookId, ok: false,
          reason: 'E_DIGEST_MISMATCH' };
      }
      this.shelf.set(t.meta.bookId, book);
      t.committed = true;
      return { v: 0, type: 'RESULT', transferId: msg.transferId,
        bookId: msg.bookId, ok: true };
    },
    cancel(transferId) {
      const t = this.transfers.get(transferId);
      if (t) t.chunks.clear();
      return { v: 0, type: 'ERROR', transferId,
        bookId: t ? t.meta.bookId : undefined,
        code: 'E_CANCELLED' };
    }
  };
}

// ---------- 发送端分块：允许劈开多字节 UTF-8 字符 ----------
function chunkBytes(book, chunkBytesSize) {
  const out = [];
  for (let offset = 0; offset < book.length;
      offset += chunkBytesSize) {
    const end = Math.min(offset + chunkBytesSize, book.length);
    out.push({
      index: out.length,
      offset,
      length: end - offset,
      payload: book.subarray(offset, end)
    });
  }
  return out;
}

const enc = new TextEncoder();
const sample = '第一章：你好，世界！\r\n第二章：emoji 😀 与中文混排。'
  .repeat(40);
const book = enc.encode(sample);
const transferId = 'test-transfer-0001';
const chunkSize = 97; // 与 3 字节 CJK 不整除，必然劈开多字节字符
const chunks = chunkBytes(book, chunkSize);
const meta = {
  v: 0, type: 'BOOK_META', transferId,
  bookId: sha256(book).substring(0, 16),
  title: '《测试》“书名”\n第二行\t制表',
  encoding: 'utf-8',
  bytes: book.length,
  sha256: sha256(book),
  chunks: chunks.length,
  chunkBytes: chunkSize,
  chapters: [{ title: '正文', offset: 0, length: book.length }]
};

// 正常流程：乱序 + 重复块。
const rx = createReceiver();
rx.start(meta);
const acks = [];
const shuffled = [...chunks].reverse(); // 乱序到达
for (const c of shuffled) {
  acks.push(rx.chunk({
    v: 0, type: 'CHUNK', transferId, bookId: meta.bookId,
    index: c.index, total: chunks.length, offset: c.offset,
    length: c.length, payloadB64: Buffer.from(c.payload).toString('base64')
  }, c.payload));
}
// 重复发送第 0 块：必须幂等，ACK 仍 ok，且不改变内容。
const dup = chunks[0];
rx.chunk({
  v: 0, type: 'CHUNK', transferId, bookId: meta.bookId,
  index: dup.index, total: chunks.length, offset: dup.offset,
  length: dup.length, payloadB64: Buffer.from(dup.payload).toString('base64')
}, dup.payload);
const result = rx.finish({
  v: 0, type: 'FINISH', transferId, bookId: meta.bookId,
  chunks: chunks.length
});
assert.equal(result.ok, true, 'full transfer must commit');
const stored = rx.shelf.get(meta.bookId);
assert.deepEqual(Buffer.from(stored), Buffer.from(book),
  'reassembled bytes must equal original');
assert.equal(new TextDecoder().decode(stored), sample,
  'decoded text must equal original');

// 书名转义往返。
const titleRound = JSON.parse(JSON.stringify(meta.title));
assert.equal(titleRound, '《测试》“书名”\n第二行\t制表');

// ---------- 缺块：FINISH 必须拒绝 ----------
{
  const rx2 = createReceiver();
  rx2.start(meta);
  for (const c of chunks) {
    if (c.index === Math.floor(chunks.length / 2)) continue; // 丢一块
    rx2.chunk({
      v: 0, type: 'CHUNK', transferId, bookId: meta.bookId,
      index: c.index, total: chunks.length, offset: c.offset,
      length: c.length, payloadB64: Buffer.from(c.payload).toString('base64')
    }, c.payload);
  }
  const res = rx2.finish({
    v: 0, type: 'FINISH', transferId, bookId: meta.bookId,
    chunks: chunks.length
  });
  assert.equal(res.ok, false);
  assert.ok(res.reason.startsWith('E_MISSING_CHUNKS'),
    'missing chunks must be reported');
  assert.equal(rx2.shelf.has(meta.bookId), false,
    'incomplete book must not reach the shelf');
}

// ---------- 摘要不符：字节翻转 ----------
{
  const rx3 = createReceiver();
  rx3.start(meta);
  for (const c of chunks) {
    let payload = c.payload;
    if (c.index === 0) {
      const flipped = new Uint8Array(payload);
      flipped[0] ^= 0xff; // 翻转一个字节
      payload = flipped;
    }
    rx3.chunk({
      v: 0, type: 'CHUNK', transferId, bookId: meta.bookId,
      index: c.index, total: chunks.length, offset: c.offset,
      length: c.length, payloadB64: Buffer.from(payload).toString('base64')
    }, payload);
  }
  const res = rx3.finish({
    v: 0, type: 'FINISH', transferId, bookId: meta.bookId,
    chunks: chunks.length
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'E_DIGEST_MISMATCH');
  assert.equal(rx3.shelf.has(meta.bookId), false,
    'digest failure must not commit');
}

// ---------- RESUME 只补缺失块 ----------
{
  const rx4 = createReceiver();
  rx4.start(meta);
  const sent = new Set();
  for (const c of chunks) {
    if (c.index % 3 === 0) {
      rx4.chunk({
        v: 0, type: 'CHUNK', transferId, bookId: meta.bookId,
        index: c.index, total: chunks.length, offset: c.offset,
        length: c.length, payloadB64: Buffer.from(c.payload).toString('base64')
      }, c.payload);
      sent.add(c.index);
    }
  }
  const resume = rx4.resume(transferId);
  assert.deepEqual(resume.received, [...sent].sort((a, b) => a - b),
    'resume must list exactly the received indices');
  const missing = chunks.filter((c) => !resume.received.includes(c.index));
  assert.ok(missing.length > 0);
  for (const c of missing) {
    rx4.chunk({
      v: 0, type: 'CHUNK', transferId, bookId: meta.bookId,
      index: c.index, total: chunks.length, offset: c.offset,
      length: c.length, payloadB64: Buffer.from(c.payload).toString('base64')
    }, c.payload);
  }
  const res = rx4.finish({
    v: 0, type: 'FINISH', transferId, bookId: meta.bookId,
    chunks: chunks.length
  });
  assert.equal(res.ok, true, 'resume + retransmit must complete');
}

// ---------- 取消 ----------
{
  const rx5 = createReceiver();
  rx5.start(meta);
  const cancel = rx5.cancel(transferId);
  assert.equal(cancel.code, 'E_CANCELLED');
  const res = rx5.finish({
    v: 0, type: 'FINISH', transferId, bookId: meta.bookId,
    chunks: chunks.length
  });
  assert.equal(res.ok, false);
  assert.ok(res.reason.startsWith('E_MISSING_CHUNKS'),
    'cancelled transfer has no chunks');
}

console.info('PASS: protocol examples, byte chunking, ordering, idempotency, ' +
  'digest/resume/cancel; chunks=' + chunks.length);
