// SPDX-License-Identifier: GPL-3.0-only
// 构建期内置书籍的一次性导入桥（issue #7）。
//
// 真机教训（issue #7 评论，2026-10-11）：
//   上一版在 `@system.file` 回调不执行时会让 "初始化 3/5：导入内置书籍"
//   永远等下去（页面 10s 看门狗只报 E_INIT_TIMEOUT，readIndex 进不去）。
//   本版要求：
//     · 每一个文件操作都有**有限超时**且**只结算一次回调**；
//     · 每一步上报**屏幕可见**的阶段 + 真实错误码；
//     · 导入是**后台任务**，绝不阻塞书架：失败/超时/无资源都让
//       index.js 继续 readIndex，正常显示已有书架或空书架；
//     · 失败只显示在独立提示里（"内置书籍导入失败：步骤 + 原因"），
//       不覆盖"本地书库就绪"。
//
// 资源路线（按参考资料的 rawfile 复制流程，需真机实测）：
//   rawfile 只读，不假设可按字节窗口直接读；改为
//   `internal://app/rawfile/gt4books/<bookId>.txt`
//     --file.copy--> `internal://app/gt4reader/temp/<bookId>`
//   再从**私有暂存**分块读、校验字节数与 SHA-256，最后
//   commitVerifiedBook + addBook。若某版本 SDK 不支持 rawfile 作 copy
//   来源，就展示 fail(data, code) 的真实错误码，不静默吞掉。
//
// 幂等与「删了不复活」：处理过的 bookId 记在
// `internal://app/gt4reader/bundled.json`。已记账的永不再处理；
// 只有**本次确实失败**的不记账，下次再试。
//
// 兼容：无 RegExp / 无 replace-match-search / 无 DataView；
// 正文不整本进内存（分块窗口）。
import file from '@system.file';
import { ROOT, bookPath, tempPath, deleteFile, readWindow,
  commitVerifiedBook, ensureDirs, isSafeBookId } from './BookStorage.js';
import { addBook } from './LibraryIndex.js';
import { createSha256 } from '../util/Sha256.js';

// 「已处理」标记文件（应用私有目录内）。
var MARKER_FILE = ROOT + '/bundled.json';
// 校验分块窗口：峰值内存只有一个窗口。
var WINDOW = 32 * 1024;
// readText 受控长度（参考资料：默认 4096，超过可能报 302）。
var TEXT_CHUNK = 4096;
// manifest / marker 上限（分块累积，超过即明确报错）。
var MAX_TEXT = 256 * 1024;

// 单步后备超时：小文件操作（access/readText/writeText/readWindow）。
export var OP_TIMEOUT_MS = 8000;
// 整文件复制可能很慢（大 TXT），给更宽的有限上限。
export var COPY_TIMEOUT_MS = 120000;

export function setImportTimeout(ms) {
  if (typeof ms === 'number' && ms > 0) OP_TIMEOUT_MS = ms;
}
export function setCopyTimeout(ms) {
  if (typeof ms === 'number' && ms > 0) COPY_TIMEOUT_MS = ms;
}

// 候选资源基路径：谁先读出 manifest.json 就用谁。
// 全部是 internal://app 前缀（@system.file 只认这个前缀）；
// rawfile 是否落在这些位置、是否可读/可复制，需真机实测。
var RESOURCE_BASES = [
  'internal://app/rawfile/gt4books/',
  'internal://app/assets/entry/resources/rawfile/gt4books/',
  'internal://app/entry/resources/rawfile/gt4books/'
];

// 取消/代次：onDestroy 或重试时递增，令在途链安全停止。
var generation = 0;
export function cancelBundledImport() {
  generation++;
}

function log(message) {
  if (typeof console !== 'undefined' && console &&
      typeof console.log === 'function') {
    console.log('[BundledBookImporter] ' + message);
  }
}

