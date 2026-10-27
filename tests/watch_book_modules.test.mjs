// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/watch_book_modules.test.mjs
// issue #10（复核后）：构建期把私人 TXT 规范化为 **rawfile 资源**并生成
// **仅元数据**书单的回归。
//
// 覆盖：
//   · 生成 <bookId>.txt（规范化 UTF-8 真实字节）/ manifest.json /
//     books_report.json / BookCatalog.g.js（仅元数据）；
//   · 不生成任何 JS 正文数据模块（BookText_*.g.js 必须不存在）；
//   · 书单只含元数据（不得含正文大块）；
//   · 资源文件逐字节等于规范化 UTF-8（去 BOM、同内容去重）；
//   · 报告 sha256 / bytes / probeB64 与真实字节一致。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const script = join(repo, 'tools', 'generate_watch_book_modules.py');

const tmp = mkdtempSync(join(tmpdir(), 'suyue-cat-'));
const booksDir = join(tmp, 'books');
const resourceDir = join(tmp, 'rawfile', 'gt4books');
const catalogDir = join(tmp, 'books-js');
mkdirSync(booksDir);

const textA = '素阅内置书甲，用于验证资源与书单。'.repeat(40);
const textB = '第二本书：另一段中文正文。'.repeat(30);
writeFileSync(join(booksDir, '书甲.txt'), '\uFEFF' + textA); // BOM → 剥掉
writeFileSync(join(booksDir, '书乙.txt'), textB);
writeFileSync(join(booksDir, '书甲副本.txt'), textA); // 同内容 → 去重

const run = spawnSync('python3', [script,
  '--books-dir', booksDir,
  '--resource-dir', resourceDir,
  '--catalog-dir', catalogDir], { encoding: 'utf8' });
assert.equal(run.status, 0, 'generator must succeed: ' + run.stderr);
assert.match(run.stdout, /WATCH_BOOKS_TOTAL count=2 /,
  'duplicate content must be deduped to 2 books');

const resFiles = readdirSync(resourceDir);
assert.ok(resFiles.includes('manifest.json'), 'manifest.json must exist');
assert.ok(resFiles.includes('books_report.json'), 'report must exist');
const catFiles = readdirSync(catalogDir);
assert.deepEqual(catFiles, ['BookCatalog.g.js'],
  'catalog dir must contain only BookCatalog.g.js');
// 关键：绝不能再生成把正文编译进 JS 的模块。
for (const f of resFiles.concat(catFiles)) {
  assert.ok(!/^BookText_.*\.g\.js$/.test(f),
    'must NOT generate JS text modules: ' + f);
  assert.ok(!/^BookRegistry/.test(f),
    'must NOT generate a text registry: ' + f);
}

const report = JSON.parse(
  readFileSync(join(resourceDir, 'books_report.json'), 'utf8'));
assert.equal(report.schema, 1);
assert.equal(report.mode, 'rawfile');
assert.equal(report.books.length, 2, 'dedupe to two books');

const catalog = readFileSync(join(catalogDir, 'BookCatalog.g.js'), 'utf8');
assert.match(catalog, /export var BOOKS = \[/);
assert.ok(!/[A-Za-z0-9+/]{120,}/.test(catalog),
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
  assert.equal(b.file, b.bookId + '.txt');
  assert.deepEqual(b.chapters,
    [{ title: '正文', offset: 0, length: raw.length }],
    'no reliable headings -> one continuous 正文 chapter');
  assert.ok(catalog.includes(JSON.stringify(b.bookId)) &&
    catalog.includes(JSON.stringify(b.title)) &&
    catalog.includes(JSON.stringify(b.file)) &&
    catalog.includes('chapters:'),
    'catalog must carry bookId/title/file/chapters metadata');
  // 资源文件必须逐字节等于规范化 UTF-8（BOM 已剥、去重后）。
  const onDisk = readFileSync(join(resourceDir, b.file));
  assert.ok(onDisk.equals(raw),
    'resource <bookId>.txt must be byte-identical normalized UTF-8');
  // 报告里的 probeB64 必须是正文前 64 字节。
  const probe = Buffer.from(b.probeB64, 'base64');
  assert.ok(probe.length > 0 && probe.equals(raw.subarray(0, probe.length)),
    'probeB64 must be the first bytes of the content');
}

rmSync(tmp, { recursive: true, force: true });
console.info('PASS: 构建期 rawfile 资源 + 仅元数据书单——规范化字节正确、' +
  '同内容去重、绝不生成 JS 正文模块（issue #10）');
