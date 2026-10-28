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
import re
import shutil
import sys

DEFAULT_MAX_BYTES = 8 * 1024 * 1024
MANIFEST_NAME = 'manifest.json'
MAX_CHAPTER_TITLE_CHARS = 80
MAX_CHAPTER_LINE_CHARS = 80
TOC_RUN_MIN = 4

DIGITS = '0123456789０１２３４５６７８９'
CHINESE_DIGITS = '零〇○一二三四五六七八九两壹贰叁肆伍陆柒捌玖'
CHINESE_UNITS = '十拾百佰千仟万萬亿億'
NUMBER_CHARS = DIGITS + CHINESE_DIGITS + CHINESE_UNITS
CHAPTER_UNITS = '章节回集话幕'
VOLUME_UNITS = '卷部篇'
SPECIAL_NAMES = (
    '大结局', '完本感言', '作者的话', '序章', '序言', '序幕',
    '楔子', '引子', '前言', '后记', '尾声', '终章', '终篇', '后序',
    '番外篇', '番外', '外传',
)
BRACKET_PAIRS = (
    ('【', '】'), ('[', ']'), ('{', '}'), ('（', '）'), ('(', ')'),
    ('《', '》'), ('〈', '〉'), ('「', '」'), ('『', '』'),
    ('“', '”'), ('‘', '’'),
)
LEADING_DECOR = '★☆◆◇●○◎■□▲△▼▽※#=~_—－-·'
OPEN_BRACKETS = '【[{(（《〈「『“‘'
CLOSE_BRACKETS = '】]})）〉》」』”’'
STRICT_SENTENCE_ENDINGS = '。；;…‥'
TRAILING_ONLY_ENDINGS = '！？!?'
FORBIDDEN_TITLE_PREFIX = '的着吧呢吗啊嘛哦呀'
PUNCTUATION_PREFIX = '，。、；：！？…‥—～·'
SITE_HINTS = ('www.', '.com', '.net', '.org', '小说', '文学', '书城',
              '阅读', '起点', '纵横', '17k', '百度', '贴吧', '全文', 'txt')

DIGIT_MAP = {
    '零': 0, '〇': 0, '○': 0, '一': 1, '二': 2, '三': 3, '四': 4,
    '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '两': 2,
    '壹': 1, '贰': 2, '叁': 3, '肆': 4, '伍': 5, '陆': 6,
    '柒': 7, '捌': 8, '玖': 9,
}

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


def _strip_outer_brackets(text):
    result = text
    changed = True
    while changed and len(result) >= 2:
        changed = False
        first = result[0]
        last = result[-1]
        for left, right in BRACKET_PAIRS:
            if first == left and last == right:
                result = result[1:-1].strip()
                changed = True
                break
    return result


def _strip_leading_decorations(text):
    result = text
    changed = True
    while changed and result:
        changed = False
        ch = result[0]
        if ch in ' \t\u3000' or ch in LEADING_DECOR:
            result = result[1:].strip()
            changed = True
    return result


def _strip_trailing_decorations(text):
    result = text
    changed = True
    while changed and result:
        changed = False
        ch = result[-1]
        if ch in ' \t\u3000' or ch in LEADING_DECOR:
            result = result[:-1].strip()
            changed = True
    return result


def _strip_loose_brackets(text):
    result = text
    while result and result[0] in OPEN_BRACKETS:
        result = result[1:].strip()
    while result and result[-1] in CLOSE_BRACKETS:
        result = result[:-1].strip()
    return result


def _strip_title_brackets(text):
    result = text
    while result and result[0] in CLOSE_BRACKETS:
        result = result[1:].strip()
    while result and result[-1] in OPEN_BRACKETS:
        result = result[:-1].strip()
    return result


def _normalize_heading(text):
    return _strip_loose_brackets(_strip_trailing_decorations(
        _strip_leading_decorations(_strip_outer_brackets(text.strip()))))


def _is_space(ch):
    return ch in ' \t\u3000'


def _is_separator(ch):
    return _is_space(ch) or ch in ':：.．·-—－_、'


