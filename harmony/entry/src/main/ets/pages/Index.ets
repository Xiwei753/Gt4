// SPDX-License-Identifier: GPL-3.0-only
// 手机端首页：真实书库列表 + TXT/EPUB 导入 +
// Wear Engine 发送到 GT 4。
// 选择文件 ≠ 导入成功：只有复制进沙箱、解析、
// 登记后才显示 ready。
// 发送 ≠ 成功：只有手表回 RESULT ok=true 才算
// 入库；未选择目标设备时发送保持禁用。
import { common } from '@kit.AbilityKit';
import { picker } from '@kit.CoreFileKit';
import { promptAction, router } from '@kit.ArkUI';
import { wearEngine } from '@kit.WearEngine';
import { BookMeta, BookStatus } from '../model/BookModels';
import { TargetDevice, TransferProgress,
  TransferState } from '../model/TransferModels';
import { WATCH_PEER, PHONE_SELF,
  isConfigured } from '../model/PeerIdentity';
import { loadPeerIdentities } from '../services/PeerIdentityLoader';
import { importBook } from '../services/BookImportService';
import { BookRepository, ShelfSortMode } from '../services/BookRepository';
import { ReadingProgressStore, ReadingSummary }
  from '../services/ReadingProgressStore';
import { ReaderKitStateStore } from '../services/ReaderKitStateStore';
import { exportReaderDiagnostics, recordReaderDiagnostic }
  from '../services/ReaderDiagnostics';
import { WearDeviceService, WearDeviceListResult } from '../services/WearDeviceService';
import { BookTransferService } from '../services/BookTransferService';
import { ReadingSyncService } from '../services/ReadingSyncService';
import { deviceNotice, planRetry, MAX_AUTO_RETRIES,
  runDeviceRefresh } from '../services/WearAuthPolicy';
import { restoreShelfWindow } from '../services/ReaderWindowAppearance';

// 双端身份严格分离（issue #13）：
//   WATCH_PEER：对端 GT 4 Lite 身份，手机发送/注册回执时
//     使用 con.xiwei.suyue.gt4_Base64(原始 EC 公钥点)；
//   PHONE_SELF：手机 APP ID，供手表登记“消息来自哪部手机”，
//     不是 OAuth Client ID，也不是证书 SHA-256。
// 两者方向、格式不同，互不代替；任一方为空/格式错误时发送明确禁用。

@Entry
@Component
struct Index {
  @State private books: BookMeta[] = [];
  @State private progressSummaries: ReadingSummary[] = [];
  @State private activeTab: string = 'shelf';
  @State private sortMode: ShelfSortMode = 'recent';
  @State private selectedTransferBookId: string = '';
  @State private diagnosticsText: string = '';
  @State private pickedName: string = '尚未选择书籍';
  @State private pickStatus: string = '可选择 TXT 或 EPUB 文件';
  @State private busy: boolean = false;
  @State private devices: TargetDevice[] = [];
  @State private selectedDevice: number = -1;
  @State private receiverReady: boolean = false;
  @State private deviceStatus: string = '未发现已连接的 GT 4';
  // issue #5 第二轮：设备发现只需 Wear Engine「设备基础信息」服务审批，
  // 无需运行时用户权限，因此不再有授权按钮/未授权状态；只保留发现进行中标志。
  @State private deviceBusy: boolean = false;
  @State private transferText: string = '未开始传输';
  @State private sending: boolean = false;
  // 身份配置错误或“未配置”提示；发送门禁仍由 isConfigured 决定。
  @State private identityStatus: string = '';
  // 当前在途 transferId（取消时用，P1-7）。
  @State private activeTransferId: string = '';
  @State private readingBookIds: string[] = [];
  @State private syncText: string = '进度同步未开始';
  private repository: BookRepository | null = null;
  private progressStore: ReadingProgressStore | null = null;
  private deviceService: WearDeviceService | null = null;
  private transferService: BookTransferService | null = null;
  private syncService: ReadingSyncService | null = null;
  // 用户显式选择的设备身份：刷新设备列表时按 randomId 恢复，
  // 不按列表下标或“第一台设备”猜测。
  private selectedRandomId: string = '';
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

