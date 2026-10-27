// SPDX-License-Identifier: GPL-3.0-only
// 发送/重发状态策略单测（施工单 P1-5）。
package com.xiwei.suyue.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SendPolicyTest {

    @Test
    fun readySentAndTransferFailedAreSendable() {
        assertTrue(SendPolicy.isSendable(BookStatus.READY))
        assertTrue("已发送的书必须可以重发", SendPolicy.isSendable(BookStatus.SENT))
        assertTrue("上次传输失败的书必须可以重发", SendPolicy.isSendable(BookStatus.TRANSFER_FAILED))
    }

    @Test
    fun importingFailedAndSendingAreNotSendable() {
        assertFalse(SendPolicy.isSendable(BookStatus.IMPORTING))
        assertFalse(SendPolicy.isSendable(BookStatus.FAILED))
        assertFalse(SendPolicy.isSendable(BookStatus.SENDING))
    }

    @Test
    fun labelIsResendAfterFirstSend() {
        assertEquals("发送", SendPolicy.sendLabel(BookStatus.READY))
        assertEquals("重发", SendPolicy.sendLabel(BookStatus.SENT))
        assertEquals("重发", SendPolicy.sendLabel(BookStatus.TRANSFER_FAILED))
    }
}
