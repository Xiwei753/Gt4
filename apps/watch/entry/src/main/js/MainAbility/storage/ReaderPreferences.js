// SPDX-License-Identifier: GPL-3.0-only
// GT4 Lite FA 的 @system.storage 持久设置（字符串必须 <128 字节）。
// 每本书独立保存字号/行距/主题，同时记录最近一次全局默认。
import storage from '@system.storage';
import { normalizeSettings } from '../reader/ReaderSettings.js';

var PREFIX = 'suyue.reader.';
var FALLBACK = 'suyue.reader.default';
var TIMEOUT = 2500;

function once(cb, task) {
  var settled = false;
  var timer = setTimeout(function () {
    if (!settled) {
      settled = true;
      cb({ ok: false, code: 'timeout' });
    }
  }, TIMEOUT);
  function finish(result) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cb(result);
  }
  try { task(finish); }
  catch (error) { finish({ ok: false, code: 'throw' }); }
}

function readKey(key, cb) {
  once(cb, function (finish) {
    storage.get({
      key: key,
      success: function (value) {
        if (typeof value !== 'string' || !value) {
          return finish({ ok: false, code: 'empty' });
        }
        try {
          finish({ ok: true, settings: normalizeSettings(JSON.parse(value)) });
        } catch (error) {
          finish({ ok: false, code: 'parse' });
        }
      },
      fail: function (data, code) {
        finish({ ok: false, code: code === undefined ? 'fail' : code });
      }
    });
  });
}

export function loadReaderPreferences(bookId, cb) {
  readKey(PREFIX + bookId, function (specific) {
    if (specific.ok) return cb(specific.settings);
    readKey(FALLBACK, function (fallback) {
      cb(fallback.ok ? fallback.settings : null);
    });
  });
}

function writeKey(key, value, cb) {
  once(cb, function (finish) {
    storage.set({
      key: key,
      value: value,
      success: function () { finish({ ok: true }); },
      fail: function (data, code) {
        finish({ ok: false, code: code === undefined ? 'fail' : code });
      }
    });
  });
}

export function saveReaderPreferences(bookId, settings, cb) {
  var serialized = JSON.stringify(normalizeSettings(settings));
  if (serialized.length >= 128) {
    return cb({ ok: false, code: 'too_long' });
  }
  writeKey(PREFIX + bookId, serialized, function (specific) {
    writeKey(FALLBACK, serialized, function (fallback) {
      cb(specific.ok ? specific : fallback);
    });
  });
}
