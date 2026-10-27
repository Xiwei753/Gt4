// SPDX-License-Identifier: GPL-3.0-only
// issue #7：构建期把本机 TXT 规范化为 Lite 构建资源
// （tools/prepare_watch_books.py）的行为测试。
// 这些测试不构建 HAP、不涉及设备；只验证脚本的输入/输出约定。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync,
  existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const SCRIPT = 'tools/prepare_watch_books.py';
const roots = [];

function tmp() {
  const root = mkdtempSync(join(tmpdir(), 'suyue-books-'));
  roots.push(root);
  const books = join(root, 'books 我的书');
  mkdirSync(books, { recursive: true });
  const res = join(root, 'res', 'gt4books');
  return { root, books, res };
}

function run(books, res, extra = []) {
  return spawnSync('python3',
    [SCRIPT, '--books-dir', books, '--resource-dir', res, ...extra],
    { encoding: 'utf8' });
}

function sha256hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function manifestOf(res) {
  return JSON.parse(readFileSync(join(res, 'manifest.json'), 'utf8'));
}

try {
  // (1) 缺目录 / 空目录 / 只有非 TXT → 明确失败，不产出半成品。
  {
    const { root, res } = tmp();
    const missing = run(join(root, 'nope'), res);
    assert.equal(missing.status, 3, missing.stderr);
    assert.ok(!existsSync(join(res, 'manifest.json')));
  }
  {
    const { books, res } = tmp();
    const empty = run(books, res);
    assert.equal(empty.status, 4, empty.stderr);
  }
  {
    const { books, res } = tmp();
    writeFileSync(join(books, 'note.md'), '# not a book');
    const noTxt = run(books, res);
    assert.equal(noTxt.status, 4, noTxt.stderr);
  }

  // (2) 两个真实 UTF-8 中文 TXT（其中一个带 BOM）→ 正确规范化 + 清单。
  {
    const { books, res } = tmp();
    const bodyA = Buffer.from('第一章\n中文正文 A\n', 'utf8');
    const bodyB = Buffer.from('\uFEFF第二章\n中文正文 B\n', 'utf8');
    writeFileSync(join(books, '乙 测试.txt'), bodyA);
    writeFileSync(join(books, '甲 测试.txt'), bodyB);
    const ok = run(books, res);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /WATCH_BOOKS_TOTAL count=2 /);
    // 正文绝不进日志（书名来自文件名，不会出现"中文正文"）。
    assert.ok(!ok.stdout.includes('中文正文'), '正文不得出现在日志里');

    const manifest = manifestOf(res);
    assert.equal(manifest.books.length, 2);
    // BOM 已在构建期剥离：bookId/摘要都按规范化后的 UTF-8 字节算。
    const expectB = Buffer.from('第二章\n中文正文 B\n', 'utf8');
    const expectA = bodyA;
    for (const book of manifest.books) {
      const normalized = book.title.startsWith('甲') ? expectB : expectA;
      assert.equal(book.bookId, sha256hex(normalized).slice(0, 16));
      assert.equal(book.bytes, normalized.length);
      assert.equal(book.sha256, sha256hex(normalized));
      assert.equal(book.encoding, 'utf-8');
      assert.ok(existsSync(join(res, book.file)));
      assert.ok(readFileSync(join(res, book.file)).equals(normalized));
    }
    const ids = new Set(manifest.books.map((b) => b.bookId));
    assert.equal(ids.size, 2);
  }

  // (2b) TXT 章节标题 → 规范化 UTF-8 字节偏移；长度首尾连续覆盖全文。
  {
    const { books, res } = tmp();
    const body = Buffer.from(
      '版权页\n\n第一章 启程\n' + '甲😀'.repeat(30) +
      '\n\nChapter 2 Return\n' + 'body '.repeat(40) +
      '\n番外 一\n尾声\n' + '结局正文。'.repeat(20), 'utf8');
    writeFileSync(join(books, '多章.txt'), body);
    const r = run(books, res);
    assert.equal(r.status, 0, r.stderr);
    const book = manifestOf(res).books[0];
    assert.ok(Array.isArray(book.chapters), 'manifest must include chapters');
    assert.deepEqual(book.chapters.map((c) => c.title),
      ['第一章 启程', 'Chapter 2 Return', '番外 一', '尾声']);
    let cursor = 0;
    for (const chapter of book.chapters) {
      const at = body.indexOf(Buffer.from(chapter.title, 'utf8'));
      assert.ok(at >= 0, 'test fixture heading must exist');
      assert.equal(chapter.offset, at,
        'chapter offset must be the real UTF-8 byte start');
      assert.ok(chapter.offset >= cursor, 'chapters must be ordered');
      assert.ok(body.subarray(chapter.offset).toString('utf8')
        .startsWith(chapter.title),
        'offset must land on the heading, not inside a UTF-8 sequence');
      cursor = chapter.offset + chapter.length;
    }
    const last = book.chapters[book.chapters.length - 1];
    assert.equal(last.offset + last.length, body.length,
      'chapters must cover the whole normalized file without losing bytes');
    for (let i = 1; i < book.chapters.length; i++) {
      assert.equal(book.chapters[i - 1].offset + book.chapters[i - 1].length,
        book.chapters[i].offset, 'chapter ranges must be contiguous');
    }

    const plain = Buffer.from('没有章节标题的连续正文。', 'utf8');
    writeFileSync(join(books, '无章.txt'), plain);
    const r2 = run(books, res);
    assert.equal(r2.status, 0, r2.stderr);
    const plainBook = manifestOf(res).books.find((b) => b.title === '无章');
    assert.deepEqual(plainBook.chapters,
      [{ title: '正文', offset: 0, length: plain.length }],
      'no reliable headings -> one continuous chapter');
    console.info('  [2b] 章节 UTF-8 偏移/连续区间/无章节回退 ✓');
  }

  // (3) 同内容重复文件 → 只保留稳定顺序里的第一份。
  {
    const { books, res } = tmp();
    const dup = Buffer.from('重复的内容\n', 'utf8');
    writeFileSync(join(books, 'a.txt'), dup);
    writeFileSync(join(books, 'b.txt'), dup);
    const r = run(books, res);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /跳过重复内容/);
    assert.equal(manifestOf(res).books.length, 1);
  }

  // (4) 同名不同书（.txt / .TXT）→ 标题自动加 " (2)" 区分。
  {
    const { books, res } = tmp();
    writeFileSync(join(books, '书.txt'), Buffer.from('第一本\n', 'utf8'));
    writeFileSync(join(books, '书.TXT'), Buffer.from('第二本不同内容\n', 'utf8'));
    const r = run(books, res);
    assert.equal(r.status, 0, r.stderr);
    const titles = manifestOf(res).books.map((b) => b.title);
    assert.deepEqual(titles.slice().sort(), ['书', '书 (2)'].sort());
  }

  // (5) 非法 UTF-8 → 显式失败（不在手表上猜编码）。
  {
    const { books, res } = tmp();
    writeFileSync(join(books, 'bad.txt'), Buffer.from([0x80, 0x81, 0x82]));
    const r = run(books, res);
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /不是有效 UTF-8/);
  }

  // (5b) 合法 GB18030（UTF-8 失败后的确定性回退）→ 构建期转成 UTF-8。
  {
    const { books, res } = tmp();
    // GBK/GB18030 的「你好」= C4 E3 BA C3，不是合法 UTF-8。
    writeFileSync(join(books, 'gb.txt'), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
    const r = run(books, res);
    assert.equal(r.status, 0, r.stderr);
    const expected = Buffer.from('你好', 'utf8');
    const book = manifestOf(res).books[0];
    assert.equal(book.bytes, expected.length);
    assert.equal(book.sha256, sha256hex(expected));
    assert.ok(readFileSync(join(res, book.file)).equals(expected));
  }

  // (6) 带 BOM 的 UTF-16LE 是无歧义的 → 构建期直接转成 UTF-8。
  {
    const { books, res } = tmp();
    const text = 'UTF16 中文内容';
    writeFileSync(join(books, 'u16.txt'),
      Buffer.concat([Buffer.from([0xff, 0xfe]),
        Buffer.from(text, 'utf16le')]));
    const r = run(books, res);
    assert.equal(r.status, 0, r.stderr);
    const expected = Buffer.from(text, 'utf8');
    const book = manifestOf(res).books[0];
    assert.equal(book.bytes, expected.length);
    assert.equal(book.sha256, sha256hex(expected));
    assert.ok(readFileSync(join(res, book.file)).equals(expected));
  }

  // (7) 超过 --max-bytes → 显式失败。
  {
    const { books, res } = tmp();
    writeFileSync(join(books, 'big.txt'), Buffer.alloc(64, 0x41));
    const r = run(books, res, ['--max-bytes', '16']);
    assert.equal(r.status, 6, r.stderr);
    assert.match(r.stderr, /超过上限/);
  }

  // (8) 每次运行都清空资源目录：上一次的旧书不得残留。
  {
    const { books, res } = tmp();
    mkdirSync(res, { recursive: true });
    writeFileSync(join(res, 'stale.txt'), 'old build leftover');
    writeFileSync(join(books, 'real.txt'), Buffer.from('真的书\n', 'utf8'));
    const r = run(books, res);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(res, 'stale.txt')),
      '本轮构建必须清掉上一次的临时资源');
    assert.equal(manifestOf(res).books.length, 1);
  }

  console.log('prepare_watch_books: OK (script behaviour only)');
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
