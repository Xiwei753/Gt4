// SPDX-License-Identifier: GPL-3.0-only
// Native reader source contracts. These do not replace phone screenshots.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const appearance = read(
  'harmony/entry/src/main/ets/services/ReaderWindowAppearance.ts');
const reader = read('harmony/entry/src/main/ets/pages/Reader.ets');
const index = read('harmony/entry/src/main/ets/pages/Index.ets');
const settings = read(
  'harmony/entry/src/main/ets/services/ReaderSettingsStore.ts');
const bookRepository = read(
  'harmony/entry/src/main/ets/services/BookRepository.ts');
const importService = read(
  'harmony/entry/src/main/ets/services/BookImportService.ts');
const builderSection = (name, nextName) => {
  const start = reader.indexOf(`@Builder\n  ${name}() {`);
  const end = reader.indexOf(`@Builder\n  ${nextName}() {`, start);
  assert.ok(start >= 0 && end > start,
    `expected ${name} builder before ${nextName}`);
  return reader.slice(start, end);
};
const infoBar = builderSection('readerInfoBar', 'readerChapterLabel');
const chapterLabel = builderSection('readerChapterLabel', 'topControls');
const controls = builderSection('topControls', 'catalogPanel');
const buildStart = reader.indexOf('\n  build() {');
assert.ok(buildStart >= 0);
const build = reader.slice(buildStart);
const bodyTextStart = build.indexOf('Text(this.readerDisplayText(this.pageText))');
const bodyTextEnd = build.indexOf('.onAreaChange', bodyTextStart);
assert.ok(bodyTextStart >= 0 && bodyTextEnd > bodyTextStart);
const bodyText = build.slice(bodyTextStart, bodyTextEnd);
const createPageStart = reader.indexOf('private async createPageAt(');
const previousPageStart = reader.indexOf(
  'private async createPreviousPageEndingAt(', createPageStart);
assert.ok(createPageStart >= 0 && previousPageStart > createPageStart);
const createPageAt = reader.slice(createPageStart, previousPageStart);
const exitReaderStart = appearance.indexOf('  exitReader(pageToken: number): void {');
const exitReaderEnd = appearance.indexOf('\n  private enqueue(', exitReaderStart);
assert.ok(exitReaderStart >= 0 && exitReaderEnd > exitReaderStart);
const exitReader = appearance.slice(exitReaderStart, exitReaderEnd);

assert.ok(appearance.includes('window.getLastWindow') &&
  appearance.includes('setWindowLayoutFullScreen(true)') &&
  appearance.includes('getWindowAvoidAreaIgnoringVisibility') &&
  appearance.includes('TYPE_NAVIGATION_INDICATOR') &&
  appearance.includes("on('avoidAreaChange'") &&
  appearance.includes("off('avoidAreaChange'"),
  'the page must retain fullscreen geometry and live system insets');
assert.ok(!reader.includes('@kit.ReaderKit') &&
  !reader.includes('ReadPageComponent') &&
  !reader.includes('readerCore') && !reader.includes('bookParser'),
  'only the native Text pager may be mounted');
assert.ok(build.includes('Text(this.readerDisplayText(this.pageText))') &&
  build.includes('.fontSize(this.fontSize)') &&
  build.includes('.lineHeight(this.fontSize * this.lineHeight)') &&
  build.includes('.wordBreak(WordBreak.BREAK_WORD)'),
  'the displayed native Text must use the same font and wrapping settings as pagination');
assert.ok(!reader.includes('debug_next') && !reader.includes('分页调试') &&
  !reader.includes('调试下一页'),
  'temporary debug paging controls and special-case logic must be removed');
const fontService = read(
  'harmony/entry/src/main/ets/services/ReaderFontService.ts');
assert.ok(reader.includes('new picker.DocumentViewPicker(context)') &&
  reader.includes("fileSuffixFilters = ['Fonts (.ttf, .otf)|.ttf,.otf']") &&
  reader.includes('registerFont({') &&
  reader.includes("familySrc: 'file://' + service.pathFor(font)") &&
  fontService.includes("this.context.filesDir + '/reader-fonts'") &&
  fontService.includes('fileIo.renameSync(tempPath, finalPath)'),
  'Aa settings must import local TTF/OTF files into private storage');
assert.ok(settings.includes('readerFontId') && settings.includes('readerFonts') &&
  reader.includes('this.readerFontFamily') &&
  reader.includes('this.resetPaginationHistory(targetByte)'),
  'font choice must persist, share one measurement/render family and reflow at the current byte offset');
assert.ok(bodyText.includes('.align(Alignment.TopStart)'),
  'short reader pages must align their body text to the top');
assert.ok(appearance.includes('this.activePageToken = generation;') &&
  exitReader.includes("this.activePage !== 'reader'") &&
  exitReader.includes('pageToken !== this.activePageToken') &&
  reader.includes('this.windowPageToken = enterReaderWindow(') &&
  reader.includes('const pageToken = this.windowPageToken;') &&
  reader.includes('exitReaderWindow(pageToken);'),
  'a stale reader page token must not exit the currently active reader');
assert.ok(reader.includes('textContent: this.readerDisplayText(text)') &&
  reader.includes('formatReaderParagraphs(sourceText)'),
  'rendering and measured pagination must use the same display-only paragraph spacing');
assert.ok(reader.includes('getMeasureUtils().measureTextSize') &&
  reader.includes('constraintWidth: this.viewportWidthVp') &&
  reader.includes('Math.max(1, heightPx - 1)'),
  'pagination must use measured width and the actual available text height');
