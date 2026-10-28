// SPDX-License-Identifier: GPL-3.0-only
// 章节索引分片：Wear Engine P2P 单条消息上限 4096 字节。
// 完整目录能放进 BOOK_META 时保持旧协议；放不下时 BOOK_META 发送空
// chapters + chapterChunks，再逐条发送 CHAPTERS，之后才传正文文件。
// 手工构造 JSON 以便 JVM 单测直接校验真实字节数，不依赖 Android org.json。
package com.xiwei.suyue.wear

import com.xiwei.suyue.model.BookChapter

class ChapterTooLargeException : IllegalArgumentException("E_CHAPTER_TOO_LARGE")

object ChapterChunks {
    const val MAX_MESSAGE_BYTES = 4096
    // 留出余量，避免不同 JSON 序列化器对字段顺序/转义的处理造成越界。
    private const val TARGET_CHAPTER_BYTES = 3600
    private const val TOTAL_HINT = 999999

    // 返回可以直接发给手表的 CHAPTERS 消息（UTF-8 JSON）。
    fun split(transferId: String, bookId: String,
              chapters: List<BookChapter>): List<ByteArray> {
        if (chapters.isEmpty()) return emptyList()
        val groups = mutableListOf<MutableList<BookChapter>>()
        var current = mutableListOf<BookChapter>()
        for (chapter in chapters) {
            current.add(chapter)
            val size = payload(transferId, bookId, 0, TOTAL_HINT, current)
                .toByteArray(Charsets.UTF_8).size
            if (size > TARGET_CHAPTER_BYTES && current.size > 1) {
                val last = current.removeAt(current.size - 1)
                groups.add(current)
                current = mutableListOf(last)
            }
        }
        if (current.isNotEmpty()) groups.add(current)
        val messages = groups.mapIndexed { index, group ->
            payload(transferId, bookId, index, groups.size, group)
                .toByteArray(Charsets.UTF_8)
        }
        // EPUB 导航标题可能异常长；单条仍超限时明确失败，不截断章节。
        if (messages.any { it.size > MAX_MESSAGE_BYTES }) {
            throw ChapterTooLargeException()
        }
        return messages
    }

    private fun payload(transferId: String, bookId: String,
                        index: Int, total: Int,
                        chapters: List<BookChapter>): String {
        val sb = StringBuilder(256)
        sb.append("{\"v\":0,\"type\":\"CHAPTERS\",\"transferId\":")
            .append(quote(transferId))
            .append(",\"bookId\":").append(quote(bookId))
            .append(",\"index\":").append(index)
            .append(",\"total\":").append(total)
            .append(",\"chapters\":[")
        chapters.forEachIndexed { i, chapter ->
            if (i > 0) sb.append(',')
            sb.append("{\"title\":").append(quote(chapter.title))
                .append(",\"offset\":").append(chapter.offset)
                .append(",\"length\":").append(chapter.length).append('}')
        }
        return sb.append("]}").toString()
    }

    private fun quote(value: String): String {
        val sb = StringBuilder(value.length + 2)
        sb.append('"')
        for (ch in value) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (ch.code < 0x20) {
                    sb.append(String.format("\\u%04x", ch.code))
                } else {
                    sb.append(ch)
                }
            }
        }
        return sb.append('"').toString()
    }
}
