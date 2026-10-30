// SPDX-License-Identifier: GPL-3.0-only
// 本机阅读页使用系统 Reader Kit；传手表仍由独立的规范化 UTF-8 正文驱动。
import { common } from '@kit.AbilityKit';
import { batteryInfo } from '@kit.BasicServicesKit';
import { fileIo } from '@kit.CoreFileKit';
import { router, display } from '@kit.ArkUI';
import { inputConsumer, KeyCode } from '@kit.InputKit';
import { bookParser, ReadPageComponent, readerCore } from '@kit.ReaderKit';
import { APP_SYSTEM_DARK_KEY, APP_THEME_MODE_KEY, AppThemePalette,
  AppThemeMode, isDarkTheme, themePalette } from '../services/AppTheme';
import { BookMeta } from '../model/BookModels';
import { BookRepository } from '../services/BookRepository';
import { ReadingProgressStore } from '../services/ReadingProgressStore';
import { ReaderKitLocation, ReaderKitSettings,
  ReaderKitStateStore } from '../services/ReaderKitStateStore';
import { AppThemeStore, applyNativeThemeMode }
  from '../services/AppThemeStore';
import { recordReaderDiagnostic } from '../services/ReaderDiagnostics';
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

const READER_FOOTER_HEIGHT_VP = 18;

