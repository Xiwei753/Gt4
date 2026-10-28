// SPDX-License-Identifier: GPL-3.0-only
package com.xiwei.suyue.wear

import com.xiwei.suyue.model.BookChapter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChapterChunksTest {
    private fun chapters(count: Int): List<BookChapter> {
        var offset = 0L
        return (1..count).map { index ->
            val title = "第${index}章 这是一个用于校验 4096 字节上限的中文章节标题"
            val length = title.toByteArray(Charsets.UTF_8).size.toLong() + 100L
            BookChapter(title, offset, length).also { offset += length }
        }
    }

    private fun assertWithinLimit(count: Int) {
        val messages = ChapterChunks.split(
            "t".repeat(32), "a".repeat(16), chapters(count)
        )
        assertTrue("large catalog must be split", messages.size > 1)
        messages.forEach { bytes ->
            assertTrue("message must stay within P2P limit: ${bytes.size}",
                bytes.size <= ChapterChunks.MAX_MESSAGE_BYTES)
        }
        val text = messages.joinToString("") { String(it, Charsets.UTF_8) }
        assertEquals(count, Regex("\"title\":").findAll(text).count())
    }

    @Test
    fun splitsOneHundredChaptersWithinMessageLimit() {
        assertWithinLimit(100)
    }

    @Test
    fun splitsFiveHundredChaptersWithinMessageLimit() {
        assertWithinLimit(500)
    }

    @Test(expected = ChapterTooLargeException::class)
    fun rejectsSingleChapterLargerThanMessageLimit() {
        val title = "超".repeat(1500)
        assertTrue(title.toByteArray(Charsets.UTF_8).size > ChapterChunks.MAX_MESSAGE_BYTES)
        ChapterChunks.split("tid", "a".repeat(16),
            listOf(BookChapter(title, 0, 100)))
    }

    @Test
    fun escapesQuotesAndNewlinesInTitles() {
        val messages = ChapterChunks.split("tid", "a".repeat(16), listOf(
            BookChapter("第1章 \"引号\"\n下一行", 0, 10)
        ))
        assertEquals(1, messages.size)
        val text = String(messages[0], Charsets.UTF_8)
        assertTrue(text.contains("\\\"引号\\\""))
        assertTrue(text.contains("\\n下一行"))
    }
}
