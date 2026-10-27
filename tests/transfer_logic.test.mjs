// SPDX-License-Identifier: GPL-3.0-only
// Run: node --experimental-default-type=module tests/transfer_logic.test.mjs
// 手表接收纯逻辑与协议测试互验：
//   - BOOK_META 字段校验（缺字段/错误编码/错误摘要格式）
//   - 块按序、幂等、offset 连续性
//   - 缺块 E_MISSING_CHUNKS、摘要异常 E_DIGEST_MISMATCH
//   - 跨多字节 UTF-8 边界的字节级拼接
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'suyue-tl-'));
// 递归加载手表 JS 模块：把相对 import 改写为绝对
// file:// 路径，使 @system.* 之外的纯逻辑模块可在
// Node 中直接运行。
const loaded = new Map();
const load = async (rel) => {
  if (loaded.has(rel)) return loaded.get(rel);
  const srcPath = join('watch/huawei/watch-lite/entry/src/main/js/MainAbility',
    rel);
  let src = readFileSync(srcPath, 'utf8');
  const importRe = /from\s+'([^']+)'/g;
  let m;
  const deps = [];
  while ((m = importRe.exec(src)) !== null) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    // 依赖路径保持相对 MainAbility，与 load() 的
    // 内部拼接一致。
    const depPath = join(rel, '..', spec);
    const depModule = await load(depPath);
    const depTmp = join(tmp,
      depPath.replaceAll('/', '_') + '.mjs');
    deps.push({ spec, depTmp, depModule });
  }
  const modPath = join(tmp, rel.replaceAll('/', '_') + '.mjs');
  for (const dep of deps) {
    src = src.replace("from '" + dep.spec + "'",
      "from '" + dep.depTmp + "'");
  }
  writeFileSync(modPath, src);
  const mod = await import(modPath);
  loaded.set(rel, mod);
  return mod;
};

const { validateBookMeta, beginTransfer, applyChunk,
  missingIndices, assembleBytes, verifyDigest } =
  await load('wear/TransferLogic.js');

const enc = new TextEncoder();
const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');

const bookText = '第一章：你好，世界！\r\n第二章：emoji 😀 混排。'
  .repeat(30);
const bookBytes = enc.encode(bookText);
const chunkSize = 97;

function makeMeta() {
  return {
    v: 0,
    transferId: 'tl-transfer-001',
    bookId: sha256(bookBytes).substring(0, 16),
    title: '《测试》书名\n带换行',
    encoding: 'utf-8',
    bytes: bookBytes.length,
    sha256: sha256(bookBytes),
    chunks: Math.ceil(bookBytes.length / chunkSize),
    chunkBytes: chunkSize,
    chapters: [{ title: '正文', offset: 0, length: bookBytes.length }]
  };
}

// ---------- BOOK_META 校验 ----------
const meta = makeMeta();
assert.equal(validateBookMeta(meta).ok, true);
for (const broken of [
  { ...meta, v: 1 },
  { ...meta, bookId: 'XYZ' },
  { ...meta, encoding: 'gbk' },
  { ...meta, sha256: 'too-short' },
  { ...meta, chunks: 0 },
  { ...meta, bytes: -1 },
  { ...meta, title: 123 },
  { ...meta, chapters: null },
  { ...meta, transferId: '' }
]) {
  assert.equal(validateBookMeta(broken).ok, false,
    'must reject broken meta: ' + JSON.stringify(broken).substring(0, 60));
}

// ---------- 正常按序接收 ----------
{
  const started = beginTransfer(meta);
  assert.equal(started.ok, true);
  const state = started.state;
  let offset = 0;
  let index = 0;
  while (offset < bookBytes.length) {
    const end = Math.min(offset + chunkSize, bookBytes.length);
    const payload = bookBytes.subarray(offset, end);
    const applied = applyChunk(state, {
      transferId: meta.transferId,
      bookId: meta.bookId,
      index: index,
      total: meta.chunks,
      offset: offset,
      length: payload.length
    }, payload);
    assert.equal(applied.ok, true);
    // 重复块：幂等
    const again = applyChunk(state, {
      transferId: meta.transferId,
      bookId: meta.bookId,
      index: index,
      total: meta.chunks,
      offset: offset,
      length: payload.length
    }, payload);
    assert.equal(again.ok, true);
    assert.equal(again.duplicate, true);
    offset = end;
    index += 1;
  }
  assert.deepEqual(missingIndices(state), []);
  const assembled = assembleBytes(state);
  assert.equal(assembled.ok, true);
  assert.deepEqual(Buffer.from(assembled.bytes),
    Buffer.from(bookBytes));
  assert.equal(new TextDecoder().decode(assembled.bytes), bookText);
  assert.equal(verifyDigest(assembled.bytes, meta.sha256), true);
}

// ---------- 缺块 ----------
{
  const state = beginTransfer(meta).state;
  let offset = 0;
  let index = 0;
  while (offset < bookBytes.length) {
    const end = Math.min(offset + chunkSize, bookBytes.length);
    if (index !== Math.floor(meta.chunks / 2)) {
      const payload = bookBytes.subarray(offset, end);
      applyChunk(state, {
        transferId: meta.transferId,
        bookId: meta.bookId,
        index: index,
        total: meta.chunks,
        offset: offset,
        length: payload.length
      }, payload);
    }
    offset = end;
    index += 1;
  }
  assert.ok(missingIndices(state).length > 0);
  assert.equal(assembleBytes(state).reason, 'E_MISSING_CHUNKS');
}

// ---------- offset 不连续 → E_PROTOCOL ----------
{
  const state = beginTransfer(meta).state;
  const payload = bookBytes.subarray(0, chunkSize);
  // 第二块直接跳到 offset = chunkSize*3（跳过中间）
  const bad = applyChunk(state, {
    transferId: meta.transferId,
    bookId: meta.bookId,
    index: 1,
    total: meta.chunks,
    offset: chunkSize * 3,
    length: chunkSize
  }, payload);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'E_PROTOCOL');
}

// ---------- 摘要异常 ----------
{
  const state = beginTransfer(meta).state;
  let offset = 0;
  let index = 0;
  while (offset < bookBytes.length) {
    const end = Math.min(offset + chunkSize, bookBytes.length);
    let payload = bookBytes.subarray(offset, end);
    if (index === 0) {
      const flipped = new Uint8Array(payload);
      flipped[0] ^= 0xff;
      payload = flipped;
    }
    applyChunk(state, {
      transferId: meta.transferId,
      bookId: meta.bookId,
      index: index,
      total: meta.chunks,
      offset: offset,
      length: payload.length
    }, payload);
    offset = end;
    index += 1;
  }
  const assembled = assembleBytes(state);
  assert.equal(assembled.ok, true);
  assert.equal(verifyDigest(assembled.bytes, meta.sha256), false,
    'flipped byte must fail digest');
}

console.info('PASS: watch transfer logic (meta validation, ' +
  'ordering, idempotency, missing/digest failures)');
