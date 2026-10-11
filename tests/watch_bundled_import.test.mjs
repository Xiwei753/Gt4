// SPDX-License-Identifier: GPL-3.0-only
// issue #7 评论回归：内置书籍导入的**行为**测试（真机失败的成因）。
//
// 覆盖：
//   1. rawfile → 私有 temp 的整文件 copy 路线（happy path）：
//      两本导入成功、字节与 SHA-256 校验、写索引、标记已处理；
//   2. 幂等 + 「删了不复活」：二次运行跳过；删书后不重生；
//   3. 无可读内置资源 → 安全 no-op（resource_unavailable）；
//   4. readText 不回调 → 有限超时后 settle（不再无限等待）；
//   5. copy 报错 / 超时 → 上屏可见步骤 + 真实码，且不落半成品；
//   6. 校验不符（SHA-256）→ 失败并清理暂存；
//   7. 页面后台集成：readIndex 不被导入阻塞，导入完成后书架就绪。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync,
  existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeSystemFileStub } from './helpers/system_file_stub.mjs';
import { createWatchLoader, writeWearEngineStub,
  writeRouterStub, wait } from './helpers/watch_module_loader.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// 每次用例独立的沙箱 + 模块实例（避免用例间串味）。
function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'suyue-imp-'));
  const sandbox = mkdtempSync(join(tmpdir(), 'suyue-impfs-'));
  const stubPath = writeSystemFileStub(tmp, sandbox);
  const wearengineStubPath = writeWearEngineStub(tmp);
  const routerStubPath = writeRouterStub(tmp);
  const load = createWatchLoader({ tmpDir: tmp, stubPath,
    wearengineStubPath, routerStubPath });
  return { tmp, sandbox, stubPath, load };
}

// 带超时的 resolve：导入器若卡住会失败而不是挂死测试。
function settle(fn, ms = 3000, label = 'importer') {
  return Promise.race([
    wait(fn),
    new Promise((_, rej) => setTimeout(
      () => rej(new Error(label + ' did not settle')), ms))
  ]);
}

// 轮询谓词直到为真（`wait()` 是回调式，不能当轮询用）。
async function waitFor(fn, ms = 3000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 4));
  }
  throw new Error('timeout waiting for ' + label);
}

