// SPDX-License-Identifier: GPL-3.0-only
// 手机端首页：真实书库列表 + TXT/EPUB 导入 +
// Wear Engine 发送到 GT 4。
// 选择文件 ≠ 导入成功：只有复制进沙箱、解析、
// 登记后才显示 ready。
// 发送 ≠ 成功：只有手表回 RESULT ok=true 才算
// 入库；未选择目标设备时发送保持禁用。
import { common } from '@kit.AbilityKit';
import { picker } from '@kit.CoreFileKit';
import { promptAction } from '@kit.ArkUI';
import { wearEngine } from '@kit.WearEngine';
import { BookMeta, BookStatus } from '../model/BookModels';
import { TargetDevice, TransferProgress,
  TransferState } from '../model/TransferModels';
import { WATCH_PEER, PHONE_SELF,
  isConfigured } from '../model/PeerIdentity';
import { loadPeerIdentities } from '../services/PeerIdentityLoader';
import { importBook } from '../services/BookImportService';
import { BookRepository } from '../services/BookRepository';
import { WearDeviceService } from '../services/WearDeviceService';
import { BookTransferService } from '../services/BookTransferService';
import { authNotice, deviceNotice, planRetry,
  MAX_AUTO_RETRIES } from '../services/WearAuthPolicy';

// 双端身份严格分离（P0-1/P0-2）：
//   WATCH_PEER：对端 GT 4 身份，作为
//     remoteApp 用于发送与回执校验；
//   PHONE_SELF：本机身份，仅供手表校验
//     消息来源。两者指纹独立注入，互不
//     代替。指纹为空时发送明确禁用。
// 指纹由 CI 从 Secrets 注入
// （services/PeerIdentityConfig.g.ts），
// 不写死、不提交假值。

@Entry
@Component
struct Index {
  @State private books: BookMeta[] = [];
  @State private pickedName: string = '尚未选择书籍';
  @State private pickStatus: string = '可选择 TXT 或 EPUB 文件';
  @State private busy: boolean = false;
  @State private devices: TargetDevice[] = [];
  @State private selectedDevice: number = -1;
  @State private receiverReady: boolean = false;
  @State private deviceStatus: string = '未发现已连接的 GT 4';
  // issue #5：授权状态与设备发现各自的提示与进行中标志。
  @State private authStatus: string = '尚未检查 Wear Engine 授权状态';
  @State private authGranted: boolean = false;
  @State private authBusy: boolean = false;
  @State private deviceBusy: boolean = false;
  @State private transferText: string = '未开始传输';
  @State private sending: boolean = false;
  // 当前在途 transferId（取消时用，P1-7）。
  @State private activeTransferId: string = '';
  private repository: BookRepository | null = null;
  private deviceService: WearDeviceService | null = null;
  private transferService: BookTransferService | null = null;
  // 设备发现/授权的进度序号：只允许最后一次异步结果落地，
  // 避免旧的 await 覆盖新状态（issue #5 P0-B）。
  private refreshSeq: number = 0;
  // issue #6 P0-B：自动重试的定时器与计数。确定性失败不重试，
  // 只有短暂断连/网络错误才在有限次数内退避重试；页面退出/切后台
  // 时一并清理，绝不做亚秒级连续请求。
  private retryTimer: number = -1;
  private autoRetryCount: number = 0;

  private getRepository(): BookRepository {
    if (this.repository === null) {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      this.repository = new BookRepository(context);
    }
    return this.repository;
  }

  private getDeviceService(): WearDeviceService {
    if (this.deviceService === null) {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      this.deviceService = new WearDeviceService(context);
      this.transferService = new BookTransferService(
        context, this.deviceService);
    }
    return this.deviceService;
  }

  onPageShow(): void {
    loadPeerIdentities();
    this.refresh();
    this.refreshDevices();
  }

  // issue #6 P0-B：切后台/页面退出时，取消任何在途发现的自动重试定时器，
  // 并让旧结果作废，避免后台继续轰炸华为服务。
  onPageHide(): void {
    this.clearRetryTimer();
    this.refreshSeq++;
  }

