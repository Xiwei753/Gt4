// SPDX-License-Identifier: GPL-3.0-only
// Issue #10：Lite KV 独立保存字号；首屏不能覆盖文件中旧进度/设置。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync,
  rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSystemFileStub } from './helpers/system_file_stub.mjs';
import { createWatchLoader, writeRouterStub,
  writeStorageStub } from './helpers/watch_module_loader.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'suyue-prefs-'));
const sandbox = mkdtempSync(join(tmpdir(), 'suyue-prefs-fs-'));
const bookId = 'aaaaaaaaaaaaaaaa';
try {
  const storageFile = writeStorageStub(tmp);
  const load = createWatchLoader({
    tmpDir: tmp,
    stubPath: writeSystemFileStub(tmp, sandbox),
    routerStubPath: writeRouterStub(tmp),
    storageStubPath: storageFile
  });
  const prefs = await load('storage/ReaderPreferences.js');
  const reader = await load('pages/reader/reader.js');
  const storage = (await import(storageFile)).default;
  const savePref = (settings) => new Promise((resolve) =>
    prefs.saveReaderPreferences(bookId, settings, resolve));
  const getPref = (id) => new Promise((resolve) =>
    prefs.loadReaderPreferences(id, resolve));
  assert.equal((await savePref({
    fontSize: 29, lineHeightRatio: 1.7, theme: 'day'
  })).ok, true);
  assert.equal((await getPref(bookId)).fontSize, 29);
  assert.equal((await getPref('bbbbbbbbbbbbbbbb')).fontSize, 29,
    'new book inherits latest font from default key');
  assert.ok(JSON.stringify(storage.__values).length > 0);

  const folder = join(sandbox, 'gt4reader', 'progress');
  mkdirSync(folder, { recursive: true });
  const savedPath = join(folder, bookId + '.json');
  writeFileSync(savedPath, JSON.stringify({
    bookId, offset: 123, history: [0],
    settings: { fontSize: 16, lineHeightRatio: 1.4, theme: 'night' }
  }));

  const p = Object.create(reader.default);
  Object.assign(p, reader.default.data);
  p.bookId = bookId;
  p.offset = 0;
  p.history = [];
  p.isBusy = false;
  p.userMoved = false;
  p.settingsTouched = false;
  p.progressReady = false;
  p.saving = false;
  p.saveWanted = false;
  p.prefSaving = false;
  p.prefWanted = false;
  p.loadPage = (offset, previous, done) => {
    p.offset = offset;
    p.scheduleSave();   // 模拟首屏 render 尝试保存；必须被 guard 挡住。
    if (done) done(true);
  };
  p.startReading();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(p.progressReady, true);
  assert.equal(p.offset, 123, 'must restore real old page, not zero');
  assert.equal(p.fontSize, 29, 'KV font overrides older file-settings font');
  assert.equal(p.theme, 'day');
  const saved = JSON.parse(readFileSync(savedPath, 'utf8'));
  assert.equal(saved.offset, 123, 'initial render must not overwrite stored page');
  assert.equal(saved.settings.fontSize, 29,
    'restored preferences must be persisted without default overwrite');

  p.isBusy = false;
  p.changeFont(1);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await getPref(bookId)).fontSize, 30);
  p.toggleTheme();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await getPref(bookId)).theme, 'night');
  console.info('PASS: GT4 persistent font/spacing/theme and startup save race');
} finally {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(sandbox, { recursive: true, force: true });
}