@Entry
@Component
struct Reader {
  @State private title: string = '';
  @State private loading: boolean = true;
  @State private readerAvailable: boolean = false;
  @State private status: string = '正在初始化 Reader Kit……';
  @State private controlsVisible: boolean = true;
  @State private settingsVisible: boolean = false;
  @State private catalogVisible: boolean = false;
  @State private catalogs: bookParser.CatalogItem[] = [];
  @State private fontSize: number = 20;
  @State private lineHeight: number = 1.6;
  @StorageLink(APP_THEME_MODE_KEY) @Watch('themeStateChanged')
  private themeMode: AppThemeMode = 'system';
  @StorageLink(APP_SYSTEM_DARK_KEY) @Watch('themeStateChanged')
  private systemDark: boolean = false;
  @State private flipMode: string = '1';
  @State private chapterTitle: string = '';
  @State private safeTop: number = 0;
  @State private safeBottom: number = 0;
  @State private safeLeft: number = 0;
  @State private safeRight: number = 0;
  @State private statusBarHeight: number = 0;
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
  private readerState: ReaderKitStateStore | null = null;
  private controller: readerCore.ReaderComponentController =
    new readerCore.ReaderComponentController();
  private parser: bookParser.BookParserHandler | null = null;
  private spine: bookParser.SpineItem[] = [];
  private currentResourceIndex: number = 0;
  private currentDomPos: string = '';
  private viewportXVp: number = 0;
  private viewportYVp: number = 0;
  private windowInsetsReady: boolean = false;
  private viewportNeedsInsetsLayout: boolean = false;
  private viewportAreaWaiters: Array<() => void> = [];
  private lastPositionLogResourceIndex: number = -1;
  private initialized: boolean = false;
  private readerReady: boolean = false;
  private pageInForeground: boolean = false;
  private leaving: boolean = false;
  private settingsLoad: Promise<void> = Promise.resolve();
  private resizeTimer: number = -1;
  private infoRefreshTimer: number = -1;
  private volumeUpRegistered: boolean = false;
  private volumeDownRegistered: boolean = false;
  private volumeUpListener = (): void => {
    this.flipPageFromVolumeKey(false);
  };
  private volumeDownListener = (): void => {
    this.flipPageFromVolumeKey(true);
  };
  private onWindowInsets = (insets: ReaderWindowInsets): void => {
    this.applyWindowInsets(insets);
  };
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
    }
    this.resolveViewportAreaWaiters();
  }
  private pageShowListener = (info: readerCore.PageDataInfo): void => {
    this.onReaderPageShow(info);
  };
  private resourceRequestListener = (path: string): ArrayBuffer => {
    const parser = this.parser;
    if (parser === null) return new ArrayBuffer(0);
    try {
      return parser.getResourceContent(this.currentResourceIndex, path);
    } catch (error) {
      this.log('resource', 'read', this.errorCode(error));
      return new ArrayBuffer(0);
    }
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
    this.readerState = new ReaderKitStateStore(context);
    this.book = this.repository.get(bookId);
    if (this.book === null) {
      this.loading = false;
      this.status = '书籍不存在，或正文文件已被删除';
      return;
    }
    this.title = this.book.title;
    const path = this.readerPath(this.book);
    if (this.book.kind === 'epub' &&
        (!this.book.readerFilePath ||
         this.book.readerFilePath === this.book.filePath)) {
      this.loading = false;
      this.status = '这本 EPUB 是旧版导入记录，缺少原始 EPUB 文件。请重新导入原文件后再用 Reader Kit 阅读；现有书籍和手表数据已保留。';
      return;
    }
    if (!fileIo.accessSync(path)) {
      this.loading = false;
      this.status = 'Reader Kit 输入文件不可用。请重新导入这本书；现有进度不会删除。';
      return;
    }
    this.readerAvailable = true;
    this.settingsLoad = this.loadSettings().catch((error: Error) => {
      this.log('settings', 'load', this.errorCode(error));
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
    this.syncVolumeKeyListeners();
    this.saveCurrentLocation();
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
    this.syncVolumeKeyListeners();
    if (this.resizeTimer !== -1) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = -1;
    }
    this.saveCurrentLocation();
    try {
      this.controller.off('pageShow', this.pageShowListener);
      this.controller.off('resourceRequest', this.resourceRequestListener);
      this.controller.releaseBook();
    } catch (error) {
      this.log('reader', 'release', this.errorCode(error));
    }
    exitReaderWindow();
  }

  private context(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext;
  }

  private readerPath(book: BookMeta): string {
    return book.readerFilePath || book.filePath;
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
    const now = Date.now();
    const delay = 60000 - (now % 60000) + 50;
    this.infoRefreshTimer = setTimeout(() => {
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
        } catch (error) {
          this.log('volumeKey', 'up_register_fail', this.errorCode(error));
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
        } catch (error) {
          this.log('volumeKey', 'down_register_fail', this.errorCode(error));
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
      } catch (error) {
        this.log('volumeKey', 'up_unregister_fail', this.errorCode(error));
      }
      this.volumeUpRegistered = false;
    }
    if (this.volumeDownRegistered) {
      try {
        inputConsumer.off('keyPressed', this.volumeDownListener);
      } catch (error) {
        this.log('volumeKey', 'down_unregister_fail', this.errorCode(error));
      }
      this.volumeDownRegistered = false;
    }
  }

  private flipPageFromVolumeKey(isNext: boolean): void {
    if (!this.shouldConsumeVolumeKeys()) return;
    try {
      this.controller.flipPage(isNext);
    } catch (error) {
      this.log('volumeKey', 'flip_fail', this.errorCode(error));
    }
  }

  private setVolumeKeyPaging(enabled: boolean): void {
    this.volumeKeyPaging = enabled;
    this.syncVolumeKeyListeners();
    this.saveSettings();
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
      Math.abs(height - this.viewportHeightVp) >= 0.5 ||
      Math.abs(x - this.viewportXVp) >= 0.5 ||
      Math.abs(y - this.viewportYVp) >= 0.5;
    if (!geometryChanged) {
      if (this.windowInsetsReady && this.viewportNeedsInsetsLayout) {
        this.viewportNeedsInsetsLayout = false;
        this.resolveViewportAreaWaiters();
      }
      return;
    }
    this.viewportWidthVp = width;
    this.viewportHeightVp = height;
    this.viewportXVp = Number.isFinite(x) ? x : 0;
    this.viewportYVp = Number.isFinite(y) ? y : 0;
    if (this.windowInsetsReady) this.viewportNeedsInsetsLayout = false;
    this.resolveViewportAreaWaiters();
    this.logReaderViewport('area_changed');
    if (this.resizeTimer !== -1) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = -1;
      if (this.readerReady) this.applyPageConfig(true);
      refreshReaderWindowInsets();
    }, 120);
  }

  private waitForViewportArea(): Promise<void> {
    if (this.windowInsetsReady && !this.viewportNeedsInsetsLayout &&
        this.viewportWidthVp > 0 && this.viewportHeightVp > 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve: () => void): void => {
      this.viewportAreaWaiters.push(resolve);
    });
  }

  private resolveViewportAreaWaiters(): void {
    if (!this.windowInsetsReady || this.viewportNeedsInsetsLayout ||
        this.viewportWidthVp <= 0 || this.viewportHeightVp <= 0) return;
    const waiters = this.viewportAreaWaiters.splice(0);
    for (let i = 0; i < waiters.length; i++) waiters[i]();
  }

  private logReaderViewport(stage: string): void {
    const ui = this.getUIContext();
    const readerWidthPx = ui.vp2px(this.viewportWidthVp);
    const readerHeightPx = ui.vp2px(this.viewportHeightVp);
    recordReaderDiagnostic(this.context(), 'readerViewport', stage, 0, {
      readerXVp: this.viewportXVp,
      readerYVp: this.viewportYVp,
      readerWidthVp: this.viewportWidthVp,
      readerHeightVp: this.viewportHeightVp,
      readerXPx: ui.vp2px(this.viewportXVp),
      readerYPx: ui.vp2px(this.viewportYVp),
      readerWidthPx: readerWidthPx,
      readerHeightPx: readerHeightPx,
      pageViewportWidthPx: Math.max(1, Math.round(readerWidthPx)),
      pageViewportHeightPx: Math.max(1, Math.round(readerHeightPx))
    });
  }

  private toggleSettings(): void {
    this.settingsVisible = !this.settingsVisible;
    this.syncVolumeKeyListeners();
  }

  private async loadSettings(): Promise<void> {
    if (this.readerState === null) return;
    const settings = await this.readerState.loadSettings();
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
    const dark = this.isDarkTheme();
    setAppWindowTheme(this.themeMode, dark);
    this.applyPageConfig(true);
  }

  private setThemeMode(mode: AppThemeMode): void {
    this.themeMode = mode;
    const context = this.context();
    new AppThemeStore(context).save(mode).catch((error: Error) => {
      this.log('theme', 'save_fail', this.errorCode(error));
    });
    applyNativeThemeMode(context, mode);
    setAppWindowTheme(mode, isDarkTheme(mode, this.systemDark));
    this.applyPageConfig(true);
  }

  private async initializeReader(
    componentController: readerCore.ReaderComponentController): Promise<void> {
    if (this.initialized || this.leaving || !this.readerAvailable) return;
    this.initialized = true;
    this.controller = componentController;
    const book = this.book;
    const state = this.readerState;
    const repository = this.repository;
    if (book === null || state === null || repository === null) return;
    const context = this.context();
    try {
      this.status = '正在初始化 Reader Kit……';
      this.log('reader', 'init.start');
      await this.controller.init(context);
      this.log('reader', 'init.ok');

      // getDefaultHandler 依赖 controller.init(context) 已成功完成。
      this.log('parser', 'create.start');
      this.parser = await bookParser.getDefaultHandler(this.readerPath(book));
      this.log('parser', 'create.ok');
      this.controller.registerBookParser(this.parser);
      this.log('parser', 'register.ok');

      this.spine = this.parser.getSpineList();
      this.catalogs = this.parser.getCatalogList();
      await this.settingsLoad;
      repository.markProgressMapping(book.bookId, 'readerkit_unmapped');
      if (this.progressStore !== null) {
        await this.progressStore.saveLastBook(book.bookId);
      }

      this.controller.on('pageShow', this.pageShowListener);
      this.controller.on('resourceRequest', this.resourceRequestListener);
      const saved = await state.loadLocation(book.bookId,
        this.readerSha256(book));
      const start = this.validLocation(saved) ? saved! : null;
      this.currentResourceIndex = start !== null ?
        start.resourceIndex : 0;
      this.currentDomPos = start !== null ? start.startDomPos : '';
      this.log('readerViewport', 'initial_measure_wait');
      await this.waitForViewportArea();
      if (this.leaving) return;
      this.controller.setPageConfig(this.pageConfig());
      this.status = '正在打开书籍……';
      this.log('reader', 'startPlay.start');
      await this.controller.startPlay(this.currentResourceIndex,
        this.currentDomPos);
      this.log('reader', 'startPlay.ok');
      this.readerReady = true;
      this.loading = false;
      this.status = '';
      this.syncVolumeKeyListeners();
    } catch (error) {
      this.readerReady = false;
      this.syncVolumeKeyListeners();
      const code = this.errorCode(error);
      this.log(this.failureStage(error), 'fail', code);
      this.loading = false;
      this.controlsVisible = true;
      this.status = 'Reader Kit 打开失败（错误码 ' + code + '）。请检查 Reader Kit 服务、文件格式和设备系统版本；诊断日志不含书名或路径。';
    }
  }

  private validLocation(location: ReaderKitLocation | null): boolean {
    return location !== null && this.spine.length > 0 &&
      location.resourceIndex < this.spine.length;
  }

  private readerSha256(book: BookMeta): string {
    return book.readerSha256 || book.sha256;
  }

  private onReaderPageShow(info: readerCore.PageDataInfo): void {
    if (info.state !== readerCore.PageState.PAGE_ON_SHOW) return;
    if (!Number.isInteger(info.resourceIndex) || info.resourceIndex < 0 ||
        info.resourceIndex >= this.spine.length) return;
    this.currentResourceIndex = info.resourceIndex;
    this.currentDomPos = info.startDomPos;
    // Reader Kit's pageFooterContent has not been verified as progress and
    // may contain book metadata. Do not present it as a page number.
    this.chapterTitle = this.catalogTitleFor(info.resourceIndex);
    this.saveCurrentLocation();
  }

  private catalogTitleFor(resourceIndex: number): string {
    for (let i = 0; i < this.spine.length; i++) {
      if (this.spine[i].index !== resourceIndex) continue;
      for (let j = 0; j < this.catalogs.length; j++) {
        if (this.catalogs[j].idRef === this.spine[i].idRef) {
          return this.catalogs[j].catalogName;
        }
      }
    }
    return '';
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

  private readerFooterHeightVp(): number {
    return this.chapterTitle.length > 0 ?
      READER_FOOTER_HEIGHT_VP : 0;
  }

  private readerContentBottomInsetVp(): number {
    return this.safeBottom + this.readerFooterHeightVp();
  }

  private async saveCurrentLocation(): Promise<void> {
    const book = this.book;
    const state = this.readerState;
    const resourceIndex = this.currentResourceIndex;
    const domPos = this.currentDomPos;
    if (book === null || state === null || resourceIndex < 0 ||
        domPos.length > 4096) return;
    try {
      await state.saveLocation(book.bookId, this.readerSha256(book),
        resourceIndex, domPos);
      this.logLocationSavedAtResourceBoundary(resourceIndex);
    } catch (error) {
      this.log('pageShow', 'position.save_fail', this.errorCode(error));
    }
  }

  // Position persistence still runs for every page, but sync log I/O only
  // records the first successful save for each Reader Kit resource.
  private logLocationSavedAtResourceBoundary(resourceIndex: number): void {
    if (resourceIndex === this.lastPositionLogResourceIndex) return;
    this.lastPositionLogResourceIndex = resourceIndex;
    this.log('pageShow', 'position.saved');
  }

  private pageConfig(): readerCore.ReaderSetting {
    const displayInfo = display.getDefaultDisplaySync();
    const scale = displayInfo.scaledDensity > 0 ?
      displayInfo.scaledDensity : 1;
    const widthPx = this.getUIContext().vp2px(this.viewportWidthVp);
    const heightPx = this.getUIContext().vp2px(this.viewportHeightVp);
    this.logReaderViewport('page_config');
    return {
      fontName: 'HarmonyOS Sans',
      fontSize: this.fontSize,
      fontWeight: 400,
      fontColor: this.isDarkTheme() ? '#E8EAF0' : '#1F2937',
      fontPath: '',
      lineHeight: this.lineHeight,
      nightMode: this.isDarkTheme(),
      themeColor: this.palette().readerPage,
      themeBgImg: '',
      flipMode: this.flipMode,
      scaledDensity: scale,
      viewPortWidth: Math.max(1, Math.round(widthPx)),
      viewPortHeight: Math.max(1, Math.round(heightPx))
    };
  }

  private applyPageConfig(restorePosition: boolean): void {
    if (this.parser === null || this.leaving || !this.readerReady ||
        this.viewportWidthVp <= 0 || this.viewportHeightVp <= 0) return;
    try {
      this.controller.setPageConfig(this.pageConfig());
      this.log('pageConfig', 'updated');
      if (restorePosition && this.currentDomPos.length > 0) {
        this.controller.startPlay(this.currentResourceIndex,
          this.currentDomPos).catch((error: Error) => {
          this.log('pageConfig', 'restore_fail', this.errorCode(error));
        });
      }
    } catch (error) {
      this.status = '更新阅读排版失败（错误码 ' +
        this.errorCode(error) + '）';
      this.log('pageConfig', 'update_fail', this.errorCode(error));
    }
  }

  private saveSettings(): void {
    const settings: ReaderKitSettings = {
      fontSize: this.fontSize,
      lineHeight: this.lineHeight,
      nightMode: this.isDarkTheme(),
      flipMode: this.flipMode,
      volumeKeyPaging: this.volumeKeyPaging
    };
    if (this.readerState !== null) {
      this.readerState.saveSettings(settings).catch((error: Error) => {
        this.log('settings', 'save', this.errorCode(error));
      });
    }
  }

  private persistSettingsAndApplyPageConfig(): void {
    this.saveSettings();
    setAppWindowTheme(this.themeMode, this.isDarkTheme());
    this.applyPageConfig(true);
  }

  private changeFont(delta: number): void {
    this.fontSize = Math.min(34, Math.max(14, this.fontSize + delta));
    this.persistSettingsAndApplyPageConfig();
  }

  private changeLineHeight(delta: number): void {
    this.lineHeight = Math.min(2.4,
      Math.max(1.1, Math.round((this.lineHeight + delta) * 10) / 10));
    this.persistSettingsAndApplyPageConfig();
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

  private setFlipMode(mode: string): void {
    if (mode !== '0' && mode !== '1') return;
    this.flipMode = mode;
    this.persistSettingsAndApplyPageConfig();
  }

  private jumpToCatalog(catalog: bookParser.CatalogItem): void {
    const parser = this.parser;
    if (parser === null) return;
    let resourceIndex = -1;
    for (let i = 0; i < this.spine.length; i++) {
      if (catalog.idRef && this.spine[i].idRef === catalog.idRef) {
        resourceIndex = this.spine[i].index;
        break;
      }
    }
    if (resourceIndex < 0) {
      this.status = '目录项没有对应的正文资源';
      return;
    }
    let domPos = '';
    try {
      if (catalog.href) domPos = parser.getDomPosByCatalogHref(catalog.href);
    } catch (error) {
      this.status = '获取目录位置失败（错误码 ' +
        this.errorCode(error) + '）';
      this.log('catalog', 'resolve_fail', this.errorCode(error));
      return;
    }
    this.setCatalogVisible(false);
    this.currentResourceIndex = resourceIndex;
    this.currentDomPos = domPos;
    this.controller.startPlay(resourceIndex, domPos).then(() => {
      this.log('catalog', 'jump.ok');
    }).catch((error: Error) => {
      this.status = '目录跳转失败（错误码 ' + this.errorCode(error) + '）';
      this.log('catalog', 'jump.fail', this.errorCode(error));
    });
  }

  private async backToShelf(): Promise<void> {
    if (this.leaving) return;
    this.leaving = true;
    this.syncVolumeKeyListeners();
    await this.saveCurrentLocation();
    if (this.book !== null && this.progressStore !== null) {
      await this.progressStore.saveLastBook(this.book.bookId);
    }
    router.back();
  }

  private errorCode(error: Object): number {
    const value = error as ErrorCodeCarrier;
    return typeof value.code === 'number' && Number.isFinite(value.code) ?
      value.code : 0;
  }

  private failureStage(error: Object): string {
    const code = this.errorCode(error);
    if (code === 1017000003 || code === 1017010003) return 'format';
    if (code === 1017010004) return 'file';
    if (code >= 1017000000 && code < 1017020000) return 'parser';
    if (code >= 1016900000 && code < 1016920000) return 'reader';
    return 'open';
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
  readerFooter() {
    Row() {
      if (this.chapterTitle.length > 0) {
        Text(this.chapterTitle).fontSize(11)
          .fontColor(this.palette().secondaryText).layoutWeight(1)
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
      }
    }
    .width('100%').height(READER_FOOTER_HEIGHT_VP)
    .padding({ left: 12 + this.safeLeft, right: 12 + this.safeRight })
    .backgroundColor(this.palette().readerPage)
    .hitTestBehavior(HitTestMode.None)
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
      .width('100%')
      .padding({ left: 12, right: 12,
        top: 8, bottom: 8 })
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
            Button(this.flipMode === '1' ? '横向滑页' : '仿真翻页')
              .height(32).layoutWeight(1).margin({ left: 8 })
              .backgroundColor(this.palette().surfaceRaised).fontColor(this.palette().text)
              .onClick(() => {
                this.setFlipMode(this.flipMode === '1' ? '0' : '1');
              })
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
        .width('100%')
        .padding({ left: 12, right: 12, top: 6, bottom: 8 })
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
        if (this.catalogs.length === 0) {
          Text('这本书没有可用目录').fontSize(14)
            .fontColor(this.palette().secondaryText).padding(20)
        } else {
          List() {
            ForEach(this.catalogs, (item: bookParser.CatalogItem) => {
              ListItem() {
                Text(item.catalogName)
                  .fontSize(14).maxLines(2)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .width('100%').padding({ top: 12, bottom: 12,
                    left: Math.min(32, (item.catalogLevel || 0) * 12) })
                  .onClick(() => { this.jumpToCatalog(item); })
              }
            }, (item: bookParser.CatalogItem) =>
              item.catalogId.toString())
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
      bottom: this.safeBottom + 8,
      left: this.safeLeft, right: this.safeRight })
  }

  build() {

    Stack({ alignContent: Alignment.TopStart }) {
      if (this.readerAvailable && this.book !== null) {
        Column() {
          ReadPageComponent({
            controller: this.controller,
            readerCallback: (error, controller) => {
              if (error) {
                this.readerReady = false;
                this.loading = false;
                this.controlsVisible = true;
                this.status = 'Reader Kit 组件初始化失败（错误码 ' +
                  this.errorCode(error) + '）';
                this.log('reader', 'component.fail', this.errorCode(error));
                this.syncVolumeKeyListeners();
                return;
              }
              this.initializeReader(controller);
            }
          })
          .width('100%').layoutWeight(1)
          .onClick(() => { this.toggleReaderControls(); })
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
            Blank().layoutWeight(1).hitTestBehavior(HitTestMode.None)
          }
          .width('100%').height('100%')
          .padding({ left: this.safeLeft, right: this.safeRight,
            top: this.readerContentTopInsetVp(),
            bottom: this.readerContentBottomInsetVp() })
          .hitTestBehavior(HitTestMode.Transparent)
        }

        this.readerInfoBar()
        if (!this.loading && this.status.length > 0) {
          Text(this.status).fontSize(11).fontColor(this.palette().text)
            .width('100%')
            .padding({ left: 12 + this.safeLeft,
              right: 12 + this.safeRight, top: 4, bottom: 4 })
            .backgroundColor(this.palette().overlay)
            .position({ x: 0, y: this.readerContentTopInsetVp() })
            .hitTestBehavior(HitTestMode.None)
        }
        if (!this.loading && this.readerFooterHeightVp() > 0) {
          Column() {
            Blank().layoutWeight(1).hitTestBehavior(HitTestMode.None)
            this.readerFooter()
          }
          .width('100%').height('100%')
          .padding({ bottom: this.safeBottom })
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
