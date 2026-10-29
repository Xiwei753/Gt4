// SPDX-License-Identifier: GPL-3.0-only
// TXT 规范化：解码 → 统一 UTF-8 字节，并计算摘要工具。
// 与 harmony/.../model/TxtChapterDetect.js 的章节规则保持一致：
// 格式校验 → 形态校验 → 目录过滤 → 序号对齐。
package com.xiwei.suyue.importer

import com.xiwei.suyue.model.BookChapter
import java.security.MessageDigest

object TxtImportService {

    data class NormalizedTxt(val bytes: ByteArray, val encoding: String,
                             val text: String = "")

    private const val MAX_CHAPTER_TITLE_CHARS = 80
    private const val MAX_CHAPTER_LINE_CHARS = 80
    private const val TOC_RUN_MIN = 4

    private const val DIGITS = "0123456789０１２３４５６７８９"
    private const val CHINESE_DIGITS = "零〇○一二三四五六七八九两壹贰叁肆伍陆柒捌玖"
    private const val CHINESE_UNITS = "十拾百佰千仟万萬亿億"
    private const val NUMBER_CHARS = DIGITS + CHINESE_DIGITS + CHINESE_UNITS
    private const val CHAPTER_UNITS = "章节回集话幕"
    private const val VOLUME_UNITS = "卷部篇"
    private val SPECIAL_NAMES = listOf(
        "大结局", "完本感言", "作者的话", "序章", "序言", "序幕",
        "楔子", "引子", "前言", "后记", "尾声", "终章", "终篇", "后序",
        "番外篇", "番外", "外传"
    )
    private val BRACKET_PAIRS = listOf(
        "【" to "】", "[" to "]", "{" to "}", "（" to "）", "(" to ")",
        "《" to "》", "〈" to "〉", "「" to "」", "『" to "』",
        "“" to "”", "‘" to "’"
    )
    private const val LEADING_DECOR = "★☆◆◇●○◎■□▲△▼▽※#=~_—－-·"
    private const val OPEN_BRACKETS = "【[{(（《〈「『“‘"
    private const val CLOSE_BRACKETS = "】]})）〉》」』”’"
    private const val STRICT_SENTENCE_ENDINGS = "。；;…‥"
    private const val TRAILING_ONLY_ENDINGS = "！？!?"
    private const val FORBIDDEN_TITLE_PREFIX = "的着吧呢吗啊嘛哦呀"
    private const val PUNCTUATION_PREFIX = "，。、；：！？…‥—～·"
    private val SITE_HINTS = listOf(
        "www.", ".com", ".net", ".org", "小说", "文学", "书城", "阅读",
        "起点", "纵横", "17k", "百度", "贴吧", "全文", "txt"
    )

    private data class ParsedHeading(
        val title: String,
        val rawTitle: String,
        val kind: String,
        val number: Long,
        val numbered: Boolean
    )

    private data class Candidate(
        val title: String,
        val offset: Long,
        val lineIndex: Int,
        val kind: String,
        val number: Long,
        val numbered: Boolean
    )

    private data class LineInfo(val content: String, val start: Long,
                                val index: Int)

    fun utf8Bytes(text: String): ByteArray = text.toByteArray(Charsets.UTF_8)

    private fun codePointLength(text: String): Int =
        text.codePointCount(0, text.length)

    private fun stripOuterBrackets(text: String): String {
        var result = text
        var changed = true
        while (changed && result.length >= 2) {
            changed = false
            for ((left, right) in BRACKET_PAIRS) {
                if (result.startsWith(left) && result.endsWith(right)) {
                    result = result.substring(
                        left.length, result.length - right.length
                    ).trim()
                    changed = true
                    break
                }
            }
        }
        return result
    }

    private fun stripLeadingDecorations(text: String): String {
        var result = text
        var changed = true
        while (changed && result.isNotEmpty()) {
            changed = false
            val ch = result[0]
            if (ch == ' ' || ch == '\t' || ch == '\u3000' ||
                LEADING_DECOR.contains(ch)
            ) {
                result = result.substring(1).trim()
                changed = true
            }
        }
        return result
    }

    private fun stripTrailingDecorations(text: String): String {
        var result = text
        var changed = true
        while (changed && result.isNotEmpty()) {
            changed = false
            val ch = result[result.length - 1]
            if (ch == ' ' || ch == '\t' || ch == '\u3000' ||
                LEADING_DECOR.contains(ch)
            ) {
                result = result.substring(0, result.length - 1).trim()
                changed = true
            }
        }
        return result
    }