// 单步执行器：settle-once + 有限超时 + 同步异常兜底。
// 保证回调**至多一次**，任何一步都不会无限等待。
function op(run, cb, timeoutMs) {
  var settled = false;
  var timer = null;
  var limit = (typeof timeoutMs === 'number' && timeoutMs > 0) ?
    timeoutMs : OP_TIMEOUT_MS;
  function finish(res) {
    if (settled) return;
    settled = true;
    if (timer !== null && timer !== undefined &&
        typeof clearTimeout === 'function') {
      clearTimeout(timer);
    }
    timer = null;
    cb(res);
  }
  if (typeof setTimeout === 'function') {
    timer = setTimeout(function () {
      finish({ ok: false, reason: 'timeout', code: 'timeout' });
    }, limit);
  }
  try {
    run(finish);
  } catch (error) {
    finish({ ok: false, reason: 'throw', code: 'throw',
      error: String(error) });
  }
}

function tryParse(text) {
  if (!text) return null;
  try {
    var value = JSON.parse(text);
    return (value && typeof value === 'object') ? value : null;
  } catch (error) {
    return null;
  }
}

// 分块 readText，边读边尝试 JSON.parse：解析成功即完成。
// 这样无论 position 的单位是字节还是字符、文件多大，
// 都能读到完整 JSON；既不整文件进内存，也不踩 4KB/302 限制。
function readJson(uri, cb) {
  var acc = '';
  function step(pos) {
    op(function (finish) {
      file.readText({
        uri: uri,
        position: pos,
        length: TEXT_CHUNK,
        success: function (data) {
          finish({ ok: true,
            text: (data && typeof data.text === 'string') ?
              data.text : '' });
        },
        fail: function (data, code) {
          finish({ ok: false, reason: 'read', code: code });
        }
      });
    }, function (r) {
      if (!r.ok) return cb(r);
      acc += r.text;
      var parsed = tryParse(acc);
      if (parsed !== null) return cb({ ok: true, value: parsed });
      if (r.text.length === 0) {
        return cb({ ok: false, reason: 'empty', code: 'eof' });
      }
      if (acc.length >= MAX_TEXT) {
        return cb({ ok: false, reason: 'too_long', code: 'too_long' });
      }
      step(pos + TEXT_CHUNK);
    });
  }
  step(0);
}

// 标记文件：任何失败（不存在/损坏/超时）都按「首次运行」，
// 绝不因此挡书架。
function loadMarker(cb) {
  readJson(MARKER_FILE, function (r) {
    if (r.ok && r.value && r.value.handled &&
        typeof r.value.handled === 'object') {
      return cb(r.value);
    }
    cb({ schema: 1, handled: {} });
  });
}

function saveMarker(marker, cb) {
  op(function (finish) {
    file.writeText({
      uri: MARKER_FILE,
      text: JSON.stringify(marker),
      append: false,
      success: function () { finish({ ok: true }); },
      fail: function (data, code) {
        finish({ ok: false, reason: 'write_marker', code: code });
      }
    });
  }, function (r) { cb(!!r.ok); });
}

// 依次探测候选基路径，返回第一个能读出合法 manifest 的。
function probeBase(cb) {
  var index = 0;
  var last = null;
  function step() {
    if (index >= RESOURCE_BASES.length) return cb(null, last);
    var base = RESOURCE_BASES[index];
    index += 1;
    readJson(base + 'manifest.json', function (r) {
      if (r.ok && r.value && Array.isArray(r.value.books)) {
        return cb({ base: base, books: r.value.books }, null);
      }
      last = r.ok ? 'manifest_parse' : r.code;
      step();
    });
  }
  step();
}

function validBook(book) {
  if (!book || typeof book !== 'object') return false;
  if (!isSafeBookId(book.bookId)) return false;
  if (typeof book.title !== 'string' || !book.title) return false;
  if (typeof book.bytes !== 'number' || !(book.bytes > 0)) return false;
  if (typeof book.sha256 !== 'string' || book.sha256.length !== 64) {
    return false;
  }
  return true;
}

