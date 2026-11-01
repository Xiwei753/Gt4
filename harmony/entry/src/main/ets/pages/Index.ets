// SPDX-License-Identifier: GPL-3.0-only
// 手机端首页：真实书库列表 + TXT/EPUB 导入 +
// Wear Engine 发送到 GT 4。
// 选择文件 ≠ 导入成功：只有复制进沙箱、解析、
// 登记后才显示 ready。
// 文件发送成功由 Wear Engine transferFile 回调确认；
// 手表校验和入库结果未知；未选择目标设备时发送保持禁用。
import { common } from '@kit.AbilityKit';
import { picker } from '@kit.CoreFileKit';
import { promptAction, router } from '@kit.ArkUI';
import { wearEngine } from '@kit.WearEngine';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { APP_SYSTEM_DARK_KEY, APP_THEME_MODE_KEY, AppThemePalette,
  AppThemeMode, isDarkTheme, themePalette } from '../services/AppTheme';
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
import { AppThemeStore, applyNativeThemeMode }
  from '../services/AppThemeStore';
import { exportReaderDiagnostics, ReaderDiagnosticsExportError,
  recordReaderDiagnostic }
  from '../services/ReaderDiagnostics';
import { WearDeviceService, WearDeviceListResult } from '../services/WearDeviceService';
import { BookTransferService } from '../services/BookTransferService';
import { ReadingSyncService } from '../services/ReadingSyncService';
import { deviceNotice, runDeviceRefresh } from '../services/WearAuthPolicy';
import { ReaderWindowInsets, setAppWindowTheme, showShelfWindow }
  from '../services/ReaderWindowAppearance';

interface SdkCodeCarrier {
  code?: number;
}

// 双端身份严格分离（issue #13）：
//   WATCH_PEER：手机发送时使用的对端 GT 4 Lite 身份
//     使用 con.xiwei.suyue.gt4_Base64(原始 EC 公钥点)；
//   PHONE_SELF：手机 APP ID，供手表登记“消息来自哪部手机”，
//     不是 OAuth Client ID，也不是证书 SHA-256。
// 两者方向、格式不同，互不代替；任一方为空/格式错误时发送明确禁用。

@Entry
@Component
struct Index {
  @State private books: BookMeta[] = [];
  @State private progressSummaries: ReadingSummary[] = [];
  @StorageLink(APP_THEME_MODE_KEY) @Watch('themeStateChanged')
  private themeMode: AppThemeMode = 'system';
  @StorageLink(APP_SYSTEM_DARK_KEY) @Watch('themeStateChanged')
  private systemDark: boolean = false;
  @State private activeTab: string = 'shelf';
  @State private sortMode: ShelfSortMode = 'recent';
  @State private selectedTransferBookId: string = '';
  @State private diagnosticsText: string = '';
  @State private shelfMenuVisible: boolean = false;
  @State private manageBooks: boolean = false;
  @State private safeTop: number = 0;
  @State private safeBottom: number = 0;
  @State private safeLeft: number = 0;
  @State private safeRight: number = 0;
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
  private onWindowInsets = (insets: ReaderWindowInsets): void => {
    this.safeTop = insets.top;
    this.safeBottom = insets.bottom;
    this.safeLeft = insets.left;
    this.safeRight = insets.right;
  };

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
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    // Shelf and Reader share one persistent immersive window; only theme and
    // safe-area padding change as navigation returns to this page.
    showShelfWindow(context, this.themeMode, this.isDarkTheme(),
      this.onWindowInsets);
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

  // No automatic device-discovery retries: user-initiated refresh makes
  // one request; leaving the page invalidates any in-flight result.
  onPageHide(): void {
    this.refreshSeq++;
  }

  onDisappear(): void {
    this.refreshSeq++;
  }

  private isDarkTheme(): boolean {
    return isDarkTheme(this.themeMode, this.systemDark);
  }

  private palette(): AppThemePalette {
    return themePalette(this.themeMode, this.systemDark);
  }

