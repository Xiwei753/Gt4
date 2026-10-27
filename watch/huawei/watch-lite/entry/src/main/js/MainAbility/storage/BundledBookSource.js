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
    chapters: b.chapters || [],
    origin: 'builtin'
  });
}

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
    chapters: b.chapters || [],
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

// Lite @system.file.readArrayBuffer 在部分 GT4 固件上会返回 code=200
// (System error)。按官方可用的 readText 接口退回受限窗口读取，
// 不读取整本小说，也不把 rawfile 读取异常伪装成成功。
// readText 默认 UTF-8、长度按字节指定，单次不超过 4096 字节。
function encodeUtf8(text) {
  var result = [];
  for (var i = 0; i < text.length; i++) {
    var n = text.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff && i + 1 < text.length) {
      var low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        n = 0x10000 + ((n - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (n < 0x80) {
      result.push(n);
    } else if (n < 0x800) {
      result.push(0xc0 | (n >> 6), 0x80 | (n & 0x3f));
    } else if (n < 0x10000) {
      result.push(0xe0 | (n >> 12), 0x80 | ((n >> 6) & 0x3f),
        0x80 | (n & 0x3f));
    } else {
      result.push(0xf0 | (n >> 18), 0x80 | ((n >> 12) & 0x3f),
        0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f));
    }
  }
  return new Uint8Array(result);
}

function readTextWindow(uri, start, len, cb) {
  // 大于 4KB 的窗口不走 readText，避免 Lite 错误 302。
  if (len > 4096) {
    cb({ ok: false, api: 'readText', uri: uri, code: 'over_4k' });
    return;
  }
  withTimeout('readText', uri, cb, function (finish) {
    file.readText({
      uri: uri,
      position: start,
      length: len,
      encoding: 'UTF-8',
      success: function (data) {
        if (!data || typeof data.text !== 'string') {
          finish({ ok: false, api: 'readText', uri: uri,
            code: 'bad_text_result' });
          return;
        }
        var bytes = encodeUtf8(data.text);
        if (bytes.length === 0 && len > 0) {
          finish({ ok: false, api: 'readText', uri: uri,
            code: 'unexpected_empty' });
          return;
        }
        finish({ ok: true, bytes: bytes, method: 'readText' });
      },
      fail: function (data, code) {
        finish({ ok: false, api: 'readText', uri: uri,
          code: (code === undefined ? 'fail' : code) });
      }
    });
  });
}

// 一次读取优先二进制，失败时用文本 API；两种都失败时携带双错误码。
// 阅读器消费的是 UTF-8 字节；文本回退后再编码，保持相同分页接口。
// 当前页面每次取 2048 字节，分页消耗远小于该窗口，确保不会消费
// 文本接口在末端 UTF-8 截断时可能产生的替换字符。
function readWindowWithText(uri, start, len, cb) {
  readWindow(uri, start, len, function (binary) {
    if (binary.ok) return cb(binary);
    readTextWindow(uri, start, len, function (fallback) {
      if (fallback.ok) return cb(fallback);
      cb({ ok: false, api: fallback.api, uri: uri,
        code: fallback.code, bufferCode: binary.code,
        textCode: fallback.code });
    });
  });
}

// 复制成功不代表副本实际完整：读取长度，失败则保留错误以便诊断。
// get 接口自己异常时允许继续试读，不把“不支持 get”当作复制失败。
function inspectCache(meta, cb) {
  var uri = cacheUri(meta);
  withTimeout('get', uri, cb, function (finish) {
    file.get({
      uri: uri,
      success: function (data) {
        if (data && typeof data.length === 'number') {
          finish({ ok: true, length: data.length });
        } else {
          finish({ ok: false, code: 'missing_length', api: 'get' });
        }
      },
      fail: function (data, code) {
        finish({ ok: false, code: (code === undefined ? 'fail' : code),
          api: 'get' });
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
// 内置书只使用私有缓存这一条正文文件路径：
//   缓存存在 -> 读取一小段；首次打开 -> copy rawfile -> 校验 -> 读取。
// 不再每次先对 rawfile 尝试二进制、再文本、然后才复制，
// 避免新书连续等待多个不支持的 API，而已读书却很快。
export function readBundledWindow(bookId, offset, size, cb, onStage) {
  function stage(label) {
    if (typeof onStage === 'function') onStage(label);
  }
  var meta = META[bookId];
  if (!meta) {
    return complete(cb, { ok: false, reason: 'not_bundled' });
  }
  var total = meta.bytes;
  var start = offset || 0;
  var want = size || 0;
  if (start >= total || want <= 0) {
    return complete(cb, { ok: true, offset: start,
      bytes: new Uint8Array(0) });
  }
  var len = Math.min(total, start + want) - start;
  var dst = cacheUri(meta);

  function readCached() {
    stage('读取缓存正文');
    readWindowWithText(dst, start, len, function (data) {
      if (data.ok) return complete(cb, okResult(data.bytes, start));
      complete(cb, { ok: false, reason: 'cache_read_failed',
        stage: 'cache_read', api: data.api, code: data.code,
        cacheBufferCode: data.bufferCode, cacheTextCode: data.textCode });
    });
  }

  function prepareFirstCopy() {
    stage('首次复制内置书');
    copyToCache(meta, function (result) {
      if (!result.ok) {
        return complete(cb, { ok: false, reason: 'copy_failed',
          stage: 'copy', api: result.api, code: result.code });
      }
      stage('核对缓存完整性');
      inspectCache(meta, function (stat) {
        if (stat.ok && stat.length !== meta.bytes) {
          return complete(cb, { ok: false, reason: 'cache_size_mismatch',
            stage: 'cache_size', code: 'size_mismatch',
            cacheBytes: stat.length, expectedBytes: meta.bytes });
        }
        // 部分 GT4 无法取得 file.get 长度，仍检查真实读取是否成功。
        // 不能把 copy success 本身视为正文已经可读。
        readCached();
      });
    });
  }

  stage('检查本地缓存');
  withTimeout('access', dst, function (state) {
    if (state.ok) return readCached();
    if (state.code === 'timeout' || state.code === 'throw') {
      return complete(cb, { ok: false, reason: 'cache_access_failed',
        stage: 'cache_access', code: state.code });
    }
    // 还没有这本书的私有副本：这是第一次打开，复制一次即可。
    prepareFirstCopy();
  }, function (finish) {
    file.access({
      uri: dst,
      success: function () { finish({ ok: true }); },
      fail: function (data, code) {
        finish({ ok: false, code: code === undefined ? 'missing' : code });
      }
    });
  });
}