def _parse_chinese_number(raw):
    if not raw:
        return -1
    if all(ch in DIGITS for ch in raw):
        digits = ''.join(str(DIGITS.index(ch) % 10) for ch in raw)
        try:
            return int(digits, 10)
        except ValueError:
            return -1

    total = 0
    section = 0
    number = 0
    seen = False
    for ch in raw:
        if ch in DIGIT_MAP:
            number = DIGIT_MAP[ch]
            seen = True
            continue
        if ch not in CHINESE_UNITS:
            return -1
        seen = True
        unit = CHINESE_UNITS.index(ch)
        if unit <= 1:
            if number == 0:
                number = 1
            section += number * 10
        elif unit <= 3:
            if number == 0:
                number = 1
            section += number * 100
        elif unit <= 5:
            if number == 0:
                number = 1
            section += number * 1000
        elif unit <= 7:
            if number == 0:
                number = 1
            section = (section + number) * 10000
            total += section
            section = 0
        else:
            if number == 0:
                number = 1
            section = (section + number) * 100000000
            total += section
            section = 0
        number = 0
    if not seen:
        return -1
    return total + section + number


def _parse_special_core(core):
    best = ''
    for name in SPECIAL_NAMES:
        if core.startswith(name) and len(name) > len(best):
            best = name
    if not best:
        return None
    rest = core[len(best):]
    if rest and not _is_space(rest[0]) and not _is_separator(rest[0]) \
            and rest[0] not in NUMBER_CHARS and best not in ('番外', '番外篇', '外传'):
        return None
    digits = ''
    i = 0
    while i < len(rest) and _is_space(rest[i]):
        i += 1
    while i < len(rest) and rest[i] in NUMBER_CHARS:
        digits += rest[i]
        i += 1
    number = 0
    numbered = False
    if digits:
        number = _parse_chinese_number(digits)
        if number < 0:
            return None
        numbered = True
    while i < len(rest) and _is_separator(rest[i]):
        i += 1
    title = _strip_title_brackets(rest[i:].strip())
    display = (best + (digits if digits else '') +
               (' ' + title if title else '')).strip()
    return {'title': display, 'rawTitle': title, 'kind': 'special',
            'number': number, 'numbered': numbered}


def _parse_numbered_core(core):
    if not core.startswith('第'):
        return None
    i = 1
    while i < len(core) and _is_space(core[i]):
        i += 1
    start = i
    while i < len(core) and core[i] in NUMBER_CHARS:
        i += 1
    if i == start:
        return None
    raw_number = core[start:i]
    while i < len(core) and _is_space(core[i]):
        i += 1
    if i >= len(core):
        return None
    unit = core[i]
    if unit not in CHAPTER_UNITS and unit not in VOLUME_UNITS:
        return None
    i += 1
    while i < len(core) and _is_separator(core[i]):
        i += 1
    title = _strip_title_brackets(core[i:].strip())
    number = _parse_chinese_number(raw_number)
    if number < 0:
        return None
    display = ('第' + raw_number + unit +
               (' ' + title if title else '')).strip()
    return {'title': display, 'rawTitle': title,
            'kind': 'volume' if unit in VOLUME_UNITS else 'chapter',
            'number': number, 'numbered': True}


def _parse_english_core(core):
    lower = core.lower()
    special = ''
    if lower.startswith('prologue'):
        special = 'Prologue'
    elif lower.startswith('epilogue'):
        special = 'Epilogue'
    if special:
        rest = core[len(special):]
        if rest and not _is_separator(rest[0]):
            return None
        title = _strip_title_brackets(
            rest.lstrip(' \t\u3000:：.．·-—－_').strip())
        return {'title': (special + (' ' + title if title else '')).strip(),
                'rawTitle': title, 'kind': 'special', 'number': 0, 'numbered': False}
    if not lower.startswith('chapter'):
        return None
    pos = 7
    if pos >= len(core) or not _is_space(core[pos]):
        return None
    while pos < len(core) and _is_space(core[pos]):
        pos += 1
    num_start = pos
    while pos < len(core) and core[pos] in '0123456789':
        pos += 1
    if pos == num_start:
        while pos < len(core) and core[pos] in 'IVXLCDMivxlcdm':
            pos += 1
    if pos == num_start:
        return None
    raw_number = core[num_start:pos]
    while pos < len(core) and _is_separator(core[pos]):
        pos += 1
    title = _strip_title_brackets(core[pos:].strip())
    number = int(raw_number) if raw_number.isdigit() else 0
    return {'title': ('Chapter ' + raw_number +
                      (' ' + title if title else '')).strip(),
            'rawTitle': title, 'kind': 'chapter', 'number': number,
            'numbered': number > 0}


