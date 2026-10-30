// SPDX-License-Identifier: GPL-3.0-only
// Native ArkUI text pager over the normalized UTF-8 body shared with the
// bookshelf, transfer service and watch reading-progress protocol.
import { common } from '@kit.AbilityKit';
import { batteryInfo } from '@kit.BasicServicesKit';
import { router } from '@kit.ArkUI';
import { inputConsumer, KeyCode, KeyEvent } from '@kit.InputKit';
import { BookChapter, BookMeta } from '../model/BookModels';
import { paginateBackward, paginateForward,
  ReaderTextPage, recoverPreviousPageFromCheckpoint,
  READER_CHECKPOINT_PAGE_INTERVAL }
  from '../model/ReaderPagination';
import { BookRepository } from '../services/BookRepository';
import { NormalizedTextFile } from '../services/NormalizedTextFile';
import { ReadingProgressStore } from '../services/ReadingProgressStore';
import { ReaderSettings, ReaderSettingsStore }
  from '../services/ReaderSettingsStore';
import { AppThemePalette, AppThemeMode, APP_SYSTEM_DARK_KEY,
  APP_THEME_MODE_KEY, isDarkTheme, themePalette }
  from '../services/AppTheme';
import { AppThemeStore, applyNativeThemeMode }
  from '../services/AppThemeStore';
import { DiagnosticDetails, recordReaderDiagnostic }
  from '../services/ReaderDiagnostics';
import { enterReaderWindow, exitReaderWindow,
  refreshReaderWindowInsets, setAppWindowTheme, showShelfWindow,
  ReaderWindowCutout, ReaderWindowInsets }
  from '../services/ReaderWindowAppearance';

interface ReaderParams {
  bookId?: string;
}

interface ErrorCodeCarrier {
  code?: number;
}

interface ReaderSafeInterval {
  left: number;
  right: number;
}

interface ReaderHeaderLayout {
  titleX: number;
  titleWidth: number;
  infoX: number;
  infoWidth: number;
}

const READER_WINDOW_BYTES = 64 * 1024;
const READER_MAX_BACKWARD_WINDOW_BYTES = 512 * 1024;
const READER_POSITION_HISTORY_LIMIT = 12;
const READER_PAGINATION_CHECKPOINT_LIMIT = 32;
const READER_TEXT_FONT = 'HarmonyOS Sans';
const READER_CHAPTER_LABEL_HEIGHT_VP = 18;
const READER_CHAPTER_LABEL_GAP_VP = 8;
const READER_INPUT_FEEDBACK_MS = 1600;

@Entry
@Component
struct Reader {
  @State private title: string = '';
  @State private pageText: string = '';
  @State private loading: boolean = true;
  @State private readerAvailable: boolean = false;
  @State private status: string = '正在准备正文……';
  @State private controlsVisible: boolean = true;
  @State private settingsVisible: boolean = false;
  @State private catalogVisible: boolean = false;
  @State private chapters: BookChapter[] = [];
  @State private fontSize: number = 20;
  @State private lineHeight: number = 1.6;
  private flipMode: string = '1';
  @StorageLink(APP_THEME_MODE_KEY) @Watch('themeStateChanged')
  private themeMode: AppThemeMode = 'system';
  @StorageLink(APP_SYSTEM_DARK_KEY) @Watch('themeStateChanged')
  private systemDark: boolean = false;
  @State private chapterTitle: string = '';
  @State private safeTop: number = 0;
  @State private safeBottom: number = 0;
  @State private safeLeft: number = 0;
  @State private safeRight: number = 0;
  @State private statusBarHeight: number = 0;
  @State private navigationIndicatorLeftVp: number = 0;
  @State private navigationIndicatorTopVp: number = 0;
  @State private navigationIndicatorRightVp: number = 0;
  @State private navigationIndicatorBottomVp: number = 0;
  @State private headerTitleX: number = 12;
  @State private headerTitleMaxWidthVp: number = 0;
  @State private headerInfoX: number = 0;
  @State private headerInfoWidth: number = 0;
  @State private viewportWidthVp: number = 0;
  @State private viewportHeightVp: number = 0;
  @State private timeText: string = '--:--';
  @State private batteryPercent: number = -1;
  @State private volumeKeyPaging: boolean = true;

  private book: BookMeta | null = null;
  private repository: BookRepository | null = null;
  private progressStore: ReadingProgressStore | null = null;
  private settingsStore: ReaderSettingsStore | null = null;
  private textFile: NormalizedTextFile | null = null;
  private currentPage: ReaderTextPage | null = null;
  private settingsReady: boolean = false;
  private readerReady: boolean = false;
  private initialized: boolean = false;
  private initializing: boolean = false;
  private pageInForeground: boolean = false;
  private leaving: boolean = false;
  private windowInsetsReady: boolean = false;
  private viewportNeedsInsetsLayout: boolean = false;
  private resizeTimer: number = -1;
  private infoRefreshTimer: number = -1;
  private inputFeedbackTimer: number = -1;
  private pageRequestId: number = 0;
  private pageFlipInProgress: boolean = false;
  private pendingReflow: boolean = false;
  private volumeUpRegistered: boolean = false;
  private volumeDownRegistered: boolean = false;
  private volumeUpListener = (_event: KeyEvent): void => {
    this.flipPageFromVolumeKey(false, 'volume_up');
  };
  private volumeDownListener = (_event: KeyEvent): void => {
    this.flipPageFromVolumeKey(true, 'volume_down');
  };
  private previousPageStarts: number[] = [];
  private nextPageStarts: number[] = [];
  private paginationAnchors: number[] = [];
  private pagesSincePaginationAnchor: number = 0;
  private touchActive: boolean = false;
  private touchStartX: number = 0;
  private touchStartY: number = 0;
  private touchStartAt: number = 0;
  private onWindowInsets = (insets: ReaderWindowInsets): void => {
    this.applyWindowInsets(insets);
  };

  aboutToAppear(): void {
    const params = router.getParams() as ReaderParams;
    const bookId = params && typeof params.bookId === 'string' ?
      params.bookId : '';
    if (!bookId) {
      this.loading = false;
      this.status = '缺少书籍参数，无法打开阅读页';
      return;
    }

    const context = this.context();
    this.repository = new BookRepository(context);
    this.progressStore = new ReadingProgressStore(context);
    this.settingsStore = new ReaderSettingsStore(context);
    this.book = this.repository.get(bookId);
    if (this.book === null) {
      this.loading = false;
      this.status = '书籍不存在，或规范化正文文件已被删除';
      return;
    }

    this.title = this.book.title;
    this.chapters = this.book.chapters.slice();
    try {
      this.textFile = new NormalizedTextFile(this.book.filePath);
      if (this.textFile.byteLength !== this.book.bytes) {
        throw new Error('正文长度与书库记录不一致');
      }
      this.readerAvailable = true;
    } catch (error) {
      this.loading = false;
      this.status = '规范化正文不可用，请重新导入这本书；现有阅读进度会保留。';
      this.log('reader', 'body_open_fail', this.errorCode(error));
      return;
    }

    this.loadSettings().then((): void => {
      this.settingsReady = true;
      this.tryInitializeReader();
    }).catch((error: Error): void => {
      this.log('settings', 'load_fail', this.errorCode(error));
      this.settingsReady = true;
      this.tryInitializeReader();
    });
  }