  private getProgressStore(): ReadingProgressStore {
    if (this.progressStore === null) {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      this.progressStore = new ReadingProgressStore(context);
    }
    return this.progressStore;
  }

  private getDeviceService(): WearDeviceService {
    if (this.deviceService === null) {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      this.deviceService = new WearDeviceService(context);
      this.transferService = new BookTransferService(
        context, this.deviceService);
      this.syncService = new ReadingSyncService(
        context, this.deviceService, this.getProgressStore(),
        this.getRepository());
      this.syncService.setStatusListener((text: string, ok: boolean) => {
        this.syncText = text;
        recordReaderDiagnostic(context, 'sync', ok ? 'ok' : 'fail');
      });
    }
    return this.deviceService;
  }

  onPageShow(): void {
    // 阅读页返回或应用重新可见时，兜底恢复书架的普通布局与深色系统栏，
    // 防止全屏布局/浅色系统栏图标泄漏到书架。
    restoreShelfWindow(
      this.getUIContext().getHostContext() as common.UIAbilityContext)
      .catch((error: Error) => {
        console.error('restore shelf window: ' + error.message);
      });
    this.identityStatus = loadPeerIdentities();
    if (this.identityStatus.length === 0 && !isConfigured(WATCH_PEER)) {
      this.identityStatus =
        '手表 Lite 公钥指纹未配置（需要 con.xiwei.suyue.gt4_' +
        'Base64(原始 EC 公钥点)），发送保持禁用';
    }
    if (this.identityStatus.length > 0) {
      console.error('suyue peer identity: ' + this.identityStatus);
    }
    this.refresh();
    this.refreshProgress();
    if (this.syncService !== null) {
      this.syncService.setActiveBook('');
    }
    recordReaderDiagnostic(
      this.getUIContext().getHostContext() as common.UIAbilityContext,
      'app', 'foreground');
    if (this.activeTab === 'transfer') this.refreshDevices();
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
    const repository = this.getRepository();
    const settings = repository.getShelfSettings();
    this.sortMode = settings.sortMode;
    this.books = this.sortBooks(repository.list(), settings.sortMode,
      settings.manualOrder);
  }

  private async refreshProgress(): Promise<void> {
    try {
      const summaries = await this.getProgressStore().list(this.books);
      this.progressSummaries = summaries;
      const ids: string[] = [];
      for (let i = 0; i < summaries.length; i++) {
        ids.push(summaries[i].bookId);
      }
      this.readingBookIds = ids;
      const last = await this.getProgressStore().loadLastRecord();
      if (last !== null) {
        for (let i = 0; i < this.progressSummaries.length; i++) {
          if (this.progressSummaries[i].bookId === last.bookId) {
            this.progressSummaries[i].updatedAt = Math.max(
              this.progressSummaries[i].updatedAt, last.updatedAt);
          }
        }
      }
      if (last !== null && this.selectedTransferBookId.length === 0) {
        this.selectedTransferBookId = last.bookId;
      }
      const settings = this.getRepository().getShelfSettings();
      this.books = this.sortBooks(this.getRepository().list(),
        settings.sortMode, settings.manualOrder);
    } catch (error) {
      this.readingBookIds = [];
      this.progressSummaries = [];
    }
  }

  private sortBooks(books: BookMeta[], mode: ShelfSortMode,
    manualOrder: string[]): BookMeta[] {
    const sorted = books.slice();
    sorted.sort((a: BookMeta, b: BookMeta): number => {
      if (mode === 'title') {
        const left = a.title.toLowerCase();
        const right = b.title.toLowerCase();
        return left < right ? -1 : left > right ? 1 : 0;
      }
      if (mode === 'manual') {
        const leftIndex = manualOrder.indexOf(a.bookId);
        const rightIndex = manualOrder.indexOf(b.bookId);
        const left = leftIndex >= 0 ? leftIndex : 1000000;
        const right = rightIndex >= 0 ? rightIndex : 1000000;
        if (left !== right) return left - right;
      }
      if (mode === 'recent') {
        const left = this.readUpdatedAt(a.bookId);
        const right = this.readUpdatedAt(b.bookId);
        if (left !== right) return right - left;
      }
      return b.importedAt - a.importedAt;
    });
    return sorted;
  }