  onDisappear(): void {
    this.clearRetryTimer();
    this.refreshSeq++;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== -1) {
      clearTimeout(this.retryTimer);
      this.retryTimer = -1;
    }
  }

  private refresh(): void {
    this.books = this.getRepository().list();
  }

  // 设备发现（issue #5）：先查授权状态，再列设备；两者都保留
  // 真实的 stage/code，不再一律归为“Wear Engine 不可用”。
  // 空列表 = Wear Engine 未返回可用设备，不等于“未配对/蓝牙没连”。
  // issue #6 P0-B：这是用户/生命周期入口，同一时间最多 1 个在途请求，
  // 重复点击不叠加；进入时清理旧的自动重试定时器。
  private async refreshDevices(): Promise<void> {
    if (this.deviceBusy) return;
    this.clearRetryTimer();
    this.autoRetryCount = 0;
    await this.runDeviceDiscovery();
  }

  private async runDeviceDiscovery(): Promise<void> {
    const seq = ++this.refreshSeq;
    this.receiverReady = false;
    const previous = this.devices[this.selectedDevice];
    if (previous) {
      await this.getDeviceService().unregisterMessageReceiver(previous);
    }
    this.deviceBusy = true;
    try {
      const auth = await this.getDeviceService().queryAuthorization();
      if (seq !== this.refreshSeq) return;
      this.authGranted = auth.granted;
      this.authStatus = authNotice(auth).text;
      const result = await this.getDeviceService().listDevices();
      if (seq !== this.refreshSeq) return;
      this.devices = result.ok ? result.devices : [];
      const notice = deviceNotice(result);
      this.deviceStatus = notice.text;
      this.selectedDevice = -1;

      // 只有可恢复的短暂错误才排定有退避上限的自动重试；
      // 1008509999（应用身份未配置）等确定性失败立即停下，只让用户手动刷新。
      const plan = planRetry(this.autoRetryCount,
        result.ok ? { ok: true } : notice);
      if (plan.retry) {
        this.autoRetryCount = plan.attempt;
        this.deviceStatus = notice.text +
          '（自动重试 ' + plan.attempt + '/' + MAX_AUTO_RETRIES + '）';
        this.retryTimer = setTimeout(() => {
          this.retryTimer = -1;
          this.runDeviceDiscovery();
        }, plan.delayMs);
      } else {
        this.autoRetryCount = 0;
      }
    } finally {
      this.deviceBusy = false;
    }
  }

  // 用户主动授权（issue #5 P0-A）：只在点击时请求，不自动弹窗；
  // 拒绝/取消后也不循环弹窗，改为让用户手动重试。
  private async requestAuth(): Promise<void> {
    if (this.authBusy) return;
    this.authBusy = true;
    const result = await this.getDeviceService().requestAuthorization();
    this.authBusy = false;
    this.authGranted = result.granted;
    this.authStatus = authNotice(result).text;
    await this.refreshDevices();
  }

  private async selectDevice(e: number): Promise<void> {
    if (e < 0 || e >= this.devices.length) return;
    const previous = this.devices[this.selectedDevice];
    const device = this.devices[e];
    if (previous && previous.randomId !== device.randomId) {
      await this.getDeviceService().unregisterMessageReceiver(previous);
    }
    this.receiverReady = false;
    this.selectedDevice = e;
    this.deviceStatus = '已选择：' + device.name;
    if (!isConfigured(WATCH_PEER)) {
      this.deviceStatus += '；手表签名指纹未配置，' +
        '发送将保持禁用';
    }
    // 注册手表 → 手机的消息接收（RESULT 回执）。
    // remoteApp 必须是对端（手表）身份
    // （P0-2），不能用手机自己的包名。
    if (isConfigured(WATCH_PEER) &&
        this.transferService !== null) {
      try {
        await this.getDeviceService()
          .registerMessageReceiver(
            device, WATCH_PEER.bundleName,
            WATCH_PEER.fingerprint,
            (message: wearEngine.P2pMessage) => {
              this.transferService!.onMessageFromWatch(
                message.content);
            });
        this.receiverReady = true;
      } catch (error) {
        this.deviceStatus += '；消息接收注册失败';
      }
    }
  }

  private async chooseBook(): Promise<void> {
    if (this.busy) return;
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const documentPicker = new picker.DocumentViewPicker(context);
      const options = new picker.DocumentSelectOptions();
      const uris: Array<string> = await documentPicker.select(options);
      if (uris.length < 1) {
        this.pickStatus = '没有选择文件';
        return;
      }
      const uri = uris[0];
      this.pickedName = decodeURIComponent(
        uri.substring(uri.lastIndexOf('/') + 1));
      this.pickStatus = '正在导入……';
      this.busy = true;
      const result = await importBook(context, uri);
      this.busy = false;
      if (!result.ok) {
        this.pickStatus = '导入失败：' + (result.reason || '未知原因');
        return;
      }
      this.pickStatus = '已导入：' + result.book!.title +
        '（' + result.book!.bytes + ' 字节，' +
        result.book!.chapters.length + ' 章）';
      this.refresh();
    } catch (error) {
      this.busy = false;
      this.pickStatus = '文件选择失败，请查看日志';
      console.error('suyue import error: ' + JSON.stringify(error));
    }
  }

  private async removeBook(book: BookMeta): Promise<void> {
    try {
      await promptAction.showDialog({
        title: '删除书籍',
        message: '确定删除《' + book.title + '》？此操作不可恢复。',
        buttons: [
          { text: '取消', color: '#9ca3af' },
          { text: '删除', color: '#f87171' }
        ]
      }).then((result) => {
        if (result.index === 1) {
          this.getRepository().remove(book.bookId);
          this.refresh();
          this.pickStatus = '已删除《' + book.title + '》';
        }
      });
    } catch (error) {
      console.error('suyue remove error: ' + JSON.stringify(error));
    }
  }

  private canSend(): boolean {
    return this.selectedDevice >= 0 &&
      this.receiverReady &&
      isConfigured(WATCH_PEER) &&
      !this.sending;
  }

  // 失败后允许重新发送；已发送的书也可能被用户从手表删除，
  // 所以不能永久锁死发送按钮。只有尚未导入完毕的状态禁止发送。
  private canTransferBook(book: BookMeta): boolean {
    return book.status === BookStatus.READY ||
      book.status === BookStatus.SENT ||
      book.status === BookStatus.TRANSFER_FAILED;
  }

  private async sendBook(book: BookMeta): Promise<void> {
    if (!this.canSend() || this.transferService === null) {
      this.transferText =
        '发送不可用：请先选择设备、配置指纹并成功注册回执';
      return;
    }
    if (!this.canTransferBook(book)) {
      this.transferText = '书籍尚未导入完成，不能发送';
      return;
    }
    const device = this.devices[this.selectedDevice];
    this.sending = true;
    this.activeTransferId = '';
    this.transferText = '正在发送《' + book.title + '》……';
    const ok = await this.transferService.sendBook(
      book, device, WATCH_PEER,
      {
        onProgress: (progress: TransferProgress) => {
          if (progress.transferId) {
            this.activeTransferId = progress.transferId;
          }
          this.transferText = progress.message +
            (progress.percent > 0 &&
              progress.state === TransferState.SENDING ?
              '（' + progress.percent + '%）' : '');
        }
      });
    this.sending = false;
    this.activeTransferId = '';
    if (ok) {
      this.transferText = '《' + book.title + '》手表已确认入库';
      this.getRepository().markStatus(book.bookId,
        BookStatus.SENT);
    } else {
      this.transferText = '发送失败：手表未确认入库';
      this.getRepository().markStatus(book.bookId,
        BookStatus.TRANSFER_FAILED,
        'watch did not confirm');
    }
    this.refresh();
  }

  // 取消（P1-7）：接真实 SDK cancelFileTransfer，
  // 并通知手表清理半成品；取消后不得入库。
  private async cancelSend(): Promise<void> {
    const service = this.transferService;
    if (!service || !this.activeTransferId) {
      return;
    }
    this.transferText = '正在取消传输……';
    await service.cancel(this.activeTransferId);
    this.transferText = '已请求取消，等待手表确认清理';
  }

  @Builder
  bookItem(book: BookMeta) {
    Row() {
      Column() {
        Text(book.title)
          .fontSize(16)
          .fontColor('#f2f2f2')
          .maxLines(1)
        Text(book.kind.toUpperCase() + ' · ' + book.bytes +
          ' 字节 · ' + book.chapters.length + ' 章')
          .fontSize(12)
          .fontColor('#9ca3af')
          .margin({ top: 4 })
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      Text(book.status)
        .fontSize(12)
        .fontColor(book.status === BookStatus.READY ?
          '#4ade80' : '#f87171')

      Button('发送')
        .fontSize(12)
        .height(28)
        .enabled(this.canSend() &&
          this.canTransferBook(book))
        .margin({ left: 12 })
        .onClick(() => { this.sendBook(book); })

      Text('删除')
        .fontSize(13)
        .fontColor('#f87171')
        .margin({ left: 12 })
        .onClick(() => { this.removeBook(book); })
    }
    .width('100%')
    .padding(14)
    .backgroundColor('#20242c')
    .borderRadius(14)
  }

  build() {
    Column({ space: 18 }) {
      Text('素阅')
        .fontSize(30)
        .fontWeight(FontWeight.Bold)
        .fontColor('#f2f2f2')

      Text('手机书库 · 配套 GT 4 46mm')
        .fontSize(15)
        .fontColor('#9ca3af')

      Column({ space: 12 }) {
        Text('导入书籍').fontSize(22)
          .fontWeight(FontWeight.Medium).fontColor('#f2f2f2')
        Text(this.pickedName).fontSize(16).fontColor('#e8eaf0')
        Text(this.pickStatus).fontSize(14).fontColor('#a7abb4')
        Button('选择 TXT / EPUB')
          .enabled(!this.busy)
          .onClick(() => { this.chooseBook(); })
      }
      .alignItems(HorizontalAlign.Start)
      .padding(20)
      .width('100%')
      .backgroundColor('#20242c')
      .borderRadius(18)

      Column({ space: 10 }) {
        Text('书架（' + this.books.length + ' 本）').fontSize(22)
          .fontWeight(FontWeight.Medium).fontColor('#f2f2f2')
        if (this.books.length === 0) {
          Text('书库为空。导入 TXT 或 EPUB 后会列在这里，重启不丢。')
            .fontSize(14)
            .fontColor('#a7abb4')
        }
        List() {
          ForEach(this.books, (book: BookMeta) => {
            ListItem() {
              this.bookItem(book)
            }
          }, (book: BookMeta) => book.bookId)
        }
        .width('100%')
        .divider({ strokeWidth: 8, color: '#101114' })
      }
      .alignItems(HorizontalAlign.Start)
      .padding(20)
      .width('100%')
      .backgroundColor('#16181d')
      .borderRadius(18)

      Column({ space: 8 }) {
        Text('发送到 GT 4').fontSize(22)
          .fontWeight(FontWeight.Medium).fontColor('#f2f2f2')
        Text(this.authStatus).fontSize(13)
          .fontColor(this.authGranted ? '#4ade80' : '#facc15')
        if (!this.authGranted) {
          Button(this.authBusy ? '授权中……' : '授权手表访问')
            .fontSize(13)
            .height(28)
            .enabled(!this.authBusy)
            .onClick(() => { this.requestAuth(); })
        }
        Text(this.deviceStatus).fontSize(14).fontColor('#a7abb4')
        if (this.devices.length > 0) {
          Row() {
            ForEach(this.devices, (device: TargetDevice,
              index: number) => {
              Button(device.name)
                .fontSize(12)
                .height(28)
                .backgroundColor(this.selectedDevice === index ?
                  '#344259' : '#101114')
                .margin({ right: 8 })
                .onClick(() => { this.selectDevice(index); })
            }, (device: TargetDevice) => device.randomId)
          }
        }
        Button(this.deviceBusy ? '发现中……' : '刷新设备')
          .fontSize(13)
          .height(28)
          .enabled(!this.deviceBusy)
          .onClick(() => { this.refreshDevices(); })
        if (this.sending) {
          Button('取消发送')
            .fontSize(13)
            .height(28)
            .backgroundColor('#7f1d1d')
            .onClick(() => { this.cancelSend(); })
        }
        Text(this.transferText).fontSize(14)
          .fontColor(this.sending ? '#facc15' : '#a7abb4')
      }
      .alignItems(HorizontalAlign.Start)
      .padding(20)
      .width('100%')
      .backgroundColor('#20242c')
      .borderRadius(18)
    }
    .alignItems(HorizontalAlign.Start)
    .padding(24)
    .width('100%')
    .height('100%')
    .backgroundColor('#101114')
  }
}
