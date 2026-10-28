// SPDX-License-Identifier: GPL-3.0-only
// 手机阅读页 + 双向进度同步的静态契约；不调用 DevEco/SDK。
// 真正的 ArkTS 编译由 tools/build_phone_hap.sh 单独验证。
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = (p) => readFileSync(p, 'utf8');
const pages = JSON.parse(read(
  'harmony/entry/src/main/resources/base/profile/main_pages.json'));
assert.ok(pages.src.includes('pages/Reader'),
  'Reader page must be registered for router navigation');
assert.ok(pages.src.includes('pages/Index'));

const reader = read('harmony/entry/src/main/ets/pages/Reader.ets');
assert.ok(reader.includes('router.getParams()'),
  'Reader must take only bookId from route params');
assert.ok(reader.includes('BookRepository') &&
  reader.includes('.get(bookId)'),
  'Reader must resolve the real BookMeta/file via BookRepository');
assert.ok(!reader.includes('filePath:') &&
  !reader.includes('params: { filePath'),
  'Reader must not accept a raw file URI');
assert.ok(reader.includes('fileIo.readSync') &&
  reader.includes('WINDOW_BYTES') &&
  reader.includes('splitWindowChunks'),
  'Reader must use bounded byte windows, not hold the whole book');
assert.ok(reader.includes('onPageHide') &&
  reader.includes('aboutToDisappear') &&
  reader.includes('flushSave'),
  'Reader must persist on hide/disappear');
assert.ok(reader.includes('saveOffset(this.currentOffset)'),
  'Reader must save the canonical byte offset');
assert.ok(reader.includes('jumpChapter'),
  'Reader must support chapter jumps');
assert.ok(reader.includes('fontSize') &&
  reader.includes('lineSpacing') &&
  reader.includes('darkTheme'),
  'Reader must expose font/line-spacing/theme controls');
assert.ok(!reader.includes('offset = this.fontSize') &&
  !reader.includes('offset = this.lineSpacing'),
  'font/theme changes must not reset byte position');

const progress = read(
  'harmony/entry/src/main/ets/services/ReadingProgressStore.ts');
assert.ok(progress.includes('@kit.ArkData') &&
  progress.includes('preferences') &&
  !progress.toLowerCase().includes('relationalstore'),
  'phone progress must use Preferences, not SQL');
assert.ok(progress.includes("const KEY_PREFIX = 'p.'"),
  'progress must be per book');
assert.ok(progress.includes('parsed.sha256 !== sha256') ||
  progress.includes('parsed.sha256 !== book.sha256'),
  'progress must reject digest mismatch');
assert.ok(progress.includes('async remove(bookId'),
  'delete must clear per-book progress');
assert.ok(progress.includes('syncedOffset'),
  'sync baseline must be persisted for conflict detection');

const sync = read(
  'harmony/entry/src/main/ets/services/ReadingSyncService.ts');
for (const name of ['READ_PROGRESS_GET', 'READ_PROGRESS_STATE',
  'READ_PROGRESS_APPLY']) {
  assert.ok(sync.includes(name), 'phone sync must handle ' + name);
}
assert.ok(sync.includes('onMessageFromWatch') &&
  sync.includes("indexOf('READ_PROGRESS_')"),
  'phone must route only progress messages');
assert.ok(sync.includes('sendP2pMessage') &&
  !sync.includes('subscribeMsg'),
  'phone sync must reuse the existing P2P channel');
assert.ok(sync.includes('decideSyncAction') &&
  sync.includes('resolveConflict') &&
  sync.includes('showDialog'),
  'phone must prompt on real conflicts instead of max-offset overwrite');
assert.ok(!sync.includes('offset > remote.offset') &&
  !sync.includes('Math.max(local.offset'),
  'phone must not choose progress by larger offset');
assert.ok(sync.includes('buildSummaryBatches'),
  'phone must batch all local summaries under 4096 bytes');
assert.ok(sync.includes('book.sha256 !== remote.sha256') ||
  sync.includes('book.sha256 !== sha256'),
  'phone must apply only digest-matching local books');
assert.ok(sync.includes('isUtf8Boundary') &&
  sync.includes('& 0xC0') && sync.includes('0x80'),
  'phone must reject UTF-8 continuation offsets');

const device = read(
  'harmony/entry/src/main/ets/services/WearDeviceService.ts');
