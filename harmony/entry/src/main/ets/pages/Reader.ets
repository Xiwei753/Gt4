// SPDX-License-Identifier: GPL-3.0-only
// 本机阅读页使用系统 Reader Kit；传手表仍由独立的规范化 UTF-8 正文驱动。
import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { router, display } from '@kit.ArkUI';
import { bookParser, ReadPageComponent, readerCore } from '@kit.ReaderKit';
import { BookMeta } from '../model/BookModels';
import { BookRepository } from '../services/BookRepository';
import { ReadingProgressStore } from '../services/ReadingProgressStore';
import { ReaderKitLocation, ReaderKitSettings,
  ReaderKitStateStore } from '../services/ReaderKitStateStore';
import { recordReaderDiagnostic } from '../services/ReaderDiagnostics';
import { enterReaderWindow, exitReaderWindow,
  refreshReaderWindowInsets, restoreShelfWindow,
  setReaderWindowTheme, ReaderWindowInsets }
  from '../services/ReaderWindowAppearance';

interface ReaderParams {
  bookId?: string;
}

interface ErrorCodeCarrier {
  code?: number;
}

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
  @State private nightMode: boolean = true;
  @State private flipMode: string = '1';
  @State private pageFooter: string = '';
  @State private chapterTitle: string = '';
  @State private safeTop: number = 0;
  @State private safeBottom: number = 0;
  @State private safeLeft: number = 0;
  @State private safeRight: number = 0;
  @State private viewportWidthVp: number = 0;
  @State private viewportHeightVp: number = 0;

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
  private initialized: boolean = false;
  private leaving: boolean = false;
  private settingsLoad: Promise<void> = Promise.resolve();
  private resizeTimer: number = -1;
  private onWindowInsets = (insets: ReaderWindowInsets): void => {
    this.safeTop = insets.top;
    this.safeBottom = insets.bottom;
    this.safeLeft = insets.left;
    this.safeRight = insets.right;
  };
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
    this.chapterTitle = this.book.title;
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
    const context = this.context();
    enterReaderWindow(context, this.nightMode, this.onWindowInsets);
    this.log('reader', 'foreground');
  }

  onPageHide(): void {
    this.saveCurrentLocation();
  }

  onBackPress(): boolean {
    if (this.catalogVisible) {
      this.catalogVisible = false;
      return true;
    }
    if (this.settingsVisible) {
      this.settingsVisible = false;
      return true;
    }
    this.backToShelf();
    return true;
  }

  aboutToDisappear(): void {
    this.leaving = true;
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

  private async loadSettings(): Promise<void> {
    if (this.readerState === null) return;
    const settings = await this.readerState.loadSettings();
    this.fontSize = settings.fontSize;
    this.lineHeight = settings.lineHeight;
    this.nightMode = settings.nightMode;
    this.flipMode = settings.flipMode;
    setReaderWindowTheme(this.nightMode);
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
      this.controller.setPageConfig(this.pageConfig());
      const saved = await state.loadLocation(book.bookId,
        this.readerSha256(book));
      const start = this.validLocation(saved) ? saved! : null;
      this.currentResourceIndex = start !== null ?
        start.resourceIndex : 0;
      this.currentDomPos = start !== null ? start.startDomPos : '';
      this.status = '正在打开书籍……';
      this.log('reader', 'startPlay.start');
      await this.controller.startPlay(this.currentResourceIndex,
        this.currentDomPos);
      this.log('reader', 'startPlay.ok');
      this.loading = false;
      this.status = 'Reader Kit 本机续读已启用。该位置暂无法可靠换算为手表 UTF-8 偏移，因此这本书的进度同步已暂停。';
    } catch (error) {
      const code = this.errorCode(error);
      this.log(this.failureStage(error), 'fail', code);
      this.loading = false;
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
    this.pageFooter = info.pageFooterContent || '';
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
    return this.book !== null ? this.book.title : '';
  }

  private saveCurrentLocation(): void {
    const book = this.book;
    const state = this.readerState;
    if (book === null || state === null || this.currentResourceIndex < 0 ||
        this.currentDomPos.length > 4096) return;
    state.saveLocation(book.bookId, this.readerSha256(book),
      this.currentResourceIndex, this.currentDomPos).then(() => {
      this.log('pageShow', 'position.saved');
    }).catch((error: Error) => {
      this.log('pageShow', 'position.save_fail', this.errorCode(error));
    });
  }

  private pageConfig(): readerCore.ReaderSetting {
    const displayInfo = display.getDefaultDisplaySync();
    const scale = displayInfo.scaledDensity > 0 ?
      displayInfo.scaledDensity : 1;
    const widthPx = this.viewportWidthVp > 0 ?
      this.getUIContext().vp2px(this.viewportWidthVp) : displayInfo.width;
    const heightPx = this.viewportHeightVp > 0 ?
      this.getUIContext().vp2px(this.viewportHeightVp) : displayInfo.height;
    return {
      fontName: 'HarmonyOS Sans',
      fontSize: this.fontSize,
      fontWeight: 400,
      fontColor: this.nightMode ? '#E8EAF0' : '#1F2937',
      fontPath: '',
      lineHeight: this.lineHeight,
      nightMode: this.nightMode,
      themeColor: this.nightMode ? '#101114' : '#F7F4EC',
      themeBgImg: '',
      flipMode: this.flipMode,
      scaledDensity: scale,
      viewPortWidth: Math.max(1, Math.round(widthPx)),
      viewPortHeight: Math.max(1, Math.round(heightPx))
    };
  }

  private applyPageConfig(restorePosition: boolean): void {
    if (this.parser === null || this.leaving) return;
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

  private persistSettings(): void {
    const settings: ReaderKitSettings = {
      fontSize: this.fontSize,
      lineHeight: this.lineHeight,
      nightMode: this.nightMode,
      flipMode: this.flipMode
    };
    if (this.readerState !== null) {
      this.readerState.saveSettings(settings).catch((error: Error) => {
        this.log('settings', 'save', this.errorCode(error));
      });
    }
    setReaderWindowTheme(this.nightMode);
    this.applyPageConfig(true);
  }

  private changeFont(delta: number): void {
    this.fontSize = Math.min(34, Math.max(14, this.fontSize + delta));
    this.persistSettings();
  }

  private changeLineHeight(delta: number): void {
    this.lineHeight = Math.min(2.4,
      Math.max(1.1, Math.round((this.lineHeight + delta) * 10) / 10));
    this.persistSettings();
  }

  private toggleTheme(): void {
    this.nightMode = !this.nightMode;
    this.persistSettings();
  }

  private setFlipMode(mode: string): void {
    if (mode !== '0' && mode !== '1') return;
    this.flipMode = mode;
    this.persistSettings();
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
    this.catalogVisible = false;
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
    this.saveCurrentLocation();
    if (this.book !== null && this.progressStore !== null) {
      await this.progressStore.saveLastBook(this.book.bookId);
    }
    await restoreShelfWindow(this.context());
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
  topControls() {
    Column() {
      Row() {
        Button('‹').fontSize(24).width(44).height(40)
          .backgroundColor('#CC171A20').fontColor('#F4F4F5')
          .onClick(() => { this.backToShelf(); })
        Column() {
          Text(this.title).fontSize(16).fontColor('#F4F4F5')
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(this.chapterTitle).fontSize(12).fontColor('#B7BBC4')
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
            .margin({ top: 2 })
        }
        .alignItems(HorizontalAlign.Start).layoutWeight(1)
        .margin({ left: 12, right: 8 })
        Button('目录').fontSize(13).height(36)
          .backgroundColor('#CC171A20').fontColor('#F4F4F5')
          .onClick(() => { this.catalogVisible = true; })
        Button('Aa').fontSize(13).height(36)
          .backgroundColor('#CC171A20').fontColor('#F4F4F5')
          .margin({ left: 8 })
          .onClick(() => { this.settingsVisible = !this.settingsVisible; })
      }
      .width('100%')
      .padding({ left: 12 + this.safeLeft, right: 12 + this.safeRight,
        top: this.safeTop + 8, bottom: 8 })
      .backgroundColor('#99101114')

      if (this.settingsVisible) {
        Column({ space: 6 }) {
          Row() {
            Button('A−').height(32)
              .onClick(() => { this.changeFont(-2); })
            Text('字号 ' + this.fontSize).fontSize(12)
              .fontColor('#F4F4F5').layoutWeight(1)
              .textAlign(TextAlign.Center)
            Button('A+').height(32)
              .onClick(() => { this.changeFont(2); })
          }
          .width('100%')
          Row() {
            Text('行距').fontSize(12).fontColor('#D1D5DB')
              .layoutWeight(1)
            Button('−').width(52).height(32)
              .onClick(() => { this.changeLineHeight(-0.1); })
            Text(this.lineHeight.toFixed(1)).fontSize(12)
              .fontColor('#F4F4F5').width(48).textAlign(TextAlign.Center)
            Button('+').width(52).height(32)
              .onClick(() => { this.changeLineHeight(0.1); })
          }
          .width('100%')
          Row() {
            Button(this.nightMode ? '浅色主题' : '深色主题')
              .height(32).layoutWeight(1)
              .onClick(() => { this.toggleTheme(); })
            Button(this.flipMode === '1' ? '横向滑页' : '仿真翻页')
              .height(32).layoutWeight(1).margin({ left: 8 })
              .onClick(() => {
                this.setFlipMode(this.flipMode === '1' ? '0' : '1');
              })
          }
          .width('100%')
        }
        .width('100%')
        .padding({ left: 12 + this.safeLeft,
          right: 12 + this.safeRight, top: 6, bottom: 8 })
        .backgroundColor('#F0101114')
      }
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
  }

  @Builder
  catalogPanel() {
    Stack({ alignContent: Alignment.Center }) {
      Column().width('100%').height('100%')
        .backgroundColor('#99000000')
        .onClick(() => { this.catalogVisible = false; })
      Column() {
        Row() {
          Text('目录').fontSize(19).fontWeight(FontWeight.Medium)
            .layoutWeight(1)
          Button('关闭').height(32)
            .onClick(() => { this.catalogVisible = false; })
        }
        .width('100%').padding({ bottom: 10 })
        if (this.catalogs.length === 0) {
          Text('这本书没有可用目录').fontSize(14)
            .fontColor('#9CA3AF').padding(20)
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
          .divider({ strokeWidth: 1, color: '#30343D' })
        }
      }
      .width('90%').height('78%').constraintSize({ maxWidth: 620 })
      .padding(18).backgroundColor('#1C2028').borderRadius(20)
    }
    .width('100%').height('100%')
    .padding({ top: this.safeTop + 8, bottom: this.safeBottom + 8,
      left: this.safeLeft, right: this.safeRight })
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      if (this.readerAvailable && this.book !== null) {
        ReadPageComponent({
          controller: this.controller,
          readerCallback: (error, controller) => {
            if (error) {
              this.loading = false;
              this.status = 'Reader Kit 组件初始化失败（错误码 ' +
                this.errorCode(error) + '）';
              this.log('reader', 'component.fail', this.errorCode(error));
              return;
            }
            this.initializeReader(controller);
          }
        })
        .width('100%').height('100%')
      } else {
        Column() {
          Text(this.status).fontSize(15).fontColor('#D1D5DB')
          Button('返回书架').margin({ top: 20 })
            .onClick(() => { this.backToShelf(); })
        }
        .width('100%').height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor('#101114')
      }

      if (this.loading) {
        Column() {
          Text('正在打开……').fontSize(14).fontColor('#D1D5DB')
        }
        .width('100%').height('100%').justifyContent(FlexAlign.Center)
        .backgroundColor('#CC101114').hitTestBehavior(HitTestMode.None)
      }

      if (!this.loading && this.readerAvailable && this.controlsVisible) {
        Column() {
          this.topControls()
          Blank().layoutWeight(1).hitTestBehavior(HitTestMode.None)
          Column() {
            if (this.status.length > 0) {
              Text(this.status).fontSize(11).fontColor('#E5E7EB')
                .maxLines(2).width('100%').textAlign(TextAlign.Center)
            }
            Text(this.pageFooter).fontSize(11).fontColor('#B7BBC4')
              .width('100%').textAlign(TextAlign.Center)
          }
          .width('100%')
          .padding({ left: 12 + this.safeLeft,
            right: 12 + this.safeRight, top: 8,
            bottom: 8 + this.safeBottom })
          .backgroundColor('#99101114')
        }
        .width('100%').height('100%')
        .hitTestBehavior(HitTestMode.Transparent)
      }

      if (this.catalogVisible) this.catalogPanel()
    }
    .width('100%').height('100%').backgroundColor('#101114')
    .onAreaChange((oldArea: Area, newArea: Area) => {
      const width = parseFloat(newArea.width.toString());
      const height = parseFloat(newArea.height.toString());
      if (!Number.isFinite(width) || !Number.isFinite(height) ||
          width <= 0 || height <= 0 ||
          (Math.abs(width - this.viewportWidthVp) < 0.5 &&
           Math.abs(height - this.viewportHeightVp) < 0.5)) return;
      this.viewportWidthVp = width;
      this.viewportHeightVp = height;
      if (this.resizeTimer !== -1) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.resizeTimer = -1;
        this.applyPageConfig(true);
        refreshReaderWindowInsets();
      }, 120);
    })
  }
}
