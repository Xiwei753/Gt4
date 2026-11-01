// SPDX-License-Identifier: GPL-3.0-only
// 手机侧书籍发送：按 protocol v0 序列
//   HELLO → BOOK_META →（可选 CHAPTERS 分片）→ 文件通道。
// 约束（协议 + 施工单）：
//   - 成功表示 Wear Engine 文件发送回调成功，不代表手表已校验或入库；
//   - 目标设备由用户选择，不默认第一台；
//   - 同一时刻只允许一本在途；
//   - 失败不自动重发；需要用户再次发起；
//   - 取消：发 ERROR/E_CANCELLED（Android SDK 无 cancelFileTransfer）。
package com.xiwei.suyue.wear

import com.xiwei.suyue.model.BookMeta
import com.xiwei.suyue.model.TransferErrorCode
import com.xiwei.suyue.model.TransferProgress
import com.xiwei.suyue.model.TransferState
import com.xiwei.suyue.model.UPLOAD_TIMEOUT_MS
import com.xiwei.suyue.model.newTransferId
import android.util.Log
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Collections

class BookTransferService(private val gateway: WearEngineGateway) {

    private val tag = "suyue/Transfer"

    private class InFlight(
        val transferId: String,
        val bookId: String,
        val watch: WatchDevice,
        val peerBundle: String,
        val peerFingerprint: String
    )

    private var inFlight: InFlight? = null

    private val cancelled: MutableSet<String> = Collections.synchronizedSet(HashSet())
    fun isSending(): Boolean = inFlight != null

    // 取消：通知手表清理半成品；Android SDK 无法中断已发出的文件流。
    suspend fun cancel(transferId: String) {
        cancelled.add(transferId)
        Log.i(tag, "cancel transferId=$transferId")
        val flight = inFlight ?: return
        if (flight.transferId != transferId) return
        try {
            gateway.sendMessage(
                flight.watch.device, flight.peerBundle, flight.peerFingerprint,
                errorJson(transferId, TransferErrorCode.E_CANCELLED)
            )
        } catch (e: Exception) {
            // 通知失败不阻断取消；手表侧超时清理。
        }
    }

    suspend fun sendBook(
        book: BookMeta,
        watch: WatchDevice,
        peerBundle: String,
        peerFingerprint: String,
        onProgress: (TransferProgress) -> Unit
    ): Boolean {
        if (inFlight != null) {
            onProgress(
                failedProgress(book, "", TransferErrorCode.E_BUSY, "已有传输在进行")
            )
            return false
        }
        val transferId = newTransferId()
        Log.i(tag, "send start bookId=${book.bookId} title=${book.title} transferId=$transferId device=${watch.target.name}")
        var progress = TransferProgress(
            transferId = transferId,
            bookId = book.bookId,
            title = book.title,
            state = TransferState.CONNECTING,
            percent = 0,
            message = "正在连接 " + watch.target.name
        )
        onProgress(progress)

        // P0-B：先显式配置对端身份（包名 + 指纹），再 ping / 发送。
        // 旧实现在没有 configurePeer 的情况下直接 ping，对端身份未设置。
        gateway.configurePeer(peerBundle, peerFingerprint)

        // 发送前提：手表应用已安装且运行。区分“未安装/未运行/异常”。
        val status = try {
            gateway.pingApp(watch.device)
        } catch (e: Exception) {
            AppStatusFallback
        }
        Log.i(tag, "ping installed=${status.installed} running=${status.running} code=${status.code} msg=${status.message}")
        if (!status.installed) {
            onProgress(
                failedProgress(
                    book, transferId, TransferErrorCode.E_PEER_UNAVAILABLE,
                    "手表端未安装素阅或未配对（${status.message}）"
                )
            )
            return false
        }
        if (!status.running) {
            onProgress(
                failedProgress(
                    book, transferId, TransferErrorCode.E_PEER_UNAVAILABLE,
                    "手表应用未运行，请在 GT 4 上打开素阅后重试"
                )
            )
            return false
        }

        inFlight = InFlight(transferId, book.bookId, watch, peerBundle, peerFingerprint)

        if (cancelled.contains(transferId)) {
            finish(transferId)
            onProgress(progress.copy(state = TransferState.CANCELLED, message = "已取消"))
            return false
        }

        try {
            progress = progress.copy(state = TransferState.CONNECTING, message = "握手（HELLO）")
            onProgress(progress)
            withTimeout(MESSAGE_TIMEOUT_MS) {
                gateway.sendMessage(
                    watch.device, peerBundle, peerFingerprint, helloJson()
                )
            }

            // Chapter metadata is optional. Send it before the body when it
            // fits in chunks, but do not let an incomplete directory block it.
            val fullMeta = bookMetaJson(transferId, book)
            var catalogTooLarge = false
            val chapterMessages = if (fullMeta.size > ChapterChunks.MAX_MESSAGE_BYTES) {
                try {
                    ChapterChunks.split(transferId, book.bookId, book.chapters)
                } catch (e: ChapterTooLargeException) {
                    catalogTooLarge = true
                    Log.w(tag, "optional chapter catalog omitted: ${e.message}")
                    emptyList()
                }
            } else {
                emptyList()
            }
            progress = progress.copy(state = TransferState.SENDING, message = "发送书籍元数据")
            onProgress(progress)
            val metaPayload = when {
                chapterMessages.isNotEmpty() ->
                    bookMetaJson(transferId, book, chapterMessages.size)
                catalogTooLarge -> bookMetaJson(transferId, book, omitChapters = true)
                else -> fullMeta
            }
            withTimeout(MESSAGE_TIMEOUT_MS) {
                gateway.sendMessage(
                    watch.device, peerBundle, peerFingerprint, metaPayload
                )
            }
            for ((index, message) in chapterMessages.withIndex()) {
                progress = progress.copy(
                    message = "补充章节目录 ${index + 1}/${chapterMessages.size}"
                )
                onProgress(progress)
                try {
                    withTimeout(MESSAGE_TIMEOUT_MS) {
                        gateway.sendMessage(
                            watch.device, peerBundle, peerFingerprint, message
                        )
                    }
                } catch (e: Exception) {
                    Log.w(tag, "optional chapter chunk failed index=$index: ${e.message}")
                    break
                }
            }

            if (cancelled.contains(transferId)) {
                finish(transferId)
                onProgress(progress.copy(state = TransferState.CANCELLED, message = "已取消"))
                return false
            }

            progress = progress.copy(state = TransferState.SENDING, message = "通过文件通道传输正文")
            onProgress(progress)
            withTimeout(UPLOAD_TIMEOUT_MS) {
                gateway.sendFile(
                    watch.device, peerBundle, peerFingerprint, File(book.filePath)
                ) { percent ->
                    progress = progress.copy(percent = percent)
                    onProgress(progress)
                }
            }
            if (cancelled.contains(transferId)) {
                finish(transferId)
                onProgress(progress.copy(state = TransferState.CANCELLED, message = "已取消"))
                return false
            }

            finish(transferId)
            progress = progress.copy(
                state = TransferState.SUCCEEDED,
                percent = 100,
                message = "文件已发送；手表侧校验和入库未确认"
            )
            onProgress(progress)
            Log.i(tag, "file sent transferId=$transferId bookId=${book.bookId}")
            return true
        } catch (e: Exception) {
            val reason = if (e is TimeoutCancellationException) {
                TransferErrorCode.E_TIMEOUT
            } else {
                TransferErrorCode.E_PEER_UNAVAILABLE
            }
            finish(transferId)
            Log.w(tag, "file send failed transferId=$transferId reason=$reason: ${e.message}")
            onProgress(failedProgress(book, transferId, reason, "文件发送失败（$reason）：${e.message}"))
            return false
        }
    }

