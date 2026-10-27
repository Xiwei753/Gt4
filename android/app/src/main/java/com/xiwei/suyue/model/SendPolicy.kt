// SPDX-License-Identifier: GPL-3.0-only
// 发送策略（纯逻辑，可在 JVM 单测）：统一“哪些状态允许发送/重发”。
//
// 施工单 P1-5：旧实现只有 status==READY 才允许发送，导致一本书第一次发送后
// 变成 SENT / TRANSFER_FAILED 就再也点不动，无法重发。
// 规则：READY / SENT / TRANSFER_FAILED 均可发送（后者即“重发”）；
// 导入中、导入失败（未就绪）、正在发送的书不允许。
package com.xiwei.suyue.model

object SendPolicy {

    fun isSendable(status: BookStatus): Boolean = when (status) {
        BookStatus.READY,
        BookStatus.SENT,
        BookStatus.TRANSFER_FAILED -> true

        BookStatus.IMPORTING,
        BookStatus.FAILED,
        BookStatus.SENDING -> false
    }

    // 发送按钮文案：未发过显示“发送”，发过一次后显示“重发”。
    fun sendLabel(status: BookStatus): String =
        if (status == BookStatus.READY) "发送" else "重发"
}