    private fun stripLooseBrackets(text: String): String {
        var result = text
        while (result.isNotEmpty() && OPEN_BRACKETS.contains(result[0])) {
            result = result.substring(1).trim()
        }
        while (result.isNotEmpty() &&
            CLOSE_BRACKETS.contains(result[result.length - 1])
        ) {
            result = result.substring(0, result.length - 1).trim()
        }
        return result
    }

    private fun stripTitleBrackets(text: String): String {
        var result = text
        while (result.isNotEmpty() && CLOSE_BRACKETS.contains(result[0])) {
            result = result.substring(1).trim()
        }
        while (result.isNotEmpty() &&
            OPEN_BRACKETS.contains(result[result.length - 1])
        ) {
            result = result.substring(0, result.length - 1).trim()
        }
        return result
    }

    private fun normalizeHeading(text: String): String =
        stripLooseBrackets(stripTrailingDecorations(
            stripLeadingDecorations(stripOuterBrackets(text.trim()))
        ))

    private fun isSpace(ch: Char): Boolean =
        ch == ' ' || ch == '\t' || ch == '\u3000'

    private fun isSeparator(ch: Char): Boolean =
        isSpace(ch) || ch == ':' || ch == '：' || ch == '.' ||
            ch == '．' || ch == '·' || ch == '-' || ch == '—' ||
            ch == '－' || ch == '_' || ch == '、'

    private fun digitValue(ch: Char): Int = when (ch) {
        '零', '〇', '○' -> 0
        '一', '壹' -> 1
        '二', '两', '贰' -> 2
        '三', '叁' -> 3
        '四', '肆' -> 4
        '五', '伍' -> 5
        '六', '陆' -> 6
        '七', '柒' -> 7
        '八', '捌' -> 8
        '九', '玖' -> 9
        else -> -1
    }

    private fun parseChineseNumber(raw: String): Long {
        if (raw.isEmpty()) return -1L
        if (raw.all { DIGITS.indexOf(it) >= 0 }) {
            val digits = StringBuilder()
            for (ch in raw) digits.append(DIGITS.indexOf(ch) % 10)
            return digits.toString().toLongOrNull() ?: -1L
        }

        var total = 0L
        var section = 0L
        var number = 0L
        var seen = false
        for (ch in raw) {
            val digit = digitValue(ch)
            if (digit >= 0) {
                number = digit.toLong()
                seen = true
                continue
            }
            val unit = CHINESE_UNITS.indexOf(ch)
            if (unit < 0) return -1L
            seen = true
            when {
                unit <= 1 -> {
                    if (number == 0L) number = 1L
                    section += number * 10L
                }
                unit <= 3 -> {
                    if (number == 0L) number = 1L
                    section += number * 100L
                }
                unit <= 5 -> {
                    if (number == 0L) number = 1L
                    section += number * 1000L
                }
                unit <= 7 -> {
                    if (number == 0L) number = 1L
                    section = (section + number) * 10000L
                    total += section
                    section = 0L
                }
                else -> {
                    if (number == 0L) number = 1L
                    section = (section + number) * 100000000L
                    total += section
                    section = 0L
                }
            }
            number = 0L
        }
        if (!seen) return -1L
        return total + section + number
    }

    private fun parseSpecialCore(core: String): ParsedHeading? {
        var best = ""
        for (name in SPECIAL_NAMES) {
            if (core.startsWith(name) && name.length > best.length) best = name
        }
        if (best.isEmpty()) return null
        val rest = core.substring(best.length)
        if (rest.isNotEmpty() && !isSpace(rest[0]) && !isSeparator(rest[0]) &&
            !NUMBER_CHARS.contains(rest[0]) &&
            best != "番外" && best != "番外篇" && best != "外传"
        ) {
            return null
        }
        var i = 0
        while (i < rest.length && isSpace(rest[i])) i++
        val digits = StringBuilder()
        while (i < rest.length && NUMBER_CHARS.contains(rest[i])) {
            digits.append(rest[i])
            i++
        }
        var number = 0L
        var numbered = false
        if (digits.isNotEmpty()) {
            number = parseChineseNumber(digits.toString())
            if (number < 0) return null
            numbered = true
        }
        while (i < rest.length && isSeparator(rest[i])) i++
        val title = stripTitleBrackets(rest.substring(i).trim())
        val display = (best + digits.toString() +
            (if (title.isNotEmpty()) " $title" else "")).trim()
        return ParsedHeading(display, title, "special", number, numbered)
    }