    private fun finish(transferId: String) {
        if (inFlight?.transferId == transferId) inFlight = null
        cancelled.remove(transferId)
    }

    private fun failedProgress(
        book: BookMeta,
        transferId: String,
        reason: String,
        message: String
    ): TransferProgress = TransferProgress(
        transferId = transferId,
        bookId = book.bookId,
        title = book.title,
        state = TransferState.FAILED,
        percent = 0,
        message = message,
        error = reason
    )

    private fun helloJson(): ByteArray {
        val capabilities = JSONObject()
            .put("formats", JSONArray().put("utf8-text"))
            .put("ack", true)
            .put("chunkBytes", JSONObject.NULL)
            .put("fileChannel", true)
        val msg = JSONObject()
            .put("v", 0)
            .put("type", "HELLO")
            .put("capabilities", capabilities)
        return msg.toString().toByteArray(Charsets.UTF_8)
    }

    private fun bookMetaJson(transferId: String, book: BookMeta,
                             chapterChunks: Int = 0,
                             omitChapters: Boolean = false): ByteArray {
        val msg = book.toBookMetaPayload()
        msg.put("v", 0)
        msg.put("type", "BOOK_META")
        msg.put("transferId", transferId)
        if (chapterChunks > 0) {
            // 分片模式：完整目录由后续 CHAPTERS 消息补齐。
            msg.put("chapters", JSONArray())
            msg.put("chapterChunks", chapterChunks)
        } else if (omitChapters) {
            msg.put("chapters", JSONArray())
        }
        return msg.toString().toByteArray(Charsets.UTF_8)
    }

    private fun errorJson(transferId: String, code: String): ByteArray {
        val msg = JSONObject()
            .put("v", 0)
            .put("type", "ERROR")
            .put("transferId", transferId)
            .put("code", code)
        return msg.toString().toByteArray(Charsets.UTF_8)
    }

    companion object {
        // 控制消息（HELLO/BOOK_META/ERROR）发送的单阶段超时，避免 SDK 不回调时挂死。
        private const val MESSAGE_TIMEOUT_MS = 15_000L

        private val AppStatusFallback = WearEngineGateway.AppStatus(
            false, false, -1, "Wear Engine 不可用"
        )
    }
}