// 从私有暂存分块读，校验字节数与 SHA-256。
function verifyTemp(tmpUri, book, cb) {
  op(function (finish) {
    file.get({
      uri: tmpUri,
      success: function (info) {
        finish({ ok: true, size: (info && typeof info.length === 'number') ?
          info.length : -1 });
      },
      fail: function (data, code) {
        finish({ ok: false, reason: 'stat', code: code });
      }
    });
  }, function (st) {
    if (!st.ok) {
      return cb({ ok: false, reason: '无法取得暂存大小', code: st.code });
    }
    if (st.size !== book.bytes) {
      return cb({ ok: false,
        reason: '字节数不符 ' + st.size + ' != ' + book.bytes });
    }
    var hasher = createSha256();
    var offset = 0;
    function next() {
      if (offset >= book.bytes) {
        return cb(hasher.digest() === book.sha256 ? { ok: true } :
          { ok: false, reason: 'SHA-256 不符' });
      }
      var size = Math.min(WINDOW, book.bytes - offset);
      op(function (finish) {
        readWindow(tmpUri, offset, size, finish);
      }, function (r) {
        if (!r.ok) {
          return cb({ ok: false, reason: '读取暂存失败', code: r.code });
        }
        if (!r.bytes || r.bytes.length === 0) {
          return cb({ ok: false, reason: '暂存提前结束' });
        }
        hasher.update(r.bytes);
        offset += r.bytes.length;
        next();
      });
    }
    next();
  });
}

// 导入单本：清残留暂存 → copy 整文件 → 校验 → 落盘 → 写索引。
function importOne(gen, base, book, report, cb) {
  // 不信任 manifest 里的文件名：由 bookId 推出，杜绝路径穿越。
  var srcUri = base + book.bookId + '.txt';
  var tmpUri = tempPath(book.bookId);
  var title = book.title;
  deleteFile(tmpUri, function () {
    if (gen !== generation) return cb({ cancelled: true });
    report('复制第 ' + title + ' 本');
    op(function (finish) {
      file.copy({
        srcUri: srcUri,
        dstUri: tmpUri,
        success: function () { finish({ ok: true }); },
        fail: function (data, code) {
          finish({ ok: false, reason: 'copy', code: code });
        }
      });
    }, function (c) {
      if (gen !== generation) {
        deleteFile(tmpUri, function () {});
        return cb({ cancelled: true });
      }
      if (!c.ok) {
        return cb({ ok: false, step: '复制第 ' + title + ' 本',
          reason: '从 rawfile 复制失败', code: c.code });
      }
      report('校验/落盘 ' + title);
      verifyTemp(tmpUri, book, function (v) {
        if (gen !== generation) {
          deleteFile(tmpUri, function () {});
          return cb({ cancelled: true });
        }
        if (!v.ok) {
          // 失败只清本次暂存，绝不留半成品。
          deleteFile(tmpUri, function () {});
          return cb({ ok: false, step: '校验/落盘',
            reason: v.reason, code: v.code });
        }
        report('写索引 ' + title);
        op(function (finish) {
          commitVerifiedBook(book.bookId, book.bookId, finish);
        }, function (m) {
          if (gen !== generation) return cb({ cancelled: true });
          if (!m.ok) {
            deleteFile(tmpUri, function () {});
            return cb({ ok: false, step: '落盘到书库',
              reason: '移动暂存失败', code: m.code });
          }
          op(function (finish) {
            addBook({
              bookId: book.bookId,
              title: title,
              encoding: 'utf-8',
              bytes: book.bytes,
              sha256: book.sha256,
              chunks: 0,
              chunkBytes: 0,
              chapters: []
            }, finish);
          }, function (a) {
            if (gen !== generation) return cb({ cancelled: true });
            if (!a || !a.ok) {
              return cb({ ok: false, step: '写索引',
                reason: '登记索引失败', code: a && a.code });
            }
            report('标记已处理 ' + title);
            cb({ ok: true });
          });
        });
      });
    });
  });
}