def _parse_heading_core(core):
    return (_parse_numbered_core(core) or _parse_english_core(core) or
            _parse_special_core(core))


def _looks_like_site_prefix(prefix):
    text = prefix.strip()
    if not text or len(text) > 30:
        return False
    if text[-1] in STRICT_SENTENCE_ENDINGS:
        return False
    lower = text.lower()
    if any(hint in lower for hint in SITE_HINTS):
        return True
    return text[-1] in ':：]】)）|/' and len(text) <= 16


def _parse_heading(line):
    trimmed = line.strip(' \t\r\n\ufeff')
    if not trimmed or len(trimmed) > MAX_CHAPTER_LINE_CHARS:
        return None
    normalized = _normalize_heading(trimmed)
    if not normalized or len(normalized) > MAX_CHAPTER_LINE_CHARS:
        return None
    parsed = _parse_heading_core(normalized)
    if parsed is None:
        for i in range(1, min(len(normalized), 33)):
            if normalized[i] != '第' and normalized[i:i + 7].lower() != 'chapter':
                continue
            prefix = normalized[:i]
            if not _looks_like_site_prefix(prefix):
                continue
            tail = _normalize_heading(normalized[i:])
            site_parsed = _parse_heading_core(tail)
            if site_parsed:
                parsed = site_parsed
                normalized = tail
                break
    if parsed is None:
        return None
    raw_title = parsed.get('rawTitle', '')
    if raw_title and len(raw_title) > MAX_CHAPTER_TITLE_CHARS:
        return None
    if any(ch in STRICT_SENTENCE_ENDINGS for ch in normalized):
        return None
    for i, ch in enumerate(normalized):
        if ch in TRAILING_ONLY_ENDINGS and any(
                x not in '！？!? \t\u3000' for x in normalized[i + 1:]):
            return None
    title = raw_title
    if title:
        if title[0] in FORBIDDEN_TITLE_PREFIX:
            return None
        if title[0] in PUNCTUATION_PREFIX:
            return None
        if len(title) > 6 and any(ch in '，,、；;' for ch in title):
            return None
    # 特殊标题保留原行内空格（如“番外 一”），装饰/前缀已清理。
    if parsed.get('kind') == 'special':
        parsed['title'] = normalized
    return parsed


def is_chapter_heading(line):
    """兼容旧调用：判断一个物理行是否是可接受的章节标题。"""
    return _parse_heading(line) is not None


def _split_lines(text):
    lines = []
    start = 0
    byte_offset = 0
    i = 0
    while i <= len(text):
        if i < len(text) and text[i] != '\n':
            i += 1
            continue
        full = text[start:i + 1] if i < len(text) else text[start:i]
        if full:
            content = full
            if content.endswith('\n'):
                content = content[:-1]
            if content.endswith('\r'):
                content = content[:-1]
            lines.append({'content': content, 'start': byte_offset,
                          'index': len(lines)})
            byte_offset += len(full.encode('utf-8'))
        start = i + 1
        if i == len(text):
            break
        i += 1
    return lines


def _is_blank(line):
    return not line['content'].strip(' \t\r\n\ufeff')


def _is_toc_marker(line):
    text = ''.join(ch for ch in line['content'] if ch not in ' \t\r\n\u3000:：').lower()
    return text in ('目录', '章节目录', '章节列表', '目录章节', '正文目录',
                    '作品目录', 'contents', 'tableofcontents', 'toc')


def _content_lines_between(lines, left, right):
    return sum(1 for i in range(left + 1, right)
               if not _is_blank(lines[i]))


def _normalize_title_for_match(title):
    text = title.lower()
    text = ''.join(ch for ch in text if ch not in
                   ' \t\r\n\u3000【】[]{}（）()《》〈〉「」『』“”‘’')
    text = text.rstrip('.．·…‥-—－_')
    return text.rstrip('0123456789０１２３４５６７８９')


def _dense_flags(candidates, lines):
    dense = [False] * len(candidates)
    for k in range(len(candidates) - 1):
        dense[k] = _content_lines_between(
            lines, candidates[k]['lineIndex'], candidates[k + 1]['lineIndex']) == 0
    return dense


