// SPDX-License-Identifier: GPL-3.0-only
// issue #7：构建期内置书籍的静态契约 + 产物内层 bin 校验。
// 不签名、不安装；只验证脚本接线与 build_artifact_check.sh 的
// 内层 entry.bin 资源核验确实能工作（含反例）。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync,
  rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const WATCH_BUNDLE = 'con.xiwei.suyue.gt4';

// ---- 静态契约 --------------------------------------------------------
{
  const build = readFileSync('tools/build_watch_lite.sh', 'utf8');
  assert.ok(build.includes('WATCH_BOOKS_DIR'),
    'build script must accept WATCH_BOOKS_DIR');
  assert.ok(build.includes('tools/prepare_watch_books.py'),
    'build script must call the book preparer');
  assert.ok(build.includes('trap cleanup_books EXIT'),
    'build script must always clean the temporary book resource');
  assert.ok(build.includes('rawfile/gt4books'),
    'books must be staged under the Lite rawfile resource dir');
  assert.ok(build.includes('--expect-books-manifest'),
    'build script must ask the artifact check to verify inner bin books');

  const check = readFileSync('tests/build_artifact_check.sh', 'utf8');
  assert.ok(check.includes('--expect-books-manifest'));
  assert.ok(check.includes('BOOKS_IN_BIN_OK'));
  assert.ok(check.includes('rawfile/gt4books/'));

  const importer = readFileSync(
    'apps/watch/entry/src/main/js/MainAbility/storage/BundledBookImporter.js',
    'utf8');
  for (const token of ['importBundledBooks', 'BUNDLED_IMPORT_UNAVAILABLE',
    'bundled.json', 'createSha256', 'writeBytes', 'readWindow',
    'commitVerifiedBook', 'addBook']) {
    assert.ok(importer.includes(token),
      'importer must use ' + token);
  }
  assert.ok(importer.includes('internal://app/'),
    'importer must only probe the JS-readable private data dir');
  // 幂等与「删了不复活」靠标记文件；资源/正文绝不硬编码书 id 之外的内容。
  assert.ok(importer.includes('marker.handled'),
    'importer must record handled bookIds (no auto-resurrect)');

  const index = readFileSync(
    'apps/watch/entry/src/main/js/MainAbility/pages/index/index.js', 'utf8');
  assert.ok(index.includes('importBundledBooks'),
    'index page must wire the importer once');
  assert.ok(index.indexOf('importBundledBooks') <
    index.indexOf('this.migrateDemo'),
    'bundled import must run before the legacy demo migration');

  const storage = readFileSync(
    'apps/watch/entry/src/main/js/MainAbility/storage/BookStorage.js', 'utf8');
  assert.ok(storage.includes('export function writeBytes'),
    'BookStorage must expose a chunked binary writer');

  const gitignore = readFileSync('.gitignore', 'utf8');
  assert.ok(gitignore.includes(
    'apps/watch/entry/src/main/resources/rawfile/'),
    'temporary book resources must be gitignored (no novel text in the repo)');
}

// ---- 产物内层 bin 校验（含反例）-------------------------------------
const root = mkdtempSync(join(tmpdir(), 'suyue-books-bin-'));
const source = join(root, 'config.json');
const resDir = join(root, 'res', 'gt4books');
mkdirSync(resDir, { recursive: true });

const bookA = Buffer.from('第一章\n中文正文 A\n', 'utf8');
const bookB = Buffer.from('第二章\n中文正文 B\n', 'utf8');
const idA = createHash('sha256').update(bookA).digest('hex').slice(0, 16);
const idB = createHash('sha256').update(bookB).digest('hex').slice(0, 16);
writeFileSync(join(resDir, idA + '.txt'), bookA);
writeFileSync(join(resDir, idB + '.txt'), bookB);
const manifestPath = join(resDir, 'manifest.json');
const manifest = {
  schema: 1,
  encoding: 'utf-8',
  books: [
    { bookId: idA, title: '甲书', file: idA + '.txt',
      bytes: bookA.length,
      sha256: createHash('sha256').update(bookA).digest('hex'),
      encoding: 'utf-8' },
    { bookId: idB, title: '乙书', file: idB + '.txt',
      bytes: bookB.length,
      sha256: createHash('sha256').update(bookB).digest('hex'),
      encoding: 'utf-8' }
  ]
};
writeFileSync(manifestPath, JSON.stringify(manifest));
writeFileSync(source, JSON.stringify({
  app: { bundleName: WATCH_BUNDLE },
  module: {
    deviceType: ['liteWearable'],
    metaData: { customizeData: [{ name: 'supportLists',
      value: 'com.xiwei.suyue:ab12' }] }
  }
}));

