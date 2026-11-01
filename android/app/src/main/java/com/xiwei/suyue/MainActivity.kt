// SPDX-License-Identifier: GPL-3.0-only
// 素阅 Android 首页：真实书库 + TXT/EPUB 导入 + Wear Engine 发送到 GT 4。
// 选择文件 ≠ 导入成功；发送完成只表示 Wear Engine 文件回调成功，
// 手表侧校验和入库结果未知。
// UI 结构对齐 harmony/.../pages/Index.ets，但不追求过度重构。
package com.xiwei.suyue

import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.LayoutInflater
import android.view.View
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.xiwei.suyue.databinding.ActivityMainBinding
import com.xiwei.suyue.databinding.ItemBookBinding
import com.xiwei.suyue.importer.BookImportService
import com.xiwei.suyue.model.BookMeta
import com.xiwei.suyue.model.BookStatus
import com.xiwei.suyue.model.SendPolicy
import com.xiwei.suyue.model.TransferProgress
import com.xiwei.suyue.model.TransferState
import com.xiwei.suyue.storage.BookRepository
import com.xiwei.suyue.ui.BookRow
import com.xiwei.suyue.wear.BookTransferService
import com.xiwei.suyue.wear.PeerIdentity
import com.xiwei.suyue.wear.WatchDevice
import com.xiwei.suyue.wear.WearEngineGateway
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {

    private val tag = "suyue/Main"

    private lateinit var binding: ActivityMainBinding
    private lateinit var repository: BookRepository
    private lateinit var gateway: WearEngineGateway
    private lateinit var transferService: BookTransferService

    private var books: List<BookMeta> = emptyList()
    private var devices: List<WatchDevice> = emptyList()
    private var selectedDevice: Int = -1
    private var sending: Boolean = false
    private var activeTransferId: String = ""

    private val pickBook = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        if (uri == null) {
            binding.pickStatus.text = "没有选择文件"
            return@registerForActivityResult
        }
        importBook(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        repository = BookRepository(this)
        gateway = WearEngineGateway(this)
        transferService = BookTransferService(gateway)

        binding.btnChooseBook.setOnClickListener {
            // 用 */* 兼容部分提供方把 .txt 报成 octet-stream 的情况；
            // 真正的类型判定在导入服务里按扩展名/MIME 完成。
            pickBook.launch(arrayOf("*/*"))
        }
        binding.btnRefreshDevices.setOnClickListener { refreshDevices() }
        binding.btnCancelSend.setOnClickListener { cancelSend() }
    }

    override fun onStart() {
        super.onStart()
        refresh()
        refreshDevices()
    }

    override fun onDestroy() {
        super.onDestroy()
    }

    private fun refresh() {
        books = repository.list()
        binding.libraryTitle.text = "书架（${books.size} 本）"
        binding.emptyHint.visibility = if (books.isEmpty()) View.VISIBLE else View.GONE
        binding.bookContainer.removeAllViews()
        for (book in books) {
            val rowBinding = ItemBookBinding.inflate(
                LayoutInflater.from(this), binding.bookContainer, false
            )
            BookRow.bind(
                rowBinding, book, canSend(),
                onSend = { sendBook(book) },
                onDelete = { confirmRemove(book) }
            )
            binding.bookContainer.addView(rowBinding.root)
        }
    }

    private fun canSend(): Boolean =
        selectedDevice >= 0 && PeerIdentity.isConfigured() && !sending

    private fun importBook(uri: Uri) {
        binding.pickedName.text = uri.lastPathSegment ?: "已选择文件"
        binding.pickStatus.text = "正在导入……"
        binding.btnChooseBook.isEnabled = false
        Log.i(tag, "import start uri=$uri")
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                BookImportService.importBook(this@MainActivity, uri)
            }
            binding.btnChooseBook.isEnabled = true
            if (!result.ok) {
                Log.w(tag, "import failed reason=${result.reason}")
                binding.pickStatus.text = "导入失败：${result.reason ?: "未知原因"}"
                return@launch
            }
            val book = result.book!!
            Log.i(tag, "import ok bookId=${book.bookId} title=${book.title} bytes=${book.bytes} chapters=${book.chapters.size}")
            binding.pickStatus.text =
                "已导入：${book.title}（${book.bytes} 字节，${book.chapters.size} 章）"
            refresh()
        }
    }

    private fun confirmRemove(book: BookMeta) {
        AlertDialog.Builder(this)
            .setTitle("删除书籍")
            .setMessage("确定删除《${book.title}》？此操作不可恢复。")
            .setNegativeButton("取消", null)
            .setPositiveButton("删除") { _, _ ->
                try {
                    repository.remove(book.bookId)
                    refresh()
                    binding.pickStatus.text = "已删除《${book.title}》"
                } catch (e: Exception) {
                    Log.e(tag, "remove failed bookId=${book.bookId}: ${e.message}")
                    binding.pickStatus.text = "删除失败：书库索引写入失败，请重试"
                    refresh()
                }
            }
            .show()
    }

    private fun refreshDevices() {
        binding.deviceStatus.text = "正在请求手表访问授权……"
        lifecycleScope.launch {
            val granted = gateway.ensurePermission()
            if (!granted) {
                Log.w(tag, "device permission denied")
                devices = emptyList()
                selectedDevice = -1
                binding.deviceStatus.text = "未获得手表访问授权（请在华为健康中确认配对）"
                renderDeviceButtons()
                return@launch
            }
            val found = try {
                withContext(Dispatchers.IO) { gateway.listDevices() }
            } catch (e: Exception) {
                emptyList()
            }
            devices = found
            selectedDevice = -1
            if (found.isEmpty()) {
                binding.deviceStatus.text = "未发现已连接的 GT 4（请确认配对与蓝牙）"
            } else {
                binding.deviceStatus.text =
                    "发现 ${found.size} 台已连接设备，请选择目标"
            }
            renderDeviceButtons()
            bookingDiagnostics()
        }
    }

    // 打印本机签名指纹，便于与手表 supportLists 登记的手机指纹比对（验收第 2 步）。
    private fun bookingDiagnostics() {
        val sha = PeerIdentity.apkSigningSha256(this)
        val watchFp = if (PeerIdentity.isConfigured()) "已配置" else "未配置（发送禁用）"
        val apkFp = if (sha != null) PeerIdentity.formatColonUpper(sha) else "未知"
        binding.transferText.text = "本机签名指纹：$apkFp\n手表指纹：$watchFp"
    }

    private fun renderDeviceButtons() {
        binding.deviceContainer.removeAllViews()
        for ((index, device) in devices.withIndex()) {
            val button = android.widget.Button(this).apply {
                text = device.target.name
                textSize = 12f
                setOnClickListener { selectDevice(index) }
            }
            val lp = android.widget.LinearLayout.LayoutParams(
                android.widget.LinearLayout.LayoutParams.WRAP_CONTENT,
                android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.marginEnd = 8
            button.layoutParams = lp
            binding.deviceContainer.addView(button)
        }
        updateSendingState()
    }

    private fun selectDevice(index: Int) {
        if (index < 0 || index >= devices.size) return
        selectedDevice = index
        val device = devices[index]
        binding.deviceStatus.text = "已选择：${device.target.name}"
        if (!PeerIdentity.isConfigured()) {
            binding.deviceStatus.text = "已选择：${device.target.name}；手表签名指纹未配置，发送保持禁用"
        }
        refresh()
    }

    private fun sendBook(book: BookMeta) {
        if (!canSend()) {
            binding.transferText.text = "发送不可用：请先选择设备并配置手表指纹"
            return
        }
        if (!SendPolicy.isSendable(book.status)) {
            binding.transferText.text = "书籍未就绪，不能发送（导入中或导入失败）"
            return
        }
        val device = devices[selectedDevice]
        sending = true
        activeTransferId = ""
        binding.transferText.text = "正在发送《${book.title}》……"
        updateSendingState()
        var transferFailure = "文件发送失败"
        lifecycleScope.launch {
            val ok = transferService.sendBook(
                book = book,
                watch = device,
                peerBundle = PeerIdentity.WATCH_BUNDLE_NAME,
                peerFingerprint = PeerIdentity.watchFingerprint,
                onProgress = { progress ->
                    transferFailure = progress.message
                    onTransferProgress(progress)
                }
            )
            sending = false
            activeTransferId = ""
            updateSendingState()
            if (ok) {
                binding.transferText.text = "《${book.title}》文件已发送；手表侧校验和入库未确认"
                markStatusSafely(book.bookId, BookStatus.SENT, null)
            } else {
                binding.transferText.text = "发送失败：$transferFailure"
                markStatusSafely(book.bookId, BookStatus.TRANSFER_FAILED, transferFailure)
            }
            refresh()
        }
    }

    // P1-7：索引写入改为 AtomicFile 后，失败会抛 IOException；
    // 这里必须捕获并向用户暴露，不能静默丢索引。
    private fun markStatusSafely(bookId: String, status: BookStatus, lastError: String?) {
        try {
            repository.markStatus(bookId, status, lastError)
        } catch (e: Exception) {
            Log.e(tag, "markStatus failed bookId=$bookId status=$status: ${e.message}")
            binding.pickStatus.text = "书库索引写入失败，状态未保存（重启可能回退）"
        }
    }

    // P1-6：进度回调可能来自 SDK 线程，必须切回主线程再碰 View，
    // 且 Activity 已销毁时不再写 View。
    private fun onTransferProgress(progress: TransferProgress) {
        runOnUiThread {
            if (isDestroyed || isFinishing) return@runOnUiThread
            if (progress.transferId.isNotEmpty()) activeTransferId = progress.transferId
            val percentText = if (progress.percent > 0 &&
                progress.state == TransferState.SENDING
            ) "（${progress.percent}%）" else ""
            binding.transferText.text = progress.message + percentText
            updateSendingState()
        }
    }

    private fun updateSendingState() {
        binding.btnCancelSend.visibility = if (sending) View.VISIBLE else View.GONE
        binding.btnRefreshDevices.isEnabled = !sending
    }

    private fun cancelSend() {
        if (!sending || activeTransferId.isEmpty()) return
        binding.transferText.text = "正在发送取消通知……"
        val transferId = activeTransferId
        lifecycleScope.launch {
            transferService.cancel(transferId)
            // 当前 Wear Engine SDK 没有传输层取消 API，不能声称文件流已停止。
            binding.transferText.text =
                "已发送取消通知（当前 SDK 无法中断已发出的文件流）"
        }
    }
}
