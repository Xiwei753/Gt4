// SPDX-License-Identifier: GPL-3.0-only
// TXT/EPUB 导入编排：读取系统选择器授权的 Uri → 规范化 UTF-8 →
// 写入应用私有目录 → 登记书库。任何一步失败都不登记为成功。
// 与 harmony/.../BookImportService.ets 对齐；Android 用
// ACTION_OPEN_DOCUMENT + ContentResolver（不记录 Uri 当作成功）。
package com.xiwei.suyue.importer

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import com.xiwei.suyue.model.BookChapter
import com.xiwei.suyue.model.BookKind
import com.xiwei.suyue.model.BookMeta
import com.xiwei.suyue.model.BookStatus
import com.xiwei.suyue.model.ImportResult
import com.xiwei.suyue.model.newBookId
import com.xiwei.suyue.storage.BookRepository
import java.io.ByteArrayOutputStream
import java.io.File

object BookImportService {

    private const val READ_CHUNK = 1024 * 1024

    // 导入上限：保护手表端内存与传输时长。超过一律明确拒绝，不进入书库。
    const val MAX_BOOK_BYTES = 32L * 1024 * 1024

    // 消息通道后备分块大小（文件通道优先发送，此值只用于 BOOK_META 的分块描述）。
    private const val MESSAGE_CHUNK_BYTES = 64 * 1024

    // 分块读取授权 Uri 的全部字节；超过上限立即拒绝。
    // 导入流程内立即读取，不依赖持久化授权。
    fun readUriBytes(context: Context, uri: Uri): ByteArray {
        val input = context.contentResolver.openInputStream(uri)
            ?: throw IllegalStateException("无法打开所选文件")
        input.use { stream ->
            val out = ByteArrayOutputStream()
            val buf = ByteArray(READ_CHUNK)
            var total = 0L
            while (true) {
                val n = stream.read(buf)
                if (n <= 0) break
                total += n
                if (total > MAX_BOOK_BYTES) {
                    throw IllegalStateException("文件超过导入上限（$MAX_BOOK_BYTES 字节）")
                }
                out.write(buf, 0, n)
            }
            return out.toByteArray()
        }
    }

