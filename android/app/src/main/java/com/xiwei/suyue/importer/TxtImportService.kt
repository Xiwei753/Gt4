// SPDX-License-Identifier: GPL-3.0-only
// TXT 规范化：解码 → 统一 UTF-8 字节，并计算摘要工具。
// 与 harmony/.../BookImportService.ets 的 TXT 分支及 sha256Hex 对齐。
package com.xiwei.suyue.importer

import com.xiwei.suyue.model.BookChapter
import java.security.MessageDigest

object TxtImportService {

    data class NormalizedTxt(val bytes: ByteArray, val encoding: String,
                             val text: String = "")

    private const val MAX_CHAPTER_TITLE_CHARS = 80
    private val CHAPTER_HEADING_PATTERNS = listOf(
        Regex("^第[0-9０-９零〇一二三四五六七八九十百千万两]+[章节回卷部篇](?=\\s|$|[：:、.．\\-—])"),
        Regex("^(?:序章|序言|楔子|引子|前言|尾声|后记|番外(?:篇)?|终章|大结局)(?=\\s|$|[：:、.．\\-—])"),
        Regex("^Chapter\\s+(?:\\d+|[IVXLCDM]+)\\b", RegexOption.IGNORE_CASE),
        Regex("^(?:Prologue|Epilogue)\\b", RegexOption.IGNORE_CASE)
    )

    fun utf8Bytes(text: String): ByteArray = text.toByteArray(Charsets.UTF_8)

    private fun isChapterHeading(line: String): Boolean {
        val title = line.trim()
        if (title.isEmpty() || title.length > MAX_CHAPTER_TITLE_CHARS) return false
        return CHAPTER_HEADING_PATTERNS.any { it.containsMatchIn(title) }
    }

    // 在规范化 UTF-8 字节上建立章节索引；不能用 Kotlin 字符下标当字节偏移。
    fun detectChapters(text: String, bytes: ByteArray): List<BookChapter> {
        val starts = ArrayList<Pair<String, Long>>()
        var byteOffset = 0L
        var lineStart = 0
        for (i in 0..text.length) {
            if (i < text.length && text[i] != '\n') continue
            val line = text.substring(lineStart, minOf(i + 1, text.length))
            if (isChapterHeading(line)) {
                starts.add(Pair(line.trim(), byteOffset))
            }
            byteOffset += utf8Bytes(line).size
            lineStart = i + 1
        }
        if (starts.isEmpty()) {
            return listOf(BookChapter("正文", 0L, bytes.size.toLong()))
        }
        val chapters = ArrayList<BookChapter>()
        for (i in starts.indices) {
            val end = if (i + 1 < starts.size) starts[i + 1].second
                else bytes.size.toLong()
            if (end > starts[i].second) {
                chapters.add(BookChapter(starts[i].first, starts[i].second,
                    end - starts[i].second))
            }
        }
        return if (chapters.isNotEmpty()) chapters
            else listOf(BookChapter("正文", 0L, bytes.size.toLong()))
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
