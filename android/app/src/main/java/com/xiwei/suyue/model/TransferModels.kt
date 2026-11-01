// SPDX-License-Identifier: GPL-3.0-only
// 手机侧传输模型：进度、传输 ID 与错误码。
// 错误码与 protocol v0 及 harmony 实现对齐。
package com.xiwei.suyue.model

import java.security.SecureRandom

enum class TransferState {
    IDLE,
    CONNECTING,
    SENDING,
    SUCCEEDED,
    FAILED,
    CANCELLED
}

data class TransferProgress(
    val transferId: String,
    val bookId: String,
    val title: String,
    val state: TransferState,
    // 传输进度 0~100。
    val percent: Int,
    val message: String,
    val error: String? = null
)

data class TargetDevice(
    // Wear Engine 设备标识（uuid），不从文件名或 MAC 拼出设备身份。
    val randomId: String,
    val name: String
)

// 上传超时：设备检查 + HELLO + BOOK_META + 文件通道传输的总时长上限。
const val UPLOAD_TIMEOUT_MS = 300_000L

// 与 protocol README 的错误码表一致。
object TransferErrorCode {
    const val E_UNSUPPORTED_FORMAT = "E_UNSUPPORTED_FORMAT"
    const val E_DECODE = "E_DECODE"
    const val E_SPACE = "E_SPACE"
    const val E_TIMEOUT = "E_TIMEOUT"
    const val E_DIGEST_MISMATCH = "E_DIGEST_MISMATCH"
    const val E_MISSING_CHUNKS = "E_MISSING_CHUNKS"
    const val E_DUPLICATE_TRANSFER = "E_DUPLICATE_TRANSFER"
    const val E_CANCELLED = "E_CANCELLED"
    const val E_PEER_UNAVAILABLE = "E_PEER_UNAVAILABLE"
    const val E_BUSY = "E_BUSY"
    const val E_PROTOCOL = "E_PROTOCOL"
    const val E_CHAPTER_TOO_LARGE = "E_CHAPTER_TOO_LARGE"
}

private val RANDOM = SecureRandom()

// 16 字节随机十六进制 transferId（不依赖 UUID 的格式差异）。
fun newTransferId(): String {
    val bytes = ByteArray(16)
    RANDOM.nextBytes(bytes)
    val sb = StringBuilder(32)
    for (b in bytes) sb.append(String.format("%02x", b))
    return sb.toString()
}

fun initialProgress(book: BookMeta, transferId: String): TransferProgress =
    TransferProgress(
        transferId = transferId,
        bookId = book.bookId,
        title = book.title,
        state = TransferState.IDLE,
        percent = 0,
        message = "待发送"
    )
