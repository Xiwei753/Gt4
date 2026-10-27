// SPDX-License-Identifier: GPL-3.0-only
// 回执关联纯逻辑（无 Android 依赖，可在 JVM 单测）。
//
// 施工单 P0-C：旧实现只要收到任意 v=0、type=RESULT 且 transferId 非空的
// 消息，就会唤醒当前等待者——没有校验 transferId，也没有校验 bookId，
// 于是“串号回执 / 别的书 / 上一轮重试 / 取消之后到达的回执”都可能把
// 当前书误标成已入库（成功）。
//
// 本类把该判断做成纯函数：只有当 RESULT 的 transferId 与 bookId
// **同时**等于当前等待中的 (transferId, bookId) 时，才返回 MATCHED；
// 其余一律 IGNORED，调用方不得据其判成功。
package com.xiwei.suyue.wear

// 一条手表 RESULT 的语义化结果。
data class Receipt(val ok: Boolean, val reason: String?)

class ReceiptMatcher {

    data class Pending(val transferId: String, val bookId: String)

    enum class Disposition { MATCHED, IGNORED }

    data class Outcome(val disposition: Disposition, val receipt: Receipt?) {
        val matched: Boolean get() = disposition == Disposition.MATCHED
    }

    // 当前等待中的传输（每轮重试/每次发送前用 begin() 重置）。
    var pending: Pending? = null
        private set

    fun begin(transferId: String, bookId: String) {
        pending = Pending(transferId, bookId)
    }

    fun clear() {
        pending = null
    }

    // 收到一条 RESULT 时的判定。返回 MATCHED 才允许唤醒等待者。
    fun onResult(
        transferId: String,
        bookId: String,
        ok: Boolean,
        reason: String?
    ): Outcome {
        val current = pending
        if (current == null || transferId.isEmpty() || bookId.isEmpty()) {
            return Outcome(Disposition.IGNORED, null)
        }
        if (current.transferId != transferId || current.bookId != bookId) {
            return Outcome(Disposition.IGNORED, null)
        }
        return Outcome(Disposition.MATCHED, Receipt(ok, reason))
    }
}
