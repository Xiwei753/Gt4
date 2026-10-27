// SPDX-License-Identifier: GPL-3.0-only
// 对端（GT 4）身份配置。
// 包名约定（issues #2/#3）：
//   手表 bundleName = con.xiwei.suyue.gt4      （con，不是 com）
//   本 Android APK  = com.xiwei.suyue.android   （AGC 登记的 Android 包名，
//                                              与 HarmonyOS 手机 com.xiwei.suyue 区分）
// 注意：包名一致 ≠ 签名一致。手表侧 supportLists 只信任“对端包名:对端证书指纹”，
// 因此本 APK 的真实签名指纹必须由 #2 侧登记进手表 supportLists（见 docs/ANDROID_APK.md）。
package com.xiwei.suyue.wear

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import java.security.MessageDigest

object PeerIdentity {

    const val WATCH_BUNDLE_NAME = "con.xiwei.suyue.gt4"
    const val PHONE_BUNDLE_NAME = "com.xiwei.suyue.android"

    // 手表应用证书指纹（Wear Engine setPeerFingerPrint 使用）。
    // 由 CI/构建脚本注入到 PeerIdentityConfig；未注入时为空，发送功能保持禁用。
    val watchFingerprint: String
        get() = PeerIdentityConfig.INJECTED_WATCH_FINGERPRINT

    fun isConfigured(): Boolean = watchFingerprint.isNotBlank()

    // 本 APK 的实际签名证书 SHA-256（用于诊断：与手表 supportLists 中登记的手机指纹比对）。
    fun apkSigningSha256(context: Context): String? {
        return try {
            val pm = context.packageManager
            val certs: Array<out android.content.pm.Signature>? = if (Build.VERSION.SDK_INT >= 28) {
                val info = pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
                val si = info.signingInfo
                when {
                    si == null -> null
                    si.hasMultipleSigners() -> si.apkContentsSigners
                    else -> si.signingCertificateHistory
                }
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES).signatures
            }
            val first = certs?.firstOrNull() ?: return null
            val digest = MessageDigest.getInstance("SHA-256").digest(first.toByteArray())
            digest.joinToString("") { String.format("%02x", it) }
        } catch (e: Exception) {
            null
        }
    }

    // 华为常见展示格式：AA:BB:...（大写，冒号分隔）。
    fun formatColonUpper(hex: String): String =
        hex.uppercase().chunked(2).joinToString(":")
}
