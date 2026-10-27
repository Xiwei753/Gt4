// SPDX-License-Identifier: GPL-3.0-only
// TXT 规范化：解码 → 统一 UTF-8 字节，并计算摘要工具。
// 与 harmony/.../BookImportService.ets 的 TXT 分支及 sha256Hex 对齐。
package com.xiwei.suyue.importer

import java.security.MessageDigest

object TxtImportService {

    data class NormalizedTxt(val bytes: ByteArray, val encoding: String)

    fun utf8Bytes(text: String): ByteArray = text.toByteArray(Charsets.UTF_8)

    fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        val sb = StringBuilder(digest.size * 2)
        for (b in digest) sb.append(String.format("%02x", b))
        return sb.toString()
    }

    // 解码失败返回 null（调用方明确提示，不静默替换）。
    fun normalize(bytes: ByteArray): NormalizedTxt? {
        val decoded = TextDecodeService.decodeToText(bytes) ?: return null
        return NormalizedTxt(utf8Bytes(decoded.text), decoded.encoding)
    }
}
