// Reader Kit location/settings writes must remain ordered across async flushes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enqueueBookWrite } from
  '../harmony/entry/src/main/ets/model/ProgressWriteQueue.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stateSource = readFileSync(
  'harmony/entry/src/main/ets/services/ReaderKitStateStore.ts', 'utf8');
const readerSource = readFileSync(
  'harmony/entry/src/main/ets/pages/Reader.ets', 'utf8');

assert.match(stateSource,
  /loadLocation\([\s\S]*?enqueueBookWrite\(bookId/,
  'reopening a book must read after its pending location writes');
assert.match(stateSource,
  /saveLocation\([\s\S]*?enqueueBookWrite\(bookId/,
  'location saves for the same book must share the ordered write queue');
assert.match(stateSource,
  /saveSettings\([\s\S]*?enqueueBookWrite\(SETTINGS_WRITE_KEY/,
  'rapid settings changes must persist through one ordered queue');
assert.match(readerSource,
  /private async backToShelf\(\)[\s\S]*?await this\.saveCurrentLocation\(\)/,
  'leaving the reader must wait for its final location write');
assert.match(readerSource,
  /if \(this\.status\.length > 0 \|\| this\.pageFooter\.length > 0\)/,
  'the reader must omit an empty bottom status/footer area');

const bookId = 'readerkit-write-order-test';
const persistedLocations = new Map();
let activeLocationWrites = 0;
let maxActiveLocationWrites = 0;
const saveLocation = (resourceIndex, startDomPos, delayMs) =>
  enqueueBookWrite(bookId, async () => {
    activeLocationWrites++;
    maxActiveLocationWrites = Math.max(maxActiveLocationWrites,
      activeLocationWrites);
    try {
      await delay(delayMs);
      persistedLocations.set(bookId, { resourceIndex, startDomPos });
    } finally {
      activeLocationWrites--;
    }
  });

// These two flushes would complete in reverse order if they ran concurrently.
const pageN = saveLocation(4, 'dom-position-N', 35);
const pageNPlus1 = saveLocation(4, 'dom-position-N+1', 0);
const returnedPage = enqueueBookWrite(bookId, async () =>
  persistedLocations.get(bookId));
const [_, __, resumedLocation] = await Promise.all([
  pageN, pageNPlus1, returnedPage
]);
assert.equal(maxActiveLocationWrites, 1,
  'same-book location flushes must not overlap');
assert.deepEqual(resumedLocation, {
  resourceIndex: 4,
  startDomPos: 'dom-position-N+1'
}, 'returning to a book must observe the newest completed location');

const settingsKey = 'readerkit-settings-write-order-test';
let persistedFontSize = 20;
const saveFontSize = (fontSize, delayMs) => enqueueBookWrite(settingsKey,
  async () => {
    await delay(delayMs);
    persistedFontSize = fontSize;
  });
await Promise.all([saveFontSize(21, 25), saveFontSize(24, 0)]);
assert.equal(persistedFontSize, 24,
  'a later font-size change must remain the saved setting');

console.log('PASS: Reader Kit location and setting write order');
