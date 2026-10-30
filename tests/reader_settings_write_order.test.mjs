// SPDX-License-Identifier: GPL-3.0-only
// Preference writes remain ordered after the native pager upgrade.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enqueueBookWrite } from
  '../harmony/entry/src/main/ets/model/ProgressWriteQueue.js';

const source = readFileSync(
  'harmony/entry/src/main/ets/services/ReaderSettingsStore.ts', 'utf8');
const reader = readFileSync(
  'harmony/entry/src/main/ets/pages/Reader.ets', 'utf8');
assert.match(source, /load\(\)[\s\S]*?enqueueBookWrite\(SETTINGS_WRITE_KEY/,
  'settings reads must wait for pending settings writes');
assert.match(source, /save\(settings:[\s\S]*?enqueueBookWrite\(SETTINGS_WRITE_KEY/,
  'rapid font and spacing updates must serialize through the same queue');
assert.match(source, /PREF_NAME = 'suyue_reader_kit'/);
assert.match(source, /SETTINGS_KEY = 'settings'/);
assert.match(reader,
  /private async backToShelf\(\)[\s\S]*?await this\.saveCurrentOffset\(\)/,
  'leaving the reader must wait for the final byte-offset write');
assert.doesNotMatch(reader, /startDomPos|resourceIndex|spine/,
  'legacy document positions must not remain in the runtime page state');

const settingsKey = 'native-reader-settings-write-order-test';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let persistedFontSize = 20;
let activeWrites = 0;
let maximumActiveWrites = 0;
const saveFontSize = (fontSize, wait) => enqueueBookWrite(settingsKey,
  async () => {
    activeWrites++;
    maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
    try {
      await delay(wait);
      persistedFontSize = fontSize;
    } finally {
      activeWrites--;
    }
  });

await Promise.all([saveFontSize(21, 25), saveFontSize(24, 0)]);
assert.equal(persistedFontSize, 24,
  'the latest font-size change must remain saved');
assert.equal(maximumActiveWrites, 1,
  'settings writes for this reader must never overlap');

console.log('PASS: native reader settings write order');
