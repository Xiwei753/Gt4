// SPDX-License-Identifier: GPL-3.0-only
// 鸿蒙手机本机阅读器首版：按规范化 UTF-8 字节窗口读取，绝不把整本
// 32 MiB 正文塞进状态；字体/主题/窗口宽度只影响显示，不改变进度。
import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { router } from '@kit.ArkUI';
import { BookChapter, BookMeta } from '../model/BookModels';
import { BookRepository } from '../services/BookRepository';
import { ReadingProgressStore } from '../services/ReadingProgressStore';
import { addReadingApplyListener, addReadingPrepareListener,
  removeReadingApplyListener,
  removeReadingPrepareListener } from '../services/ReadingSyncEvents';
import { chapterIndexAt } from '../model/TextWindow';
import {
  loadedSegmentBytes,
  safeWindowLength,
  segmentIndexForOffset,
  splitWindowSegments
} from '../model/ReaderSegments';
import { bumpWriteGeneration, captureWriteGeneration }
  from '../model/ProgressWriteQueue';

const WINDOW_BYTES = 64 * 1024;
// 每段约 256 字节，进度精度远高于旧的 6 KiB 块，又不会让列表项过多。
const SEGMENT_TARGET_BYTES = 256;
const MAX_LOADED_SEGMENTS = 900;
const MAX_LOADED_BYTES = 256 * 1024;
// 程序化滚动后 List 会先发临时索引；等动画落定再接收 onScrollIndex。
const SCROLL_GUARD_MS = 700;
const CHAPTER_PAGE_SIZE = 100;

interface ReaderParams {
  bookId?: string;
}

interface ReaderSegment {
  offset: number;
  length: number;
  text: string;
}

@Entry
@Component
struct Reader {
  @State private title: string = '';
  @State private segments: ReaderSegment[] = [];
  @State private chapters: BookChapter[] = [];
  @State private fontSize: number = 20;
  @State private lineSpacing: number = 1.65;
  @State private darkTheme: boolean = true;
  @State private showSettings: boolean = false;
  @State private showChapters: boolean = false;
  @State private chapterPage: number = 0;
  @State private loading: boolean = true;
  @State private status: string = '正在打开……';
  @State private currentIndex: number = 0;
  @State private currentOffset: number = 0;
  @State private progressLabel: string = '';
  @State private pagePadding: number = 16;

  private book: BookMeta | null = null;
  private repository: BookRepository | null = null;
  private progressStore: ReadingProgressStore | null = null;
  private fd: number = -1;
  private scroller: Scroller = new Scroller();
  private saveTimer: number = -1;
  private lastSavedOffset: number = -1;
  // 跳章/同步/字号重排期间禁止 onScrollIndex 覆盖目标位置。
  private scrollGuardActive: boolean = false;
  private scrollGuardToken: number = 0;
  private scrollGuardTimer: number = -1;
  private scrollGuardTarget: number = -1;
  // 串行化进度写入，避免较早的异步写入晚于新位置落盘；
  // epoch 用于远端进度应用后作废尚未执行的本地写入。
  private saveChain: Promise<void> = Promise.resolve();
  private saveEpoch: number = 0;
  private loadingMore: boolean = false;
  private opened: boolean = false;
  private remotePrepare = (bookId: string): void => {
    const book = this.book;
    if (book === null || book.bookId !== bookId) return;
    // 远端写入 Preferences 之前先取消旧 debounce 并作废旧代次，
    // 防止旧定时器在远端写入之后又把旧位置排进队列。
    this.saveEpoch++;
    if (this.saveTimer !== -1) {
      clearTimeout(this.saveTimer);
      this.saveTimer = -1;
    }
    bumpWriteGeneration(bookId);
  };

