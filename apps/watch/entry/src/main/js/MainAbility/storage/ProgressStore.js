// SPDX-License-Identifier: GPL-3.0-only
// 每本书独立的阅读进度与设置：字节偏移、
// 翻页历史、字号、行距、主题。
// 不同书互不串书；写入失败明确回报。
//
// issue #10 复核：进度**绝不允许阻塞阅读**。文件接口不回调时，
// loadProgress 必须仍然回调（返回默认从头读），saveProgress 必须
// 仍然回调（返回失败），否则阅读页会一直卡在"正在读取"或翻页被锁死。
// 因此这里给每个文件调用都加了 settle-once + 有限超时。
import file from '@system.file';
import { progressPath, isSafeBookId, complete }
  from './BookStorage.js';
import { DEFAULT_SETTINGS } from '../reader/ReaderSettings.js';

var PROGRESS_TIMEOUT_MS = 6000;
export function setProgressTimeout(ms) {
  PROGRESS_TIMEOUT_MS = ms;
}

function withTimeout(cb, startFn) {
  var done = false;
  var timer = setTimeout(function () {
    if (done) return;
    done = true;
    cb({ timeout: true });
  }, PROGRESS_TIMEOUT_MS);
  function finish(res) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cb(res);
  }
  try {
    startFn(finish);
  } catch (e) {
    finish({ error: true });
  }
}

function defaultState() {
  return { ok: true, offset: 0, history: [], settings: DEFAULT_SETTINGS };
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
  withTimeout(function (r) {
    if (!r || r.timeout || r.error || typeof r.text !== 'string') {
      // 无进度文件 / 读取失败 / 接口不回调：都从头读，不阻塞阅读。
      return complete(cb, defaultState());
    }
    try {
      const state = JSON.parse(r.text || '{}');
      const offset = Number(state.offset);
      const history = Array.isArray(state.history) ? state.history : [];
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
  }, function (finish) {
    file.readText({
      uri: progressPath(bookId),
      length: 4096,
      position: 0,
      success: (data) => finish({ text: data && data.text }),
      fail: () => finish({ text: null })
    });
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
  withTimeout(function (r) {
    if (r && r.ok === true) return complete(cb, { ok: true });
    complete(cb, {
      ok: false,
      reason: 'write_progress',
      code: (r && r.code !== undefined) ? r.code :
        (r && r.timeout ? 'timeout' : 'fail')
    });
  }, function (finish) {
    file.writeText({
      uri: progressPath(bookId),
      text: state,
      append: false,
      success: () => finish({ ok: true }),
      fail: (data, code) => finish({ ok: false, code: code })
    });
  });
}
