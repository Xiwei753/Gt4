// SPDX-License-Identifier: GPL-3.0-only
// 华为 Wear Engine Android SDK 薄封装。
// 关键结论（相对 repo 中的 HarmonyOS ArkTS 形状差异）：
//   - 本 Android SDK 无 isRemoteAppInstalled，改用 ping 返回码判断手表应用状态；
//   - 本 Android SDK 无 cancelFileTransfer，取消只能本地停等 + 发 ERROR 通知手表；
//   - 对端身份通过 setPeerPkgName/setPeerFingerPrint 配置（发送/收信前统一设置）。
// API 形状来自官方 SDK 5.0.0.300（com.huawei.wearengine.*），真机行为待验证。
package com.xiwei.suyue.wear

import android.content.Context
import android.util.Log
import com.huawei.hmf.tasks.Task
import com.huawei.wearengine.HiWear
import com.huawei.wearengine.auth.AuthCallback
import com.huawei.wearengine.auth.AuthClient
import com.huawei.wearengine.auth.Permission
import com.huawei.wearengine.common.WearEngineErrorCode
import com.huawei.wearengine.device.Device
import com.huawei.wearengine.device.DeviceClient
import com.huawei.wearengine.p2p.Message
import com.huawei.wearengine.p2p.P2pClient
import com.huawei.wearengine.p2p.Receiver
import com.huawei.wearengine.p2p.SendCallback
import com.xiwei.suyue.model.TargetDevice
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

// Wear Engine 返回非成功码时抛出，携带原始 code 便于 UI 区分原因。
class WearEngineFailure(val code: Int, message: String) : Exception(message)

// 一台已配对手表：同时保留 Wear Engine Device 句柄与可展示的 TargetDevice。
data class WatchDevice(val target: TargetDevice, val device: Device)

class WearEngineGateway(private val context: Context) {

    private val authClient: AuthClient by lazy { HiWear.getAuthClient(context) }
    private val deviceClient: DeviceClient by lazy { HiWear.getDeviceClient(context) }
    private val p2pClient: P2pClient by lazy { HiWear.getP2pClient(context) }

    private var receiver: Receiver? = null

    private val permissions = arrayOf(Permission.DEVICE_MANAGER)

    private val tag = "suyue/WearEngine"

    private suspend fun <T> Task<T>.awaitTask(): T = suspendCancellableCoroutine { cont ->
        addOnSuccessListener { result -> if (cont.isActive) cont.resume(result) }
        addOnFailureListener { e -> if (cont.isActive) cont.resumeWithException(e) }
    }

    // 配置对端（手表）身份。发送 / 收信 / ping 前必须调用，
    // 保证三者使用同一 device + 同一对端包名/指纹。
    fun configurePeer(bundleName: String, fingerprint: String) {
        p2pClient.setPeerPkgName(bundleName)
        if (fingerprint.isNotBlank()) p2pClient.setPeerFingerPrint(fingerprint)
    }

    // 申请 DEVICE_MANAGER 权限。
    // 说明：SDK 5.0.0.300 的 AuthClient 只有 requestPermission（无 checkPermissions）；
    // 已授权时 Huawei SDK 会直接回调 onOk，不弹窗，因此这里重复调用是安全的。
    suspend fun ensurePermission(): Boolean {
        return suspendCancellableCoroutine { cont ->
            try {
                authClient.requestPermission(object : AuthCallback {
                    override fun onOk(permissions: Array<out Permission>?) {
                        if (cont.isActive) cont.resume(permissions?.isNotEmpty() == true)
                    }

                    override fun onCancel() {
                        if (cont.isActive) cont.resume(false)
                    }
                }, *permissions)
            } catch (e: Exception) {
                Log.w(tag, "requestPermission failed: ${e.message}")
                if (cont.isActive) cont.resume(false)
            }
        }
    }

    suspend fun hasAvailableDevices(): Boolean = try {
        deviceClient.hasAvailableDevices().awaitTask()
    } catch (e: Exception) {
        Log.w(tag, "hasAvailableDevices failed: ${e.message}")
        false
    }

    // 列出已连接（isConnected）的手表。空列表 = 未配对 / 离线 / 健康应用未就绪。
    suspend fun listDevices(): List<WatchDevice> {
        val devices = deviceClient.bondedDevices.awaitTask()
        val out = ArrayList<WatchDevice>()
        for (d in devices) {
            if (!d.isConnected) continue
            val uuid = d.uuid ?: ""
            val name = d.name ?: "GT 4（${uuid.take(6)}…）"
            out.add(WatchDevice(TargetDevice(randomId = uuid, name = name), d))
        }
        return out
    }

