// SPDX-License-Identifier: GPL-3.0-only
// 手机与手表共用的书籍数据模型（Android 侧）。
// 字段名与 harmony/.../model/BookModels.ets 对齐，二者只通过
// protocol 约定交互，不共享可执行代码。
package com.xiwei.suyue.model

import org.json.JSONArray
import org.json.JSONObject

enum class BookKind(val value: String) {
    TXT("txt"),
    EPUB("epub");

    companion object {
        fun from(value: String?): BookKind =
            if (value == EPUB.value) EPUB else TXT
    }
}

enum class BookStatus(val value: String) {
    IMPORTING("importing"),
    READY("ready"),
    FAILED("failed"),
    SENDING("sending"),
    SENT("sent"),
    TRANSFER_FAILED("transfer_failed");

    companion object {
        fun from(value: String?): BookStatus =
            entries.firstOrNull { it.value == value } ?: READY
    }
}

data class BookChapter(
    val title: String,
    // 规范化 UTF-8 正文文件内的字节偏移与长度。
    val offset: Long,
    val length: Long
) {
    fun toJson(): JSONObject = JSONObject()
        .put("title", title)
        .put("offset", offset)
        .put("length", length)

    companion object {
        fun fromJson(o: JSONObject): BookChapter = BookChapter(
            o.optString("title", ""),
            o.optLong("offset", 0),
            o.optLong("length", 0)
        )
    }
}

data class BookMeta(
    val bookId: String,
    val title: String,
    val kind: BookKind,
    // 规范化后的 UTF-8 正文（沙箱私有目录内）文件路径。
    val filePath: String,
    // 规范化后正文的编码（本项目统一 utf-8）。
    val encoding: String,
    // 规范化后正文字节数（UTF-8 字节，非字符数）。
    val bytes: Long,
    // 规范化后正文的 SHA-256（十六进制小写）。必须对实际发送的 normalized 字节计算。
    val sha256: String,
    val chapters: List<BookChapter>,
    // 消息通道后备分块描述（文件通道优先）。
    val chunks: Int,
    val chunkBytes: Int,
    val importedAt: Long,
    val updatedAt: Long,
    val status: BookStatus,
    val lastError: String? = null
) {
    // 本地书库索引（library.json）持久化形状，含磁盘路径与状态。
    fun toJson(): JSONObject {
        val chaptersJson = JSONArray()
        chapters.forEach { chaptersJson.put(it.toJson()) }
        val o = JSONObject()
            .put("bookId", bookId)
            .put("title", title)
            .put("kind", kind.value)
            .put("filePath", filePath)
            .put("encoding", encoding)
            .put("bytes", bytes)
            .put("sha256", sha256)
            .put("chapters", chaptersJson)
            .put("chunks", chunks)
            .put("chunkBytes", chunkBytes)
            .put("importedAt", importedAt)
            .put("updatedAt", updatedAt)
            .put("status", status.value)
        if (lastError != null) o.put("lastError", lastError)
        return o
    }

    // 协议 BOOK_META 的正文部分（transferId/v/type 由传输层附加）。
    fun toBookMetaPayload(): JSONObject {
        val chaptersJson = JSONArray()
        chapters.forEach { chaptersJson.put(it.toJson()) }
        return JSONObject()
            .put("bookId", bookId)
            .put("title", title)
            .put("encoding", encoding)
            .put("bytes", bytes)
            .put("sha256", sha256)
            .put("chunks", chunks)
            .put("chunkBytes", chunkBytes)
            .put("chapters", chaptersJson)
    }

    companion object {
        fun fromJson(o: JSONObject): BookMeta? {
            val bookId = o.optString("bookId", "")
            if (bookId.isEmpty()) return null
            val chapters = mutableListOf<BookChapter>()
            val arr = o.optJSONArray("chapters")
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val c = arr.optJSONObject(i) ?: continue
                    chapters.add(BookChapter.fromJson(c))
                }
            }
            return BookMeta(
                bookId = bookId,
                title = o.optString("title", ""),
                kind = BookKind.from(o.optString("kind")),
                filePath = o.optString("filePath", ""),
                encoding = o.optString("encoding", "utf-8"),
                bytes = o.optLong("bytes", 0),
                sha256 = o.optString("sha256", ""),
                chapters = chapters,
                chunks = o.optInt("chunks", 1),
                chunkBytes = o.optInt("chunkBytes", 0),
                importedAt = o.optLong("importedAt", 0),
                updatedAt = o.optLong("updatedAt", 0),
                status = BookStatus.from(o.optString("status")),
                lastError = if (o.has("lastError")) o.optString("lastError") else null
            )
        }
    }
}

data class ImportResult(
    val ok: Boolean,
    val book: BookMeta? = null,
    val reason: String? = null
)

// 稳定 bookId：同一内容（摘要）始终映射到同一本书；标题仅用于可读性。
fun newBookId(sha256: String, @Suppress("UNUSED_PARAMETER") title: String): String =
    sha256.take(16)