assert.ok(device.includes('sendP2pMessage') &&
  device.includes('ensureP2pClient()') &&
  !device.includes('wearengine.getP2pClient(this.context);\n    this.p2pClient ='),
  'sendP2pMessage must reuse the lazy single P2pClient');

const index = read('harmony/entry/src/main/ets/pages/Index.ets');
assert.ok(index.includes('ReadingSyncService') &&
  index.includes('onMessageFromWatch(message.content)'),
  'phone index must route watch messages through sync first');
const routePos = index.indexOf('syncService.onMessageFromWatch');
const transferPos = index.indexOf('transferService.onMessageFromWatch');
assert.ok(routePos >= 0 && transferPos > routePos,
  'progress messages must be offered to sync before transfer RESULT');
assert.ok(index.includes("Button('同步阅读进度')") &&
  index.includes('syncReadingProgress'),
  'phone index must expose manual progress sync');
assert.ok(index.includes('getProgressStore().remove(book.bookId)'),
  'deleting a book must clear its progress');

const watchReceiver = read(
  'watch/huawei/watch-lite/entry/src/main/js/MainAbility/wear/WearReceiver.js');
assert.ok(watchReceiver.includes('handleProgressMessage') &&
  watchReceiver.indexOf('handleProgressMessage') <
    watchReceiver.indexOf('receiver.onMessage(messageText)'),
  'watch must route progress before transfer receiver');
assert.equal((watchReceiver.match(/wearengine\.subscribeMsg\(/g) || []).length, 1,
  'watch must keep exactly one subscribeMsg');

const watchSync = read(
  'watch/huawei/watch-lite/entry/src/main/js/MainAbility/wear/ProgressSync.js');
assert.ok(watchSync.includes('READ_PROGRESS_GET') &&
  watchSync.includes('READ_PROGRESS_STATE') &&
  watchSync.includes('READ_PROGRESS_APPLY'),
  'watch progress handler must implement the protocol');
assert.ok(!watchSync.includes('subscribeMsg') &&
  !watchSync.includes('wearengine'),
  'watch progress handler must not create a second subscription');
assert.ok(watchSync.includes('isLowerHex(book.sha256, 64)') ||
  watchSync.includes('isLowerHex(remote.sha256, 64)'),
  'watch must validate sha256 before applying');
assert.ok(watchSync.includes('validateBoundary') &&
  watchSync.includes('& 0xc0') && watchSync.includes('0x80'),
  'watch must reject UTF-8 continuation offsets');
assert.ok(watchSync.includes('applyHandler') &&
  watchSync.includes('takePendingApply'),
  'watch must redraw an active reader or keep a pending apply');

const watchReader = read(
  'watch/huawei/watch-lite/entry/src/main/js/MainAbility/pages/reader/reader.js');
assert.ok(watchReader.includes('setApplyHandler') &&
  watchReader.includes('clearApplyHandler') &&
  watchReader.includes('applyRemoteProgress'),
  'watch reader must apply incoming progress and clear history');
const watchIndex = read(
  'watch/huawei/watch-lite/entry/src/main/js/MainAbility/pages/index/index.js');
assert.ok(watchIndex.includes('clearProgress'),
  'watch delete must clear progress keys');

const store = read(
  'watch/huawei/watch-lite/entry/src/main/js/MainAbility/storage/ProgressStore.js');
assert.ok(store.includes('JSON.stringify({ o: offset, h: recent })'),
  'watch must preserve legacy {o,h} progress shape');
assert.ok(store.includes("SYNC_PREFIX = 'suyue.sync.'") &&
  store.includes('clearProgress'),
  'watch must keep sync baseline in a separate tiny key');
assert.ok(store.includes('MAX_VALUE_BYTES = 127'),
  'watch single key must stay <128 bytes');

const bundled = read(
  'watch/huawei/watch-lite/entry/src/main/js/MainAbility/storage/BundledBookSource.js');
assert.ok(bundled.includes('sha256: b.sha256'),
  'bundled book entries must expose sha256 for digest matching');

const protocol = read('protocol/README.md');
for (const name of ['READ_PROGRESS_GET', 'READ_PROGRESS_STATE',
  'READ_PROGRESS_APPLY', 'syncedOffset', 'UTF-8']) {
  assert.ok(protocol.includes(name), 'protocol must document ' + name);
}
assert.ok(protocol.includes('独立于传书') &&
  protocol.includes('4096'),
  'progress sync must be separate and bounded');

console.log('PASS: phone reader/sync static contracts');