  private remoteApply = (bookId: string, offset: number): void => {
    const book = this.book;
    if (book === null || book.bookId !== bookId) return;
    // 远端进度优先于尚未落盘的本地写入。
    this.saveEpoch++;
    if (this.saveTimer !== -1) {
      clearTimeout(this.saveTimer);
      this.saveTimer = -1;
    }
    const target = this.snapFileOffset(offset);
    this.status = '已采用同步进度，正在重绘……';
    this.loadWindowAt(target, target, true).then(() => {
      this.lastSavedOffset = this.currentOffset;
      this.status = '';
    }).catch(() => {
      this.status = '同步进度重绘失败，继续使用当前位置';
    });
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

  aboutToAppear(): void {
    addReadingApplyListener(this.remoteApply);
    addReadingPrepareListener(this.remotePrepare);
    if (!this.opened) {
      this.opened = true;
      this.openBook();
    }
  }

  onPageHide(): void {
    this.flushSave();
  }

  aboutToDisappear(): void {
    removeReadingApplyListener(this.remoteApply);
    removeReadingPrepareListener(this.remotePrepare);
    this.cancelScrollGuard();
    this.flushSave();
    this.closeFile();
  }

  private async openBook(): Promise<void> {
    const params = router.getParams() as ReaderParams;
    const bookId = params && typeof params.bookId === 'string' ? params.bookId : '';
    if (!bookId) {
      this.loading = false;
      this.status = '缺少书籍参数，无法打开阅读页';
      return;
    }
    const book = this.getRepository().get(bookId);
    if (book === null) {
      this.loading = false;
      this.status = '书籍不存在，或正文文件已被删除';
      return;
    }
    this.book = book;
    this.title = book.title;
    this.chapters = book.chapters;
    try {
      this.fd = fileIo.openSync(book.filePath,
        fileIo.OpenMode.READ_ONLY).fd;
    } catch (error) {
      this.loading = false;
      this.status = '打开正文失败，请重新导入或查看日志';
      return;
    }

    let start = 0;
    try {
      const record = await this.getProgressStore().load(
        book.bookId, book.sha256);
      if (record !== null) start = record.offset;
    } catch (error) {
      // 进度读取失败不能阻塞阅读，从文件头开始。
    }
    await this.loadWindowAt(start, start, true);
    try {
      await this.getProgressStore().saveLastBook(book.bookId);
    } catch (error) {
      // 最后阅读书只是入口提示，失败不影响正文。
    }
    this.loading = false;
  }

  private readBytes(offset: number, length: number): Uint8Array {
    if (this.fd < 0 || length <= 0) return new Uint8Array(0);
    const buffer = new Uint8Array(length);
    const read = fileIo.readSync(this.fd, buffer.buffer,
      { offset: offset, length: length });
    return buffer.subarray(0, Math.max(read, 0));
  }

  // 保存/同步来的 offset 可能落在 UTF-8 续字节上；向前吸附到字符起点。
  private snapFileOffset(offset: number): number {
    const book = this.book;
    if (book === null) return 0;
    if (!Number.isFinite(offset)) return 0;
    let value = Math.floor(offset);
    if (value <= 0) return 0;
    if (value >= book.bytes) return book.bytes;
    const start = Math.max(0, value - 3);
    const bytes = this.readBytes(start, value - start + 1);
    let pos = value;
    while (pos > start &&
        (bytes[pos - start] & 0xC0) === 0x80) {
      pos--;
    }
    return pos;
  }

  private async loadWindowAt(startOffset: number,
    anchorOffset: number, scroll: boolean): Promise<void> {
    const book = this.book;
    if (book === null || this.fd < 0) return;
    const base = this.snapFileOffset(startOffset);
    const length = Math.min(WINDOW_BYTES, book.bytes - base);
    if (length <= 0) {
      this.segments = [];
      this.loading = false;
      return;
    }
    const raw = this.readBytes(base, length);
    const usable: number = safeWindowLength(raw,
      base + length < book.bytes) as number;
    if (usable <= 0) {
      this.segments = [];
      this.loading = false;
      this.status = '正文窗口边界异常';
      return;
    }
    const bytes = raw.subarray(0, usable);
    const ranges = splitWindowSegments(bytes, SEGMENT_TARGET_BYTES,
      MAX_LOADED_SEGMENTS) as ReaderSegment[];
    const next: ReaderSegment[] = [];
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i];
      next.push({
        offset: base + range.offset,
        length: range.length,
        text: range.text
      });
    }
    // 先定位到包含 anchorOffset 的分段，再整体替换列表并滚到该段。
    const target = this.indexIn(next, anchorOffset);
    if (scroll) this.armScrollGuard(target, true);
    this.segments = next;
    this.currentIndex = target;
    this.currentOffset = next.length > 0 ? next[target].offset : base;
    this.updateProgressLabel();
    this.status = '';
  }

  private indexIn(list: ReaderSegment[], offset: number): number {
    if (list.length === 0) return 0;
    return segmentIndexForOffset(list, offset);
  }

  private indexForOffset(offset: number): number {
    return this.indexIn(this.segments, offset);
  }

  // 跳转后 List 可能先发出临时的 0 号索引；在滚动落定前忽略
  // onScrollIndex，避免把刚同步/跳转到的位置又写回文件头。
  private cancelScrollGuard(): void {
    this.scrollGuardToken++;
    this.scrollGuardActive = false;
    this.scrollGuardTarget = -1;
    if (this.scrollGuardTimer !== -1) {
      clearTimeout(this.scrollGuardTimer);
      this.scrollGuardTimer = -1;
    }
  }

  private armScrollGuard(index: number, animate: boolean): void {
    this.scrollGuardToken++;
    const token = this.scrollGuardToken;
    this.scrollGuardActive = true;
    // 跳章/同步允许目标段到顶后提前结束守卫；重排要等布局稳定。
    this.scrollGuardTarget = animate ? index : -1;
    if (this.scrollGuardTimer !== -1) {
      clearTimeout(this.scrollGuardTimer);
    }
    this.scrollGuardTimer = setTimeout(() => {
      if (token !== this.scrollGuardToken) return;
      this.scrollGuardActive = false;
      this.scrollGuardTarget = -1;
      this.scrollGuardTimer = -1;
      this.updateProgressLabel();
      // 跳转目标可能靠近当前窗口末尾；落定后补一次有界加载。
      if (this.currentIndex >= this.segments.length - 2) {
        this.appendNext();
      }
    }, SCROLL_GUARD_MS);
    // 字号/行距/宽度变化后先让本轮布局完成，再按段索引回锚。
    setTimeout(() => {
      if (token !== this.scrollGuardToken) return;
      if (index >= 0 && index < this.segments.length) {
        this.scroller.scrollToIndex(index, animate);
      }
    }, animate ? 0 : 50);
  }

  // 字号/行距/主题/窗口宽度变化后用当前字节位置重新定位，不回到 0。
  private rescrollToCurrent(): void {
    if (this.segments.length === 0) return;
    const index = this.indexForOffset(this.currentOffset);
    this.currentIndex = index;
    this.armScrollGuard(index, false);
  }

  private loadedBytes(): number {
    return loadedSegmentBytes(this.segments) as number;
  }

  private appendNext(): void {
    const book = this.book;
    if (book === null || this.fd < 0 || this.loadingMore ||
        this.segments.length === 0) return;
    const loaded = this.loadedBytes();
    if (this.segments.length >= MAX_LOADED_SEGMENTS ||
        loaded >= MAX_LOADED_BYTES) {
      this.status = '已到当前窗口末尾，点“继续加载”继续阅读';
      return;
    }
    const last = this.segments[this.segments.length - 1];
    const start = last.offset + last.length;
    if (start >= book.bytes) return;
    this.loadingMore = true;
    const length = Math.min(WINDOW_BYTES, book.bytes - start);
    const raw = this.readBytes(start, length);
    const usable: number = safeWindowLength(raw,
      start + length < book.bytes) as number;
    if (usable <= 0) {
      this.loadingMore = false;
      this.status = '正文窗口边界异常，点“继续加载”重试';
      return;
    }
    const bytes = raw.subarray(0, usable);
    const ranges = splitWindowSegments(bytes, SEGMENT_TARGET_BYTES,
      MAX_LOADED_SEGMENTS) as ReaderSegment[];
    const appended: ReaderSegment[] = [];
    let used = loaded;
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i];
      if (this.segments.length + appended.length >= MAX_LOADED_SEGMENTS) break;
      if (used + range.length > MAX_LOADED_BYTES) break;
      appended.push({
        offset: start + range.offset,
        length: range.length,
        text: range.text
      });
      used += range.length;
    }
    if (appended.length > 0) {
      this.segments = this.segments.concat(appended);
      this.status = '';
    } else if (start < book.bytes) {
      // 余量不足一段时不要静默卡住，仍给出“继续加载”入口。
      this.status = '已到当前窗口末尾，点“继续加载”继续阅读';
    }
    this.loadingMore = false;
  }

  private continueFromHere(): void {
    this.status = '';
    this.loadWindowAt(this.currentOffset, this.currentOffset, true);
  }

  private onScrollIndex(start: number, end: number): void {
    if (this.scrollGuardActive) {
      // 目标段真正到达列表顶部后才恢复接收；中途的 0 号/过路索引一律忽略。
      if (this.scrollGuardTarget < 0 || start !== this.scrollGuardTarget) {
        return;
      }
      if (this.scrollGuardTimer !== -1) {
        clearTimeout(this.scrollGuardTimer);
        this.scrollGuardTimer = -1;
      }
      this.scrollGuardActive = false;
      this.scrollGuardTarget = -1;
    }
    if (start < 0 || start >= this.segments.length) return;
    const segment = this.segments[start];
    this.currentIndex = start;
    this.currentOffset = segment.offset;
    this.updateProgressLabel();
    this.scheduleSave(segment.offset);
    if (end >= this.segments.length - 2) {
      this.appendNext();
    }
  }

  private updateProgressLabel(): void {
    const book = this.book;
    if (book === null || book.bytes <= 0) {
      this.progressLabel = '';
      return;
    }
    const percent = Math.min(100,
      Math.floor(this.currentOffset * 100 / book.bytes));
    this.progressLabel = percent + '% · ' + this.currentChapterTitle();
  }

  private currentChapterIndex(): number {
    if (this.chapters.length === 0) return -1;
    return chapterIndexAt(this.chapters, this.currentOffset);
  }

  private currentChapterTitle(): string {
    const index = this.currentChapterIndex();
    if (index >= 0 && index < this.chapters.length) {
      return this.chapters[index].title;
    }
    return '正文';
  }

  private scheduleSave(offset: number): void {
    if (offset === this.lastSavedOffset) return;
    const book = this.book;
    if (book === null) return;
    const generation: number =
      captureWriteGeneration(book.bookId) as number;
    if (this.saveTimer !== -1) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = -1;
      this.saveOffset(offset, generation);
    }, 700);
  }

  private saveOffset(offset: number, generation?: number): Promise<void> {
    const book = this.book;
    if (book === null || !Number.isInteger(offset) || offset < 0) {
      return this.saveChain;
    }
    if (offset === this.lastSavedOffset) return this.saveChain;
    const epoch = this.saveEpoch;
    const writeGeneration: number = generation !== undefined ? generation :
      captureWriteGeneration(book.bookId) as number;
    this.saveChain = this.saveChain.then(async () => {
      // 远端进度已应用，旧的本地位置不能再覆盖它。
      if (epoch !== this.saveEpoch) return;
      if (offset === this.lastSavedOffset) return;
      try {
        await this.getProgressStore().save(book.bookId, book.sha256,
          offset, undefined, writeGeneration);
        if (epoch === this.saveEpoch) {
          this.lastSavedOffset = offset;
        }
      } catch (error) {
        // 阅读进度保存失败不能打断翻页；下次退出/重开会再尝试。
      }
    });
    return this.saveChain;
  }

  private flushSave(): void {
    if (this.saveTimer !== -1) {
      clearTimeout(this.saveTimer);
      this.saveTimer = -1;
    }
    const book = this.book;
    const generation: number = book !== null ?
      captureWriteGeneration(book.bookId) as number : 0;
    this.saveOffset(this.currentOffset, generation);
  }

  private closeFile(): void {
    if (this.fd >= 0) {
      try {
        fileIo.closeSync(this.fd);
      } catch (error) {
        // 已关闭或文件被系统回收。
      }
      this.fd = -1;
    }
  }

  private async backToShelf(): Promise<void> {
    if (this.saveTimer !== -1) {
      clearTimeout(this.saveTimer);
      this.saveTimer = -1;
    }
    await this.saveOffset(this.currentOffset);
    const book = this.book;
    if (book !== null) {
      try {
        await this.getProgressStore().saveLastBook(book.bookId);
      } catch (error) {
        // 入口提示失败不影响返回。
      }
    }
    router.back();
  }

  private changeFont(delta: number): void {
    const next = Math.max(16, Math.min(32, this.fontSize + delta));
    if (next === this.fontSize) return;
    this.fontSize = next;
    this.rescrollToCurrent();
  }

  private changeSpacing(delta: number): void {
    const next = Math.round((this.lineSpacing + delta) * 10) / 10;
    const value = Math.max(1.2, Math.min(2.4, next));
    if (value === this.lineSpacing) return;
    this.lineSpacing = value;
    this.rescrollToCurrent();
  }

  private toggleTheme(): void {
    this.darkTheme = !this.darkTheme;
    this.rescrollToCurrent();
  }

  private openChapterPanel(): void {
    const index = this.currentChapterIndex();
    this.chapterPage = index >= 0 ?
      Math.floor(index / CHAPTER_PAGE_SIZE) : 0;
    this.showChapters = true;
  }

  private chapterSlice(): BookChapter[] {
    const start = this.chapterPage * CHAPTER_PAGE_SIZE;
    return this.chapters.slice(start, start + CHAPTER_PAGE_SIZE);
  }

  private chapterPageCount(): number {
    return Math.max(1,
      Math.ceil(this.chapters.length / CHAPTER_PAGE_SIZE));
  }

  private jumpChapter(index: number): void {
    if (index < 0 || index >= this.chapters.length) return;
    const chapter = this.chapters[index];
    this.showChapters = false;
    this.status = '正在跳转……';
    this.loadWindowAt(chapter.offset, chapter.offset, true);
  }

  private previousChapter(): void {
    const index = this.currentChapterIndex();
    if (index > 0) this.jumpChapter(index - 1);
  }

  private nextChapter(): void {
    const index = this.currentChapterIndex();
    if (index >= 0 && index + 1 < this.chapters.length) {
      this.jumpChapter(index + 1);
    }
  }

  private pageBackground(): string {
    return this.darkTheme ? '#101114' : '#f7f4ec';
  }

  private panelColor(): string {
    return this.darkTheme ? '#20242c' : '#ffffff';
  }

  private textColor(): string {
    return this.darkTheme ? '#e8eaf0' : '#1f2937';
  }

  private mutedColor(): string {
    return this.darkTheme ? '#9ca3af' : '#6b7280';
  }

  @Builder
  topBar() {
    Row() {
      Button('返回')
        .fontSize(13)
        .height(30)
        .backgroundColor(this.panelColor())
        .fontColor(this.textColor())
        .onClick(() => { this.backToShelf(); })
      Column() {
        Text(this.title).fontSize(17)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.textColor())
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.currentChapterTitle()).fontSize(12)
          .fontColor(this.mutedColor())
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .margin({ top: 2 })
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      .margin({ left: 10, right: 8 })
      Button('目录')
        .fontSize(13)
        .height(30)
        .backgroundColor(this.panelColor())
        .fontColor(this.textColor())
        .onClick(() => { this.openChapterPanel(); })
      Button('Aa')
        .fontSize(13)
        .height(30)
        .backgroundColor(this.panelColor())
        .fontColor(this.textColor())
        .margin({ left: 8 })
        .onClick(() => { this.showSettings = !this.showSettings; })
    }
    .width('100%')
    .padding({ left: this.pagePadding, right: this.pagePadding,
      top: 10, bottom: 10 })
    .backgroundColor(this.panelColor())
  }

  @Builder
  settingsBar() {
    Row() {
      Button('A-').fontSize(13).height(30)
        .backgroundColor(this.panelColor())
        .fontColor(this.textColor())
        .onClick(() => { this.changeFont(-2); })
      Button('A+').fontSize(13).height(30)
        .backgroundColor(this.panelColor())
        .fontColor(this.textColor())
        .margin({ left: 6 })
        .onClick(() => { this.changeFont(2); })
      Button('行距-').fontSize(12).height(30)
        .backgroundColor(this.panelColor())
        .fontColor(this.textColor())
        .margin({ left: 6 })
        .onClick(() => { this.changeSpacing(-0.1); })
      Button('行距+').fontSize(12).height(30)
        .backgroundColor(this.panelColor())
        .fontColor(this.textColor())
        .margin({ left: 6 })
        .onClick(() => { this.changeSpacing(0.1); })
      Button(this.darkTheme ? '浅色' : '深色')
        .fontSize(12).height(30)
        .backgroundColor(this.panelColor())
        .fontColor(this.textColor())
        .margin({ left: 6 })
        .onClick(() => { this.toggleTheme(); })
      Text(this.fontSize + ' / ' + this.lineSpacing.toFixed(1))
        .fontSize(12).fontColor(this.mutedColor())
        .margin({ left: 8 })
    }
    .width('100%')
    .padding({ left: this.pagePadding, right: this.pagePadding,
      top: 6, bottom: 6 })
    .backgroundColor(this.pageBackground())
  }

  @Builder
  bottomBar() {
    Row() {
      Button('上一章')
        .fontSize(12).height(30)
        .backgroundColor(this.panelColor())
        .fontColor(this.textColor())
        .enabled(this.currentChapterIndex() > 0)
        .onClick(() => { this.previousChapter(); })
      Text(this.progressLabel)
        .fontSize(12).fontColor(this.mutedColor())
        .layoutWeight(1).textAlign(TextAlign.Center)
        .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
      Button('下一章')
        .fontSize(12).height(30)
        .backgroundColor(this.panelColor())
        .fontColor(this.textColor())
        .enabled(this.currentChapterIndex() >= 0 &&
          this.currentChapterIndex() + 1 < this.chapters.length)
        .onClick(() => { this.nextChapter(); })
    }
    .width('100%')
    .padding({ left: this.pagePadding, right: this.pagePadding,
      top: 8, bottom: 10 })
    .backgroundColor(this.panelColor())
  }

  @Builder
  chapterOverlay() {
    Column() {
      Row() {
        Text('目录 · ' + this.chapters.length + ' 章')
          .fontSize(18).fontWeight(FontWeight.Medium)
          .fontColor(this.textColor()).layoutWeight(1)
        Button('关闭').fontSize(12).height(30)
          .backgroundColor(this.panelColor())
          .fontColor(this.textColor())
          .onClick(() => { this.showChapters = false; })
      }
      .width('100%').padding({ bottom: 8 })
      List() {
        ForEach(this.chapterSlice(), (chapter: BookChapter,
          index: number) => {
          ListItem() {
            Text((this.chapterPage * CHAPTER_PAGE_SIZE + index + 1) +
              '. ' + chapter.title)
              .fontSize(14)
              .fontColor(this.textColor())
              .width('100%')
              .padding({ top: 9, bottom: 9 })
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .onClick(() => {
                this.jumpChapter(this.chapterPage * CHAPTER_PAGE_SIZE + index);
              })
          }
        }, (chapter: BookChapter) => chapter.offset.toString())
      }
      .layoutWeight(1).width('100%')
      .divider({ strokeWidth: 1, color: this.mutedColor() })
      Row() {
        Button('上一页').fontSize(12).height(30)
          .enabled(this.chapterPage > 0)
          .onClick(() => { this.chapterPage--; })
        Text((this.chapterPage + 1) + ' / ' + this.chapterPageCount())
          .fontSize(12).fontColor(this.mutedColor())
          .layoutWeight(1).textAlign(TextAlign.Center)
        Button('下一页').fontSize(12).height(30)
          .enabled(this.chapterPage + 1 < this.chapterPageCount())
          .onClick(() => { this.chapterPage++; })
      }
      .width('100%').padding({ top: 8 })
    }
    .width('90%').height('80%')
    .padding(16)
    .backgroundColor(this.panelColor())
    .borderRadius(18)
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      Row() {
        Column() {
          this.topBar()
          if (this.loading) {
            Column() {
              Text('正在打开……').fontSize(15).fontColor(this.mutedColor())
            }
            .layoutWeight(1).width('100%')
            .justifyContent(FlexAlign.Center)
          } else if (this.segments.length === 0) {
            Column({ space: 10 }) {
              Text(this.status).fontSize(15).fontColor(this.mutedColor())
              Button('返回书架').onClick(() => { this.backToShelf(); })
            }
            .layoutWeight(1).width('100%')
            .justifyContent(FlexAlign.Center)
          } else {
            List({ space: 0, scroller: this.scroller }) {
              ForEach(this.segments, (segment: ReaderSegment) => {
                ListItem() {
                  Text(segment.text)
                    .fontSize(this.fontSize)
                    .lineHeight(this.fontSize * this.lineSpacing)
                    .fontColor(this.textColor())
                    .width('100%')
                    .padding({ left: this.pagePadding, right: this.pagePadding,
                      top: 6, bottom: 6 })
                    .textAlign(TextAlign.Start)
                }
              }, (segment: ReaderSegment) => segment.offset.toString())
            }
            .layoutWeight(1)
            .width('100%')
            .scrollBar(BarState.Auto)
            .edgeEffect(EdgeEffect.Spring)
            .onScrollIndex((start: number, end: number) => {
              this.onScrollIndex(start, end);
            })
          }
          if (this.showSettings) {
            this.settingsBar()
          }
          if (this.status.length > 0 && this.segments.length > 0) {
            Row() {
              Text(this.status).fontSize(12).fontColor(this.mutedColor())
                .layoutWeight(1).maxLines(2)
              if (this.status.indexOf('继续加载') >= 0) {
                Button('继续加载').fontSize(12).height(28)
                  .onClick(() => { this.continueFromHere(); })
              }
            }
            .width('100%')
            .padding({ left: this.pagePadding, right: this.pagePadding,
              top: 4, bottom: 4 })
            .backgroundColor(this.pageBackground())
          }
          this.bottomBar()
        }
        .width('100%')
        .height('100%')
        .constraintSize({ maxWidth: 920 })
      }
      .width('100%')
      .height('100%')
      .justifyContent(FlexAlign.Center)
      .backgroundColor(this.pageBackground())

      if (this.showChapters) {
        this.chapterOverlay()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.pageBackground())
    .onAreaChange((oldValue: Area, newValue: Area) => {
      const width = parseFloat(newValue.width.toString());
      if (isFinite(width)) {
        const nextPadding = width >= 720 ? 36 : 16;
        if (nextPadding !== this.pagePadding) {
          this.pagePadding = nextPadding;
          // 宽度跨档会改变行宽，重新锚定当前字节位置。
          this.rescrollToCurrent();
        }
      }
    })
  }
}
