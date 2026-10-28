// SPDX-License-Identifier: GPL-3.0-only
// GT4 Lite 阅读进度同步：只处理 READ_PROGRESS_* 小消息。
// 不创建第二套 Wear Engine 订阅；WearReceiver 已收到的消息在这里分流。
// 消息只含 bookId/sha256/offset/updatedAt，不含正文、目录或书架。
// 本文件运行在 JerryScript：禁止正则、replace/match/search/padStart/DataView。
import { BUNDLED_BOOKS, readBundledWindow }
  from '../storage/BundledBookSource.js';
import { listBooks } from '../storage/LibraryIndex.js';
import { readBytes } from '../storage/BookStorage.js';
import { loadProgress, saveProgress, loadLastBook, saveLastBook,
  loadSyncBase, saveSyncBase } from '../storage/ProgressStore.js';
import { isLowerHex } from '../util/Validate.js';

var MAX_MESSAGE_BYTES = 4096;
var applyHandler = null;
var pendingApply = null;
var activeBookId = '';

function utf8Length(text) {
  var total = 0;
  for (var i = 0; i < text.length; i++) {
    var n = text.charCodeAt(i);
    if (n < 0x80) {
      total += 1;
    } else if (n < 0x800) {
      total += 2;
    } else if (n >= 0xd800 && n <= 0xdbff &&
      i + 1 < text.length) {
      var low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        total += 4;
        i++;
      } else {
        total += 3;
      }
    } else {
      total += 3;
    }
  }
  return total;
}

function isOffset(n) {
  return typeof n === 'number' && isFinite(n) &&
    n >= 0 && Math.floor(n) === n;
}

function isValidSummary(value) {
  return value && typeof value === 'object' &&
    isLowerHex(value.bookId, 16) &&
    isLowerHex(value.sha256, 64) &&
    isOffset(value.offset) &&
    (value.updatedAt === undefined || isOffset(value.updatedAt));
}

function findBook(books, bookId) {
  for (var i = 0; i < books.length; i++) {
    if (books[i].bookId === bookId) return books[i];
  }
  return null;
}

function mergeBooks(external) {
  var out = [];
  var seen = {};
  var i;
  for (i = 0; i < BUNDLED_BOOKS.length; i++) {
    var b = BUNDLED_BOOKS[i];
    if (!b || seen[b.bookId]) continue;
    seen[b.bookId] = true;
    out.push(b);
  }
  for (i = 0; i < external.length; i++) {
    var e = external[i];
    if (!e || seen[e.bookId]) continue;
    seen[e.bookId] = true;
    out.push(e);
  }
  return out;
}

function loadBooks(cb) {
  try {
    listBooks(function (external) {
      cb(mergeBooks(external || []));
    });
  } catch (e) {
    cb(mergeBooks([]));
  }
}

// 本地摘要：只返回有真实进度且摘要完整的书。
function loadSummaries(books, cb) {
  var out = [];
  var index = 0;
  function next() {
    if (index >= books.length) return cb(out);
    var book = books[index++];
    if (!book || !isLowerHex(book.sha256, 64)) return next();
    loadProgress(book.bookId, function (progress) {
      if (!progress || !progress.ok || progress.empty) return next();
      loadSyncBase(book.bookId, function (base) {
        var offset = progress.offset;
        var updatedAt = 0;
        if (base && base.ok && base.offset === offset) {
          updatedAt = base.updatedAt || 0;
        } else {
          updatedAt = Date.now();
        }
        out.push({
          bookId: book.bookId,
          sha256: book.sha256,
          offset: offset,
          updatedAt: updatedAt
        });
        next();
      });
    });
  }
  next();
}

