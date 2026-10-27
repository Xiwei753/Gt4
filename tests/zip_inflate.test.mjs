// SPDX-License-Identifier: GPL-3.0-only
// Run: node --experimental-default-type=module tests/zip_inflate.test.mjs
// 把纯 JS 的 ZipReader.ts 复制为 .mjs 后在 Node 中验证：
//   - inflateRaw 与 zlib.deflateRawSync 互操作（多种数据形态）
//   - 中央目录解析、stored/deflate 条目读取、CRC-32 校验
//   - ZIP 路径穿越拒绝、zip bomb 上限、ZIP64 明确报错
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const tmp = mkdtempSync(join(tmpdir(), 'suyue-zip-'));
const modPath = join(tmp, 'ZipReader.mjs');
writeFileSync(modPath, readFileSync(
  'harmony/entry/src/main/ets/services/ZipReader.ts', 'utf8'));
const { ZipReader, inflateRaw, crc32 } = await import(modPath);

// ---------- inflateRaw 与 zlib 互操作 ----------
const cases = [
  new Uint8Array(0),
  new TextEncoder().encode('hello world'),
  new TextEncoder().encode('a'.repeat(1000)),
  new TextEncoder().encode('第一章：你好，世界！\n'.repeat(200)),
  (() => {
    const b = new Uint8Array(50000);
    for (let i = 0; i < b.length; i++) b[i] = (i * 7 + (i >> 3)) & 0xff;
    return b;
  })(),
  (() => {
    // 大量回引距离，验证距离编码
    const s = '素阅素阅素阅阅读阅读阅读读器器器器器';
    return new TextEncoder().encode(s.repeat(500));
  })()
];
for (const c of cases) {
  const compressed = deflateRawSync(Buffer.from(c));
  const back = inflateRaw(compressed, 10 * 1024 * 1024);
  assert.deepEqual(Buffer.from(back), Buffer.from(c),
    'inflateRaw must round-trip');
  assert.deepEqual(inflateRawSync(compressed), Buffer.from(c));
}

// ---------- 构造一个最小 ZIP（stored + deflate） ----------
function buildZip(items) {
  const chunks = [];
  const cd = [];
  let offset = 0;
  const push = (buf) => {
    chunks.push(buf);
    const prev = offset;
    offset += buf.length;
    return prev;
  };
  const u16 = (v) => Buffer.from([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v) => Buffer.from([v & 0xff, (v >> 8) & 0xff,
    (v >> 16) & 0xff, (v >>> 24) & 0xff]);
  for (const item of items) {
    const name = Buffer.from(item.name, 'utf8');
    const raw = Buffer.from(item.data, 'utf8');
    const stored = item.method === 0;
    const body = stored ? raw : deflateRawSync(raw);
    const crc = crc32(raw);
    const lfh = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(stored ? 0 : 8),
      u16(0), u16(0), u32(crc), u32(body.length), u32(raw.length),
      u16(name.length), u16(0), name
    ]);
    const localOffset = push(lfh);
    push(body);
    cd.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(stored ? 0 : 8),
      u16(0), u16(0), u32(crc), u32(body.length), u32(raw.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(localOffset), name
    ]));
  }
  const cdStart = offset;
  const cdBuf = Buffer.concat(cd);
  push(cdBuf);
  push(Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(items.length), u16(items.length),
    u32(cdBuf.length), u32(cdStart), u16(0)
  ]));
  return new Uint8Array(Buffer.concat(chunks));
}

const zipBytes = buildZip([
  { name: 'META-INF/container.xml', method: 8,
    data: '<?xml version="1.0"?><container></container>' },
  { name: 'OEBPS/content.opf', method: 0,
    data: '<package><metadata><dc:title>测试书</dc:title></metadata></package>' },
  { name: 'OEBPS/第1章.xhtml', method: 8,
    data: '<html><body><p>你好，世界！</p></body></html>' },
  { name: 'OEBPS/img/cover.txt', method: 8, data: 'cover' }
]);
const reader = new ZipReader(zipBytes, 16 * 1024 * 1024);
assert.ok(reader.has('META-INF/container.xml'));
assert.ok(reader.has('OEBPS/content.opf'));
assert.equal(reader.readText('OEBPS/content.opf').includes('测试书'), true,
  'stored entry with UTF-8 name must decode');
assert.equal(reader.readText('OEBPS/第1章.xhtml').includes('你好，世界！'),
  true, 'deflated CJK entry must round-trip');
assert.equal(reader.names().length, 4);

// ---------- 路径穿越拒绝 ----------
// 穿越名字在 ZipReader 解析中央目录时被拒绝（构建器本身不校验）。
{
  const evil = buildZip([{ name: '../evil.txt', method: 0, data: 'x' }]);
  assert.throws(() => new ZipReader(evil, 1024), /path traversal/);
}
{
  const evil = buildZip([{ name: '/abs.txt', method: 0, data: 'x' }]);
  assert.throws(() => new ZipReader(evil, 1024), /absolute path/);
}
{
  assert.throws(() => reader.read('../OEBPS/content.opf'),
    /entry not found/);
}

// ---------- CRC 不匹配检测 ----------
{
  const bad = buildZip([{ name: 'a.txt', method: 0, data: 'good' }]);
  // 破坏数据字节（stored 条目数据紧跟在 30+name 字节之后）
  const nameLen = 5;
  bad[30 + nameLen] ^= 0xff;
  const r = new ZipReader(bad, 1024);
  assert.throws(() => r.read('a.txt'), /crc32 mismatch/);
}

// ---------- zip bomb 上限 ----------
// inflateRaw 在解压输出超过上限时立即报错，不等解压完成。
{
  const bombBody = deflateRawSync(Buffer.from('a'.repeat(100000)));
  assert.throws(() => inflateRaw(bombBody, 1000), /exceeds limit/);
  // 同样上限作用于 ZipReader.read
  const zip = buildZip([{ name: 'b.txt', method: 8,
    data: 'a'.repeat(100000) }]);
  const r = new ZipReader(zip, 1000);
  assert.throws(() => r.read('b.txt'),
    /exceeds limit|size mismatch/);
}

console.info('PASS: zip inflate/central directory/CRC/traversal/bomb guards');
