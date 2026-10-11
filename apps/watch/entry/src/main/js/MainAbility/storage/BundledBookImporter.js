// SPDX-License-Identifier: GPL-3.0-only
// 构建期内置书籍的一次性导入桥（issue #7）。
//
// 背景（必须如实说明，不伪造成功）：
//   GT 4 是 Lite Wearable 的 **JS FA**（HML/CSS/JS，JerryScript）。
//   本仓对本机 Lite SDK / OpenHarmony 源码核对后的结论是：
//     · `@system.file` 只认 `internal://app/...` 私有数据目录
//       （IsValidPath 要求前缀 internal://app、总长 <=128、
//       禁止 "/./" 与 "/../"）；
//     · 打包进 HAP 的 rawfile 在设备上留在 HAP zip 内，只有原生资源
//       管理器能读，Lite JS 侧没有对应 API，也没有 $rawfile。
//   所以这里对若干「打包资源可能被放到私有目录」的候选路径做**探测式**
//   读取：在这个运行时版本上若真的可读就导入；读不到就记一条明确诊断
//   `BUNDLED_IMPORT_UNAVAILABLE` 并安全 no-op——绝不假装导入成功，
//   也绝不阻塞书架。详细说明见 apps/watch/README.md 的 issue #7 一节。
//
// 幂等与「删了不复活」：
//   处理过的内置书籍 bookId 记在 internal://app/gt4reader/bundled.json。
//   已记账的（无论当时导入成功、发现已存在、还是用户后来删掉）永不再处理；
//   只有**本次确实导入失败**的才不记账，下次再试。
//
// 内存：正文按 BUNDLE_WINDOW 分块 readWindow → writeArrayBuffer，
//   峰值只有一个窗口；不使用 RegExp/replace/match 等 Lite 缺失能力。
import file from '@system.file';
import { ROOT, bookPath, tempPath, writeBytes,
  deleteFile, readWindow, commitVerifiedBook,
  ensureDirs, isSafeBookId } from './BookStorage.js';
import { addBook } from './LibraryIndex.js';
import { createSha256 } from '../util/Sha256.js';

// 「已处理」标记文件（应用私有目录内）。
var MARKER_FILE = ROOT + '/bundled.json';
// 分块窗口：峰值内存只有一个窗口。
var WINDOW = 32 * 1024;
// 候选资源基路径：谁先读出 manifest.json 就用谁。
// 都以 '/' 结尾；bookId 为 16 位小写 hex，拼出的 URI 远小于 128。
var RESOURCE_BASES = [
  'internal://app/rawfile/gt4books/',
  'internal://app/assets/entry/resources/rawfile/gt4books/',
  'internal://app/entry/resources/rawfile/gt4books/'
];

function log(message) {
  if (typeof console !== 'undefined' && console &&
      typeof console.log === 'function') {
    console.log('[BundledBookImporter] ' + message);
  }
}

// 标记文件：失败一律当作「首次运行」，绝不因此挡书架。
function loadMarker(cb) {
  file.readText({
    uri: MARKER_FILE,
    length: 65536,
    position: 0,
    success: (data) => {
      try {
        var parsed = JSON.parse(data.text || '{}');
        if (parsed && typeof parsed === 'object' &&
            parsed.handled && typeof parsed.handled === 'object') {
          return cb(parsed);
        }
      } catch (e) {
        // 内容损坏：按首次运行处理，不抛错。
      }
      cb({ schema: 1, handled: {} });
    },
    fail: () => cb({ schema: 1, handled: {} })
  });
}

function saveMarker(marker, cb) {
  file.writeText({
    uri: MARKER_FILE,
    text: JSON.stringify(marker),
    append: false,
    success: () => cb({ ok: true }),
    fail: () => cb({ ok: false })
  });
}

function probeBase(index, cb) {
  if (index >= RESOURCE_BASES.length) {
    return cb(null);
  }
  var base = RESOURCE_BASES[index];
  file.readText({
    uri: base + 'manifest.json',
    length: 65536,
    position: 0,
    success: (data) => {
      var manifest = null;
      try {
        manifest = JSON.parse(data.text || '{}');
      } catch (e) {
        manifest = null;
      }
      if (manifest && manifest.books &&
          Array.isArray(manifest.books)) {
        return cb({ base: base, books: manifest.books });
      }
      probeBase(index + 1, cb);
    },
    fail: () => probeBase(index + 1, cb)
  });
}

// 单本导入失败：删掉半写的暂存，绝不留半成品。
function failCopy(tmpUri, cb, reason) {
  deleteFile(tmpUri, () => cb({ ok: false, reason: reason }));
}

