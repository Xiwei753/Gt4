// SPDX-License-Identifier: GPL-3.0-only
// 手机侧书籍发送：按 shared/protocol v0 序列
// HELLO → BOOK_META → 文件通道 transferFile →
// 等待手表 RESULT。
//
// 关键约束（协议 + 施工单）：
//   - 成功以手表回 RESULT ok=true 为准，
//     不以 transferFile 回调成功为准；
//   - 目标设备由用户选择，不默认第一台；
//   - 同一时刻只允许一本在途（手表侧单本
//     互斥，第二个 META 返回 E_BUSY）；
//   - waiter 生命周期绑定重试轮次：每轮
//     重新注册，上传阶段与回执阶段分开计时
//     （第二轮 P0-3）；
//   - 取消接真实 SDK：cancelFileTransfer +
//     向手表发 ERROR/E_CANCELLED（第二轮 P1-7）；
//   - 重试只针对可恢复错误，摘要类错误不重试。
// API 形状以华为 Wear Engine 指南为准，
// 当前未在真机验证（待验证）。
import { wearEngine } from '@kit.WearEngine';
import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { common } from '@kit.AbilityKit';
import { BookMeta } from '../model/BookModels';
import { TransferProgress, TransferState,
  TargetDevice, MAX_RETRY, RESULT_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  newTransferId } from '../model/TransferModels';
import { WearDeviceService } from './WearDeviceService';
import { createWaiterRegistry } from './TransferWaiters';

const TAG = 'suyue/BookTransferService';

export interface TransferCallbacks {
  onProgress: (progress: TransferProgress) => void;
}

// 在途传输的运行态：取消时需要同一个
// P2pFile 句柄与设备/身份参数。
interface InFlightTransfer {
  transferId: string;
  device: TargetDevice;
  appParam: wearEngine.P2pAppParam;
  p2pFile: wearEngine.P2pFile | null;
}

export class BookTransferService {
  private p2pClient: wearEngine.P2pClient;
  private deviceService: WearDeviceService;
  private context: Context;
  private encoder: util.TextEncoder;
  // P0-3：waiter 注册表（纯逻辑模块，Node 可测）。
  private waiters = createWaiterRegistry({
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    uploadTimeoutMs: UPLOAD_TIMEOUT_MS,
    resultTimeoutMs: RESULT_TIMEOUT_MS
  });
  private cancelled = new Set<string>();
  // 当前在途传输（单本互斥）。
  private inFlight: InFlightTransfer | null = null;

  constructor(context: common.UIAbilityContext,
    deviceService: WearDeviceService) {
    this.context = context;
    this.p2pClient = wearEngine.getP2pClient(context);
    this.deviceService = deviceService;
    this.encoder = new util.TextEncoder();
  }

  // 手表回执入口：页面层把 Wear Engine 消息
  // 回调路由到这里。
  onMessageFromWatch(content: Uint8Array): void {
    const text = new util.TextDecoder()
      .decodeToString(content);
    let message;
    try {
      message = JSON.parse(text);
    } catch (e) {
      hilog.warn(0x0000, TAG, 'non-protocol message');
      return;
    }
    if (message.v !== 0 || message.type !== 'RESULT') {
      return;
    }
    // deliver：缓存回执并唤醒当前轮次；迟到
    // 回执只入缓存，不丢失（P0-3）。
    this.waiters.deliver(message);
  }

  getReceipt(transferId: string):
  { ok: boolean; reason?: string } | undefined {
    return this.waiters.receipt(transferId);
  }

  isSending(): boolean {
    return this.inFlight !== null;
  }