    data class AppStatus(val installed: Boolean, val running: Boolean, val code: Int, val message: String)

    // 用 ping 返回码判断手表应用状态（官方 SDK 无 isRemoteAppInstalled）。
    suspend fun pingApp(device: Device): AppStatus = suspendCancellableCoroutine { cont ->
        try {
            p2pClient.ping(device) { code ->
                val status = when (code) {
                    WearEngineErrorCode.ERROR_CODE_P2P_WATCH_APP_RUNNING ->
                        AppStatus(true, true, code, "手表应用运行中")
                    WearEngineErrorCode.ERROR_CODE_P2P_WATCH_APP_NOT_RUNNING ->
                        AppStatus(true, false, code, "手表应用已安装但未运行")
                    WearEngineErrorCode.ERROR_CODE_P2P_WATCH_APP_NOT_EXIT ->
                        AppStatus(false, false, code, "手表应用未安装")
                    else -> AppStatus(
                        false, false, code,
                        WearEngineErrorCode.getErrorMsgFromCode(code)
                    )
                }
                if (cont.isActive) cont.resume(status)
            }.addOnFailureListener { e ->
                if (cont.isActive) cont.resumeWithException(e)
            }
        } catch (e: Exception) {
            if (cont.isActive) cont.resumeWithException(e)
        }
    }

    // 发送控制消息（HELLO/BOOK_META/ERROR 等 JSON 文本，字节载荷）。
    suspend fun sendMessage(
        device: Device,
        peerBundle: String,
        peerFingerprint: String,
        payload: ByteArray
    ) {
        configurePeer(peerBundle, peerFingerprint)
        val message = Message.Builder().setPayload(payload).build()
        sendInternal(device, message, null)
    }

    // 发送正文文件（文件通道）。
    suspend fun sendFile(
        device: Device,
        peerBundle: String,
        peerFingerprint: String,
        file: File,
        onProgress: ((Int) -> Unit)? = null
    ) {
        configurePeer(peerBundle, peerFingerprint)
        val message = Message.Builder().setPayload(file).build()
        sendInternal(device, message, onProgress)
    }

    private suspend fun sendInternal(
        device: Device,
        message: Message,
        onProgress: ((Int) -> Unit)?
    ): Unit = suspendCancellableCoroutine { cont ->
        try {
            // 注意：send() 返回的 Task 失败与 SendCallback 的回调失败是两条路径，
            // 都要处理，否则 SDK 不回调时协程会挂死（P0-B）。
            p2pClient.send(device, message, object : SendCallback {
                override fun onSendProgress(progress: Long) {
                    val percent = progress.coerceIn(0, 100).toInt()
                    onProgress?.invoke(percent)
                }

                override fun onSendResult(code: Int) {
                    if (!cont.isActive) return
                    if (code == WearEngineErrorCode.ERROR_CODE_COMM_SUCCESS) {
                        cont.resume(Unit)
                    } else {
                        Log.w(
                            tag,
                            "send result failed code=$code " +
                                "(${WearEngineErrorCode.getErrorMsgFromCode(code)})"
                        )
                        cont.resumeWithException(
                            WearEngineFailure(code, "发送失败（code=$code）")
                        )
                    }
                }
            }).addOnFailureListener { e ->
                Log.w(tag, "send task failed: ${e.message}")
                if (cont.isActive) cont.resumeWithException(e)
            }
        } catch (e: Exception) {
            if (cont.isActive) cont.resumeWithException(e)
        }
    }

    // 注册手表 → 手机消息接收（RESULT 回执）。
    // P0-D：这是可等待的，返回是否注册成功；注册失败时 UI 不得允许发送。
    suspend fun registerReceiver(
        device: Device,
        peerBundle: String,
        peerFingerprint: String,
        onMessage: (Message) -> Unit
    ): Boolean {
        configurePeer(peerBundle, peerFingerprint)
        unregisterReceiver()
        val newReceiver = object : Receiver {
            override fun onReceiveMessage(message: Message) {
                onMessage(message)
            }
        }
        return try {
            p2pClient.registerReceiver(device, newReceiver).awaitTask()
            receiver = newReceiver
            true
        } catch (e: Exception) {
            Log.w(tag, "registerReceiver failed: ${e.message}")
            receiver = null
            false
        }
    }

    fun unregisterReceiver() {
        val current = receiver ?: return
        try {
            p2pClient.unregisterReceiver(current)
                .addOnFailureListener { e -> Log.w(tag, "unregisterReceiver failed: ${e.message}") }
        } catch (e: Exception) {
            Log.w(tag, "unregisterReceiver threw: ${e.message}")
        }
        receiver = null
    }
}
