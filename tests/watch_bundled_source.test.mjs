// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/watch_bundled_source.test.mjs
// issue #10：内置正文读取（BundledBookSource）回归。
//
// 用真实生成器把一本「多字节字符正好跨块」的书生成到源码树 books/，
// 再经真实加载器加载 BundledBookSource，验证：
//   · 书单/书包元数据（origin='builtin'）；
//   · readBundledWindow 返回与原始规范化字节逐字节一致的窗口；
//   · 跨块窗口正确（因为总是整块解码再切片）；
//   · 越界/未知书 id 的安全行为。
// 结束后还原提交的默认 books/ 目录。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSystemFileStub } from './helpers/system_file_stub.mjs';
import { createWatchLoader, writeWearEngineStub,
  writeRouterStub } from './helpers/watch_module_loader.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const booksDirSrc = join(repo, 'apps', 'watch', 'entry',
  'src', 'main', 'js', 'MainAbility', 'books');
const script = join(repo, 'tools', 'generate_watch_book_modules.py');

// 备份提交的默认 books/ 目录（generator 会清空重建）。
const backup = {};
for (const f of readdirSync(booksDirSrc)) {
  backup[f] = readFileSync(join(booksDirSrc, f), 'utf8');
}
const restore = () => {
  rmSync(booksDirSrc, { recursive: true, force: true });
  mkdirSync(booksDirSrc, { recursive: true });
  for (const f of Object.keys(backup)) {
    writeFileSync(join(booksDirSrc, f), backup[f]);
  }
};

const tmp = mkdtempSync(join(tmpdir(), 'suyue-bsrc-'));
const src = join(tmp, 'books');
mkdirSync(src);
// 254 个 ASCII 后接一个 3 字节汉字，块大小 256 → 边界落在汉字中间。
const raw = Buffer.concat([
  Buffer.from('a'.repeat(254), 'utf8'),
  Buffer.from('中', 'utf8'),
  Buffer.from('b'.repeat(100), 'utf8')
]);
writeFileSync(join(src, '跨块.txt'), raw);

try {
  const gen = spawnSync('python3', [script, '--books-dir', src,
    '--out-dir', booksDirSrc, '--chunk-bytes', '256'],
    { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);

  const sandbox = mkdtempSync(join(tmpdir(), 'suyue-bsrcfs-'));
  const stubPath = writeSystemFileStub(tmp, sandbox);
  const we = writeWearEngineStub(tmp);
  const router = writeRouterStub(tmp);
  const load = createWatchLoader({ tmpDir: tmp, stubPath,
    wearengineStubPath: we, routerStubPath: router });
  const bs = await load('storage/BundledBookSource.js');

  assert.equal(bs.BUNDLED_BOOKS.length, 1);
  const entry = bs.BUNDLED_BOOKS[0];
  assert.equal(entry.origin, 'builtin');
  assert.equal(entry.bytes, raw.length);
  const id = entry.bookId;
  assert.equal(bs.isBundled(id), true);
  assert.equal(bs.isBundled('zzzzzzzzzzzzzzzz'), false);
  assert.equal(bs.bundledEntry('zzzzzzzzzzzzzzzz'), null);
  assert.equal(bs.bundledEntry(id).title, '跨块');

  const read = (offset, size) => {
    let out;
    bs.readBundledWindow(id, offset, size, (r) => { out = r; });
    return out;
  };
  const eq = (r, from, to) => {
    assert.equal(r.ok, true);
    const got = Buffer.from(r.bytes);
    const want = raw.subarray(from, to);
    assert.ok(got.equals(want),
      'window [' + from + ',' + to + ') mismatch');
  };

  // 整段
  eq(read(0, raw.length + 10), 0, raw.length);
  // 跨块窗口（边界 256 在汉字中间）
  eq(read(250, 20), 250, 270);
  eq(read(0, 300), 0, 300);
  // 末尾越界 → 夹到 EOF
  eq(read(raw.length - 5, 100), raw.length - 5, raw.length);
  // 完全越界 → 空
  const past = read(raw.length + 10, 10);
  assert.equal(past.ok, true);
  assert.equal(past.bytes.length, 0);

  // 未知书 id → 结构化失败，不抛异常
  let miss;
  bs.readBundledWindow('zzzzzzzzzzzzzzzz', 0, 10, (r) => { miss = r; });
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, 'not_bundled');

  rmSync(sandbox, { recursive: true, force: true });
  console.info('  [1] 内置读取：窗口逐字节一致、跨块正确、越界安全 ✓');
} finally {
  rmSync(tmp, { recursive: true, force: true });
  restore();
}

console.info('PASS: 内置正文读取（readBundledWindow）与原始字节逐字节一致，' +
  '多字节跨块安全（issue #10）');
