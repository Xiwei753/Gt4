// SPDX-License-Identifier: GPL-3.0-only
// GT4 Lite：每本书阅读位置只存 @system.storage，一本书一个小键值。
// 文件 API 曾在 GT4 返回 200；不再将“读取文件失败”偷偷当作首页。
// 字号、行距与主题由 ReaderPreferences 独立存储，此处只写字节偏移及少量上页位置。
import storage from '@system.storage';
import { isSafeBookId, complete } from './BookStorage.js';

var PROGRESS_TIMEOUT_MS = 2500;
var PREFIX = 'suyue.pos.';
var SYNC_PREFIX = 'suyue.sync.';
var LAST_BOOK_KEY = 'suyue.last';
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

// 上次成功打开的书籍：只存 16 字节 bookId，不复制整份进度。
export function loadLastBook(cb) {
  settle(function (res) { complete(cb, res); }, function (done) {
    storage.get({
      key: LAST_BOOK_KEY,
      default: '',
      success: function (value) {
        if (value === '') {
          done({ ok: true, bookId: '', empty: true });
        } else if (isSafeBookId(value)) {
          done({ ok: true, bookId: value });
        } else {
          done({ ok: false, code: 'invalid_book_id' });
        }
      },
      fail: function (data, code) {
        done({ ok: false, code: code === undefined ? 'get_failed' : code });
      }
    });
  });
}

export function saveLastBook(bookId, cb) {
  if (!isSafeBookId(bookId)) {
    return complete(cb, { ok: false, code: 'unsafe_book_id' });
  }
  settle(function (res) { complete(cb, res); }, function (done) {
    storage.set({
      key: LAST_BOOK_KEY,
      value: bookId,
      success: function () { done({ ok: true }); },
      fail: function (info, code) {
        done({ ok: false, code: code === undefined ? 'set_failed' : code });
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

// 同步基线：独立小键，绝不改变旧 {o,h} 的形状。
// 只记录“上次双方确认的 offset”和 advisory 时间戳。
export function loadSyncBase(bookId, cb) {
  if (!isSafeBookId(bookId)) {
    return complete(cb, { ok: false, code: 'unsafe_book_id' });
  }
  settle(function (res) { complete(cb, res); }, function (done) {
    storage.get({
      key: SYNC_PREFIX + bookId,
      default: '',
      success: function (raw) {
        if (raw === '') {
          return done({ ok: true, empty: true, offset: -1,
            updatedAt: 0 });
        }
        try {
          var data = JSON.parse(raw);
          if (!data || !isOffset(data.o)) {
            return done({ ok: false, code: 'invalid_sync_state' });
          }
          done({ ok: true, offset: data.o,
            updatedAt: isOffset(data.t) ? data.t : 0 });
        } catch (e) {
          done({ ok: false, code: 'invalid_sync_json' });
        }
      },
      fail: function (data, code) {
        done({ ok: false, code: code === undefined ? 'get_failed' : code });
      }
    });
  });
}

export function saveSyncBase(bookId, offset, updatedAt, cb) {
  if (!isSafeBookId(bookId) || !isOffset(offset)) {
    return complete(cb, { ok: false, code: 'invalid_sync_base' });
  }
  var data = JSON.stringify({ o: offset,
    t: isOffset(updatedAt) ? updatedAt : 0 });
  if (data.length >= MAX_VALUE_BYTES) {
    return complete(cb, { ok: false, code: 'value_too_long' });
  }
  settle(function (res) { complete(cb, res); }, function (done) {
    storage.set({
      key: SYNC_PREFIX + bookId,
      value: data,
      success: function () { done({ ok: true }); },
      fail: function (info, code) {
        done({ ok: false, code: code === undefined ? 'set_failed' : code });
      }
    });
  });
}

function deleteKey(key, cb) {
  settle(function (res) { complete(cb, res); }, function (done) {
    if (typeof storage.delete !== 'function') {
      return done({ ok: false, code: 'delete_unsupported' });
    }
    storage.delete({
      key: key,
      success: function () { done({ ok: true }); },
      fail: function (data, code) {
        // 删除不存在的键在部分 Lite 固件上返回失败；视为已清理。
        done({ ok: true, code: code === undefined ? 'missing' : code });
      }
    });
  });
}

// 删除书籍时清理：进度键、同步基线，以及指向该书的 last 键。
// 任何一步失败都不阻止其余清理；调用方不应因此回滚书籍删除。
export function clearProgress(bookId, cb) {
  if (!isSafeBookId(bookId)) {
    return complete(cb, { ok: false, code: 'unsafe_book_id' });
  }
  var firstError = '';
  deleteKey(PREFIX + bookId, function (a) {
    if (!a.ok) firstError = a.code || 'delete_failed';
    deleteKey(SYNC_PREFIX + bookId, function (b) {
      if (!b.ok && !firstError) firstError = b.code || 'delete_failed';
      storage.get({
        key: LAST_BOOK_KEY,
        default: '',
        success: function (value) {
          if (value !== bookId) {
            return complete(cb, firstError ?
              { ok: false, code: firstError } : { ok: true });
          }
          deleteKey(LAST_BOOK_KEY, function (c) {
            if (!c.ok && !firstError) firstError = c.code || 'delete_failed';
            complete(cb, firstError ?
              { ok: false, code: firstError } : { ok: true });
          });
        },
        fail: function (data, code) {
          complete(cb, firstError ? { ok: false, code: firstError } :
            { ok: true, lastCode: code });
        }
      });
    });
  });
}
