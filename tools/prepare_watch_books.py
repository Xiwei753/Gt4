#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""把本机私人 TXT 小说规范化为 GT 4 Lite 构建资源（issue #7）。

构建期一次性工作（**不在手表上做编码猜测**）：

  1. 只扫描 --books-dir 的**顶层** *.txt（不递归、不看别处）；
  2. 逐个读入、去掉 UTF-8 BOM、严格按 UTF-8 解码
     （带 BOM 的 UTF-16LE/BE 是**无歧义**的，构建期直接转成 UTF-8）；
     UTF-8 失败时**确定性回退 GB18030**（中文小说常见 GBK/GB2312 的超集）
     后转成 UTF-8；两者都失败才**显式失败**，绝不猜；
  3. 生成与现有书库兼容的 bookId =
     sha256(规范化 UTF-8 字节) 的前 16 位小写十六进制，
     与手机端 BookImportService 的口径一致（对规范化字节算摘要）；
  4. 把规范化后的真实字节写进 --resource-dir，
     并写 manifest.json 描述每本书；
  5. 打印「书名 + 字节数」清单（**绝不打印正文**）。

明确的行为约定：
  - 同内容重复文件（bookId 相同）：只保留稳定顺序里的第一份，其余跳过并提示；
  - 同名不同书（标题相同、内容不同）：标题自动加 " (2)"、" (3)" 后缀区分；
  - 单本超过 --max-bytes：显式失败。

