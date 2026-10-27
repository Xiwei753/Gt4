// SPDX-License-Identifier: GPL-3.0-only
// issue #17：TXT 章节标题必须落在规范化 UTF-8 字节边界上。
package com.xiwei.suyue.importer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TxtImportServiceTest {

    private fun byteOffsetOf(text: String, title: String): Long =
        text.substring(0, text.indexOf(title))
            .toByteArray(Charsets.UTF_8).size.toLong()

    @Test
    fun detectsChineseEnglishAndExtraChapterByteOffsets() {
        val text = "版权页\n\n第一章 启程\n正文😀\n" +
            "Chapter 2 Return\nbody\n番外 一\n结局"
        val bytes = TxtImportService.utf8Bytes(text)
        val chapters = TxtImportService.detectChapters(text, bytes)

        assertEquals(listOf("第一章 启程", "Chapter 2 Return", "番外 一"),
            chapters.map { it.title })
        var cursor = 0L
        for (chapter in chapters) {
            assertEquals(byteOffsetOf(text, chapter.title), chapter.offset)
            assertEquals(chapter.title,
                bytes.copyOfRange(chapter.offset.toInt(),
                    (chapter.offset + chapter.title.toByteArray(Charsets.UTF_8).size)
                        .toInt()).toString(Charsets.UTF_8))
            assertTrue(chapter.offset >= cursor)
            cursor = chapter.offset + chapter.length
        }
        assertEquals(bytes.size.toLong(), cursor)
    }

    @Test
    fun doesNotMistakeParagraphForHeading() {
        val text = "第一章的小镇并不是章节标题，只是正文。\n" +
            "这一段也没有章节。".repeat(80)
        val bytes = TxtImportService.utf8Bytes(text)
        val chapters = TxtImportService.detectChapters(text, bytes)
        assertEquals(1, chapters.size)
        assertEquals("正文", chapters[0].title)
        assertEquals(0L, chapters[0].offset)
        assertEquals(bytes.size.toLong(), chapters[0].length)
    }

    @Test
    fun plainTextFallsBackToWholeBook() {
        val text = "没有章节标题的连续正文。"
        val bytes = TxtImportService.utf8Bytes(text)
        val chapters = TxtImportService.detectChapters(text, bytes)
        assertEquals(listOf("正文"), chapters.map { it.title })
        assertEquals(bytes.size.toLong(), chapters[0].length)
    }
}