  // 取消（P1-7）：本地等待立即结束 + 真实
  // SDK cancelFileTransfer + 通知手表清理。
  // 半成品由手表侧的失败清理路径删除。
  async cancel(transferId: string): Promise<void> {
    this.cancelled.add(transferId);
    this.waiters.fail(transferId, 'E_CANCELLED');
    const flight = this.inFlight;
    if (!flight || flight.transferId !== transferId) {
      return;
    }
    if (flight.p2pFile) {
      try {
        // 形状以华为 Wear Engine 指南为准（待真机验证）：
        // cancelFileTransfer(deviceRandomId, appParam, file)
        const result = await this.p2pClient.cancelFileTransfer(
          flight.device.randomId, flight.appParam,
          flight.p2pFile);
        if (result &&
            result.code !==
            wearEngine.P2pResultCode.COMMUNICATION_SUCCESS) {
          hilog.warn(0x0000, TAG,
            'cancelFileTransfer code ' + result.code);
        }
      } catch (error) {
        hilog.warn(0x0000, TAG,
          'cancelFileTransfer failed');
      }
    }
    // 显式通知手表：停止接收并删除暂存。
    try {
      await this.sendMessage(flight.device,
        flight.appParam, {
          v: 0, type: 'ERROR',
          transferId: transferId,
          code: 'E_CANCELLED'
        }, 'ERROR');
    } catch (error) {
      hilog.warn(0x0000, TAG,
        'cancel notice failed');
    }
  }

  private buildAppParam(peer: { bundleName: string;
    fingerprint: string }): wearEngine.P2pAppParam {
    const appInfo: wearEngine.AppInfo = {
      bundleName: peer.bundleName,
      fingerprint: peer.fingerprint
    };
    return { remoteApp: appInfo };
  }

  private async sendMessage(device: TargetDevice,
    appParam: wearEngine.P2pAppParam,
    payload: object, label: string): Promise<void> {
    const message: wearEngine.P2pMessage = {
      content: this.encoder.encodeInto(
        JSON.stringify(payload))
    };
    hilog.info(0x0000, TAG,
      'sendMessage %{public}s bytes=%{public}d',
      label, message.content.length);
    // Wear Engine 的 sendMessage 返回 Promise<P2pResult>。
    // 必须等真正发送结束：旧写法调用后直接 resolve，
    // 异步失败也会被误判成成功，导致直接开始文件传输。
    const result = await this.p2pClient.sendMessage(
      device.randomId, appParam, message);
    hilog.info(0x0000, TAG,
      'sendMessage %{public}s result=%{public}s',
      label, result && result.code !== undefined ?
        String(result.code) : 'undefined');
    if (result && result.code !== undefined &&
        result.code !==
          wearEngine.P2pResultCode.COMMUNICATION_SUCCESS) {
      throw new Error('sendMessage code ' + result.code);
    }
  }

  // transferFile：回调可能多次上报进度。
  // 句柄只在终态（错误或传输完成）关闭，
  // 进度回调不得关闭；在途句柄登记到
  // inFlight 供取消使用（P1-9/P1-7）。
  private transferFile(device: TargetDevice,
    appParam: wearEngine.P2pAppParam,
    transferId: string,
    filePath: string,
    onPercent: (percent: number) => void):
  Promise<void> {
    hilog.info(0x0000, TAG,
      'transferFile start path=%{public}s', filePath);
    const p2pFile: wearEngine.P2pFile = {
      file: fs.openSync(filePath, fs.OpenMode.READ_ONLY)
    };
    hilog.info(0x0000, TAG, 'transferFile opened');
    if (this.inFlight &&
        this.inFlight.transferId === transferId) {
      this.inFlight.p2pFile = p2pFile;
    }
    let settled = false;
    return new Promise<void>((resolve, reject) => {
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (this.inFlight &&
            this.inFlight.transferId === transferId) {
          this.inFlight.p2pFile = null;
        }
        try {
          fs.closeSync(p2pFile.file);
        } catch (closeError) {
          hilog.warn(0x0000, TAG, 'close failed');
        }
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      try {
        this.p2pClient.transferFile(device.randomId,
          appParam, p2pFile, (error, result) => {
            try {
              if (error) {
                hilog.error(0x0000, TAG,
                  'transferFile callback error=%{public}s',
                  String(error.code));
                settle(new Error('transfer failed: ' +
                  error.code));
                return;
              }
              if (result) {
                hilog.info(0x0000, TAG,
                  'transferFile callback code=%{public}s progress=%{public}d',
                  result.code !== undefined ?
                    String(result.code) : 'undefined',
                  typeof result.progress === 'number' ?
                    result.progress : -1);
              }
              if (result && typeof result.progress === 'number') {
                onPercent(result.progress);
              }
              // Wear Engine 的成功码不是 0，而是
              // P2pResultCode.COMMUNICATION_SUCCESS（当前 SDK 为 207）。
              // code 缺失代表进度通知，不能提前关闭文件句柄。
              if (result && result.code !== undefined) {
                if (result.code ===
                    wearEngine.P2pResultCode.COMMUNICATION_SUCCESS) {
                  settle(undefined);
                } else {
                  settle(new Error('transfer result code ' +
                    result.code));
                }
              }
            } catch (callbackError) {
              settle(callbackError instanceof Error ?
                callbackError : new Error('callback failed'));
            }
          });
      } catch (callError) {
        hilog.error(0x0000, TAG,
          'transferFile call threw: %{public}s',
          callError instanceof Error ?
            callError.message : String(callError));
        settle(callError instanceof Error ? callError :
          new Error('transferFile call failed'));
      }
    });
  }

