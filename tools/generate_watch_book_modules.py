#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""把本机私人 TXT 小说生成为 GT 4 Lite **JS 数据模块**（issue #10）。

背景（issue #10 实测结论）：
  · 官方 Lite 示例只使用 `internal://app/...` 私有目录，
    **没有**任何读 `internal://app/rawfile/...` 的通路；
  · Lite JS FA 是 webpack 逐页打包，页面里的静态 import 会被
    内联进该页 bundle；因此「把正文做成 JS 数据模块，页面按需取块」
    是 SDK 层面**确定可编译、可访问**的内置正文通路。

产物（写进 --out-dir，通常是
apps/watch/entry/src/main/js/MainAbility/books/）：
  · BookCatalog.g.js      —— 仅元数据（bookId/书名/字节数/块数），
                             **绝不含正文**；书架页只 import 它。
  · BookText_<id>.g.js    —— 每本一个，导出 getChunk(index)，
                             **块数据放在函数体内**，只有真正
                             调用时才在堆上materialize（按需取块）。
  · BookRegistry.g.js     —— 正文访问器：import 全部 BookText 模块，
                             导出 BOOKS / CHUNK_BYTES / getChunk(bookId,index)。
                             默认（未指定 WATCH_BOOKS_DIR）为空实现。
  · books_report.json     —— 供构建产物校验用的小报告（含每本
                             chunk0 的 base64 前缀，用来核对内层 BIN
                             真的带上了正文）。**不提交仓库**。

编码/规范化与 prepare_watch_books.py 完全一致（复用其函数）：
UTF-8（去 BOM）/ UTF-16(BOM) / GB18030 回退，bookId = sha256[:16]。

行为约定：
  · 只扫 --books-dir 顶层 *.txt，稳定顺序，不递归；
  · 同内容重复只留第一份；同名不同书加 " (n)" 后缀；
  · 单本超过 --max-bytes 显式失败；
  · --out-dir 会被**清空重建**（构建脚本负责备份/还原提交的默认文件）。