  private readUpdatedAt(bookId: string): number {
    for (let i = 0; i < this.progressSummaries.length; i++) {
      if (this.progressSummaries[i].bookId === bookId) {
        return this.progressSummaries[i].updatedAt;
      }
    }
    return 0;
  }

  private chooseSort(mode: ShelfSortMode): void {
    this.getRepository().setShelfSortMode(mode);
    this.sortMode = mode;
    const settings = this.getRepository().getShelfSettings();
    this.books = this.sortBooks(this.getRepository().list(), mode,
      settings.manualOrder);
  }

  private moveBook(book: BookMeta, delta: number): void {
    const order: string[] = [];
    for (let i = 0; i < this.books.length; i++) {
      order.push(this.books[i].bookId);
    }
    const index = order.indexOf(book.bookId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= order.length) return;
    const current = order[index];
    order[index] = order[target];
    order[target] = current;
    const repository = this.getRepository();
    repository.setShelfManualOrder(order);
    repository.setShelfSortMode('manual');
    this.sortMode = 'manual';
    this.books = this.sortBooks(repository.list(), 'manual', order);
  }

  private selectTab(tab: string): void {
    this.activeTab = tab;
    if (tab === 'transfer') {
      this.refresh();
      this.refreshProgress();
      this.refreshDevices();
    }
  }

  private isReading(bookId: string): boolean {
    return this.readingBookIds.indexOf(bookId) >= 0;
  }

  private openReader(book: BookMeta): void {
    if (this.syncService !== null) {
      this.syncService.setActiveBook(book.bookId);
    }
    this.selectedTransferBookId = book.bookId;
    router.pushUrl({
      url: 'pages/Reader',
      params: { bookId: book.bookId }
    }).catch((error: Error) => {
      this.pickStatus = '打开阅读页失败：' + error.message;
    });
  }

  // 设备发现（issue #5 第二轮 + issue #6 P0-B）：传书只需「设备基础信息」
  // 服务审批，无需运行时用户权限，因此不再查询/申请授权。
  // 同一时间最多 1 个在途请求，只有最新一轮结果落地；短暂错误按上限退避
  // 重试，确定性失败立即停止，只由用户手动刷新。
  private async refreshDevices(): Promise<void> {
    if (this.deviceBusy) return;
    this.clearRetryTimer();
    this.autoRetryCount = 0;
    await this.runDeviceRefreshFlow();
  }

  private async runDeviceRefreshFlow(): Promise<void> {
    let seq = 0;
    try {
      await runDeviceRefresh({
        start: () => {
          this.deviceBusy = true;
          seq = ++this.refreshSeq;
          return seq;
        },
        isCurrent: (current: number) => current === this.refreshSeq,
        listDevices: async () => {
          // 刷新设备列表时保留当前已注册的接收器；只有设备真正
          // 消失后才在 apply 里注销，避免从阅读页返回时丢选择。
          return await this.getDeviceService().listDevices();
        },
        apply: (result: WearDeviceListResult) => {
          const previous = this.devices[this.selectedDevice];
          const wanted = this.selectedRandomId;
          this.devices = result.ok ? result.devices : [];
          const notice = deviceNotice(result);
          this.deviceStatus = notice.text;
          let restored = -1;
          if (result.ok && wanted) {
            for (let i = 0; i < this.devices.length; i++) {
              if (this.devices[i].randomId === wanted) {
                restored = i;
                break;
              }
            }
          }
          if (restored >= 0) {
            // 同一台手表仍在：保留用户显式选择，不自动改选第一台。
            this.selectedDevice = restored;
            const device = this.devices[restored];
            if (!this.receiverReady) {
              this.registerReceiverFor(device);
            }
          } else {
            this.selectedDevice = -1;
            this.selectedRandomId = '';
            this.receiverReady = false;
            if (previous) {
              this.getDeviceService().unregisterMessageReceiver(previous)
                .catch((error: Error) => {
                  this.deviceStatus += '；注销旧接收器失败：' + error.message;
                });
            }
          }

          // 只有可恢复的短暂错误才排定有退避上限的自动重试；
          // 1008509999（应用身份未配置）等确定性失败立即停下。
          const plan = planRetry(this.autoRetryCount,
            result.ok ? { ok: true } : notice);
          if (plan.retry) {
            this.autoRetryCount = plan.attempt;
            this.deviceStatus = notice.text +
              '（自动重试 ' + plan.attempt + '/' + MAX_AUTO_RETRIES + '）';
            this.retryTimer = setTimeout(() => {
              this.retryTimer = -1;
              this.runDeviceRefreshFlow();
            }, plan.delayMs);
          } else {
            this.autoRetryCount = 0;
          }
        },
        end: () => {
          this.deviceBusy = false;
        }
      });
    } catch (error) {
      if (seq === this.refreshSeq) {
        const e = error as Error;
        this.deviceStatus = '设备发现异常：' + e.message;
      }
    }
  }

