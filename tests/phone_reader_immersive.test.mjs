// SPDX-License-Identifier: GPL-3.0-only
// Reader Kit screen integration and immersive-window static contract.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const appearance = read(
  'harmony/entry/src/main/ets/services/ReaderWindowAppearance.ts');
const reader = read('harmony/entry/src/main/ets/pages/Reader.ets');
const index = read('harmony/entry/src/main/ets/pages/Index.ets');
const readerState = read(
  'harmony/entry/src/main/ets/services/ReaderKitStateStore.ts');

assert.ok(appearance.includes('window.getLastWindow') &&
  appearance.includes('setWindowLayoutFullScreen(true)') &&
  appearance.includes('getWindowProperties().isLayoutFullScreen') &&
  appearance.includes('getWindowSystemBarProperties()') &&
  appearance.includes('sameSystemBarState') &&
  appearance.includes('setWindowSystemBarProperties'),
  'window must stay immersive and reconcile only observed system-bar changes');
assert.ok(appearance.includes('getWindowAvoidArea') &&
  appearance.includes('TYPE_SYSTEM') &&
  appearance.includes('TYPE_CUTOUT') &&
  appearance.includes('TYPE_NAVIGATION_INDICATOR'),
  'reader insets must come from current system avoid areas');
assert.ok(appearance.includes('densityPixels') &&
  appearance.includes("on('avoidAreaChange'") &&
  appearance.includes("off('avoidAreaChange'"),
  'insets must react to display density and window changes');
assert.ok(reader.includes('ReadPageComponent({') &&
  reader.includes('enterReaderWindow') &&
  reader.includes('refreshReaderWindowInsets') &&
  reader.includes('exitReaderWindow'),
  'Reader Kit page must wire the component and immersive lifecycle');
assert.ok(reader.includes('safeTop') && reader.includes('safeBottom') &&
  reader.includes('safeLeft') && reader.includes('safeRight') &&
  reader.includes('top: this.safeTop + 8') &&
  reader.includes('bottom: 8 + this.safeBottom'),
  'reader controls must avoid status bars, cutouts and the gesture area');
assert.ok(reader.includes('this.readerInfoBar()') &&
  reader.includes('this.readerFooter()') &&
  reader.includes('top: this.safeTop + 5') &&
  reader.includes('bottom: 8 + this.safeBottom') &&
  reader.includes('this.getUIContext().vp2px(this.viewportHeightVp)'),
  'the reader must reserve live safe-area space for its fixed header and footer');
assert.ok(reader.includes('new Date()') && reader.includes('now.getHours()') &&
  reader.includes('now.getMinutes()') && reader.includes('batteryInfo.batterySOC') &&
  reader.includes('60000 - (now % 60000)') &&
  reader.includes('clearInfoRefreshTimer()'),
  'the header must read local time and battery and refresh only while visible');
assert.ok(reader.includes("inputConsumer.on('keyPressed'") &&
  reader.includes('KeyCode.KEYCODE_VOLUME_UP') &&
  reader.includes('KeyCode.KEYCODE_VOLUME_DOWN') &&
  reader.includes('action: 1') && reader.includes('isRepeat: false') &&
  reader.includes("inputConsumer.off('keyPressed'") &&
  reader.includes('this.controller.flipPage(isNext)'),
  'volume keys must consume one press and call Reader Kit, with unsubscribe support');
assert.ok(reader.includes('!this.catalogVisible && !this.settingsVisible') &&
  reader.includes('this.pageInForeground && this.readerReady') &&
  reader.includes('private setVolumeKeyPaging(enabled: boolean)'),
  'volume paging must be limited to a ready foreground reader outside overlays');
assert.ok(appearance.includes("setSpecificSystemBarEnabled('status', visible, false)") &&
  appearance.includes("page === 'shelf'") &&
  appearance.includes('this.setStatusBarVisible(win, true)') &&
  !appearance.includes("setSpecificSystemBarEnabled('navigationIndicator', false"),
  'the reader may hide only status and must restore it on the shelf');
