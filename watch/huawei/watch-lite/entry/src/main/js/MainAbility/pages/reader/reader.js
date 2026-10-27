// SPDX-License-Identifier: GPL-3.0-only
// 阅读页：按路由参数 bookId 打开对应书籍；
// 每本书独立进度与设置；字号/行距/主题可调，
// 按当前字节位置重排（不丢字、不重复、不跳页）。
//
// issue #11：正文改为 **Canvas 圆形排版**（不再是方形 list-item）。
// - 分页：reader/PageLayout.takeCanvasPage（真实 measureText + 真实画布尺寸，
//   按每行字形上下边缘取圆弦宽度），输出可直接绘制的行坐标；
// - 绘制：reader/CanvasTextRenderer.drawPage（clearRect/fillRect/fillText）；
// - 数据先到 / 画布先到都会正确绘制（pending + 延迟重绘）；
// - Context 只在 onShow 取一次；无像素回读、无文字备份层、无重试定时器。
//
// issue #10 复核：正文显示与翻页**绝不依赖进度文件读写完成**。
// - 打开即从头分页显示；进度在后台加载，回来时若用户还没翻页才跳过去；
// - 翻页渲染完成立刻解锁并后台串行保存，进度写不回调也不卡阅读；
// - 迟到的保存回调不会倒退已变化的阅读位置。
import router from '@system.router';
import { getBook } from '../../storage/LibraryIndex';
import { openBook, readBytes } from '../../storage/BookStorage';
import { isBundled, bundledEntry,
  readBundledWindow } from '../../storage/BundledBookSource';
import { loadProgress,
  saveProgress, saveLastBook } from '../../storage/ProgressStore';
import { takeCanvasPage } from '../../reader/PageLayout';
import { normalizeChapters, chapterIndexAt,
  chapterRows, chapterLabel } from '../../reader/Chapters';
import { drawPage } from '../../reader/CanvasTextRenderer';
import { loadReaderPreferences, saveReaderPreferences }
  from '../../storage/ReaderPreferences.js';
import { normalizeSettings } from '../../reader/ReaderSettings';
import { createCrownTracker,
  crownStatus } from '../../reader/CrownInput';
import { isLowerHex } from '../../util/Validate';

// 画布初始尺寸（HML width/height 绑定）；真实值以运行时画布为准。
var CANVAS_SIZE = 452;
// 圆屏安全内边距：留出边缘，避免贴边裁切。
var EDGE_PADDING = 10;

