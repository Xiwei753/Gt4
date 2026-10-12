// SPDX-License-Identifier: GPL-3.0-only
// GT4 Lite：每本书阅读位置只存 @system.storage，一本书一个小键值。
// 文件 API 曾在 GT4 返回 200；不再将“读取文件失败”偷偷当作首页。
// 字号、行距与主题由 ReaderPreferences 独立存储，此处只写字节偏移及少量上页位置。
import storage from '@system.storage';
import { isSafeBookId, complete } from './BookStorage.js';

var PROGRESS_TIMEOUT_MS = 2500;
var PREFIX = 'suyue.pos.';
var MAX_VALUE_BYTES = 127;  // Lite storage.set 限制严格小于 128 字节。

export function setProgressTimeout(ms) {
  PROGRESS_TIMEOUT_MS = ms;
}

function settle(cb, task) {
  var finished = false;
  var timer = setTimeout(function () {
    if (finished) return;
    finished = true;
    cb({ ok: false, code: 'timeout' });
  }, PROGRESS_TIMEOUT_MS);
  function done(data) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    cb(data);
  }
  try { task(done); }
  catch (e) { done({ ok: false, code: 'exception' }); }
}

function isOffset(n) {
  return typeof n === 'number' && isFinite(n) &&
    n >= 0 && Math.floor(n) === n;
}

function parseProgress(raw) {
  if (raw === '') {
    return { ok: true, offset: 0, history: [], empty: true };
  }
  if (typeof raw !== 'string') {
    return { ok: false, code: 'invalid_type' };
  }
  try {
    var data = JSON.parse(raw);
    if (!data || !isOffset(data.o) || !Array.isArray(data.h)) {
      return { ok: false, code: 'invalid_state' };
    }
    for (var i = 0; i < data.h.length; i++) {
      if (!isOffset(data.h[i])) {
        return { ok: false, code: 'invalid_history' };
      }
    }
    return { ok: true, offset: data.o, history: data.h.slice(-8) };
  } catch (e) {
    return { ok: false, code: 'invalid_json' };
  }
}

export function loadProgress(bookId, cb) {
  if (!isSafeBookId(bookId)) {
    return complete(cb, { ok: false, code: 'unsafe_book_id' });
  }
  settle(function (res) { complete(cb, res); }, function (done) {
    storage.get({
      key: PREFIX + bookId,
      default: '',
      success: function (value) {
        done(parseProgress(value));
      },
      fail: function (data, code) {
        done({ ok: false, code: code === undefined ? 'get_failed' : code });
      }
    });
  });
}

export function saveProgress(bookId, offset, history, settings, cb) {
  if (!isSafeBookId(bookId) || !isOffset(offset)) {
    return complete(cb, { ok: false, code: 'invalid_progress' });
  }
  var recent = [];
  if (Array.isArray(history)) {
    for (var i = history.length - 1; i >= 0 &&
         recent.length < 8; i--) {
      if (isOffset(history[i])) recent.unshift(history[i]);
    }
  }
  var data = JSON.stringify({ o: offset, h: recent });
  while (data.length >= MAX_VALUE_BYTES && recent.length > 0) {
    recent.shift();
    data = JSON.stringify({ o: offset, h: recent });
  }
  if (data.length >= MAX_VALUE_BYTES) {
    return complete(cb, { ok: false, code: 'value_too_long' });
  }
  settle(function (res) { complete(cb, res); }, function (done) {
    storage.set({
      key: PREFIX + bookId,
      value: data,
      success: function () { done({ ok: true }); },
      fail: function (info, code) {
        done({ ok: false, code: code === undefined ? 'set_failed' : code });
      }
    });
  });
}