assert.ok(readerState.includes('volumeKeyPaging: true') &&
  readerState.includes('typeof value.volumeKeyPaging === \'boolean\'') &&
  readerState.includes('volumeKeyPaging: settings.volumeKeyPaging'),
  'volume paging must default on and persist compatibly with saved settings');
const readerBuildPosition = reader.indexOf('build() {');
const infoBarPosition = reader.indexOf('this.readerInfoBar()', readerBuildPosition);
const readPagePosition = reader.indexOf('ReadPageComponent({', infoBarPosition);
const footerPosition = reader.indexOf('this.readerFooter()', readPagePosition);
assert.ok(infoBarPosition > readerBuildPosition &&
  readPagePosition > infoBarPosition && footerPosition > readPagePosition,
  'Reader Kit content must sit between the fixed info bar and footer');
assert.ok(reader.includes('Stack({ alignContent: Alignment.TopStart })') &&
  reader.includes('Blank().layoutWeight(1).hitTestBehavior(HitTestMode.None)'),
  'reader controls must remain at the top and bottom of the viewport');
assert.ok(reader.includes('.hitTestBehavior(HitTestMode.Transparent)'),
  'reader control overlay must pass non-control gestures to Reader Kit');
assert.ok(reader.includes('onPageShow(): void') &&
  reader.includes('enterReaderWindow(context, this.themeMode'),
  'reader must apply the shared theme and immersive appearance when resumed');
assert.ok(reader.includes("if (this.catalogVisible)") &&
  reader.includes('if (this.settingsVisible)') &&
  reader.includes('onBackPress(): boolean'),
  'system back must close the open catalog or settings before leaving');
assert.ok(reader.includes('this.getUIContext().vp2px(this.viewportWidthVp)') &&
  reader.includes('this.getUIContext().vp2px(this.viewportHeightVp)') &&
  reader.includes('applyPageConfig(true)') &&
  reader.includes('refreshReaderWindowInsets()'),
  'rotation and fold changes must update Reader Kit viewport and restore its anchor');
assert.ok(index.includes('showShelfWindow') &&
  index.includes('onPageShow(): void') &&
  index.includes("@StorageLink(APP_THEME_MODE_KEY)") &&
  index.includes("chooseTheme('system')") &&
  index.includes("chooseTheme('light')") &&
  index.includes("chooseTheme('dark')"),
  'shelf must expose the persisted app-wide theme modes');
assert.ok(reader.includes('.expandSafeArea([SafeAreaType.SYSTEM]') &&
  index.includes('.expandSafeArea([SafeAreaType.SYSTEM]') &&
  !appearance.includes('setWindowLayoutFullScreen(false)'),
  'shelf and reader must share fullscreen content with measured safe insets');
assert.ok(reader.includes('.onClick(() => { this.toggleReaderControls(); })') &&
  reader.includes('private toggleReaderControls()'),
  'a body tap must toggle controls while leaving Reader Kit swipe gestures intact');
assert.ok(reader.includes('this.loading = false;\n      this.status = \'\';') &&
  !reader.includes('本机续读已启用'),
  'successful initialization must clear status and keep sync guidance out of reading text');
assert.ok(index.includes("List({ space: 8 })") &&
  index.includes('Image(\'file://\' + book.coverFilePath)') &&
  index.includes('导出诊断日志') &&
  index.includes("Button(this.manageBooks ? '完成整理' : '整理书架')") &&
  index.includes("Text(this.busy ? '…' : '+')") &&
  index.includes("Text('▤')") && index.includes("Text('↗')"),
  'shelf must use a compact lazy book list, cover images, tucked actions and low-profile tabs');
assert.ok(index.includes('this.palette().text') &&
  index.includes('themePalette(this.themeMode, this.systemDark)') &&
  index.includes('this.palette().warningText'),
  'shelf and transfer UI must use shared light/dark theme tokens');

console.log('PASS: phone Reader Kit immersive contracts');
