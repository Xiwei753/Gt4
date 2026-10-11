// SPDX-License-Identifier: GPL-3.0-only
// 阅读页：按路由参数 bookId 打开对应书籍；
// 每本书独立进度与设置；字号/行距/主题可调，
// 按当前字节位置重排（不丢字、不重复、不跳页）。
// 分页唯一真相：reader/PageLayout.takePage
// （字节偏移、列数、行数）；列数/行数由
// ReaderSettings 推导。
import router from '@system.router';
import { getBook } from '../../storage/LibraryIndex';
import { openBook, readBytes } from '../../storage/BookStorage';
import { isBundled, bundledEntry,
  readBundledWindow } from '../../storage/BundledBookSource';
import { loadProgress,
  saveProgress } from '../../storage/ProgressStore';
import { takePage } from '../../reader/PageLayout';
import { normalizeSettings, columnsFor,
  rowsFor } from '../../reader/ReaderSettings';
import { createCrownTracker,
  crownStatus } from '../../reader/CrownInput';
import { isLowerHex } from '../../util/Validate';

export default {
  data: {
    title: '',
    body: '正在读取本地文本……',
    pageHint: '请稍候',
    offset: 0,
    nextOffset: 0,
    fontSize: 20,
    lineHeightRatio: 1.55,
    theme: 'night',
    // 表冠：隐藏 slider 是否真的挂载（设备运行时可见），
    // 与"旋转事件是否送达"是两件事，后者待真机验证。
    crownMounted: false,
    crownStatus: 'unverified',
    isBusy: true,
    // 设置收进二级交互（P2-13）：主操作
    // 只保留上页/下页，避免控件互相挤占。
    settingsOpen: false
  },
  onInit() {
    this.history = [];
    this.bookId = '';
    this.settings = normalizeSettings(null);
    this.crownStatus = crownStatus();
    this.crownTracker = createCrownTracker(null);
    const params = router.getParams() || {};
    const bookId = params.bookId;
    if (typeof bookId !== 'string' ||
        !isLowerHex(bookId, 16)) {
      this.pageHint = '未知书籍，请返回书架选择';
      this.isBusy = false;
      return;
    }
    this.bookId = bookId;
    // 内置书（issue #10）：正文来自构建期 JS 数据块，无需文件接口；
    // 直接读进度并分页。外部书仍走原有文件通路。
    this.bundled = isBundled(bookId);
    if (this.bundled) {
      const entry = bundledEntry(bookId);
      this.title = entry ? entry.title : '内置书籍';
      loadProgress(bookId, (progress) => {
        this.history = progress.history;
        this.applySettings(progress.settings);
        this.loadPage(progress.offset);
      });
      return;
    }
    openBook(bookId, (state) => {
      if (!state.ok) {
        this.pageHint = '书籍不存在或已删除';
        this.isBusy = false;
        return;
      }
      getBook(bookId, (entry) => {
        this.title = entry ? entry.title : '未知书名';
        loadProgress(bookId, (progress) => {
          this.history = progress.history;
          this.applySettings(progress.settings);
          this.loadPage(progress.offset);
        });
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
  loadPage(offset, previousOffset) {
    if (this.isLoading || !this.bookId) return;
    this.isLoading = true;
    this.isBusy = true;
    const readSource = this.bundled ? readBundledWindow : readBytes;
    readSource(this.bookId, offset, 2048, (data) => {
      this.isLoading = false;
      if (!data.ok) {
        this.pageHint = '读取失败：' + data.reason;
        this.isBusy = false;
        return;
      }
      const page = takePage(data.bytes, data.offset,
        columnsFor(this.currentSettings()),
        rowsFor(this.currentSettings()));
      if (!page.text) {
        this.pageHint = '已经读到末尾';
        this.isBusy = false;
        return;
      }
      if (typeof previousOffset === 'number') {
        this.history.push(previousOffset);
        this.history = this.history.slice(-60);
      }
      this.body = page.text;
      this.offset = page.offset;
      this.nextOffset = page.nextOffset;
      this.pageHint = '字节位置 ' + this.offset +
        (this.crownMounted ? ' · 表冠待真机验证' : '');
      // 进度写完才允许继续翻页，避免多个异步写覆盖更晚的进度。
      saveProgress(this.bookId, this.offset, this.history,
        this.currentSettings(), (state) => {
          if (!state.ok) this.pageHint = '进度保存失败';
          this.isBusy = false;
        });
    });
  },
  nextPage() {
    if (this.isBusy || this.nextOffset <= this.offset) return;
    this.loadPage(this.nextOffset, this.offset);
  },
  previousPage() {
    if (this.isBusy || !this.history.length) return;
    const previous = this.history.pop();
    this.loadPage(previous);
  },
  // 改变字号：列数/行数随之变化，按当前字节
  // 位置重排，不丢字、不跳页。
  changeFont(delta) {
    if (this.isBusy || !this.bookId) return;
    const next = this.fontSize + delta;
    if (next < 14 || next > 32) return;
    this.fontSize = next;
    this.loadPage(this.offset);
  },
  // 切换主题不重新分页，但要立即保存：用户可能直接返回书架。
  toggleTheme() {
    if (this.isBusy || !this.bookId) return;
    const oldTheme = this.theme;
    this.theme = oldTheme === 'night' ? 'day' : 'night';
    this.isBusy = true;
    saveProgress(this.bookId, this.offset, this.history,
      this.currentSettings(), (state) => {
        if (!state.ok) {
          this.theme = oldTheme;
          this.pageHint = '主题保存失败';
        }
        this.isBusy = false;
      });
  },
  // 展开/收起设置行（字号、主题）。
  toggleSettings() {
    this.settingsOpen = !this.settingsOpen;
  },
  // ---- 表冠（机制来自上游 MIT 示例，见 reader/CrownInput.js）----
  // 隐藏 slider 挂载后抢占表冠焦点；设备上若 $refs.crownProxy
  // 不存在则静默跳过，触屏「上页/下页」照常可用。
  onShow() {
    this.focusCrown(true);
  },
  onHide() {
    this.focusCrown(false);
  },
  onDestroy() {
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
    if (!e) return;
    const pages = this.crownTracker.push(e.value);
    if (pages > 0) this.nextPage();
    else if (pages < 0) this.previousPage();
  },
  backToLibrary() {
    router.back();
  }
};