"""

import argparse
import base64
import hashlib
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prepare_watch_books as prep  # noqa: E402

DEFAULT_CHUNK_BYTES = 16 * 1024
REPORT_NAME = 'books_report.json'


def js_string(text):
    """生成安全的 JS 字符串字面量（单行、已转义）。"""
    return json.dumps(text, ensure_ascii=False)


def write_file(path, text):
    try:
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write(text)
    except OSError as exc:
        prep.fail('写文件失败 %s: %s' % (path, exc), prep.EXIT_WRITE)


def render_catalog(books):
    lines = [
        '// SPDX-License-Identifier: GPL-3.0-only',
        '// 构建期生成的内置书单（仅元数据，不含正文）：issue #10。',
        '// 由 tools/generate_watch_book_modules.py 生成；',
        '// 构建脚本用 trap 在构建结束后还原为提交的空默认值。',
        'export var BOOKS = [',
    ]
    for b in books:
        lines.append('  { bookId: %s, title: %s, bytes: %d, chunks: %d },'
                     % (js_string(b['bookId']), js_string(b['title']),
                        b['bytes'], b['chunks']))
    lines.append('];')
    lines.append('')
    return '\n'.join(lines)


def render_text_module(book):
    safe_name = 'BookText_' + book['bookId'] + '.g.js'
    lines = [
        '// SPDX-License-Identifier: GPL-3.0-only',
        '// 构建期生成的内置正文块：%s' % js_string(book['title']),
        '// 每块是原始规范化 UTF-8 字节的 base64，切块在**函数体内**返回，',
        '// 只有 getChunk(i) 被调用时才 materialize，避免静态 import 一次性',
        '// 载入整本小说（issue #10 内存要求）。',
        'var CHUNKS = {',
    ]
    for i, chunk in enumerate(book['chunks_b64']):
        lines.append('  %d: function () { return %s; },'
                     % (i, js_string(chunk)))
    lines.append('};')
    lines.append('export function getChunk(index) {')
    lines.append('  var fn = CHUNKS[index];')
    lines.append('  return fn ? fn() : null;')
    lines.append('}')
    lines.append('')
    return safe_name, '\n'.join(lines)


def render_registry(books):
    lines = [
        '// SPDX-License-Identifier: GPL-3.0-only',
        '// 构建期生成的内置正文访问器：默认空实现（无内置书）。',
        '// 阅读页 import 本模块；书架页只 import BookCatalog.g.js，',
        '// 从而让正文数据只进入阅读页 bundle（issue #10）。',
    ]
    for b in books:
        lines.append("import { getChunk as c_%s } from './BookText_%s.g.js';"
                     % (b['bookId'], b['bookId']))
    lines.append("import { BOOKS } from './BookCatalog.g.js';")
    lines.append('export { BOOKS };')
    lines.append('export var CHUNK_BYTES = %d;' % book_chunk_of(books))
    lines.append('export function getChunk(bookId, index) {')
    for b in books:
        lines.append("  if (bookId === %s) return c_%s(index);"
                     % (js_string(b['bookId']), b['bookId']))
    lines.append('  return null;')
    lines.append('}')
    lines.append('')
    return '\n'.join(lines)


# 全局块大小（本次构建统一）。
_CHUNK_BYTES = DEFAULT_CHUNK_BYTES


def book_chunk_of(books):
    return _CHUNK_BYTES


def main(argv):
    global _CHUNK_BYTES
    parser = argparse.ArgumentParser(
        description='Generate GT4 Lite JS data modules for local TXT novels.')
    parser.add_argument('--books-dir', required=True,
                        help='含私人 TXT 的本地目录（只扫顶层）')
    parser.add_argument('--out-dir', required=True,
                        help='写入 JS 模块的目录（会被清空重建）')
    parser.add_argument('--chunk-bytes', type=int,
                        default=DEFAULT_CHUNK_BYTES,
                        help='正文分块字节数（默认 %d）' % DEFAULT_CHUNK_BYTES)
    parser.add_argument('--max-bytes', type=int,
                        default=prep.DEFAULT_MAX_BYTES,
                        help='单本字节上限（默认 %d）' % prep.DEFAULT_MAX_BYTES)
    args = parser.parse_args(argv)

    if args.chunk_bytes < 256:
        prep.fail('--chunk-bytes 太小（至少 256）', prep.EXIT_USAGE)
    _CHUNK_BYTES = args.chunk_bytes

    books_dir = args.books_dir
    if not os.path.isdir(books_dir):
        prep.fail('--books-dir 不存在或不是目录：%s' % books_dir,
                  prep.EXIT_NO_DIR)

    names = [n for n in os.listdir(books_dir)
             if os.path.isfile(os.path.join(books_dir, n))
             and n.lower().endswith('.txt')]
    names.sort(key=lambda n: (n.lower(), n))
    if not names:
        prep.fail('--books-dir 里没有可用的 .txt 文件：%s' % books_dir,
                  prep.EXIT_NO_FILES)

    out_dir = args.out_dir
    try:
        if os.path.isdir(out_dir):
            shutil.rmtree(out_dir)
        os.makedirs(out_dir)
    except OSError as exc:
        prep.fail('准备输出目录失败 %s: %s' % (out_dir, exc), prep.EXIT_WRITE)

    entries = []
    seen_ids = {}
    for name in names:
        path = os.path.join(books_dir, name)
        title = prep.title_from_name(name)
        if not title:
            prep.fail('文件名无法得到书名：%s' % path, prep.EXIT_BAD_TITLE)
        data, source = prep.decode_book(path)
        if len(data) > args.max_bytes:
            prep.fail('单本超过上限 %d 字节（%s 为 %d 字节）'
                      % (args.max_bytes, path, len(data)), prep.EXIT_TOO_BIG)
        digest = hashlib.sha256(data).hexdigest()
        book_id = digest[:16]
        if book_id in seen_ids:
            sys.stderr.write(
                'WARN: 跳过重复内容 %s（与 %s 同书 %s）\n'
                % (path, seen_ids[book_id], book_id))
            continue
        seen_ids[book_id] = path
        entries.append({
            'bookId': book_id,
            'title': title,
            'bytes': len(data),
            'sha256': digest,
            'sourceName': name,
            'sourceEncoding': source,
            '_data': data,
        })

    if not entries:
        prep.fail('所有 .txt 都因重复被跳过，没有可用书籍', prep.EXIT_NO_FILES)

    titles = prep.unique_titles([e['title'] for e in entries])
    for entry, title in zip(entries, titles):
        entry['title'] = title

    chunk_bytes = args.chunk_bytes
    report_books = []
    for entry in entries:
        data = entry['_data']
        chunks_b64 = []
        offset = 0
        while offset < len(data):
            piece = data[offset:offset + chunk_bytes]
            chunks_b64.append(base64.b64encode(piece).decode('ascii'))
            offset += chunk_bytes
        if not chunks_b64:
            chunks_b64.append('')  # 空书（理论不可达，max/空文本）
        entry['chunks_b64'] = chunks_b64
        entry['chunks'] = len(chunks_b64)
        name_out, module = render_text_module(entry)
        write_file(os.path.join(out_dir, name_out), module)
        report_books.append({
            'bookId': entry['bookId'],
            'title': entry['title'],
            'bytes': entry['bytes'],
            'chunks': entry['chunks'],
            'sha256': entry['sha256'],
            'chunkBytes': chunk_bytes,
            'chunk0Prefix': chunks_b64[0][:160],
        })

    write_file(os.path.join(out_dir, 'BookCatalog.g.js'),
               render_catalog(entries))
    write_file(os.path.join(out_dir, 'BookRegistry.g.js'),
               render_registry(entries))
    report = {
        'schema': 1,
        'generator': 'tools/generate_watch_book_modules.py',
        'chunkBytes': chunk_bytes,
        'books': report_books,
    }
    report_path = os.path.join(out_dir, REPORT_NAME)
    write_file(report_path, json.dumps(report, ensure_ascii=False,
                                       indent=2) + '\n')

    total = 0
    for b in report_books:
        total += b['bytes']
        print('WATCH_BOOKS_ADDED title=%s bytes=%d id=%s chunks=%d'
              % (b['title'], b['bytes'], b['bookId'], b['chunks']))
    print('WATCH_BOOKS_TOTAL count=%d bytes=%d chunk_bytes=%d'
          % (len(report_books), total, chunk_bytes))
    # 诚实提示：Node(V8) 实测「静态 import 数据模块」会保留模块源文本，
    # 堆占用约等于 2× 源大小；JerryScript 快照的字面量驻留在镜像里、
    # 是否入堆只能在真机测。总正文过大时给出显式告警。
    if total > 2 * 1024 * 1024:
        sys.stderr.write(
            'WARN: 内置正文合计 %d 字节（>2MiB）。V8 实测静态 import 会保留'
            '模块源，JerryScript 堆占用需真机确认；建议先用小书/单本做真机'
            '验证，再决定是否一次内置多本大书。\n' % total)
    print('WATCH_BOOKS_CATALOG=%s'
          % os.path.abspath(os.path.join(out_dir, 'BookCatalog.g.js')))
    print('WATCH_BOOKS_REPORT=%s' % os.path.abspath(report_path))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main(sys.argv[1:]))
    except BrokenPipeError:
        raise SystemExit(prep.EXIT_WRITE)