// 在沙箱内布置 rawfile/gt4books（manifest + TXT），模拟打包资源可读。
function seedRawfile(sandbox, books) {
  const dir = join(sandbox, 'rawfile', 'gt4books');
  mkdirSync(dir, { recursive: true });
  const manifest = { schema: 1, generator: 'test',
    encoding: 'utf-8', books: [] };
  for (const b of books) {
    writeFileSync(join(dir, b.bookId + '.txt'), b.content);
    manifest.books.push({
      bookId: b.bookId, title: b.title, file: b.bookId + '.txt',
      bytes: b.content.length,
      sha256: b.sha256 || sha(b.content), encoding: 'utf-8'
    });
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

const A = { bookId: '1111111111111111', title: '书甲',
  content: Buffer.from('第一章\n中文正文 A\n', 'utf8') };
const B = { bookId: '2222222222222222', title: '书乙',
  content: Buffer.from('第二章\n中文正文 B\n', 'utf8') };

const bookPathIn = (sandbox, id) =>
  join(sandbox, 'gt4reader', 'books', id + '.txt');
const tempPathIn = (sandbox, id) =>
  join(sandbox, 'gt4reader', 'temp', id);

// ---- 1. happy path：两本导入成功 ------------------------------------
{
  const { sandbox, load } = setup();
  seedRawfile(sandbox, [A, B]);
  const imp = await load('storage/BundledBookImporter.js');
  imp.setImportTimeout(2000);
  const stages = [];
  const res = await settle((cb) => imp.importBundledBooks(cb,
    (s) => stages.push(s)));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.imported, 2, 'both books must import');
  assert.equal(res.failed, 0);
  // 六个可见阶段都出现过。
  for (const label of ['读取 bundled.json', '检查 rawfile/manifest',
    '复制第 ', '校验/落盘', '写索引', '标记已处理']) {
    assert.ok(stages.some((s) => s.includes(label)),
      'stage missing: ' + label + ' got ' + JSON.stringify(stages));
  }
  const index = JSON.parse(readFileSync(
    join(sandbox, 'gt4reader', 'books.json'), 'utf8'));
  assert.equal(index.length, 2);
  assert.deepEqual(index.map((e) => e.bookId).sort(),
    [A.bookId, B.bookId]);
  for (const b of [A, B]) {
    const stored = readFileSync(bookPathIn(sandbox, b.bookId));
    assert.ok(stored.equals(b.content), 'stored bytes must match');
    assert.equal(existsSync(tempPathIn(sandbox, b.bookId)), false,
      'temp must be cleaned after commit');
  }
  const marker = JSON.parse(readFileSync(
    join(sandbox, 'gt4reader', 'bundled.json'), 'utf8'));
  assert.equal(marker.handled[A.bookId], true);
  assert.equal(marker.handled[B.bookId], true);
}

// ---- 2. 幂等 + 删了不复活 -------------------------------------------
{
  const { sandbox, load } = setup();
  seedRawfile(sandbox, [A, B]);
  const imp = await load('storage/BundledBookImporter.js');
  imp.setImportTimeout(2000);
  await settle((cb) => imp.importBundledBooks(cb, () => {}));
  const again = await settle((cb) => imp.importBundledBooks(cb, () => {}));
  assert.equal(again.imported, 0, 'second run must not re-import');
  assert.equal(again.skipped, 2);
  // 删除其中一本（像用户点删除），再运行：不得复活。
  const LI = await load('storage/LibraryIndex.js');
  await settle((cb) => LI.removeBook(A.bookId, cb), 2000, 'removeBook');
  rmSync(bookPathIn(sandbox, A.bookId), { force: true });
  const after = await settle((cb) => imp.importBundledBooks(cb, () => {}));
  assert.equal(after.imported, 0, 'deleted book must not resurrect');
  assert.equal(existsSync(bookPathIn(sandbox, A.bookId)), false);
  assert.equal(existsSync(bookPathIn(sandbox, B.bookId)), true,
    'deleting one book must not affect another');
}

// ---- 3. 无可读内置资源 → 安全 no-op ---------------------------------
{
  const { sandbox, load } = setup();
  const imp = await load('storage/BundledBookImporter.js');
  imp.setImportTimeout(1000);
  const res = await settle((cb) => imp.importBundledBooks(cb, () => {}));
  assert.equal(res.ok, true);
  assert.equal(res.reason, 'resource_unavailable');
  assert.equal(res.imported, 0);
  assert.equal(existsSync(join(sandbox, 'gt4reader', 'books.json')),
    false, 'must not create an index when nothing is bundled');
}

// ---- 4. readText 不回调 → 有限超时后 settle -------------------------
{
  const { sandbox, load, stubPath } = setup();
  seedRawfile(sandbox, [A]);
  const systemFile = (await import(stubPath)).default;
  const orig = systemFile.readText;
  systemFile.readText = () => {};
  try {
    const imp = await load('storage/BundledBookImporter.js');
    imp.setImportTimeout(40);
    const res = await settle((cb) => imp.importBundledBooks(cb,
      () => {}), 2000);
    assert.equal(res.ok, true, 'a hung readText must settle, not hang');
    assert.equal(res.reason, 'resource_unavailable');
    assert.equal(res.code, 'timeout');
  } finally {
    systemFile.readText = orig;
  }
}

// ---- 5/6. 失败路径：copy 报错、copy 超时、摘要不符 ------------------
async function failureCase({ books = [A], mutate, expectReason,
  expectStep }) {
  const { sandbox, load, stubPath } = setup();
  seedRawfile(sandbox, books);
  const systemFile = (await import(stubPath)).default;
  const origin = Object.assign({}, systemFile);
  const imp = await load('storage/BundledBookImporter.js');
  imp.setImportTimeout(500);
  imp.setCopyTimeout(60);
  mutate(systemFile);
  try {
    const res = await settle((cb) => imp.importBundledBooks(cb, () => {}));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.failed, 1, 'the book must be reported failed');
    assert.ok(res.first && res.first.step.includes(expectStep),
      'step must be visible, got: ' + JSON.stringify(res.first));
    if (expectReason) {
      assert.ok(res.first.reason.includes(expectReason),
        'reason must be visible, got: ' + JSON.stringify(res.first));
    }
    assert.equal(existsSync(bookPathIn(sandbox, A.bookId)), false,
      'a failed import must not leave a book');
    assert.equal(existsSync(tempPathIn(sandbox, A.bookId)), false,
      'temp must be cleaned on failure');
    return res;
  } finally {
    Object.assign(systemFile, origin);
  }
}

// copy 报 300。
await failureCase({
  mutate: (sf) => { sf.copy = (o) => o.fail && o.fail({}, 300); },
  expectReason: '复制失败', expectStep: '复制第'
});

// copy 永不回调 → 有限超时（steps 可见）。
{
  const res = await failureCase({
    mutate: (sf) => { sf.copy = () => {}; },
    expectReason: '复制失败', expectStep: '复制第'
  });
  assert.equal(res.first.code, 'timeout',
    'a hung copy must surface the timeout code');
}

// SHA-256 不符：manifest 里写错误摘要，字节数正确。
await failureCase({
  books: [{ bookId: A.bookId, title: A.title, content: A.content,
    sha256: 'f'.repeat(64) }],
  mutate: () => {},
  expectReason: 'SHA-256', expectStep: '校验/落盘'
});

// ---- 7. 页面后台集成：不阻塞书架，导入完成后就绪 --------------------
{
  const { sandbox, load } = setup();
  seedRawfile(sandbox, [A, B]);
  const imp = await load('storage/BundledBookImporter.js');
  imp.setImportTimeout(2000);
  const pageMod = await load('pages/index/index.js');
  const page = Object.create(pageMod.default);
  page.data = Object.assign({}, pageMod.default.data);
  page.initTimeoutMs = 4000;
  const started = Date.now();
  page.onInit();
  await waitFor(() => page.initDone === true, 3000, 'page initDone');
  assert.ok(Date.now() - started < 3000,
    'shelf must reach a terminal state without waiting for the import');
  await waitFor(() => page.bundledStatus.includes('内置书籍已导入'),
    3000, 'import result');
  assert.equal(page.books.length, 2,
    'imported books must appear on the shelf');
  assert.ok(page.status.includes('本地书库就绪'),
    'shelf status must become ready after import, got: ' + page.status);
  assert.ok(page.bundledStatus.includes('2'),
    'import result must be reported separately, got: ' +
    page.bundledStatus);
}

console.info('PASS: bundled book import copies from rawfile in ' +
  'background, verifies, is idempotent and never blocks the shelf ' +
  '(issue #7 device regression)');
