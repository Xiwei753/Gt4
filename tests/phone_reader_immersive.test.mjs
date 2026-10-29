// SPDX-License-Identifier: GPL-3.0-only
// issue #19 静态结构检查：沉浸式窗口、真实避让区和阅读页交互。
// 不调用 SDK，不能替代 Pocket 2 真机上的状态栏/手势条验收。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const appearancePath =
  'harmony/entry/src/main/ets/services/ReaderWindowAppearance.ts';
assert.ok(existsSync(appearancePath),
  'reader window appearance helper must exist');
const appearance = read(appearancePath);
const reader = read('harmony/entry/src/main/ets/pages/Reader.ets');
const index = read('harmony/entry/src/main/ets/pages/Index.ets');

// 主窗口必须进入全屏布局，但系统状态栏和导航条本身保持可见；
// 背景透明，由阅读页同一底色延伸到系统栏后方。
assert.ok(appearance.includes('window.getLastWindow'),
  'reader must use the real main window');
assert.ok(appearance.includes('setWindowLayoutFullScreen(enabled)') &&
  appearance.includes('this.setFullScreen(win, true)'),
  'reader must expand the page layout into the system bars');
assert.ok(appearance.includes('this.setFullScreen(win, false)'),
  'leaving reader must restore the shelf layout');
assert.ok(appearance.includes('setWindowSystemBarProperties'),
  'reader must configure system bar colors and icons');
assert.ok(appearance.includes("statusBarColor: TRANSPARENT") &&
  appearance.includes("navigationBarColor: TRANSPARENT"),
  'system bar backgrounds must be transparent');
assert.ok(appearance.includes('isStatusBarLightIcon') &&
  appearance.includes('isNavigationBarLightIcon') &&
  appearance.includes('statusBarContentColor') &&
  appearance.includes('navigationBarContentColor'),
  'light/dark system icons and content colors must follow reader theme');
assert.ok(!appearance.includes('setWindowSystemBarEnable'),
  'immersive reader must not hide the system bars/gesture');
assert.ok(!reader.includes('setWindowSystemBarProperties'),
  'bar configuration must stay in the single window helper');

// 避让区必须来自真实窗口，且同时考虑状态栏/刘海和手势指示条。
assert.ok(appearance.includes('getWindowAvoidArea'),
  'reader must measure the real avoid area');
assert.ok(appearance.includes('TYPE_SYSTEM') &&
  appearance.includes('TYPE_CUTOUT') &&
  appearance.includes('TYPE_NAVIGATION_INDICATOR'),
  'avoid area must include system bars, cutout and navigation indicator');
assert.ok(appearance.includes("on('avoidAreaChange'") &&
  appearance.includes("off('avoidAreaChange'"),
  'avoid area changes must be observed and cleaned up');
assert.ok(appearance.includes('densityPixels'),
  'avoid-area pixels must be converted to vp');
assert.ok(!appearance.includes('.expandSafeArea(') &&
  !appearance.includes('.ignoreLayoutSafeArea('),
  'manual avoid-area padding must not be combined with safe-area expansion');
assert.ok(!reader.includes('.expandSafeArea(') &&
  !reader.includes('.ignoreLayoutSafeArea('),
  'reader must use only manual safe-area padding');
assert.ok(!/\b(?:1260|2700|1220|2688)\b/.test(reader),
  'reader must not hard-code Pocket 2 pixel dimensions');

// 阅读页背景延伸到系统栏，正文和可点击控件用安全间距避让。
assert.ok(reader.includes('ReaderWindowInsets') &&
  reader.includes('enterReaderWindow') &&
  reader.includes('refreshReaderWindowInsets') &&
  reader.includes('restoreShelfWindow'),
  'reader page must wire the window appearance helper');
assert.ok(reader.includes('onPageShow') &&
  reader.includes('enterImmersiveWindow'),
  'reader must reapply immersive appearance when shown/resumed');
assert.ok(reader.includes('safeTop') && reader.includes('safeBottom') &&
  reader.includes('safeLeft') && reader.includes('safeRight'),
  'reader must expose measured safe insets');
assert.ok(reader.includes('top: this.safeTop') &&
  reader.includes('bottom: this.safeBottom'),
  'reader body must be padded by the measured avoid area');
assert.ok(reader.includes('setReaderWindowTheme(this.darkTheme)'),
  'theme switch must update system bar icon contrast');

// 正文优先：操作层默认收起，点击正文切换；返回键先关目录/设置/操作层。
assert.ok(/@State private showControls: boolean = false/.test(reader),
  'reader controls must default to hidden');
assert.ok(reader.includes('toggleControls()') &&
  reader.includes('.onClick(() => { this.toggleControls(); })'),
  'tapping the reading body must toggle controls');
assert.ok(reader.includes('progressHint()') &&
  reader.includes('HitTestMode.None'),
  'collapsed controls must leave a lightweight pass-through progress hint');
assert.ok(reader.includes('onBackPress(): boolean') &&
  reader.includes('if (this.showChapters)') &&
  reader.includes('if (this.showSettings)') &&
  reader.includes('if (this.showControls)'),
  'system back must close open layers before leaving the reader');
assert.ok(reader.includes('if (this.showControls)') &&
  reader.includes('this.bottomBar()'),
  'top/bottom operation layers must be conditional overlays');
assert.ok(!/\.layoutWeight\(1\)\s*\n\s*\.width\('100%'\)\s*\n\s*\.scrollBar/.test(reader),
  'reading list must fill the body without changing height when bars toggle');

// 退出阅读页必须恢复书架窗口，避免全屏布局和浅色系统图标泄漏。
assert.ok(reader.includes('await restoreShelfWindow(context)') &&
  reader.includes('router.back()'),
  'reader must restore shelf appearance before navigating back');
assert.ok(reader.includes('exitReaderWindow()'),
  'reader teardown must also restore the main window');
assert.ok(index.includes('restoreShelfWindow') &&
  index.includes('onPageShow'),
  'shelf must defensively restore its own system bar appearance');
const shelfShow = index.indexOf('onPageShow(): void');
const shelfRestore = index.indexOf('restoreShelfWindow(', shelfShow);
assert.ok(shelfShow >= 0 && shelfRestore > shelfShow &&
  shelfRestore < shelfShow + 800,
  'shelf restore must run from its show lifecycle');

// 窗口外观服务必须串行化异步调用，并跳过已经过期的恢复操作。
assert.ok(appearance.includes('operations: Promise<void> = Promise.resolve()') &&
  appearance.includes('this.operations.then(action)'),
  'window operations must be serialized');
assert.ok(appearance.includes('if (this.readerActive) return;'),
  'stale restore operations must be skipped after re-entering reader');
