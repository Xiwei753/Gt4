// SPDX-License-Identifier: GPL-3.0-only
// Run: node tests/watch_bundled_source.test.mjs
// issue #10（复核后）：内置正文**按需 rawfile 读取**（BundledBookSource）回归。
//
// 用真实生成器把一本书规范化为 rawfile 资源 + 仅元数据书单，放进 Node 桩的
// internal://app/rawfile/gt4books/，验证：
//   · 直接窗口读 rawfile：与原始规范化字节逐字节一致（含多字节中文）；
//   · rawfile 直接读不支持时，file.copy 到私有目录再读（复制回退）；
//   · 两条路都失败：结构化错误带真实 api/uri/code（不假装读到）；
//   · 文件接口永不回调：有限超时返回，不卡死；
//   · 越界/未知 bookId 的安全行为。
// 结束后还原提交的默认 books/ 目录。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, writeFileSync } from 'node:fs';
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
const resourceDir = join(tmp, 'res');
mkdirSync(src);
// 254 个 ASCII 后接一个 3 字节汉字，再接一段 ASCII：
// 读取窗口 [250,270) 会从汉字中间穿过。
const raw = Buffer.concat([
  Buffer.from('a'.repeat(254), 'utf8'),
  Buffer.from('中', 'utf8'),
  Buffer.from('b'.repeat(100), 'utf8')
]);
const expectedId = createHash('sha256').update(raw).digest('hex').slice(0, 16);
writeFileSync(join(src, '跨块.txt'), raw);

const settle = (fn, ms = 2000) => Promise.race([
  new Promise((res) => fn(res)),
  new Promise((_, rej) => setTimeout(
    () => rej(new Error('test settle timeout')), ms))
]);