    private fun parseNumberedCore(core: String): ParsedHeading? {
        if (!core.startsWith("第")) return null
        var i = 1
        while (i < core.length && isSpace(core[i])) i++
        val start = i
        while (i < core.length && NUMBER_CHARS.contains(core[i])) i++
        if (i == start) return null
        val rawNumber = core.substring(start, i)
        while (i < core.length && isSpace(core[i])) i++
        if (i >= core.length) return null
        val unit = core[i]
        if (!CHAPTER_UNITS.contains(unit) && !VOLUME_UNITS.contains(unit)) {
            return null
        }
        i++
        while (i < core.length && isSeparator(core[i])) i++
        val title = stripTitleBrackets(core.substring(i).trim())
        val number = parseChineseNumber(rawNumber)
        if (number < 0) return null
        val display = ("第" + rawNumber + unit +
            (if (title.isNotEmpty()) " $title" else "")).trim()
        return ParsedHeading(
            display,
            title,
            if (VOLUME_UNITS.contains(unit)) "volume" else "chapter",
            number,
            true
        )
    }

    private fun parseEnglishCore(core: String): ParsedHeading? {
        val lower = core.lowercase()
        var special = ""
        if (lower.startsWith("prologue")) special = "Prologue"
        else if (lower.startsWith("epilogue")) special = "Epilogue"
        if (special.isNotEmpty()) {
            val rest = core.substring(special.length)
            if (rest.isNotEmpty() && !isSeparator(rest[0])) return null
            val title = stripTitleBrackets(rest.trimStart(
                ' ', '\t', '\u3000', ':', '：', '.', '．', '·',
                '-', '—', '－', '_'
            ).trim())
            val display = (special +
                (if (title.isNotEmpty()) " $title" else "")).trim()
            return ParsedHeading(display, title, "special", 0L, false)
        }
        if (!lower.startsWith("chapter")) return null
        var pos = 7
        if (pos >= core.length || !isSpace(core[pos])) return null
        while (pos < core.length && isSpace(core[pos])) pos++
        val numStart = pos
        while (pos < core.length && core[pos] in '0'..'9') pos++
        if (pos == numStart) {
            while (pos < core.length && "IVXLCDMivxlcdm".contains(core[pos])) pos++
        }
        if (pos == numStart) return null
        val rawNumber = core.substring(numStart, pos)
        while (pos < core.length && isSeparator(core[pos])) pos++
        val title = stripTitleBrackets(core.substring(pos).trim())
        val number = rawNumber.toLongOrNull() ?: 0L
        val display = ("Chapter " + rawNumber +
            (if (title.isNotEmpty()) " $title" else "")).trim()
        return ParsedHeading(display, title, "chapter", number, number > 0)
    }

    private fun parseHeadingCore(core: String): ParsedHeading? =
        parseNumberedCore(core) ?: parseEnglishCore(core) ?: parseSpecialCore(core)

    private fun looksLikeSitePrefix(prefix: String): Boolean {
        val text = prefix.trim()
        if (text.isEmpty() || codePointLength(text) > 30) return false
        if (STRICT_SENTENCE_ENDINGS.contains(text[text.length - 1])) return false
        val lower = text.lowercase()
        if (SITE_HINTS.any { lower.contains(it) }) return true
        val last = text[text.length - 1]
        return (last == ':' || last == '：' || last == ']' || last == '】' ||
            last == ')' || last == '）' || last == '|' || last == '/') &&
            codePointLength(text) <= 16
    }

    private fun parseHeading(line: String): ParsedHeading? {
        val trimmed = line.trim(' ', '\t', '\r', '\n', '\uFEFF')
        if (trimmed.isEmpty() ||
            codePointLength(trimmed) > MAX_CHAPTER_LINE_CHARS
        ) return null
        var normalized = normalizeHeading(trimmed)
        if (normalized.isEmpty() ||
            codePointLength(normalized) > MAX_CHAPTER_LINE_CHARS
        ) return null
        var parsed = parseHeadingCore(normalized)
        if (parsed == null) {
            for (i in 1 until minOf(normalized.length, 33)) {
                if (normalized[i] != '第' &&
                    normalized.substring(i, minOf(i + 7, normalized.length))
                        .lowercase() != "chapter"
                ) continue
                val prefix = normalized.substring(0, i)
                if (!looksLikeSitePrefix(prefix)) continue
                val tail = normalizeHeading(normalized.substring(i))
                val siteParsed = parseHeadingCore(tail)
                if (siteParsed != null) {
                    parsed = siteParsed
                    normalized = tail
                    break
                }
            }
        }
        if (parsed == null) return null
        if (parsed.rawTitle.isNotEmpty() &&
            codePointLength(parsed.rawTitle) > MAX_CHAPTER_TITLE_CHARS
        ) return null
        if (normalized.any { STRICT_SENTENCE_ENDINGS.contains(it) }) return null
        for (i in normalized.indices) {
            if (TRAILING_ONLY_ENDINGS.contains(normalized[i]) &&
                normalized.substring(i + 1).any {
                    it != '！' && it != '？' && it != '!' && it != '?' &&
                        !isSpace(it)
                }
            ) return null
        }
        val title = parsed.rawTitle
        if (title.isNotEmpty()) {
            if (FORBIDDEN_TITLE_PREFIX.contains(title[0])) return null
            if (PUNCTUATION_PREFIX.contains(title[0])) return null
            if (codePointLength(title) > 6 &&
                title.any { it == '，' || it == ',' || it == '、' ||
                    it == '；' || it == ';' }
            ) return null
        }
        return ParsedHeading(
            if (parsed.kind == "special") normalized else parsed.title,
            title, parsed.kind, parsed.number, parsed.numbered
        )
    }

