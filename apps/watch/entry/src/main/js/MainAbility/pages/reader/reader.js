// SPDX-License-Identifier: GPL-3.0-only
// 阅读页：按路由参数 bookId 打开对应书籍；
// 每本书独立进度与设置；字号/行距/主题可调，
// 按当前字节位置重排（不丢字、不重复、不跳页）。
// 分页唯一真相：reader/PageLayout.takePage
// （字节偏移、列数、行数）；列数/行数由
// ReaderSettings 推导。
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
  saveProgress } from '../../storage/ProgressStore';
import { takeRoundPage } from '../../reader/PageLayout';
import { loadReaderPreferences, saveReaderPreferences }
  from '../../storage/ReaderPreferences.js';
import { normalizeSettings } from '../../reader/ReaderSettings';
import { createCrownTracker,
  crownStatus } from '../../reader/CrownInput';
import { isLowerHex } from '../../util/Validate';

export default {
  data: {
    // issue #10：Lite 通过目标页 data 的**同名字段**注入路由参数，
    // 因此这里必须声明 bookId，且 onInit 不得把它清空。
    bookId: '',
    title: '',
    body: '正在读取本地文本……',
    pageLines: [],
    linePixelHeight: 31,
    readingError: false,
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
    // 正文与设置互斥显示。默认只展示文字，右滑/长按进入设置。
    settingsOpen: false
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
    this.settingsTouched = false;
    this.prefSaving = false;
    this.prefWanted = false;
    // Lite 通过目标页 data 同名字段注入 bookId（不再用旧的取参接口）；
    // 切勿在这里重置 this.bookId，否则会把收到的参数清空。
    const bookId = this.bookId;
    if (typeof bookId !== 'string' ||
        !isLowerHex(bookId, 16)) {
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
      this.startReading();
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
        this.startReading();
      });
    });
  },
  // 首屏尽快显示，随后读回旧位置与设置。恢复前不允许写进度文件。
  startReading() {
    this.loadPage(0, undefined, () => {
      loadProgress(this.bookId, (progress) => {
        loadReaderPreferences(this.bookId, (saved) => {
          if (this.settingsTouched || this.userMoved) {
            this.progressReady = true;
            this.scheduleSave();
            return;
          }
          const oldFont = this.fontSize;
          const oldRatio = this.lineHeightRatio;
          const oldTheme = this.theme;
          this.history = progress.history;
          this.applySettings(saved || progress.settings);
          const desiredOffset = progress.offset;
          const layoutChanged = desiredOffset !== this.offset ||
            oldFont !== this.fontSize || oldRatio !== this.lineHeightRatio ||
            oldTheme !== this.theme;
          this.progressReady = true;
          if (layoutChanged) {
            this.loadPage(desiredOffset);
          } else {
            this.scheduleSave();
          }
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
  loadPage(offset, previousOffset, done) {
    if (this.isLoading || !this.bookId) return;
    this.isLoading = true;
    this.isBusy = true;
    const readSource = this.bundled ? readBundledWindow : readBytes;
    readSource(this.bookId, offset, 2048, (data) => {
      this.isLoading = false;
      if (!data.ok) {
        this.readingError = true;
        this.pageLines = [];
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
      const page = takeRoundPage(data.bytes, data.offset,
        this.fontSize, this.lineHeightRatio);
      if (!page.text) {
        this.pageHint = '已经读到末尾';
        this.isBusy = false;
        if (done) done(false);
        return;
      }
      if (typeof previousOffset === 'number') {
        this.history.push(previousOffset);
        this.history = this.history.slice(-60);
      }
      this.body = page.text;
      this.pageLines = page.lines;
      this.linePixelHeight = page.lineHeight;
      this.readingError = false;
      this.offset = page.offset;
      this.nextOffset = page.nextOffset;
      this.pageHint = '字节位置 ' + this.offset +
        (this.crownMounted ? ' · 表冠待真机验证' : '');
      // 渲染完成即解锁：不等进度写完，翻页不被进度锁死（issue #10）。
      this.isBusy = false;
      this.scheduleSave();
      if (done) done(true);
    });
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
          this.pageHint = '进度保存失败' +
            (state.code !== undefined && state.code !== 'fail' ?
              '（' + state.code + '）' : '');
        }
        if (this.saveWanted) this.saveNext();
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
  // 改变字号：列数/行数随之变化，按当前字节
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
    this.loadPage(this.offset);
  },
  // 切换主题不重新分页，后台保存（不阻塞）。
  toggleTheme() {
    this.userMoved = true;
    if (!this.bookId) return;
    this.theme = this.theme === 'night' ? 'day' : 'night';
    this.settingsTouched = true;
    this.savePreferences();
    this.scheduleSave();
  },
  // 展开/收起设置行（现在是独占一屏的设置页，阅读位置不变）。
  openSettings() {
    this.settingsOpen = true;
  },
  closeSettings() {
    this.settingsOpen = false;
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
    if (x !== null && x < 233) {
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
    this.loadPage(this.offset);
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
    if (!e || this.settingsOpen) return;
    const pages = this.crownTracker.push(e.value);
    if (pages > 0) this.nextPage();
    else if (pages < 0) this.previousPage();
  },
  backToLibrary() {
    // issue #10：Lite Wearable 用 router.replace 切页（不用 router.back）。
    router.replace({ uri: 'pages/index/index' });
  }
};