assert.ok(build.includes('readerContentTopInsetVp()') &&
  build.includes('readerContentBottomInsetVp()') &&
  build.includes('.expandSafeArea([SafeAreaType.SYSTEM]') &&
  reader.includes('readerAreaChanged(newArea)'),
  'the body must fill the measured safe area and reflow after geometry changes');
assert.ok(infoBar.includes('.height(this.statusBarHeight)') &&
  infoBar.includes('this.headerTitleMaxWidthVp') &&
  chapterLabel.includes('this.chapterLabelWidthVp()') &&
  chapterLabel.includes('this.chapterLabelTopVp()') &&
  chapterLabel.includes('.hitTestBehavior(HitTestMode.None)') &&
  reader.includes('READER_GESTURE_SAFE_REGION_RATIO') &&
  reader.includes('const screenWidth = this.viewportWidthVp + this.safeLeft + this.safeRight;') &&
  !reader.includes('this.navigationIndicatorLeftVp -') &&
  reader.includes('this.navigationIndicatorTopVp +'),
  'the chapter label must reserve a centered gesture area without treating the avoidance rect as the visible indicator');
assert.ok(reader.includes('private readerContentBottomInsetVp(): number {\n    return this.safeBottom;') &&
  !reader.includes('READER_FOOTER_HEIGHT_VP') &&
  appearance.includes('navigationIndicatorRectVp: insets?.navigationIndicator'),
  'the text area must reserve only the measured system bottom inset and no separate footer row');
assert.ok(reader.includes('calculateHeaderLayout') &&
  reader.includes('ReaderWindowCutout') &&
  reader.includes('this.headerInfoX'),
  'the drawn header must continue to avoid the actual cutout rectangle');
assert.ok(reader.includes('this.scheduleReflow()') &&
  reader.includes('refreshReaderWindowInsets()') &&
  reader.includes('this.currentPage.startByte'),
  'rotation, fold and inset changes must reflow at the current byte anchor');

assert.ok(reader.includes('event.type === TouchType.Down') &&
  reader.includes('Math.abs(deltaX) >= 48') &&
  reader.includes("this.requestPageFlip('tap_right', true)") &&
  reader.includes("this.requestPageFlip('tap_left', false)") &&
  reader.includes("this.requestPageFlip('swipe_left', true)") &&
  reader.includes("this.requestPageFlip('swipe_right', false)") &&
  reader.includes('this.toggleReaderControls()'),
  'tap and horizontal swipe must route to page navigation without vertical-scroll behavior');
assert.ok(reader.includes('KeyCode.KEYCODE_VOLUME_UP') &&
  reader.includes('KeyCode.KEYCODE_VOLUME_DOWN') &&
  reader.includes("this.flipPageFromVolumeKey(false, 'volume_up')") &&
  reader.includes("this.flipPageFromVolumeKey(true, 'volume_down')") &&
  reader.includes("inputConsumer.off('keyPressed'"),
  'volume up remains previous, volume down remains next, with lifecycle cleanup');
assert.ok(reader.includes('!this.catalogVisible && !this.settingsVisible') &&
  reader.includes('this.pageInForeground && this.readerReady') &&
  reader.includes('private setVolumeKeyPaging(enabled: boolean)'),
  'volume paging must only run for an active reader outside overlays');
assert.ok(controls.includes('this.changeFont(-2)') &&
  controls.includes('this.changeFont(2)') &&
  controls.includes('this.changeLineHeight(-0.1)') &&
  controls.includes('this.toggleTheme()') &&
  controls.includes('this.setVolumeKeyPaging(enabled)'),
  'font, spacing, theme and volume-key preferences remain available');
assert.ok(settings.includes("PREF_NAME = 'suyue_reader_kit'") &&
  settings.includes("SETTINGS_KEY = 'settings'") &&
  settings.includes('volumeKeyPaging'),
  'existing reader settings retain their Preferences storage identity');
assert.ok(reader.includes('this.readerChapterLabel()') &&
  reader.includes('page_load_superseded') &&
  reader.includes('page_load_ok') &&
  reader.includes('const pageTextChanged = oldText !== page.text') &&
  reader.includes('pageTextChanged: pageTextChanged') &&
  reader.includes('touch_up_without_down') &&
  reader.includes("'readerFlip', 'blocked'") &&
  !reader.includes("'readerFlip', 'attempt'") &&
  reader.includes('reason: blockedReason.length > 0 ? blockedReason') &&
  reader.includes('this.showInputFeedback(') &&
  reader.includes('.position({ x: 0, y: this.readerContentTopInsetVp() })') &&
  !reader.includes('Blank().layoutWeight(1).hitTestBehavior(HitTestMode.None)') &&
  reader.includes('Text(this.status)') &&
  !reader.includes('this.pageFooter'),
  'input and page-load diagnostics must identify each attempt without logging book text');
assert.ok(createPageAt.includes('chapterStart > startByte') &&
  createPageAt.includes('windowBytes = chapterStart - startByte'),
  'a page read window must stop before the next detected chapter boundary');
assert.ok(index.includes('documentPicker.select(options)') &&
  index.includes('importBook(context, uri)') &&
  bookRepository.includes('books[idx].chapters = meta.chapters.slice()') &&
  !bookRepository.includes('ReadingProgressStore'),
  're-importing the same normalized book refreshes chapter metadata without touching reading progress');
assert.ok(importService.includes('chapters = detectTxtChapters(decoded.text, normalized)'),
  'TXT re-import must refresh chapter metadata from the normalized source text');
assert.ok(index.includes('showShelfWindow') &&
  index.includes("@StorageLink(APP_THEME_MODE_KEY)") &&
  index.includes("chooseTheme('system')"),
  'the shelf keeps the shared persisted app theme modes');

console.log('PASS: native phone reader layout and interaction contracts');