export default {
  data: {
    // issue #10：Lite 通过目标页 data 的**同名字段**注入路由参数，
    // 因此这里必须声明 bookId，且 onInit 不得把它清空。
    bookId: '',
    title: '',
    // 仅用于“读取失败”纯文字提示（正常阅读时不可见）。
    body: '正在读取本地文本……',
    // 首次打开没有已绘制的正文，必须显示加载提示而不是纯黑屏。
    // 这是状态提示，不是另一套 HML 正文渲染。
    readingError: true,
    pageHint: '请稍候',
    offset: 0,
    nextOffset: 0,
    fontSize: 20,
    lineHeightRatio: 1.55,
    theme: 'night',
    canvasSize: CANVAS_SIZE,
    // 表冠：隐藏 slider 是否真的挂载（设备运行时可见），
    // 与"旋转事件是否送达"是两件事，后者待真机验证。
    crownMounted: false,
    crownStatus: 'unverified',
    isBusy: true,
    // 正文与设置互斥显示。左滑设置，系统右滑返回。
    settingsOpen: false,
    // 章节面板嵌在设置页内，只展示当前章节附近的有界行数。
    hasChapters: false,
    chapterOpen: false,
    chapterLabel: '',
    chapterRows: [],
    chapterPrevEnabled: false,
    chapterNextEnabled: false
  },
  onInit() {
    this.history = [];
    this.settings = normalizeSettings(null);
    this.crownStatus = crownStatus();
    this.crownTracker = createCrownTracker(null);
    // issue #10：用户是否已经翻过页；决定迟到的进度是否还能应用。
    this.userMoved = false;
    this.saving = false;
    this.saveWanted = false;
    // 初始渲染不允许把默认设置写回旧进度。
    this.progressReady = false;
    this.preferencesReady = false;
    this.renderedOnce = false;
    this.settingsTouched = false;
    this.prefSaving = false;
    this.prefWanted = false;
    this.returnToShelf = false;
    this.progressError = '';
    // 待绘制的页（数据先到、画布后到时先存这里）。
    this.pending = null;
    this.ctx = null;
    // onShow 才允许取得 Canvas context；数据提前到达只保留 pending。
    this.canvasReady = false;
    this.chapters = [];
    this.chapterIndex = -1;
    this.chapterOpen = false;
    this.lastBookSaved = false;
    // Lite 通过目标页 data 同名字段注入 bookId（不再用旧的取参接口）；
    // 切勿在这里重置 this.bookId，否则会把收到的参数清空。
    const bookId = this.bookId;
    if (typeof bookId !== 'string' ||
        !isLowerHex(bookId, 16)) {
      this.readingError = true;
      this.body = '打开失败：未收到有效书籍编号\\n请返回书架重选';
      this.pageHint = '未知书籍，请返回书架选择';
      this.isBusy = false;
      return;
    }
    // 内置书（issue #10）：正文来自 rawfile 资源，按需窗口读取；
    // 外部书仍走原有文件通路。两者都**先出正文**再看进度。
    this.bundled = isBundled(bookId);
    if (this.bundled) {
      const entry = bundledEntry(bookId);
      this.title = entry ? entry.title : '内置书籍';
      this.setChapters(entry);
      this.startReading();
      return;
    }
    openBook(bookId, (state) => {
      if (!state.ok) {
        this.readingError = true;
        this.body = '打开失败：书籍不存在或已删除';
        this.pageHint = '书籍不存在或已删除';
        this.isBusy = false;
        return;
      }
      getBook(bookId, (entry) => {
        this.title = entry ? entry.title : '未知书名';
        this.setChapters(entry);
        this.startReading();
      });
    });
  },
  setChapters(entry) {
    const total = entry && typeof entry.bytes === 'number' ?
      entry.bytes : 0;
    this.chapters = normalizeChapters(entry && entry.chapters, total);
    this.hasChapters = this.chapters.length > 1;
    this.refreshChapterView();
  },
  refreshChapterView() {
    this.chapterIndex = chapterIndexAt(this.chapters, this.offset);
    this.chapterLabel = chapterLabel(this.chapters, this.chapterIndex);
    this.chapterRows = chapterRows(this.chapters, this.chapterIndex, 2);
    this.chapterPrevEnabled = this.chapterIndex > 0;
    this.chapterNextEnabled = this.chapterIndex >= 0 &&
      this.chapterIndex < this.chapters.length - 1;
  },
  // 初次打开的书没有 per-book 阅读设置。原链路把位置与两次
  // 设置 KV 读取串在一起：只要“缺省设置”调用不及时返回，
  // 正文连一次读取都不会启动，屏幕永久显示最初的加载文字。
  // 位置恢复仍是唯一写入位置的真相；设置独立读取，绝不挡住正文。
  setLoadingStage(stage) {
    this.pageHint = '打开阶段：' + stage;
    if (!this.renderedOnce) {
      this.readingError = true;
      this.body = '正在读取本地文本……\n阶段：' + stage;
    }
  },
  startReading() {
    this.isBusy = true;
    this.setLoadingStage('读取阅读位置');
    loadProgress(this.bookId, (progress) => {
      if (!progress.ok) {
        this.readingError = true;
        this.body = '阅读位置读取失败：' + progress.code;
        this.pageHint = '阅读位置读取失败：' + progress.code;
        this.isBusy = false;
        return;
      }
      this.history = progress.history;
      this.progressReady = true;
      this.setLoadingStage('读取正文');
      // 不等每本书的“字号设置”KV 回调。即使某个新书的设置 key
      // 不存在或存储后端迟迟不回应，真正的 TXT 仍会被读取并绘制。
      this.loadPage(progress.offset);
      // 字号/主题依旧只存在 ReaderPreferences，没有第二套存储。
      // 设置回调若来晚，则按当前真实字节位置重画，不改动阅读历史。
      loadReaderPreferences(this.bookId, (saved) => {
        this.preferencesReady = true;
        if (this.settingsTouched) return;
        var previous = this.currentSettings();
        this.applySettings(saved);
        var changed = previous.fontSize !== this.fontSize ||
          previous.lineHeightRatio !== this.lineHeightRatio ||
          previous.theme !== this.theme;
        if (!changed || this.settingsOpen) return;
        if (this.pending && this.canvasReady) {
          // 文件先到、设置后到：使用最终字号画这同一页。
          this.renderPending();
        } else if (this.renderedOnce && !this.isLoading) {
          // 已画过正文再恢复字号，重新分页当前真实字节位置；
          // 进度的 offset/history 均不清零。
          this.redraw();
        }
      });
    });
  },
  applySettings(settings) {
    this.settings = normalizeSettings(settings);
    this.fontSize = this.settings.fontSize;
    this.lineHeightRatio = this.settings.lineHeightRatio;
    this.theme = this.settings.theme;
  },
  currentSettings() {
    return {
      fontSize: this.fontSize,
      lineHeightRatio: this.lineHeightRatio,
      theme: this.theme
    };
  },
  // ---- 画布上下文与视口 ----
  // Lite Canvas 文档：onInit/onReady 不能拿 Context。只在 onShow 获取，
  // 一个展示周期缓存一次，分页绝不重复 getContext。
  acquireContext() {
    if (!this.canvasReady) return null;
    if (this.ctx) return this.ctx;
    const ref = this.$refs && this.$refs.readerCanvas;
    if (!ref || typeof ref.getContext !== 'function') return null;
    try {
      this.ctx = ref.getContext('2d');
    } catch (e) {
      this.ctx = null;
    }
    return this.ctx;
  },
  // 真实画布尺寸优先；取不到时退回 HML 绑定的初始尺寸。
  viewport() {
    const ref = this.$refs && this.$refs.readerCanvas;
    let width = ref && typeof ref.width === 'number' && ref.width > 0 ?
      ref.width : 0;
    let height = ref && typeof ref.height === 'number' && ref.height > 0 ?
      ref.height : 0;
    if (!width || !height) {
      width = this.canvasSize;
      height = this.canvasSize;
    }
    return { width: width, height: height };
  },
  loadPage(offset, previousOffset, done, skipSave) {
    if (this.isLoading || !this.bookId) return;
    this.isLoading = true;
    this.isBusy = true;
    const readSource = this.bundled ? readBundledWindow : readBytes;
    readSource(this.bookId, offset, 2048, (data) => {
      this.isLoading = false;
      if (!data.ok) {
        this.readingError = true;
        this.pageHint = '读取失败：' + (data.reason || data.api || 'unknown') +
          (data.code !== undefined ? ' code=' + data.code : '');
        // 页面正文区足够大，显示真实失败阶段，避免只有一个“200”。
        this.body = '正文读取失败' +
          '\n阶段：' + (data.stage || data.api || 'read') +
          '\n错误码：' + (data.code === undefined ? '?' : data.code) +
          (data.cacheBufferCode === undefined ? '' :
            '\n二进制读取：' + data.cacheBufferCode) +
          (data.cacheTextCode === undefined ? '' :
            '\n文本读取：' + data.cacheTextCode) +
          (data.cacheGetCode === undefined ? '' :
            '\n文件检查：' + data.cacheGetCode) +
          (data.cacheBytes === undefined ? '' :
            '\n文件字节数：' + data.cacheBytes +
            ' / ' + data.expectedBytes) +
          (data.rawCode === undefined ? '' :
            '\n资源读取：' + data.rawCode);
        this.isBusy = false;
        if (done) done(false);
        return;
      }
      // 文件数据可能比 onShow 早到，暂存等待画布就绪。
      this.pending = {
        data: data,
        offset: offset,
        previousOffset: previousOffset,
        done: done,
        skipSave: !!skipSave
      };
      this.renderPending();
    }, this.bundled ? (stage) => {
      this.setLoadingStage('内置书：' + stage);
    } : undefined);
  },
  // 绘制失败就是失败：不启动另一套正文组件、不用像素回读或计时重试。
  failCanvas(message, pending) {
    this.readingError = true;
    this.body = '无法使用 Canvas 阅读\n' + message;
    this.pageHint = 'Canvas 绘制不可用：' + message;
    this.pending = null;
    this.isBusy = false;
    if (pending && pending.done) pending.done(false);
  },
  // 只按需绘制：载入一本、翻页、设置字号/主题后返回、恢复前台。
  renderPending() {
    const pending = this.pending;
    if (!pending || !this.canvasReady || this.settingsOpen) return;
    const ctx = this.acquireContext();
    if (!ctx) {
      this.failCanvas('getContext(2d) 不可用', pending);
      return;
    }
    const view = this.viewport();
    // 手表轻量模式：线性、确定性的中文字格计算，不对每个文字前缀测量。
    const layout = takeCanvasPage(pending.data.bytes, 0, {
      width: view.width, height: view.height,
      fontSize: this.fontSize, lineHeightRatio: this.lineHeightRatio,
      padding: EDGE_PADDING
    });
    // 有的 TXT 开头连续很多空行/空格；原实现会把整张 Canvas
    // 填成背景色、认为绘制成功，首次阅读便是一片黑色。
    // 空白页不绘制也不保存进度：按唯一分页路径继续取下一窗口。
    var hasVisibleText = false;
    for (var i = 0; i < layout.lines.length; i++) {
      var line = layout.lines[i];
      if (line && line.text && line.text.trim().length > 0) {
        hasVisibleText = true;
        break;
      }
    }
    if (!hasVisibleText) {
      this.pending = null;
      if (layout.nextOffset > 0) {
        // 消耗的仍是真实 UTF-8 字节数；保留上一页历史与回调。
        // 每次都前进才继续，避免空白输入无限循环。
        var nextStart = (pending.data.offset || 0) + layout.nextOffset;
        this.loadPage(nextStart, pending.previousOffset,
          pending.done, pending.skipSave);
        return;
      }
      // 读完文件/遇到损坏字节也不能再伪装为绘制成功。
      this.readingError = true;
      this.body = '此处没有可显示的正文\n请检查 TXT 是否为空或内容损坏';
      this.pageHint = '正文为空或无法正确解码';
      this.isBusy = false;
      if (pending.done) pending.done(false);
      return;
    }
    const result = drawPage(ctx, view, layout.lines, {
      fontSize: this.fontSize, theme: this.theme
    });
    if (!result.ok) {
      this.failCanvas(result.reason, pending);
      return;
    }
    if (typeof pending.previousOffset === 'number') {
      this.history.push(pending.previousOffset);
      this.history = this.history.slice(-60);
    }
    const base = pending.data.offset || 0;
    this.offset = base + layout.offset;
    this.nextOffset = base + layout.nextOffset;
    this.pending = null;
    this.renderedOnce = true;
    this.readingError = false;
    this.isBusy = false;
    this.pageHint = this.progressError ||
      ('字节位置 ' + this.offset);
    this.refreshChapterView();
    // 前后台重绘不是新进度：不再把同一字节位置反复写回 KV。
    if (!pending.skipSave) this.scheduleSave();
    if (!this.lastBookSaved) {
      this.lastBookSaved = true;
      saveLastBook(this.bookId, function () {});
    }
    if (pending.done) pending.done(true);
  },
  // 重绘当前页（设置返回 / 画布重建 / 主题变化后调用）。
  redraw() {
    if (!this.bookId) return;
    this.loadPage(this.offset, undefined, undefined, true);
  },
  // 后台**串行**保存进度：同一时刻只有一个写，避免多个异步写
  // 乱序覆盖更晚的进度；失败只记诊断、不回退已读位置。
  scheduleSave() {
    if (!this.bookId) return;
    this.saveWanted = true;
    if (this.saving || !this.progressReady) return;
    this.saveNext();
  },
  saveNext() {
    this.saving = true;
    this.saveWanted = false;
    saveProgress(this.bookId, this.offset, this.history,
      this.currentSettings(), (state) => {
        this.saving = false;
        if (!state.ok) {
          this.progressError = '进度保存失败：' +
            (state.code === undefined ? 'unknown' : state.code);
          this.pageHint = this.progressError;
        } else {
          this.progressError = '';
        }
        if (this.saveWanted) {
          this.saveNext();
        } else if (this.returnToShelf) {
          this.returnToShelf = false;
          router.replace({ uri: 'pages/index/index',
            params: { resume: '0' } });
        }
      });
  },
  nextPage() {
    this.userMoved = true;
    if (this.isBusy || this.nextOffset <= this.offset) return;
    this.loadPage(this.nextOffset, this.offset);
  },
  previousPage() {
    this.userMoved = true;
    if (this.isBusy || !this.history.length) return;
    const previous = this.history.pop();
    this.loadPage(previous);
  },
  // 改变字号：行高/每行字数随之变化，按当前字节
  // 位置重排，不丢字、不跳页。
  changeFont(delta) {
    this.userMoved = true;
    if (this.isBusy || !this.bookId) return;
    const next = this.fontSize + delta;
    if (next < 14 || next > 32) return;
    this.fontSize = next;
    this.settingsTouched = true;
    this.savePreferences();
    this.scheduleSave();
    // 设置页隐藏了 Canvas，不在后台白白重绘；返回阅读时统一排版。
    if (!this.settingsOpen) this.redraw();
  },
  // 切换主题：Canvas 不用 CSS，必须重绘（同一位置，不分页变化）。
  toggleTheme() {
    this.userMoved = true;
    if (!this.bookId) return;
    this.theme = this.theme === 'night' ? 'day' : 'night';
    this.settingsTouched = true;
    this.savePreferences();
    this.scheduleSave();
    if (!this.settingsOpen) this.redraw();
  },
  // 展开/收起设置行（现在是独占一屏的设置页，阅读位置不变）。
  openSettings() {
    this.settingsOpen = true;
    this.chapterOpen = false;
    this.refreshChapterView();
  },
  openChapters() {
    if (!this.hasChapters) return;
    this.settingsOpen = true;
    this.chapterOpen = true;
    this.refreshChapterView();
  },
  closeChapters() {
    this.chapterOpen = false;
    this.refreshChapterView();
  },
  // Canvas 始终挂载，返回阅读后只绘制一次当前页。
  closeSettings() {
    this.settingsOpen = false;
    this.chapterOpen = false;
    if (this.pending) this.renderPending();
    else if (!this.isLoading) this.redraw();
  },
  jumpChapter(index) {
    if (!this.hasChapters || this.isBusy) return;
    if (index < 0 || index >= this.chapters.length) return;
    const chapter = this.chapters[index];
    this.userMoved = true;
    this.settingsOpen = false;
    this.chapterOpen = false;
    this.loadPage(chapter.offset, this.offset);
  },
  previousChapter() {
    if (!this.hasChapters) return;
    const index = chapterIndexAt(this.chapters, this.offset);
    if (index <= 0) return;
    this.jumpChapter(index - 1);
  },
  nextChapter() {
    if (!this.hasChapters) return;
    const index = chapterIndexAt(this.chapters, this.offset);
    const target = index < 0 ? 0 : index + 1;
    if (target >= this.chapters.length) return;
    this.jumpChapter(target);
  },
  // 左滑进入设置；右滑保留给 GT4 系统返回手势，不在应用拦截。
  // 左滑不再翻页，翻页用点按正文两侧或表冠。
  onReadingSwipe(e) {
    if (this.settingsOpen || !e) return;
    if (e.direction === 'left') this.openSettings();
  },
  // 点击正文左半边回上一页，右半边进入下一页。
  // 坐标不可用时默认下一页，确保还能翻页。
  onReaderTap(e) {
    if (this.settingsOpen || this.isBusy) return;
    var x = e && typeof e.globalX === 'number' ?
      e.globalX : (e && typeof e.localX === 'number' ?
        e.localX + 75 : null);
    var half = (this.viewport().width || CANVAS_SIZE) / 2;
    if (x !== null && x < half) {
      this.previousPage();
    } else {
      this.nextPage();
    }
  },
  fontSmaller() {
    this.changeFont(-1);
  },
  fontLarger() {
    this.changeFont(1);
  },
  spacingTighter() {
    this.changeSpacing(-0.1);
  },
  spacingLooser() {
    this.changeSpacing(0.1);
  },
  changeSpacing(delta) {
    if (this.isBusy || !this.bookId) return;
    var next = Math.round((this.lineHeightRatio + delta) * 100) / 100;
    if (next < 1.3 || next > 2.0) return;
    this.userMoved = true;
    this.lineHeightRatio = next;
    this.settingsTouched = true;
    this.savePreferences();
    this.scheduleSave();
    if (!this.settingsOpen) this.redraw();
  },
  // Lite FA @system.storage 独立保存阅读设置，连续调整串行落盘。
  savePreferences() {
    this.prefWanted = true;
    if (this.prefSaving || !this.bookId) return;
    this.flushPreferences();
  },
  flushPreferences() {
    this.prefSaving = true;
    this.prefWanted = false;
    saveReaderPreferences(this.bookId, this.currentSettings(), (result) => {
      this.prefSaving = false;
      if (!result.ok) {
        this.pageHint = '设置保存失败：' + (result.code || 'unknown');
      }
      if (this.prefWanted) this.flushPreferences();
    });
  },
  // ---- 表冠（机制来自上游 MIT 示例，见 reader/CrownInput.js）----
  // 隐藏 slider 挂载后抢占表冠焦点；设备上若 $refs.crownProxy
  // 不存在则静默跳过，触屏「上页/下页」照常可用。
  onShow() {
    this.canvasReady = true;
    this.ctx = null;
    this.focusCrown(true);
    const ctx = this.acquireContext();
    if (!ctx) {
      this.failCanvas('onShow 无法获取 getContext(2d)', this.pending);
      return;
    }
    if (this.pending) this.renderPending();
    else if (this.bookId && this.progressReady &&
      !this.isLoading && !this.settingsOpen) this.redraw();
  },
  onHide() {
    this.canvasReady = false;
    this.ctx = null;
    this.focusCrown(false);
  },
  onDestroy() {
    this.canvasReady = false;
    this.ctx = null;
    this.pending = null;
    this.focusCrown(false);
  },
  focusCrown(focus) {
    const proxy = this.$refs && this.$refs.crownProxy;
    if (!proxy || typeof proxy.rotation !== 'function') {
      this.crownMounted = false;
      return;
    }
    this.crownMounted = true;
    proxy.rotation({ focus: focus });
  },
  // 旋转回调：是否翻页由 CrownInput 的换算器决定；
  // 每个回调最多翻一页（翻页本身是异步读+写进度）。
  // GT4 真机是否送达此回调、每页阈值多少，均待实测。
  onCrownChange(e) {
    if (!e || this.settingsOpen) return;
    const pages = this.crownTracker.push(e.value);
    if (pages > 0) this.nextPage();
    else if (pages < 0) this.previousPage();
  },
  backToLibrary() {
    // 必须在退出前等待最后一次阅读位置写入完成（有 2.5 秒上限）。
    if (!this.progressReady || !this.bookId) {
      router.replace({ uri: 'pages/index/index',
        params: { resume: '0' } });
      return;
    }
    this.returnToShelf = true;
    this.scheduleSave();
  }
};
