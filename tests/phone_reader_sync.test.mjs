// SPDX-License-Identifier: GPL-3.0-only
// Reader Kit phone flow + bidirectional byte-progress sync contracts.
// Device Reader Kit behavior is verified separately on a real phone.
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
assert.ok(reader.includes("from '@kit.ReaderKit'") &&
  reader.includes('ReadPageComponent'),
  'phone reading must use the official Reader Kit component');
assert.ok(reader.includes('this.readerAvailable && this.book !== null') &&
  reader.includes('this.leaving || !this.readerAvailable'),
  'missing source files must not mount or initialize Reader Kit');
const initPosition = reader.indexOf('await this.controller.init(context)');
const parserPosition = reader.indexOf('bookParser.getDefaultHandler');
const registerPosition = reader.indexOf('registerBookParser(this.parser)');
const configPosition = reader.indexOf('setPageConfig(this.pageConfig())');
const startPosition = reader.indexOf('startPlay(this.currentResourceIndex');
assert.ok(initPosition >= 0 && parserPosition > initPosition &&
  registerPosition > parserPosition && configPosition > registerPosition &&
  startPosition > configPosition,
  'Reader Kit must init, parse, register, configure, then start playing');
assert.ok(reader.indexOf('await this.settingsLoad') >= 0 &&
  reader.indexOf('await this.settingsLoad') < configPosition,
  'saved Reader Kit settings must load before the first page configuration');
assert.ok(reader.includes('onPageShow') &&
  reader.includes('pageShowListener') &&
  reader.includes('saveCurrentLocation'),
  'Reader Kit pageShow location must be persisted on device lifecycle');
assert.ok(reader.includes('getDomPosByCatalogHref') &&
  reader.includes('catalogs'),
  'Reader Kit catalog entries must map to a spine resource and DOM position');
assert.ok(reader.includes('viewPortWidth') &&
  reader.includes('viewPortHeight') &&
  reader.includes('scaledDensity') &&
  reader.includes('onAreaChange'),
  'Reader Kit page configuration must follow live viewport and display scale');
assert.ok(!reader.includes('ReaderSegments') &&
  !reader.includes('splitWindowSegments') &&
  !reader.includes('WINDOW_BYTES') &&
  !reader.includes('继续加载'),
  'old byte-window reader and manual scrolling guards must be removed');
assert.ok(reader.includes('flipMode') &&
  reader.includes('changeFont') && reader.includes('changeLineHeight') &&
  reader.includes('toggleTheme'),
  'Reader Kit controls must expose flip mode, font, line height and theme');
assert.ok(reader.includes("this.flipMode === '1' ? '横向滑页' : '仿真翻页'"),
  'Reader Kit mode labels must match the sample API mode values');
assert.ok(reader.includes("'readerkit_unmapped'") &&
  !reader.includes('暂无法可靠换算'),
  'Reader Kit DOM position must not be treated as a protocol byte offset');

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
assert.ok(index.includes("Button('同步可映射书籍的阅读进度')") &&
  index.includes('syncReadingProgress'),
  'phone index must expose manual progress sync');
assert.ok(index.includes("Text('书架')") && index.includes("Text('传书')") &&
  index.includes('bottomTabs()'),
  'phone home must expose only compact bookshelf and transfer tabs');
assert.ok(index.includes("setShelfSortMode('manual')") &&
  index.includes('setShelfManualOrder'),
  'manual shelf ordering must persist');
assert.ok(index.includes("chooseSort('title')") &&
  index.includes("chooseSort('imported')") &&
  index.includes("chooseSort('recent')"),
  'shelf must support recent, title and import-time sorting');
assert.ok(index.includes('exportReaderDiagnostics'),
  'phone shelf must export bounded diagnostics');
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

const repository = read(
  'harmony/entry/src/main/ets/services/BookRepository.ts');
const importService = read(
  'harmony/entry/src/main/ets/services/BookImportService.ts');
assert.ok(repository.includes('markProgressMapping') &&
  repository.includes('readerFilePath'),
  'book metadata must retain Reader Kit source and mapping state');
assert.ok(importService.includes("if (ext === 'epub')") &&
  importService.includes("originalDir + '/' + bookId + '.epub'") &&
  importService.includes('readerFilePath'),
  'EPUB import must preserve original EPUB separately from transfer text');
const epubImport = read(
  'harmony/entry/src/main/ets/services/EpubImportService.ts');
assert.ok(epubImport.includes('dc:creator') &&
  epubImport.includes("'cover-image'") &&
  epubImport.includes("image/jpeg") &&
  epubImport.includes('coverBytes'),
  'EPUB import must extract optional author and original raster cover data');
assert.ok(importService.includes("booksDir + '/covers'") &&
  importService.includes('coverFilePath') &&
  repository.includes('target.coverFilePath'),
  'EPUB cover images must live in the app library and be cleaned with the book');
const readerState = read(
  'harmony/entry/src/main/ets/services/ReaderKitStateStore.ts');
assert.ok(readerState.includes('startDomPos') &&
  readerState.includes('resourceIndex') &&
  readerState.includes('PREF_NAME = \'suyue_reader_kit\''),
  'phone must persist Kit-local locations separately from UTF-8 offsets');
const diagnostics = read(
  'harmony/entry/src/main/ets/services/ReaderDiagnostics.ts');
assert.ok(diagnostics.includes('MAX_LINES') &&
  diagnostics.includes('MAX_BYTES') &&
  diagnostics.includes('fileSuffixChoices'),
  'diagnostics must be bounded and export through the document picker');
assert.ok(sync.includes('acceptApply') &&
  sync.includes('await this.progressStore.load(') &&
  sync.includes('decidePendingAction') &&
  sync.includes('conflictKeys.delete(key)'),
  'delayed APPLY must re-check local state and release conflict keys');
assert.ok((sync.match(/progressMapping/g) || []).length >= 3 &&
  sync.includes("book.progressMapping !== 'readerkit_unmapped'"),
  'unmapped Reader Kit positions must stay out of the phone-watch byte protocol');
assert.ok(store.includes('LAST_BOOK_AT_KEY') &&
  store.includes('clearProgress'),
  'watch last-read timestamp and delete cleanup must be present');
assert.ok(sync.includes('emitReadingPrepare') &&
  sync.split('emitReadingPrepare').length - 1 >= 3,
  'sync must emit prepare before every remote apply');
assert.ok(progress.includes('captureWriteGeneration') &&
  progress.includes('bumpWriteGeneration'),
  'progress store must enforce write generations');
const writeQueue = read(
  'harmony/entry/src/main/ets/model/ProgressWriteQueue.js');
assert.ok(writeQueue.includes('bumpWriteGeneration') &&
  writeQueue.includes('captureWriteGeneration'),
  'write queue must expose generation invalidation');

console.log('PASS: phone reader/sync static contracts');
