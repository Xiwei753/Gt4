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
const builderSection = (name, nextName) => {
  const start = reader.indexOf(`@Builder\n  ${name}() {`);
  const end = reader.indexOf(`@Builder\n  ${nextName}() {`, start);
  assert.ok(start >= 0 && end > start,
    `expected ${name} builder before ${nextName}`);
  return reader.slice(start, end);
};
const infoBar = builderSection('readerInfoBar', 'readerFooter');
const footer = builderSection('readerFooter', 'topControls');
const controls = builderSection('topControls', 'catalogPanel');
const buildStart = reader.indexOf('\n  build() {');
assert.ok(buildStart >= 0);
const build = reader.slice(buildStart);

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
assert.ok(build.includes('Text(this.pageText)') &&
  build.includes('.fontSize(this.fontSize)') &&
  build.includes('.lineHeight(this.fontSize * this.lineHeight)') &&
  build.includes('.wordBreak(WordBreak.BREAK_WORD)'),
  'the displayed native Text must use the same font and wrapping settings as pagination');
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
  footer.includes('height(READER_FOOTER_HEIGHT_VP)') &&
  !footer.includes('this.safeBottom'),
  'the header and one-line chapter footer must stay inside the existing system insets');
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
  reader.includes('this.nextPage()') &&
  reader.includes('this.previousPage()') &&
  reader.includes('this.toggleReaderControls()'),
  'tap and horizontal swipe must route to page navigation without vertical-scroll behavior');
assert.ok(reader.includes('KeyCode.KEYCODE_VOLUME_UP') &&
  reader.includes('KeyCode.KEYCODE_VOLUME_DOWN') &&
  reader.includes('this.flipPageFromVolumeKey(false)') &&
  reader.includes('this.flipPageFromVolumeKey(true)') &&
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
assert.ok(reader.includes('this.readerFooter()') &&
  reader.includes('this.chapterTitle.length > 0') &&
  reader.includes('Text(this.status)') &&
  !reader.includes('this.pageFooter'),
  'only a single chapter label may occupy the bottom reading line');
assert.ok(index.includes('showShelfWindow') &&
  index.includes("@StorageLink(APP_THEME_MODE_KEY)") &&
  index.includes("chooseTheme('system')"),
  'the shelf keeps the shared persisted app theme modes');

console.log('PASS: native phone reader layout and interaction contracts');