// 串行处理清单（一次一本，避免并发写索引/文件）。
function processBooks(gen, base, books, marker, state, report, cb) {
  if (gen !== generation) return cb(state);
  if (state.index >= books.length) {
    return saveMarker(marker, function () { cb(state); });
  }
  var book = books[state.index];
  state.index += 1;
  if (!validBook(book)) {
    state.failed += 1;
    if (!state.first) {
      state.first = { step: '检查清单', reason: '清单条目非法',
        code: 'invalid_entry' };
    }
    log('skip invalid manifest entry');
    return processBooks(gen, base, books, marker, state, report, cb);
  }
  if (marker.handled[book.bookId]) {
    state.skipped += 1;
    return processBooks(gen, base, books, marker, state, report, cb);
  }
  // 已存在（用户自己的书或更早导入）：只记账，绝不覆盖、绝不动进度。
  op(function (finish) {
    file.access({
      uri: bookPath(book.bookId),
      success: function () { finish({ ok: true }); },
      fail: function (data, code) { finish({ ok: false, code: code }); }
    });
  }, function (ex) {
    if (gen !== generation) return cb(state);
    if (ex.ok) {
      marker.handled[book.bookId] = true;
      state.skipped += 1;
      return saveMarker(marker, function () {
        processBooks(gen, base, books, marker, state, report, cb);
      });
    }
    importOne(gen, base, book, report, function (res) {
      if (gen !== generation) return cb(state);
      if (res.cancelled) return cb(state);
      if (res.ok) {
        marker.handled[book.bookId] = true;
        state.imported += 1;
        log('imported ' + book.bookId);
        return saveMarker(marker, function () {
          processBooks(gen, base, books, marker, state, report, cb);
        });
      }
      // 失败不记账，下次再试；诊断可查，但不挡书架。
      state.failed += 1;
      if (!state.first) {
        state.first = { step: res.step, reason: res.reason,
          code: res.code };
      }
      log('import failed ' + book.bookId + ': ' + res.reason +
        ' code=' + res.code);
      processBooks(gen, base, books, marker, state, report, cb);
    });
  });
}

// 唯一对外入口：在书架页调用，**后台**执行，永不阻塞。
//   cb(result)：至多一次。result.ok=false 表示有明确错误（含 step/code）；
//             result.ok=true 且 reason='resource_unavailable' 表示包内无
//             可读内置资源，属正常情况。
//   onStage(stage, code)：屏幕可见的阶段进度。
export function importBundledBooks(cb, onStage) {
  var gen = generation;
  function report(stage, code) {
    if (gen !== generation) return;
    log('stage ' + stage + (code ? ' code=' + code : ''));
    if (typeof onStage === 'function') onStage(stage, code);
  }
  function done(res) {
    if (gen !== generation) return;
    if (typeof cb === 'function') cb(res);
  }
  report('准备目录');
  ensureDirs(function (dirs) {
    if (gen !== generation) return;
    if (!dirs.ok) {
      return done({ ok: false, step: '准备目录',
        reason: '书库目录未就绪',
        code: dirs.code || dirs.reason || 'dirs' });
    }
    report('读取 bundled.json');
    loadMarker(function (marker) {
      if (gen !== generation) return;
      report('检查 rawfile/manifest');
      probeBase(function (found, lastCode) {
        if (gen !== generation) return;
        if (!found) {
          log('BUNDLED_IMPORT_UNAVAILABLE 打包 rawfile 在此 Lite 运行时' +
            '不可读或包内无内置书；本次安全 no-op。code=' + lastCode);
          return done({ ok: true, imported: 0, skipped: 0, failed: 0,
            reason: 'resource_unavailable', code: lastCode });
        }
        var state = { index: 0, imported: 0, skipped: 0, failed: 0,
          first: null };
        log('manifest found at ' + found.base +
          ' books=' + found.books.length);
        processBooks(gen, found.base, found.books, marker, state, report,
          function (final) {
            if (gen !== generation) return;
            done({ ok: true, imported: final.imported,
              skipped: final.skipped, failed: final.failed,
              first: final.first, base: found.base });
          });
      });
    });
  });
}