// 分块读源资源 → 追加写暂存 → 边写边算摘要 → 校验字节数与 sha256
// → 原子转正 → 登记索引。
function copyBookResource(base, book, cb) {
  // 不信任 manifest 里的文件名：由 bookId 推出，杜绝路径穿越。
  var srcUri = base + book.bookId + '.txt';
  var tmpUri = tempPath(book.bookId);
  var hasher = createSha256();
  var total = 0;
  var offset = 0;

  function next() {
    if (offset >= book.bytes) {
      if (total !== book.bytes) {
        return failCopy(tmpUri, cb,
          'size ' + total + ' != ' + book.bytes);
      }
      if (hasher.digest() !== book.sha256) {
        return failCopy(tmpUri, cb, 'digest mismatch');
      }
      return commitVerifiedBook(book.bookId, book.bookId, (moved) => {
        if (!moved.ok) {
          return failCopy(tmpUri, cb, 'move_to_books');
        }
        addBook({
          bookId: book.bookId,
          title: book.title,
          encoding: 'utf-8',
          bytes: book.bytes,
          sha256: book.sha256,
          chunks: 0,
          chunkBytes: 0,
          chapters: []
        }, (added) => {
          cb(added && added.ok ?
            { ok: true } : { ok: false, reason: 'add_book' });
        });
      });
    }
    var size = Math.min(WINDOW, book.bytes - offset);
    readWindow(srcUri, offset, size, (r) => {
      if (!r.ok) {
        return failCopy(tmpUri, cb, 'read');
      }
      hasher.update(r.bytes);
      writeBytes(tmpUri, r.bytes, offset > 0, (w) => {
        if (!w.ok) {
          return failCopy(tmpUri, cb, 'write');
        }
        total += r.bytes.length;
        offset += r.bytes.length;
        next();
      });
    });
  }
  next();
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

// 串行处理清单（一次一本，避免并发写索引/文件）。
function processBooks(base, books, marker, state, cb) {
  if (state.index >= books.length) {
    return saveMarker(marker, () => cb(state));
  }
  var book = books[state.index];
  state.index += 1;
  if (!validBook(book)) {
    log('skip invalid manifest entry');
    return processBooks(base, books, marker, state, cb);
  }
  if (marker.handled[book.bookId]) {
    return processBooks(base, books, marker, state, cb);
  }
  // 已存在（用户自己的书或更早导入）：只记账，绝不覆盖、绝不动进度。
  file.access({
    uri: bookPath(book.bookId),
    success: () => {
      marker.handled[book.bookId] = true;
      state.skipped += 1;
      saveMarker(marker,
        () => processBooks(base, books, marker, state, cb));
    },
    fail: () => {
      copyBookResource(base, book, (res) => {
        if (res.ok) {
          marker.handled[book.bookId] = true;
          state.imported += 1;
          log('imported ' + book.title + ' (' + book.bookId + ')');
          saveMarker(marker,
            () => processBooks(base, books, marker, state, cb));
        } else {
          // 失败不记账，下次再试；诊断可查，但不挡书架。
          log('import failed ' + book.bookId + ': ' +
            (res.reason || 'unknown'));
          processBooks(base, books, marker, state, cb);
        }
      });
    }
  });
}

// 唯一对外入口：在书架 prepareLibrary() 里调用一次。
// 永远回调一次；任何失败都降级为安全 no-op。
export function importBundledBooks(cb) {
  var done = (result) => {
    if (typeof cb === 'function') cb(result);
  };
  ensureDirs((dirs) => {
    if (!dirs.ok) {
      log('book dirs not ready, skip');
      return done({ ok: true, imported: 0, reason: 'dirs' });
    }
    loadMarker((marker) => {
      probeBase(0, (found) => {
        if (!found) {
          log('BUNDLED_IMPORT_UNAVAILABLE: 打包的 rawfile 在此 Lite JS ' +
            '运行时的 @system.file 下不可读（internal://app 仅指向私有数据目录）。' +
            '内置书籍导入桥已就绪但本次 no-op；见 apps/watch/README.md issue #7。');
          return done({ ok: true, imported: 0,
            reason: 'resource_unavailable' });
        }
        var state = { index: 0, imported: 0, skipped: 0 };
        log('manifest found at ' + found.base +
          ' books=' + found.books.length);
        processBooks(found.base, found.books, marker, state,
          (final) => {
            done({ ok: true, imported: final.imported,
              skipped: final.skipped });
          });
      });
    });
  });
}
