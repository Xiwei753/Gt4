// SPDX-License-Identifier: GPL-3.0-only
// 内置书正文**按需**访问器（issue #10 复核后）。
//
// 正文不再编译进 JS：它作为 rawfile 资源随包打进内层 entry.bin，
// 本模块在设备上**只读取当前页所在的小窗口**（不把整本解码进 JS 内存）：
//   1) 先尝试直接以窗口读 rawfile：internal://app/rawfile/gt4books/<file>；
//   2) 不行再尝试 file.copy 把**当前这一本**复制到私有目录
//      internal://app/gt4reader/cache/<bookId>.txt，再窗口读该副本；
//   3) 两步都失败：如实回报真实接口名 / URI / 错误码 / 是否无回调超时，
//      由阅读页显示**简短**错误，不假装读到了正文。
//
// 每个文件调用都有有限超时（settle-once），任何一步不回调都不会
// 让阅读页永久卡住。书单元数据来自 BookCatalog.g.js（不含正文）。
import file from '@system.file';
import { BOOKS } from '../books/BookCatalog.g.js';
import { ROOT, complete } from './BookStorage.js';

// rawfile 资源基路径（与构建期 resourceDir 一致）。
var RAWFILE_DIR = 'internal://app/rawfile/gt4books/';
// 私有缓存目录（复制出来的副本放这里，可窗口读）。
var CACHE_DIR = ROOT + '/cache';

var OP_TIMEOUT_MS = 6000;
export function setBundledTimeout(ms) {
  OP_TIMEOUT_MS = ms;
}

// 元数据表：bookId -> {bookId,title,bytes,file}
var META = {};
var LIST = [];
var i;
for (i = 0; i < BOOKS.length; i++) {
  var b = BOOKS[i];
  META[b.bookId] = b;
  LIST.push({
    bookId: b.bookId,
    title: b.title,
    bytes: b.bytes,
    origin: 'builtin'
  });
}

// 已确认可用的读取位置：bookId -> true 表示私有副本可用。
var CACHED = {};

export var BUNDLED_BOOKS = LIST;

export function isBundled(bookId) {
  return Object.prototype.hasOwnProperty.call(META, bookId);
}

export function bundledEntry(bookId) {
  var b = META[bookId];
  if (!b) return null;
  return {
    bookId: b.bookId,
    title: b.title,
    bytes: b.bytes,
    origin: 'builtin'
  };
}

function rawUri(meta) {
  return RAWFILE_DIR + meta.file;
}

function cacheUri(meta) {
  return CACHE_DIR + '/' + meta.bookId + '.txt';
}

// settle-once + 有限超时包装：任何分支都只回调一次。
function withTimeout(api, uri, cb, startFn) {
  var done = false;
  var timer = setTimeout(function () {
    if (done) return;
    done = true;
    cb({ ok: false, api: api, uri: uri, code: 'timeout' });
  }, OP_TIMEOUT_MS);
  function finish(res) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cb(res);
  }
  try {
    startFn(finish);
  } catch (e) {
    finish({ ok: false, api: api, uri: uri, code: 'throw' });
  }
}

function toBytes(data, want) {
  if (!data || !data.buffer) return new Uint8Array(0);
  var all = new Uint8Array(data.buffer);
  if (want > 0 && all.length > want) return all.subarray(0, want);
  return all;
}

// 直接窗口读某个 URI：成功 cb({ok:true,bytes})，失败 cb({ok:false,api,uri,code})。
function readWindow(uri, start, len, cb) {
  withTimeout('readArrayBuffer', uri, cb, function (finish) {
    file.readArrayBuffer({
      uri: uri,
      position: start,
      length: len,
      success: function (data) {
        finish({ ok: true, bytes: toBytes(data, len) });
      },
      fail: function (d, code) {
        finish({ ok: false, api: 'readArrayBuffer', uri: uri,
          code: (code === undefined ? 'fail' : code) });
      }
    });
  });
}

// 确保私有缓存目录存在（失败不致命，copy 会再报真实错误）。
function ensureCacheDir(cb) {
  withTimeout('mkdir', CACHE_DIR, function () { cb(); }, function (finish) {
    file.mkdir({
      uri: CACHE_DIR,
      recursive: true,
      success: function () { finish({}); },
      fail: function () { finish({}); }  // 已存在/失败都继续
    });
  });
}

// 把当前这一本从 rawfile 复制到私有缓存目录。
function copyToCache(meta, cb) {
  var src = rawUri(meta);
  var dst = cacheUri(meta);
  ensureCacheDir(function () {
    withTimeout('copy', src, cb, function (finish) {
      file.copy({
        srcUri: src,
        dstUri: dst,
        success: function () { finish({ ok: true }); },
        fail: function (d, code) {
          finish({ ok: false, api: 'copy', uri: src, dstUri: dst,
            code: (code === undefined ? 'fail' : code) });
        }
      });
    });
  });
}

function okResult(bytes, start) {
  return { ok: true, offset: start, bytes: bytes };
}

// 读取 [start, start+len) 的正文窗口（字节偏移语义同 BookStorage.readBytes）。
// 成功 cb({ok:true,offset,bytes:Uint8Array})；
// 失败 cb({ok:false,reason,api,uri,code})。
export function readBundledWindow(bookId, offset, size, cb) {
  var meta = META[bookId];
  if (!meta) {
    return complete(cb, { ok: false, reason: 'not_bundled' });
  }
  var total = meta.bytes;
  var start = offset || 0;
  var want = size || 0;
  if (start >= total || want <= 0) {
    return complete(cb, { ok: true, offset: start, bytes: new Uint8Array(0) });
  }
  var end = Math.min(total, start + want);
  var len = end - start;

  function fromCacheOrRaw() {
    if (!CACHED[bookId]) return fromRaw();
    readWindow(cacheUri(meta), start, len, function (r) {
      if (r.ok) return complete(cb, okResult(r.bytes, start));
      CACHED[bookId] = false;
      fromRaw();
    });
  }

  function fromRaw() {
    readWindow(rawUri(meta), start, len, function (r) {
      if (r.ok) return complete(cb, okResult(r.bytes, start));
      // rawfile 直接读不行 → 复制当前一本到私有目录再读。
      copyToCache(meta, function (c) {
        if (!c.ok) {
          return complete(cb, {
            ok: false,
            reason: 'unreadable',
            api: c.api,
            uri: c.uri,
            code: c.code,
            rawCode: r.code
          });
        }
        readWindow(cacheUri(meta), start, len, function (r2) {
          if (r2.ok) {
            CACHED[bookId] = true;
            return complete(cb, okResult(r2.bytes, start));
          }
          complete(cb, {
            ok: false,
            reason: 'read_failed',
            api: r2.api,
            uri: r2.uri,
            code: r2.code
          });
        });
      });
    });
  }

  fromCacheOrRaw();
}
