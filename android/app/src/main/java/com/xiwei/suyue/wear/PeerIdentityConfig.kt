// SPDX-License-Identifier: GPL-3.0-only
// 构建期指纹注入点（提交空值占位）。
// CI（.github/workflows/android_apk.yml）或 tools/build_android_apk.sh 在编译前
// 用真实手表指纹替换下方字符串；不得提交真实指纹/密钥。
package com.xiwei.suyue.wear

object PeerIdentityConfig {
    // 手表应用证书指纹（SHA-256）。空值 = 未配置。
    const val INJECTED_WATCH_FINGERPRINT = ""
}