def _drop_toc(candidates, lines):
    if len(candidates) < 2:
        return candidates
    dense = _dense_flags(candidates, lines)
    drop = [False] * len(candidates)

    i = 0
    while i < len(candidates):
        if not dense[i]:
            i += 1
            continue
        j = i
        while j < len(candidates) and dense[j]:
            j += 1
        if j - i >= TOC_RUN_MIN:
            for k in range(i, j):
                drop[k] = True
        i = j

    marker_index = -1
    for m in range(min(len(lines), 201)):
        if _is_toc_marker(lines[m]):
            marker_index = m
            break
    if marker_index >= 0:
        first = -1
        for c, candidate in enumerate(candidates):
            if candidate['lineIndex'] > marker_index:
                first = c
                break
        if first >= 0:
            end = first
            while end < len(candidates) and dense[end]:
                end += 1
            if end - first >= 2 and end < len(candidates):
                later = [_normalize_title_for_match(c['title'])
                         for c in candidates[end:]]
                matched = 0
                for u in range(first, end):
                    key = _normalize_title_for_match(candidates[u]['title'])
                    if key and key in later:
                        matched += 1
                if matched >= 1:
                    for d in range(first, end):
                        drop[d] = True

    return [c for c, dropped in zip(candidates, drop) if not dropped]


def _align_segment(segment):
    n = len(segment)
    if n == 0:
        return []
    keep = [False] * n
    numbered = []
    for i, candidate in enumerate(segment):
        if candidate['kind'] in ('special', 'volume') or not candidate['numbered']:
            keep[i] = True
        else:
            numbered.append(i)
    size = len(numbered)
    if size:
        tails = []
        tail_pos = []
        prev = [-1] * size
        length = 0
        for p in range(size):
            value = segment[numbered[p]]['number']
            lo, hi = 0, length
            while lo < hi:
                mid = (lo + hi) // 2
                if tails[mid] < value:
                    lo = mid + 1
                else:
                    hi = mid
            if lo < length and tails[lo] == value:
                continue
            if lo == length:
                length += 1
                tails.append(value)
                tail_pos.append(p)
            else:
                tails[lo] = value
                tail_pos[lo] = p
            prev[p] = tail_pos[lo - 1] if lo > 0 else -1
        if length:
            back = tail_pos[length - 1]
            while back >= 0:
                keep[numbered[back]] = True
                back = prev[back]
    return [candidate for i, candidate in enumerate(segment) if keep[i]]


def _align_by_number(candidates):
    if not candidates:
        return candidates
    kept = []
    segment_start = 0
    for i, candidate in enumerate(candidates):
        starts = False
        if i > segment_start:
            if candidate['kind'] == 'volume':
                starts = True
            elif candidate['numbered'] and candidate['number'] == 1:
                starts = True
        if not starts:
            continue
        kept.extend(_align_segment(candidates[segment_start:i]))
        kept.append(candidate)
        segment_start = i + 1
    kept.extend(_align_segment(candidates[segment_start:]))
    return kept


def detect_chapters(data):
    """在规范化 UTF-8 字节上生成连续章节区间。

    每个区间从标题行首字节开始，到下一个标题行首/文件尾结束；这样
    章节跳转不会丢失标题或正文。识别不到可靠标题时整本作为「正文」，
    保持旧书可读。绝不修改正文本身。
    """
    total = len(data)
    text = data.decode('utf-8')
    lines = _split_lines(text)
    candidates = []
    for line in lines:
        parsed = _parse_heading(line['content'])
        if parsed is None:
            continue
        candidates.append({
            'title': parsed['title'],
            'offset': line['start'],
            'lineIndex': line['index'],
            'kind': parsed['kind'],
            'number': parsed['number'],
            'numbered': parsed['numbered'],
        })
    if not candidates:
        return [{'title': '正文', 'offset': 0, 'length': total}]
    kept = _align_by_number(_drop_toc(candidates, lines))
    if not kept:
        return [{'title': '正文', 'offset': 0, 'length': total}]
    kept.sort(key=lambda c: c['offset'])
    chapters = []
    for index, candidate in enumerate(kept):
        end = kept[index + 1]['offset'] if index + 1 < len(kept) else total
        if end > candidate['offset'] and candidate['offset'] >= 0 and end <= total:
            chapters.append({'title': candidate['title'],
                             'offset': candidate['offset'],
                             'length': end - candidate['offset']})
    return chapters or [{'title': '正文', 'offset': 0, 'length': total}]

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
            'chapters': detect_chapters(data),
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
            'chapters': e['chapters'],
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