  private update(callbacks: TransferCallbacks,
    progress: TransferProgress): void {
    callbacks.onProgress(progress);
  }

  private finishTransfer(transferId: string): void {
    this.waiters.end(transferId);
    if (this.inFlight &&
        this.inFlight.transferId === transferId) {
      this.inFlight = null;
    }
  }

  // 发送一本书。重试只包裹可恢复阶段（超时/对端不可用）。
  // peer 必须是对端（手表）身份，不能是本机身份。
  async sendBook(book: BookMeta, device: TargetDevice,
    peer: { bundleName: string; fingerprint: string },
    callbacks: TransferCallbacks,
    retry: number = MAX_RETRY): Promise<boolean> {
    // 单本互斥：手表侧第二本会回 E_BUSY，
    // 手机侧也不允许并发发送。
    if (this.inFlight !== null) {
      this.update(callbacks, {
        transferId: '',
        bookId: book.bookId,
        title: book.title,
        state: TransferState.FAILED,
        percent: 0,
        message: '已有传输在进行',
        error: 'E_BUSY'
      });
      return false;
    }
    const transferId = newTransferId();
    const progress: TransferProgress = {
      transferId: transferId,
      bookId: book.bookId,
      title: book.title,
      state: TransferState.CONNECTING,
      percent: 0,
      message: '正在连接 ' + device.name
    };
    this.update(callbacks, progress);

    // 目标前提：远端应用已安装（用对端身份校验）。
    let installed = false;
    try {
      installed = await this.deviceService
        .isRemoteAppInstalled(device, peer.bundleName);
    } catch (e) {
      installed = false;
    }
    if (!installed) {
      progress.state = TransferState.FAILED;
      progress.error = 'E_PEER_UNAVAILABLE';
      progress.message = '手表端未安装素阅或未配对';
      this.update(callbacks, progress);
      return false;
    }

    const appParam = this.buildAppParam(peer);
    this.inFlight = {
      transferId: transferId,
      device: device,
      appParam: appParam,
      p2pFile: null
    };

    let attempt = 0;
    while (attempt <= retry) {
      if (this.cancelled.has(transferId)) {
        this.finishTransfer(transferId);
        progress.state = TransferState.CANCELLED;
        progress.message = '已取消';
        this.update(callbacks, progress);
        return false;
      }
      attempt += 1;
      // P0-3：每个重试轮次注册全新 waiter；
      // 上传阶段与回执阶段分开计时。
      const resultPromise =
        this.waiters.beginAttempt(transferId);
      try {
        // HELLO
        progress.state = TransferState.CONNECTING;
        progress.message = '握手（HELLO）';
        this.update(callbacks, progress);
        await this.sendMessage(device, appParam, {
          v: 0, type: 'HELLO',
          capabilities: {
            formats: ['utf8-text'], ack: true,
            chunkBytes: null, fileChannel: true
          }
        }, 'HELLO');

        // BOOK_META
        progress.state = TransferState.SENDING;
        progress.message = '发送书籍元数据';
        this.update(callbacks, progress);
        await this.sendMessage(device, appParam, {
          v: 0, type: 'BOOK_META',
          transferId: transferId,
          bookId: book.bookId,
          title: book.title,
          // 固定 'utf-8'：BookMeta 没有 encoding 字段，也不能有——
          // 导入链路（BookImportService.importBook）已把 TXT 解码后
          // 重新编码、EPUB 转出的正文也用 packChapters 打包，落到
          // 沙箱的字节一律是 UTF-8。协议（shared/protocol）同样只
          // 接受 'utf-8'，所以这里发的是既成事实，不是占位值。
          encoding: 'utf-8',
          bytes: book.bytes,
          sha256: book.sha256,
          chunks: book.chunks,
          chunkBytes: book.chunkBytes,
          chapters: book.chapters
        }, 'BOOK_META');

        // 文件通道：整本规范化文件。
        progress.message = '通过文件通道传输正文';
        this.update(callbacks, progress);
        await this.transferFile(device, appParam,
          transferId, book.filePath, (percent) => {
            progress.percent = percent;
            this.update(callbacks, progress);
          });

        // 上传完成：切换为回执等待阶段，
        // 回执计时从现在开始（大文件不误超时）。
        this.waiters.markUploaded(transferId);
        progress.state = TransferState.WAITING_RESULT;
        progress.message = '等待手表校验回执';
        progress.percent = 100;
        this.update(callbacks, progress);
        const result = await resultPromise;
        if (this.cancelled.has(transferId)) {
          this.finishTransfer(transferId);
          progress.state = TransferState.CANCELLED;
          progress.message = '已取消';
          this.update(callbacks, progress);
          return false;
        }
        if (result.ok) {
          this.finishTransfer(transferId);
          progress.state = TransferState.SUCCEEDED;
          progress.message = '手表已确认入库';
          this.update(callbacks, progress);
          return true;
        }
        // 摘要/缺块/忙碌类错误不可通过重试解决。
        const reason = result.reason || 'E_PROTOCOL';
        if (reason === 'E_DIGEST_MISMATCH' ||
            reason === 'E_MISSING_CHUNKS' ||
            reason === 'E_UNSUPPORTED_FORMAT' ||
            reason === 'E_DECODE' ||
            reason === 'E_BUSY') {
          this.finishTransfer(transferId);
          progress.state = TransferState.FAILED;
          progress.error = reason;
          progress.message = '手表拒绝：' + reason;
          this.update(callbacks, progress);
          return false;
        }
        // 可恢复错误（超时等）走重试。
        progress.message = '可恢复失败（' + reason +
          '），重试 ' + attempt + '/' + retry;
        this.update(callbacks, progress);
        if (attempt > retry) {
          this.finishTransfer(transferId);
          progress.state = TransferState.FAILED;
          progress.error = reason;
          progress.message = '重试耗尽：' + reason;
          this.update(callbacks, progress);
          return false;
        }
      } catch (error) {
        hilog.error(0x0000, TAG,
          'sendBook attempt %{public}d failed: %{public}s',
          attempt,
          error instanceof Error ? error.message : String(error));
        this.waiters.fail(transferId, 'E_PEER_UNAVAILABLE');
        if (attempt > retry) {
          this.finishTransfer(transferId);
          progress.state = TransferState.FAILED;
          progress.error = 'E_PEER_UNAVAILABLE';
          progress.message = '传输失败：' +
            (error && error.message);
          this.update(callbacks, progress);
          return false;
        }
        progress.message = '传输异常，重试 ' + attempt +
          '/' + retry;
        this.update(callbacks, progress);
      }
    }
    this.finishTransfer(transferId);
    progress.state = TransferState.FAILED;
    progress.error = 'E_TIMEOUT';
    progress.message = '超过最大重试次数';
    this.update(callbacks, progress);
    return false;
  }
}