  // 注册/恢复同一个手表 → 手机消息接收回调。进度消息优先，
  // 未识别为进度的才交给传书状态机。
  private async registerReceiverFor(device: TargetDevice): Promise<boolean> {
    if (!isConfigured(WATCH_PEER) || this.transferService === null) {
      return false;
    }
    try {
      await this.getDeviceService().registerMessageReceiver(
        device, WATCH_PEER.bundleName, WATCH_PEER.fingerprint,
        (message: wearEngine.P2pMessage) => {
          const handled = this.syncService !== null &&
            this.syncService.onMessageFromWatch(message.content);
          if (!handled && this.transferService !== null) {
            this.transferService.onMessageFromWatch(message.content);
          }
        });
      this.receiverReady = true;
      return true;
    } catch (error) {
      this.deviceStatus += '；消息接收注册失败';
      return false;
    }
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
    this.selectedRandomId = device.randomId;
    this.deviceStatus = '已选择：' + device.name;
    if (!isConfigured(WATCH_PEER)) {
      this.deviceStatus += '；手表 Lite 公钥指纹未配置或格式错误，' +
        '发送将保持禁用';
    }
    await this.registerReceiverFor(device);
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
        recordReaderDiagnostic(context, 'import', 'fail');
        this.pickStatus = '导入失败：' + (result.reason || '未知原因');
        return;
      }
      recordReaderDiagnostic(context, 'import', 'ok');
      this.pickStatus = '已导入：' + result.book!.title +
        '（' + result.book!.bytes + ' 字节，' +
        result.book!.chapters.length + ' 章）';
      this.refresh();
      this.refreshProgress();
    } catch (error) {
      this.busy = false;
      this.pickStatus = '文件选择失败，请查看日志';
      console.error('suyue import error: ' + JSON.stringify(error));
    }
  }

  private async removeBook(book: BookMeta): Promise<void> {
    try {
      const result = await promptAction.showDialog({
        title: '删除书籍',
        message: '确定删除《' + book.title + '》？此操作不可恢复。',
        buttons: [
          { text: '取消', color: '#9ca3af' },
          { text: '删除', color: '#f87171' }
        ]
      });
      if (result.index === 1) {
        this.getRepository().remove(book.bookId);
        await this.getProgressStore().remove(book.bookId);
        await new ReaderKitStateStore(
          this.getUIContext().getHostContext() as common.UIAbilityContext)
          .removeLocation(book.bookId);
        this.refresh();
        this.refreshProgress();
        this.pickStatus = '已删除《' + book.title + '》';
      }
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
        '发送不可用：请先选择设备、配置手表 Lite 公钥指纹并成功注册回执';
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
    let lastFailure = '手表未确认入库';
    const ok = await this.transferService.sendBook(
      book, device, WATCH_PEER,
      {
        onProgress: (progress: TransferProgress) => {
          if (progress.transferId) {
            this.activeTransferId = progress.transferId;
          }
          if (progress.message) {
            lastFailure = progress.message;
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
      recordReaderDiagnostic(
        this.getUIContext().getHostContext() as common.UIAbilityContext,
        'transfer', 'ok');
      this.transferText = '《' + book.title + '》手表已确认入库';
      this.getRepository().markStatus(book.bookId,
        BookStatus.SENT);
    } else {
      recordReaderDiagnostic(
        this.getUIContext().getHostContext() as common.UIAbilityContext,
        'transfer', 'fail');
      this.transferText = '发送失败：' + lastFailure;
      this.getRepository().markStatus(book.bookId,
        BookStatus.TRANSFER_FAILED,
        lastFailure);
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

  private async syncReadingProgress(): Promise<void> {
    const device = this.devices[this.selectedDevice];
    if (this.syncService === null || device === undefined ||
        !this.receiverReady || !isConfigured(WATCH_PEER)) {
      this.syncText = '同步不可用：请先选择设备并成功注册消息接收';
      return;
    }
    await this.syncService.syncAll(device, WATCH_PEER);
  }

  private findBook(bookId: string): BookMeta | null {
    for (let i = 0; i < this.books.length; i++) {
      if (this.books[i].bookId === bookId) return this.books[i];
    }
    return null;
  }

  @Builder
  shelfBookCard(book: BookMeta) {
    Column() {
      Row() {
        Column() {
          Text(book.title).fontSize(17).fontWeight(FontWeight.Medium)
            .fontColor('#F4F4F5').maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(book.kind.toUpperCase() + ' · ' + book.chapters.length +
            ' 章 · ' + Math.ceil(book.bytes / 1024) + ' KB')
            .fontSize(12).fontColor('#9CA3AF').margin({ top: 6 })
        }
        .alignItems(HorizontalAlign.Start).layoutWeight(1)
        Text(book.status === BookStatus.SENT ? '已传书' : '本机可读')
          .fontSize(11).fontColor('#A7F3D0')
          .padding({ left: 9, right: 9, top: 5, bottom: 5 })
          .backgroundColor('#15382E').borderRadius(10)
      }
      .width('100%').onClick(() => { this.openReader(book); })

      Row() {
        Button(this.isReading(book.bookId) ? '继续阅读' : '开始阅读')
          .fontSize(13).height(34).backgroundColor('#314A69')
          .onClick(() => { this.openReader(book); })
        if (this.sortMode === 'manual') {
          Button('↑').fontSize(12).height(34).margin({ left: 8 })
            .onClick(() => { this.moveBook(book, -1); })
          Button('↓').fontSize(12).height(34).margin({ left: 6 })
            .onClick(() => { this.moveBook(book, 1); })
        }
        Button('删除').fontSize(12).height(34).margin({ left: 8 })
          .backgroundColor('#3A2529').fontColor('#FCA5A5')
          .onClick(() => { this.removeBook(book); })
      }
      .width('100%').margin({ top: 14 })
    }
    .alignItems(HorizontalAlign.Start).width('100%').padding(16)
    .backgroundColor('#20242C').borderRadius(16)
  }

  @Builder
  shelfPanel() {
    Scroll() {
      Column({ space: 16 }) {
        Column({ space: 6 }) {
          Text('素阅').fontSize(30).fontWeight(FontWeight.Bold)
            .fontColor('#F4F4F5')
          Text('本地书架 · 阅读与传书共用同一书库')
            .fontSize(14).fontColor('#9CA3AF')
        }
        .alignItems(HorizontalAlign.Start).width('100%')

        Row() {
          Column() {
            Text('你的书架').fontSize(18).fontWeight(FontWeight.Medium)
              .fontColor('#F4F4F5')
            Text(this.books.length + ' 本书 · 点卡片继续阅读')
              .fontSize(12).fontColor('#A7ABB4').margin({ top: 4 })
          }
          .alignItems(HorizontalAlign.Start).layoutWeight(1)
          Button(this.busy ? '导入中…' : '导入 TXT / EPUB')
            .height(38).enabled(!this.busy)
            .onClick(() => { this.chooseBook(); })
        }
        .width('100%').padding(16).backgroundColor('#20242C')
        .borderRadius(16)

        if (this.pickStatus !== '可选择 TXT 或 EPUB 文件') {
          Text(this.pickStatus).fontSize(12).fontColor('#A7ABB4')
            .width('100%').maxLines(2)
        }

        Row() {
          Button('最近阅读').fontSize(12).height(32)
            .backgroundColor(this.sortMode === 'recent' ?
              '#314A69' : '#20242C')
            .onClick(() => { this.chooseSort('recent'); })
          Button('名称').fontSize(12).height(32).margin({ left: 6 })
            .backgroundColor(this.sortMode === 'title' ?
              '#314A69' : '#20242C')
            .onClick(() => { this.chooseSort('title'); })
          Button('导入时间').fontSize(12).height(32).margin({ left: 6 })
            .backgroundColor(this.sortMode === 'imported' ?
              '#314A69' : '#20242C')
            .onClick(() => { this.chooseSort('imported'); })
          Button('手动').fontSize(12).height(32).margin({ left: 6 })
            .backgroundColor(this.sortMode === 'manual' ?
              '#314A69' : '#20242C')
            .onClick(() => { this.chooseSort('manual'); })
        }
        .width('100%')

        if (this.books.length === 0) {
          Column() {
            Text('书架还是空的').fontSize(17).fontColor('#E5E7EB')
            Text('导入 TXT 或 EPUB 后，书籍会保存在素阅的私有书库中。')
              .fontSize(13).fontColor('#9CA3AF').margin({ top: 6 })
          }
          .alignItems(HorizontalAlign.Start).width('100%')
          .padding(18).backgroundColor('#20242C').borderRadius(16)
        } else {
          ForEach(this.books, (book: BookMeta) => {
            this.shelfBookCard(book)
          }, (book: BookMeta) => book.bookId)
        }

        Row() {
          Text('诊断日志只含阶段、时间和错误码，不记录正文、书名或路径。')
            .fontSize(11).fontColor('#8E96A3').layoutWeight(1)
          Button('导出日志').fontSize(12).height(32)
            .onClick(() => { this.exportDiagnostics(); })
        }
        .width('100%').padding({ top: 8, bottom: 8 })
        if (this.diagnosticsText.length > 0) {
          Text(this.diagnosticsText).fontSize(12).fontColor('#A7ABB4')
            .width('100%')
        }
      }
      .alignItems(HorizontalAlign.Start).width('100%')
      .padding({ left: 20, right: 20, top: 24, bottom: 18 })
    }
    .layoutWeight(1).width('100%').scrollBar(BarState.Auto)
  }

  @Builder
  transferBookOption(book: BookMeta) {
    Row() {
      Column() {
        Text(book.title).fontSize(14).fontColor('#F4F4F5')
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(book.kind.toUpperCase() + ' · ' + book.chapters.length + ' 章')
          .fontSize(11).fontColor('#9CA3AF').margin({ top: 4 })
      }
      .alignItems(HorizontalAlign.Start).layoutWeight(1)
      Text(this.selectedTransferBookId === book.bookId ? '已选择' : '选择')
        .fontSize(12).fontColor(this.selectedTransferBookId === book.bookId ?
          '#93C5FD' : '#A7ABB4')
    }
    .width('100%').padding(14).backgroundColor(
      this.selectedTransferBookId === book.bookId ? '#26384C' : '#20242C')
    .borderRadius(12).onClick(() => {
      this.selectedTransferBookId = book.bookId;
    })
  }

  @Builder
  transferPanel() {
    Scroll() {
      Column({ space: 16 }) {
        Column({ space: 6 }) {
          Text('传书').fontSize(28).fontWeight(FontWeight.Bold)
            .fontColor('#F4F4F5')
          Text('从同一个本地书库选择书籍发送到 GT Lite')
            .fontSize(14).fontColor('#9CA3AF')
        }
        .alignItems(HorizontalAlign.Start).width('100%')

        Column({ space: 10 }) {
          Row() {
            Text('选择书籍').fontSize(18)
              .fontWeight(FontWeight.Medium).fontColor('#F4F4F5')
              .layoutWeight(1)
            Text(this.books.length + ' 本').fontSize(12)
              .fontColor('#9CA3AF')
          }
          .width('100%')
          if (this.books.length === 0) {
            Text('先到书架导入 TXT 或 EPUB。').fontSize(13)
              .fontColor('#A7ABB4')
          } else {
            ForEach(this.books, (book: BookMeta) => {
              this.transferBookOption(book)
            }, (book: BookMeta) => book.bookId)
          }
          if (this.findBook(this.selectedTransferBookId) !== null) {
            Button(this.sending ? '正在发送…' : '发送到已选手表')
              .width('100%').height(42).enabled(this.canSend() &&
                this.canTransferBook(this.findBook(
                  this.selectedTransferBookId)!))
              .onClick(() => {
                const selected = this.findBook(this.selectedTransferBookId);
                if (selected !== null) this.sendBook(selected);
              })
          }
          if (this.sending) {
            Button('取消发送').height(34).backgroundColor('#7F1D1D')
              .onClick(() => { this.cancelSend(); })
          }
          Text(this.transferText).fontSize(13)
            .fontColor(this.sending ? '#FACC15' : '#A7ABB4')
            .width('100%')
        }
        .alignItems(HorizontalAlign.Start).width('100%')
        .padding(16).backgroundColor('#16181D').borderRadius(16)

        Column({ space: 10 }) {
          Text('手表连接').fontSize(18).fontWeight(FontWeight.Medium)
            .fontColor('#F4F4F5')
          Text(this.deviceStatus).fontSize(13).fontColor('#A7ABB4')
            .width('100%')
          if (this.identityStatus.length > 0) {
            Text(this.identityStatus).fontSize(12).fontColor('#FCA5A5')
              .width('100%')
          }
          if (this.devices.length > 0) {
            Row() {
              ForEach(this.devices, (device: TargetDevice,
                index: number) => {
                Button(device.name)
                  .fontSize(12).height(32)
                  .backgroundColor(this.selectedDevice === index ?
                    '#314A69' : '#101114')
                  .margin({ right: 8 })
                  .onClick(() => { this.selectDevice(index); })
              }, (device: TargetDevice) => device.randomId)
            }
          }
          Button(this.deviceBusy ? '正在查找…' : '刷新设备')
            .fontSize(13).height(34).enabled(!this.deviceBusy)
            .onClick(() => { this.refreshDevices(); })
          if (this.findBook(this.selectedTransferBookId) !== null &&
              this.findBook(this.selectedTransferBookId)!.progressMapping ===
                'readerkit_unmapped') {
            Text('所选书籍的 Reader Kit 位置暂不能换算为 UTF-8 字节偏移。这本书的进度同步会跳过，旧进度仍保留。')
              .fontSize(12).fontColor('#FCD34D').width('100%')
          }
          Button('同步可映射书籍的阅读进度')
            .fontSize(13).height(36)
            .enabled(this.selectedDevice >= 0 && this.receiverReady &&
              isConfigured(WATCH_PEER))
            .onClick(() => { this.syncReadingProgress(); })
          Text(this.syncText).fontSize(12).fontColor('#93C5FD')
            .width('100%')
        }
        .alignItems(HorizontalAlign.Start).width('100%')
        .padding(16).backgroundColor('#20242C').borderRadius(16)
      }
      .alignItems(HorizontalAlign.Start).width('100%')
      .padding({ left: 20, right: 20, top: 24, bottom: 18 })
    }
    .layoutWeight(1).width('100%').scrollBar(BarState.Auto)
  }

  @Builder
  bottomTabs() {
    Row() {
      Button('书架')
        .layoutWeight(1).height(52).fontSize(14)
        .fontColor(this.activeTab === 'shelf' ? '#F4F4F5' : '#8E96A3')
        .backgroundColor(this.activeTab === 'shelf' ? '#26384C' : '#15171C')
        .onClick(() => { this.selectTab('shelf'); })
      Button('传书')
        .layoutWeight(1).height(52).fontSize(14)
        .margin({ left: 10 })
        .fontColor(this.activeTab === 'transfer' ? '#F4F4F5' : '#8E96A3')
        .backgroundColor(this.activeTab === 'transfer' ? '#26384C' : '#15171C')
        .onClick(() => { this.selectTab('transfer'); })
    }
    .width('100%').padding({ left: 16, right: 16, top: 8, bottom: 10 })
    .backgroundColor('#101114')
  }

  private async exportDiagnostics(): Promise<void> {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    try {
      const saved = await exportReaderDiagnostics(context);
      this.diagnosticsText = saved ? '诊断日志已导出。' : '已取消导出。';
    } catch (error) {
      recordReaderDiagnostic(context, 'diagnostics', 'export_fail');
      this.diagnosticsText = '导出失败，请重试。';
    }
  }

  build() {
    Column() {
      if (this.activeTab === 'shelf') {
        this.shelfPanel()
      } else {
        this.transferPanel()
      }
      this.bottomTabs()
    }
    .width('100%').height('100%').backgroundColor('#101114')
  }
}
