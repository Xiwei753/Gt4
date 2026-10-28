#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""把本机私人 TXT 小说规范化为 GT 4 Lite 构建资源，并生成**极小书单**（issue #10 复核后）。

方向修正（issue #10 复核意见）：
  · 不再把小说正文编译成 JS 数据模块 —— 那会把整本正文并进阅读页 bundle，
    巨型的 `reader.js` 与 GT4 安装失败（错误 34）时间上高度相关，且“静态
    import 是否按需取材”在 JerryScript 上无法在地面证明。
  · 改为把**规范化后的真实 UTF-8 字节**放进临时构建资源
    `entry/src/main/resources/rawfile/gt4books/<bookId>.txt`
    （hvigor 会真正把它打进内层 entry.bin），页面只带一份
    **仅含元数据**的 `BookCatalog.g.js`（bookId / 书名 / 字节数 / 资源文件名），
    **绝不含正文**。这样书架与阅读页 JS 都保持很小。
  · 正文怎么读由设备侧 `storage/BundledBookSource.js` 按需尝试
    （rawfile 窗口读 / 先 copy 到私有目录再窗口读），读不到就如实报错。

产物：
  · --resource-dir/<bookId>.txt    规范化 UTF-8 真实字节（会被清空重建）
  · --resource-dir/manifest.json   每本元数据（供构建/校验）
  · --catalog-dir/BookCatalog.g.js 仅元数据的 JS 书单
  · 报告 books_report.json 写到 --resource-dir（含每本前若干字节的
    base64 前缀，供 tests/build_artifact_check.sh 核对内层 BIN 真带正文）

编码/规范化规则与 tools/prepare_watch_books.py 完全一致（复用其函数）：
UTF-8（去 BOM）/ UTF-16(BOM) / GB18030 回退；bookId = sha256(规范化字节)[:16]；
同内容重复只留稳定顺序第一份；同名不同书加 " (n)" 后缀；单本超过
--max-bytes 显式失败。**绝不打印/提交正文**。
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

REPORT_NAME = 'books_report.json'
CATALOG_NAME = 'BookCatalog.g.js'
# 报告里记录的正文前缀字节数（用于产物校验，不泄漏成段正文）。
PROBE_BYTES = 64


def js_string(text):
    """生成安全的 JS 字符串字面量（单行、已转义）。"""
    return json.dumps(text, ensure_ascii=False)


def write_text(path, text):
    try:
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write(text)
    except OSError as exc:
        prep.fail('写文件失败 %s: %s' % (path, exc), prep.EXIT_WRITE)


def write_bytes(path, data):
    try:
        with open(path, 'wb') as handle:
            handle.write(data)
    except OSError as exc:
        prep.fail('写资源失败 %s: %s' % (path, exc), prep.EXIT_WRITE)


def render_catalog(books):
    """仅元数据的 JS 书单：bookId / 书名 / 字节数 / 资源文件名 / 章节索引。"""
    lines = [
        '// SPDX-License-Identifier: GPL-3.0-only',
        '// 构建期生成的内置书单（**仅元数据，绝不含正文**）：issue #10。',
        '// 正文在 entry/src/main/resources/rawfile/gt4books/ 里，',
        '// 由设备侧 storage/BundledBookSource.js 按需读取。',
        '// 由 tools/generate_watch_book_modules.py 生成；构建脚本用 trap',
        '// 在构建结束后还原为提交的空默认值。',
        'export var BOOKS = [',
    ]
    for b in books:
        lines.append(
            '  { bookId: %s, title: %s, bytes: %d, file: %s, sha256: %s, chapters: %s },'
            % (js_string(b['bookId']), js_string(b['title']), b['bytes'],
               js_string(b['file']), js_string(b['sha256']),
               json.dumps(b['chapters'], ensure_ascii=False,
                          separators=(',', ':'))))
    lines.append('];')
    lines.append('')
    return '\n'.join(lines)


