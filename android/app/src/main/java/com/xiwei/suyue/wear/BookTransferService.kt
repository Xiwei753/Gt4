// SPDX-License-Identifier: GPL-3.0-only
// 手机侧书籍发送：按 protocol v0 序列
//   HELLO → BOOK_META → 文件通道 → 等待手表 RESULT。
// 约束（协议 + 施工单）：
//   - 成功以手表回 RESULT ok=true 为准，不以发送回调成功为准；
//   - 目标设备由用户选择，不默认第一台；
//   - 同一时刻只允许一本在途；
//   - 上传阶段与回执阶段分开计时，大文件不会误判超时；
//   - 摘要/缺块/忙碌类错误不重试；
//   - 取消：本地停等 + 发 ERROR/E_CANCELLED（Android SDK 无 cancelFileTransfer）。
package com.xiwei.suyue.wear

import com.xiwei.suyue.model.BookMeta
import com.xiwei.suyue.model.MAX_RETRY
import com.xiwei.suyue.model.RESULT_TIMEOUT_MS
import com.xiwei.suyue.model.TransferErrorCode
import com.xiwei.suyue.model.TransferProgress
import com.xiwei.suyue.model.TransferState
import com.xiwei.suyue.model.UPLOAD_TIMEOUT_MS
import com.xiwei.suyue.model.newTransferId
import android.util.Log
import kotlinx.coroutines.CompletableDeferred
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

    // 回执关联（P0-C）：只有 transferId + bookId 同时命中当前等待者才计入成功。
    private val matcher = ReceiptMatcher()

    private val cancelled: MutableSet<String> = Collections.synchronizedSet(HashSet())
    private val receipts: MutableMap<String, Receipt> = Collections.synchronizedMap(HashMap())

    @Volatile
    private var pendingResult: CompletableDeferred<Receipt>? = null

    // 手表回执入口：页面把 Wear Engine 消息回调路由到这里。
    // 仅当 transferId 与 bookId 都与当前在途传输一致时，才唤醒等待者；
    // 串号 / 别的书 / 取消或重试之后到达的回执一律忽略（不判成功）。
    fun onMessageFromWatch(content: ByteArray) {
        val text = try {
            String(content, Charsets.UTF_8)
        } catch (e: Exception) {
            return
        }
        val json = try {
            JSONObject(text)
        } catch (e: Exception) {
            return
        }
        if (json.optInt("v", -1) != 0 || json.optString("type") != "RESULT") return
        val transferId = json.optString("transferId", "")
        val bookId = json.optString("bookId", "")
        val ok = json.optBoolean("ok", false)
        val reason = if (ok) null else json.optString("reason", TransferErrorCode.E_PROTOCOL)
        val outcome = matcher.onResult(transferId, bookId, ok, reason)
        if (!outcome.matched) {
            Log.w(
                tag,
                "ignore unmatched RESULT transferId=$transferId bookId=$bookId " +
                    "(pending=${matcher.pending})"
            )
            return
        }
        val receipt = outcome.receipt ?: return
        receipts[transferId] = receipt
        Log.i(tag, "RESULT matched transferId=$transferId bookId=$bookId ok=$ok reason=${reason ?: "-"}")
        val active = pendingResult
        if (active != null && active.isActive) active.complete(receipt)
    }

    fun isSending(): Boolean = inFlight != null

    fun getReceipt(transferId: String): Receipt? = receipts[transferId]

    // 取消：本地立即结束等待 + 通知手表清理半成品。
    suspend fun cancel(transferId: String) {
        cancelled.add(transferId)
        Log.i(tag, "cancel transferId=$transferId")
        pendingResult?.let { if (it.isActive) it.complete(Receipt(false, TransferErrorCode.E_CANCELLED)) }
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
        onProgress: (TransferProgress) -> Unit,
        retry: Int = MAX_RETRY
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

        var attempt = 0
        while (attempt <= retry) {
            if (cancelled.contains(transferId)) {
                finish(transferId)
                onProgress(progress.copy(state = TransferState.CANCELLED, message = "已取消"))
                return false
            }
            attempt += 1

            // 每轮注册全新回执等待者（上传阶段与回执阶段分开计时）。
            // P0-C：本轮 (transferId, bookId) 写入 matcher，只有同时命中才判成功。
            val deferred = CompletableDeferred<Receipt>()
            pendingResult = deferred
            matcher.begin(transferId, book.bookId)

            try {
                // HELLO
                progress = progress.copy(state = TransferState.CONNECTING, message = "握手（HELLO）")
                onProgress(progress)
                withTimeout(MESSAGE_TIMEOUT_MS) {
                    gateway.sendMessage(
                        watch.device, peerBundle, peerFingerprint, helloJson()
                    )
                }

                // BOOK_META：章节偏移基于 UTF-8 字节。
                progress = progress.copy(state = TransferState.SENDING, message = "发送书籍元数据")
                onProgress(progress)
                withTimeout(MESSAGE_TIMEOUT_MS) {
                    gateway.sendMessage(
                        watch.device, peerBundle, peerFingerprint, bookMetaJson(transferId, book)
                    )
                }

                // 文件通道传输整本规范化正文（上传阶段独立超时）。
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

                // 回执阶段（独立超时，从上传完成起算）。
                progress = progress.copy(
                    state = TransferState.WAITING_RESULT,
                    percent = 100,
                    message = "等待手表校验回执"
                )
                onProgress(progress)
                val receipt = withTimeout(RESULT_TIMEOUT_MS) { deferred.await() }

                if (cancelled.contains(transferId)) {
                    finish(transferId)
                    onProgress(progress.copy(state = TransferState.CANCELLED, message = "已取消"))
                    return false
                }
                if (receipt.ok) {
                    finish(transferId)
                    Log.i(tag, "send success transferId=$transferId bookId=${book.bookId}")
                    onProgress(progress.copy(state = TransferState.SUCCEEDED, message = "手表已确认入库"))
                    return true
                }
                val reason = receipt.reason ?: TransferErrorCode.E_PROTOCOL
                if (reason in NON_RETRYABLE) {
                    finish(transferId)
                    Log.w(tag, "send refused transferId=$transferId reason=$reason")
                    onProgress(
                        failedProgress(book, transferId, reason, "手表拒绝：$reason")
                    )
                    return false
                }
                progress = progress.copy(
                    message = "可恢复失败（$reason），重试 $attempt/$retry"
                )
                onProgress(progress)
                if (attempt > retry) {
                    finish(transferId)
                    onProgress(failedProgress(book, transferId, reason, "重试耗尽：$reason"))
                    return false
                }
            } catch (e: Exception) {
                val reason = if (e is TimeoutCancellationException) {
                    TransferErrorCode.E_TIMEOUT
                } else {
                    TransferErrorCode.E_PEER_UNAVAILABLE
                }
                progress = progress.copy(message = "传输异常（$reason），重试 $attempt/$retry")
                onProgress(progress)
                if (attempt > retry) {
                    finish(transferId)
                    onProgress(failedProgress(book, transferId, reason, "传输失败：${e.message}"))
                    return false
                }
            }
        }
        finish(transferId)
        onProgress(failedProgress(book, transferId, TransferErrorCode.E_TIMEOUT, "超过最大重试次数"))
        return false
    }

    private fun finish(transferId: String) {
        pendingResult = null
        matcher.clear()
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

    private fun bookMetaJson(transferId: String, book: BookMeta): ByteArray {
        val msg = book.toBookMetaPayload()
        msg.put("v", 0)
        msg.put("type", "BOOK_META")
        msg.put("transferId", transferId)
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

        // 不可通过重试解决的错误。
        private val NON_RETRYABLE = setOf(
            TransferErrorCode.E_DIGEST_MISMATCH,
            TransferErrorCode.E_MISSING_CHUNKS,
            TransferErrorCode.E_UNSUPPORTED_FORMAT,
            TransferErrorCode.E_DECODE,
            TransferErrorCode.E_BUSY
        )

        private val AppStatusFallback = WearEngineGateway.AppStatus(
            false, false, -1, "Wear Engine 不可用"
        )
    }
}