  onPageShow(): void {
    this.pageInForeground = true;
    const context = this.context();
    if (this.readerAvailable && this.book !== null) {
      this.refreshReaderInfo();
      this.scheduleReaderInfoRefresh();
      enterReaderWindow(context, this.themeMode, this.isDarkTheme(),
        this.onWindowInsets);
    } else {
      showShelfWindow(context, this.themeMode, this.isDarkTheme(),
        this.onWindowInsets);
    }
    this.syncVolumeKeyListeners();
    this.log('reader', 'foreground');
  }

  onPageHide(): void {
    this.pageInForeground = false;
    this.clearInfoRefreshTimer();
    this.clearInputFeedbackTimer();
    this.syncVolumeKeyListeners();
    this.saveCurrentOffset();
  }

  onBackPress(): boolean {
    if (this.catalogVisible) {
      this.setCatalogVisible(false);
      return true;
    }
    if (this.settingsVisible) {
      this.settingsVisible = false;
      this.syncVolumeKeyListeners();
      return true;
    }
    this.backToShelf();
    return true;
  }

  aboutToDisappear(): void {
    this.leaving = true;
    this.pageInForeground = false;
    this.clearInfoRefreshTimer();
    this.clearInputFeedbackTimer();
    this.syncVolumeKeyListeners();
    if (this.resizeTimer !== -1) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = -1;
    }
    this.pageRequestId += 1;
    this.saveCurrentOffset();
    if (this.textFile !== null) this.textFile.close();
    exitReaderWindow();
  }

  private context(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  private formatTimePart(value: number): string {
    return value < 10 ? '0' + value.toString() : value.toString();
  }

  private refreshReaderInfo(): void {
    const now = new Date();
    this.timeText = this.formatTimePart(now.getHours()) + ':' +
      this.formatTimePart(now.getMinutes());
    try {
      const level = batteryInfo.batterySOC;
      this.batteryPercent = Number.isFinite(level) ?
        Math.min(100, Math.max(0, Math.round(level))) : -1;
    } catch (error) {
      this.batteryPercent = -1;
    }
  }

  private scheduleReaderInfoRefresh(): void {
    this.clearInfoRefreshTimer();
    if (!this.pageInForeground || this.leaving) return;
    const delay = 60000 - (Date.now() % 60000) + 50;
    this.infoRefreshTimer = setTimeout((): void => {
      this.infoRefreshTimer = -1;
      if (!this.pageInForeground || this.leaving) return;
      this.refreshReaderInfo();
      this.scheduleReaderInfoRefresh();
    }, delay);
  }

  private clearInfoRefreshTimer(): void {
    if (this.infoRefreshTimer === -1) return;
    clearTimeout(this.infoRefreshTimer);
    this.infoRefreshTimer = -1;
  }

  private shouldConsumeVolumeKeys(): boolean {
    return this.pageInForeground && this.readerReady && !this.loading &&
      !this.leaving && !this.catalogVisible && !this.settingsVisible &&
      this.volumeKeyPaging;
  }

  private syncVolumeKeyListeners(): void {
    if (this.shouldConsumeVolumeKeys()) {
      if (!this.volumeUpRegistered) {
        try {
          inputConsumer.on('keyPressed', {
            key: KeyCode.KEYCODE_VOLUME_UP,
            action: 1,
            isRepeat: false
          }, this.volumeUpListener);
          this.volumeUpRegistered = true;
          this.logReaderInput('volume_listener_registered', 'volume_up');
        } catch (error) {
          this.log('volumeKey', 'up_register_fail', this.errorCode(error));
          this.logReaderInput('volume_listener_register_fail', 'volume_up',
            'error_' + this.errorCode(error).toString());
        }
      }
      if (!this.volumeDownRegistered) {
        try {
          inputConsumer.on('keyPressed', {
            key: KeyCode.KEYCODE_VOLUME_DOWN,
            action: 1,
            isRepeat: false
          }, this.volumeDownListener);
          this.volumeDownRegistered = true;
          this.logReaderInput('volume_listener_registered', 'volume_down');
        } catch (error) {
          this.log('volumeKey', 'down_register_fail', this.errorCode(error));
          this.logReaderInput('volume_listener_register_fail', 'volume_down',
            'error_' + this.errorCode(error).toString());
        }
      }
      return;
    }
    this.unregisterVolumeKeyListeners();
  }

  private unregisterVolumeKeyListeners(): void {
    if (this.volumeUpRegistered) {
      try {
        inputConsumer.off('keyPressed', this.volumeUpListener);
        this.volumeUpRegistered = false;
        this.logReaderInput('volume_listener_unregistered', 'volume_up');
      } catch (error) {
        this.log('volumeKey', 'up_unregister_fail', this.errorCode(error));
      }
    }
    if (this.volumeDownRegistered) {
      try {
        inputConsumer.off('keyPressed', this.volumeDownListener);
        this.volumeDownRegistered = false;
        this.logReaderInput('volume_listener_unregistered', 'volume_down');
      } catch (error) {
        this.log('volumeKey', 'down_unregister_fail', this.errorCode(error));
      }
    }
  }

  private flipPageFromVolumeKey(isNext: boolean, source: string): void {
    this.requestPageFlip(source, isNext);
  }

  private setVolumeKeyPaging(enabled: boolean): void {
    this.volumeKeyPaging = enabled;
    this.syncVolumeKeyListeners();
    this.saveSettings();
  }

  private handleReaderTouch(event: TouchEvent): void {
    if (event.type === TouchType.Cancel) {
      if (this.touchActive) this.logReaderInput('touch_cancel', 'touch');
      this.touchActive = false;
      return;
    }
    const point = event.changedTouches.length > 0 ?
      event.changedTouches[0] :
      event.touches.length > 0 ? event.touches[0] : null;
    if (point === null) {
      this.logReaderInput(event.type === TouchType.Down ?
        'touch_down_missing_point' : 'touch_up_missing_point', 'touch');
      return;
    }
    if (event.type === TouchType.Down) {
      this.touchActive = true;
      this.touchStartX = point.x;
      this.touchStartY = point.y;
      this.touchStartAt = Date.now();
      this.logReaderInput('touch_down', 'touch', '', point.x, point.y,
        this.touchRegion(point.x));
      return;
    }
    if (event.type !== TouchType.Up) return;
    if (!this.touchActive) {
      this.logReaderInput('touch_up_without_down', 'touch', '', point.x,
        point.y, this.touchRegion(point.x));
      return;
    }
    this.touchActive = false;
    const deltaX = point.x - this.touchStartX;
    const deltaY = point.y - this.touchStartY;
    const region = this.touchRegion(point.x);
    this.logReaderInput('touch_up', 'touch', '', point.x, point.y,
      region, deltaX, deltaY);
    if (Math.abs(deltaX) >= 48 && Math.abs(deltaX) > Math.abs(deltaY)) {
      if (deltaX < 0) this.requestPageFlip('swipe_left', true);
      else this.requestPageFlip('swipe_right', false);
      return;
    }
    if (Math.abs(deltaY) >= 48 || Date.now() - this.touchStartAt > 600) return;
    if (region === 'left') {
      this.requestPageFlip('tap_left', false);
    } else if (region === 'right') {
      this.requestPageFlip('tap_right', true);
    } else if (region === 'center') {
      this.logReaderInput('controls_toggle', 'tap_center', '', point.x,
        point.y, region);
      this.toggleReaderControls();
    }
  }

  private touchRegion(x: number): string {
    const width = this.viewportWidthVp;
    if (width <= 0) return 'unknown';
    if (x < width * 0.34) return 'left';
    if (x > width * 0.66) return 'right';
    return 'center';
  }

  private logReaderInput(stage: string, source: string, reason?: string,
    x?: number, y?: number, hitRegion?: string, deltaX?: number,
    deltaY?: number): void {
    const details: DiagnosticDetails = {
      source: source,
      reason: reason,
      hitRegion: hitRegion,
      inputXVp: x,
      inputYVp: y,
      deltaXVp: deltaX,
      deltaYVp: deltaY,
      pageInForeground: this.pageInForeground,
      readerReady: this.readerReady,
      loading: this.loading,
      leaving: this.leaving,
      catalogVisible: this.catalogVisible,
      settingsVisible: this.settingsVisible,
      volumeKeyPaging: this.volumeKeyPaging,
      volumeUpRegistered: this.volumeUpRegistered,
      volumeDownRegistered: this.volumeDownRegistered
    };
    recordReaderDiagnostic(this.context(), 'readerInput', stage, 0, details);
  }

  private pageFlipBlockReason(source: string): string {
    if (!this.pageInForeground) return 'page_hidden';
    if (this.leaving) return 'leaving';
    if (this.catalogVisible) return 'catalog_open';
    if (this.settingsVisible) return 'settings_open';
    if (this.loading) return 'loading';
    if (!this.readerReady) return 'reader_not_ready';
    if (this.pageFlipInProgress) return 'flip_in_progress';
    if ((source === 'volume_up' || source === 'volume_down') &&
        !this.volumeKeyPaging) return 'volume_paging_disabled';
    if (this.currentPage === null) return 'page_missing';
    return '';
  }

  private async requestPageFlip(source: string,
    isNext: boolean): Promise<void> {
    const page = this.currentPage;
    const blockedReason = this.pageFlipBlockReason(source);
    const details: DiagnosticDetails = {
      source: source,
      reason: blockedReason.length > 0 ? blockedReason : undefined,
      startByte: page !== null ? page.startByte : undefined,
      endByte: page !== null ? page.endByte : undefined,
      pageRequestId: this.pageRequestId,
      pageInForeground: this.pageInForeground,
      readerReady: this.readerReady,
      loading: this.loading,
      leaving: this.leaving,
      catalogVisible: this.catalogVisible,
      settingsVisible: this.settingsVisible,
      volumeKeyPaging: this.volumeKeyPaging,
      volumeUpRegistered: this.volumeUpRegistered,
      volumeDownRegistered: this.volumeDownRegistered
    };
    recordReaderDiagnostic(this.context(), 'readerFlip', 'attempt', 0,
      details);
    if (blockedReason.length > 0) {
      if (this.pageInForeground && !this.leaving && !this.loading) {
        this.showInputFeedback(blockedReason === 'settings_open' ?
          '先关闭设置再翻页' : blockedReason === 'catalog_open' ?
            '先关闭目录再翻页' : blockedReason === 'flip_in_progress' ?
              '正在翻页，请稍候' : blockedReason === 'volume_paging_disabled' ?
                '音量键翻页已关闭' : '阅读页尚未就绪');
      }
      return;
    }

    this.pageFlipInProgress = true;
    try {
      if (isNext) await this.nextPage(source);
      else await this.previousPage(source);
    } catch (error) {
      const failedPage = this.currentPage;
      recordReaderDiagnostic(this.context(), 'readerFlip', 'request_fail',
        this.errorCode(error), {
          source: source,
          startByte: failedPage !== null ? failedPage.startByte : undefined,
          endByte: failedPage !== null ? failedPage.endByte : undefined,
          pageRequestId: this.pageRequestId,
          pageInForeground: this.pageInForeground,
          readerReady: this.readerReady,
          loading: this.loading,
          leaving: this.leaving,
          catalogVisible: this.catalogVisible,
          settingsVisible: this.settingsVisible
        });
      this.showInputFeedback('翻页失败，请再试一次');
    } finally {
      this.pageFlipInProgress = false;
      if (this.pendingReflow) {
        this.pendingReflow = false;
        this.scheduleReflow();
      }
    }
  }

  private showInputFeedback(message: string): void {
    if (this.inputFeedbackTimer !== -1) {
      clearTimeout(this.inputFeedbackTimer);
      this.inputFeedbackTimer = -1;
    }
    this.status = message;
    this.inputFeedbackTimer = setTimeout((): void => {
      this.inputFeedbackTimer = -1;
      if (this.status === message) this.status = '';
    }, READER_INPUT_FEEDBACK_MS);
  }

  private clearInputFeedbackTimer(): void {
    if (this.inputFeedbackTimer === -1) return;
    clearTimeout(this.inputFeedbackTimer);
    this.inputFeedbackTimer = -1;
  }

  private setCatalogVisible(visible: boolean): void {
    this.catalogVisible = visible;
    this.syncVolumeKeyListeners();
  }

  private readerAreaChanged(area: Area): void {
    const width = parseFloat(area.width.toString());
    const height = parseFloat(area.height.toString());
    const x = area.globalPosition.x !== undefined ?
      parseFloat(area.globalPosition.x.toString()) : 0;
    const y = area.globalPosition.y !== undefined ?
      parseFloat(area.globalPosition.y.toString()) : 0;
    if (!Number.isFinite(width) || !Number.isFinite(height) ||
        width <= 0 || height <= 0) return;
    const geometryChanged =
      Math.abs(width - this.viewportWidthVp) >= 0.5 ||
      Math.abs(height - this.viewportHeightVp) >= 0.5;
    if (!geometryChanged) {
      if (this.windowInsetsReady && this.viewportNeedsInsetsLayout) {
        this.viewportNeedsInsetsLayout = false;
        if (this.readerReady) this.scheduleReflow();
      }
      return;
    }
    this.viewportWidthVp = width;
    this.viewportHeightVp = height;
    if (this.windowInsetsReady) this.viewportNeedsInsetsLayout = false;
    this.logReaderViewport('area_changed', x, y);
    if (this.initialized) this.scheduleReflow();
    else this.tryInitializeReader();
  }

  private applyWindowInsets(insets: ReaderWindowInsets): void {
    const oldTop = this.readerContentTopInsetVp();
    const oldBottom = this.readerContentBottomInsetVp();
    const oldLeft = this.safeLeft;
    const oldRight = this.safeRight;
    this.safeTop = insets.top;
    this.safeBottom = insets.bottom;
    this.safeLeft = insets.left;
    this.safeRight = insets.right;
    this.statusBarHeight = insets.statusBarHeight > 0 ?
      insets.statusBarHeight : insets.top;
    this.navigationIndicatorLeftVp = insets.navigationIndicator.left;
    this.navigationIndicatorTopVp = insets.navigationIndicator.top;
    this.navigationIndicatorRightVp = insets.navigationIndicator.right;
    this.navigationIndicatorBottomVp = insets.navigationIndicator.bottom;
    const header = this.calculateHeaderLayout(insets);
    this.headerTitleX = header.titleX;
    this.headerTitleMaxWidthVp = header.titleWidth;
    this.headerInfoX = header.infoX;
    this.headerInfoWidth = header.infoWidth;
    this.windowInsetsReady = true;
    if (Math.abs(oldTop - this.readerContentTopInsetVp()) >= 0.5 ||
        Math.abs(oldBottom - this.readerContentBottomInsetVp()) >= 0.5 ||
        Math.abs(oldLeft - this.safeLeft) >= 0.5 ||
        Math.abs(oldRight - this.safeRight) >= 0.5) {
      this.viewportNeedsInsetsLayout = true;
      if (this.readerReady) this.scheduleReflow();
    }
    this.tryInitializeReader();
  }

  private tryInitializeReader(): void {
    if (!this.readerAvailable || !this.settingsReady ||
        !this.windowInsetsReady || this.viewportNeedsInsetsLayout ||
        this.viewportWidthVp <= 0 || this.viewportHeightVp <= 0 ||
        this.initialized || this.initializing || this.leaving) return;
    this.initializeReader();
  }

  private async initializeReader(): Promise<void> {
    if (this.initialized || this.initializing || this.leaving) return;
    this.initializing = true;
    const book = this.book;
    const store = this.progressStore;
    const repository = this.repository;
    const textFile = this.textFile;
    if (book === null || store === null || repository === null ||
        textFile === null) {
      this.initializing = false;
      return;
    }
    try {
      this.log('reader', 'initial_load.start');
      const saved = await store.load(book.bookId, book.sha256);
      let startByte = saved !== null ? saved.offset : 0;
      let savedOffsetValid = startByte <= book.bytes &&
        await textFile.isUtf8Boundary(startByte);
      if (!savedOffsetValid) {
        startByte = 0;
        this.log('progress', 'saved_offset_invalid');
      }
      const pageLoaded = await this.loadPageAt(startByte, true);
      if (!pageLoaded || this.leaving) return;
      this.initialized = true;
      this.readerReady = true;
      this.paginationAnchors = [startByte];
      this.pagesSincePaginationAnchor = 0;
      this.loading = false;
      this.status = '';
      this.syncVolumeKeyListeners();
      if (savedOffsetValid) {
        repository.markProgressMapping(book.bookId, 'utf8_byte');
        if (this.settingsStore !== null) {
          await this.settingsStore.removeLegacyLocation(book.bookId);
        }
      }
      if (saved === null) {
        await store.save(book.bookId, book.sha256, startByte);
      }
      await store.saveLastBook(book.bookId);
      this.log('reader', 'initial_load.ok');
    } catch (error) {
      this.loading = false;
      this.controlsVisible = true;
      this.status = '无法读取或分页这本书的正文，请重新打开书籍；现有正文和进度会保留。';
      this.log('reader', 'initial_load.fail', this.errorCode(error));
    } finally {
      this.initializing = false;
    }
  }

  private async createPageAt(startByte: number): Promise<ReaderTextPage> {
    const textFile = this.textFile;
    const book = this.book;
    if (textFile === null || book === null) {
      throw new Error('Reader body is unavailable');
    }
    const window = await textFile.readWindow(startByte, READER_WINDOW_BYTES);
    if (window.text.length === 0 && startByte < book.bytes) {
      throw new Error('The current UTF-8 text window is empty');
    }
    const heightPx = this.getUIContext().vp2px(this.viewportHeightVp);
    const page = paginateForward(window.text, window.startByte,
      Math.max(1, heightPx - 1), (text: string): number =>
        this.measureTextHeightPx(text));
    if (startByte < book.bytes && page.endByte <= startByte) {
      throw new Error('Pagination did not advance through the text');
    }
    if (page.endByte > book.bytes) {
      throw new Error('Pagination exceeded the normalized text length');
    }
    return page;
  }

  private async createPreviousPage(endByte: number):
    Promise<ReaderTextPage | null> {
    const textFile = this.textFile;
    if (textFile === null || endByte <= 0) return null;
    const heightPx = this.getUIContext().vp2px(this.viewportHeightVp);
    let maxBytes = READER_WINDOW_BYTES;
    for (;;) {
      const window = await textFile.readWindowBefore(endByte, maxBytes);
      const page = paginateBackward(window.text, window.startByte,
        endByte, Math.max(1, heightPx - 1), (text: string): number =>
          this.measureTextHeightPx(text));
      if (page === null) return null;
      if (page.startByte !== window.startByte || window.startByte === 0) {
        return page;
      }
      if (maxBytes >= READER_MAX_BACKWARD_WINDOW_BYTES) return page;
      maxBytes = Math.min(READER_MAX_BACKWARD_WINDOW_BYTES, maxBytes * 2);
    }
  }

  private measureTextHeightPx(text: string): number {
    const measured = this.getUIContext().getMeasureUtils().measureTextSize({
      textContent: text,
      constraintWidth: this.viewportWidthVp,
      fontSize: this.fontSize,
      fontWeight: FontWeight.Normal,
      fontFamily: READER_TEXT_FONT,
      lineHeight: this.fontSize * this.lineHeight,
      letterSpacing: 0,
      wordBreak: WordBreak.BREAK_WORD
    });
    const height = measured.height;
    if (height === undefined) {
      throw new Error('Text measurement did not return a height');
    }
    const value = typeof height === 'number' ? height :
      parseFloat(height.toString());
    if (!Number.isFinite(value)) throw new Error('Text measurement failed');
    return value;
  }

  private async loadPageAt(startByte: number,
    showLoading: boolean, flipSource?: string, oldStartByte?: number,
    oldEndByte?: number): Promise<boolean> {
    const requestId = ++this.pageRequestId;
    if (showLoading) this.loading = true;
    const oldText = this.pageText;
    try {
      const page = await this.createPageAt(startByte);
      if (requestId !== this.pageRequestId || this.leaving) {
        if (flipSource !== undefined) {
          recordReaderDiagnostic(this.context(), 'readerFlip',
            'page_load_superseded', 0, {
              source: flipSource,
              startByte: oldStartByte,
              endByte: oldEndByte,
              nextStartByte: startByte,
              pageRequestId: requestId,
              pageRequestCurrent: false,
              pageInForeground: this.pageInForeground,
              readerReady: this.readerReady,
              loading: this.loading,
              leaving: this.leaving,
              catalogVisible: this.catalogVisible,
              settingsVisible: this.settingsVisible
            });
        }
        return false;
      }
      this.currentPage = page;
      this.pageText = page.text;
      this.chapterTitle = this.chapterTitleFor(page.startByte);
      this.logReaderViewport('page_measured');
      if (flipSource !== undefined) {
        recordReaderDiagnostic(this.context(), 'readerFlip',
          'page_load_ok', 0, {
            source: flipSource,
            startByte: oldStartByte,
            endByte: oldEndByte,
            nextStartByte: page.startByte,
            pageRequestId: requestId,
            pageRequestCurrent: true,
            pageTextChanged: oldText !== page.text,
            pageInForeground: this.pageInForeground,
            readerReady: this.readerReady,
            loading: this.loading,
            leaving: this.leaving,
            catalogVisible: this.catalogVisible,
            settingsVisible: this.settingsVisible
          });
      }
      return true;
    } catch (error) {
      if (requestId === this.pageRequestId && !this.leaving) {
        this.status = '正文读取或分页失败（错误码 ' +
          this.errorCode(error) + '）';
        this.loading = false;
        this.log('pagination', 'page_load_fail', this.errorCode(error));
        if (flipSource !== undefined) {
          recordReaderDiagnostic(this.context(), 'readerFlip',
            'page_load_fail', this.errorCode(error), {
              source: flipSource,
              startByte: oldStartByte,
              endByte: oldEndByte,
              nextStartByte: startByte,
              pageRequestId: requestId,
              pageRequestCurrent: true,
              pageInForeground: this.pageInForeground,
              readerReady: this.readerReady,
              loading: this.loading,
              leaving: this.leaving,
              catalogVisible: this.catalogVisible,
              settingsVisible: this.settingsVisible
            });
        }
        if (flipSource !== undefined) {
          this.showInputFeedback('正文分页失败，请稍后重试');
        }
      }
      return false;
    }
  }

  private async nextPage(source: string): Promise<void> {
    const page = this.currentPage;
    const book = this.book;
    if (page === null || book === null) return;
    let nextStart = page.endByte;
    const restoredForwardPage = this.nextPageStarts.length > 0;
    if (this.nextPageStarts.length > 0) {
      nextStart = this.nextPageStarts.pop()!;
    } else if (nextStart >= book.bytes) {
      this.status = '已经读到书末';
      recordReaderDiagnostic(this.context(), 'readerFlip', 'end_of_book', 0,
        { source: source, startByte: page.startByte, endByte: page.endByte,
          nextStartByte: nextStart, pageRequestId: this.pageRequestId });
      return;
    }
    this.previousPageStarts.push(page.startByte);
    this.trimPositionHistory(this.previousPageStarts);
    const loaded = await this.loadPageAt(nextStart, false, source,
      page.startByte, page.endByte);
    if (!loaded) {
      this.previousPageStarts.pop();
      return;
    }
    if (!restoredForwardPage) this.recordPaginationCheckpoint();
    this.status = '';
    this.saveCurrentOffset();
  }

  private async previousPage(source: string): Promise<void> {
    const page = this.currentPage;
    if (page === null || page.startByte <= 0) {
      if (page !== null) {
        this.status = '已经读到书首';
        recordReaderDiagnostic(this.context(), 'readerFlip',
          'start_of_book', 0, { source: source,
            startByte: page.startByte, endByte: page.endByte,
            pageRequestId: this.pageRequestId });
      }
      return;
    }
    const oldStart = page.startByte;
    let previousStart = -1;
    let cameFromHistory = false;
    if (this.previousPageStarts.length > 0) {
      previousStart = this.previousPageStarts.pop()!;
      cameFromHistory = true;
    } else {
      const checkpoint = this.closestPaginationAnchorBefore(oldStart);
      const previous = await recoverPreviousPageFromCheckpoint(oldStart,
        checkpoint, (start: number): Promise<ReaderTextPage> =>
          this.createPageAt(start), (target: number):
          Promise<ReaderTextPage | null> => this.createPreviousPage(target));
      if (previous === null) {
        recordReaderDiagnostic(this.context(), 'readerFlip',
          'previous_page_missing', 0, {
            source: source,
            startByte: page.startByte,
            endByte: page.endByte,
            pageRequestId: this.pageRequestId
          });
        this.showInputFeedback('无法定位上一页，请重新打开本书');
        return;
      }
      previousStart = previous.startByte;
    }
    this.nextPageStarts.push(oldStart);
    this.trimPositionHistory(this.nextPageStarts);
    const loaded = await this.loadPageAt(previousStart, false, source,
      page.startByte, page.endByte);
    if (!loaded) {
      this.nextPageStarts.pop();
      if (cameFromHistory) this.previousPageStarts.push(previousStart);
      return;
    }
    this.status = '';
    this.saveCurrentOffset();
  }

  private trimPositionHistory(history: number[]): void {
    while (history.length > READER_POSITION_HISTORY_LIMIT) history.shift();
  }

  private recordPaginationCheckpoint(): void {
    this.pagesSincePaginationAnchor += 1;
    if (this.pagesSincePaginationAnchor <
        READER_CHECKPOINT_PAGE_INTERVAL || this.currentPage === null) return;
    this.paginationAnchors.push(this.currentPage.startByte);
    while (this.paginationAnchors.length >
        READER_PAGINATION_CHECKPOINT_LIMIT) this.paginationAnchors.shift();
    this.pagesSincePaginationAnchor = 0;
  }

  private closestPaginationAnchorBefore(targetStartByte: number): number {
    let closest = -1;
    for (let i = 0; i < this.paginationAnchors.length; i++) {
      const anchor = this.paginationAnchors[i];
      if (anchor < targetStartByte && anchor > closest) closest = anchor;
    }
    return closest >= 0 ? closest : targetStartByte;
  }

  private resetPaginationHistory(anchorByte: number): void {
    this.previousPageStarts = [];
    this.nextPageStarts = [];
    this.paginationAnchors = [anchorByte];
    this.pagesSincePaginationAnchor = 0;
  }

  private scheduleReflow(): void {
    if (this.resizeTimer !== -1) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout((): void => {
      this.resizeTimer = -1;
      this.viewportNeedsInsetsLayout = false;
      if (this.readerReady && this.currentPage !== null && !this.leaving) {
        if (this.pageFlipInProgress) {
          this.pendingReflow = true;
          recordReaderDiagnostic(this.context(), 'readerFlip',
            'reflow_deferred', 0, {
              source: 'layout',
              startByte: this.currentPage.startByte,
              endByte: this.currentPage.endByte,
              pageRequestId: this.pageRequestId,
              pageInForeground: this.pageInForeground,
              readerReady: this.readerReady,
              loading: this.loading,
              leaving: this.leaving
            });
          return;
        }
        this.resetPaginationHistory(this.currentPage.startByte);
        this.loadPageAt(this.currentPage.startByte, false);
      }
      refreshReaderWindowInsets();
    }, 120);
  }

  private async saveCurrentOffset(): Promise<void> {
    const book = this.book;
    const store = this.progressStore;
    const repository = this.repository;
    const page = this.currentPage;
    if (book === null || store === null || page === null ||
        page.startByte < 0 || page.startByte > book.bytes) return;
    try {
      await store.save(book.bookId, book.sha256, page.startByte);
      if (repository !== null) {
        repository.markProgressMapping(book.bookId, 'utf8_byte');
      }
      this.log('progress', 'position_saved');
    } catch (error) {
      this.log('progress', 'position_save_fail', this.errorCode(error));
    }
  }

  private async saveLastBook(): Promise<void> {
    if (this.book === null || this.progressStore === null) return;
    try {
      await this.progressStore.saveLastBook(this.book.bookId);
    } catch (error) {
      this.log('progress', 'last_book_save_fail', this.errorCode(error));
    }
  }

  private chapterTitleFor(offset: number): string {
    for (let i = 0; i < this.chapters.length; i++) {
      const chapter = this.chapters[i];
      if (offset >= chapter.offset && offset < chapter.offset + chapter.length) {
        return chapter.title;
      }
    }
    if (offset > 0 && this.chapters.length > 0) {
      const last = this.chapters[this.chapters.length - 1];
      if (offset === last.offset + last.length) return last.title;
    }
    return '';
  }

  private async jumpToChapter(chapter: BookChapter): Promise<void> {
    if (chapter.offset < 0 || chapter.offset > (this.book?.bytes || 0)) {
      this.status = '目录位置超出正文范围';
      return;
    }
    const textFile = this.textFile;
    if (textFile === null || !await textFile.isUtf8Boundary(chapter.offset)) {
      this.status = '目录位置不是有效的 UTF-8 字节边界';
      return;
    }
    this.setCatalogVisible(false);
    this.resetPaginationHistory(chapter.offset);
    if (await this.loadPageAt(chapter.offset, false)) {
      this.status = '';
      this.saveCurrentOffset();
    }
  }

  private toggleSettings(): void {
    this.settingsVisible = !this.settingsVisible;
    this.syncVolumeKeyListeners();
  }

  private async loadSettings(): Promise<void> {
    const store = this.settingsStore;
    if (store === null) return;
    const settings = await store.load();
    this.applySettings(settings);
  }

  private applySettings(settings: ReaderSettings): void {
    this.fontSize = settings.fontSize;
    this.lineHeight = settings.lineHeight;
    this.flipMode = settings.flipMode;
    this.volumeKeyPaging = settings.volumeKeyPaging;
    setAppWindowTheme(this.themeMode, this.isDarkTheme());
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

  private setThemeMode(mode: AppThemeMode): void {
    this.themeMode = mode;
    const context = this.context();
    new AppThemeStore(context).save(mode).catch((error: Error): void => {
      this.log('theme', 'save_fail', this.errorCode(error));
    });
    applyNativeThemeMode(context, mode);
    setAppWindowTheme(mode, isDarkTheme(mode, this.systemDark));
  }

  private currentSettings(): ReaderSettings {
    return {
      fontSize: this.fontSize,
      lineHeight: this.lineHeight,
      nightMode: this.isDarkTheme(),
      flipMode: this.flipMode,
      volumeKeyPaging: this.volumeKeyPaging
    };
  }

  private saveSettings(): void {
    const store = this.settingsStore;
    if (store === null) return;
    store.save(this.currentSettings()).catch((error: Error): void => {
      this.log('settings', 'save_fail', this.errorCode(error));
    });
  }

  private changeFont(delta: number): void {
    this.fontSize = Math.min(34, Math.max(14, this.fontSize + delta));
    this.saveSettings();
    this.reflowCurrentPage();
  }

  private changeLineHeight(delta: number): void {
    this.lineHeight = Math.min(2.4,
      Math.max(1.1, Math.round((this.lineHeight + delta) * 10) / 10));
    this.saveSettings();
    this.reflowCurrentPage();
  }

  private reflowCurrentPage(): void {
    const page = this.currentPage;
    if (!this.readerReady || page === null || this.leaving) return;
    if (this.pageFlipInProgress) {
      this.pendingReflow = true;
      recordReaderDiagnostic(this.context(), 'readerFlip',
        'reflow_deferred', 0, {
          source: 'settings',
          startByte: page.startByte,
          endByte: page.endByte,
          pageRequestId: this.pageRequestId,
          pageInForeground: this.pageInForeground,
          readerReady: this.readerReady,
          loading: this.loading,
          leaving: this.leaving
        });
      return;
    }
    this.resetPaginationHistory(page.startByte);
    this.loadPageAt(page.startByte, false);
  }

  private toggleTheme(): void {
    this.setThemeMode(this.isDarkTheme() ? 'light' : 'dark');
  }

  private toggleReaderControls(): void {
    if (this.loading || this.catalogVisible) return;
    if (this.settingsVisible) {
      this.settingsVisible = false;
      this.syncVolumeKeyListeners();
      return;
    }
    this.controlsVisible = !this.controlsVisible;
  }

  private openCatalog(): void {
    this.setCatalogVisible(true);
  }

  private async backToShelf(): Promise<void> {
    if (this.leaving) return;
    this.leaving = true;
    this.syncVolumeKeyListeners();
    await this.saveCurrentOffset();
    await this.saveLastBook();
    router.back();
  }

  private calculateHeaderLayout(insets: ReaderWindowInsets): ReaderHeaderLayout {
    if (insets.windowWidth <= 0) {
      return { titleX: 12, titleWidth: 0, infoX: 0, infoWidth: 0 };
    }
    const contentLeft = insets.left + 12;
    const contentRight = insets.windowWidth - insets.right - 12;
    let intervals: ReaderSafeInterval[] = contentRight > contentLeft ?
      [{ left: contentLeft, right: contentRight }] : [];
    const headerHeight = Math.max(this.statusBarHeight, 1);
    for (let i = 0; i < insets.cutouts.length; i++) {
      const cutout: ReaderWindowCutout = insets.cutouts[i];
      if (cutout.top >= headerHeight || cutout.bottom <= 0) continue;
      const next: ReaderSafeInterval[] = [];
      for (let j = 0; j < intervals.length; j++) {
        const interval = intervals[j];
        if (cutout.right <= interval.left || cutout.left >= interval.right) {
          next.push(interval);
          continue;
        }
        if (cutout.left > interval.left) {
          next.push({ left: interval.left,
            right: Math.min(interval.right, cutout.left) });
        }
        if (cutout.right < interval.right) {
          next.push({ left: Math.max(interval.left, cutout.right),
            right: interval.right });
        }
      }
      intervals = next.filter((interval: ReaderSafeInterval) =>
        interval.right - interval.left > 0);
    }
    if (intervals.length === 0) {
      return { titleX: contentLeft, titleWidth: 0,
        infoX: contentLeft, infoWidth: 0 };
    }
    const minimumInfoWidth = 100;
    let infoIntervalIndex = -1;
    for (let i = intervals.length - 1; i >= 0; i--) {
      if (intervals[i].right - intervals[i].left >= minimumInfoWidth) {
        infoIntervalIndex = i;
        break;
      }
    }
    if (infoIntervalIndex < 0) {
      let widest = 0;
      for (let i = 0; i < intervals.length; i++) {
        const width = intervals[i].right - intervals[i].left;
        if (width > widest) {
          widest = width;
          infoIntervalIndex = i;
        }
      }
    }
    const infoInterval = intervals[infoIntervalIndex];
    const infoWidth = Math.min(minimumInfoWidth,
      infoInterval.right - infoInterval.left);
    const infoX = infoInterval.right - infoWidth;
    const titleInterval = intervals[0];
    const titleX = titleInterval.left;
    const titleWidth = infoIntervalIndex === 0 ?
      Math.max(0, infoX - titleX - 8) :
      titleInterval.right - titleInterval.left;
    return { titleX: titleX, titleWidth: titleWidth,
      infoX: infoX, infoWidth: infoWidth };
  }

  private readerContentTopInsetVp(): number {
    return Math.max(this.safeTop, this.statusBarHeight);
  }

  private readerContentBottomInsetVp(): number {
    return this.safeBottom;
  }

  private chapterLabelLeftVp(): number {
    return this.safeLeft + 12;
  }

  private chapterLabelWidthVp(): number {
    if (this.navigationIndicatorRightVp <=
        this.navigationIndicatorLeftVp) return 0;
    return Math.max(0, this.navigationIndicatorLeftVp -
      this.chapterLabelLeftVp() - READER_CHAPTER_LABEL_GAP_VP);
  }

  private chapterLabelTopVp(): number {
    if (this.navigationIndicatorBottomVp <= this.navigationIndicatorTopVp) {
      return 0;
    }
    return (this.navigationIndicatorTopVp +
      this.navigationIndicatorBottomVp - READER_CHAPTER_LABEL_HEIGHT_VP) / 2;
  }

  private logReaderViewport(stage: string, x?: number, y?: number): void {
    const ui = this.getUIContext();
    const readerWidthPx = ui.vp2px(this.viewportWidthVp);
    const readerHeightPx = ui.vp2px(this.viewportHeightVp);
    recordReaderDiagnostic(this.context(), 'readerViewport', stage, 0, {
      readerXVp: x !== undefined ? x : 0,
      readerYVp: y !== undefined ? y : 0,
      readerWidthVp: this.viewportWidthVp,
      readerHeightVp: this.viewportHeightVp,
      readerXPx: ui.vp2px(x !== undefined ? x : 0),
      readerYPx: ui.vp2px(y !== undefined ? y : 0),
      readerWidthPx: readerWidthPx,
      readerHeightPx: readerHeightPx,
      pageViewportWidthPx: Math.max(1, Math.round(readerWidthPx)),
      pageViewportHeightPx: Math.max(1, Math.round(readerHeightPx))
    });
  }

  private errorCode(error: Object): number {
    const value = error as ErrorCodeCarrier;
    return typeof value.code === 'number' ? value.code : 0;
  }

  private log(event: string, stage: string, code?: number): void {
    recordReaderDiagnostic(this.context(), event, stage, code);
  }

  @Builder
  readerInfoBar() {
    Stack({ alignContent: Alignment.TopStart }) {
      Row() {
        Text(this.title).fontSize(12)
          .fontColor(this.palette().secondaryText)
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
      }
      .width(this.headerTitleMaxWidthVp)
      .height('100%')
      .alignItems(VerticalAlign.Center)
      .position({ x: this.headerTitleX, y: 0 })
      Row() {
        Text(this.timeText).fontSize(12).width(34)
          .textAlign(TextAlign.End).fontColor(this.palette().secondaryText)
        Row() {
          Stack({ alignContent: Alignment.TopStart }) {
            if (this.batteryPercent > 0) {
              Row().width(Math.max(1,
                Math.round(11 * this.batteryPercent / 100)))
                .height(4).margin({ left: 2, top: 3 })
                .backgroundColor(this.palette().secondaryText).borderRadius(1)
            }
          }
          .width(17).height(10)
          .border({ width: 1, color: this.palette().secondaryText, radius: 2 })
          Column().width(2).height(4)
            .backgroundColor(this.palette().secondaryText)
            .margin({ left: 1 })
          Text(this.batteryPercent < 0 ? '--%' :
            this.batteryPercent.toString() + '%')
            .fontSize(11).width(27)
            .fontColor(this.palette().secondaryText).margin({ left: 4 })
        }
        .margin({ left: 8 })
      }
      .alignItems(VerticalAlign.Center)
      .width(this.headerInfoWidth)
      .height('100%')
      .position({ x: this.headerInfoX, y: 0 })
    }
    .width('100%').height(this.statusBarHeight)
    .backgroundColor(this.palette().readerPage)
    .hitTestBehavior(HitTestMode.None)
  }

  @Builder
  readerChapterLabel() {
    if (this.chapterTitle.length > 0 && this.chapterLabelWidthVp() > 0) {
      Text(this.chapterTitle).fontSize(11)
        .fontColor(this.palette().secondaryText)
        .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        .width(this.chapterLabelWidthVp())
        .height(READER_CHAPTER_LABEL_HEIGHT_VP)
        .position({ x: this.chapterLabelLeftVp(),
          y: this.chapterLabelTopVp() })
        .hitTestBehavior(HitTestMode.None)
    }
  }

  @Builder
  topControls() {
    Column() {
      Row() {
        Button('‹').fontSize(24).width(44).height(40)
          .backgroundColor(this.palette().surfaceRaised).fontColor(this.palette().text)
          .onClick(() => { this.backToShelf(); })
        Blank().layoutWeight(1)
        Button('目录').fontSize(13).height(36)
          .backgroundColor(this.palette().surfaceRaised).fontColor(this.palette().text)
          .onClick(() => { this.openCatalog(); })
        Button('Aa').fontSize(13).height(36)
          .backgroundColor(this.palette().surfaceRaised).fontColor(this.palette().text)
          .margin({ left: 8 })
          .onClick(() => { this.toggleSettings(); })
      }
      .width('100%').padding({ left: 12, right: 12, top: 8, bottom: 8 })
      .backgroundColor(this.palette().overlay)

      if (this.settingsVisible) {
        Column({ space: 6 }) {
          Row() {
            Button('A−').height(32)
              .backgroundColor(this.palette().surfaceRaised).fontColor(this.palette().text)
              .onClick(() => { this.changeFont(-2); })
            Text('字号 ' + this.fontSize).fontSize(12)
              .fontColor(this.palette().text).layoutWeight(1)
              .textAlign(TextAlign.Center)
            Button('A+').height(32)
              .backgroundColor(this.palette().surfaceRaised).fontColor(this.palette().text)
              .onClick(() => { this.changeFont(2); })
          }
          .width('100%')
          Row() {
            Text('行距').fontSize(12).fontColor(this.palette().secondaryText)
              .layoutWeight(1)
            Button('−').width(52).height(32)
              .backgroundColor(this.palette().surfaceRaised).fontColor(this.palette().text)
              .onClick(() => { this.changeLineHeight(-0.1); })
            Text(this.lineHeight.toFixed(1)).fontSize(12)
              .fontColor(this.palette().text).width(48).textAlign(TextAlign.Center)
            Button('+').width(52).height(32)
              .backgroundColor(this.palette().surfaceRaised).fontColor(this.palette().text)
              .onClick(() => { this.changeLineHeight(0.1); })
          }
          .width('100%')
          Row() {
            Button(this.themeMode === 'system' ? '跟随系统' :
              this.isDarkTheme() ? '深色主题' : '浅色主题')
              .height(32).layoutWeight(1)
              .backgroundColor(this.palette().surfaceRaised).fontColor(this.palette().text)
              .onClick(() => { this.toggleTheme(); })
            Blank().layoutWeight(1).margin({ left: 8 })
          }
          .width('100%')
          Row() {
            Text('音量键翻页').fontSize(12)
              .fontColor(this.palette().text).layoutWeight(1)
            Toggle({ type: ToggleType.Switch, isOn: this.volumeKeyPaging })
              .onChange((enabled: boolean) => {
                this.setVolumeKeyPaging(enabled);
              })
          }
          .width('100%')
        }
        .width('100%').padding({ left: 12, right: 12, top: 6, bottom: 8 })
        .backgroundColor(this.palette().surface)
      }
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
  }

  @Builder
  catalogPanel() {
    Stack({ alignContent: Alignment.Center }) {
      Column().width('100%').height('100%')
        .backgroundColor(this.palette().overlay)
        .onClick(() => { this.setCatalogVisible(false); })
      Column() {
        Row() {
          Text('目录').fontSize(19).fontWeight(FontWeight.Medium)
            .fontColor(this.palette().text).layoutWeight(1)
          Button('关闭').height(32)
            .backgroundColor(this.palette().surfaceRaised).fontColor(this.palette().text)
            .onClick(() => { this.setCatalogVisible(false); })
        }
        .width('100%').padding({ bottom: 10 })
        if (this.chapters.length === 0) {
          Text('这本书没有可用目录').fontSize(14)
            .fontColor(this.palette().secondaryText).padding(20)
        } else {
          List() {
            ForEach(this.chapters, (item: BookChapter) => {
              ListItem() {
                Text(item.title)
                  .fontSize(14).maxLines(2)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .width('100%').padding({ top: 12, bottom: 12,
                    left: 12 })
                  .onClick(() => { this.jumpToChapter(item); })
              }
            }, (item: BookChapter) => item.offset.toString())
          }
          .width('100%').layoutWeight(1)
          .divider({ strokeWidth: 1, color: this.palette().border })
        }
      }
      .width('90%').height('78%').constraintSize({ maxWidth: 620 })
      .padding(18).backgroundColor(this.palette().surface).borderRadius(20)
    }
    .width('100%').height('100%')
    .padding({ top: this.readerContentTopInsetVp() + 8,
      bottom: this.safeBottom + 8, left: this.safeLeft, right: this.safeRight })
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      if (this.readerAvailable && this.book !== null) {
        Column() {
          Text(this.pageText)
            .fontSize(this.fontSize)
            .fontWeight(FontWeight.Normal)
            .fontFamily(READER_TEXT_FONT)
            .fontColor(this.isDarkTheme() ? '#E8EAF0' : '#1F2937')
            .lineHeight(this.fontSize * this.lineHeight)
            .letterSpacing(0)
            .wordBreak(WordBreak.BREAK_WORD)
            .textAlign(TextAlign.Start)
            .width('100%').height('100%')
            .onTouch((event: TouchEvent) => { this.handleReaderTouch(event); })
            .onAreaChange((oldArea: Area, newArea: Area) => {
              this.readerAreaChanged(newArea);
            })
        }
        .width('100%').height('100%')
        .padding({ left: this.safeLeft, right: this.safeRight,
          top: this.readerContentTopInsetVp(),
          bottom: this.readerContentBottomInsetVp() })

        if (!this.loading && this.controlsVisible) {
          Column() {
            this.topControls()
          }
          .width('100%')
          .position({ x: 0, y: this.readerContentTopInsetVp() })
          .padding({ left: this.safeLeft, right: this.safeRight })
        }

        this.readerInfoBar()
        this.readerChapterLabel()
        if (!this.loading && this.status.length > 0) {
          Text(this.status).fontSize(11).fontColor(this.palette().text)
            .width('100%')
            .padding({ left: 12 + this.safeLeft,
              right: 12 + this.safeRight, top: 4, bottom: 4 })
            .backgroundColor(this.palette().overlay)
            .position({ x: 0, y: this.readerContentTopInsetVp() })
            .hitTestBehavior(HitTestMode.None)
        }
      } else {
        Column() {
          Text(this.status).fontSize(15).fontColor(this.palette().text)
          Button('返回书架').margin({ top: 20 })
            .backgroundColor(this.palette().surfaceRaised).fontColor(this.palette().text)
            .onClick(() => { this.backToShelf(); })
        }
        .width('100%').height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor(this.palette().page)
      }

      if (this.loading) {
        Column() {
          Text('正在打开……').fontSize(14).fontColor(this.palette().text)
        }
        .width('100%').height('100%').justifyContent(FlexAlign.Center)
        .backgroundColor(this.palette().overlay).hitTestBehavior(HitTestMode.None)
      }
      if (this.catalogVisible) this.catalogPanel()
    }
    .width('100%').height('100%').backgroundColor(this.palette().readerPage)
    .expandSafeArea([SafeAreaType.SYSTEM],
      [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
  }
}
