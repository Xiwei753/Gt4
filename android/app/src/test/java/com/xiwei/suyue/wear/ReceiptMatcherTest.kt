// SPDX-License-Identifier: GPL-3.0-only
// 回执关联纯逻辑单测（施工单 P0-C）。
// 覆盖：正常命中、串号、别的书、缺 bookId、取消/清空后迟到回执、失败回执。
package com.xiwei.suyue.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReceiptMatcherTest {

    private val tid = "a0b1c2d3e4f5061728394a5b6c7d8e9f"
    private val bid = "57289cc5703b030b"

    @Test
    fun matchesWhenBothIdsEqual() {
        val m = ReceiptMatcher()
        m.begin(tid, bid)
        val out = m.onResult(tid, bid, ok = true, reason = null)
        assertTrue(out.matched)
        assertEquals(true, out.receipt?.ok)
    }

    @Test
    fun ignoresStrayTransferId() {
        val m = ReceiptMatcher()
        m.begin(tid, bid)
        val out = m.onResult("ffffffffffffffffffffffffffffffff", bid, ok = true, reason = null)
        assertFalse(out.matched)
    }

    @Test
    fun ignoresWrongBookId() {
        val m = ReceiptMatcher()
        m.begin(tid, bid)
        val out = m.onResult(tid, "0000000000000000", ok = true, reason = null)
        assertFalse("别的书的回执不得判当前书成功", out.matched)
    }

    @Test
    fun ignoresMissingBookId() {
        val m = ReceiptMatcher()
        m.begin(tid, bid)
        assertFalse(m.onResult(tid, "", ok = true, reason = null).matched)
    }

    @Test
    fun ignoresWhenNoPending() {
        val m = ReceiptMatcher()
        assertFalse(m.onResult(tid, bid, ok = true, reason = null).matched)
    }

    @Test
    fun ignoresLateReceiptAfterClear() {
        val m = ReceiptMatcher()
        m.begin(tid, bid)
        m.clear()
        assertFalse("取消/结束后迟到的回执不得唤醒", m.onResult(tid, bid, ok = true, reason = null).matched)
    }

    @Test
    fun failureReceiptMatchesButIsNotSuccess() {
        val m = ReceiptMatcher()
        m.begin(tid, bid)
        val out = m.onResult(tid, bid, ok = false, reason = "E_BUSY")
        assertTrue(out.matched)
        assertEquals(false, out.receipt?.ok)
        assertEquals("E_BUSY", out.receipt?.reason)
    }

    @Test
    fun pendingIsReplacedByBegin() {
        val m = ReceiptMatcher()
        m.begin(tid, bid)
        m.begin("11111111111111111111111111111111", bid)
        // 旧 transferId 不再命中。
        assertFalse(m.onResult(tid, bid, ok = true, reason = null).matched)
        assertTrue(m.onResult("11111111111111111111111111111111", bid, ok = true, reason = null).matched)
    }
}
