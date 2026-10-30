// SPDX-License-Identifier: GPL-3.0-only
// Reader Kit screen integration and immersive-window static contract.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const appearance = read(
  'harmony/entry/src/main/ets/services/ReaderWindowAppearance.ts');
const reader = read('harmony/entry/src/main/ets/pages/Reader.ets');
const index = read('harmony/entry/src/main/ets/pages/Index.ets');

assert.ok(appearance.includes('window.getLastWindow') &&
  appearance.includes('setWindowLayoutFullScreen(enabled)') &&
  appearance.includes('setWindowSystemBarProperties'),
  'reader must use the real window and restore system bar styling');
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
  reader.includes('restoreShelfWindow') &&
  reader.includes('exitReaderWindow'),
  'Reader Kit page must wire the component and immersive lifecycle');
assert.ok(reader.includes('safeTop') && reader.includes('safeBottom') &&
  reader.includes('safeLeft') && reader.includes('safeRight') &&
  reader.includes('top: this.safeTop + 8') &&
  reader.includes('bottom: 8 + this.safeBottom'),
  'reader controls must avoid status bars, cutouts and the gesture area');
assert.ok(reader.includes('Stack({ alignContent: Alignment.TopStart })') &&
  reader.includes('Blank().layoutWeight(1).hitTestBehavior(HitTestMode.None)'),
  'reader controls must remain at the top and bottom of the viewport');
assert.ok(reader.includes('.hitTestBehavior(HitTestMode.Transparent)'),
  'reader control overlay must pass non-control gestures to Reader Kit');
assert.ok(reader.includes('onPageShow(): void') &&
  reader.includes('enterReaderWindow(context, this.nightMode'),
  'reader must reapply immersive appearance when resumed');
assert.ok(reader.includes("if (this.catalogVisible)") &&
  reader.includes('if (this.settingsVisible)') &&
  reader.includes('onBackPress(): boolean'),
  'system back must close the open catalog or settings before leaving');
assert.ok(reader.includes('this.getUIContext().vp2px(this.viewportWidthVp)') &&
  reader.includes('this.getUIContext().vp2px(this.viewportHeightVp)') &&
  reader.includes('applyPageConfig(true)') &&
  reader.includes('refreshReaderWindowInsets()'),
  'rotation and fold changes must update Reader Kit viewport and restore its anchor');
assert.ok(index.includes('restoreShelfWindow') &&
  index.includes('onPageShow(): void'),
  'shelf must defensively restore its own window styling');
assert.ok(!reader.includes('.expandSafeArea(') &&
  !reader.includes('.ignoreLayoutSafeArea('),
  'reader must not combine measured insets with built-in safe area expansion');

console.log('PASS: phone Reader Kit immersive contracts');