function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function binWith(extras, bundle = WATCH_BUNDLE) {
  const nb = Buffer.from(bundle, 'utf8');
  return Buffer.concat([
    Buffer.from([0xbe]), u32be(nb.length), nb, Buffer.from('\n'),
    ...extras
  ]);
}

function assetPath(id) {
  return Buffer.from('/assets/entry/resources/rawfile/gt4books/' +
    id + '.txt', 'utf8');
}

function writeHap(hapPath, binBytes) {
  const binFile = hapPath + '.bin';
  writeFileSync(binFile, binBytes);
  const script = [
    'import sys, zipfile',
    'with open(sys.argv[1], "rb") as f: data = f.read()',
    'with zipfile.ZipFile(sys.argv[2], "w",',
    '        compression=zipfile.ZIP_DEFLATED) as z:',
    '    z.writestr("entry-default-unsigned.bin", data)'
  ].join('\n');
  const r = spawnSync('python3', ['-c', script, binFile, hapPath],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function check(hapPath, extra = []) {
  return spawnSync('bash', ['tests/build_artifact_check.sh', hapPath,
    '--bundle', WATCH_BUNDLE, '--device', 'liteWearable', '--mode', 'debug',
    '--source-manifest', source, ...extra], { encoding: 'utf8' });
}

try {
  const goodHap = join(root, 'entry-default-debug-signed.hap');
  // 内层 bin 同时携带：真实正文字节 + 资源目录名 + 文件名 + manifest 字节。
  const manifestBytes = readFileSync(manifestPath);
  writeHap(goodHap, binWith([
    assetPath(idA), Buffer.from('\n'), bookA, Buffer.from('\n'),
    assetPath(idB), Buffer.from('\n'), bookB, Buffer.from('\n'),
    manifestBytes
  ]));
  const ok = check(goodHap, ['--expect-books-manifest', manifestPath]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /BOOKS_IN_BIN_OK count=2/);

  // 反例 1：缺一本的**真实正文** → 必须失败（只看到路径不算）。
  const missingContent = join(root, 'entry-default-debug-signed.hap');
  writeHap(missingContent, binWith([
    assetPath(idA), Buffer.from('\n'), bookA, Buffer.from('\n'),
    assetPath(idB), Buffer.from('\n'),
    manifestBytes
  ]));
  const bad = check(missingContent,
    ['--expect-books-manifest', manifestPath]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /content:/);

  // 反例 2：--expect-books-manifest 只对 Lite 单 bin 有意义。
  const multiHap = join(root, 'entry-default-debug-multi.hap');
  const script = [
    'import sys, zipfile',
    'with open(sys.argv[2], "r", encoding="utf-8") as f: cfg = f.read()',
    'with zipfile.ZipFile(sys.argv[1], "w") as z:',
    '    z.writestr("config.json", cfg)',
    '    z.writestr("pages/index/index.js", "export default {}")',
    '    z.writestr("pages/index/index.bc", "x")'
  ].join('\n');
  const mz = spawnSync('python3', ['-c', script, multiHap, source],
    { encoding: 'utf8' });
  assert.equal(mz.status, 0, mz.stderr);
  const wrongLayout = check(multiHap,
    ['--expect-books-manifest', manifestPath]);
  assert.notEqual(wrongLayout.status, 0);
  assert.match(wrongLayout.stderr, /requires a Lite single-bin HAP/);

  console.log('bundled books (issue #7): OK (no device, no signing)');
} finally {
  rmSync(root, { recursive: true, force: true });
}