    private fun isChapterHeading(line: String): Boolean = parseHeading(line) != null

    private fun splitLines(text: String): List<LineInfo> {
        val lines = ArrayList<LineInfo>()
        var start = 0
        var byteOffset = 0L
        var i = 0
        while (i <= text.length) {
            if (i < text.length && text[i] != '\n') {
                i++
                continue
            }
            val full = text.substring(start, if (i < text.length) i + 1 else i)
            if (full.isNotEmpty()) {
                var content = full
                if (content.endsWith("\n")) content = content.dropLast(1)
                if (content.endsWith("\r")) content = content.dropLast(1)
                lines.add(LineInfo(content, byteOffset, lines.size))
                byteOffset += utf8Bytes(full).size
            }
            start = i + 1
            if (i == text.length) break
            i++
        }
        return lines
    }

    private fun isBlank(line: LineInfo): Boolean =
        line.content.trim(' ', '\t', '\r', '\n', '\uFEFF').isEmpty()

    private fun isTocMarker(line: LineInfo): Boolean {
        val text = line.content.filterNot {
            it == ' ' || it == '\t' || it == '\r' || it == '\n' ||
                it == '\u3000' || it == ':' || it == '：'
        }.lowercase()
        return text in setOf(
            "目录", "章节目录", "章节列表", "目录章节", "正文目录",
            "作品目录", "contents", "tableofcontents", "toc"
        )
    }

    private fun contentLinesBetween(lines: List<LineInfo>, left: Int,
                                    right: Int): Int {
        var count = 0
        for (i in left + 1 until right) if (!isBlank(lines[i])) count++
        return count
    }

    private fun normalizeTitleForMatch(title: String): String {
        var text = title.lowercase().filterNot {
            it == ' ' || it == '\t' || it == '\r' || it == '\n' ||
                it == '\u3000' || it == '【' || it == '】' || it == '[' ||
                it == ']' || it == '{' || it == '}' || it == '（' ||
                it == '）' || it == '(' || it == ')' || it == '《' ||
                it == '》' || it == '〈' || it == '〉' || it == '「' ||
                it == '」' || it == '『' || it == '』' || it == '“' ||
                it == '”' || it == '‘' || it == '’'
        }
        text = text.trimEnd('.', '．', '·', '…', '‥', '-', '—', '－', '_')
        return text.trimEnd { it in '0'..'9' || it in '０'..'９' }
    }

    private fun dropToc(candidates: List<Candidate>,
                        lines: List<LineInfo>): List<Candidate> {
        if (candidates.size < 2) return candidates
        val dense = BooleanArray(candidates.size)
        for (k in 0 until candidates.size - 1) {
            dense[k] = contentLinesBetween(
                lines, candidates[k].lineIndex, candidates[k + 1].lineIndex
            ) == 0
        }
        val drop = BooleanArray(candidates.size)

        var i = 0
        while (i < candidates.size) {
            if (!dense[i]) {
                i++
                continue
            }
            var j = i
            while (j < candidates.size && dense[j]) j++
            if (j - i >= TOC_RUN_MIN) {
                for (k in i until j) drop[k] = true
            }
            i = j
        }

        var markerIndex = -1
        for (m in 0 until minOf(lines.size, 201)) {
            if (isTocMarker(lines[m])) {
                markerIndex = m
                break
            }
        }
        if (markerIndex >= 0) {
            var first = -1
            for (c in candidates.indices) {
                if (candidates[c].lineIndex > markerIndex) {
                    first = c
                    break
                }
            }
            if (first >= 0) {
                var end = first
                while (end < candidates.size && dense[end]) end++
                if (end - first >= 2 && end < candidates.size) {
                    val later = candidates.subList(end, candidates.size)
                        .map { normalizeTitleForMatch(it.title) }
                    var matched = 0
                    for (u in first until end) {
                        val key = normalizeTitleForMatch(candidates[u].title)
                        if (key.isNotEmpty() && later.contains(key)) matched++
                    }
                    if (matched >= 1) {
                        for (d in first until end) drop[d] = true
                    }
                }
            }
        }

        return candidates.filterIndexed { index, _ -> !drop[index] }
    }

