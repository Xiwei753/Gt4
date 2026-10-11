// SPDX-License-Identifier: GPL-3.0-only
// 每本书独立的阅读进度与设置：字节偏移、
// 翻页历史、字号、行距、主题。
// 不同书互不串书；写入失败明确回报。
import file from '@system.file';
import { progressPath, isSafeBookId, complete }
  from './BookStorage.js';
import { DEFAULT_SETTINGS } from '../reader/ReaderSettings.js';

// 进度读写单次超时（issue #9 A3）：底层不回调时也必须
// 结算一次，阅读页据此解除忙态并提示，绝不无限等待。
var PROGRESS_TIMEOUT_MS = 6000;

export function setProgressTimeout(ms) {
  if (typeof ms === 'number' && ms > 0) PROGRESS_TIMEOUT_MS = ms;
}

function withTimeout(cb, start) {
  var called = false;
  var timer = null;
  var finish = function (value) {
    if (called) return;
    called = true;
    if (timer !== null && typeof clearTimeout === 'function') {
      clearTimeout(timer);
      timer = null;
    }
    cb(value);
  };
  if (typeof setTimeout === 'function') {
    timer = setTimeout(function () {
      finish({ timeout: true });
    }, PROGRESS_TIMEOUT_MS);
  }
  try {
    start(finish);
  } catch (error) {
    finish({ timeout: true, error: String(error) });
  }
}

function defaultState() {
  return { ok: true, offset: 0, history: [],
    settings: DEFAULT_SETTINGS };
}

function normalizeNumber(value, min, max, fallback) {
  const num = Number(value);
  return isFinite(num) ?
    Math.max(min, Math.min(max, Math.floor(num))) :
    fallback;
}

export function loadProgress(bookId, cb) {
  if (!isSafeBookId(bookId)) {
    return complete(cb, defaultState());
  }
  withTimeout((done) => {
    file.readText({
      uri: progressPath(bookId),
      length: 4096,
      position: 0,
      success: (data) => done({ text: data && data.text }),
      fail: () => done({ fail: true })
    });
  }, (r) => {
    if (!r || r.timeout || r.fail) {
      // 不回调/旧文件不存在都是正常首读：用默认值，
      // 但如带 error 说明抛异常，仍以默认值保证可读。
      return complete(cb, defaultState());
    }
    try {
      const state = JSON.parse(r.text || '{}');
      const offset = Number(state.offset);
      const history = Array.isArray(state.history) ?
        state.history : [];
      const rawSettings = state.settings;
      complete(cb, {
        ok: true,
        offset: isFinite(offset) && offset >= 0 ?
          Math.floor(offset) : 0,
        history: history.filter((x) => typeof x === 'number' &&
          isFinite(x) && x >= 0 && Math.floor(x) === x)
          .slice(-60),
        settings: {
          fontSize: normalizeNumber(
            rawSettings && rawSettings.fontSize,
            14, 32, DEFAULT_SETTINGS.fontSize),
          lineHeightRatio: (function () {
            const ratio = Number(rawSettings &&
              rawSettings.lineHeightRatio);
            return isFinite(ratio) ?
              Math.max(1.3, Math.min(2.0,
                Math.round(ratio * 100) / 100)) :
              DEFAULT_SETTINGS.lineHeightRatio;
          })(),
          theme: (rawSettings &&
            (rawSettings.theme === 'day' ||
              rawSettings.theme === 'night')) ?
            rawSettings.theme : DEFAULT_SETTINGS.theme
        }
      });
    } catch (e) {
      complete(cb, defaultState());
    }
  });
}

export function saveProgress(bookId, offset, history,
  settings, cb) {
  if (!isSafeBookId(bookId)) {
    return complete(cb, { ok: false, reason: 'unsafe_book_id' });
  }
  const state = JSON.stringify({
    bookId: bookId,
    offset: Math.max(0, Math.floor(offset)),
    history: history.slice(-60),
    settings: {
      fontSize: normalizeNumber(settings && settings.fontSize,
        14, 32, DEFAULT_SETTINGS.fontSize),
      lineHeightRatio: settings &&
        isFinite(Number(settings.lineHeightRatio)) ?
        Math.max(1.3, Math.min(2.0,
          Math.round(Number(settings.lineHeightRatio) * 100) /
          100)) : DEFAULT_SETTINGS.lineHeightRatio,
      theme: (settings &&
        (settings.theme === 'day' ||
          settings.theme === 'night')) ?
        settings.theme : DEFAULT_SETTINGS.theme
    }
  });
  withTimeout((done) => {
    file.writeText({
      uri: progressPath(bookId),
      text: state,
      append: false,
      success: () => done({ ok: true }),
      fail: (data, code) => done({ ok: false, code: code })
    });
  }, (r) => {
    if (r && r.ok) return complete(cb, { ok: true });
    if (r && r.code) {
      return complete(cb, { ok: false,
        reason: 'write_progress', code: r.code });
    }
    complete(cb, { ok: false, reason: 'timeout',
      code: 'timeout' });
  });
}
