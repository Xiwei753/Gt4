// SPDX-License-Identifier: GPL-3.0-only
// TXT 编码检测与统一 UTF-8 输出。
// 规则（与 harmony/.../TextDecodeService.ets 对齐）：
//   1. UTF-8 BOM / UTF-16 BOM 优先识别；
//   2. 完整 UTF-8 校验通过则按 UTF-8 处理；
//   3. 否则按 GB18030/GBK 尝试解码；不支持或失败时明确报错，不静默替换。
// Android 侧 GBK/GB18030 由系统 Charset 提供（Android 真机可用）。
package com.xiwei.suyue.importer

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction

data class DecodedText(val text: String, val encoding: String)

object TextDecodeService {

    private val BOM_UTF8 = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())
    private val BOM_UTF16LE = byteArrayOf(0xFF.toByte(), 0xFE.toByte())
    private val BOM_UTF16BE = byteArrayOf(0xFE.toByte(), 0xFF.toByte())

    private fun hasBom(bytes: ByteArray, bom: ByteArray): Boolean {
        if (bytes.size < bom.size) return false
        for (i in bom.indices) if (bytes[i] != bom[i]) return false
        return true
    }

    // 标准 UTF-8 合法性校验：不允许超长编码、代理区、>U+10FFFF。
    fun isValidUtf8(bytes: ByteArray): Boolean {
        var i = 0
        while (i < bytes.size) {
            val b0 = bytes[i].toInt() and 0xFF
            if (b0 < 0x80) {
                i += 1
                continue
            }
            val width: Int
            val min: Int
            when {
                b0 in 0xC2..0xDF -> { width = 2; min = 0x80 }
                b0 in 0xE0..0xEF -> { width = 3; min = 0x800 }
                b0 in 0xF0..0xF4 -> { width = 4; min = 0x10000 }
                else -> return false
            }
            if (i + width > bytes.size) return false
            var code = b0 and (if (width == 2) 0x1F else if (width == 3) 0x0F else 0x07)
            for (j in 1 until width) {
                val b = bytes[i + j].toInt() and 0xFF
                if ((b and 0xC0) != 0x80) return false
                code = (code shl 6) or (b and 0x3F)
            }
            if (code < min || code > 0x10FFFF || (code in 0xD800..0xDFFF)) return false
            i += width
        }
        return true
    }

    fun detectEncoding(bytes: ByteArray): String {
        if (hasBom(bytes, BOM_UTF8)) return "utf-8"
        if (hasBom(bytes, BOM_UTF16LE)) return "utf-16le"
        if (hasBom(bytes, BOM_UTF16BE)) return "utf-16be"
        if (isValidUtf8(bytes)) return "utf-8"
        // 无 BOM 且非合法 UTF-8：按 GBK/GB18030 候选处理。
        return "gbk"
    }

    // 严格解码（P1-8）：遇到非法字节 / 不可映射字符直接失败并返回 null，
    // 不用 U+FFFD 静默替换。旧实现 `String(bytes, charset)` 会把坏字节
    // 悄悄替换成“�”，用户在书里看到乱码却得不到任何提示。
    private fun decodeStrict(bytes: ByteArray, charset: Charset): String? {
        val decoder = charset.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        return try {
            var text = decoder.decode(ByteBuffer.wrap(bytes)).toString()
            if (text.isNotEmpty() && text[0] == '\uFEFF') text = text.substring(1)
            text
        } catch (e: CharacterCodingException) {
            null
        }
    }

    private fun decodeGbk(bytes: ByteArray): String? {
        for (name in listOf("GB18030", "GBK", "GB2312")) {
            try {
                val cs = Charset.forName(name)
                val text = decodeStrict(bytes, cs)
                if (text != null) return text
            } catch (e: Exception) {
                // 继续尝试下一个候选。
            }
        }
        return null
    }

    // 统一输出文本。失败返回 null，调用方负责明确提示，不静默替换。
    fun decodeToText(bytes: ByteArray): DecodedText? {
        val encoding = detectEncoding(bytes)
        val text = when (encoding) {
            "utf-8" -> decodeStrict(bytes, Charsets.UTF_8)
            "utf-16le" -> decodeStrict(bytes, Charsets.UTF_16LE)
            "utf-16be" -> decodeStrict(bytes, Charsets.UTF_16BE)
            else -> decodeGbk(bytes)
        } ?: return null
        return DecodedText(text, encoding)
    }
}