    private fun alignSegment(segment: List<Candidate>): List<Candidate> {
        val n = segment.size
        if (n == 0) return segment
        val keep = BooleanArray(n)
        val numbered = ArrayList<Int>()
        for (i in 0 until n) {
            val candidate = segment[i]
            if (candidate.kind == "special" || candidate.kind == "volume" ||
                !candidate.numbered
            ) {
                keep[i] = true
            } else {
                numbered.add(i)
            }
        }
        val size = numbered.size
        if (size > 0) {
            val tails = LongArray(size)
            val tailPos = IntArray(size)
            val prev = IntArray(size) { -1 }
            var length = 0
            for (p in 0 until size) {
                val value = segment[numbered[p]].number
                var lo = 0
                var hi = length
                while (lo < hi) {
                    val mid = (lo + hi) / 2
                    if (tails[mid] < value) lo = mid + 1 else hi = mid
                }
                if (lo < length && tails[lo] == value) continue
                if (lo == length) length++
                tails[lo] = value
                tailPos[lo] = p
                prev[p] = if (lo > 0) tailPos[lo - 1] else -1
            }
            if (length > 0) {
                var back = tailPos[length - 1]
                while (back >= 0) {
                    keep[numbered[back]] = true
                    back = prev[back]
                }
            }
        }
        return segment.filterIndexed { index, _ -> keep[index] }
    }

    private fun alignByNumber(candidates: List<Candidate>): List<Candidate> {
        if (candidates.isEmpty()) return candidates
        val kept = ArrayList<Candidate>()
        var segmentStart = 0
        for (i in candidates.indices) {
            var starts = false
            if (i > segmentStart) {
                val candidate = candidates[i]
                if (candidate.kind == "volume") {
                    starts = true
                } else if (candidate.numbered && candidate.number == 1L) {
                    starts = true
                }
            }
            if (!starts) continue
            kept.addAll(alignSegment(candidates.subList(segmentStart, i)))
            kept.add(candidates[i])
            segmentStart = i + 1
        }
        kept.addAll(alignSegment(candidates.subList(segmentStart, candidates.size)))
        return kept
    }

    // 在规范化 UTF-8 字节上建立章节索引；不能用 Kotlin 字符下标当字节偏移。
    fun detectChapters(text: String, bytes: ByteArray): List<BookChapter> {
        val total = bytes.size.toLong()
        val lines = splitLines(text)
        val candidates = ArrayList<Candidate>()
        for (line in lines) {
            val parsed = parseHeading(line.content) ?: continue
            candidates.add(Candidate(
                parsed.title, line.start, line.index, parsed.kind,
                parsed.number, parsed.numbered
            ))
        }
        if (candidates.isEmpty()) {
            return listOf(BookChapter("正文", 0L, total))
        }
        val kept = alignByNumber(dropToc(candidates, lines))
        if (kept.isEmpty()) {
            return listOf(BookChapter("正文", 0L, total))
        }
        val ordered = kept.sortedBy { it.offset }
        val chapters = ArrayList<BookChapter>()
        for (index in ordered.indices) {
            val end = if (index + 1 < ordered.size) ordered[index + 1].offset
                else total
            if (end > ordered[index].offset && ordered[index].offset >= 0 &&
                end <= total
            ) {
                chapters.add(BookChapter(
                    ordered[index].title, ordered[index].offset,
                    end - ordered[index].offset
                ))
            }
        }
        return if (chapters.isNotEmpty()) chapters
            else listOf(BookChapter("正文", 0L, total))
    }

    fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        val sb = StringBuilder(digest.size * 2)
        for (b in digest) sb.append(String.format("%02x", b))
        return sb.toString()
    }

    // 解码失败返回 null（调用方明确提示，不静默替换）。
    fun normalize(bytes: ByteArray): NormalizedTxt? {
        val decoded = TextDecodeService.decodeToText(bytes) ?: return null
        return NormalizedTxt(utf8Bytes(decoded.text), decoded.encoding,
            decoded.text)
    }
}