  private themeStateChanged(): void {
    setAppWindowTheme(this.themeMode, this.isDarkTheme());
  }

  private chooseTheme(mode: AppThemeMode): void {
    this.themeMode = mode;
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    new AppThemeStore(context).save(mode).catch((error: Error) => {
      recordReaderDiagnostic(context, 'theme', 'save_fail');
    });
    applyNativeThemeMode(context, mode);
    setAppWindowTheme(mode, isDarkTheme(mode, this.systemDark));
    this.shelfMenuVisible = false;
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
    this.shelfMenuVisible = false;
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
  // 同一时间最多 1 个在途请求，只有最新一轮结果落地；失败后由用户手动刷新。
  private async refreshDevices(): Promise<void> {
    if (this.deviceBusy) return;
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
          if (!result.ok) {
            const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
            recordReaderDiagnostic(context, 'device', 'discover_fail',
              result.code, { source: result.stage, reason: notice.kind });
          }
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

          // Discovery failure is terminal for this request. The user may
          // manually refresh again; do not schedule another SDK request.
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

  // 注册/恢复同一个手表 → 手机消息接收回调，供阅读进度同步使用。
  private async registerReceiverFor(device: TargetDevice): Promise<boolean> {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    if (!isConfigured(WATCH_PEER) || this.transferService === null) {
      recordReaderDiagnostic(context, 'device', 'receiver_register_fail', 0, {
        source: 'registerMessageReceiver',
        reason: !isConfigured(WATCH_PEER) ? 'E_PEER_IDENTITY_UNCONFIGURED' :
          'E_TRANSFER_SERVICE_UNAVAILABLE',
        deviceSelected: this.selectedRandomId === device.randomId,
        receiverReady: this.receiverReady
      });
      return false;
    }
    recordReaderDiagnostic(context, 'device', 'receiver_register_start', 0, {
      source: 'registerMessageReceiver',
      deviceSelected: this.selectedRandomId === device.randomId,
      receiverReady: this.receiverReady
    });
    try {
      await this.getDeviceService().registerMessageReceiver(
        device, WATCH_PEER.bundleName, WATCH_PEER.fingerprint,
        (message: wearEngine.P2pMessage) => {
          if (this.syncService !== null) {
            this.syncService.onMessageFromWatch(message.content);
          }
        });
      const deviceSelected = this.selectedRandomId === device.randomId;
      if (deviceSelected) this.receiverReady = true;
      recordReaderDiagnostic(context, 'device', 'receiver_register_success', 0, {
        source: 'registerMessageReceiver',
        deviceSelected: deviceSelected,
        receiverReady: this.receiverReady
      });
      return deviceSelected;
    } catch (error) {
      const failure = error as SdkCodeCarrier;
      const message = error instanceof Error ? error.message : String(error);
      const codeMatch = /(?:code|failed:)\s*(-?\d+)/i.exec(message);
      const code = typeof failure.code === 'number' ? failure.code :
        codeMatch !== null ? Number(codeMatch[1]) : 0;
      const deviceSelected = this.selectedRandomId === device.randomId;
      if (deviceSelected) this.receiverReady = false;
      recordReaderDiagnostic(context, 'device', 'receiver_register_fail',
        code, {
          source: 'registerMessageReceiver',
          reason: code === 0 ? 'E_REGISTER_FAILED' : 'E_SDK_REGISTER_FAILED',
          deviceSelected: deviceSelected,
          receiverReady: this.receiverReady
        });
      if (deviceSelected) {
        this.deviceStatus += '；消息接收注册失败（' + code + '）';
      }
      return false;
    }
  }

  private async selectDevice(e: number): Promise<void> {
    if (e < 0 || e >= this.devices.length) return;
    const previous = this.devices[this.selectedDevice];
    const device = this.devices[e];
    // Mark progress sync unavailable until the receiver is registered for
    // the selected device. File sending uses its independent transfer channel.
    this.receiverReady = false;
    this.selectedDevice = e;
    this.selectedRandomId = device.randomId;
    this.deviceStatus = '已选择：' + device.name;
    if (previous && previous.randomId !== device.randomId) {
      await this.getDeviceService().unregisterMessageReceiver(previous);
    }
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
    if (this.sending) return;
    if (!this.canSend() || this.transferService === null) {
      this.transferText =
        '发送不可用：请先选择设备并配置手表 Lite 公钥指纹';
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
    let lastFailure = '文件传输尚未完成';
    let lastPhase = 'PEER_CHECK';
    let lastError = 'E_UNKNOWN';
    let wasCancelled = false;
    let lastSdkCode = 0;
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    recordReaderDiagnostic(context, 'transfer', 'start', 0, {
      source: 'sendBook',
      receiverReady: this.receiverReady,
      deviceSelected: this.selectedRandomId === device.randomId,
      peerConfigured: isConfigured(WATCH_PEER)
    });
    const ok = await this.transferService.sendBook(
      book, device, WATCH_PEER,
      {
        onProgress: (progress: TransferProgress) => {
          wasCancelled = progress.state === TransferState.CANCELLED;
          if (progress.transferId) {
            this.activeTransferId = progress.transferId;
          }
          if (progress.phase && progress.phase !== lastPhase) {
            lastPhase = progress.phase;
            recordReaderDiagnostic(context, 'transfer', 'phase', 0,
              { source: lastPhase });
          }
          if (progress.error) lastError = progress.error;
          if (progress.sdkCode !== undefined) {
            lastSdkCode = progress.sdkCode;
          }
          if (progress.message) lastFailure = progress.message;
          this.transferText = progress.message +
            (progress.percent > 0 &&
              progress.state === TransferState.SENDING ?
              '（' + progress.percent + '%）' : '');
        },
        onChapterChunk: (index: number, total: number,
          result: 'sent' | 'send_failed') => {
          const stage = result === 'sent' ? 'chapter_sent' :
            'chapter_send_failed';
          recordReaderDiagnostic(context, 'transfer', stage, 0, {
            chapterIndex: index,
            chapterTotal: total,
            chapterStatus: result
          });
        }
      });
    this.sending = false;
    this.activeTransferId = '';
    if (ok) {
      recordReaderDiagnostic(
        this.getUIContext().getHostContext() as common.UIAbilityContext,
        'transfer', 'ok');
      this.transferText = '《' + book.title + '》文件已发送；手表侧校验和入库未确认';
      this.getRepository().markStatus(book.bookId,
        BookStatus.SENT);
    } else if (wasCancelled) {
      recordReaderDiagnostic(context, 'transfer', 'cancelled', 0,
        { source: lastPhase, reason: 'E_CANCELLED' });
      this.transferText = '已取消传书';
    } else {
      recordReaderDiagnostic(context, 'transfer', 'fail', lastSdkCode,
        { source: lastPhase, reason: lastError });
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
    this.transferText = '已发送取消请求；手表侧清理结果未确认';
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
  bookCover(book: BookMeta) {

    Stack({ alignContent: Alignment.Center }) {
      if (book.coverFilePath && book.coverFilePath.length > 0) {
        Image('file://' + book.coverFilePath)
          .width('100%').height('100%').objectFit(ImageFit.Cover)
      } else {
        Column() {
          Text(book.title.substring(0, Math.min(2, book.title.length)))
            .fontSize(22).fontWeight(FontWeight.Medium)
            .fontColor(this.palette().coverText).maxLines(1)
          Text('素阅').fontSize(10).fontColor(this.palette().coverText)
            .margin({ top: 10 })
        }
        .width('100%').height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor(this.palette().cover)
      }
    }
    .width(72).height(100).borderRadius(8).clip(true)
  }

  private progressLabel(book: BookMeta): string {
    for (let i = 0; i < this.progressSummaries.length; i++) {
      const summary = this.progressSummaries[i];
      if (summary.bookId === book.bookId && book.bytes > 0 &&
          book.progressMapping !== 'readerkit_unmapped') {
        const percent = Math.max(0, Math.min(100,
          Math.floor(summary.offset / book.bytes * 100)));
        return percent + '% · 最近阅读';
      }
    }
    return book.kind.toUpperCase() + ' · ' + book.chapters.length + ' 章';
  }

  @Builder
  shelfBookCard(book: BookMeta) {

    Row({ space: 12 }) {
      this.bookCover(book)
      Column({ space: 5 }) {
        Text(book.title).fontSize(16).fontWeight(FontWeight.Medium)
          .fontColor(this.palette().text).maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        if (book.author && book.author.length > 0) {
          Text(book.author).fontSize(12).fontColor(this.palette().secondaryText)
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }
        Text(this.progressLabel(book)).fontSize(12)
          .fontColor(this.palette().secondaryText).maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        if (this.manageBooks) {
          Row({ space: 6 }) {
            if (this.sortMode === 'manual') {
              Button('上移').fontSize(11).height(28)
                .onClick(() => { this.moveBook(book, -1); })
              Button('下移').fontSize(11).height(28)
                .onClick(() => { this.moveBook(book, 1); })
            }
            Button('删除').fontSize(11).height(28)
              .fontColor(this.palette().secondaryText)
              .onClick(() => { this.removeBook(book); })
          }
        }
      }
      .alignItems(HorizontalAlign.Start).layoutWeight(1)
    }
    .width('100%').alignItems(VerticalAlign.Center)
    .padding(9).backgroundColor(this.palette().surface)
    .borderRadius(10).border({ width: 1, color: this.palette().border })
    .onClick(() => { this.openReader(book); })
  }

  @Builder
  shelfPanel() {

    List({ space: 8 }) {
      ListItem() {
        Row() {
          Text('素阅').fontSize(21).fontWeight(FontWeight.Medium)
            .fontColor(this.palette().text)
          Text(this.books.length + ' 本').fontSize(12)
            .fontColor(this.palette().secondaryText).margin({ left: 8 })
          Blank().layoutWeight(1)
          Text(this.busy ? '…' : '+').fontSize(23)
            .width(40).height(40).textAlign(TextAlign.Center)
            .backgroundColor(this.palette().surfaceRaised)
            .fontColor(this.palette().text).borderRadius(10)
            .onClick(() => { if (!this.busy) this.chooseBook(); })
          Text(this.shelfMenuVisible ? '×' : '···').fontSize(19)
            .width(40).height(40).margin({ left: 6 })
            .textAlign(TextAlign.Center)
            .backgroundColor(this.palette().surfaceRaised)
            .fontColor(this.palette().text).borderRadius(10)
            .onClick(() => {
              this.shelfMenuVisible = !this.shelfMenuVisible;
            })
        }
        .width('100%').padding({ top: this.safeTop + 2, bottom: 2 })
      }
      if (this.shelfMenuVisible) {
        ListItem() {
          Column({ space: 8 }) {
            Text('排序方式').fontSize(12).fontColor(this.palette().mutedText)
            Row({ space: 5 }) {
              Button('最近阅读').fontSize(11).height(30)
                .backgroundColor(this.sortMode === 'recent' ?
                  this.palette().surfaceSelected : this.palette().surfaceRaised)
                .fontColor(this.palette().text)
                .onClick(() => { this.chooseSort('recent'); })
              Button('名称').fontSize(11).height(30)
                .backgroundColor(this.sortMode === 'title' ?
                  this.palette().surfaceSelected : this.palette().surfaceRaised)
                .fontColor(this.palette().text)
                .onClick(() => { this.chooseSort('title'); })
              Button('导入时间').fontSize(11).height(30)
                .backgroundColor(this.sortMode === 'imported' ?
                  this.palette().surfaceSelected : this.palette().surfaceRaised)
                .fontColor(this.palette().text)
                .onClick(() => { this.chooseSort('imported'); })
              Button('手动').fontSize(11).height(30)
                .backgroundColor(this.sortMode === 'manual' ?
                  this.palette().surfaceSelected : this.palette().surfaceRaised)
                .fontColor(this.palette().text)
                .onClick(() => { this.chooseSort('manual'); })
            }
            Text('主题').fontSize(12).fontColor(this.palette().mutedText)
              .margin({ top: 3 })
            Row({ space: 5 }) {
              Button('跟随系统').fontSize(11).height(30)
                .backgroundColor(this.themeMode === 'system' ?
                  this.palette().surfaceSelected : this.palette().surfaceRaised)
                .fontColor(this.palette().text)
                .onClick(() => { this.chooseTheme('system'); })
              Button('浅色').fontSize(11).height(30)
                .backgroundColor(this.themeMode === 'light' ?
                  this.palette().surfaceSelected : this.palette().surfaceRaised)
                .fontColor(this.palette().text)
                .onClick(() => { this.chooseTheme('light'); })
              Button('深色').fontSize(11).height(30)
                .backgroundColor(this.themeMode === 'dark' ?
                  this.palette().surfaceSelected : this.palette().surfaceRaised)
                .fontColor(this.palette().text)
                .onClick(() => { this.chooseTheme('dark'); })
            }
            Row() {
              Button(this.manageBooks ? '完成整理' : '整理书架')
                .fontSize(12).height(32).backgroundColor(this.palette().surfaceRaised)
                .fontColor(this.palette().text)
                .onClick(() => { this.manageBooks = !this.manageBooks; })
              Blank().layoutWeight(1)
              Button('导出诊断日志').fontSize(12).height(32)
                .backgroundColor(this.palette().surfaceRaised).fontColor(this.palette().text)
                .onClick(() => { this.exportDiagnostics(); })
            }
            .width('100%').margin({ top: 2 })
            if (this.diagnosticsText.length > 0) {
              Text(this.diagnosticsText).fontSize(12)
                .fontColor(this.palette().secondaryText).width('100%')
            }
          }
          .alignItems(HorizontalAlign.Start).width('100%').padding(11)
          .backgroundColor(this.palette().surface)
          .borderRadius(10).border({ width: 1, color: this.palette().border })
        }
      }
      if (this.pickStatus !== '可选择 TXT 或 EPUB 文件') {
        ListItem() {
          Text(this.pickStatus).fontSize(12).fontColor(this.palette().secondaryText)
            .width('100%').maxLines(2)
        }
      }
      if (this.books.length === 0) {
        ListItem() {
          Column() {
            Text('书架还是空的').fontSize(17).fontColor(this.palette().text)
            Text('导入 TXT 或 EPUB 后，书籍会保存在素阅的私有书库中。')
              .fontSize(13).fontColor(this.palette().secondaryText).margin({ top: 6 })
          }
          .alignItems(HorizontalAlign.Start).width('100%')
          .padding(18).backgroundColor(this.palette().surface).borderRadius(10)
          .border({ width: 1, color: this.palette().border })
        }
      } else {
        ForEach(this.books, (book: BookMeta) => {
          ListItem() { this.shelfBookCard(book) }
        }, (book: BookMeta) => book.bookId)
      }
    }
    .layoutWeight(1).width('100%').scrollBar(BarState.Auto)
    .padding({ left: 14 + this.safeLeft, right: 14 + this.safeRight,
      bottom: 10 })
  }

  @Builder
  transferBookOption(book: BookMeta) {

    Row() {
      Column() {
        Text(book.title).fontSize(14).fontColor(this.palette().text)
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(book.kind.toUpperCase() + ' · ' + book.chapters.length + ' 章')
          .fontSize(11).fontColor(this.palette().secondaryText).margin({ top: 4 })
      }
      .alignItems(HorizontalAlign.Start).layoutWeight(1)
      Text(this.selectedTransferBookId === book.bookId ? '已选择' : '选择')
        .fontSize(12).fontColor(this.selectedTransferBookId === book.bookId ?
          this.palette().accent : this.palette().secondaryText)
    }
    .width('100%').padding(14).backgroundColor(
      this.selectedTransferBookId === book.bookId ?
        this.palette().surfaceSelected : this.palette().surface)
    .borderRadius(10).border({ width: 1, color: this.palette().border })
    .onClick(() => {
      this.selectedTransferBookId = book.bookId;
    })
  }

  @Builder
  transferPanel() {
    List({ space: 8 }) {
      ListItem() {
        Row() {
          Text('传书').fontSize(21).fontWeight(FontWeight.Medium)
            .fontColor(this.palette().text)
          Blank().layoutWeight(1)
          Text('从本地书库选择').fontSize(12)
            .fontColor(this.palette().secondaryText)
        }
        .width('100%').padding({ top: this.safeTop + 2, bottom: 2 })
      }
      ListItem() {
        Row() {
          Text('选择书籍').fontSize(16).fontWeight(FontWeight.Medium)
            .fontColor(this.palette().text).layoutWeight(1)
          Text(this.books.length + ' 本').fontSize(12)
            .fontColor(this.palette().secondaryText)
        }
        .width('100%').padding({ top: 3, bottom: 1 })
      }
      if (this.books.length === 0) {
        ListItem() {
          Text('先到书架导入 TXT 或 EPUB。').fontSize(13)
            .fontColor(this.palette().secondaryText).width('100%')
            .padding(13).backgroundColor(this.palette().surface)
            .borderRadius(10)
        }
      } else {
        ForEach(this.books, (book: BookMeta) => {
          ListItem() { this.transferBookOption(book) }
        }, (book: BookMeta) => book.bookId)
      }
      if (this.findBook(this.selectedTransferBookId) !== null) {
        ListItem() {
          Column({ space: 8 }) {
            Button(this.sending ? '正在发送…' : '发送到已选手表')
              .width('100%').height(40).enabled(!this.sending &&
                this.canSend() &&
                this.canTransferBook(this.findBook(
                  this.selectedTransferBookId)!))
              .backgroundColor(this.palette().accent)
              .fontColor(this.palette().accentText)
              .onClick(() => {
                const selected = this.findBook(this.selectedTransferBookId);
                if (selected !== null) this.sendBook(selected);
              })
            if (this.sending) {
              Button('取消发送').height(34)
                .backgroundColor(this.palette().warningSurface)
                .fontColor(this.palette().warningText)
                .onClick(() => { this.cancelSend(); })
            }
            Text(this.transferText).fontSize(13)
              .fontColor(this.sending ? this.palette().warningText :
                this.palette().secondaryText).width('100%')
          }
          .width('100%').padding(12).backgroundColor(this.palette().surface)
          .borderRadius(10).border({ width: 1, color: this.palette().border })
        }
      }
      ListItem() {
        Column({ space: 9 }) {
          Text('手表连接').fontSize(16).fontWeight(FontWeight.Medium)
            .fontColor(this.palette().text)
          Text(this.deviceStatus).fontSize(13)
            .fontColor(this.palette().secondaryText).width('100%')
          if (this.identityStatus.length > 0) {
            Text(this.identityStatus).fontSize(12)
              .fontColor(this.palette().warningText).width('100%')
          }
          if (this.devices.length > 0) {
            Row() {
              ForEach(this.devices, (device: TargetDevice,
                index: number) => {
                Button(device.name).fontSize(12).height(32)
                  .backgroundColor(this.selectedDevice === index ?
                    this.palette().surfaceSelected :
                    this.palette().surfaceRaised)
                  .fontColor(this.palette().text).margin({ right: 8 })
                  .onClick(() => { this.selectDevice(index); })
              }, (device: TargetDevice) => device.randomId)
            }
          }
          Button(this.deviceBusy ? '正在查找…' : '刷新设备')
            .fontSize(13).height(34).enabled(!this.deviceBusy)
            .backgroundColor(this.palette().surfaceRaised)
            .fontColor(this.palette().text)
            .onClick(() => { this.refreshDevices(); })
          if (this.findBook(this.selectedTransferBookId) !== null &&
              this.findBook(this.selectedTransferBookId)!.progressMapping ===
                'readerkit_unmapped') {
            Text('这本书的旧阅读位置尚未验证为 UTF-8 字节偏移，进度同步会暂时跳过。')
              .fontSize(12).fontColor(this.palette().warningText).width('100%')
          }
          Button('同步可映射书籍的阅读进度')
            .fontSize(13).height(36)
            .backgroundColor(this.palette().surfaceRaised)
            .fontColor(this.palette().text)
            .enabled(this.selectedDevice >= 0 && this.receiverReady &&
              isConfigured(WATCH_PEER))
            .onClick(() => { this.syncReadingProgress(); })
          Text(this.syncText).fontSize(12)
            .fontColor(this.palette().secondaryText).width('100%')
        }
        .alignItems(HorizontalAlign.Start).width('100%').padding(12)
        .backgroundColor(this.palette().surface).borderRadius(10)
        .border({ width: 1, color: this.palette().border })
      }
    }
    .layoutWeight(1).width('100%').scrollBar(BarState.Auto)
    .padding({ left: 14 + this.safeLeft, right: 14 + this.safeRight,
      bottom: 10 })
  }

  @Builder
  bottomTabs() {

    Row() {
      Column({ space: 2 }) {
        Text('▤').fontSize(19)
          .fontColor(this.activeTab === 'shelf' ? this.palette().accent :
            this.palette().mutedText)
        Text('书架').fontSize(11)
          .fontColor(this.activeTab === 'shelf' ? this.palette().text :
            this.palette().secondaryText)
      }
      .layoutWeight(1).height(49).justifyContent(FlexAlign.Center)
      .backgroundColor(this.palette().page)
      .onClick(() => { this.selectTab('shelf'); })
      Column({ space: 2 }) {
        Text('↗').fontSize(19)
          .fontColor(this.activeTab === 'transfer' ? this.palette().accent :
            this.palette().mutedText)
        Text('传书').fontSize(11)
          .fontColor(this.activeTab === 'transfer' ? this.palette().text :
            this.palette().secondaryText)
      }
      .layoutWeight(1).height(49).justifyContent(FlexAlign.Center)
      .backgroundColor(this.palette().page)
      .onClick(() => { this.selectTab('transfer'); })
    }
    .width('100%').padding({ left: 12 + this.safeLeft,
      right: 12 + this.safeRight, top: 5, bottom: 6 + this.safeBottom })
    .backgroundColor(this.palette().page)
  }

  private async exportDiagnostics(): Promise<void> {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    try {
      const saved = await exportReaderDiagnostics(context);
      this.diagnosticsText = saved ? '诊断日志已导出。' : '已取消导出。';
    } catch (error) {
      const failure = error instanceof ReaderDiagnosticsExportError ?
        error : null;
      const stage = failure !== null ? failure.stage : 'unknown';
      const code = failure !== null ? failure.code : 0;
      hilog.error(0x0000, 'suyue/Diagnostics',
        'export_fail stage=' + stage + ' code=' + code);
      recordReaderDiagnostic(context, 'diagnostics', 'export_fail', code,
        { reason: 'stage_' + stage });
      let stageLabel = '未知阶段';
      if (stage === 'empty') {
        this.diagnosticsText = '没有可导出的诊断记录，请先操作阅读页后重试。';
        return;
      }
      if (stage === 'picker') stageLabel = '文件选择器';
      else if (stage === 'open') stageLabel = '打开文件';
      else if (stage === 'write') stageLabel = '写入文件';
      else if (stage === 'close') stageLabel = '关闭文件';
      this.diagnosticsText = '导出失败：' + stageLabel + '，错误码 ' + code;
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
    .width('100%').height('100%').backgroundColor(this.palette().page)
    .expandSafeArea([SafeAreaType.SYSTEM],
      [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }
}