try {
  const gen = spawnSync('python3', [script, '--books-dir', src,
    '--resource-dir', resourceDir, '--catalog-dir', booksDirSrc],
    { encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);

  const sandbox = mkdtempSync(join(tmpdir(), 'suyue-bsrcfs-'));
  // 把资源放到桩映射的 rawfile 目录（internal://app/rawfile/gt4books/）。
  mkdirSync(join(sandbox, 'rawfile', 'gt4books'), { recursive: true });
  copyFileSync(join(resourceDir, expectedId + '.txt'),
    join(sandbox, 'rawfile', 'gt4books', expectedId + '.txt'));

  const stubPath = writeSystemFileStub(tmp, sandbox);
  const systemFile = (await import(stubPath)).default;
  const we = writeWearEngineStub(tmp);
  const router = writeRouterStub(tmp);
  const load = createWatchLoader({ tmpDir: tmp, stubPath,
    wearengineStubPath: we, routerStubPath: router });
  const bs = await load('storage/BundledBookSource.js');

  assert.equal(bs.BUNDLED_BOOKS.length, 1);
  const entry = bs.BUNDLED_BOOKS[0];
  assert.equal(entry.origin, 'builtin');
  assert.equal(entry.bookId, expectedId);
  assert.equal(entry.bytes, raw.length);
  assert.equal(bs.isBundled(expectedId), true);
  assert.equal(bs.isBundled('zzzzzzzzzzzzzzzz'), false);
  assert.equal(bs.bundledEntry('zzzzzzzzzzzzzzzz'), null);
  assert.equal(bs.bundledEntry(expectedId).title, '跨块');

  const read = (offset, size) => settle((done) =>
    bs.readBundledWindow(expectedId, offset, size, done));
  const eq = (r, from, to) => {
    assert.equal(r.ok, true, 'expected ok read');
    const got = Buffer.from(r.bytes);
    assert.ok(got.equals(raw.subarray(from, to)),
      'window [' + from + ',' + to + ') mismatch');
  };

  // ---- 1. 新书只复制一次，旧书随后直接读取同一本缓存 ----
  {
    const originalCopy=systemFile.copy;
    const originalBuffer=systemFile.readArrayBuffer;
    const originalText=systemFile.readText;
    let copies=0, rawReadAttempts=0;
    const stages=[];
    systemFile.copy=(o)=>{copies++;originalCopy(o);};
    systemFile.readArrayBuffer=(o)=>{
      if(o.uri.indexOf('rawfile/')>=0)rawReadAttempts++;
      originalBuffer(o);
    };
    systemFile.readText=(o)=>{
      if(o.uri.indexOf('rawfile/')>=0)rawReadAttempts++;
      originalText(o);
    };
    try {
      eq(await settle(done=>bs.readBundledWindow(
        expectedId,0,raw.length+10,done,(stage)=>stages.push(stage))),
        0,raw.length);
      assert.equal(copies,1,'first open copies only the current novel');
      assert.equal(rawReadAttempts,0,
        'no unsupported rawfile read probes before first copy');
      assert.ok(stages.includes('首次复制内置书'));
      assert.ok(stages.includes('读取缓存正文'));
      eq(await read(250,20),250,270);
      eq(await read(0,300),0,300);
      eq(await read(raw.length-5,100),raw.length-5,raw.length);
      assert.equal(copies,1,'later reads must reuse the verified cache');
    }finally{
      systemFile.copy=originalCopy;
      systemFile.readArrayBuffer=originalBuffer;
      systemFile.readText=originalText;
    }
  }
  const past=await read(raw.length+10,10);
  assert.equal(past.ok,true);
  assert.equal(past.bytes.length,0);

  // ---- 2. rawfile 不能直接读也不影响已经缓存的书 ----
  {
    const original = systemFile.readArrayBuffer;
    const originalText = systemFile.readText;
    systemFile.readArrayBuffer = (o) => {
      if (o.uri && o.uri.indexOf('rawfile/') >= 0) {
        return o.fail && o.fail({}, 300);
      }
      return original(o);
    };
    systemFile.readText = (o) => {
      if (o.uri && o.uri.indexOf('rawfile/') >= 0) {
        return o.fail && o.fail({}, 300);
      }
      return originalText(o);
    };
    try {
      eq(await read(250, 20), 250, 270);
    } finally {
      systemFile.readArrayBuffer = original;
      systemFile.readText = originalText;
    }
  }

  // ---- 3a. GT4 真机 code=200：私有副本二进制读失败，
  // 文本读取成功时应能恢复正常正文；不再直接报告 read_failed。
  {
    const originalBuffer = systemFile.readArrayBuffer;
    const originalText = systemFile.readText;
    systemFile.readArrayBuffer = (o) => o.fail && o.fail(
      { message: 'System error' }, 200);
    systemFile.readText = (o) => {
      if (o.uri && o.uri.indexOf('rawfile/') >= 0) {
        return o.fail && o.fail({ message: 'System error' }, 200);
      }
      return originalText(o);
    };
    try {
      eq(await read(0, 20), 0, 20);
      eq(await read(250, 20), 250, 270);
    } finally {
      systemFile.readArrayBuffer = originalBuffer;
      systemFile.readText = originalText;
    }
  }

  // ---- 3. 新书缓存不存在，复制失败时不能伪装成加载成功 ----
  {
    const originalAccess = systemFile.access;
    const original = systemFile.readArrayBuffer;
    const originalText = systemFile.readText;
    const originalCopy = systemFile.copy;
    systemFile.access = (o) => o.fail && o.fail({}, 301);
    systemFile.readArrayBuffer = (o) => o.fail && o.fail({}, 300);
    systemFile.readText = (o) => o.fail && o.fail({}, 300);
    systemFile.copy = (o) => o.fail && o.fail({}, 300);
    try {
      const r = await read(0, 20);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'copy_failed');
      assert.equal(r.stage, 'copy');
      assert.equal(r.api, 'copy');
      assert.equal(r.code, 300);
    } finally {
      systemFile.access = originalAccess;
      systemFile.readArrayBuffer = original;
      systemFile.readText = originalText;
      systemFile.copy = originalCopy;
    }
  }

  // ---- 4. 接口永不回调 → 有限超时，不卡死 ----
  {
    const original = systemFile.readArrayBuffer;
    const originalText = systemFile.readText;
    const originalCopy = systemFile.copy;
    systemFile.readArrayBuffer = () => {};
    systemFile.readText = () => {};
    systemFile.copy = () => {};
    bs.setBundledTimeout(40);
    try {
      const r = await read(0, 20);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'timeout');
    } finally {
      bs.setBundledTimeout(6000);
      systemFile.readArrayBuffer = original;
      systemFile.readText = originalText;
      systemFile.copy = originalCopy;
    }
  }

  // ---- 5. 未知 bookId → not_bundled ----
  const miss = await settle((done) =>
    bs.readBundledWindow('zzzzzzzzzzzzzzzz', 0, 10, done));
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, 'not_bundled');

  rmSync(sandbox, { recursive: true, force: true });
  console.info('  [1] 内置读取：一次复制后缓存窗口逐字节一致、' +
    '双失败结构化报错、无回调超时 ✓');
} finally {
  rmSync(tmp, { recursive: true, force: true });
  restore();
}

console.info('PASS: 内置正文按需 rawfile 读取（readBundledWindow）' +
  '逐字节一致、复制回退与错误码真实（issue #10 复核后）');