function chunkSummaries(summaries, base) {
  var groups = [];
  var current = [];
  var i;
  for (i = 0; i < summaries.length; i++) {
    var probe = current.concat([summaries[i]]);
    var payload = Object.assign({}, base, {
      books: probe, batch: 9999, batches: 9999
    });
    if (utf8Length(JSON.stringify(payload)) < MAX_MESSAGE_BYTES) {
      current = probe;
    } else {
      if (current.length === 0) return [];
      groups.push(current);
      current = [summaries[i]];
      var single = Object.assign({}, base, {
        books: current, batch: 9999, batches: 9999
      });
      if (utf8Length(JSON.stringify(single)) >= MAX_MESSAGE_BYTES) {
        return [];
      }
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function sendState(sendToPhone, requestId) {
  loadLastBook(function (last) {
    loadBooks(function (books) {
      loadSummaries(books, function (summaries) {
        var lastBook = last && last.ok ?
          findBook(books, last.bookId) : null;
        var base = {
          v: 0,
          type: 'READ_PROGRESS_STATE',
          source: 'watch',
          requestId: typeof requestId === 'string' ? requestId : '',
          lastBookId: last && last.ok ? (last.bookId || '') : '',
          lastUpdatedAt: last && last.ok ? (last.updatedAt || 0) : 0,
          lastSha256: lastBook ? lastBook.sha256 : ''
        };
        if (summaries.length === 0) {
          sendToPhone(JSON.stringify(Object.assign({}, base,
            { books: [] })));
          return;
        }
        var groups = chunkSummaries(summaries, base);
        for (var i = 0; i < groups.length; i++) {
          var payload = Object.assign({}, base, {
            books: groups[i],
            batch: i,
            batches: groups.length
          });
          sendToPhone(JSON.stringify(payload));
        }
      });
    });
  });
}

function validateBoundary(book, offset, cb) {
  if (offset === book.bytes) return cb(true);
  if (offset > book.bytes) return cb(false);
  var reader = book.origin === 'builtin' ?
    readBundledWindow : readBytes;
  try {
    reader(book.bookId, offset, 1, function (data) {
      if (!data || !data.ok || !data.bytes ||
          data.bytes.length !== 1) {
        return cb(false);
      }
      cb((data.bytes[0] & 0xc0) !== 0x80);
    });
  } catch (e) {
    cb(false);
  }
}

function notifyApply(bookId, offset) {
  if (typeof applyHandler === 'function') {
    try {
      applyHandler({ bookId: bookId, offset: offset });
      return;
    } catch (e) {}
  }
  pendingApply = { bookId: bookId, offset: offset };
}

function applyOffset(book, remote, sendToPhone, cb) {
  if (!isValidSummary(remote) || !book ||
      book.sha256 !== remote.sha256 ||
      remote.offset > book.bytes) {
    return cb(false);
  }
  validateBoundary(book, remote.offset, function (ok) {
    if (!ok) return cb(false);
    saveProgress(book.bookId, remote.offset, [], null,
      function (saved) {
        if (!saved || !saved.ok) return cb(false);
        saveSyncBase(book.bookId, remote.offset,
          remote.updatedAt || 0, function () {
            notifyApply(book.bookId, remote.offset);
            cb(true);
          });
      });
  });
}

function sendApply(sendToPhone, book, offset, updatedAt) {
  sendToPhone(JSON.stringify({
    v: 0,
    type: 'READ_PROGRESS_APPLY',
    source: 'watch',
    bookId: book.bookId,
    sha256: book.sha256,
    offset: offset,
    updatedAt: updatedAt || 0
  }));
}

function handleRemoteState(message, sendToPhone) {
  if (!Array.isArray(message.books)) return;
  loadBooks(function (books) {
    var lastBook = null;
    if (typeof message.lastBookId === 'string') {
      lastBook = findBook(books, message.lastBookId);
    }
    var index = 0;
    function next() {
      if (index >= message.books.length) {
        // 上次阅读只更新入口；活动阅读中绝不强制跳书。
        if (lastBook && !activeBookId &&
            isLowerHex(lastBook.sha256, 64) &&
            (typeof message.lastSha256 !== 'string' ||
             !message.lastSha256 ||
             lastBook.sha256 === message.lastSha256)) {
          loadLastBook(function (localLast) {
            var localAt = localLast && localLast.ok ?
              (localLast.updatedAt || 0) : 0;
            var remoteAt = typeof message.lastUpdatedAt === 'number' ?
              message.lastUpdatedAt : 0;
            // 只有对端明确更新时才改续读入口；不比较书名/offset，
            // 也不强制跳书。
            if (remoteAt > localAt) {
              saveLastBook(lastBook.bookId, function () {});
            }
          });
        }
        return;
      }
      var remote = message.books[index++];
      if (!isValidSummary(remote)) return next();
      var book = findBook(books, remote.bookId);
      if (!book || book.sha256 !== remote.sha256 ||
          remote.offset > book.bytes) {
        return next();
      }
      loadProgress(book.bookId, function (local) {
        loadSyncBase(book.bookId, function (base) {
          if (!local || !local.ok) return next();
          if (local.empty) {
            return applyOffset(book, remote, sendToPhone,
              function () { next(); });
          }
          if (local.offset === remote.offset) {
            saveSyncBase(book.bookId, local.offset,
              remote.updatedAt || 0, function () { next(); });
            return;
          }
          var baseOffset = base && base.ok ? base.offset : -1;
          if (baseOffset >= 0 && local.offset === baseOffset) {
            return applyOffset(book, remote, sendToPhone,
              function () { next(); });
          }
          if (baseOffset >= 0 && remote.offset === baseOffset) {
            // 本地新读，远端未变：把本地进度告诉手机。
            sendApply(sendToPhone, book, local.offset, Date.now());
            return next();
          }
          // 两边都改过：不覆盖，把自己的摘要发回手机，
          // 由手机弹窗让用户选择。
          sendToPhone(JSON.stringify({
            v: 0,
            type: 'READ_PROGRESS_STATE',
            source: 'watch',
            books: [{
              bookId: book.bookId,
              sha256: book.sha256,
              offset: local.offset,
              updatedAt: Date.now()
            }]
          }));
          next();
        });
      });
    }
    next();
  });
}

function handleApply(message, sendToPhone) {
  if (!isValidSummary(message)) return;
  loadBooks(function (books) {
    var book = findBook(books, message.bookId);
    if (!book || book.sha256 !== message.sha256 ||
        message.offset > book.bytes) return;
    // APPLY 是手机在用户选择后发出的显式指令；这里只做摘要、
    // 范围和 UTF-8 边界校验，不再用本地旧进度反推冲突。
    // 以本地当前位置判断重复：同一偏移不重绘，但从更后面合法
    // 回退到同一旧偏移必须生效，不能按 offset 永久去重。
    loadProgress(book.bookId, function (local) {
      if (local && local.ok && !local.empty &&
          local.offset === message.offset) {
        saveSyncBase(book.bookId, local.offset,
          message.updatedAt || 0, function () {});
        return;
      }
      applyOffset(book, message, sendToPhone, function () {});
    });
  });
}

// WearReceiver 在交给传书接收器之前调用。
export function handleMessage(text, sendToPhone) {
  if (typeof text !== 'string' || typeof sendToPhone !== 'function') {
    return false;
  }
  var message;
  try {
    message = JSON.parse(text);
  } catch (e) {
    return false;
  }
  if (!message || typeof message.type !== 'string' ||
      message.type.indexOf('READ_PROGRESS_') !== 0) {
    return false;
  }
  if (message.v !== 0) return true;
  if (message.type === 'READ_PROGRESS_GET') {
    sendState(sendToPhone, message.requestId);
  } else if (message.type === 'READ_PROGRESS_STATE') {
    handleRemoteState(message, sendToPhone);
  } else if (message.type === 'READ_PROGRESS_APPLY') {
    handleApply(message, sendToPhone);
  }
  return true;
}

export function setApplyHandler(handler) {
  applyHandler = typeof handler === 'function' ? handler : null;
}

export function clearApplyHandler(handler) {
  if (!handler || applyHandler === handler) applyHandler = null;
}

export function takePendingApply(bookId) {
  if (pendingApply && pendingApply.bookId === bookId) {
    var offset = pendingApply.offset;
    pendingApply = null;
    return offset;
  }
  return null;
}

export function setActiveBook(bookId) {
  activeBookId = typeof bookId === 'string' ? bookId : '';
}

export function clearActiveBook() {
  activeBookId = '';
}