def main(argv):
    parser = argparse.ArgumentParser(
        description='Stage local TXT novels as GT4 Lite rawfile resources '
                    'and emit a metadata-only JS catalog.')
    parser.add_argument('--books-dir', required=True,
                        help='含私人 TXT 的本地目录（只扫顶层）')
    parser.add_argument('--resource-dir', required=True,
                        help='rawfile 资源目录（会被清空重建）')
    parser.add_argument('--catalog-dir', required=True,
                        help='写入 BookCatalog.g.js 的目录（会被清空重建）')
    parser.add_argument('--max-bytes', type=int,
                        default=prep.DEFAULT_MAX_BYTES,
                        help='单本字节上限（默认 %d）' % prep.DEFAULT_MAX_BYTES)
    args = parser.parse_args(argv)

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

    for target in (args.resource_dir, args.catalog_dir):
        try:
            if os.path.isdir(target):
                shutil.rmtree(target)
            os.makedirs(target)
        except OSError as exc:
            prep.fail('准备目录失败 %s: %s' % (target, exc), prep.EXIT_WRITE)

    entries = []
    seen_ids = {}
    for name in names:
        path = os.path.join(books_dir, name)
        title = prep.title_from_name(name)
        if not title:
            prep.fail('文件名无法得到书名（去掉 .txt 后为空）：%s' % path,
                      prep.EXIT_BAD_TITLE)
        data, source = prep.decode_book(path)
        if len(data) > args.max_bytes:
            prep.fail('单本超过上限 %d 字节（%s 为 %d 字节）'
                      % (args.max_bytes, path, len(data)), prep.EXIT_TOO_BIG)
        digest = hashlib.sha256(data).hexdigest()
        book_id = digest[:16]
        if book_id in seen_ids:
            sys.stderr.write('WARN: 跳过重复内容 %s（与 %s 同书 %s）\n'
                             % (path, seen_ids[book_id], book_id))
            continue
        seen_ids[book_id] = path
        entries.append({
            'bookId': book_id,
            'title': title,
            'file': book_id + '.txt',
            'bytes': len(data),
            'sha256': digest,
            'encoding': 'utf-8',
            'chapters': prep.detect_chapters(data),
            'sourceName': name,
            'sourceEncoding': source,
            '_data': data,
        })

    if not entries:
        prep.fail('所有 .txt 都因重复被跳过，没有可用书籍', prep.EXIT_NO_FILES)

    titles = prep.unique_titles([e['title'] for e in entries])
    for entry, title in zip(entries, titles):
        entry['title'] = title

    report_books = []
    for entry in entries:
        data = entry['_data']
        write_bytes(os.path.join(args.resource_dir, entry['file']), data)
        report_books.append({
            'bookId': entry['bookId'],
            'title': entry['title'],
            'file': entry['file'],
            'bytes': entry['bytes'],
            'sha256': entry['sha256'],
            'chapters': entry['chapters'],
            # 仅前 64 字节（base64），供构建产物校验，不泄漏成段正文。
            'probeB64': base64.b64encode(data[:PROBE_BYTES]).decode('ascii'),
        })

    manifest = {
        'schema': 1,
        'generator': 'tools/generate_watch_book_modules.py',
        'encoding': 'utf-8',
        'resourceDir': 'rawfile/gt4books',
        'books': [{
            'bookId': e['bookId'],
            'title': e['title'],
            'file': e['file'],
            'bytes': e['bytes'],
            'sha256': e['sha256'],
            'encoding': e['encoding'],
            'chapters': e['chapters'],
        } for e in entries],
    }
    write_text(os.path.join(args.resource_dir, 'manifest.json'),
               json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')

    write_text(os.path.join(args.catalog_dir, CATALOG_NAME),
               render_catalog(entries))

    report_path = os.path.join(args.resource_dir, REPORT_NAME)
    write_text(report_path, json.dumps({
        'schema': 1,
        'generator': 'tools/generate_watch_book_modules.py',
        'mode': 'rawfile',
        'resourceDir': 'rawfile/gt4books',
        'books': report_books,
    }, ensure_ascii=False, indent=2) + '\n')

    total = 0
    for b in report_books:
        total += b['bytes']
        print('WATCH_BOOKS_ADDED title=%s bytes=%d id=%s file=%s'
              % (b['title'], b['bytes'], b['bookId'], b['file']))
    print('WATCH_BOOKS_TOTAL count=%d bytes=%d' % (len(report_books), total))
    print('WATCH_BOOKS_CATALOG=%s'
          % os.path.abspath(os.path.join(args.catalog_dir, CATALOG_NAME)))
    print('WATCH_BOOKS_REPORT=%s' % os.path.abspath(report_path))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main(sys.argv[1:]))
    except BrokenPipeError:
        raise SystemExit(prep.EXIT_WRITE)