失败即非零退出、不产出「看着成功其实缺书」的包。
"""

import argparse
import hashlib
import json
import os
import shutil
import sys

DEFAULT_MAX_BYTES = 8 * 1024 * 1024
MANIFEST_NAME = 'manifest.json'

EXIT_USAGE = 2
EXIT_NO_DIR = 3
EXIT_NO_FILES = 4
EXIT_ENCODING = 5
EXIT_TOO_BIG = 6
EXIT_BAD_TITLE = 7
EXIT_WRITE = 8


def fail(message, code):
    sys.stderr.write('ERROR: ' + message + '\n')
    raise SystemExit(code)


def decode_book(path):
    """返回 (规范化 UTF-8 字节, 说明用的源编码)。失败显式抛出。"""
    try:
        with open(path, 'rb') as handle:
            raw = handle.read()
    except OSError as exc:
        fail('读取失败 %s: %s' % (path, exc), EXIT_WRITE)

    if raw.startswith(b'\xef\xbb\xbf'):
        body = raw[3:]
        source = 'utf-8 (bom stripped)'
    elif raw.startswith(b'\xff\xfe'):
        body = raw[2:]
        source = 'utf-16le (converted)'
    elif raw.startswith(b'\xfe\xff'):
        body = raw[2:]
        source = 'utf-16be (converted)'
    else:
        source = 'utf-8'
        body = raw

    if source.startswith('utf-16le'):
        try:
            text = body.decode('utf-16-le')
        except UnicodeDecodeError as exc:
            fail('%s 不是有效的 UTF-16LE：%s' % (path, exc),
                 EXIT_ENCODING)
    elif source.startswith('utf-16be'):
        try:
            text = body.decode('utf-16-be')
        except UnicodeDecodeError as exc:
            fail('%s 不是有效的 UTF-16BE：%s' % (path, exc),
                 EXIT_ENCODING)
    else:
        try:
            text = body.decode('utf-8')
        except UnicodeDecodeError:
            # 构建侧确定性回退：中文小说常见 GBK/GB2312，统一按
            # GB18030（其超集，标准、可复现）解码，再不行才显式失败。
            # 手表端永远只读规范化后的 UTF-8。
            try:
                text = body.decode('gb18030')
                source = 'gb18030 (converted)'
            except UnicodeDecodeError as exc:
                fail('%s 既不是有效 UTF-8 也不是有效 GB18030（%s）。'
                     '请在构建前自行转成 UTF-8；手表端不会猜编码。'
                     % (path, exc), EXIT_ENCODING)

    # 与手机端一致：摘要对「去掉 BOM 后的规范化 UTF-8 字节」计算。
    return text.encode('utf-8'), source


def title_from_name(name):
    stem = name[:-4] if name.lower().endswith('.txt') else name
    stem = stem.strip()
    return stem.replace('\n', ' ').replace('\r', ' ')


def unique_titles(titles):
    """同名不同书：第二次起加 " (n)" 后缀，保持稳定顺序。"""
    seen = {}
    out = []
    for title in titles:
        if title not in seen:
            seen[title] = 1
            out.append(title)
            continue
        seen[title] += 1
        candidate = title + ' (' + str(seen[title]) + ')'
        while candidate in seen:
            seen[title] += 1
            candidate = title + ' (' + str(seen[title]) + ')'
        seen[candidate] = 1
        out.append(candidate)
    return out


def main(argv):
    parser = argparse.ArgumentParser(
        description='Stage local TXT novels as a GT4 Lite build resource.')
    parser.add_argument('--books-dir', required=True,
                        help='含私人 TXT 的本地目录（只扫顶层）')
    parser.add_argument('--resource-dir', required=True,
                        help='写入的构建资源目录（会被清空重建）')
    parser.add_argument('--max-bytes', type=int,
                        default=DEFAULT_MAX_BYTES,
                        help='单本字节上限（默认 %d）' % DEFAULT_MAX_BYTES)
    args = parser.parse_args(argv)

    books_dir = args.books_dir
    if not os.path.isdir(books_dir):
        fail('--books-dir 不存在或不是目录：%s' % books_dir, EXIT_NO_DIR)

    names = [n for n in os.listdir(books_dir)
             if os.path.isfile(os.path.join(books_dir, n))
             and n.lower().endswith('.txt')]
    # 稳定顺序：先按小写名，再按原名（不递归）。
    names.sort(key=lambda n: (n.lower(), n))
    if not names:
        fail('--books-dir 里没有可用的 .txt 文件：%s' % books_dir,
             EXIT_NO_FILES)

    resource_dir = args.resource_dir
    try:
        if os.path.isdir(resource_dir):
            # 清掉上一次的临时资源，避免旧书残留污染本次构建。
            shutil.rmtree(resource_dir)
        os.makedirs(resource_dir)
    except OSError as exc:
        fail('准备资源目录失败 %s: %s' % (resource_dir, exc), EXIT_WRITE)

    entries = []
    seen_ids = {}
    for name in names:
        path = os.path.join(books_dir, name)
        title = title_from_name(name)
        if not title:
            fail('文件名无法得到书名（去掉 .txt 后为空）：%s' % path,
                 EXIT_BAD_TITLE)
        data, source = decode_book(path)
        if len(data) > args.max_bytes:
            fail('单本超过上限 %d 字节（%s 为 %d 字节）'
                 % (args.max_bytes, path, len(data)), EXIT_TOO_BIG)
        digest = hashlib.sha256(data).hexdigest()
        book_id = digest[:16]
        if book_id in seen_ids:
            # 同内容重复：稳定顺序里的第一份胜出。
            sys.stderr.write(
                'WARN: 跳过重复内容 %s（与 %s 同书 %s）\n'
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
            'sourceName': name,
            'sourceEncoding': source,
            '_data': data,
        })

    if not entries:
        fail('所有 .txt 都因重复被跳过，没有可用书籍', EXIT_NO_FILES)

    titles = unique_titles([e['title'] for e in entries])
    for entry, title in zip(entries, titles):
        entry['title'] = title

    for entry in entries:
        out_path = os.path.join(resource_dir, entry['file'])
        try:
            with open(out_path, 'wb') as handle:
                handle.write(entry['_data'])
        except OSError as exc:
            fail('写资源失败 %s: %s' % (out_path, exc), EXIT_WRITE)

    manifest = {
        'schema': 1,
        'generator': 'tools/prepare_watch_books.py',
        'encoding': 'utf-8',
        'books': [{
            'bookId': e['bookId'],
            'title': e['title'],
            'file': e['file'],
            'bytes': e['bytes'],
            'sha256': e['sha256'],
            'encoding': e['encoding'],
        } for e in entries],
    }
    manifest_path = os.path.join(resource_dir, MANIFEST_NAME)
    try:
        with open(manifest_path, 'w', encoding='utf-8') as handle:
            json.dump(manifest, handle, ensure_ascii=False, indent=2)
            handle.write('\n')
    except OSError as exc:
        fail('写 manifest 失败 %s: %s' % (manifest_path, exc), EXIT_WRITE)

    total = 0
    for entry in entries:
        total += entry['bytes']
        # 只打印书名与字节数，绝不打印正文。
        print('WATCH_BOOKS_ADDED title=%s bytes=%d id=%s src=%s'
              % (entry['title'], entry['bytes'], entry['bookId'],
                 entry['sourceEncoding']))
    print('WATCH_BOOKS_TOTAL count=%d bytes=%d' % (len(entries), total))
    print('WATCH_BOOKS_MANIFEST=%s' % os.path.abspath(manifest_path))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main(sys.argv[1:]))
    except BrokenPipeError:
        raise SystemExit(EXIT_WRITE)
