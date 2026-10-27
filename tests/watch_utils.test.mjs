// SPDX-License-Identifier: GPL-3.0-only
// Run: node --experimental-default-type=module tests/watch_utils.test.mjs
// 手表端纯 JS 工具与 Node 互验：
//   - Utf8.decodeUtf8Bytes 与 TextDecoder 一致（含非法序列替换）
//   - Base64.decodeBase64 与 Buffer base64 一致（含非法字符/填充）
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'suyue-wu-'));
const load = (rel) => {
  const p = join(tmp, rel.replaceAll('/', '_') + '.mjs');
  writeFileSync(p, readFileSync(
    'watch/huawei/watch-lite/entry/src/main/js/MainAbility/' + rel, 'utf8'));
  return import(p);
};

const enc = new TextEncoder();
const { decodeUtf8Bytes } = await load('util/Utf8.js');
const { decodeBase64 } = await load('util/Base64.js');

// UTF-8 解码
const texts = [
  '',
  'abc',
  '你好，世界！',
  'emoji 😀 混排',
  'a\nb\tc',
  '《》“”‘’，。：；？！'
];
for (const t of texts) {
  const bytes = enc.encode(t);
  assert.equal(decodeUtf8Bytes(bytes), t,
    'utf8 decode must round-trip: ' + JSON.stringify(t));
}
// 非法序列：截断的 3 字节字符 → 替换符
assert.equal(decodeUtf8Bytes(new Uint8Array([0xe4, 0xbd])), '�');
// 非法首字节
assert.equal(decodeUtf8Bytes(new Uint8Array([0xff, 0xfe])), '��');
// 混合：有效 + 非法 + 有效
assert.equal(
  decodeUtf8Bytes(new Uint8Array([0xe4, 0xbd, 0xa0, 0xff, 0x41])),
  '你�A');

// Base64 解码
const b64cases = [
  '',
  'a',
  'ab',
  'abc',
  'abcd',
  'hello world 你好',
  '素阅 suyue 😀'
];
for (const t of b64cases) {
  const bytes = enc.encode(t);
  const b64 = Buffer.from(bytes).toString('base64');
  assert.deepEqual(Buffer.from(decodeBase64(b64)), Buffer.from(bytes),
    'base64 decode must match Buffer: ' + t);
}
// 带填充
assert.deepEqual(Buffer.from(decodeBase64('aGVsbG8=')),
  Buffer.from('hello'));
// 非法字符被忽略
assert.deepEqual(Buffer.from(decodeBase64('aGVs\nbG8=')),
  Buffer.from('hello'));
// 标准字符集完整性：'+/' 解码为 0xFB（尾部 4 位不足一字节，丢弃）。
assert.deepEqual(Buffer.from(decodeBase64('+/')),
  Buffer.from([0xfb]));

// ---- 格式校验（无正则实现）----
// Lite 的 JerryScript 没有 RegExp，手表端所有格式校验都走
// util/Validate.js 的字符比较。Node 有正则，正好在这里把
// 两者判定逐一对照，证明去掉正则没有放松校验。
const { isLowerHex, isSafeToken } = await load('util/Validate.js');

const hex16 = /^[0-9a-f]{16}$/;
for (const s of ['aaaa000000000001', 'AAAA000000000001', '', 'aaaa',
                 'g00000000000000', '0000000000000000', 'aaaa0000000000011']) {
  assert.equal(isLowerHex(s, 16), hex16.test(s),
    'isLowerHex(_,16) 必须与正则判定一致: ' + JSON.stringify(s));
}
const hex64 = /^[0-9a-f]{64}$/;
for (const s of ['a'.repeat(64), 'A'.repeat(64), 'a'.repeat(63),
                 'a'.repeat(65), '0'.repeat(64)]) {
  assert.equal(isLowerHex(s, 64), hex64.test(s),
    'isLowerHex(_,64) 必须与正则判定一致: ' + s.length + ' 位');
}
assert.equal(isLowerHex(null, 16), false, '非字符串必须拒绝');

const tokenRe = /^[0-9a-zA-Z\-_]{1,128}$/;
for (const s of ['abc-123_XYZ', '', 'a'.repeat(128), 'a'.repeat(129),
                 '../etc/passwd', 'a/b', '中文', 'a b']) {
  assert.equal(isSafeToken(s, 128), tokenRe.test(s),
    'isSafeToken 必须与正则判定一致: ' + JSON.stringify(s));
}

// ---- 表冠换算器：绝对档位 → 相对翻页 ----
const { createCrownTracker, CROWN_RANGE, crownStatus } =
  await load('reader/CrownInput.js');
assert.equal(crownStatus(), 'unverified',
  '真机验证前不得宣称表冠可用');

const tracker = createCrownTracker(null);
assert.equal(tracker.push(0), 0, '首个读数只作基准，不翻页');
assert.equal(tracker.push(1), 1, '正向 1 格翻 1 页');
assert.equal(tracker.push(0), -1, '反向 1 格回退 1 页');
assert.equal(tracker.eventCount(), 3);
tracker.reset();
assert.equal(tracker.push(3), 0, 'reset 后重新取基准');
assert.equal(tracker.push(3 + CROWN_RANGE + 1), 0,
  '超过整个行程的单次跳变必须丢弃，不能一次翻掉几十页');
assert.equal(tracker.push(3 + CROWN_RANGE + 1), 0,
  '同一档位重复上报不翻页');
assert.equal(tracker.push('x'), 0, '非数字读数丢弃');

// 未满一页的余量必须保留：stepsPerPage=2 时第一格攒着、第二格才翻。
const slow = createCrownTracker({ stepsPerPage: 2 });
slow.push(0);
assert.equal(slow.push(1), 0, '不足一格不翻页');
assert.equal(slow.pending(), 1, '余量保留');
assert.equal(slow.push(2), 1, '累计满一格翻一页');
assert.equal(slow.pending(), 0, '翻页后余量清零');

console.info('PASS: watch Utf8/Base64 utils match Node references');
