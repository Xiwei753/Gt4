// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/watch_book_modules.test.mjs
// issue #10：构建期把私人 TXT 生成 JS 数据模块的回归。
//
// 覆盖：
//   · 生成 BookCatalog（仅元数据）/ BookText_<id> / BookRegistry /
//     books_report.json；
//   · 还原：把生成的块 base64 重新拼回原始规范化 UTF-8 字节，
//     sha256 与报告一致（含跨块的多字节中文边界）；
//   · 目录只含元数据，绝不含正文大块；
//   · 内存实测（子进程 node --expose-gc）：静态 import 会保留模块源，
//     但 getChunk 只 materialize 单块——把真实数字打印出来作为证据。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const script = join(repo, 'tools', 'generate_watch_book_modules.py');

const tmp = mkdtempSync(join(tmpdir(), 'suyue-mod-'));
const booksDir = join(tmp, 'books');
const outDir = join(tmp, 'out');
mkdirSync(booksDir);

// 内容：一段中文 + 结尾，确保 >1 块且多字节字符跨块。
const textA = '素阅内置书甲，用于验证分块与还原。' .repeat(40);
const textB = '第二本书：跨块边界的中文字符。'.repeat(30);
writeFileSync(join(booksDir, '书甲.txt'), '\uFEFF' + textA); // BOM
writeFileSync(join(booksDir, '书乙.txt'), textB);
writeFileSync(join(booksDir, '书甲副本.txt'), textA); // 同内容 → 去重

const CHUNK = 256;
const run = spawnSync('python3', [script, '--books-dir', booksDir,
  '--out-dir', outDir, '--chunk-bytes', String(CHUNK)],
  { encoding: 'utf8' });
assert.equal(run.status, 0, 'generator must succeed: ' + run.stderr);
assert.match(run.stdout, /WATCH_BOOKS_TOTAL count=2 /,
  'duplicate content must be deduped to 2 books');

const files = readdirSync(outDir);
assert.ok(files.includes('BookCatalog.g.js'));
assert.ok(files.includes('BookRegistry.g.js'));
assert.ok(files.includes('books_report.json'));

const report = JSON.parse(
  readFileSync(join(outDir, 'books_report.json'), 'utf8'));
assert.equal(report.schema, 1);
assert.equal(report.chunkBytes, CHUNK);
assert.equal(report.books.length, 2, 'dedupe to two books');

const catalog = readFileSync(join(outDir, 'BookCatalog.g.js'), 'utf8');
const registry = readFileSync(join(outDir, 'BookRegistry.g.js'), 'utf8');

// 目录仅元数据：不得出现长 base64 大块。
assert.match(catalog, /export var BOOKS = \[/);
assert.ok(!/[A-Za-z0-9+/]{200,}/.test(catalog),
  'BookCatalog must contain metadata only (no text payload)');

const expected = {
  '书甲': Buffer.from(textA, 'utf8'),
  '书乙': Buffer.from(textB, 'utf8')
};

for (const b of report.books) {
  const raw = expected[b.title];
  assert.ok(raw, 'unexpected title ' + b.title);
  const digest = createHash('sha256').update(raw).digest('hex');
  assert.equal(b.sha256, digest, 'report sha256 must match source');
  assert.equal(b.bytes, raw.length, 'report bytes must match source');
  assert.equal(b.chunks, Math.ceil(raw.length / CHUNK));
  // 目录里有这本书的元数据
  assert.ok(catalog.includes(JSON.stringify(b.bookId)) &&
    catalog.includes(JSON.stringify(b.title)));
  // 注册表引用了这本书的正文模块
  assert.ok(registry.includes('./BookText_' + b.bookId + '.g.js'));
  // report 的 chunk0Prefix 必须是 chunk0 的真前缀
  assert.ok(b.chunk0Prefix.length >= 32,
    'chunk0Prefix must be a real base64 prefix');
  assert.ok(raw.slice(0, 160).toString('base64').startsWith(
    b.chunk0Prefix), 'chunk0Prefix must match real chunk0');

  // 还原正文：按块序拼回，逐字节比对。
  const modPath = join(outDir, 'BookText_' + b.bookId + '.g.js');
  const mod = readFileSync(modPath, 'utf8');
  const chunks = {};
  const re = /^\s*(\d+): function \(\) \{ return "(.*)"; \},/gm;
  let m;
  while ((m = re.exec(mod)) !== null) chunks[m[1]] = m[2];
  assert.equal(Object.keys(chunks).length, b.chunks);
  const parts = [];
  for (let i = 0; i < b.chunks; i++) {
    assert.ok(chunks[i] !== undefined, 'missing chunk ' + i);
    parts.push(Buffer.from(chunks[i], 'base64'));
  }
  const rebuilt = Buffer.concat(parts);
  assert.equal(rebuilt.length, raw.length, 'rebuilt length must match');
  assert.ok(rebuilt.equals(raw),
    'rebuilt bytes must be byte-identical to normalized UTF-8');
}

// ---- 内存实测（子进程，--expose-gc）----
// 把生成的 .g.js 转成 .mjs 便于 Node 导入。
const esmDir = join(tmp, 'esm');
mkdirSync(esmDir);
for (const f of files) {
  if (!f.endsWith('.g.js')) continue;
  let src = readFileSync(join(outDir, f), 'utf8');
  src = src.replace(/\.g\.js'/g, ".mjs'");
  writeFileSync(join(esmDir, f.replace(/\.g\.js$/, '.mjs')), src);
}
const probe = join(esmDir, 'probe.mjs');
writeFileSync(probe, `
const mb = () => { global.gc(); return process.memoryUsage().heapUsed / 1048576; };
const before = mb();
const reg = await import('./BookRegistry.mjs');
const afterImport = mb();
const c = reg.getChunk(reg.BOOKS[0].bookId, 0);
const afterChunk = mb();
console.log(JSON.stringify({ before, afterImport, afterChunk,
  chunkLen: (c || '').length, books: reg.BOOKS.length,
  chunkBytes: reg.CHUNK_BYTES }));
`);
const measured = spawnSync(process.execPath, ['--expose-gc', probe],
  { encoding: 'utf8' });
assert.equal(measured.status, 0, measured.stderr);
const mem = JSON.parse(measured.stdout.trim());
assert.equal(mem.books, 2);
assert.equal(mem.chunkBytes, CHUNK);
assert.ok(mem.chunkLen > 0, 'getChunk(0) must return a base64 chunk');
console.info('  [内存实测 V8] before=%sMB import后=%sMB 取1块后=%sMB ' +
  'chunk0=%sB（import 会保留模块源；JerryScript 真机堆占用待测）',
  mem.before.toFixed(2), mem.afterImport.toFixed(2),
  mem.afterChunk.toFixed(2), mem.chunkLen);

rmSync(tmp, { recursive: true, force: true });
console.info('PASS: 构建期 JS 数据模块——目录仅元数据、正文可逐字节还原、' +
  '多字节跨块正确、内存数字已实测打印（issue #10）');
