// SPDX-License-Identifier: GPL-3.0-only
// TXT 编码检测与严格解码单测（施工单 P1-8）。
// 真 UTF-8 / GBK / BOM / 非法字节都要覆盖：非法字节必须返回 null，不得静默替换为 U+FFFD。
package com.xiwei.suyue.importer

import java.nio.charset.Charset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TextDecodeServiceTest {

    private val cjk = "第一章　你好，世界。"

    @Test
    fun decodesPlainUtf8() {
        val bytes = cjk.toByteArray(Charsets.UTF_8)
        assertEquals("utf-8", TextDecodeService.detectEncoding(bytes))
        val decoded = TextDecodeService.decodeToText(bytes)
        assertNotNull(decoded)
        assertEquals(cjk, decoded!!.text)
        assertEquals("utf-8", decoded.encoding)
    }

    @Test
    fun decodesUtf8WithBom() {
        val bom = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())
        val bytes = bom + cjk.toByteArray(Charsets.UTF_8)
        assertEquals("utf-8", TextDecodeService.detectEncoding(bytes))
        val decoded = TextDecodeService.decodeToText(bytes)
        assertNotNull(decoded)
        assertEquals("BOM 不应残留", cjk, decoded!!.text)
    }

    @Test
    fun decodesGbk() {
        val gbk = Charset.forName("GBK")
        val bytes = cjk.toByteArray(gbk)
        // 这段中文的 GBK 字节不是合法 UTF-8，应走 GBK 候选。
        if (!TextDecodeService.isValidUtf8(bytes)) {
            assertEquals("gbk", TextDecodeService.detectEncoding(bytes))
        }
        val decoded = TextDecodeService.decodeToText(bytes)
        assertNotNull(decoded)
        assertEquals(cjk, decoded!!.text)
    }

    @Test
    fun decodesUtf16LeWithBom() {
        val bom = byteArrayOf(0xFF.toByte(), 0xFE.toByte())
        val bytes = bom + cjk.toByteArray(Charsets.UTF_16LE)
        assertEquals("utf-16le", TextDecodeService.detectEncoding(bytes))
        val decoded = TextDecodeService.decodeToText(bytes)
        assertNotNull(decoded)
        assertEquals(cjk, decoded!!.text)
    }

    @Test
    fun rejectsInvalidBytesInsteadOfSubstituting() {
        // 0xFF 不是合法 UTF-8，也不是合法 GBK/GB18030 首字节：必须失败。
        val bytes = byteArrayOf(0xFF.toByte())
        assertTrue(!TextDecodeService.isValidUtf8(bytes))
        assertNull("非法字节不得被静默替换为 U+FFFD", TextDecodeService.decodeToText(bytes))
    }

    @Test
    fun rejectsIncompleteGbkLeadByte() {
        // 单个 0x81 是 GBK 双字节首字节但没有续字节：严格解码应失败。
        val bytes = byteArrayOf(0x81.toByte())
        assertNull(TextDecodeService.decodeToText(bytes))
    }
}
