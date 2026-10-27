// SPDX-License-Identifier: GPL-3.0-only
// ZIP 读取器（EPUB 解包用）——基于 Android 内置 java.util.zip。
// 与 ArkTS 侧手写 inflate 的 ZipReader 语义一致，但直接复用平台实现。
// 安全边界：
//   - 拒绝 '..' 与绝对路径（ZIP 路径穿越）；
//   - 限制解压后总大小（防 zip bomb）；
//   - 读取全部条目到内存后随机访问（EPUB 需要 container/OPF/spine 多次读取）。
package com.xiwei.suyue.importer

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.zip.ZipInputStream

class ZipReader(
    bytes: ByteArray,
    private val maxOutputBytes: Long = 64L * 1024 * 1024
) {

    private val entries = LinkedHashMap<String, ByteArray>()

    init {
        val zin = ZipInputStream(ByteArrayInputStream(bytes))
        var total = 0L
        try {
            while (true) {
                val entry = zin.nextEntry ?: break
                val name = entry.name
                if (name.endsWith("/")) {
                    zin.closeEntry()
                    continue
                }
                val safe = safeEntryName(name)
                val out = ByteArrayOutputStream()
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = zin.read(buf)
                    if (n <= 0) break
                    total += n
                    if (total > maxOutputBytes) {
                        throw IllegalStateException("zip bomb: output exceeds limit")
                    }
                    out.write(buf, 0, n)
                }
                entries[safe] = out.toByteArray()
                zin.closeEntry()
            }
        } finally {
            try {
                zin.close()
            } catch (e: Exception) {
                // 忽略关闭异常。
            }
        }
    }

    fun has(name: String): Boolean = entries.containsKey(name)

    fun names(): List<String> = entries.keys.toList()

    fun read(name: String): ByteArray =
        entries[name] ?: throw IllegalStateException("entry not found: $name")

    fun readText(name: String): String = String(read(name), Charsets.UTF_8)

    private fun safeEntryName(name: String): String {
        if (name.isEmpty()) throw IllegalStateException("empty entry name")
        if (name[0] == '/') throw IllegalStateException("absolute path in zip: $name")
        val parts = name.split('/')
        for (p in parts) {
            if (p == "..") throw IllegalStateException("path traversal in zip: $name")
        }
        return name
    }
}