    private fun queryDisplayName(context: Context, uri: Uri): String? {
        var name: String? = null
        try {
            context.contentResolver.query(
                uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null
            )?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (idx >= 0) name = cursor.getString(idx)
                }
            }
        } catch (e: Exception) {
            // 回退到 lastPathSegment。
        }
        if (name.isNullOrEmpty()) name = uri.lastPathSegment
        return name
    }

    // 防 ../ 、重复名、奇怪 Uri：只取最后一段作为展示名。
    fun displayFilename(context: Context, uri: Uri): String {
        var name = queryDisplayName(context, uri) ?: ""
        name = name.substringAfterLast('/').substringAfterLast('\\')
        if (name.isEmpty() || name.contains("..")) {
            throw IllegalStateException("非法文件名：$name")
        }
        return name
    }

    private fun extensionOf(context: Context, uri: Uri): String {
        val name = (queryDisplayName(context, uri) ?: "").lowercase()
        if (name.endsWith(".txt")) return "txt"
        if (name.endsWith(".epub")) return "epub"
        val mime = (context.contentResolver.getType(uri) ?: "").lowercase()
        if (mime == "application/epub+zip") return "epub"
        if (mime.startsWith("text/")) return "txt"
        return ""
    }

    private fun writeNormalizedFile(path: String, bytes: ByteArray) {
        // P1-7：先写临时文件，再原子替换目标，避免“先删后写”中途失败丢正文。
        val tmp = File("$path.tmp")
        val target = File(path)
        tmp.writeBytes(bytes)
        try {
            java.nio.file.Files.move(
                tmp.toPath(),
                target.toPath(),
                java.nio.file.StandardCopyOption.REPLACE_EXISTING
            )
        } catch (e: Exception) {
            tmp.delete()
            throw java.io.IOException("写入正文文件失败：$path", e)
        }
    }

    private fun readFileBytes(path: String): ByteArray = File(path).readBytes()

    // 把 EPUB 章节合并为单一规范化 UTF-8 文件，并返回章节字节区间。
    private fun packChapters(chapters: List<EpubImportService.EpubChapter>):
        Pair<ByteArray, List<BookChapter>> {
        val encoded = chapters.map { it.title to TxtImportService.utf8Bytes(it.text) }
        var total = 0L
        for (e in encoded) total += e.second.size
        val out = ByteArray(total.toInt())
        val offsets = ArrayList<BookChapter>()
        var pos = 0
        for (e in encoded) {
            System.arraycopy(e.second, 0, out, pos, e.second.size)
            offsets.add(BookChapter(e.first, pos.toLong(), e.second.size.toLong()))
            pos += e.second.size
        }
        return Pair(out, offsets)
    }

    fun importBook(context: Context, uri: Uri): ImportResult {
        val ext = extensionOf(context, uri)
        if (ext.isEmpty()) {
            return ImportResult(false, reason = "仅接受 TXT / EPUB 文件")
        }
        val raw: ByteArray = try {
            readUriBytes(context, uri)
        } catch (e: Exception) {
            return ImportResult(false, reason = "读取文件失败：${e.message}")
        }
        if (raw.isEmpty()) {
            return ImportResult(false, reason = "文件为空")
        }

        return try {
            val title: String
            val chapters: List<BookChapter>
            val normalized: ByteArray

            if (ext == "txt") {
                val normalizedTxt = TxtImportService.normalize(raw)
                    ?: return ImportResult(
                        false,
                        reason = "编码识别失败（GBK/GB18030 解码在当前系统不可用），未导入"
                    )
                normalized = normalizedTxt.bytes
                chapters = listOf(BookChapter("正文", 0L, normalized.size.toLong()))
                title = displayFilename(context, uri).replace(Regex("\\.[^.]+$"), "")
            } else {
                val epub = EpubImportService.importEpub(raw)
                val packed = packChapters(epub.chapters)
                normalized = packed.first
                chapters = packed.second
                title = epub.title
            }

            // 摘要与 bookId 必须基于实际发送/落盘的 normalized 字节。
            val digest = TxtImportService.sha256Hex(normalized)
            val bookId = newBookId(digest, title)

            val repository = BookRepository(context)
            repository.booksDir.mkdirs()
            val filePath = File(repository.booksDir, "$bookId.txt").absolutePath
            writeNormalizedFile(filePath, normalized)

            // 写后复核：回读文件，确认字节数与摘要一致。
            val onDisk = readFileBytes(filePath)
            if (onDisk.size != normalized.size) {
                return ImportResult(false, reason = "导入复核失败：磁盘字节数与正文不符")
            }
            if (TxtImportService.sha256Hex(onDisk) != digest) {
                return ImportResult(false, reason = "导入复核失败：磁盘摘要与正文不符")
            }

            val now = System.currentTimeMillis()
            val chunks = maxOf(1, ((normalized.size + MESSAGE_CHUNK_BYTES - 1) / MESSAGE_CHUNK_BYTES))
            val meta = BookMeta(
                bookId = bookId,
                title = title,
                kind = if (ext == "txt") BookKind.TXT else BookKind.EPUB,
                filePath = filePath,
                encoding = "utf-8",
                bytes = normalized.size.toLong(),
                sha256 = digest,
                chapters = chapters,
                chunks = chunks,
                chunkBytes = MESSAGE_CHUNK_BYTES,
                importedAt = now,
                updatedAt = now,
                status = BookStatus.READY
            )
            repository.register(meta)
            ImportResult(true, book = meta)
        } catch (e: Exception) {
            ImportResult(false, reason = "导入失败：${e.message}")
        }
    }
}
